use crate::security::{PipeSecurity, pipe_name, require_standard_user};
use session_core::{
    PROTOCOL_VERSION,
    pairing::{Identity, Pairing, SecretToken},
    session::*,
};
use session_protocol::*;
use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::windows::named_pipe::NamedPipeServer,
    sync::{Semaphore, watch},
    task::JoinSet,
    time::timeout,
};
use uuid::Uuid;

pub(crate) struct Store {
    pub(crate) sessions: Sessions,
    pub(crate) pairing: Pairing,
    started: Instant,
}
impl Store {
    pub(crate) fn now(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}
#[cfg(test)]
impl Store {
    pub(crate) fn test_store() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            sessions: Sessions::default(),
            pairing: Pairing::new(&SecretToken::generate()),
            started: Instant::now(),
        }))
    }
}
struct Runtime {
    logging: crate::logging::Manager,
    config: crate::config::ConfigWorker,
    ssh: crate::ssh::Manager,
    serial: crate::serial::Manager,
    store: Arc<Mutex<Store>>,
    service_id: Uuid,
    started: Instant,
    fixture: bool,
    shutdown: watch::Sender<bool>,
}
impl Runtime {
    async fn handle_agent(
        &self,
        identity: &Identity,
        request: agent::Request,
    ) -> Result<Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        if let agent::Request::Grant {
            request_id,
            scopes,
            lifetime_ms,
        } = &request
        {
            {
                let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                if let Some(result) = store.pairing.grant_replay(
                    identity,
                    *request_id,
                    scopes,
                    *lifetime_ms,
                    self.now(),
                )? {
                    return Ok(Reply::Agent(Self::grant_reply(result)));
                }
            }
            // Only the existing configuration worker resolves Profile IDs. No paths or secrets.
            for scope in scopes {
                use session_core::access::Target;
                let query = match scope.target {
                    Target::Profile { profile_id } => {
                        Some(crate::config::Internal::Profile(profile_id))
                    }
                    Target::ProfileRevision {
                        profile_id,
                        revision,
                    } => Some(crate::config::Internal::ProfileRevision {
                        id: profile_id,
                        revision,
                    }),
                    _ => None,
                };
                if let Some(query) = query {
                    let lookup = self.config.access().request(query).await;
                    // Another in-flight copy may have completed while this
                    // configuration request waited, including before a deletion.
                    {
                        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                        if let Some(result) = store.pairing.grant_replay(
                            identity,
                            *request_id,
                            scopes,
                            *lifetime_ms,
                            self.now(),
                        )? {
                            return Ok(Reply::Agent(Self::grant_reply(result)));
                        }
                    }
                    lookup.map_err(|e| {
                        if matches!(e, config::ConfigError::NotFound) {
                            ErrorCode::NotFound
                        } else {
                            ErrorCode::InvalidState
                        }
                    })?;
                }
            }
        }
        // Revalidate identity and all current connection generations after asynchronous work.
        self.handle(identity, Request::Agent { request })
    }
    fn grant_reply(result: session_core::pairing::grants::ResultView) -> agent::Reply {
        agent::Reply::Grant {
            receipt: result.view,
            token: result
                .token
                .map(|token| Sensitive::new(token.expose().to_string())),
        }
    }
    async fn handle_logging(
        &self,
        identity: &Identity,
        request: logging::Request,
    ) -> Result<Reply, ErrorCode> {
        {
            let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            store.pairing.require_active(identity, self.now())?;
            store.pairing.require_desktop(identity, self.now())?;
        }
        self.logging.handle(request).await.map(Reply::Logging)
    }
    async fn handle_serial(
        &self,
        identity: &Identity,
        request: serial::Request,
    ) -> Result<Reply, ErrorCode> {
        self.serial
            .handle_authenticated(identity, request)
            .await
            .map(Reply::Serial)
    }
    async fn handle_ssh(
        &self,
        identity: &Identity,
        request: ssh::Request,
    ) -> Result<Reply, ErrorCode> {
        {
            let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            store.pairing.require_active(identity, self.now())?;
            if !store.pairing.is_agent(identity, self.now())?
                || !matches!(
                    request,
                    ssh::Request::Start { .. }
                        | ssh::Request::Disconnect { .. }
                        | ssh::Request::DisconnectStatus { .. }
                        | ssh::Request::Resize { .. }
                        | ssh::Request::Write { .. }
                        | ssh::Request::WriteText { .. }
                        | ssh::Request::InputStatus { .. }
                        | ssh::Request::Exec { .. }
                        | ssh::Request::ExecStatus { .. }
                        | ssh::Request::ExecCancel { .. }
                        | ssh::Request::ExecRead { .. }
                )
            {
                store.pairing.require_desktop(identity, self.now())?;
            }
        }
        self.ssh
            .handle_authenticated(identity, request)
            .await
            .map(Reply::Ssh)
    }
    async fn handle_config(
        &self,
        identity: &Identity,
        request: config::ConfigRequest,
    ) -> Result<Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        {
            let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            store.pairing.require_active(identity, self.now())?;
            store.pairing.require_desktop(identity, self.now())?;
        }
        self.config.request(request).await.map(Reply::Config)
    }
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn handle(&self, identity: &Identity, request: Request) -> Result<Reply, ErrorCode> {
        request.validate()?;
        let now = self.now();
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        store.pairing.require_active(identity, now)?;
        match request {
            Request::Agent { request } => {
                use agent::{Reply as R, Request as A};
                let reply = match request {
                    A::Grant {
                        request_id,
                        scopes,
                        lifetime_ms,
                    } => {
                        store.pairing.require_desktop(identity, now)?;
                        if let Some(result) = store.pairing.grant_replay(
                            identity,
                            request_id,
                            &scopes,
                            lifetime_ms,
                            now,
                        )? {
                            return Ok(Reply::Agent(Self::grant_reply(result)));
                        }
                        for scope in &scopes {
                            if let session_core::access::Target::Connection { connection } =
                                scope.target
                            {
                                store.sessions.info(connection)?;
                            }
                        }
                        Self::grant_reply(store.pairing.issue_managed_agent(
                            identity,
                            request_id,
                            scopes,
                            lifetime_ms,
                            now,
                        )?)
                    }
                    A::GrantStatus { request_id } => {
                        Self::grant_reply(store.pairing.grant_status(identity, request_id, now)?)
                    }
                    A::GrantList {} => R::GrantList(store.pairing.grant_list(identity, now)?),
                    A::GrantRevoke { request_id } => Self::grant_reply(
                        store
                            .pairing
                            .revoke_managed_agent(identity, request_id, now)?,
                    ),
                    A::Acquire {
                        connection,
                        lifetime_ms,
                    } => {
                        store.pairing.can_acquire(identity, connection, now)?;
                        store.sessions.info(connection)?;
                        R::Lease(Some(store.pairing.acquire_lease(
                            identity,
                            connection,
                            lifetime_ms,
                            now,
                        )?))
                    }
                    A::Release {
                        connection,
                        lease_id,
                    } => {
                        store
                            .pairing
                            .release_lease(identity, connection, lease_id, now)?;
                        R::Ok
                    }
                    A::Lease { connection } => {
                        R::Lease(store.pairing.lease(identity, connection, now)?)
                    }
                    A::Takeover { connection } => {
                        store.pairing.require_desktop(identity, now)?;
                        store.sessions.info(connection)?;
                        store.pairing.takeover(identity, connection, now)?;
                        R::Ok
                    }
                    A::Audit { cursor, limit } => {
                        R::Audit(store.pairing.audit(identity, cursor, limit, now)?)
                    }
                };
                Ok(Reply::Agent(reply))
            }
            Request::Ping {} => Ok(Reply::Pong {
                service_id: self.service_id,
                uptime_ms: now,
            }),
            Request::List {} => Ok(Reply::Sessions(
                store
                    .sessions
                    .list()
                    .into_iter()
                    .filter(|info| {
                        store
                            .pairing
                            .can_read(identity, info.reference(), now)
                            .is_ok()
                    })
                    .collect(),
            )),
            Request::Read {
                connection,
                cursor,
                max_bytes,
            } => {
                store.pairing.can_read(identity, connection, now)?;
                Ok(Reply::Output(
                    store.sessions.read(connection, cursor, max_bytes)?,
                ))
            }
            Request::ReadText {
                connection,
                cursor,
                max_bytes,
            } => {
                store.pairing.can_read(identity, connection, now)?;
                Ok(Reply::Text(
                    store.sessions.read_text(connection, cursor, max_bytes)?,
                ))
            }
            Request::Screen { connection } => {
                store.pairing.can_read(identity, connection, now)?;
                Ok(Reply::Screen(store.sessions.screen(connection)?))
            }
            request => {
                store.pairing.require_desktop(identity, now)?;
                match request {
                    Request::IssueRead {
                        scopes,
                        lifetime_ms,
                    } => {
                        for scope in &scopes {
                            store.sessions.info(*scope)?;
                        }
                        let expires = now
                            .checked_add(lifetime_ms)
                            .ok_or(ErrorCode::InvalidArgument)?;
                        let (identity, token) =
                            store.pairing.issue_read(identity, scopes, expires, now)?;
                        Ok(Reply::ReadTicket {
                            ticket_id: identity.ticket_id(),
                            token: Sensitive::new(token.expose().to_string()),
                            expires_at_ms: expires,
                        })
                    }
                    Request::Revoke { ticket_id } => {
                        store.pairing.revoke(identity, ticket_id, now)?;
                        Ok(Reply::Ok)
                    }
                    Request::Shutdown {} => {
                        let _ = self.shutdown.send(true);
                        Ok(Reply::Ok)
                    }
                    request if self.fixture => match request {
                        Request::CreateFixture {} => {
                            let initial = store.sessions.create(Protocol::Fixture)?;
                            let active = store.sessions.begin_connect(initial.reference())?;
                            Ok(Reply::Connection(
                                store
                                    .sessions
                                    .transition(active.reference(), State::Connected)?,
                            ))
                        }
                        Request::AppendFixture { connection, bytes } => {
                            if store.sessions.info(connection)?.protocol != Protocol::Fixture {
                                return Err(ErrorCode::Unsupported);
                            }
                            let time = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map_err(|_| ErrorCode::InvalidState)?
                                .as_millis() as u64;
                            store.sessions.append(connection, &bytes, time)?;
                            Ok(Reply::Ok)
                        }
                        Request::ReconnectFixture { connection } => {
                            if store.sessions.info(connection)?.protocol != Protocol::Fixture {
                                return Err(ErrorCode::Unsupported);
                            }
                            store.sessions.transition(connection, State::Failed)?;
                            let active = store.sessions.begin_connect(connection)?;
                            store.pairing.retire_connection(connection, now);
                            Ok(Reply::Connection(
                                store
                                    .sessions
                                    .transition(active.reference(), State::Connected)?,
                            ))
                        }
                        Request::CloseFixture { connection } => {
                            if store.sessions.info(connection)?.protocol != Protocol::Fixture {
                                return Err(ErrorCode::Unsupported);
                            }
                            store.sessions.transition(connection, State::Closing)?;
                            store.pairing.retire_connection(connection, now);
                            Ok(Reply::Connection(
                                store.sessions.transition(connection, State::Disconnected)?,
                            ))
                        }
                        Request::RemoveFixture { connection } => {
                            if store.sessions.info(connection)?.protocol != Protocol::Fixture {
                                return Err(ErrorCode::Unsupported);
                            }
                            store.sessions.remove(connection)?;
                            store.pairing.retire_connection(connection, now);
                            Ok(Reply::Ok)
                        }
                        _ => Err(ErrorCode::Unsupported),
                    },
                    _ => Err(ErrorCode::Unsupported),
                }
            }
        }
    }
}

async fn connection(mut pipe: NamedPipeServer, runtime: Arc<Runtime>) -> io::Result<()> {
    let hello: Hello = timeout(Duration::from_secs(5), read_frame(&mut pipe))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "hello timeout"))??
        .ok_or_else(|| io::Error::other("missing hello"))?;
    let result = (|| {
        hello.validate()?;
        let token = SecretToken::parse(hello.token.expose().to_string())?;
        let store = runtime.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let identity = store.pairing.authenticate(&token, runtime.now())?;
        let kind = if store
            .pairing
            .require_desktop(&identity, runtime.now())
            .is_ok()
        {
            ClientKind::Desktop
        } else {
            if store.pairing.is_agent(&identity, runtime.now())? {
                ClientKind::Agent
            } else {
                ClientKind::Observer
            }
        };
        Ok::<_, ErrorCode>((identity, kind))
    })();
    let (identity, kind) = match result {
        Ok(value) => value,
        Err(code) => {
            timeout(
                Duration::from_secs(5),
                write_frame(&mut pipe, &Response::Error { id: 0, code }),
            )
            .await??;
            return Ok(());
        }
    };
    timeout(
        Duration::from_secs(5),
        write_frame(
            &mut pipe,
            &Response::Ok {
                id: 0,
                reply: Reply::Welcome(Welcome {
                    protocol_version: PROTOCOL_VERSION,
                    service_id: runtime.service_id,
                    client_id: if matches!(kind, ClientKind::Agent) {
                        identity.ticket_id()
                    } else {
                        Uuid::new_v4()
                    },
                    kind,
                }),
            },
        ),
    )
    .await??;
    let mut shutdown = runtime.shutdown.subscribe();
    loop {
        let request: RequestEnvelope = tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            frame = timeout(Duration::from_secs(30), read_frame(&mut pipe)) => match frame.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "idle client timeout"))?? { Some(value) => value, None => return Ok(()) }
        };
        let result = match request.request {
            Request::Agent { request } => runtime.handle_agent(&identity, request).await,
            Request::Logging { request } => runtime.handle_logging(&identity, request).await,
            Request::Serial { request } => runtime.handle_serial(&identity, request).await,
            Request::Ssh { request } => runtime.handle_ssh(&identity, request).await,
            Request::Config { request } => runtime.handle_config(&identity, request).await,
            request => runtime.handle(&identity, request),
        };
        let response = match result {
            Ok(reply) => Response::Ok {
                id: request.id,
                reply,
            },
            Err(code) => Response::Error {
                id: request.id,
                code,
            },
        };
        timeout(Duration::from_secs(5), write_frame(&mut pipe, &response)).await??;
    }
}

pub async fn serve(instance: &str, bootstrap: SecretToken, fixture: bool) -> io::Result<()> {
    serve_with_config(instance, bootstrap, fixture, None).await
}
pub async fn serve_with_config(
    instance: &str,
    bootstrap: SecretToken,
    fixture: bool,
    directory: Option<std::path::PathBuf>,
) -> io::Result<()> {
    require_standard_user()?;
    let security = PipeSecurity::current_user()?;
    let name = pipe_name(instance)?;
    // No endpoint gap: create the next listener before handing this connection off.
    let mut listener = security.create(&name, true)?;
    let (shutdown, mut stopping) = watch::channel(false);
    let config = crate::config::ConfigWorker::start(directory)?;
    let started = Instant::now();
    let store = Arc::new(Mutex::new(Store {
        sessions: Sessions::default(),
        pairing: Pairing::new(&bootstrap),
        started,
    }));
    let ssh = crate::ssh::Manager::new(store.clone(), config.access());
    let serial = crate::serial::Manager::new(store.clone(), config.access());
    let logging = crate::logging::Manager::new(store.clone(), config.access())?;
    #[cfg(feature = "serial-ui-fixture")]
    let serial = if fixture { serial.ui_fixture() } else { serial };
    let runtime = Arc::new(Runtime {
        logging,
        config,
        ssh,
        serial,
        store,
        service_id: Uuid::new_v4(),
        started,
        fixture,
        shutdown,
    });
    drop(bootstrap);
    let permits = Arc::new(Semaphore::new(32));
    let mut tasks = JoinSet::new();
    let mut serial_tick = tokio::time::interval(Duration::from_millis(10));
    serial_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    eprintln!("session-service ready; fixture={fixture}; no device opened");
    loop {
        // Completed tasks retain JoinSet entries until reaped; bound those too.
        while tasks.try_join_next().is_some() {}
        tokio::select! {
            _ = serial_tick.tick() => runtime.serial.tick(),
            _ = stopping.changed() => break,
            _ = tokio::signal::ctrl_c() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            connected = listener.connect() => {
                connected?;
                let next = security.create(&name, false)?;
                let active = std::mem::replace(&mut listener, next);
                if tasks.len() < 32 && let Ok(permit) = permits.clone().try_acquire_owned() {
                    let runtime = runtime.clone();
                    tasks.spawn(async move { let _permit = permit; let _ = connection(active, runtime).await; });
                }
            }
        }
    }
    // Allow the shutdown RPC's acknowledgement to flush, then bound cleanup time.
    drop(listener);
    let _ = timeout(Duration::from_secs(1), async {
        while tasks.join_next().await.is_some() {}
    })
    .await;
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let runtime = Arc::try_unwrap(runtime)
        .map_err(|_| io::Error::other("session tasks still own runtime"))?;
    runtime.ssh.close().await;
    let serial_result = runtime.serial.close().await;
    let logging_result = runtime.logging.close().await;
    runtime.config.close().await?;
    serial_result?;
    logging_result?;
    Ok(())
}
