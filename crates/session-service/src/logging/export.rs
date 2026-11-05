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
use terminal_log::{ExportArtifact, ExportStore, ManagedRoot};
use wire::{ExportFailure as F, ExportInfo, ExportPhase as P};

const RECEIPTS: usize = 64;
struct Entry {
    info: ExportInfo,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
struct Registry {
    items: HashMap<Uuid, Entry>,
    window: RequestWindow,
}
type Entries = Arc<Mutex<Registry>>;
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
                        || -> io::Result<ExportArtifact> {
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
                            store.as_mut().unwrap().1.create(
                                &root,
                                job.log_id,
                                job.connection,
                                job.request_id,
                                || job.cancel.load(Ordering::Acquire),
                            )
                        },
                    ));
                    let mut entries = shared.lock().unwrap_or_else(|e| e.into_inner());
                    let info = &mut entries.items.get_mut(&job.request_id).unwrap().info;
                    match result {
                        Ok(Ok(artifact)) => {
                            // Publication wins a concurrent late cancel; never report
                            // cancellation as if an already-created file disappeared.
                            info.phase = P::Completed;
                            info.bytes = Some(artifact.bytes);
                            info.sha256 = Some(
                                artifact
                                    .sha256
                                    .iter()
                                    .map(|byte| format!("{byte:02x}"))
                                    .collect(),
                            );
                            info.retained_records = Some(artifact.summary.retained_records);
                            info.retained_raw_bytes = Some(artifact.summary.retained_raw_bytes);
                            info.retained_gap_bytes = Some(artifact.summary.retained_gap_bytes);
                            info.next_cursor = Some(artifact.summary.next_cursor);
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
        let entries = self.entries.lock().map_err(|_| ErrorCode::InvalidState)?;
        if !entries.items.contains_key(&request_id) {
            entries.window.check(request_id)?;
        }
        entries
            .items
            .get(&request_id)
            .map(|entry| {
                if entry.info.connection != connection || entry.info.log_id != log_id {
                    Err(ErrorCode::InvalidArgument)
                } else {
                    Ok(entry.info.clone())
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
        let mut entries = self.entries.lock().map_err(|_| ErrorCode::InvalidState)?;
        if let Some(entry) = entries.items.get(&request_id) {
            return if entry.info.connection == connection && entry.info.log_id == log_id {
                Ok(entry.info.clone())
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
                info: info.clone(),
                cancel,
            },
        );
        Ok(info)
    }
    pub(super) fn status(
        &self,
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
        cancel: bool,
    ) -> Result<ExportInfo, ErrorCode> {
        let mut entries = self.entries.lock().map_err(|_| ErrorCode::InvalidState)?;
        if !entries.items.contains_key(&request_id) {
            entries.window.check(request_id)?;
        }
        let entry = entries
            .items
            .get_mut(&request_id)
            .ok_or(ErrorCode::NotFound)?;
        if entry.info.connection != connection || entry.info.log_id != log_id {
            return Err(ErrorCode::InvalidArgument);
        }
        if cancel && !terminal(entry.info.phase) {
            entry.cancel.store(true, Ordering::Release);
            entry.info.phase = P::Cancelling;
        }
        Ok(entry.info.clone())
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
