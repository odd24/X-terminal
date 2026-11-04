//! Service-owned SSH2 actors. Public control messages never carry private key bytes.
use crate::{
    config::{Access, Internal, Value},
    server::Store,
};
use config_store::{Auth, HostEndpoint, HostKey, HostKeyStatus, HostProtocol, Profile, Settings};
use session_core::session::*;
use session_protocol::{
    Sensitive,
    ssh::{self, Challenge, Failure},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};
use transport_ssh2::session::{
    self as transport, AuthState, Authentication, Cancellation, SecretText, ShellEvent, Ssh2Session,
};
use uuid::Uuid;
#[derive(Clone, Copy, PartialEq, Eq)]
struct Start {
    profile_id: Uuid,
    cols: u32,
    rows: u32,
}
struct Entry {
    profile_id: Uuid,
    cancel: Cancellation,
    challenge: Option<Challenge>,
    answer: Option<oneshot::Sender<Answer>>,
    failure: Option<Failure>,
    exit: Option<u32>,
    signal: Option<String>,
    task: Option<JoinHandle<()>>,
}
enum Answer {
    Host(bool),
    Credentials {
        use_saved: bool,
        password: Option<Sensitive>,
    },
    Interactive(Vec<Sensitive>),
}
#[derive(Default)]
struct Inner {
    entries: HashMap<ConnectionId, Entry>,
    requests: HashMap<Uuid, (Start, ConnectionInfo)>,
}
pub(crate) struct Manager {
    inner: Arc<Mutex<Inner>>,
    store: Arc<Mutex<Store>>,
    config: Access,
}
impl Manager {
    pub(crate) fn new(store: Arc<Mutex<Store>>, config: Access) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            store,
            config,
        }
    }
    fn duplicate(&self, id: Uuid, start: Start) -> Result<Option<ConnectionInfo>, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        match inner.requests.get(&id) {
            Some((previous, connection)) if *previous == start => Ok(Some(connection.clone())),
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => Ok(None),
        }
    }
    pub(crate) async fn handle(&self, request: ssh::Request) -> Result<ssh::Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        match request {
            ssh::Request::Start {
                profile_id,
                request_id,
                cols,
                rows,
            } => {
                let start = Start {
                    profile_id,
                    cols,
                    rows,
                };
                if let Some(connection) = self.duplicate(request_id, start)? {
                    return Ok(ssh::Reply::Started { connection });
                }
                let Value::Profile(profile) = self
                    .config
                    .request(Internal::Profile(profile_id))
                    .await
                    .map_err(|_| ErrorCode::InvalidArgument)?
                else {
                    return Err(ErrorCode::InvalidState);
                };
                if !matches!(profile.settings, Settings::Ssh2 { .. }) {
                    return Err(ErrorCode::Unsupported);
                }
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                if let Some((previous, connection)) = inner.requests.get(&request_id) {
                    return if *previous == start {
                        Ok(ssh::Reply::Started {
                            connection: connection.clone(),
                        })
                    } else {
                        Err(ErrorCode::InvalidArgument)
                    };
                }
                if inner.requests.len() >= 1024 || inner.entries.len() >= MAX_CONNECTIONS {
                    return Err(ErrorCode::CapacityExceeded);
                }
                let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                let initial = store.sessions.create(Protocol::Ssh2)?;
                let connection = store.sessions.begin_connect(initial.reference())?;
                let cancel = Cancellation::default();
                inner.entries.insert(
                    connection.connection_id,
                    Entry {
                        profile_id,
                        cancel: cancel.clone(),
                        challenge: None,
                        answer: None,
                        failure: None,
                        exit: None,
                        signal: None,
                        task: None,
                    },
                );
                inner
                    .requests
                    .insert(request_id, (start, connection.clone()));
                let actor = Actor {
                    inner: self.inner.clone(),
                    store: self.store.clone(),
                    config: self.config.clone(),
                    reference: connection.reference(),
                    cancel,
                };
                let task = tokio::spawn(async move {
                    let result = actor.run(profile, cols, rows).await;
                    actor.finish(result);
                });
                inner
                    .entries
                    .get_mut(&connection.connection_id)
                    .unwrap()
                    .task = Some(task);
                Ok(ssh::Reply::Started { connection })
            }
            ssh::Request::Status { connection } => {
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let info = self
                    .store
                    .lock()
                    .map_err(|_| ErrorCode::InvalidState)?
                    .sessions
                    .info(connection)?;
                let entry = inner
                    .entries
                    .get(&connection.connection_id)
                    .ok_or(ErrorCode::NotFound)?;
                Ok(ssh::Reply::Status(Box::new(ssh::Status {
                    connection: info,
                    profile_id: entry.profile_id,
                    challenge: entry.challenge.clone(),
                    failure: entry.failure,
                    shell_exit_status: entry.exit,
                    shell_exit_signal: entry.signal.clone(),
                })))
            }
            ssh::Request::Close { connection } => {
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                let info = store.sessions.info(connection)?;
                let entry = inner
                    .entries
                    .get_mut(&connection.connection_id)
                    .ok_or(ErrorCode::NotFound)?;
                entry.cancel.cancel();
                entry.answer = None;
                entry.challenge = None;
                if !matches!(info.state, State::Disconnected | State::Closing) {
                    store.sessions.transition(connection, State::Closing)?;
                    store.sessions.transition(connection, State::Disconnected)?;
                }
                Ok(ssh::Reply::Accepted)
            }
            ssh::Request::AnswerHost {
                connection,
                challenge_id,
                approve,
            } => self.answer(connection, challenge_id, Answer::Host(approve)),
            ssh::Request::Authenticate {
                connection,
                challenge_id,
                use_saved,
                password,
            } => self.answer(
                connection,
                challenge_id,
                Answer::Credentials {
                    use_saved,
                    password,
                },
            ),
            ssh::Request::AnswerInteractive {
                connection,
                challenge_id,
                answers,
            } => self.answer(connection, challenge_id, Answer::Interactive(answers)),
        }
    }
    fn answer(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        answer: Answer,
    ) -> Result<ssh::Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        self.store
            .lock()
            .map_err(|_| ErrorCode::InvalidState)?
            .sessions
            .info(connection)?;
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if entry.cancel.is_cancelled() {
            return Err(ErrorCode::InvalidState);
        }
        let challenge = entry
            .challenge
            .as_ref()
            .filter(|challenge| challenge.id() == id)
            .ok_or(ErrorCode::InvalidState)?;
        if !matches!(
            (challenge, &answer),
            (Challenge::HostKey { .. }, Answer::Host(_))
                | (Challenge::Credentials { .. }, Answer::Credentials { .. })
                | (Challenge::Interactive { .. }, Answer::Interactive(_))
        ) {
            return Err(ErrorCode::InvalidArgument);
        }
        entry
            .answer
            .take()
            .ok_or(ErrorCode::InvalidState)?
            .send(answer)
            .map_err(|_| ErrorCode::InvalidState)?;
        entry.challenge = None;
        Ok(ssh::Reply::Accepted)
    }
    pub(crate) async fn close(self) {
        let tasks = {
            let mut inner = self.inner.lock().unwrap();
            inner
                .entries
                .values_mut()
                .filter_map(|entry| {
                    entry.cancel.cancel();
                    entry.answer = None;
                    entry.task.take()
                })
                .collect::<Vec<_>>()
        };
        for mut task in tasks {
            if timeout(Duration::from_secs(2), &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
    }
}
struct Actor {
    inner: Arc<Mutex<Inner>>,
    store: Arc<Mutex<Store>>,
    config: Access,
    reference: ConnectionRef,
    cancel: Cancellation,
}
impl Actor {
    async fn config(&self, request: Internal) -> Result<Value, Failure> {
        tokio::select! {biased;_=self.cancel.cancelled()=>Err(Failure::Cancelled),reply=self.config.request(request)=>reply.map_err(|error|match error {session_protocol::config::ConfigError::Conflict=>Failure::HostKeyConflict,_=>Failure::Configuration})}
    }
    fn transition(&self, state: State) -> Result<(), Failure> {
        let inner = self.inner.lock().map_err(|_| Failure::Transport)?;
        let entry = inner
            .entries
            .get(&self.reference.connection_id)
            .ok_or(Failure::Transport)?;
        if entry.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        self.store
            .lock()
            .map_err(|_| Failure::Transport)?
            .sessions
            .transition(self.reference, state)
            .map_err(|_| Failure::Transport)?;
        Ok(())
    }
    async fn ask(&self, challenge: Challenge) -> Result<Answer, Failure> {
        let id = challenge.id();
        let (answer, receiver) = oneshot::channel();
        {
            let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
            let entry = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .ok_or(Failure::Transport)?;
            if entry.cancel.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            entry.challenge = Some(challenge);
            entry.answer = Some(answer);
        }
        let result = tokio::select! {biased;_=self.cancel.cancelled()=>Err(Failure::Cancelled),reply=timeout(Duration::from_secs(110),receiver)=>reply.map_err(|_|Failure::ApprovalTimeout)?.map_err(|_|Failure::Cancelled)};
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.entries.get_mut(&self.reference.connection_id)
            && entry
                .challenge
                .as_ref()
                .is_some_and(|value| value.id() == id)
        {
            entry.challenge = None;
            entry.answer = None;
        }
        result
    }
    async fn host(
        &self,
        key: transport::ServerKey,
        endpoint: &HostEndpoint,
    ) -> Result<bool, Failure> {
        let candidate = HostKey {
            endpoint: endpoint.clone(),
            algorithm: key.algorithm,
            key: key.bytes,
        };
        let Value::Review(review) = self.config(Internal::Review(candidate.clone())).await? else {
            return Err(Failure::Configuration);
        };
        if review.status == HostKeyStatus::Known {
            return Ok(true);
        }
        let revision = review.revision.clone();
        let Answer::Host(approve) = self
            .ask(Challenge::HostKey {
                id: Uuid::new_v4(),
                review,
            })
            .await?
        else {
            return Err(Failure::Transport);
        };
        if !approve {
            return Err(Failure::HostKeyRejected);
        }
        self.config(Internal::Approve {
            key: candidate,
            revision,
            cancel: self.cancel.clone(),
        })
        .await?;
        Ok(true)
    }
    async fn challenge(
        &self,
        challenge: transport::Challenge,
        endpoint: &HostEndpoint,
    ) -> Result<(), Failure> {
        match challenge {
            transport::Challenge::HostKey { key, answer } => {
                let result = self.host(key, endpoint).await;
                let _ = answer.send(result.is_ok());
                result.map(|_| ())
            }
            transport::Challenge::Authentication { challenge, answer } => {
                let prompts = challenge
                    .prompts
                    .into_iter()
                    .map(|prompt| ssh::Prompt {
                        text: prompt.text,
                        echo: prompt.echo,
                    })
                    .collect();
                let Answer::Interactive(values) = self
                    .ask(Challenge::Interactive {
                        id: Uuid::new_v4(),
                        name: challenge.name,
                        instructions: challenge.instructions,
                        prompts,
                    })
                    .await?
                else {
                    return Err(Failure::Transport);
                };
                let values = values
                    .into_iter()
                    .map(|value| SecretText::new(value.expose().to_owned()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(map_error)?;
                answer.send(values).map_err(|_| Failure::Cancelled)
            }
        }
    }
    async fn drive<T>(
        &self,
        receiver: &mut mpsc::Receiver<transport::Challenge>,
        endpoint: &HostEndpoint,
        future: impl std::future::Future<Output = transport::Result<T>>,
    ) -> Result<T, Failure> {
        tokio::pin!(future);
        loop {
            tokio::select! {biased;
                _=self.cancel.cancelled()=>return Err(Failure::Cancelled),
                challenge=receiver.recv()=>{let challenge=challenge.ok_or(Failure::Transport)?;self.challenge(challenge,endpoint).await?;},
                result=&mut future=>return result.map_err(map_error),
            }
        }
    }
    async fn credential(&self, profile: &Profile, auth: Auth) -> Result<Authentication, Failure> {
        if auth == Auth::KeyboardInteractive {
            return Ok(Authentication::KeyboardInteractive);
        }
        let Answer::Credentials {
            use_saved,
            password,
        } = self
            .ask(Challenge::Credentials {
                id: Uuid::new_v4(),
                auth: auth.clone(),
                stored_available: profile.credential_ref.is_some(),
            })
            .await?
        else {
            return Err(Failure::Transport);
        };
        if !use_saved {
            if auth != Auth::Password {
                return Err(Failure::CredentialUnavailable);
            }
            return Ok(Authentication::Password(
                SecretText::new(
                    password
                        .ok_or(Failure::CredentialUnavailable)?
                        .expose()
                        .to_owned(),
                )
                .map_err(map_error)?,
            ));
        }
        let Value::Credential(value) = self
            .config(Internal::Credential(profile.clone()))
            .await
            .map_err(|_| Failure::CredentialUnavailable)?
        else {
            return Err(Failure::CredentialUnavailable);
        };
        match auth {
            Auth::Password => Ok(Authentication::Password(
                SecretText::new(
                    value
                        .password
                        .ok_or(Failure::CredentialUnavailable)?
                        .expose()
                        .to_owned(),
                )
                .map_err(map_error)?,
            )),
            Auth::PublicKey => Ok(Authentication::PublicKey {
                pem: SecretText::new(
                    value
                        .private_key
                        .ok_or(Failure::CredentialUnavailable)?
                        .expose()
                        .to_owned(),
                )
                .map_err(map_error)?,
                passphrase: value
                    .passphrase
                    .map(|value| SecretText::new(value.expose().to_owned()))
                    .transpose()
                    .map_err(map_error)?,
            }),
            Auth::KeyboardInteractive => Ok(Authentication::KeyboardInteractive),
        }
    }
    async fn run(&self, profile: Profile, cols: u32, rows: u32) -> Result<(), Failure> {
        let Settings::Ssh2 {
            host,
            port,
            username,
            auth,
            ..
        } = &profile.settings
        else {
            return Err(Failure::Configuration);
        };
        let endpoint = HostEndpoint {
            protocol: HostProtocol::Ssh2,
            host: host.clone(),
            port: *port,
        };
        let (sender, mut receiver) = mpsc::channel(1);
        let mut session = self
            .drive(
                &mut receiver,
                &endpoint,
                Ssh2Session::connect(
                    host,
                    *port,
                    sender,
                    self.cancel.clone(),
                    transport::Limits::default(),
                ),
            )
            .await?;
        self.transition(State::Authenticating)?;
        let mut authenticated = false;
        for _ in 0..3 {
            let credential = tokio::select! {
                value=self.credential(&profile, auth.clone())=>value?,
                _=async {while !session.is_closed() {tokio::time::sleep(Duration::from_millis(100)).await;}}=>return Err(Failure::Transport),
            };
            let result = self
                .drive(
                    &mut receiver,
                    &endpoint,
                    session.authenticate(username, credential),
                )
                .await?;
            if result == AuthState::Authenticated {
                authenticated = true;
                break;
            }
            if let Ok(mut inner) = self.inner.lock()
                && let Some(entry) = inner.entries.get_mut(&self.reference.connection_id)
            {
                entry.failure = Some(Failure::AuthenticationRejected);
            }
        }
        if !authenticated {
            return Err(Failure::AuthenticationRejected);
        }
        let mut shell = self
            .drive(&mut receiver, &endpoint, session.shell(cols, rows))
            .await?;
        self.transition(State::Connected)?;
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.entries.get_mut(&self.reference.connection_id)
        {
            entry.failure = None;
        }
        loop {
            let event = self
                .drive(&mut receiver, &endpoint, shell.reader.next())
                .await?;
            match event {
                Some(ShellEvent::Stdout(bytes) | ShellEvent::Stderr(bytes)) => {
                    let timestamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| Failure::Transport)?
                        .as_millis() as u64;
                    self.store
                        .lock()
                        .map_err(|_| Failure::Transport)?
                        .sessions
                        .append(self.reference, &bytes, timestamp)
                        .map_err(|_| Failure::Transport)?;
                }
                Some(ShellEvent::ExitStatus(code)) => {
                    if let Ok(mut inner) = self.inner.lock()
                        && let Some(entry) = inner.entries.get_mut(&self.reference.connection_id)
                    {
                        entry.exit = Some(code);
                    }
                }
                Some(ShellEvent::Closed {
                    remote_close: false,
                }) => return Err(Failure::Transport),
                Some(ShellEvent::Closed { remote_close: true }) | None => {
                    self.transition(State::Closing)?;
                    self.transition(State::Disconnected)?;
                    return Ok(());
                }
                Some(ShellEvent::ExitSignal { signal, .. }) => {
                    if let Ok(mut inner) = self.inner.lock()
                        && let Some(entry) = inner.entries.get_mut(&self.reference.connection_id)
                    {
                        entry.signal = Some(signal);
                    }
                }
                Some(ShellEvent::Eof) => {}
            }
        }
    }
    fn finish(&self, result: Result<(), Failure>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(entry) = inner.entries.get_mut(&self.reference.connection_id) else {
            return;
        };
        entry.challenge = None;
        entry.answer = None;
        if let Err(error) = result
            && !entry.cancel.is_cancelled()
        {
            entry.failure = Some(error);
            let _ = self
                .store
                .lock()
                .unwrap()
                .sessions
                .transition(self.reference, State::Failed);
        }
    }
}
fn map_error(error: transport::Error) -> Failure {
    match error {
        transport::Error::Cancelled => Failure::Cancelled,
        transport::Error::HostKeyRejected => Failure::HostKeyRejected,
        transport::Error::Timeout => Failure::TransportTimeout,
        transport::Error::Limit => Failure::ProtocolLimit,
        transport::Error::InvalidKey => Failure::CredentialUnavailable,
        _ => Failure::Transport,
    }
}
