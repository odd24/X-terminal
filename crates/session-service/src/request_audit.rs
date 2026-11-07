//! Separate from policy audit/authorization. Guards never cancel business work.
use session_core::{rpc_audit::*, session::ErrorCode};
use session_protocol::rpc_audit as wire;
use std::{
    io,
    os::windows::io::AsRawHandle,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::net::windows::named_pipe::NamedPipeServer;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Audit {
    ring: Arc<Mutex<Ring>>,
    failures: Arc<AtomicU64>,
    started: Instant,
    service_id: Uuid,
}
impl Audit {
    pub(crate) fn new(service_id: Uuid, started: Instant) -> Self {
        Self {
            ring: Arc::new(Mutex::new(Ring::default())),
            failures: Arc::new(AtomicU64::new(0)),
            started,
            service_id,
        }
    }
    fn time(&self) -> Time {
        Time {
            unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            elapsed_ms: self.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        }
    }
    fn edit<T>(&self, f: impl FnOnce(&mut Ring) -> Result<T, ErrorCode>) -> Result<T, ErrorCode> {
        let result = self
            .ring
            .lock()
            .map_err(|_| ErrorCode::InvalidState)
            .and_then(|mut r| f(&mut r));
        if result.is_err() {
            let _ = self
                .failures
                .try_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                    Some(v.saturating_add(1))
                });
        }
        result
    }
    pub(crate) fn begin(&self, origin: Origin, request: Descriptor) -> io::Result<Guard> {
        let event = self
            .edit(|ring| ring.begin(self.time(), origin, request))
            .map_err(|_| io::Error::other("request audit unavailable"))?;
        Ok(Guard {
            audit: self.clone(),
            id: event.attempt.attempt_id,
            active: true,
        })
    }
    pub(crate) fn read_failure(
        &self,
        origin: Origin,
        stage: IoStage,
        reason: IoReason,
    ) -> io::Result<()> {
        let guard = self.begin(
            origin,
            Descriptor {
                area: Area::Transport,
                verb: Verb::Receive,
                wire_id: None,
                request_id: None,
                requested_scope: None,
                resource: None,
            },
        )?;
        guard.end(Phase::IoFailure { stage, reason })
    }
    pub(crate) fn reject_capacity(&self, pipe: &NamedPipeServer) -> io::Result<()> {
        let origin = Origin {
            pipe_id: Uuid::new_v4(),
            client_id: None,
            kind: OriginKind::Unauthenticated,
            peer_pid: peer_pid(pipe),
        };
        let guard = self.begin(
            origin,
            Descriptor {
                area: Area::Transport,
                verb: Verb::Hello,
                wire_id: None,
                request_id: None,
                requested_scope: None,
                resource: None,
            },
        )?;
        guard.end(Phase::AdmissionRejected {
            code: ErrorCode::CapacityExceeded,
        })
    }
    pub(crate) fn query(&self, view: wire::View) -> Result<wire::Reply, ErrorCode> {
        let ring = self.ring.lock().map_err(|_| ErrorCode::InvalidState)?;
        let failures = self.failures.load(Ordering::Relaxed);
        match view {
            wire::View::Info {} => Ok(wire::Reply::Info {
                service_id: self.service_id,
                through_cursor: ring.through_cursor(),
                active_attempts: ring.active_count(),
                record_failures: failures,
                persistent: false,
            }),
            wire::View::Page {
                cursor,
                through_cursor,
                limit,
            } => Ok(wire::Reply::Page {
                service_id: self.service_id,
                page: ring.page(cursor, through_cursor, limit)?,
                record_failures: failures,
                persistent: false,
            }),
        }
    }
}
pub(crate) struct Guard {
    audit: Audit,
    id: Uuid,
    active: bool,
}
impl Guard {
    pub(crate) fn authenticated(&self, client_id: Uuid, kind: OriginKind) -> io::Result<()> {
        self.audit
            .edit(|r| r.authenticated(self.id, self.audit.time(), client_id, kind))
            .map(|_| ())
            .map_err(|_| io::Error::other("request audit authentication unavailable"))
    }
    pub(crate) fn returned(&self, result: Result<(), ErrorCode>) -> io::Result<()> {
        self.audit
            .edit(|r| r.returned(self.id, self.audit.time(), result))
            .map(|_| ())
            .map_err(|_| io::Error::other("request audit result unavailable"))
    }
    pub(crate) fn end(mut self, phase: Phase) -> io::Result<()> {
        self.audit
            .edit(|r| r.end(self.id, self.audit.time(), phase))
            .map_err(|_| io::Error::other("request audit completion unavailable"))?;
        self.active = false;
        Ok(())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if self.active {
            let _ = self
                .audit
                .edit(|r| r.end(self.id, self.audit.time(), Phase::Abandoned {}));
        }
    }
}
pub(crate) fn origin_kind(kind: session_protocol::ClientKind) -> OriginKind {
    match kind {
        session_protocol::ClientKind::Desktop => OriginKind::Desktop,
        session_protocol::ClientKind::Observer => OriginKind::Observer,
        session_protocol::ClientKind::Agent => OriginKind::Agent,
    }
}
pub(crate) fn peer_pid(pipe: &NamedPipeServer) -> Option<u32> {
    let mut pid = 0;
    let ok = unsafe {
        windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
            pipe.as_raw_handle(),
            &mut pid,
        )
    };
    (ok != 0 && pid != 0).then_some(pid)
}
pub(crate) fn io_reason(error: &io::Error) -> IoReason {
    match error.kind() {
        io::ErrorKind::TimedOut => IoReason::Timeout,
        io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput | io::ErrorKind::UnexpectedEof => {
            IoReason::InvalidFrame
        }
        io::ErrorKind::BrokenPipe
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected => IoReason::Closed,
        _ => IoReason::Other,
    }
}
pub(crate) async fn write_response(
    pipe: &mut NamedPipeServer,
    guard: Guard,
    response: &session_protocol::Response,
) -> io::Result<()> {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        session_protocol::write_frame(pipe, response),
    )
    .await;
    match result {
        Ok(Ok(())) => guard.end(Phase::ReplyWritten {}),
        Ok(Err(error)) => {
            guard.end(Phase::IoFailure {
                stage: IoStage::ReplyWrite,
                reason: io_reason(&error),
            })?;
            Err(error)
        }
        Err(_) => {
            guard.end(Phase::IoFailure {
                stage: IoStage::ReplyWrite,
                reason: IoReason::Timeout,
            })?;
            Err(io::Error::new(io::ErrorKind::TimedOut, "reply timeout"))
        }
    }
}

#[cfg(test)]
#[path = "request_audit/tests.rs"]
mod tests;
