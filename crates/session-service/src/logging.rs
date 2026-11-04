//! Desktop-controlled captures. The store lock only sees nonblocking enqueue/stop.
use crate::{
    config::{Access, Internal, Value},
    server::Store,
};
use session_core::{capture::OutputCapture, presentation::TextEvent, session::*};
use session_protocol::logging::{self as wire, Reply, Request};
use std::{
    collections::{HashMap, HashSet},
    io,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use terminal_log::{Logger, Metadata};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Start {
    connection: ConnectionRef,
    limits: wire::Limits,
}

#[cfg(test)]
mod tests;
struct Entry {
    logger: Arc<Logger>,
    metadata: Metadata,
    limits: wire::Limits,
}
#[derive(Default)]
struct Inner {
    entries: HashMap<Uuid, Entry>,
    starts: HashMap<Uuid, (Start, Uuid)>,
}
struct Sink {
    logger: Arc<Logger>,
    connection: ConnectionRef,
}
impl OutputCapture for Sink {
    fn record(&self, raw: Option<&OutputEvent>, text: &TextEvent) {
        self.logger.submit(terminal_log::Record {
            connection: self.connection,
            raw: raw.cloned(),
            text: text.clone(),
        });
    }
    fn stop(&self) {
        self.logger.stop();
    }
}
pub(crate) struct Manager {
    inner: Mutex<Inner>,
    gate: tokio::sync::Mutex<()>,
    store: Arc<Mutex<Store>>,
    config: Access,
}
impl Manager {
    pub(crate) fn new(store: Arc<Mutex<Store>>, config: Access) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            gate: tokio::sync::Mutex::new(()),
            store,
            config,
        }
    }
    fn info(&self, entry: &Entry) -> Result<wire::Info, ErrorCode> {
        let status = entry.logger.status();
        let active = self
            .store
            .lock()
            .map_err(|_| ErrorCode::InvalidState)?
            .sessions
            .capture_id(entry.metadata.connection)
            .ok()
            .flatten()
            == Some(status.log_id);
        use terminal_log::{Failure as F, Phase as P};
        let phase = match status.phase {
            P::Opening => wire::Phase::Opening,
            P::Recording => wire::Phase::Recording,
            P::Stopping => wire::Phase::Stopping,
            P::Stopped => wire::Phase::Stopped,
            P::Failed => wire::Phase::Failed,
        };
        let failure = status.failure.map(|value| match value {
            F::QueueFull => wire::Failure::QueueFull,
            F::InvalidRecord => wire::Failure::InvalidRecord,
            F::CounterExhausted => wire::Failure::CounterExhausted,
            F::DiskFull => wire::Failure::DiskFull,
            F::Storage => wire::Failure::Storage,
            F::WorkerPanicked => wire::Failure::WorkerPanicked,
        });
        Ok(wire::Info {
            log_id: status.log_id,
            connection: status.connection,
            protocol: entry.metadata.protocol,
            encoding: entry.metadata.encoding.clone(),
            started_at_ms: entry.metadata.started_at_ms,
            source_cursor: entry.metadata.source_cursor,
            text_cursor: entry.metadata.text_cursor,
            limits: entry.limits,
            phase,
            failure,
            active,
            accepted_records: status.accepted_records,
            written_records: status.written_records,
            accepted_raw_bytes: status.accepted_raw_bytes,
            written_raw_bytes: status.written_raw_bytes,
            rejected_records: status.rejected_records,
            rejected_raw_bytes: status.rejected_raw_bytes,
            source_gap_bytes: status.source_gap_bytes,
            first_retained_segment: status.first_retained_segment,
            last_segment: status.last_segment,
            retired_segments: status.retired_segments,
            natural_end: status.natural_end,
            durable: status.durable,
            worker_finished: status.worker_finished,
        })
    }
    fn duplicate(&self, id: Uuid, start: Start) -> Result<Option<wire::Info>, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        match inner.starts.get(&id) {
            Some((old, log)) if *old == start => Ok(Some(
                self.info(inner.entries.get(log).ok_or(ErrorCode::InvalidState)?)?,
            )),
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => Ok(None),
        }
    }
    pub(crate) async fn handle(&self, request: Request) -> Result<Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        match request {
            Request::Start {
                connection,
                request_id,
                limits,
            } => {
                let start = Start { connection, limits };
                if let Some(info) = self.duplicate(request_id, start)? {
                    return Ok(Reply::Info(Box::new(info)));
                }
                let _gate = self.gate.lock().await;
                if let Some(info) = self.duplicate(request_id, start)? {
                    return Ok(Reply::Info(Box::new(info)));
                }
                let Value::LoggingDirectory(directory) = self
                    .config
                    .request(Internal::LoggingDirectory)
                    .await
                    .map_err(|_| ErrorCode::InvalidState)?
                else {
                    return Err(ErrorCode::InvalidState);
                };
                let root = tokio::task::spawn_blocking(move || {
                    terminal_log::ManagedRoot::open(&directory).and_then(|root| {
                        let ids = root.ids()?;
                        Ok((root, ids))
                    })
                })
                .await
                .map_err(|_| ErrorCode::InvalidState)?
                .map_err(|_| ErrorCode::InvalidState)?;
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let mut ids: HashSet<_> = root.1.into_iter().collect();
                ids.extend(inner.entries.keys().copied());
                if ids.len() >= 64 || inner.entries.len() >= 64 {
                    return Err(ErrorCode::CapacityExceeded);
                }
                let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                let position = store.sessions.output_position(connection)?;
                if store.sessions.capture_id(connection)?.is_some() {
                    return Err(ErrorCode::InvalidState);
                }
                let metadata = Metadata {
                    connection,
                    protocol: position.protocol,
                    encoding: position.encoding,
                    started_at_ms: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| ErrorCode::InvalidState)?
                        .as_millis() as u64,
                    source_cursor: position.source_cursor,
                    text_cursor: position.text_cursor,
                };
                let logger = Arc::new(
                    Logger::start(
                        root.0.path().to_path_buf(),
                        metadata.clone(),
                        terminal_log::Limits {
                            segment_bytes: limits.segment_bytes,
                            segments: limits.segments,
                        },
                    )
                    .map_err(|error| {
                        if error.kind() == io::ErrorKind::WouldBlock {
                            ErrorCode::CapacityExceeded
                        } else {
                            ErrorCode::InvalidState
                        }
                    })?,
                );
                let id = logger.status().log_id;
                store.sessions.attach_capture(
                    connection,
                    id,
                    Arc::new(Sink {
                        logger: logger.clone(),
                        connection,
                    }),
                )?;
                inner.entries.insert(
                    id,
                    Entry {
                        logger,
                        metadata,
                        limits,
                    },
                );
                inner.starts.insert(request_id, (start, id));
                drop(store);
                Ok(Reply::Info(Box::new(self.info(&inner.entries[&id])?)))
            }
            Request::List { connection } => {
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let mut logs = inner
                    .entries
                    .values()
                    .filter(|entry| entry.metadata.connection == connection)
                    .map(|entry| self.info(entry))
                    .collect::<Result<Vec<_>, _>>()?;
                logs.sort_by_key(|info| (std::cmp::Reverse(info.started_at_ms), info.log_id));
                Ok(Reply::List { logs })
            }
            Request::Status { connection, log_id } | Request::Stop { connection, log_id } => {
                let stop = matches!(request, Request::Stop { .. });
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let entry = inner
                    .entries
                    .get(&log_id)
                    .filter(|e| e.metadata.connection == connection)
                    .ok_or(ErrorCode::NotFound)?;
                if stop {
                    // An old log cannot detach a newer capture, even in the same generation.
                    let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    if store.sessions.capture_id(connection).ok().flatten() == Some(log_id) {
                        store.sessions.detach_capture(connection, log_id)?;
                    }
                    entry.logger.stop();
                }
                Ok(Reply::Info(Box::new(self.info(entry)?)))
            }
        }
    }
    pub(crate) async fn close(self) -> io::Result<()> {
        let inner = self
            .inner
            .into_inner()
            .map_err(|_| io::Error::other("logging state poisoned"))?;
        {
            let mut store = self
                .store
                .lock()
                .map_err(|_| io::Error::other("session state poisoned"))?;
            for (id, entry) in &inner.entries {
                if store
                    .sessions
                    .capture_id(entry.metadata.connection)
                    .ok()
                    .flatten()
                    == Some(*id)
                {
                    let _ = store
                        .sessions
                        .detach_capture(entry.metadata.connection, *id);
                }
                entry.logger.stop();
            }
        }
        tokio::task::spawn_blocking(move || {
            for entry in inner.entries.into_values() {
                let mut logger = Arc::try_unwrap(entry.logger)
                    .map_err(|_| io::Error::other("capture still owns journal"))?;
                logger.join();
            }
            Ok(())
        })
        .await
        .map_err(|_| io::Error::other("journal cleanup task failed"))?
    }
}
