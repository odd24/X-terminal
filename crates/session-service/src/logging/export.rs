//! Dedicated bounded export worker. Status/cancel never wait on filesystem I/O.
use super::*;
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
type Entries = Arc<Mutex<HashMap<Uuid, Entry>>>;
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
    matches!(phase, P::Completed | P::Cancelled | P::Failed)
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
                        let entry = entries.get_mut(&job.request_id).unwrap();
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
                    let info = &mut entries.get_mut(&job.request_id).unwrap().info;
                    match result {
                        Ok(Ok(artifact)) => {
                            // Publication wins a concurrent late cancel; never report
                            // cancellation as if an already-created file disappeared.
                            info.phase = P::Completed;
                            info.bytes = Some(artifact.bytes);
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
        entries
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
        if let Some(entry) = entries.get(&request_id) {
            return if entry.info.connection == connection && entry.info.log_id == log_id {
                Ok(entry.info.clone())
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        if entries.len() >= RECEIPTS {
            return Err(ErrorCode::CapacityExceeded);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let info = ExportInfo {
            connection,
            log_id,
            request_id,
            phase: P::Queued,
            failure: None,
            bytes: None,
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
        entries.insert(
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
        let entry = entries.get_mut(&request_id).ok_or(ErrorCode::NotFound)?;
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
            for entry in entries.values() {
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
