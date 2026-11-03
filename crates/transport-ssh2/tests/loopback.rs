//! Real SSH2 packets on loopback; synthetic server behavior, not Linux/PTY acceptance.
use russh::keys::{Algorithm, HashAlg, PrivateKey, PublicKey};
use russh::server::{self, Server as _, Session, VerifiedPublicKey};
use russh::{Channel, ChannelId, ChannelMsg, Pty};
use std::borrow::Cow;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;
use transport_ssh2::Ssh2Probe;

#[derive(Clone)]
struct FixtureServer {
    token: Arc<String>,
    client_key: PublicKey,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    excessive_prompts: bool,
}

impl server::Server for FixtureServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Self {
        self.clone()
    }
    fn handle_session_error(&mut self, _: russh::Error) { /* Do not log auth material. */
    }
}

impl server::Handler for FixtureServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "probe" && password == self.token.as_str() {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "probe" && key.public_key == &self.client_key {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        if user != "probe" {
            return Ok(server::Auth::reject());
        }
        if let Some(mut response) = response {
            return Ok(
                if response.next().as_deref() == Some(self.token.as_bytes()) {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            );
        }
        Ok(server::Auth::Partial {
            name: Cow::Borrowed("Synthetic challenge"),
            instructions: Cow::Borrowed("Loopback fixture only"),
            prompts: Cow::Owned(vec![
                (Cow::Borrowed("Token: "), false);
                if self.excessive_prompts { 17 } else { 1 }
            ]),
        })
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(term, "xterm-256color");
        self.sizes.lock().unwrap().push((cols, rows));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"fixture-shell\r\n".to_vec())?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.sizes.lock().unwrap().push((cols, rows));
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        bytes: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if bytes == [3] {
            return Err(russh::Error::Disconnect);
        }
        session.data(channel, bytes.to_vec())?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if command == b"reject" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        if command == b"stall" {
            return Ok(());
        }
        if command == b"overflow" {
            session.data(channel, vec![b'x'; 1024 * 1024 + 1])?;
            session.eof(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        if command == b"fail" {
            session.extended_data(channel, 1, b"fixture-error".to_vec())?;
            session.exit_status_request(channel, 7)?;
        } else {
            session.data(channel, b"fresh-exec-channel".to_vec())?;
            session.exit_status_request(channel, 0)?;
        }
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

struct Fixture {
    addr: SocketAddr,
    pin: String,
    token: Arc<String>,
    key: PrivateKey,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    shutdown: server::RunningServerHandle,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn start(excessive_prompts: bool) -> Self {
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let pin = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let token = Arc::new(rand::random::<u128>().to_string());
        let sizes = Arc::new(Mutex::new(vec![]));
        let mut handler = FixtureServer {
            token: token.clone(),
            client_key: key.public_key().clone(),
            sizes: sizes.clone(),
            excessive_prompts,
        };
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::ZERO),
            inactivity_timeout: Some(Duration::from_secs(20)),
            ..Default::default()
        });
        let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = socket.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let running = handler.run_on_socket(config, &socket);
            let _ = tx.send(running.handle());
            running.await.unwrap();
        });
        let shutdown = rx.await.unwrap();
        Self {
            addr,
            pin,
            token,
            key,
            sizes,
            shutdown,
            task,
        }
    }
    async fn connect(&self) -> Ssh2Probe {
        Ssh2Probe::connect(self.addr, self.pin.clone())
            .await
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown.shutdown(String::new());
        self.task.abort();
    }
}

async fn data(channel: &mut Channel<russh::client::Msg>) -> Vec<u8> {
    timeout(Duration::from_secs(5), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => return data.to_vec(),
                None => panic!("channel closed without output"),
                _ => {}
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn password_pty_resize_exec_keepalive_disconnect() {
    let fixture = Fixture::start(false).await;
    let mut client = fixture.connect().await;
    assert!(
        !client
            .password("probe", "intentionally-invalid-fixture-input")
            .await
            .unwrap()
    );
    assert!(client.password("probe", &fixture.token).await.unwrap());
    let algorithms = client.negotiated().unwrap();
    assert!(algorithms.contains("ssh-ed25519"));
    println!("Loopback negotiation: {algorithms}");
    let mut shell = client.shell(80, 24).await.unwrap();
    assert_eq!(data(&mut shell).await, b"fixture-shell\r\n");
    shell.window_change(100, 30, 0, 0).await.unwrap();
    shell.data(&b"cd fixture\r\n"[..]).await.unwrap();
    assert_eq!(data(&mut shell).await, b"cd fixture\r\n");
    assert_eq!(*fixture.sizes.lock().unwrap(), [(80, 24), (100, 30)]);
    let exec = client.exec("separate").await.unwrap();
    assert_eq!(exec.stdout, b"fresh-exec-channel");
    assert_eq!(exec.exit_status, Some(0));
    let failure = client.exec("fail").await.unwrap();
    assert_eq!(failure.stderr, b"fixture-error");
    assert_eq!(failure.exit_status, Some(7));
    tokio::time::sleep(Duration::from_millis(2200)).await;
    shell.data(&b"still-connected"[..]).await.unwrap();
    assert_eq!(data(&mut shell).await, b"still-connected");
    shell.data(&[3][..]).await.unwrap();
    timeout(Duration::from_secs(5), async {
        while shell.wait().await.is_some() {}
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn public_key_encryption_and_interactive_auth() {
    let fixture = Fixture::start(false).await;
    let encrypted = fixture
        .key
        .encrypt(&mut rand::rng(), fixture.token.as_bytes())
        .unwrap();
    assert!(
        encrypted
            .decrypt(b"intentionally-invalid-fixture-input")
            .is_err()
    );
    let decrypted = encrypted.decrypt(fixture.token.as_bytes()).unwrap();
    let mut client = fixture.connect().await;
    let wrong_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    assert!(!client.public_key("probe", wrong_key).await.unwrap());
    assert!(client.public_key("probe", decrypted).await.unwrap());
    client.disconnect().await.unwrap();
    let mut interactive = fixture.connect().await;
    assert!(
        !interactive
            .keyboard_interactive("probe", |_, _, _| Ok(vec![
                "intentionally-invalid-fixture-input".to_string()
            ]))
            .await
            .unwrap()
    );
    assert!(
        interactive
            .keyboard_interactive("probe", |_, _, prompts| {
                assert_eq!(prompts.len(), 1);
                assert!(!prompts[0].echo);
                Ok(vec![fixture.token.to_string()])
            })
            .await
            .unwrap()
    );
    interactive.disconnect().await.unwrap();
}

#[tokio::test]
async fn changed_host_key_and_prompt_overflow_are_rejected() {
    let fixture = Fixture::start(true).await;
    let other_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let wrong_pin = other_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    assert!(Ssh2Probe::connect(fixture.addr, wrong_pin).await.is_err());
    assert!(
        Ssh2Probe::connect(fixture.addr, String::new())
            .await
            .is_err()
    );
    let mut client = fixture.connect().await;
    assert!(
        client
            .keyboard_interactive("probe", |_, _, _| panic!(
                "oversized challenge must not reach UI"
            ))
            .await
            .is_err()
    );
    client.disconnect().await.unwrap();
}

#[tokio::test]
async fn rejected_requests_limits_and_stalled_exec_fail_closed() {
    let fixture = Fixture::start(false).await;
    let mut client = fixture.connect().await;
    assert!(client.password("probe", &fixture.token).await.unwrap());
    assert!(client.shell(501, 24).await.is_err());
    assert!(client.exec(&"x".repeat(64 * 1024 + 1)).await.is_err());
    assert!(client.exec("reject").await.is_err());
    assert!(client.exec("overflow").await.is_err());
    let start = std::time::Instant::now();
    assert!(client.exec("stall").await.is_err());
    assert!(start.elapsed() < Duration::from_secs(8));
    // A failed isolated exec must leave the transport usable, with no replay.
    assert_eq!(client.exec("separate").await.unwrap().exit_status, Some(0));
    client.disconnect().await.unwrap();
}
