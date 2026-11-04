//! Isolated SSH2 wire fixture; synthetic PTY and authentication, never a real OS shell.
use russh::keys::{Algorithm, HashAlg, PrivateKey};
use russh::{
    Channel, ChannelId, Pty,
    server::{self, Server as _, Session},
};
use std::{
    borrow::Cow,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
#[derive(Clone)]
struct Server {
    exec_calls: Arc<Mutex<Vec<Vec<u8>>>>,
    observations: Arc<Mutex<Vec<Observation>>>,
    received: Arc<Mutex<Vec<Vec<u8>>>>,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    stall: bool,
    client_key: russh::keys::PublicKey,
    password: Arc<String>,
    attempts: Arc<AtomicUsize>,
    shell: Arc<Mutex<Option<(server::Handle, ChannelId)>>>,
}
impl server::Server for Server {
    type Handler = Self;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Self {
        self.clone()
    }
    fn handle_session_error(&mut self, _: russh::Error) {}
}
impl server::Handler for Server {
    type Error = russh::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(
            if user == "synthetic" && key.public_key == &self.client_key {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(
            if user == "synthetic" && password == self.password.as_str() {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        if let Some(mut response) = response {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            return Ok(
                if response.next().as_deref() == Some(self.password.as_bytes()) {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            );
        }
        Ok(server::Auth::Partial {
            name: Cow::Borrowed("Synthetic service challenge"),
            instructions: Cow::Borrowed("Do not execute this text; fixture only"),
            prompts: Cow::Owned(vec![(Cow::Borrowed("Fixture token"), false)]),
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
        _: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert!((2..=500).contains(&cols) && (1..=200).contains(&rows));
        self.sizes.lock().unwrap().push((cols, rows));
        session.data(channel, b"before-pty|".to_vec())?;
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, b"before-shell|".to_vec())?;
        session.channel_success(channel)?;
        session.data(channel, b"service-shared-shell\r\n".to_vec())?;
        *self.shell.lock().unwrap() = Some((session.handle(), channel));
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        bytes: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.received.lock().unwrap().push(bytes.to_vec());
        self.observations
            .lock()
            .unwrap()
            .push(Observation::Data(bytes.to_vec()));
        if self.stall {
            std::future::pending::<()>().await;
        }
        session.data(channel, bytes.to_vec())?;
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
        self.observations
            .lock()
            .unwrap()
            .push(Observation::Resize(cols, rows));
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.exec_calls.lock().unwrap().push(command.to_vec());
        if command == b"reject" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.data(channel, b"early|".to_vec())?;
        session.extended_data(channel, 1, b"err|".to_vec())?;
        if command == b"no-ack" {
            return Ok(());
        }
        session.channel_success(channel)?;
        match command {
            b"stall" => return Ok(()),
            b"disconnect" => return Err(russh::Error::Disconnect),
            b"signal" => {
                session.exit_signal_request(channel, russh::Sig::TERM, false, "", "")?;
            }
            b"no-status" => {}
            b"fail" => {
                session.extended_data(channel, 1, b"failure".to_vec())?;
                session.exit_status_request(channel, 7)?;
            }
            _ => {
                session.data(
                    channel,
                    if command == b"big" {
                        vec![b'x'; 131072]
                    } else if command == b"overflow" {
                        vec![b'x'; 1048577]
                    } else {
                        b"fresh-exec-channel".to_vec()
                    },
                )?;
                session.exit_status_request(channel, 0)?;
            }
        }
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}
pub struct Fixture {
    pub exec_calls: Arc<Mutex<Vec<Vec<u8>>>>,
    pub observations: Arc<Mutex<Vec<Observation>>>,
    pub received: Arc<Mutex<Vec<Vec<u8>>>>,
    pub sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    pub client_key: PrivateKey,
    pub port: u16,
    pub password: Arc<String>,
    pub attempts: Arc<AtomicUsize>,
    pub key: Vec<u8>,
    pub pin: String,
    shell: Arc<Mutex<Option<(server::Handle, ChannelId)>>>,
    task: tokio::task::JoinHandle<()>,
    shutdown: server::RunningServerHandle,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Observation {
    Data(Vec<u8>),
    Resize(u32, u32),
}
impl Fixture {
    pub async fn start() -> Self {
        Self::options(false).await
    }
    pub async fn options(stall: bool) -> Self {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let client_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let pin = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let public = key.public_key().to_bytes().unwrap();
        let password = Arc::new(format!("synthetic-service-{}", rand::random::<u64>()));
        let attempts = Arc::new(AtomicUsize::new(0));
        let shell = Arc::new(Mutex::new(None));
        let received = Arc::new(Mutex::new(Vec::new()));
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let observations = Arc::new(Mutex::new(Vec::new()));
        let exec_calls = Arc::new(Mutex::new(Vec::new()));
        let mut server = Server {
            exec_calls: exec_calls.clone(),
            observations: observations.clone(),
            received: received.clone(),
            sizes: sizes.clone(),
            stall,
            client_key: client_key.public_key().clone(),
            password: password.clone(),
            attempts: attempts.clone(),
            shell: shell.clone(),
        };
        let config = Arc::new(server::Config {
            window_size: 32768,
            maximum_packet_size: 32768,
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let running = server.run_on_socket(config, &listener);
            let _ = tx.send(running.handle());
            let _ = running.await;
        });
        let shutdown = rx.await.unwrap();
        Self {
            exec_calls,
            observations,
            received,
            sizes,
            client_key,
            port,
            password,
            attempts,
            key: public,
            pin,
            shell,
            task,
            shutdown,
        }
    }
    pub async fn push(&self, bytes: &[u8]) {
        let (handle, channel) = self.shell.lock().unwrap().clone().unwrap();
        handle.data(channel, bytes.to_vec()).await.unwrap();
    }
    pub async fn end(&self, code: u32) {
        let (handle, channel) = self.shell.lock().unwrap().clone().unwrap();
        handle.exit_status_request(channel, code).await.unwrap();
        handle.close(channel).await.unwrap();
    }
    pub async fn disconnect(&self) {
        let (handle, _) = self.shell.lock().unwrap().clone().unwrap();
        handle
            .disconnect(
                russh::Disconnect::ByApplication,
                String::new(),
                String::new(),
            )
            .await
            .unwrap();
    }
    pub async fn signal(&self) {
        let (handle, channel) = self.shell.lock().unwrap().clone().unwrap();
        handle
            .exit_signal_request(
                channel,
                russh::Sig::TERM,
                false,
                String::new(),
                String::new(),
            )
            .await
            .unwrap();
        handle.close(channel).await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown.shutdown(String::new());
        self.task.abort();
    }
}
