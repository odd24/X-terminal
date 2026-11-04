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
    early_output: bool,
    auth_attempts: Arc<std::sync::atomic::AtomicUsize>,
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
        self.auth_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
        if self.early_output {
            session.data(channel, b"before-pty|".to_vec())?;
        }
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.early_output {
            session.xon_xoff_request(channel, true)?;
            session.data(channel, b"before-shell|".to_vec())?;
        }
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
        if self.early_output {
            session.data(channel, b"before-exec|".to_vec())?;
            session.extended_data(channel, 1, b"before-error|".to_vec())?;
        }
        if command == b"no-ack" {
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
        if command == b"disconnect" {
            return Err(russh::Error::Disconnect);
        }
        if command == b"signal" {
            session.exit_signal_request(channel, russh::Sig::TERM, false, "", "")?;
            session.eof(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        if command == b"no-status" {
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
    auth_attempts: Arc<std::sync::atomic::AtomicUsize>,
    shutdown: server::RunningServerHandle,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn start(excessive_prompts: bool) -> Self {
        Self::options(excessive_prompts, false).await
    }
    async fn options(excessive_prompts: bool, early_output: bool) -> Self {
        Self::with_rekey(excessive_prompts, early_output, false).await
    }
    async fn with_rekey(excessive_prompts: bool, early_output: bool, rekey: bool) -> Self {
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let pin = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let token = Arc::new(rand::random::<u128>().to_string());
        let sizes = Arc::new(Mutex::new(vec![]));
        let auth_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handler = FixtureServer {
            token: token.clone(),
            client_key: key.public_key().clone(),
            sizes: sizes.clone(),
            excessive_prompts,
            early_output,
            auth_attempts: auth_attempts.clone(),
        };
        let config = Arc::new(server::Config {
            limits: if rekey {
                russh::Limits::new(16384, 16384, Duration::from_secs(60))
            } else {
                russh::Limits::default()
            },
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
            auth_attempts,
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

use tokio::sync::mpsc;
use transport_ssh2::session::{
    AuthState, Authentication, Cancellation, Challenge, Error, ExecEnd, ExecOptions, Limits,
    SecretText, ShellEvent, Ssh2Session,
};
fn secret(value: &str) -> SecretText {
    SecretText::new(value.to_owned()).unwrap()
}
async fn production(fixture: &Fixture) -> (Ssh2Session, mpsc::Receiver<Challenge>, Cancellation) {
    let (tx, mut rx) = mpsc::channel(1);
    let cancel = Cancellation::default();
    let token = cancel.clone();
    let port = fixture.addr.port();
    let task = tokio::spawn(async move {
        Ssh2Session::connect(
            "127.0.0.1",
            port,
            tx,
            token,
            Limits {
                keepalive: Duration::from_millis(50),
                ..Limits::default()
            },
        )
        .await
    });
    let Challenge::HostKey { key, answer } = timeout(Duration::from_secs(3), rx.recv())
        .await
        .unwrap()
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(key.fingerprint, fixture.pin);
    assert_eq!(key.algorithm, "ssh-ed25519");
    assert!(!key.bytes.is_empty());
    answer.send(true).unwrap();
    (task.await.unwrap().unwrap(), rx, cancel)
}
#[tokio::test]
async fn production_rekey_rechecks_trust_while_shell_resize_and_exec_share_transport() {
    let fixture = Fixture::with_rekey(false, false, true).await;
    let (mut session, mut challenges, cancel) = production(&fixture).await;
    assert_eq!(
        session
            .authenticate("probe", Authentication::Password(secret(&fixture.token)))
            .await
            .unwrap(),
        AuthState::Authenticated
    );
    let mut shell = session.shell(80, 24).await.unwrap();
    assert_eq!(
        shell.reader.next().await.unwrap(),
        Some(ShellEvent::Stdout(b"fixture-shell\r\n".to_vec()))
    );
    let decisions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = decisions.clone();
    let pin = fixture.pin.clone();
    let stop = cancel.clone();
    let approve = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                challenge = challenges.recv() => {
                    let Some(Challenge::HostKey { key, answer }) = challenge else { panic!("unexpected challenge") };
                    assert_eq!(key.fingerprint, pin);
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    answer.send(true).unwrap();
                }
            }
        }
    });
    let expected: Vec<u8> = (0..512 * 1024).map(|i| (i % 251) as u8).collect();
    timeout(Duration::from_secs(15), async {
        let write = async {
            for (index, bytes) in expected.chunks(32768).enumerate() {
                shell.writer.write(bytes).await.unwrap();
                shell.writer.resize(100 + index as u32, 30).await.unwrap();
            }
        };
        let read = async {
            let mut actual = Vec::new();
            while actual.len() < expected.len() {
                match shell.reader.next().await.unwrap() {
                    Some(ShellEvent::Stdout(bytes)) => actual.extend(bytes),
                    event => panic!("unexpected shell event: {event:?}"),
                }
            }
            assert_eq!(actual, expected);
        };
        let exec = async {
            for _ in 0..4 {
                let result = session
                    .exec("fail", ExecOptions::default(), &cancel)
                    .await
                    .unwrap();
                assert_eq!(result.end, ExecEnd::Completed);
                assert_eq!(result.exit_status, Some(7));
                assert_eq!(result.stderr, b"fixture-error");
                assert!(result.stdout.is_empty());
            }
        };
        tokio::join!(write, read, exec);
        while fixture.sizes.lock().unwrap().len() < 17 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        decisions.load(std::sync::atomic::Ordering::SeqCst) >= 3,
        "rekey must actually enter the trust gate repeatedly"
    );
    assert_eq!(
        fixture
            .auth_attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(
        *fixture.sizes.lock().unwrap(),
        std::iter::once((80, 24))
            .chain((100..116).map(|cols| (cols, 30)))
            .collect::<Vec<_>>()
    );
    cancel.cancel();
    approve.await.unwrap();
}

#[tokio::test]
async fn production_rekey_rejection_closes_transport_without_fabricating_exit_status() {
    let fixture = Fixture::with_rekey(false, false, true).await;
    let (mut session, mut challenges, cancel) = production(&fixture).await;
    assert_eq!(
        session
            .authenticate("probe", Authentication::Password(secret(&fixture.token)))
            .await
            .unwrap(),
        AuthState::Authenticated
    );
    let mut shell = session.shell(80, 24).await.unwrap();
    shell.reader.next().await.unwrap();
    shell.writer.write(&vec![b'r'; 32768]).await.unwrap();
    let Challenge::HostKey { key, answer } = timeout(Duration::from_secs(3), challenges.recv())
        .await
        .expect("rekey must not bypass trust")
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(key.fingerprint, fixture.pin);
    answer.send(false).unwrap();
    timeout(Duration::from_secs(3), async {
        while !session.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    loop {
        match shell.reader.next().await {
            Ok(Some(ShellEvent::Stdout(_))) => {}
            Ok(Some(ShellEvent::Closed {
                remote_close: false,
            }))
            | Err(Error::Transport) => break,
            event => panic!("unexpected rekey rejection outcome: {event:?}"),
        }
    }
    assert_eq!(
        fixture
            .auth_attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    cancel.cancel();
}
#[tokio::test]
async fn production_host_decision_precedes_credentials_and_cancellation_closes_pending_handshake() {
    let fixture = Fixture::start(false).await;
    for approve in [false, true] {
        let (tx, mut rx) = mpsc::channel(1);
        let cancel = Cancellation::default();
        let token = cancel.clone();
        let port = fixture.addr.port();
        let task = tokio::spawn(async move {
            Ssh2Session::connect("127.0.0.1", port, tx, token, Limits::default()).await
        });
        let Challenge::HostKey { mut answer, .. } = rx.recv().await.unwrap() else {
            panic!()
        };
        assert!(!task.is_finished());
        assert_eq!(
            fixture
                .auth_attempts
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        if approve {
            cancel.cancel();
            assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
            timeout(Duration::from_secs(3), answer.closed())
                .await
                .unwrap();
            assert!(answer.send(true).is_err());
        } else {
            answer.send(false).unwrap();
            assert!(matches!(task.await.unwrap(), Err(Error::HostKeyRejected)));
        }
    }
    let (tx, mut rx) = mpsc::channel(1);
    let port = fixture.addr.port();
    let task = tokio::spawn(async move {
        Ssh2Session::connect(
            "127.0.0.1",
            port,
            tx,
            Cancellation::default(),
            Limits {
                decision: Duration::from_millis(40),
                ..Limits::default()
            },
        )
        .await
    });
    let challenge = rx.recv().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Timeout)));
    drop(challenge);
    assert_eq!(
        fixture
            .auth_attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}
#[tokio::test]
async fn production_preserves_early_output_and_shares_shell_and_exec_transport() {
    let fixture = Fixture::options(false, true).await;
    let (mut session, _rx, cancel) = production(&fixture).await;
    assert!(matches!(
        session.shell(80, 24).await,
        Err(Error::AuthenticationRequired)
    ));
    assert_eq!(
        session
            .authenticate(
                "probe",
                Authentication::Password(secret("wrong synthetic password"))
            )
            .await
            .unwrap(),
        AuthState::Rejected
    );
    assert_eq!(
        session
            .authenticate("probe", Authentication::Password(secret(&fixture.token)))
            .await
            .unwrap(),
        AuthState::Authenticated
    );
    let mut shell = session.shell(80, 24).await.unwrap();
    let mut bytes = Vec::new();
    for _ in 0..3 {
        let Some(ShellEvent::Stdout(data)) = shell.reader.next().await.unwrap() else {
            panic!()
        };
        bytes.extend(data);
    }
    assert_eq!(bytes, b"before-pty|before-shell|fixture-shell\r\n");
    shell.writer.resize(101, 31).await.unwrap();
    assert_eq!(shell.writer.write(b"same-channel-input").await.unwrap(), 18);
    assert!(
        matches!(shell.reader.next().await.unwrap(),Some(ShellEvent::Stdout(v)) if v==b"same-channel-input")
    );
    let result = session
        .exec("fail", ExecOptions::default(), &Cancellation::default())
        .await
        .unwrap();
    assert_eq!(result.end, ExecEnd::Completed);
    assert_eq!(result.exit_status, Some(7));
    assert_eq!(result.stdout, b"before-exec|");
    assert_eq!(result.stderr, b"before-error|fixture-error");
    assert!(result.request_accepted);
    tokio::time::sleep(Duration::from_millis(220)).await;
    shell.writer.write(b"after-exec").await.unwrap();
    assert!(
        matches!(shell.reader.next().await.unwrap(),Some(ShellEvent::Stdout(v)) if v==b"after-exec")
    );
    assert_eq!(*fixture.sizes.lock().unwrap(), [(80, 24), (101, 31)]);
    cancel.cancel();
    assert!(matches!(
        shell.writer.write(b"never-queue-after-cancel").await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(shell.reader.next().await, Err(Error::Cancelled)));
}
#[tokio::test]
async fn production_encrypted_key_and_async_interactive_auth_have_no_secret_debug_output() {
    let fixture = Fixture::start(false).await;
    let key = fixture
        .key
        .encrypt(&mut rand::rng(), fixture.token.as_bytes())
        .unwrap()
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let auth = Authentication::PublicKey {
        pem: secret(&key),
        passphrase: Some(secret(&fixture.token)),
    };
    assert!(!format!("{auth:?}").contains(fixture.token.as_str()));
    assert!(!format!("{auth:?}").contains("PRIVATE KEY"));
    let (mut session, _rx, _cancel) = production(&fixture).await;
    assert_eq!(
        session.authenticate("probe", auth).await.unwrap(),
        AuthState::Authenticated
    );
    session.disconnect().await.unwrap();
    let (mut session, _rx, _cancel) = production(&fixture).await;
    assert_eq!(
        session
            .authenticate(
                "probe",
                Authentication::PublicKey {
                    pem: secret(&key),
                    passphrase: Some(secret("wrong fixture passphrase"))
                }
            )
            .await,
        Err(Error::InvalidKey)
    );
    let (mut session, mut rx, _cancel) = production(&fixture).await;
    let auth = tokio::spawn(async move {
        let state = session
            .authenticate("probe", Authentication::KeyboardInteractive)
            .await;
        (session, state)
    });
    let Challenge::Authentication { challenge, answer } = rx.recv().await.unwrap() else {
        panic!()
    };
    assert_eq!(challenge.prompts.len(), 1);
    assert!(!challenge.prompts[0].echo);
    assert_eq!(challenge.prompts[0].text, "Token: ");
    answer.send(vec![secret(&fixture.token)]).unwrap();
    let (session, result) = auth.await.unwrap();
    assert_eq!(result.unwrap(), AuthState::Authenticated);
    session.disconnect().await.unwrap();
    let excessive = Fixture::start(true).await;
    let (mut session, mut rx, _cancel) = production(&excessive).await;
    assert_eq!(
        session
            .authenticate("probe", Authentication::KeyboardInteractive)
            .await,
        Err(Error::Limit)
    );
    assert!(rx.try_recv().is_err());
}
#[tokio::test]
async fn production_exec_reports_partial_timeout_cancel_limits_signal_and_absent_exit_status() {
    let fixture = Fixture::options(false, true).await;
    let (mut session, _rx, _cancel) = production(&fixture).await;
    session
        .authenticate("probe", Authentication::Password(secret(&fixture.token)))
        .await
        .unwrap();
    let options = ExecOptions {
        timeout: Duration::from_millis(80),
        ..ExecOptions::default()
    };
    for (command, end, accepted) in [
        ("stall", ExecEnd::Timeout, true),
        ("no-ack", ExecEnd::Timeout, false),
        ("reject", ExecEnd::Rejected, false),
        ("no-status", ExecEnd::MissingExitStatus, true),
        ("signal", ExecEnd::RemoteSignal, true),
    ] {
        let result = session
            .exec(command, options, &Cancellation::default())
            .await
            .unwrap();
        assert_eq!(result.end, end, "{command}");
        assert_eq!(result.request_accepted, accepted);
        assert_eq!(result.exit_status, None);
        if command != "reject" {
            assert_eq!(result.stdout, b"before-exec|");
            assert_eq!(result.stderr, b"before-error|");
        }
        if command == "signal" {
            assert_eq!(result.exit_signal.unwrap().name, "TERM");
        }
    }
    let result = session
        .exec(
            "overflow",
            ExecOptions {
                max_output_bytes: 64,
                ..ExecOptions::default()
            },
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.end, ExecEnd::OutputLimit);
    assert!(result.output_truncated);
    assert_eq!(result.stdout.len() + result.stderr.len(), 64);
    let token = Cancellation::default();
    let copy = token.clone();
    let cancel_task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        copy.cancel();
    });
    let result = session
        .exec("stall", ExecOptions::default(), &token)
        .await
        .unwrap();
    cancel_task.await.unwrap();
    assert_eq!(result.end, ExecEnd::Cancelled);
    assert!(result.request_accepted);
    assert_eq!(result.stdout, b"before-exec|");
    assert_eq!(
        session
            .exec("separate", ExecOptions::default(), &Cancellation::default())
            .await
            .unwrap()
            .exit_status,
        Some(0)
    );
    let result = session
        .exec(
            "disconnect",
            ExecOptions::default(),
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.end, ExecEnd::TransportLost);
    assert_eq!(result.exit_status, None);
}
#[tokio::test]
async fn production_owner_drop_and_pre_key_timeout_close_real_sockets() {
    let fixture = Fixture::start(false).await;
    let (mut session, _rx, _cancel) = production(&fixture).await;
    session
        .authenticate("probe", Authentication::Password(secret(&fixture.token)))
        .await
        .unwrap();
    let mut shell = session.shell(80, 24).await.unwrap();
    assert!(matches!(
        shell.reader.next().await.unwrap(),
        Some(ShellEvent::Stdout(_))
    ));
    drop(session);
    timeout(Duration::from_secs(3), async {
        loop {
            if matches!(
                shell.reader.next().await.unwrap(),
                Some(ShellEvent::Closed { .. }) | None
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(2), socket.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(bytes.starts_with(b"SSH-2.0"));
    });
    let (tx, _rx) = mpsc::channel(1);
    assert!(matches!(
        Ssh2Session::connect(
            "127.0.0.1",
            port,
            tx,
            Cancellation::default(),
            Limits {
                connect: Duration::from_millis(30),
                decision: Duration::from_millis(30),
                ..Limits::default()
            }
        )
        .await,
        Err(Error::Timeout)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn streaming_exec_delivers_before_request_acknowledgement_and_cancel_preserves_partial_result()
 {
    let fixture = Fixture::options(false, true).await;
    let (mut session, _rx, _cancel) = production(&fixture).await;
    session
        .authenticate("probe", Authentication::Password(secret(&fixture.token)))
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::channel(1);
    let cancel = Cancellation::default();
    let copy = cancel.clone();
    let task = tokio::spawn(async move {
        let result = session
            .exec_streaming("no-ack", ExecOptions::default(), &copy, tx)
            .await;
        (session, result)
    });
    let first = timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!first.stderr);
    assert_eq!(first.bytes, b"before-exec|");
    let second = timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(second.stderr);
    assert_eq!(second.bytes, b"before-error|");
    assert!(!task.is_finished());
    cancel.cancel();
    let (session, result) = task.await.unwrap();
    let result = result.unwrap();
    assert_eq!(result.end, ExecEnd::Cancelled);
    assert!(!result.request_accepted);
    assert_eq!(result.stdout, first.bytes);
    assert_eq!(result.stderr, second.bytes);
    assert_eq!(
        session
            .exec("separate", ExecOptions::default(), &Cancellation::default())
            .await
            .unwrap()
            .exit_status,
        Some(0)
    );
}

#[tokio::test]
async fn streaming_exec_backpressure_cancel_keeps_captured_tail_in_bounded_outcome() {
    let fixture = Fixture::options(false, true).await;
    let (mut session, _rx, _cancel) = production(&fixture).await;
    session
        .authenticate("probe", Authentication::Password(secret(&fixture.token)))
        .await
        .unwrap();
    let (tx, rx) = mpsc::channel(1);
    let cancel = Cancellation::default();
    let copy = cancel.clone();
    let task = tokio::spawn(async move {
        session
            .exec_streaming("no-ack", ExecOptions::default(), &copy, tx)
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(2), async {
        while rx.len() != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    })
    .await
    .unwrap();
    cancel.cancel();
    let result = task.await.unwrap();
    assert_eq!(result.end, ExecEnd::Cancelled);
    assert_eq!(result.stdout, b"before-exec|");
    assert_eq!(result.stderr, b"before-error|");
    assert_eq!(rx.len(), 1);
}
