//! Service-owned SSH2 actors. Public control messages never carry private key bytes.
mod disconnect;
mod exec;
mod forget;
mod history;
mod reconnect;
#[cfg(test)]
mod reconnect_tests;
mod start;
use crate::{
    config::{Access, Internal, Value},
    server::Store,
};
use config_store::{Auth, HostEndpoint, HostKey, HostKeyStatus, HostProtocol, Profile, Settings};
use session_core::input::{Fingerprint, InputFailure, Receipts};
use session_core::session::*;
use session_core::{
    access::{Action, Permit, Scope, Target},
    pairing::Identity,
};
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
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use transport_ssh2::session::{
    self as transport, AuthState, Authentication, Cancellation, SecretText, ShellEvent, Ssh2Session,
};
use uuid::Uuid;
#[derive(Clone, PartialEq, Eq)]
struct Start {
    temporary: Option<Settings>,
    owner: Option<Uuid>,
    previous: Option<ConnectionRef>,
    profile_id: Uuid,
    revision: Option<Uuid>,
    cols: u32,
    rows: u32,
}
struct Entry {
    server_host: String,
    temporary: Option<Profile>,
    reference: ConnectionRef,
    restart_gate: Arc<tokio::sync::Mutex<()>>,
    exec: exec::Tasks,
    writable: watch::Sender<bool>,
    commands: Option<mpsc::Sender<QueuedInput>>,
    receipts: Receipts,
    profile_id: Uuid,
    encoding: config_store::Encoding,
    cancel: Cancellation,
    challenge: Option<Challenge>,
    answer: Option<oneshot::Sender<Answer>>,
    failure: Option<Failure>,
    exit: Option<u32>,
    signal: Option<String>,
    task: Option<JoinHandle<()>>,
    transport: Option<std::sync::Weak<Ssh2Session>>,
}
impl Manager {
    /// Issuance-only lookup; operation retries never depend on this live entry.
    pub(crate) fn grant_profile(&self, connection: ConnectionRef) -> Result<Uuid, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if entry.reference != connection {
            return Err(ErrorCode::StaleGeneration);
        }
        // A temporary target is never a saved Profile/revision grant target,
        // even if a Desktop later creates a saved UUID with the same value.
        if entry.temporary.is_some() {
            return Err(ErrorCode::Unsupported);
        }
        Ok(entry.profile_id)
    }
}
enum Input {
    Exec(exec::Queued),
    Write(session_protocol::SensitiveBytes),
    Resize { cols: u32, rows: u32 },
}
impl Input {
    fn fingerprint(&self) -> Fingerprint {
        match self {
            Self::Exec(queued) => queued.fingerprint(),
            Self::Write(bytes) => Fingerprint::write(bytes.expose()),
            Self::Resize { cols, rows } => Fingerprint::resize(*cols, *rows),
        }
    }
}
struct QueuedInput {
    authority: Option<(Identity, Permit)>,
    id: Uuid,
    input: Input,
}
impl QueuedInput {
    fn cancel_pending(&self, entry: &mut Entry) {
        match &self.input {
            Input::Exec(queued) => entry.exec.cancel_pending(queued.task_id, true),
            _ => {
                entry.receipts.cancel_pending(self.id);
            }
        }
    }
}

enum Answer {
    KeyFile {
        path: String,
        passphrase: Option<Sensitive>,
    },
    Host(bool),
    Credentials {
        use_saved: bool,
        password: Option<Sensitive>,
    },
    Interactive(Vec<Sensitive>),
}
#[derive(Default)]
struct Inner {
    forgets: session_core::forget::Receipts,
    disconnects: session_core::disconnect::Receipts,
    entries: HashMap<ConnectionId, Entry>,
    requests: HashMap<Uuid, (Start, ConnectionInfo)>,
    request_window: session_core::input::RequestWindow,
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
    pub(crate) async fn handle_authenticated(
        &self,
        identity: &Identity,
        request: ssh::Request,
    ) -> Result<ssh::Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        match request {
            ssh::Request::QuickStart {
                settings,
                request_id,
                cols,
                rows,
            } => {
                {
                    let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    store.pairing.require_desktop(identity, store.now())?;
                }
                let profile = Profile {
                    id: request_id,
                    folder_id: None,
                    name: "临时SSH连接".into(),
                    credential_ref: None,
                    settings,
                };
                self.start_from(
                    Some(identity),
                    start::Source::Temporary(profile),
                    request_id,
                    cols,
                    rows,
                )
                .await
            }
            ssh::Request::StartStatus { request_id } => {
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                store.pairing.require_desktop(identity, store.now())?;
                let Some((start, connection)) = inner.requests.get(&request_id) else {
                    inner.request_window.check(request_id)?;
                    return Err(ErrorCode::NotFound);
                };
                if start.owner.is_some() {
                    return Err(ErrorCode::PermissionDenied);
                }
                Ok(ssh::Reply::Started {
                    connection: connection.clone(),
                })
            }
            ssh::Request::StartFixed {
                profile_id,
                revision,
                request_id,
                cols,
                rows,
            } => {
                self.start_from(
                    Some(identity),
                    start::Source::Saved {
                        profile_id,
                        revision: Some(revision),
                    },
                    request_id,
                    cols,
                    rows,
                )
                .await
            }
            ssh::Request::ConnectStatus {
                profile_id,
                revision,
                request_id,
            } => self.connect_status(identity, profile_id, revision, request_id),
            request @ ssh::Request::AuthenticateKey { .. } => {
                {
                    let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    store.pairing.require_desktop(identity, store.now())?;
                }
                self.handle(request).await
            }
            ssh::Request::ForgetStart {
                connection,
                request_id,
            } => {
                self.forget_as(Some(identity), connection, request_id, false)
                    .await
            }
            ssh::Request::ForgetStatus {
                connection,
                request_id,
            } => {
                self.forget_as(Some(identity), connection, request_id, true)
                    .await
            }
            ssh::Request::Reconnect {
                connection,
                request_id,
                cols,
                rows,
            } => {
                self.reconnect_as(Some(identity), connection, request_id, cols, rows)
                    .await
            }
            ssh::Request::ReconnectStatus {
                connection,
                request_id,
            } => self.reconnect_status(identity, connection, request_id),
            ssh::Request::Disconnect {
                connection,
                request_id,
            } => self.disconnect_as(Some(identity), connection, request_id, false),
            ssh::Request::DisconnectStatus {
                connection,
                request_id,
            } => self.disconnect_as(Some(identity), connection, request_id, true),
            ssh::Request::Start {
                profile_id,
                request_id,
                cols,
                rows,
            } => {
                self.start_as(Some(identity), profile_id, request_id, cols, rows)
                    .await
            }
            ssh::Request::Resize {
                connection,
                request_id,
                cols,
                rows,
            } => self.enqueue_from(
                Some(identity),
                connection,
                request_id,
                Input::Resize { cols, rows },
            ),
            ssh::Request::Exec {
                connection,
                request_id,
                command,
                timeout_ms,
                max_output_bytes,
            } => self.start_exec_as(
                Some(identity),
                connection,
                request_id,
                command,
                timeout_ms,
                max_output_bytes,
            ),
            ssh::Request::ExecStatus {
                connection,
                task_id,
            } => self.exec_status_as(Some(identity), connection, task_id, false),
            ssh::Request::ExecCancel {
                connection,
                task_id,
            } => self.exec_status_as(Some(identity), connection, task_id, true),
            ssh::Request::ExecReadProtected {
                connection,
                task_id,
                view,
            } => self.exec_read_protected(identity, connection, task_id, view),
            ssh::Request::ExecRead {
                connection,
                task_id,
                cursor,
                max_bytes,
            } => self.exec_read_as(Some(identity), connection, task_id, cursor, max_bytes),
            ssh::Request::Write {
                connection,
                request_id,
                bytes,
            } => self.enqueue_from(Some(identity), connection, request_id, Input::Write(bytes)),
            ssh::Request::WriteText {
                connection,
                request_id,
                text,
            } => {
                let encoding = {
                    let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                    let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    let now = store.now();
                    if store.pairing.is_agent(identity, now)? {
                        // Reject scopes/leases before resolving encoding or transport existence.
                        store.pairing.check_action(
                            identity,
                            Scope {
                                target: Target::Connection { connection },
                                action: Action::Write,
                            },
                            now,
                        )?;
                    } else {
                        store.pairing.require_desktop(identity, now)?;
                    }
                    store.sessions.info(connection)?;
                    inner
                        .entries
                        .get(&connection.connection_id)
                        .ok_or(ErrorCode::NotFound)?
                        .encoding
                        .clone()
                };
                let bytes = encode_text(&encoding, text.expose())?;
                self.enqueue_from(
                    Some(identity),
                    connection,
                    request_id,
                    Input::Write(session_protocol::SensitiveBytes::new(bytes)),
                )
            }
            ssh::Request::InputStatus {
                connection,
                request_id,
            } => {
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                store.pairing.require_active(identity, store.now())?;
                store.sessions.info(connection)?;
                let entry = inner
                    .entries
                    .get(&connection.connection_id)
                    .ok_or(ErrorCode::NotFound)?;
                let receipt = if store.pairing.require_desktop(identity, store.now()).is_ok() {
                    entry.receipts.get(request_id)?
                } else {
                    if !store.pairing.is_agent(identity, store.now())? {
                        return Err(ErrorCode::PermissionDenied);
                    }
                    entry
                        .receipts
                        .get_owned(Some(identity.ticket_id()), request_id)?
                };
                Ok(ssh::Reply::Input(receipt))
            }
            other => self.handle(other).await,
        }
    }
    pub(crate) async fn handle(&self, request: ssh::Request) -> Result<ssh::Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        match request {
            ssh::Request::QuickStart { .. }
            | ssh::Request::StartStatus { .. }
            | ssh::Request::StartFixed { .. }
            | ssh::Request::ConnectStatus { .. }
            | ssh::Request::ReconnectStatus { .. } => Err(ErrorCode::PermissionDenied),
            ssh::Request::AuthenticateKey {
                connection,
                challenge_id,
                key_path,
                passphrase,
            } => self.answer(
                connection,
                challenge_id,
                Answer::KeyFile {
                    path: key_path,
                    passphrase,
                },
            ),
            ssh::Request::ForgetStart {
                connection,
                request_id,
            } => self.forget_as(None, connection, request_id, false).await,
            ssh::Request::ForgetStatus {
                connection,
                request_id,
            } => self.forget_as(None, connection, request_id, true).await,
            ssh::Request::Disconnect {
                connection,
                request_id,
            } => self.disconnect_as(None, connection, request_id, false),
            ssh::Request::DisconnectStatus {
                connection,
                request_id,
            } => self.disconnect_as(None, connection, request_id, true),
            ssh::Request::Forget { connection } => self.forget(connection).await,
            ssh::Request::Reconnect {
                connection,
                request_id,
                cols,
                rows,
            } => {
                self.reconnect_as(None, connection, request_id, cols, rows)
                    .await
            }
            ssh::Request::Exec {
                connection,
                request_id,
                command,
                timeout_ms,
                max_output_bytes,
            } => self.start_exec(
                connection,
                request_id,
                command,
                timeout_ms,
                max_output_bytes,
            ),
            ssh::Request::ExecStatus {
                connection,
                task_id,
            } => self.exec_status(connection, task_id, false),
            ssh::Request::ExecCancel {
                connection,
                task_id,
            } => self.exec_status(connection, task_id, true),
            ssh::Request::ExecRead {
                connection,
                task_id,
                cursor,
                max_bytes,
            } => self.exec_read(connection, task_id, cursor, max_bytes),
            ssh::Request::ExecReadProtected { .. } => Err(ErrorCode::PermissionDenied),
            ssh::Request::WriteText {
                connection,
                request_id,
                text,
            } => {
                let encoding = {
                    let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                    self.store
                        .lock()
                        .map_err(|_| ErrorCode::InvalidState)?
                        .sessions
                        .info(connection)?;
                    inner
                        .entries
                        .get(&connection.connection_id)
                        .ok_or(ErrorCode::NotFound)?
                        .encoding
                        .clone()
                };
                let bytes = encode_text(&encoding, text.expose())?;
                self.enqueue(
                    connection,
                    request_id,
                    Input::Write(session_protocol::SensitiveBytes::new(bytes)),
                )
            }
            ssh::Request::Write {
                connection,
                request_id,
                bytes,
            } => self.enqueue(connection, request_id, Input::Write(bytes)),
            ssh::Request::Resize {
                connection,
                request_id,
                cols,
                rows,
            } => self.enqueue(connection, request_id, Input::Resize { cols, rows }),
            ssh::Request::InputStatus {
                connection,
                request_id,
            } => {
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                self.store
                    .lock()
                    .map_err(|_| ErrorCode::InvalidState)?
                    .sessions
                    .info(connection)?;
                let entry = inner
                    .entries
                    .get(&connection.connection_id)
                    .ok_or(ErrorCode::NotFound)?;
                Ok(ssh::Reply::Input(entry.receipts.get(request_id)?))
            }
            ssh::Request::Start {
                profile_id,
                request_id,
                cols,
                rows,
            } => {
                self.start_as(None, profile_id, request_id, cols, rows)
                    .await
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
                    server_host: entry.server_host.clone(),
                    temporary_settings: entry.temporary.as_ref().map(|p| p.settings.clone()),
                    connection: info,
                    profile_id: entry.profile_id,
                    encoding: entry.encoding.clone(),
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
                let now = store.now();
                store.pairing.retire_connection(connection, now);
                entry.cancel.cancel();
                entry.exec.finish_all(true);
                entry.commands = None;
                entry.receipts.connection_lost(InputFailure::Cancelled);
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
    fn enqueue(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        input: Input,
    ) -> Result<ssh::Reply, ErrorCode> {
        self.enqueue_from(None, connection, id, input)
    }
    fn enqueue_from(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        input: Input,
    ) -> Result<ssh::Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let now = store.now();
        let owner = match identity {
            Some(identity) if store.pairing.is_agent(identity, now)? => Some(identity.ticket_id()),
            Some(identity) => {
                store.pairing.require_desktop(identity, now)?;
                None
            }
            None => None,
        };
        let authority = if let Some(identity) = identity.filter(|_| owner.is_some()) {
            Some((
                identity.clone(),
                store.pairing.admit_input(
                    identity,
                    Scope {
                        target: Target::Connection { connection },
                        action: if matches!(&input, Input::Resize { .. }) {
                            Action::Control
                        } else {
                            Action::Write
                        },
                    },
                    id,
                    now,
                )?,
            ))
        } else {
            None
        };
        let info = store.sessions.info(connection)?;
        if owner.is_some()
            && matches!(&input, Input::Resize { .. })
            && info.protocol != Protocol::Ssh2
        {
            return Err(ErrorCode::PermissionDenied);
        }
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        let fingerprint = input.fingerprint();
        if entry.exec.contains(id) {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(receipt) = entry.receipts.lookup_owned(owner, id, fingerprint)? {
            return Ok(ssh::Reply::Input(receipt));
        }
        entry.exec.check_available(id)?;
        if info.state != State::Connected {
            return Err(ErrorCode::NotConnected);
        }
        if entry.cancel.is_cancelled() || entry.challenge.is_some() || !*entry.writable.borrow() {
            return Err(ErrorCode::InvalidState);
        }
        if let Some(desktop) =
            identity.filter(|_| owner.is_none() && !matches!(&input, Input::Resize { .. }))
        {
            store.pairing.takeover(desktop, connection, now)?;
            entry.receipts.cancel_agent_pending();
            entry.exec.cancel_agent_pending();
        }
        let sender = entry
            .commands
            .as_ref()
            .ok_or(ErrorCode::NotConnected)?
            .clone();
        let permit = sender.try_reserve().map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
            _ => ErrorCode::NotConnected,
        })?;
        let receipt = entry.receipts.remember_owned(owner, id, fingerprint)?;
        permit.send(QueuedInput {
            authority,
            id,
            input,
        });
        Ok(ssh::Reply::Input(receipt))
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
                | (
                    Challenge::Credentials {
                        auth: Auth::PublicKey,
                        ..
                    },
                    Answer::KeyFile { .. }
                )
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
            .filter(|entry| entry.reference == self.reference)
            .ok_or(Failure::Transport)?;
        if entry.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let mut store = self.store.lock().map_err(|_| Failure::Transport)?;
        store
            .sessions
            .transition(self.reference, state)
            .map_err(|_| Failure::Transport)?;
        if matches!(state, State::Disconnected | State::Failed) {
            let now = store.now();
            store.pairing.retire_connection(self.reference, now);
        }
        Ok(())
    }
    async fn ask(&self, challenge: Challenge) -> Result<Answer, Failure> {
        let id = challenge.id();
        let host_decision = matches!(&challenge, Challenge::HostKey { .. });
        let (answer, receiver) = oneshot::channel();
        {
            let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
            let entry = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
                .ok_or(Failure::Transport)?;
            if entry.cancel.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            entry.challenge = Some(challenge);
            entry.answer = Some(answer);
        }
        let result = tokio::select! {biased;_=self.cancel.cancelled()=>Err(Failure::Cancelled),reply=timeout(Duration::from_secs(110),receiver)=>reply.map_err(|_|Failure::ApprovalTimeout)?.map_err(|_|Failure::Cancelled)};
        if !host_decision
            && let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
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
        if let Ok(inner) = self.inner.lock()
            && let Some(entry) = inner
                .entries
                .get(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
        {
            entry.writable.send_replace(false);
        }
        let candidate = HostKey {
            endpoint: endpoint.clone(),
            algorithm: key.algorithm,
            key: key.bytes,
        };
        let Value::Review(review) = self.config(Internal::Review(candidate.clone())).await? else {
            return Err(Failure::Configuration);
        };
        if review.status == HostKeyStatus::Known {
            if let Ok(inner) = self.inner.lock()
                && let Some(entry) = inner
                    .entries
                    .get(&self.reference.connection_id)
                    .filter(|entry| entry.reference == self.reference)
            {
                entry.writable.send_replace(true);
            }
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
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
        {
            entry.challenge = None;
            entry.writable.send_replace(true);
        }
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
        let answer = self
            .ask(Challenge::Credentials {
                id: Uuid::new_v4(),
                auth: auth.clone(),
                stored_available: profile.credential_ref.is_some(),
            })
            .await?;
        let (use_saved, password) = match answer {
            Answer::Credentials {
                use_saved,
                password,
            } => (use_saved, password),
            Answer::KeyFile { path, passphrase } if auth == Auth::PublicKey => {
                let Value::Credential(value) = self
                    .config(Internal::TemporaryKey { path, passphrase })
                    .await
                    .map_err(|_| Failure::CredentialUnavailable)?
                else {
                    return Err(Failure::CredentialUnavailable);
                };
                return Ok(Authentication::PublicKey {
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
                        .map(|v| SecretText::new(v.expose().to_owned()))
                        .transpose()
                        .map_err(map_error)?,
                });
            }
            _ => return Err(Failure::CredentialUnavailable),
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
    async fn run_as(
        &self,
        profile: Profile,
        cols: u32,
        rows: u32,
        identity: Option<Identity>,
        authority: Option<(Identity, Permit)>,
    ) -> Result<(), Failure> {
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
        let mut connecting = std::pin::pin!(Ssh2Session::connect(
            host,
            *port,
            sender,
            self.cancel.clone(),
            transport::Limits::default(),
        ));
        let mut dispatched = false;
        // First poll starts the actual transport operation. Revoke and this decision
        // share Store; no socket/DNS future is polled using a pre-await permission.
        let connecting = std::future::poll_fn(|cx| {
            use std::future::Future;
            if !dispatched {
                let Ok(mut store) = self.store.lock() else {
                    return std::task::Poll::Ready(Err(transport::Error::Transport));
                };
                if self.cancel.is_cancelled()
                    || Manager::check_start(&mut store, identity.as_ref(), authority.as_ref(), true)
                        .is_err()
                {
                    return std::task::Poll::Ready(Err(transport::Error::Cancelled));
                }
                dispatched = true;
                connecting.as_mut().poll(cx)
            } else {
                connecting.as_mut().poll(cx)
            }
        });
        let mut session = self.drive(&mut receiver, &endpoint, connecting).await?;
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
                && let Some(entry) = inner
                    .entries
                    .get_mut(&self.reference.connection_id)
                    .filter(|entry| entry.reference == self.reference)
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
        let (sender, commands) = mpsc::channel(16);
        {
            let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
            let entry = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
                .ok_or(Failure::Transport)?;
            entry.commands = Some(sender);
        }
        self.transition(State::Connected)?;
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
        {
            entry.failure = None;
        }
        let session = Arc::new(session);
        {
            let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
            let entry = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
                .ok_or(Failure::Transport)?;
            entry.transport = Some(Arc::downgrade(&session));
        }
        tokio::select! {
            result=self.read_shell(&mut receiver,&endpoint,&mut shell.reader)=>result,
            result=self.write_shell(commands,shell.writer,session)=>result,
        }
    }
    async fn write_shell(
        &self,
        mut commands: mpsc::Receiver<QueuedInput>,
        writer: transport::ShellWriter,
        session: Arc<Ssh2Session>,
    ) -> Result<(), Failure> {
        let mut ready = {
            self.inner
                .lock()
                .map_err(|_| Failure::Transport)?
                .entries
                .get(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
                .ok_or(Failure::Transport)?
                .writable
                .subscribe()
        };
        let mut jobs = tokio::task::JoinSet::new();
        'commands: loop {
            let command = tokio::select! {biased;_=self.cancel.cancelled()=>return Err(Failure::Cancelled),Some(result)=jobs.join_next(),if !jobs.is_empty()=>{result.map_err(|_|Failure::Transport)?;continue;},value=commands.recv()=>value.ok_or(Failure::Transport)?};
            loop {
                // Periodic wake also settles expired/revoked pending input while rekey is paused.
                tokio::select! {biased;_=self.cancel.cancelled()=>return Err(Failure::Cancelled),value=ready.wait_for(|value|*value)=>{value.map_err(|_|Failure::Transport)?;},_=tokio::time::sleep(Duration::from_millis(25))=>{}}
                let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
                let entry = inner
                    .entries
                    .get_mut(&self.reference.connection_id)
                    .filter(|entry| entry.reference == self.reference)
                    .ok_or(Failure::Transport)?;
                if entry.cancel.is_cancelled() {
                    return Err(Failure::Cancelled);
                }
                let mut store = self.store.lock().map_err(|_| Failure::Transport)?;
                if let Some((identity, permit)) = &command.authority
                    && store
                        .pairing
                        .check_input(identity, permit, store.now())
                        .is_err()
                {
                    let now = store.now();
                    let _ = store.pairing.dispatch_input(identity, permit, now);
                    command.cancel_pending(entry);
                    continue 'commands;
                }
                if !*entry.writable.borrow() {
                    continue;
                }
                let now = store.now();
                if !matches!(&command.input, Input::Exec(_))
                    && let Some((identity, permit)) = &command.authority
                    && store.pairing.dispatch_input(identity, permit, now).is_err()
                {
                    command.cancel_pending(entry);
                    continue 'commands;
                }
                if !matches!(&command.input, Input::Exec(_)) && !entry.receipts.dispatch(command.id)
                {
                    return Err(Failure::Transport);
                }
                break;
            }
            let result = match command.input {
                Input::Exec(queued) => {
                    exec::launch(
                        &mut jobs,
                        queued,
                        self.inner.clone(),
                        self.reference,
                        session.clone(),
                        self.store.clone(),
                        command.authority,
                    )?;
                    continue;
                }
                Input::Write(bytes) => writer.write(bytes.expose()).await.map(Some),
                Input::Resize { cols, rows } => {
                    let result = writer.resize(cols, rows).await.map(|()| None);
                    if result.is_ok() {
                        self.store
                            .lock()
                            .map_err(|_| Failure::Transport)?
                            .sessions
                            .resize_screen(self.reference, rows as u16, cols as u16)
                            .map_err(|_| Failure::Transport)?;
                    }
                    result
                }
            };
            {
                let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
                if let Some(entry) = inner
                    .entries
                    .get_mut(&self.reference.connection_id)
                    .filter(|entry| entry.reference == self.reference)
                {
                    entry.receipts.complete(
                        command.id,
                        result.map_err(|error| match error {
                            transport::Error::Cancelled => InputFailure::Cancelled,
                            transport::Error::Timeout => InputFailure::Timeout,
                            _ => InputFailure::Transport,
                        }),
                    );
                }
            }
            if let Err(error) = result {
                return Err(map_error(error));
            }
        }
    }
    async fn read_shell(
        &self,
        receiver: &mut mpsc::Receiver<transport::Challenge>,
        endpoint: &HostEndpoint,
        reader: &mut transport::ShellReader,
    ) -> Result<(), Failure> {
        loop {
            let event = self.drive(receiver, endpoint, reader.next()).await?;
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
                        && let Some(entry) = inner
                            .entries
                            .get_mut(&self.reference.connection_id)
                            .filter(|entry| entry.reference == self.reference)
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
                        && let Some(entry) = inner
                            .entries
                            .get_mut(&self.reference.connection_id)
                            .filter(|entry| entry.reference == self.reference)
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
        let Some(entry) = inner
            .entries
            .get_mut(&self.reference.connection_id)
            .filter(|entry| entry.reference == self.reference)
        else {
            return;
        };
        entry.challenge = None;
        entry.answer = None;
        entry.commands = None;
        entry.exec.finish_all(entry.cancel.is_cancelled());
        entry
            .receipts
            .connection_lost(if entry.cancel.is_cancelled() {
                InputFailure::Cancelled
            } else {
                InputFailure::Transport
            });
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
        let mut store = self.store.lock().unwrap();
        let now = store.now();
        store.pairing.retire_connection(self.reference, now);
        entry.cancel.cancel();
    }
}
fn configure_output(
    sessions: &mut Sessions,
    reference: ConnectionRef,
    profile: &Profile,
    rows: u32,
    cols: u32,
) -> Result<(), ErrorCode> {
    let Settings::Ssh2 { encoding, .. } = &profile.settings else {
        return Err(ErrorCode::Unsupported);
    };
    sessions.configure_output(
        reference,
        crate::encoding_label(encoding),
        rows as u16,
        cols as u16,
    )
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

fn profile_encoding(profile: &Profile) -> Result<config_store::Encoding, ErrorCode> {
    match &profile.settings {
        Settings::Ssh2 { encoding, .. } => Ok(encoding.clone()),
        _ => Err(ErrorCode::Unsupported),
    }
}
fn encode_text(encoding: &config_store::Encoding, text: &str) -> Result<Vec<u8>, ErrorCode> {
    let codec = encoding_rs::Encoding::for_label(crate::encoding_label(encoding).as_bytes())
        .ok_or(ErrorCode::InvalidArgument)?;
    let (bytes, _, replaced) = codec.encode(text);
    if replaced || bytes.is_empty() || bytes.len() > 65536 {
        return Err(ErrorCode::InvalidArgument);
    }
    Ok(bytes.into_owned())
}

#[cfg(test)]
mod encoding_tests {
    use super::*;
    #[test]
    fn strict_encoding_never_substitutes_or_exceeds_wire_budget() {
        use config_store::Encoding::*;
        assert_eq!(
            encode_text(&Gbk, "中文\r").unwrap(),
            [0xd6, 0xd0, 0xce, 0xc4, 13]
        );
        assert_eq!(
            encode_text(&Gb18030, "𠀀").unwrap(),
            [0x95, 0x32, 0x82, 0x36]
        );
        assert_eq!(encode_text(&Utf8, "𠀀").unwrap(), "𠀀".as_bytes());
        assert_eq!(encode_text(&Gbk, "𠀀"), Err(ErrorCode::InvalidArgument));
        assert_eq!(encode_text(&Utf8, ""), Err(ErrorCode::InvalidArgument));
        assert!(encode_text(&Gbk, &"中".repeat(32768)).is_ok());
        assert_eq!(
            encode_text(&Gbk, &"中".repeat(32769)),
            Err(ErrorCode::InvalidArgument)
        );
    }
}
