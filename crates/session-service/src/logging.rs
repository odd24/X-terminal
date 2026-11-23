//! Desktop-controlled captures. The store lock only sees nonblocking enqueue/stop.
use crate::{
    config::{Access, Internal, Value},
    server::Store,
};
use session_core::input::{RequestWindow, ordered_timestamp};
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

mod cleanup;
mod export;
mod history;
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
    removed: HashSet<Uuid>,
    released: HashSet<Uuid>,
    window: RequestWindow,
}
impl Inner {
    fn reserve(&mut self, id: Uuid) -> Result<(), ErrorCode> {
        self.window.check(id)?;
        if self.starts.len() >= 64 {
            let (old, log, stamp) = self
                .starts
                .iter()
                .filter(|(_, (_, log))| self.removed.contains(log) || self.released.contains(log))
                .filter_map(|(id, (_, log))| ordered_timestamp(*id).map(|stamp| (*id, *log, stamp)))
                .min_by_key(|(_, _, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            self.starts.remove(&old);
            self.entries.remove(&log);
            self.removed.remove(&log);
            self.released.remove(&log);
            self.window.retire(stamp);
            self.window.check(id)?;
        }
        Ok(())
    }
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
    #[cfg(feature = "t19-timeline-fixture")]
    timeline: Option<(
        terminal_log::timeline_fixture::Timeline,
        std::sync::atomic::AtomicU8,
    )>,
    history: history::Worker,
    export: export::Worker,
    cleanup: cleanup::Worker,
    inner: Arc<Mutex<Inner>>,
    gate: tokio::sync::Mutex<()>,
    store: Arc<Mutex<Store>>,
    config: Access,
}
impl Manager {
    pub(crate) fn new(store: Arc<Mutex<Store>>, config: Access) -> io::Result<Self> {
        let export = export::Worker::start()?;
        let inner = Arc::new(Mutex::new(Inner::default()));
        let cleanup = cleanup::Worker::start(inner.clone(), export.access(), store.clone())?;
        Ok(Self {
            #[cfg(feature = "t19-timeline-fixture")]
            timeline: None,
            history: history::Worker::start()?,
            export,
            cleanup,
            inner,
            gate: tokio::sync::Mutex::new(()),
            store,
            config,
        })
    }
    #[cfg(feature = "t19-timeline-fixture")]
    pub(crate) fn with_timeline(
        mut self,
        timeline: Option<terminal_log::timeline_fixture::Timeline>,
    ) -> Self {
        self.timeline = timeline.map(|timeline| (timeline, std::sync::atomic::AtomicU8::new(0)));
        self
    }
    fn info(&self, entry: &Entry, removed: bool, released: bool) -> Result<wire::Info, ErrorCode> {
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
            F::Capacity => wire::Failure::Capacity,
            F::Storage => wire::Failure::Storage,
            F::WorkerPanicked => wire::Failure::WorkerPanicked,
        });
        Ok(wire::Info {
            readable: status.readable.map(|v| wire::ReadableInfo {
                filename: v.filename,
                directory: v.directory,
                file_identity: Some(v.file_identity),
                written_records: v.written_records,
                flushed_records: v.flushed_records,
                synced_records: v.synced_records,
                written_bytes: v.written_bytes,
                flushed_bytes: v.flushed_bytes,
                synced_bytes: v.synced_bytes,
                written_gap_bytes: v.written_gap_bytes,
                flushed_gap_bytes: v.flushed_gap_bytes,
                synced_gap_bytes: v.synced_gap_bytes,
                flushed_at_ms: v.flushed_at_ms,
                synced_at_ms: v.synced_at_ms,
            }),
            log_id: status.log_id,
            connection: status.connection,
            protocol: entry.metadata.protocol,
            encoding: entry.metadata.encoding.clone(),
            started_at_ms: entry.metadata.started_at_ms,
            source_cursor: entry.metadata.source_cursor,
            text_cursor: entry.metadata.text_cursor,
            limits: entry.limits,
            phase: if removed {
                wire::Phase::Removed
            } else if released {
                wire::Phase::Released
            } else {
                phase
            },
            failure,
            active: active && !removed && !released,
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
            durable: status.durable && !removed && !released,
            worker_finished: status.worker_finished,
        })
    }
    fn duplicate(&self, id: Uuid, start: Start) -> Result<Option<wire::Info>, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        match inner.starts.get(&id) {
            Some((old, log)) if *old == start => Ok(Some(self.info(
                inner.entries.get(log).ok_or(ErrorCode::InvalidState)?,
                inner.removed.contains(log),
                inner.released.contains(log),
            )?)),
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => {
                inner.window.check(id)?;
                Ok(None)
            }
        }
    }
    #[cfg(test)]
    pub(crate) async fn handle(&self, request: Request) -> Result<Reply, ErrorCode> {
        self.handle_named(request, None).await
    }
    pub(crate) async fn handle_named(
        &self,
        request: Request,
        window_name: Option<String>,
    ) -> Result<Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        match request {
            Request::DirectorySetting {} | Request::SetDirectory { .. } => {
                let _gate = self.gate.lock().await;
                let root = self.readable_data().await?;
                tokio::task::spawn_blocking(move || {
                    let (revision, directory) = match request {
                        Request::SetDirectory {
                            revision,
                            directory,
                        } => terminal_log::location::set(&root, revision, directory)
                            .map_err(|_| ErrorCode::InvalidArgument)?
                            .ok_or(ErrorCode::InvalidState)?,
                        _ => terminal_log::location::setting(&root)
                            .map_err(|_| ErrorCode::InvalidState)?,
                    };
                    let effective = terminal_log::location::effective(&root, directory.as_deref())
                        .to_str()
                        .ok_or(ErrorCode::InvalidState)?
                        .to_owned();
                    Ok(Reply::Directory {
                        revision,
                        directory,
                        effective,
                    })
                })
                .await
                .map_err(|_| ErrorCode::InvalidState)?
            }
            Request::ReadableLocation {
                connection,
                log_id,
                protocol,
            } => {
                {
                    let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                    if let Some(entry) = inner.entries.get(&log_id) {
                        if entry.metadata.connection != connection
                            || entry.metadata.protocol != protocol
                        {
                            return Err(ErrorCode::NotFound);
                        }
                        let status = entry.logger.status();
                        let readable = status.readable.ok_or(ErrorCode::NotFound)?;
                        return Ok(Reply::ReadableLocation {
                            directory: readable.directory,
                            filename: readable.filename,
                            file_identity: readable.file_identity,
                            writer_may_be_open: !status.worker_finished,
                        });
                    }
                }
                let root = self.readable_data().await?;
                tokio::task::spawn_blocking(move || {
                    let entry = terminal_log::location::lookup(&root, log_id, connection, protocol)
                        .map_err(|_| ErrorCode::InvalidState)?
                        .ok_or(ErrorCode::NotFound)?;
                    Ok(Reply::ReadableLocation {
                        directory: entry.directory,
                        filename: entry.filename,
                        file_identity: entry.file_identity,
                        writer_may_be_open: false,
                    })
                })
                .await
                .map_err(|_| ErrorCode::InvalidState)?
            }
            Request::StartStatus {
                connection,
                request_id,
            } => {
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let (start, id) = inner.starts.get(&request_id).ok_or_else(|| {
                    inner
                        .window
                        .check(request_id)
                        .err()
                        .unwrap_or(ErrorCode::NotFound)
                })?;
                if start.connection != connection {
                    return Err(ErrorCode::InvalidArgument);
                }
                Ok(Reply::Info(Box::new(self.info(
                    inner.entries.get(id).ok_or(ErrorCode::NotFound)?,
                    inner.removed.contains(id),
                    inner.released.contains(id),
                )?)))
            }
            request @ (Request::CleanupList { .. }
            | Request::CleanupPreview { .. }
            | Request::CleanupStatus { .. }
            | Request::CleanupCancel { .. }
            | Request::CleanupCommit { .. }) => {
                let _gate = self.gate.lock().await;
                if matches!(request, Request::CleanupPreview { .. })
                    && self.export.access().busy()?
                {
                    return Err(ErrorCode::InvalidState);
                }
                if matches!(request, Request::CleanupList { .. }) && self.cleanup.reserved() {
                    return Err(ErrorCode::InvalidState);
                }
                let directory = if matches!(
                    request,
                    Request::CleanupList { .. }
                        | Request::CleanupPreview { .. }
                        | Request::CleanupCommit { .. }
                ) {
                    let Value::LoggingDirectory(path) = self
                        .config
                        .request(Internal::LoggingDirectory)
                        .await
                        .map_err(|_| ErrorCode::InvalidState)?
                    else {
                        return Err(ErrorCode::InvalidState);
                    };
                    Some(path)
                } else {
                    None
                };
                self.cleanup.request(directory, request).await
            }
            request @ (Request::TextExportStart {
                connection,
                log_id,
                request_id,
            }
            | Request::ExportStart {
                connection,
                log_id,
                request_id,
            }
            | Request::RecoveryExportStart {
                connection,
                log_id,
                request_id,
            }) => {
                let text = matches!(request, Request::TextExportStart { .. });
                let recovery = matches!(request, Request::RecoveryExportStart { .. });
                let duplicate = || {
                    if text {
                        self.export
                            .text_duplicate(connection, log_id, request_id)
                            .map(|v| v.map(|v| Reply::TextExport(Box::new(v))))
                    } else if recovery {
                        self.export
                            .recovery_duplicate(connection, log_id, request_id)
                            .map(|info| info.map(|info| Reply::RecoveryExport(Box::new(info))))
                    } else {
                        self.export
                            .duplicate(connection, log_id, request_id)
                            .map(|info| info.map(|info| Reply::Export(Box::new(info))))
                    }
                };
                if let Some(reply) = duplicate()? {
                    return Ok(reply);
                }
                let _gate = self.gate.lock().await;
                if let Some(reply) = duplicate()? {
                    return Ok(reply);
                }
                if self.cleanup.reserved() {
                    return Err(ErrorCode::InvalidState);
                }
                let Value::LoggingDirectory(directory) = self
                    .config
                    .request(Internal::LoggingDirectory)
                    .await
                    .map_err(|_| ErrorCode::InvalidState)?
                else {
                    return Err(ErrorCode::InvalidState);
                };
                if text {
                    self.export
                        .text_submit(directory, connection, log_id, request_id)
                        .map(|v| Reply::TextExport(Box::new(v)))
                } else if recovery {
                    self.export
                        .recovery_submit(directory, connection, log_id, request_id)
                        .map(|info| Reply::RecoveryExport(Box::new(info)))
                } else {
                    self.export
                        .submit(directory, connection, log_id, request_id)
                        .map(|info| Reply::Export(Box::new(info)))
                }
            }
            request @ (Request::TextExportStatus {
                connection,
                log_id,
                request_id,
            }
            | Request::TextExportCancel {
                connection,
                log_id,
                request_id,
            }
            | Request::RecoveryExportStatus {
                connection,
                log_id,
                request_id,
            }
            | Request::RecoveryExportCancel {
                connection,
                log_id,
                request_id,
            }
            | Request::ExportStatus {
                connection,
                log_id,
                request_id,
            }
            | Request::ExportCancel {
                connection,
                log_id,
                request_id,
            }) => {
                if matches!(
                    request,
                    Request::TextExportStatus { .. } | Request::TextExportCancel { .. }
                ) {
                    self.export
                        .text_status(
                            connection,
                            log_id,
                            request_id,
                            matches!(request, Request::TextExportCancel { .. }),
                        )
                        .map(|v| Reply::TextExport(Box::new(v)))
                } else if matches!(
                    request,
                    Request::RecoveryExportStatus { .. } | Request::RecoveryExportCancel { .. }
                ) {
                    self.export
                        .recovery_status(
                            connection,
                            log_id,
                            request_id,
                            matches!(request, Request::RecoveryExportCancel { .. }),
                        )
                        .map(|info| Reply::RecoveryExport(Box::new(info)))
                } else {
                    self.export
                        .status(
                            connection,
                            log_id,
                            request_id,
                            matches!(request, Request::ExportCancel { .. }),
                        )
                        .map(|info| Reply::Export(Box::new(info)))
                }
            }
            request @ (Request::HistoryList {}
            | Request::RecoveryList {}
            | Request::RecoveryOpen { .. }
            | Request::RecoveryRead { .. }
            | Request::RecoveryClose { .. }
            | Request::HistoryOpen { .. }
            | Request::HistoryRead { .. }
            | Request::HistoryClose { .. }) => {
                if matches!(
                    request,
                    Request::HistoryList {}
                        | Request::HistoryOpen { .. }
                        | Request::RecoveryList {}
                        | Request::RecoveryOpen { .. }
                ) && self.cleanup.reserved()
                {
                    return Err(ErrorCode::InvalidState);
                }
                let directory = if matches!(
                    request,
                    Request::HistoryList {}
                        | Request::HistoryOpen { .. }
                        | Request::RecoveryList {}
                        | Request::RecoveryOpen { .. }
                ) {
                    let Value::LoggingDirectory(directory) = self
                        .config
                        .request(Internal::LoggingDirectory)
                        .await
                        .map_err(|_| ErrorCode::InvalidState)?
                    else {
                        return Err(ErrorCode::InvalidState);
                    };
                    Some(directory)
                } else {
                    None
                };
                self.history.request(directory, request).await
            }
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
                if self.cleanup.reserved() {
                    return Err(ErrorCode::InvalidState);
                }
                let Value::LoggingDirectory(directory) = self
                    .config
                    .request(Internal::LoggingDirectory)
                    .await
                    .map_err(|_| ErrorCode::InvalidState)?
                else {
                    return Err(ErrorCode::InvalidState);
                };
                let prepared = tokio::task::spawn_blocking(move || {
                    let (_, destination) = terminal_log::location::setting(&directory)?;
                    // Validate before attaching a capture. The worker revalidates at file creation.
                    let Ok(pin) = terminal_log::UserLogDirectory::resolve(
                        &directory,
                        destination.as_deref(),
                        true,
                    ) else {
                        return Ok(None);
                    };
                    terminal_log::ManagedRoot::open(&directory).and_then(|root| {
                        let ids = root.ids()?;
                        Ok(Some(((root, ids), (destination, pin))))
                    })
                })
                .await
                .map_err(|_| ErrorCode::InvalidState)?
                .map_err(|_| ErrorCode::InvalidState)?;
                let Some((root, destination)) = prepared else {
                    return Ok(Reply::DirectoryUnavailable {});
                };
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                inner.reserve(request_id)?;
                let mut ids: HashSet<_> = root.1.into_iter().collect();
                ids.extend(
                    inner
                        .entries
                        .keys()
                        .filter(|id| !inner.removed.contains(id) && !inner.released.contains(id))
                        .copied(),
                );
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
                let start_logger = || {
                    Logger::start_registered_readable(
                        root.0.path().to_path_buf(),
                        metadata.clone(),
                        terminal_log::Limits {
                            segment_bytes: limits.segment_bytes,
                            segments: limits.segments,
                        },
                        window_name.unwrap_or_else(|| "终端".into()),
                        destination,
                    )
                };
                #[cfg(feature = "t19-timeline-fixture")]
                let logger = if let Some((timeline, next)) = &self.timeline {
                    if position.protocol != Protocol::Fixture {
                        return Err(ErrorCode::Unsupported);
                    }
                    use std::sync::atomic::Ordering::Relaxed;
                    let index = next
                        .try_update(Relaxed, Relaxed, |index| (index < 8).then_some(index + 1))
                        .map_err(|_| ErrorCode::CapacityExceeded)?;
                    timeline.with_logger(index, start_logger)
                } else {
                    start_logger()
                };
                #[cfg(not(feature = "t19-timeline-fixture"))]
                let logger = start_logger();
                let logger = Arc::new(logger.map_err(|error| {
                    if error.kind() == io::ErrorKind::WouldBlock {
                        ErrorCode::CapacityExceeded
                    } else {
                        ErrorCode::InvalidState
                    }
                })?);
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
                Ok(Reply::Info(Box::new(self.info(
                    &inner.entries[&id],
                    false,
                    false,
                )?)))
            }
            request @ (Request::List { .. } | Request::CaptureList {}) => {
                let connection = match request {
                    Request::List { connection } => Some(connection),
                    _ => None,
                };
                let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let mut logs = inner
                    .entries
                    .values()
                    .filter(|entry| {
                        connection.is_none_or(|target| entry.metadata.connection == target)
                    })
                    .map(|entry| {
                        let id = entry.logger.status().log_id;
                        self.info(
                            entry,
                            inner.removed.contains(&id),
                            inner.released.contains(&id),
                        )
                    })
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
                Ok(Reply::Info(Box::new(self.info(
                    entry,
                    inner.removed.contains(&log_id),
                    inner.released.contains(&log_id),
                )?)))
            }
            Request::ReleaseFailed { connection, log_id } => {
                // Metadata-only maintenance: no directory reads/deletes and no
                // claim that a failed attempt ever created a file. This also
                // works when its data directory is currently unavailable.
                let _gate = self.gate.lock().await;
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let entry = inner
                    .entries
                    .get(&log_id)
                    .filter(|entry| entry.metadata.connection == connection)
                    .ok_or(ErrorCode::NotFound)?;
                let status = entry.logger.status();
                if status.phase != terminal_log::Phase::Failed || !status.worker_finished {
                    return Err(ErrorCode::InvalidState);
                }
                if !inner.removed.contains(&log_id) {
                    let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    if store.sessions.capture_id(connection).ok().flatten() == Some(log_id) {
                        store.sessions.detach_capture(connection, log_id)?;
                    }
                    inner.released.insert(log_id);
                }
                Ok(Reply::Info(Box::new(self.info(
                    &inner.entries[&log_id],
                    inner.removed.contains(&log_id),
                    inner.released.contains(&log_id),
                )?)))
            }
        }
    }
    async fn readable_data(&self) -> Result<std::path::PathBuf, ErrorCode> {
        match self.config.request(Internal::LoggingDirectory).await {
            Ok(Value::LoggingDirectory(path)) => Ok(path),
            _ => Err(ErrorCode::InvalidState),
        }
    }
    pub(crate) async fn close(self) -> io::Result<()> {
        self.cleanup.close().await?;
        self.export.close().await?;
        self.history.close().await?;
        let inner = Arc::try_unwrap(self.inner)
            .map_err(|_| io::Error::other("cleanup still owns logging state"))?
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
