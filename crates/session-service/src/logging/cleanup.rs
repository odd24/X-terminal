//! Bounded cleanup snapshots on a dedicated file actor. No terminal lock is held
//! while inspecting/deleting. Registry invalidation belongs to this actor so a
//! lost response or cancelled caller future cannot skip it after deletion.
use super::*;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use terminal_log::{CleanupPreview, ManagedRoot};
use tokio::sync::oneshot;
use wire::{CleanupKind as K, CleanupPhase as P};

const PREVIEWS: usize = 4;
const RECEIPTS: usize = 128;
const TTL: Duration = Duration::from_secs(30);
struct Message {
    directory: Option<PathBuf>,
    request: Request,
    reply: oneshot::Sender<Result<Reply, ErrorCode>>,
    _pending: Option<Pending>,
}
struct Pending(Arc<AtomicUsize>);
impl Pending {
    fn new(count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self(count)
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(super) struct Worker {
    sender: mpsc::SyncSender<Message>,
    thread: thread::JoinHandle<()>,
    reserved: Arc<AtomicBool>,
    pending: Arc<AtomicUsize>,
}
impl Worker {
    pub(super) fn start(
        inner: Arc<Mutex<Inner>>,
        exports: export::Access,
        store: Arc<Mutex<Store>>,
    ) -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Message>(8);
        let reserved = Arc::new(AtomicBool::new(false));
        let signal = reserved.clone();
        let thread = thread::Builder::new()
            .name("terminal-log-cleanup".into())
            .spawn(move || {
                let mut state = State {
                    entries: HashMap::new(),
                    window: RequestWindow::default(),
                    reserved: signal,
                    inner,
                    exports,
                    store,
                };
                loop {
                    state.reap(Instant::now());
                    let message = match receiver.recv_timeout(Duration::from_millis(200)) {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    // Accepted commits execute even if the response receiver goes
                    // away. Their receipt and registry changes remain authoritative.
                    let result = state.handle(message.directory, message.request, Instant::now());
                    let _ = message.reply.send(result);
                }
            })?;
        Ok(Self {
            sender,
            thread,
            reserved,
            pending: Arc::new(AtomicUsize::new(0)),
        })
    }
    pub(super) fn reserved(&self) -> bool {
        self.pending.load(Ordering::Acquire) != 0 || self.reserved.load(Ordering::Acquire)
    }
    pub(super) async fn request(
        &self,
        directory: Option<PathBuf>,
        request: Request,
    ) -> Result<Reply, ErrorCode> {
        let (reply, receiver) = oneshot::channel();
        // Reserve before enqueue, not only after the file actor opens handles.
        // This intent survives cancellation of the awaiting client future.
        let pending = matches!(request, Request::CleanupPreview { .. })
            .then(|| Pending::new(self.pending.clone()));
        self.sender
            .try_send(Message {
                directory,
                request,
                reply,
                _pending: pending,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
                _ => ErrorCode::InvalidState,
            })?;
        receiver.await.map_err(|_| ErrorCode::InvalidState)?
    }
    pub(super) async fn close(self) -> io::Result<()> {
        drop(self.sender);
        tokio::task::spawn_blocking(move || self.thread.join())
            .await
            .map_err(|_| io::Error::other("cleanup join task failed"))?
            .map_err(|_| io::Error::other("cleanup worker failed"))
    }
}
struct Entry {
    info: wire::CleanupInfo,
    snapshot: Option<CleanupPreview>,
    confirmation: Uuid,
    deadline: Instant,
}
struct State {
    entries: HashMap<Uuid, Entry>,
    window: RequestWindow,
    reserved: Arc<AtomicBool>,
    inner: Arc<Mutex<Inner>>,
    exports: export::Access,
    store: Arc<Mutex<Store>>,
}
fn file_error(error: io::Error) -> ErrorCode {
    if error.kind() == io::ErrorKind::NotFound {
        ErrorCode::NotFound
    } else {
        ErrorCode::InvalidState
    }
}
fn reply(entry: &Entry) -> Reply {
    Reply::Cleanup(Box::new(entry.info.clone()))
}
impl State {
    fn signal(&self) {
        self.reserved.store(
            self.entries.values().any(|entry| entry.snapshot.is_some()),
            Ordering::Release,
        );
    }
    fn reap(&mut self, now: Instant) {
        for entry in self.entries.values_mut() {
            if entry.snapshot.is_some() && now >= entry.deadline {
                entry.snapshot = None;
                entry.info.phase = P::Expired;
                entry.info.confirmation = None;
            }
        }
        self.signal();
    }
    fn reserve(&mut self, id: Uuid) -> Result<(), ErrorCode> {
        self.window.check(id)?;
        if self.entries.len() >= RECEIPTS {
            let (old, stamp) = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.snapshot.is_none())
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            self.entries.remove(&old);
            self.window.retire(stamp);
            self.window.check(id)?;
        }
        Ok(())
    }
    fn entry(&mut self, preview_id: Uuid, kind: K, id: Uuid) -> Result<&mut Entry, ErrorCode> {
        if !self.entries.contains_key(&preview_id) {
            self.window.check(preview_id)?;
        }
        let entry = self
            .entries
            .get_mut(&preview_id)
            .ok_or(ErrorCode::NotFound)?;
        if entry.info.kind != kind || entry.info.id != id {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(entry)
    }
    fn handle(
        &mut self,
        directory: Option<PathBuf>,
        request: Request,
        now: Instant,
    ) -> Result<Reply, ErrorCode> {
        self.reap(now);
        match request {
            Request::CleanupList { kind } => {
                let path = directory.ok_or(ErrorCode::InvalidState)?;
                let ids = match kind {
                    K::Log => ManagedRoot::open(&path).and_then(|root| root.ids()),
                    K::Export => CleanupPreview::export_ids(&path),
                }
                .map_err(file_error)?;
                Ok(Reply::CleanupList { kind, ids })
            }
            Request::CleanupPreview {
                kind,
                id,
                preview_id,
            } => {
                if self.entries.contains_key(&preview_id) {
                    return Ok(reply(self.entry(preview_id, kind, id)?));
                }
                if self
                    .entries
                    .values()
                    .filter(|entry| entry.snapshot.is_some())
                    .count()
                    >= PREVIEWS
                {
                    return Err(ErrorCode::CapacityExceeded);
                }
                self.reserve(preview_id)?;
                if self.exports.busy()? {
                    return Err(ErrorCode::InvalidState);
                }
                if kind == K::Log
                    && self
                        .inner
                        .lock()
                        .map_err(|_| ErrorCode::InvalidState)?
                        .entries
                        .get(&id)
                        .is_some_and(|entry| !entry.logger.status().worker_finished)
                {
                    return Err(ErrorCode::InvalidState);
                }
                let path = directory.ok_or(ErrorCode::InvalidState)?;
                let snapshot = match kind {
                    K::Log => ManagedRoot::open(&path).and_then(|root| root.preview_cleanup(id)),
                    K::Export => CleanupPreview::export(&path, id),
                }
                .map_err(file_error)?;
                let confirmation = Uuid::new_v4();
                let remaining = TTL
                    .checked_sub(Instant::now().saturating_duration_since(now))
                    .filter(|duration| !duration.is_zero())
                    .ok_or(ErrorCode::RequestExpired)?;
                let expires_at_ms = u64::try_from(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| ErrorCode::InvalidState)?
                        .as_millis(),
                )
                .ok()
                .and_then(|millis| millis.checked_add(remaining.as_millis() as u64))
                .ok_or(ErrorCode::InvalidState)?;
                let info = wire::CleanupInfo {
                    kind,
                    id,
                    preview_id,
                    phase: P::Preview,
                    expires_at_ms,
                    confirmation: Some(confirmation),
                    files: snapshot
                        .info()
                        .files
                        .iter()
                        .map(|file| wire::CleanupFile {
                            name: file.name.clone(),
                            bytes: file.bytes,
                        })
                        .collect(),
                    logical_bytes: snapshot.info().logical_bytes,
                    report: None,
                };
                self.entries.insert(
                    preview_id,
                    Entry {
                        info,
                        snapshot: Some(snapshot),
                        confirmation,
                        deadline: now + TTL,
                    },
                );
                self.signal();
                Ok(reply(&self.entries[&preview_id]))
            }
            Request::CleanupStatus {
                kind,
                id,
                preview_id,
            } => Ok(reply(self.entry(preview_id, kind, id)?)),
            Request::CleanupCancel {
                kind,
                id,
                preview_id,
            } => {
                let entry = self.entry(preview_id, kind, id)?;
                if entry.snapshot.take().is_some() {
                    entry.info.phase = P::Cancelled;
                    entry.info.confirmation = None;
                }
                let response = reply(entry);
                self.signal();
                Ok(response)
            }
            Request::CleanupCommit {
                kind,
                id,
                preview_id,
                confirmation,
            } => {
                let entry = self.entry(preview_id, kind, id)?;
                if entry.confirmation != confirmation {
                    return Err(ErrorCode::InvalidArgument);
                }
                if entry.info.phase == P::Applied {
                    return Ok(reply(entry));
                }
                let snapshot = entry.snapshot.take().ok_or(ErrorCode::RequestExpired)?;
                let result = snapshot.apply();
                let changed = result.removed_files != 0 || result.directory_removed;
                entry.info.phase = P::Applied;
                entry.info.confirmation = None;
                entry.info.report = Some(wire::CleanupReport {
                    removed_files: result.removed_files,
                    removed_logical_bytes: result.removed_logical_bytes,
                    directory_removed: result.directory_removed,
                    failure: result.failure.map(|failure| match failure {
                        terminal_log::CleanupFailure::Changed => wire::CleanupFailure::Changed,
                        terminal_log::CleanupFailure::Storage => wire::CleanupFailure::Storage,
                    }),
                    os_code: result.os_code,
                });
                let response = reply(entry);
                if changed {
                    match kind {
                        K::Log => {
                            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(connection) = inner
                                .entries
                                .get(&id)
                                .map(|entry| entry.metadata.connection)
                            {
                                inner.removed.insert(id);
                                // Failed capture workers may have left their sink
                                // attached. Detach only this exact old capture,
                                // never another recording in the same generation.
                                let mut store =
                                    self.store.lock().unwrap_or_else(|e| e.into_inner());
                                if store.sessions.capture_id(connection).ok().flatten() == Some(id)
                                {
                                    let _ = store.sessions.detach_capture(connection, id);
                                }
                            }
                        }
                        K::Export => self.exports.mark_removed(id),
                    }
                }
                self.signal();
                Ok(response)
            }
            _ => Err(ErrorCode::InvalidArgument),
        }
    }
}

#[cfg(test)]
mod tests;
