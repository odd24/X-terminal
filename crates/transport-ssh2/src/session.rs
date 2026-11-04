//! Service-owned SSH2 primitives. No configuration, UI, implicit trust or command replay.
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, client};
use std::{collections::VecDeque, future::Future, net::Shutdown, sync::Arc, time::Duration};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use zeroize::Zeroizing;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid SSH2 operation")]
    Invalid,
    #[error("SSH2 operation cancelled; remote actions are not undone")]
    Cancelled,
    #[error("SSH2 operation timed out; remote result may be unknown")]
    Timeout,
    #[error("SSH2 transport failed")]
    Transport,
    #[error("SSH2 host key rejected")]
    HostKeyRejected,
    #[error("SSH2 host certificates require an unsupported CA policy")]
    HostCertificateUnsupported,
    #[error("SSH2 approval channel unavailable")]
    ApprovalUnavailable,
    #[error("SSH2 peer exceeded limits")]
    Limit,
    #[error("SSH2 channel request rejected")]
    RequestRejected,
    #[error("SSH2 channel closed before acknowledgement")]
    Closed,
    #[error("SSH2 private key or passphrase invalid")]
    InvalidKey,
    #[error("SSH2 authentication required")]
    AuthenticationRequired,
}
impl From<russh::Error> for Error {
    fn from(_: russh::Error) -> Self {
        Self::Transport
    }
}

/// Cloneable, one-way cancellation. Dropping a clone does not cancel other owners.
#[derive(Clone)]
pub struct Cancellation(watch::Sender<bool>);
impl Default for Cancellation {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}
impl Cancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    pub async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}
pub struct SecretText(Zeroizing<String>);
impl SecretText {
    pub fn new(value: String) -> Result<Self> {
        let value = Zeroizing::new(value);
        if value.len() > 65536 {
            return Err(Error::Limit);
        }
        Ok(Self(value))
    }
    fn expose(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for SecretText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}
#[derive(Debug)]
pub enum Authentication {
    Password(SecretText),
    PublicKey {
        pem: SecretText,
        passphrase: Option<SecretText>,
    },
    KeyboardInteractive,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthState {
    Authenticated,
    Rejected,
    FurtherAuthenticationRequired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerKey {
    pub algorithm: String,
    pub bytes: Vec<u8>,
    pub fingerprint: String,
}
#[derive(Debug)]
pub struct Prompt {
    pub text: String,
    pub echo: bool,
}
#[derive(Debug)]
pub struct AuthChallenge {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<Prompt>,
}
#[derive(Debug)]
pub enum Challenge {
    HostKey {
        key: ServerKey,
        answer: oneshot::Sender<bool>,
    },
    Authentication {
        challenge: AuthChallenge,
        answer: oneshot::Sender<Vec<SecretText>>,
    },
}
#[derive(Debug, Clone)]
pub struct Limits {
    pub connect: Duration,
    pub control: Duration,
    pub decision: Duration,
    pub keepalive: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            control: Duration::from_secs(15),
            decision: Duration::from_secs(120),
            keepalive: Duration::from_secs(30),
        }
    }
}
impl Limits {
    fn validate(&self) -> Result<()> {
        for (value, max) in [
            (self.connect, 120),
            (self.control, 120),
            (self.decision, 600),
            (self.keepalive, 300),
        ] {
            if value.is_zero() || value > Duration::from_secs(max) {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
}
async fn bounded<T>(
    cancel: &Cancellation,
    duration: Duration,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! { biased; _=cancel.cancelled()=>Err(Error::Cancelled), result=timeout(duration,future)=>result.map_err(|_|Error::Timeout)? }
}

/// Explicitly shuts down the shared OS socket even if russh's detached task still owns a handle.
struct SocketGuard {
    socket: std::net::TcpStream,
    monitor: tokio::task::JoinHandle<()>,
}
impl SocketGuard {
    fn new(socket: std::net::TcpStream, cancel: Cancellation) -> Result<Self> {
        let copy = socket.try_clone().map_err(|_| Error::Transport)?;
        let monitor = tokio::spawn(async move {
            cancel.cancelled().await;
            let _ = copy.shutdown(Shutdown::Both);
        });
        Ok(Self { socket, monitor })
    }
    fn close(&self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.close();
        self.monitor.abort();
    }
}
struct Gate {
    challenges: mpsc::Sender<Challenge>,
    cancel: Cancellation,
    decision: Duration,
}
impl client::Handler for Gate {
    type Error = Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        if key.certificate().is_some() {
            return Err(Error::HostCertificateUnsupported);
        }
        let bytes = key.public_key().to_bytes().map_err(|_| Error::Transport)?;
        if bytes.is_empty() || bytes.len() > 16384 {
            return Err(Error::Limit);
        }
        let key = ServerKey {
            algorithm: key.public_key().algorithm().to_string(),
            bytes,
            fingerprint: key.public_key().fingerprint(HashAlg::Sha256).to_string(),
        };
        let (answer, receiver) = oneshot::channel();
        bounded(&self.cancel, self.decision, async {
            self.challenges
                .send(Challenge::HostKey { key, answer })
                .await
                .map_err(|_| Error::ApprovalUnavailable)?;
            if receiver.await.map_err(|_| Error::ApprovalUnavailable)? {
                Ok(true)
            } else {
                Err(Error::HostKeyRejected)
            }
        })
        .await
    }
}

pub struct Ssh2Session {
    handle: client::Handle<Gate>,
    socket: SocketGuard,
    cancel: Cancellation,
    limits: Limits,
    challenges: mpsc::Sender<Challenge>,
    authenticated: bool,
}
impl Ssh2Session {
    /// The owner must evaluate every key against its endpoint/generation-scoped trust policy.
    pub async fn connect(
        host: &str,
        port: u16,
        challenges: mpsc::Sender<Challenge>,
        cancel: Cancellation,
        limits: Limits,
    ) -> Result<Self> {
        limits.validate()?;
        if host.is_empty()
            || host.len() > 253
            || host.chars().any(char::is_control)
            || port == 0
            || challenges.max_capacity() > 8
        {
            return Err(Error::Invalid);
        }
        let tcp = bounded(&cancel, limits.connect, async {
            TcpStream::connect((host, port))
                .await
                .map_err(|_| Error::Transport)
        })
        .await?;
        tcp.set_nodelay(true).map_err(|_| Error::Transport)?;
        let raw = tcp.into_std().map_err(|_| Error::Transport)?;
        let tcp = TcpStream::from_std(raw.try_clone().map_err(|_| Error::Transport)?)
            .map_err(|_| Error::Transport)?;
        let socket = SocketGuard::new(raw, cancel.clone())?;
        let config = Arc::new(client::Config {
            preferred: russh::Preferred {
                compression: std::borrow::Cow::Borrowed(&[russh::compression::NONE]),
                ..Default::default()
            },
            keepalive_interval: Some(limits.keepalive),
            keepalive_max: 3,
            window_size: 256 * 1024,
            maximum_packet_size: 32 * 1024,
            channel_buffer_size: 32,
            ..Default::default()
        });
        let handle = bounded(&cancel, limits.connect + limits.decision, async {
            client::connect_stream(
                config,
                tcp,
                Gate {
                    challenges: challenges.clone(),
                    cancel: cancel.clone(),
                    decision: limits.decision,
                },
            )
            .await
        })
        .await?;
        Ok(Self {
            handle,
            socket,
            cancel,
            limits,
            challenges,
            authenticated: false,
        })
    }
    pub fn is_closed(&self) -> bool {
        self.cancel.is_cancelled() || self.handle.is_closed()
    }
    pub async fn authenticate(
        &mut self,
        user: &str,
        authentication: Authentication,
    ) -> Result<AuthState> {
        if user.is_empty()
            || user.len() > 256
            || user.chars().any(char::is_control)
            || self.authenticated
            || self.is_closed()
        {
            return Err(Error::Invalid);
        }
        let result = self.authenticate_inner(user, authentication).await;
        // An interrupted auth exchange cannot safely share subsequent response messages.
        if result.is_err() {
            self.socket.close();
        }
        if matches!(result, Ok(AuthState::Authenticated)) {
            self.authenticated = true;
        }
        result
    }
    async fn authenticate_inner(
        &mut self,
        user: &str,
        authentication: Authentication,
    ) -> Result<AuthState> {
        let result = match authentication {
            Authentication::Password(secret) => {
                bounded(&self.cancel, self.limits.control, async {
                    self.handle
                        .authenticate_password(user, secret.expose())
                        .await
                        .map_err(Error::from)
                })
                .await?
            }
            Authentication::PublicKey { pem, passphrase } => {
                // Key decryption can be CPU intensive; isolate it from the async runtime worker.
                static PARSERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
                let permit = PARSERS.try_acquire().map_err(|_| Error::Limit)?;
                let parse = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    crate::key_cost::check(pem.expose())?;
                    russh::keys::decode_secret_key(
                        pem.expose(),
                        passphrase.as_ref().map(SecretText::expose),
                    )
                    .map_err(|_| Error::InvalidKey)
                });
                let key = bounded(&self.cancel, self.limits.control, async {
                    parse.await.map_err(|_| Error::InvalidKey)?
                })
                .await?;
                let hash = bounded(&self.cancel, self.limits.control, async {
                    self.handle
                        .best_supported_rsa_hash()
                        .await
                        .map_err(Error::from)
                })
                .await?
                .flatten();
                bounded(&self.cancel, self.limits.control, async {
                    self.handle
                        .authenticate_publickey(
                            user,
                            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                        )
                        .await
                        .map_err(Error::from)
                })
                .await?
            }
            Authentication::KeyboardInteractive => return self.interactive(user).await,
        };
        Ok(match result {
            client::AuthResult::Success => AuthState::Authenticated,
            client::AuthResult::Failure {
                partial_success: true,
                ..
            } => AuthState::FurtherAuthenticationRequired,
            _ => AuthState::Rejected,
        })
    }
    async fn interactive(&mut self, user: &str) -> Result<AuthState> {
        let mut response = bounded(&self.cancel, self.limits.control, async {
            self.handle
                .authenticate_keyboard_interactive_start(user, None)
                .await
                .map_err(Error::from)
        })
        .await?;
        let mut rounds = 0;
        loop {
            match response {
                client::KeyboardInteractiveAuthResponse::Success => {
                    return Ok(AuthState::Authenticated);
                }
                client::KeyboardInteractiveAuthResponse::Failure {
                    partial_success, ..
                } => {
                    return Ok(if partial_success {
                        AuthState::FurtherAuthenticationRequired
                    } else {
                        AuthState::Rejected
                    });
                }
                client::KeyboardInteractiveAuthResponse::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => {
                    if rounds >= 8
                        || prompts.len() > 16
                        || name.len()
                            + instructions.len()
                            + prompts.iter().map(|p| p.prompt.len()).sum::<usize>()
                            > 8192
                    {
                        return Err(Error::Limit);
                    }
                    rounds += 1;
                    let count = prompts.len();
                    let challenge = AuthChallenge {
                        name,
                        instructions,
                        prompts: prompts
                            .into_iter()
                            .map(|p| Prompt {
                                text: p.prompt,
                                echo: p.echo,
                            })
                            .collect(),
                    };
                    let (answer, receiver) = oneshot::channel();
                    let answers = bounded(&self.cancel, self.limits.decision, async {
                        self.challenges
                            .send(Challenge::Authentication { challenge, answer })
                            .await
                            .map_err(|_| Error::ApprovalUnavailable)?;
                        receiver.await.map_err(|_| Error::ApprovalUnavailable)
                    })
                    .await?;
                    if answers.len() != count
                        || answers.iter().map(|v| v.expose().len()).sum::<usize>() > 8192
                    {
                        return Err(Error::Limit);
                    }
                    response = bounded(&self.cancel, self.limits.control, async {
                        self.handle
                            .authenticate_keyboard_interactive_respond(
                                answers.iter().map(|v| v.expose().to_owned()).collect(),
                            )
                            .await
                            .map_err(Error::from)
                    })
                    .await?;
                }
            }
        }
    }
    pub async fn shell(&self, cols: u32, rows: u32) -> Result<Shell> {
        size(cols, rows)?;
        if !self.authenticated {
            return Err(Error::AuthenticationRequired);
        }
        let mut channel = bounded(&self.cancel, self.limits.control, async {
            self.handle
                .channel_open_session()
                .await
                .map_err(Error::from)
        })
        .await?;
        let mut early = Early::default();
        let result = bounded(&self.cancel, self.limits.control, async {
            channel
                .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
                .await?;
            acknowledge(&mut channel, &mut early).await?;
            channel.request_shell(true).await?;
            acknowledge(&mut channel, &mut early).await
        })
        .await;
        if let Err(error) = result {
            let _ = timeout(Duration::from_millis(100), channel.close()).await;
            return Err(error);
        }
        let (read, write) = channel.split();
        Ok(Shell {
            reader: ShellReader {
                read,
                early,
                cancel: self.cancel.clone(),
                closed: false,
            },
            writer: ShellWriter {
                write,
                cancel: self.cancel.clone(),
                deadline: self.limits.control,
            },
        })
    }
    pub async fn disconnect(&self) -> Result<()> {
        let result = match timeout(
            self.limits.control,
            self.handle
                .disconnect(russh::Disconnect::ByApplication, "", ""),
        )
        .await
        {
            Ok(value) => value.map_err(Error::from),
            Err(_) => Err(Error::Timeout),
        };
        self.socket.close();
        result
    }
}
fn size(cols: u32, rows: u32) -> Result<()> {
    if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
        Err(Error::Invalid)
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Eof,
    ExitStatus(u32),
    ExitSignal { signal: String, core_dumped: bool },
    Closed { remote_close: bool },
}
fn event(message: ChannelMsg) -> Result<Option<ShellEvent>> {
    Ok(match message {
        ChannelMsg::Data { data } => {
            if data.len() > 65536 {
                return Err(Error::Limit);
            }
            Some(ShellEvent::Stdout(data.to_vec()))
        }
        ChannelMsg::ExtendedData { data, ext: 1 } => {
            if data.len() > 65536 {
                return Err(Error::Limit);
            }
            Some(ShellEvent::Stderr(data.to_vec()))
        }
        ChannelMsg::ExtendedData { .. } => return Err(Error::Limit),
        ChannelMsg::Eof => Some(ShellEvent::Eof),
        ChannelMsg::ExitStatus { exit_status } => Some(ShellEvent::ExitStatus(exit_status)),
        ChannelMsg::ExitSignal {
            signal_name,
            core_dumped,
            error_message,
            lang_tag,
        } => {
            let signal = match signal_name {
                russh::Sig::Custom(value) => value,
                value => format!("{value:?}"),
            };
            if signal.len() > 128 || error_message.len() + lang_tag.len() > 8192 {
                return Err(Error::Limit);
            }
            Some(ShellEvent::ExitSignal {
                signal,
                core_dumped,
            })
        }
        ChannelMsg::Close => Some(ShellEvent::Closed { remote_close: true }),
        ChannelMsg::WindowAdjusted { .. } | ChannelMsg::XonXoff { .. } => None,
        _ => return Err(Error::RequestRejected),
    })
}
#[derive(Default)]
struct Early {
    events: VecDeque<ShellEvent>,
    bytes: usize,
}
impl Early {
    fn push(&mut self, event: ShellEvent) -> Result<()> {
        let bytes = match &event {
            ShellEvent::Stdout(v) | ShellEvent::Stderr(v) => v.len(),
            _ => 0,
        };
        if self.events.len() >= 256 || self.bytes + bytes > 65536 {
            return Err(Error::Limit);
        }
        self.bytes += bytes;
        self.events.push_back(event);
        Ok(())
    }
    fn pop(&mut self) -> Option<ShellEvent> {
        let event = self.events.pop_front()?;
        if let ShellEvent::Stdout(v) | ShellEvent::Stderr(v) = &event {
            self.bytes -= v.len();
        }
        Some(event)
    }
}
async fn acknowledge(channel: &mut Channel<client::Msg>, early: &mut Early) -> Result<()> {
    let mut count = 0;
    loop {
        count += 1;
        if count > 256 {
            return Err(Error::Limit);
        }
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => return Err(Error::RequestRejected),
            Some(ChannelMsg::Close | ChannelMsg::Eof) | None => return Err(Error::Closed),
            Some(message) => {
                if let Some(value) = event(message)? {
                    early.push(value)?;
                }
            }
        }
    }
}
pub struct Shell {
    pub reader: ShellReader,
    pub writer: ShellWriter,
}
pub struct ShellReader {
    read: russh::ChannelReadHalf,
    early: Early,
    cancel: Cancellation,
    closed: bool,
}
impl ShellReader {
    pub async fn next(&mut self) -> Result<Option<ShellEvent>> {
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if self.closed {
            return Ok(None);
        }
        if let Some(event) = self.early.pop() {
            return Ok(Some(event));
        }
        loop {
            let message = tokio::select! {biased;_=self.cancel.cancelled()=>return Err(Error::Cancelled),value=self.read.wait()=>value};
            let event = match message {
                Some(message) => event(message)?,
                None => Some(ShellEvent::Closed {
                    remote_close: false,
                }),
            };
            if let Some(event) = event {
                if matches!(event, ShellEvent::Closed { .. }) {
                    self.closed = true;
                }
                return Ok(Some(event));
            }
        }
    }
}
pub struct ShellWriter {
    write: russh::ChannelWriteHalf<client::Msg>,
    cancel: Cancellation,
    deadline: Duration,
}
impl ShellWriter {
    /// Success acknowledges queuing to the SSH pipeline, not remote execution. Any error may follow a partial send.
    pub async fn write(&self, bytes: &[u8]) -> Result<usize> {
        if bytes.len() > 65536 {
            return Err(Error::Limit);
        }
        bounded(&self.cancel, self.deadline, async {
            self.write
                .data_bytes(bytes.to_vec())
                .await
                .map_err(Error::from)
        })
        .await?;
        Ok(bytes.len())
    }
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        size(cols, rows)?;
        bounded(&self.cancel, self.deadline, async {
            self.write
                .window_change(cols, rows, 0, 0)
                .await
                .map_err(Error::from)
        })
        .await
    }
    pub async fn close(&self) -> Result<()> {
        bounded(&self.cancel, self.deadline, async {
            self.write.close().await.map_err(Error::from)
        })
        .await
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ExecOptions {
    pub timeout: Duration,
    pub max_output_bytes: usize,
}
impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(600),
            max_output_bytes: 1024 * 1024,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecEnd {
    Completed,
    RemoteSignal,
    MissingExitStatus,
    TransportLost,
    Rejected,
    Timeout,
    Cancelled,
    OutputLimit,
    ProtocolFailure,
}
#[derive(Debug, PartialEq, Eq)]
pub struct RemoteSignal {
    pub name: String,
    pub core_dumped: bool,
}
#[derive(Debug)]
pub struct ExecOutcome {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
    pub exit_signal: Option<RemoteSignal>,
    pub request_accepted: bool,
    pub output_truncated: bool,
    pub end: ExecEnd,
}
impl ExecOutcome {
    fn bytes(&mut self, bytes: Vec<u8>, stderr: bool, limit: usize) -> Option<ExecEnd> {
        let keep = bytes
            .len()
            .min(limit.saturating_sub(self.stdout.len() + self.stderr.len()));
        let target = if stderr {
            &mut self.stderr
        } else {
            &mut self.stdout
        };
        target.extend_from_slice(&bytes[..keep]);
        if keep < bytes.len() {
            self.output_truncated = true;
            Some(ExecEnd::OutputLimit)
        } else {
            None
        }
    }
    fn consume(&mut self, value: ShellEvent, limit: usize) -> Option<ExecEnd> {
        match value {
            ShellEvent::Stdout(bytes) => return self.bytes(bytes, false, limit),
            ShellEvent::Stderr(bytes) => return self.bytes(bytes, true, limit),
            ShellEvent::ExitStatus(code) => self.exit_status = Some(code),
            ShellEvent::ExitSignal {
                signal,
                core_dumped,
            } => {
                self.exit_signal = Some(RemoteSignal {
                    name: signal,
                    core_dumped,
                })
            }
            ShellEvent::Closed {
                remote_close: false,
            } => return Some(ExecEnd::TransportLost),
            ShellEvent::Closed { remote_close: true } => {
                return Some(if self.exit_signal.is_some() {
                    ExecEnd::RemoteSignal
                } else if self.exit_status.is_some() {
                    ExecEnd::Completed
                } else {
                    ExecEnd::MissingExitStatus
                });
            }
            ShellEvent::Eof => {}
        }
        None
    }
}
impl Ssh2Session {
    /// Separate SSH exec channel: no shell cwd/environment and no automatic retries.
    /// After attempting the request, remote execution may have occurred even without an acknowledgement.
    pub async fn exec(
        &self,
        command: &str,
        options: ExecOptions,
        cancel: &Cancellation,
    ) -> Result<ExecOutcome> {
        if command.len() > 65536
            || options.timeout.is_zero()
            || options.timeout > Duration::from_secs(86400)
            || !(1..=16 * 1024 * 1024).contains(&options.max_output_bytes)
        {
            return Err(Error::Invalid);
        }
        if !self.authenticated {
            return Err(Error::AuthenticationRequired);
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut channel = bounded(&self.cancel, self.limits.control, async {
            self.handle
                .channel_open_session()
                .await
                .map_err(Error::from)
        })
        .await?;
        if cancel.is_cancelled() {
            let _ = timeout(Duration::from_millis(100), channel.close()).await;
            return Err(Error::Cancelled);
        }
        let mut result = ExecOutcome {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_status: None,
            exit_signal: None,
            request_accepted: false,
            output_truncated: false,
            end: ExecEnd::ProtocolFailure,
        };
        let mut early = Early::default();
        let completed = {
            let work = async {
                channel.exec(true, command).await?;
                acknowledge(&mut channel, &mut early).await?;
                result.request_accepted = true;
                while let Some(value) = early.pop() {
                    if let Some(end) = result.consume(value, options.max_output_bytes) {
                        return Ok(end);
                    }
                }
                loop {
                    let value = match channel.wait().await {
                        Some(message) => event(message)?,
                        None => Some(ShellEvent::Closed {
                            remote_close: false,
                        }),
                    };
                    if let Some(value) = value
                        && let Some(end) = result.consume(value, options.max_output_bytes)
                    {
                        return Ok(end);
                    }
                }
            };
            tokio::select! {biased;
                _=self.cancel.cancelled()=>Err(Error::Cancelled),
                _=cancel.cancelled()=>Err(Error::Cancelled),
                value=timeout(options.timeout,work)=>value.map_err(|_|Error::Timeout).and_then(|value|value),
            }
        };
        result.end = match completed {
            Ok(end) => end,
            Err(Error::Timeout) => ExecEnd::Timeout,
            Err(Error::Cancelled) => ExecEnd::Cancelled,
            Err(Error::Limit) => {
                result.output_truncated = true;
                ExecEnd::OutputLimit
            }
            Err(Error::RequestRejected) => ExecEnd::Rejected,
            Err(Error::Closed | Error::Transport) => ExecEnd::TransportLost,
            Err(_) => ExecEnd::ProtocolFailure,
        };
        // Preserve bytes received before a missing/late request acknowledgement too.
        while let Some(value) = early.pop() {
            let _ = result.consume(value, options.max_output_bytes);
        }
        // Closing stops this local channel; it cannot roll back remote work.
        let _ = timeout(Duration::from_millis(100), channel.close()).await;
        Ok(result)
    }
}
