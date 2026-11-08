//! Dedicated bounded export worker. Status/cancel never wait on filesystem I/O.
use super::*;
use session_core::input::{RequestWindow, ordered_timestamp};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};
use terminal_log::{ExportArtifact, ExportStore, ManagedRoot, RecoveryArtifact};
use wire::{ExportFailure as F, ExportInfo, ExportPhase as P};

const RECEIPTS: usize = 64;
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Text,
    Normal,
    Recovery,
}
enum Artifact {
    Normal(ExportArtifact),
    Recovery(RecoveryArtifact),
}
struct Entry {
    info: ExportInfo,
    mode: Mode,
    recovery: Option<wire::RecoveryExportSummary>,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
struct Registry {
    items: HashMap<Uuid, Entry>,
    window: RequestWindow,
}
type Entries = Arc<Mutex<Registry>>;
type Receipt = (ExportInfo, Option<wire::RecoveryExportSummary>);
fn recovery_info((info, recovered): Receipt) -> wire::RecoveryExportInfo {
    wire::RecoveryExportInfo {
        connection: info.connection,
        log_id: info.log_id,
        request_id: info.request_id,
        phase: info.phase,
        failure: info.failure,
        incomplete: true,
        bytes: info.bytes,
        sha256: info.sha256,
        recovered,
    }
}
fn recovery_summary(summary: terminal_log::RecoverySummary) -> wire::RecoveryExportSummary {
    use terminal_log::RecoveryStopKind as S;
    use wire::RecoveryStopKind as W;
    wire::RecoveryExportSummary {
        recovered_records: summary.recovered_records,
        recovered_raw_bytes: summary.recovered_raw_bytes,
        recovered_gap_bytes: summary.recovered_gap_bytes,
        next_cursor: summary.next_cursor,
        stop: wire::RecoveryStop {
            segment: summary.stop.segment,
            next_cursor: summary.stop.next_cursor,
            kind: match summary.stop.kind {
                S::EndOfAvailable => W::EndOfAvailable,
                S::MissingPartner => W::MissingPartner,
                S::MissingSegment => W::MissingSegment,
                S::InvalidHeader => W::InvalidHeader,
                S::Discontinuity => W::Discontinuity,
                S::TruncatedRecord => W::TruncatedRecord,
                S::InvalidRecord => W::InvalidRecord,
                S::Storage => W::Storage,
            },
        },
    }
}
#[derive(Clone)]
pub(super) struct Access(Entries);
impl Access {
    pub(super) fn busy(&self) -> Result<bool, ErrorCode> {
        Ok(self
            .0
            .lock()
            .map_err(|_| ErrorCode::InvalidState)?
            .items
            .values()
            .any(|entry| !terminal(entry.info.phase)))
    }
    pub(super) fn mark_removed(&self, id: Uuid) {
        let mut registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = registry.items.get_mut(&id) {
            entry.recovery = None;
            entry.info.phase = P::Removed;
            entry.info.failure = None;
            entry.info.bytes = None;
            entry.info.sha256 = None;
            entry.info.retained_records = None;
            entry.info.retained_raw_bytes = None;
            entry.info.retained_gap_bytes = None;
            entry.info.next_cursor = None;
        }
    }
}
struct Job {
    mode: Mode,
    directory: PathBuf,
    connection: ConnectionRef,
    log_id: Uuid,
    request_id: Uuid,
    cancel: Arc<AtomicBool>,
}
pub(super) struct Worker {
    entries: Entries,
    sender: mpsc::SyncSender<Job>,
    thread: thread::JoinHandle<()>,
}
fn terminal(phase: P) -> bool {
    matches!(phase, P::Completed | P::Cancelled | P::Failed | P::Removed)
}
fn failure(error: io::Error) -> F {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput => {
            F::InvalidSource
        }
        io::ErrorKind::StorageFull => F::Capacity,
        io::ErrorKind::FileTooLarge => F::TooLarge,
        _ => F::Storage,
    }
}
impl Worker {
    pub(super) fn access(&self) -> Access {
        Access(self.entries.clone())
    }
    pub(super) fn start() -> io::Result<Self> {
        Self::spawn(|| {})
    }
    fn spawn(before: impl FnOnce() + Send + 'static) -> io::Result<Self> {
        let entries: Entries = Arc::default();
        let shared = entries.clone();
        let (sender, receiver) = mpsc::sync_channel::<Job>(8);
        let thread = thread::Builder::new()
            .name("terminal-log-export".into())
            .spawn(move || {
                before();
                let mut store: Option<(PathBuf, ExportStore)> = None;
                while let Ok(job) = receiver.recv() {
                    {
                        let mut entries = shared.lock().unwrap_or_else(|e| e.into_inner());
                        let entry = entries.items.get_mut(&job.request_id).unwrap();
                        if job.cancel.load(Ordering::Acquire) {
                            entry.info.phase = P::Cancelled;
                            continue;
                        }
                        entry.info.phase = P::Running;
                    }
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                        || -> io::Result<Artifact> {
                            if store
                                .as_ref()
                                .is_some_and(|(path, _)| path != &job.directory)
                            {
                                return Err(io::Error::other("export directory changed"));
                            }
                            if store.is_none() {
                                store = Some((
                                    job.directory.clone(),
                                    ExportStore::open(&job.directory)?,
                                ));
                            }
                            let root = ManagedRoot::open(&job.directory)?;
                            let store = &mut store.as_mut().unwrap().1;
                            if job.mode == Mode::Recovery {
                                return store
                                    .create_recovery(
                                        &root,
                                        job.log_id,
                                        job.connection,
                                        job.request_id,
                                        || job.cancel.load(Ordering::Acquire),
                                    )
                                    .map(Artifact::Recovery);
                            }
                            if job.mode == Mode::Text {
                                return store
                                    .create_text(
                                        &root,
                                        job.log_id,
                                        job.connection,
                                        job.request_id,
                                        || job.cancel.load(Ordering::Acquire),
                                    )
                                    .map(Artifact::Normal);
                            }
                            store
                                .create(&root, job.log_id, job.connection, job.request_id, || {
                                    job.cancel.load(Ordering::Acquire)
                                })
                                .map(Artifact::Normal)
                        },
                    ));
                    let mut entries = shared.lock().unwrap_or_else(|e| e.into_inner());
                    let entry = entries.items.get_mut(&job.request_id).unwrap();
                    let info = &mut entry.info;
                    match result {
                        Ok(Ok(artifact)) => {
                            let (bytes, sha256) = match artifact {
                                Artifact::Normal(artifact) => {
                                    info.retained_records = Some(artifact.summary.retained_records);
                                    info.retained_raw_bytes =
                                        Some(artifact.summary.retained_raw_bytes);
                                    info.retained_gap_bytes =
                                        Some(artifact.summary.retained_gap_bytes);
                                    info.next_cursor = Some(artifact.summary.next_cursor);
                                    (artifact.bytes, artifact.sha256)
                                }
                                Artifact::Recovery(artifact) => {
                                    entry.recovery = Some(recovery_summary(artifact.summary));
                                    (artifact.bytes, artifact.sha256)
                                }
                            };
                            // Publication wins a concurrent late cancel; never report
                            // cancellation as if an already-created file disappeared.
                            info.phase = P::Completed;
                            info.bytes = Some(bytes);
                            info.sha256 =
                                Some(sha256.iter().map(|byte| format!("{byte:02x}")).collect());
                        }
                        Ok(Err(error))
                            if error.kind() == io::ErrorKind::Interrupted
                                && job.cancel.load(Ordering::Acquire) =>
                        {
                            info.phase = P::Cancelled
                        }
                        other => {
                            info.phase = P::Failed;
                            info.failure = Some(match other {
                                Ok(Err(error)) => failure(error),
                                _ => F::WorkerFailed,
                            });
                        }
                    }
                }
            })?;
        Ok(Self {
            entries,
            sender,
            thread,
        })
    }
    pub(super) fn duplicate(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    ) -> Result<Option<ExportInfo>, ErrorCode> {
        Ok(self
            .duplicate_mode(connection, log_id, request_id, Mode::Normal)?
            .map(|(info, _)| info))
    }
    pub(super) fn text_duplicate(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    ) -> Result<Option<ExportInfo>, ErrorCode> {
        Ok(self
            .duplicate_mode(connection, log_id, request_id, Mode::Text)?
            .map(|(i, _)| i))
    }
    pub(super) fn text_submit(
        &self,
        directory: PathBuf,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    ) -> Result<ExportInfo, ErrorCode> {
        Ok(self
            .submit_mode(directory, connection, log_id, request_id, Mode::Text)?
            .0)
    }
    pub(super) fn text_status(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        cancel: bool,
    ) -> Result<ExportInfo, ErrorCode> {
        Ok(self
            .status_mode(connection, log_id, request_id, cancel, Mode::Text)?
            .0)
    }
    fn duplicate_mode(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        mode: Mode,
    ) -> Result<Option<Receipt>, ErrorCode> {
        let entries = self.entries.lock().map_err(|_| ErrorCode::InvalidState)?;
        if !entries.items.contains_key(&request_id) {
            entries.window.check(request_id)?;
        }
        entries
            .items
            .get(&request_id)
            .map(|entry| {
                if entry.info.connection != connection
                    || entry.info.log_id != log_id
                    || entry.mode != mode
                {
                    Err(ErrorCode::InvalidArgument)
                } else {
                    Ok((entry.info.clone(), entry.recovery.clone()))
                }
            })
            .transpose()
    }
    pub(super) fn submit(
        &self,
        directory: PathBuf,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    ) -> Result<ExportInfo, ErrorCode> {
        Ok(self
            .submit_mode(directory, connection, log_id, request_id, Mode::Normal)?
            .0)
    }
    fn submit_mode(
        &self,
        directory: PathBuf,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        mode: Mode,
    ) -> Result<Receipt, ErrorCode> {
        let mut entries = self.entries.lock().map_err(|_| ErrorCode::InvalidState)?;
        if let Some(entry) = entries.items.get(&request_id) {
            return if entry.info.connection == connection
                && entry.info.log_id == log_id
                && entry.mode == mode
            {
                Ok((entry.info.clone(), entry.recovery.clone()))
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        entries.window.check(request_id)?;
        if entries.items.len() >= RECEIPTS {
            let (old, stamp) = entries
                .items
                .iter()
                .filter(|(_, entry)| {
                    matches!(entry.info.phase, P::Removed | P::Failed | P::Cancelled)
                })
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            entries.items.remove(&old);
            entries.window.retire(stamp);
            entries.window.check(request_id)?;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let info = ExportInfo {
            connection,
            log_id,
            request_id,
            phase: P::Queued,
            failure: None,
            bytes: None,
            sha256: None,
            retained_records: None,
            retained_raw_bytes: None,
            retained_gap_bytes: None,
            next_cursor: None,
        };
        // Holding only the receipt mutex: try_send never waits on disk or queue.
        self.sender
            .try_send(Job {
                mode,
                directory,
                connection,
                log_id,
                request_id,
                cancel: cancel.clone(),
            })
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
                _ => ErrorCode::InvalidState,
            })?;
        entries.items.insert(
            request_id,
            Entry {
                mode,
                recovery: None,
                info: info.clone(),
                cancel,
            },
        );
        Ok((info, None))
    }
    pub(super) fn status(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        cancel: bool,
    ) -> Result<ExportInfo, ErrorCode> {
        Ok(self
            .status_mode(connection, log_id, request_id, cancel, Mode::Normal)?
            .0)
    }
    fn status_mode(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        cancel: bool,
        mode: Mode,
    ) -> Result<Receipt, ErrorCode> {
        let mut entries = self.entries.lock().map_err(|_| ErrorCode::InvalidState)?;
        if !entries.items.contains_key(&request_id) {
            entries.window.check(request_id)?;
        }
        let entry = entries
            .items
            .get_mut(&request_id)
            .ok_or(ErrorCode::NotFound)?;
        if entry.info.connection != connection || entry.info.log_id != log_id || entry.mode != mode
        {
            return Err(ErrorCode::InvalidArgument);
        }
        if cancel && !terminal(entry.info.phase) {
            entry.cancel.store(true, Ordering::Release);
            entry.info.phase = P::Cancelling;
        }
        Ok((entry.info.clone(), entry.recovery.clone()))
    }
    pub(super) fn recovery_duplicate(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    ) -> Result<Option<wire::RecoveryExportInfo>, ErrorCode> {
        Ok(self
            .duplicate_mode(connection, log_id, request_id, Mode::Recovery)?
            .map(recovery_info))
    }
    pub(super) fn recovery_submit(
        &self,
        directory: PathBuf,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    ) -> Result<wire::RecoveryExportInfo, ErrorCode> {
        self.submit_mode(directory, connection, log_id, request_id, Mode::Recovery)
            .map(recovery_info)
    }
    pub(super) fn recovery_status(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        cancel: bool,
    ) -> Result<wire::RecoveryExportInfo, ErrorCode> {
        self.status_mode(connection, log_id, request_id, cancel, Mode::Recovery)
            .map(recovery_info)
    }
    pub(super) async fn close(self) -> io::Result<()> {
        {
            let entries = self
                .entries
                .lock()
                .map_err(|_| io::Error::other("export state poisoned"))?;
            for entry in entries.items.values() {
                entry.cancel.store(true, Ordering::Release);
            }
        }
        drop(self.sender);
        tokio::task::spawn_blocking(move || self.thread.join())
            .await
            .map_err(|_| io::Error::other("export cleanup task failed"))?
            .map_err(|_| io::Error::other("export worker failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn mixed_modes_share_queue_and_reject_cross_mode_duplicates_queries_and_cancellation() {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-export-mode-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let worker_gate = gate.clone();
        let worker = Worker::spawn(move || {
            worker_gate.wait();
        })
        .unwrap();
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 3,
        };
        let log_id = Uuid::new_v4();
        let ids: Vec<_> = (0..8).map(|_| Uuid::new_v4()).collect();
        for (n, id) in ids.iter().enumerate() {
            if n % 2 == 0 {
                worker
                    .submit(path.clone(), connection, log_id, *id)
                    .unwrap();
            } else {
                let info = worker
                    .recovery_submit(path.clone(), connection, log_id, *id)
                    .unwrap();
                assert!(info.incomplete);
                assert!(info.recovered.is_none());
            }
        }
        assert_eq!(
            worker
                .recovery_submit(path.clone(), connection, log_id, Uuid::new_v4())
                .unwrap_err(),
            ErrorCode::CapacityExceeded
        );
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, Uuid::new_v4())
                .unwrap_err(),
            ErrorCode::CapacityExceeded
        );
        for (n, id) in ids.iter().enumerate() {
            if n % 2 == 0 {
                assert_eq!(
                    worker
                        .recovery_duplicate(connection, log_id, *id)
                        .unwrap_err(),
                    ErrorCode::InvalidArgument
                );
                assert_eq!(
                    worker
                        .recovery_status(connection, log_id, *id, true)
                        .unwrap_err(),
                    ErrorCode::InvalidArgument
                );
                assert_eq!(
                    worker
                        .recovery_submit(path.clone(), connection, log_id, *id)
                        .unwrap_err(),
                    ErrorCode::InvalidArgument
                );
                assert_eq!(
                    worker.status(connection, log_id, *id, false).unwrap().phase,
                    P::Queued
                );
            } else {
                assert_eq!(
                    worker.duplicate(connection, log_id, *id).unwrap_err(),
                    ErrorCode::InvalidArgument
                );
                assert_eq!(
                    worker.status(connection, log_id, *id, true).unwrap_err(),
                    ErrorCode::InvalidArgument
                );
                assert_eq!(
                    worker
                        .submit(path.clone(), connection, log_id, *id)
                        .unwrap_err(),
                    ErrorCode::InvalidArgument
                );
                assert_eq!(
                    worker
                        .recovery_status(connection, log_id, *id, false)
                        .unwrap()
                        .phase,
                    P::Queued
                );
            }
        }
        worker
            .recovery_status(connection, log_id, ids[1], true)
            .unwrap();
        gate.wait();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if ids
                    .iter()
                    .all(|id| terminal(worker.entries.lock().unwrap().items[id].info.phase))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let cancelled = worker
            .recovery_status(connection, log_id, ids[1], false)
            .unwrap();
        assert_eq!(cancelled.phase, P::Cancelled);
        assert!(cancelled.incomplete);
        assert!(cancelled.bytes.is_none() && cancelled.recovered.is_none());
        assert_eq!(
            worker
                .recovery_submit(path.clone(), connection, log_id, ids[1])
                .unwrap()
                .phase,
            P::Cancelled
        );
        worker.close().await.unwrap();
        assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-export-mode-中文-")
        );
        std::fs::remove_dir_all(path).unwrap();
    }
    #[tokio::test]
    async fn retired_removed_and_failed_ordered_receipts_cannot_recreate_jobs_while_opaque_receipts_remain()
     {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-export-window-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        let worker = Worker::start().unwrap();
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let log_id = Uuid::new_v4();
        let ordered =
            |stamp: u64| Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | 1);
        let opaque = Uuid::new_v4();
        {
            let mut registry = worker.entries.lock().unwrap();
            for id in (1..64).map(ordered).chain([opaque]) {
                registry.items.insert(
                    id,
                    Entry {
                        mode: Mode::Normal,
                        recovery: None,
                        info: ExportInfo {
                            connection,
                            log_id,
                            request_id: id,
                            phase: if id == ordered(1) {
                                P::Failed
                            } else {
                                P::Removed
                            },
                            failure: if id == ordered(1) {
                                Some(F::InvalidSource)
                            } else {
                                None
                            },
                            bytes: None,
                            sha256: None,
                            retained_records: None,
                            retained_raw_bytes: None,
                            retained_gap_bytes: None,
                            next_cursor: None,
                        },
                        cancel: Arc::new(AtomicBool::new(false)),
                    },
                );
            }
        }
        worker
            .submit(path.clone(), connection, log_id, ordered(100))
            .unwrap();
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, ordered(1))
                .unwrap_err(),
            ErrorCode::RequestExpired
        );
        assert_eq!(
            worker
                .status(connection, log_id, ordered(1), false)
                .unwrap_err(),
            ErrorCode::RequestExpired
        );
        assert_eq!(
            worker
                .duplicate(connection, Uuid::new_v4(), ordered(1))
                .unwrap_err(),
            ErrorCode::RequestExpired
        );
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, opaque)
                .unwrap()
                .phase,
            P::Removed
        );
        worker.close().await.unwrap();
        assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-export-window-中文-")
        );
        std::fs::remove_dir_all(path).unwrap();
    }
    #[tokio::test]
    async fn queued_cancel_dedup_scope_queue_and_receipt_bounds_are_nonblocking() {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-export-中文-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let worker_gate = gate.clone();
        let worker = Worker::spawn(move || {
            worker_gate.wait();
        })
        .unwrap();
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let log_id = Uuid::new_v4();
        let mut ids = Vec::new();
        for _ in 0..8 {
            let id = Uuid::new_v4();
            assert_eq!(
                worker
                    .submit(path.clone(), connection, log_id, id)
                    .unwrap()
                    .phase,
                P::Queued
            );
            ids.push(id);
        }
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, Uuid::new_v4())
                .unwrap_err(),
            ErrorCode::CapacityExceeded
        );
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, ids[0])
                .unwrap()
                .phase,
            P::Queued
        );
        let wrong = ConnectionRef {
            generation: 2,
            ..connection
        };
        assert_eq!(
            worker.status(wrong, log_id, ids[0], true).unwrap_err(),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            worker
                .duplicate(connection, Uuid::new_v4(), ids[0])
                .unwrap_err(),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            worker
                .status(connection, log_id, ids[0], true)
                .unwrap()
                .phase,
            P::Cancelling
        );
        gate.wait();
        let settled = |id| worker.status(connection, log_id, id, false).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while ids.iter().any(|id| !terminal(settled(*id).phase)) {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(settled(ids[0]).phase, P::Cancelled);
        assert!(settled(ids[0]).failure.is_none());
        assert!(settled(ids[0]).bytes.is_none());
        assert!(
            !path
                .join("terminal-log-exports")
                .join(ids[0].to_string())
                .exists()
        );
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, ids[0])
                .unwrap()
                .phase,
            P::Cancelled
        );
        for _ in 8..RECEIPTS {
            let id = Uuid::new_v4();
            worker.submit(path.clone(), connection, log_id, id).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !terminal(settled(id).phase) {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(settled(id).failure, Some(F::InvalidSource));
        }
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, Uuid::new_v4())
                .unwrap_err(),
            ErrorCode::CapacityExceeded
        );
        // Full receipt window retains cancelled IDs rather than reviving them.
        assert_eq!(
            worker
                .submit(path.clone(), connection, log_id, ids[0])
                .unwrap()
                .phase,
            P::Cancelled
        );
        worker.close().await.unwrap();
        assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-export-中文-")
        );
        std::fs::remove_dir_all(path).unwrap();
    }
}
