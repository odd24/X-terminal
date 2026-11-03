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

struct Store {
    sessions: Sessions,
    pairing: Pairing,
}
struct Runtime {
    store: Mutex<Store>,
    service_id: Uuid,
    started: Instant,
    fixture: bool,
    shutdown: watch::Sender<bool>,
}
impl Runtime {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn handle(&self, identity: &Identity, request: Request) -> Result<Reply, ErrorCode> {
        request.validate()?;
        let now = self.now();
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        store.pairing.require_active(identity, now)?;
        match request {
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
                            Ok(Reply::Connection(
                                store
                                    .sessions
                                    .transition(active.reference(), State::Connected)?,
                            ))
                        }
                        Request::CloseFixture { connection } => {
                            store.sessions.transition(connection, State::Closing)?;
                            Ok(Reply::Connection(
                                store.sessions.transition(connection, State::Disconnected)?,
                            ))
                        }
                        Request::RemoveFixture { connection } => {
                            store.sessions.remove(connection)?;
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
            ClientKind::Observer
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
                    client_id: Uuid::new_v4(),
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
        let response = match runtime.handle(&identity, request.request) {
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
    require_standard_user()?;
    let security = PipeSecurity::current_user()?;
    let name = pipe_name(instance)?;
    // No endpoint gap: create the next listener before handing this connection off.
    let mut listener = security.create(&name, true)?;
    let (shutdown, mut stopping) = watch::channel(false);
    let runtime = Arc::new(Runtime {
        store: Mutex::new(Store {
            sessions: Sessions::default(),
            pairing: Pairing::new(&bootstrap),
        }),
        service_id: Uuid::new_v4(),
        started: Instant::now(),
        fixture,
        shutdown,
    });
    drop(bootstrap);
    let permits = Arc::new(Semaphore::new(32));
    let mut tasks = JoinSet::new();
    eprintln!("session-service ready; fixture={fixture}; no device opened");
    loop {
        // Completed tasks retain JoinSet entries until reaped; bound those too.
        while tasks.try_join_next().is_some() {}
        tokio::select! {
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
    Ok(())
}
