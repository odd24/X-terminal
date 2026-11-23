//! Opt-in bounded journals. Callers must authorize and route an exact generation.
macro_rules! timeline_io {
    ($operation:ident, $watermark:expr, $action:expr) => {{
        #[cfg(feature = "log-timeline-fixture")]
        {
            crate::timeline_fixture::observe_io(
                crate::timeline_fixture::Operation::$operation,
                $watermark,
                || $action,
            )
        }
        #[cfg(not(feature = "log-timeline-fixture"))]
        {
            $action
        }
    }};
}
mod archive;
#[cfg(windows)]
pub mod audit;
#[cfg(windows)]
mod cleanup;
#[cfg(windows)]
pub mod close_store;
#[cfg(all(windows, feature = "log-disk-full-fixture"))]
pub mod disk_full_fixture;
#[cfg(feature = "log-timeline-fixture")]
pub mod timeline_fixture;
#[cfg(windows)]
pub use close_store::save_recovery;
mod directory;
mod export;
mod export_store;
#[cfg(windows)]
mod verified_export;
#[cfg(windows)]
pub use verified_export::{ExportFingerprint, VerifiedExport};
#[cfg(windows)]
mod selected_save;
#[cfg(windows)]
pub use selected_save::{SaveCheckpoint, SaveReport, SaveTarget};
#[cfg(all(windows, feature = "save-recovery-fixture"))]
pub use selected_save::{SaveFaultPoint, SaveFixtureFault};
mod format;
mod paired;
mod recovery;
mod recovery_export;
pub use recovery::{RecoveryInfo, RecoveryPage, RecoveryReader, RecoveryStop, RecoveryStopKind};
pub use recovery_export::{RecoverySummary, export_recovery_jsonl};
mod live_text;
pub mod location;
mod user_file;
pub use user_file::{ReadableSnapshot, UserLogDirectory, UserLogFile};
mod storage;
pub use archive::{ArchiveInfo, ArchivePage, ArchiveReader, Completion};
#[cfg(windows)]
pub use cleanup::{
    CleanupFailure, CleanupFile, CleanupInfo, CleanupKind, CleanupPreview, CleanupReport,
};
pub use directory::ManagedRoot;
pub use export::{ExportSummary, export_jsonl};
pub use export_store::{ExportArtifact, ExportStore, MAX_EXPORT_BYTES, RecoveryArtifact};
pub use format::{RawFrame, RawReader, SegmentHeader};
pub use live_text::{ReadableStatus, readable_stem, safe_window_name};
pub use paired::PairReader;
use serde::{Deserialize, Serialize};
use session_core::{presentation::TextEvent, session::*};
use std::{
    io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{self, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
};
use uuid::Uuid;

pub const QUEUE_RECORDS: usize = 32;
const MAX_TEXT: usize = 16 * 1024;
const MAX_WORKERS: usize = 64;
static WORKERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub encoding: String,
    pub started_at_ms: u64,
    pub source_cursor: u64,
    pub text_cursor: u64,
}
impl Metadata {
    fn valid(&self) -> bool {
        self.connection.generation > 0
            && !self.connection.connection_id.0.is_nil()
            && self.source_cursor > 0
            && self.text_cursor > 0
            && matches!(self.encoding.as_str(), "utf-8" | "gbk" | "gb18030")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    /// Combined raw + text bytes per segment, including both headers.
    pub segment_bytes: u64,
    pub segments: u32,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            segment_bytes: 100 * 1024 * 1024,
            segments: 5,
        }
    }
}
impl Limits {
    fn valid(self) -> bool {
        (128 * 1024..=100 * 1024 * 1024).contains(&self.segment_bytes)
            && (1..=16).contains(&self.segments)
    }
}

#[derive(Clone)]
pub struct Record {
    pub connection: ConnectionRef,
    pub raw: Option<OutputEvent>,
    pub text: TextEvent,
}
impl std::fmt::Debug for Record {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Record([TERMINAL_CONTENT])")
    }
}
impl Record {
    fn raw_bytes(&self) -> u64 {
        self.raw.as_ref().map_or(0, |r| r.bytes.len() as u64)
    }
    fn valid(&self, metadata: &Metadata, source: u64, text: u64) -> bool {
        if self.connection != metadata.connection
            || self.text.seq != text
            || self.text.text.len() > MAX_TEXT
        {
            return false;
        }
        match &self.raw {
            Some(raw) => {
                raw.seq == source
                    && self.text.source_seq == Some(source)
                    && raw.timestamp_ms == self.text.timestamp_ms
                    && raw.gap_bytes == self.text.gap_bytes
                    && match raw.gap_bytes {
                        Some(lost) => {
                            lost > 0
                                && raw.bytes.is_empty()
                                && self.text.text.is_empty()
                                && !self.text.decode_error
                        }
                        None => !raw.bytes.is_empty() && raw.bytes.len() <= EVENT_BYTES,
                    }
            }
            None => self.text.source_seq.is_none() && self.text.gap_bytes.is_none(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Phase {
    Opening,
    Recording,
    Stopping,
    Stopped,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    QueueFull,
    InvalidRecord,
    CounterExhausted,
    Capacity,
    DiskFull,
    Storage,
    WorkerPanicked,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub readable: Option<ReadableStatus>,
    pub phase: Phase,
    pub failure: Option<Failure>,
    pub accepted_records: u64,
    pub written_records: u64,
    pub accepted_raw_bytes: u64,
    pub written_raw_bytes: u64,
    pub rejected_records: u64,
    pub rejected_raw_bytes: u64,
    pub source_gap_bytes: u64,
    pub first_retained_segment: u64,
    pub last_segment: u64,
    pub retired_segments: u64,
    pub natural_end: bool,
    pub durable: bool,
    pub worker_finished: bool,
}
struct Shared {
    #[cfg(feature = "log-timeline-fixture")]
    timeline: Option<timeline_fixture::Context>,
    sender: Option<SyncSender<Record>>,
    status: Status,
    source_cursor: u64,
    text_cursor: u64,
}
impl Shared {
    #[cfg(feature = "log-timeline-fixture")]
    fn trace_queue(&self, seq: u64, event: timeline_fixture::Kind) {
        if let Some(context) = &self.timeline {
            context.record(
                seq,
                event,
                Some(self.status.accepted_records),
                Some(self.status.written_records),
            );
        }
    }
    fn fail(&mut self, failure: Failure) {
        self.status.failure.get_or_insert(failure);
        self.status.phase = Phase::Failed;
        self.sender.take();
    }
    fn reject(&mut self, record: &Record) {
        self.status.rejected_records = self.status.rejected_records.saturating_add(1);
        self.status.rejected_raw_bytes = self
            .status
            .rejected_raw_bytes
            .saturating_add(record.raw_bytes());
    }
}
struct Permit;
impl Permit {
    fn acquire() -> io::Result<Self> {
        use std::sync::atomic::Ordering::Relaxed;
        WORKERS
            .try_update(Relaxed, Relaxed, |count| {
                (count < MAX_WORKERS).then_some(count + 1)
            })
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "journal worker capacity"))?;
        Ok(Self)
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        WORKERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}
pub struct Logger {
    metadata: Metadata,
    shared: Arc<Mutex<Shared>>,
    thread: Option<JoinHandle<()>>,
}
trait Journal: Send {
    #[cfg(test)]
    fn test_first_sync_advance(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }

    #[cfg(any(test, all(windows, feature = "log-timeline-fixture")))]
    fn periodic_checkpoint(&mut self, sync: bool) -> io::Result<()> {
        self.checkpoint(sync)
    }

    fn checkpoint(&mut self, _sync: bool) -> io::Result<()> {
        Ok(())
    }
    fn readable(&self) -> Option<ReadableStatus> {
        None
    }
    fn append(&mut self, record: &Record) -> io::Result<(u64, u64)>;
    fn finish(&mut self, status: &Status) -> io::Result<()>;
}
fn failure(error: &io::Error) -> Failure {
    if error.kind() == io::ErrorKind::FileTooLarge {
        return Failure::Capacity;
    }
    if error.kind() == io::ErrorKind::StorageFull
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(39 | 112)))
    {
        Failure::DiskFull
    } else {
        Failure::Storage
    }
}
impl Logger {
    /// Creates only a fresh UUID child below an existing local root. Opening occurs
    /// on the worker: successful submission means queued, never durable storage.
    pub fn start(root: PathBuf, metadata: Metadata, limits: Limits) -> io::Result<Self> {
        if !root.is_absolute() || !metadata.valid() || !limits.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid journal setup",
            ));
        }
        Self::spawn(metadata, move |id, metadata| {
            Ok(Box::new(storage::FileJournal::open(
                root, id, metadata, limits,
            )?))
        })
    }
    pub fn start_readable(
        root: PathBuf,
        metadata: Metadata,
        limits: Limits,
        window_name: String,
    ) -> io::Result<Self> {
        if !root.is_absolute() || !metadata.valid() || !limits.valid() || window_name.len() > 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid readable setup",
            ));
        }
        Self::spawn(metadata, move |id, metadata| {
            Ok(Box::new(storage::FileJournal::open_readable(
                root,
                id,
                metadata,
                limits,
                &window_name,
            )?))
        })
    }
    pub fn start_registered_readable(
        root: PathBuf,
        metadata: Metadata,
        limits: Limits,
        window_name: String,
        directory: (Option<String>, UserLogDirectory),
    ) -> io::Result<Self> {
        if !root.is_absolute() || !metadata.valid() || !limits.valid() || window_name.len() > 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid readable setup",
            ));
        }
        Self::spawn(metadata, move |id, metadata| {
            Ok(Box::new(storage::FileJournal::open_registered(
                root,
                id,
                metadata,
                limits,
                &window_name,
                directory,
            )?))
        })
    }
    fn spawn(
        metadata: Metadata,
        factory: impl FnOnce(Uuid, Metadata) -> io::Result<Box<dyn Journal>> + Send + 'static,
    ) -> io::Result<Self> {
        let permit = Permit::acquire()?;
        let id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(QUEUE_RECORDS);
        #[cfg(feature = "log-timeline-fixture")]
        let timeline = timeline_fixture::logger_context();
        let shared = Arc::new(Mutex::new(Shared {
            #[cfg(feature = "log-timeline-fixture")]
            timeline: timeline.clone(),
            sender: Some(sender),
            source_cursor: metadata.source_cursor,
            text_cursor: metadata.text_cursor,
            status: Status {
                log_id: id,
                connection: metadata.connection,
                readable: None,
                phase: Phase::Opening,
                failure: None,
                accepted_records: 0,
                written_records: 0,
                accepted_raw_bytes: 0,
                written_raw_bytes: 0,
                rejected_records: 0,
                rejected_raw_bytes: 0,
                source_gap_bytes: 0,
                first_retained_segment: 1,
                last_segment: 1,
                retired_segments: 0,
                natural_end: false,
                durable: false,
                worker_finished: false,
            },
        }));
        let state = shared.clone();
        let header = metadata.clone();
        let thread = thread::Builder::new()
            .name("terminal-journal".into())
            .spawn(move || {
                #[cfg(feature = "log-timeline-fixture")]
                let _timeline = timeline_fixture::install(timeline);
                let _permit = permit;
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> io::Result<()> {
                        let mut journal = factory(id, header)?;
                        {
                            let mut state = state.lock().unwrap();
                            state.status.readable = journal.readable();
                            if state.status.phase == Phase::Opening {
                                state.status.phase = Phase::Recording;
                            }
                        }
                        #[cfg(test)]
                        let first_sync_advance = journal.test_first_sync_advance();
                        let mut flushed = std::time::Instant::now();
                        let mut synced = flushed;
                        #[cfg(test)]
                        {
                            synced -= first_sync_advance;
                        }
                        loop {
                            match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                                Ok(record) => {
                                    #[cfg(feature = "log-timeline-fixture")]
                                    timeline_fixture::dequeued(record.text.seq);
                                    let (first, last) = journal.append(&record)?;
                                    let mut state = state.lock().unwrap();
                                    state.status.written_records += 1;
                                    state.status.written_raw_bytes += record.raw_bytes();
                                    state.status.first_retained_segment = first;
                                    state.status.last_segment = last;
                                    state.status.retired_segments = first - 1;
                                    state.status.readable = journal.readable();
                                }
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                            }
                            if flushed.elapsed() >= std::time::Duration::from_millis(100) {
                                let sync = synced.elapsed() >= std::time::Duration::from_secs(1);
                                #[cfg(any(test, all(windows, feature = "log-timeline-fixture")))]
                                journal.periodic_checkpoint(sync)?;
                                #[cfg(not(any(
                                    test,
                                    all(windows, feature = "log-timeline-fixture")
                                )))]
                                journal.checkpoint(sync)?;
                                state.lock().unwrap().status.readable = journal.readable();
                                flushed = std::time::Instant::now();
                                if sync {
                                    synced = flushed;
                                }
                            }
                        }
                        journal.checkpoint(true)?;
                        state.lock().unwrap().status.readable = journal.readable();
                        let status = state.lock().unwrap().status.clone();
                        // A latched queue/validation fault must never publish a clean marker.
                        if status.failure.is_none() {
                            journal.finish(&status)?;
                            state.lock().unwrap().status.readable = journal.readable();
                        }
                        // Release the writer and directory pins before publishing the
                        // terminal phase. Only the captured file identity survives.
                        drop(journal);
                        Ok(())
                    }));
                let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
                #[cfg(feature = "log-timeline-fixture")]
                if !matches!(&result, Ok(Ok(()))) {
                    timeline_fixture::worker_failed();
                }
                match result {
                    Ok(Ok(())) if state.status.failure.is_none() => {
                        state.status.phase = Phase::Stopped;
                        state.status.durable = true;
                    }
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => state.fail(failure(&error)),
                    Err(_) => state.fail(Failure::WorkerPanicked),
                }
                state.sender.take();
                state.status.worker_finished = true;
            })?;
        Ok(Self {
            metadata,
            shared,
            thread: Some(thread),
        })
    }
    pub fn status(&self) -> Status {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
            .clone()
    }
    /// Never waits for disk I/O. Full queues latch an incomplete log and drop all
    /// subsequent capture; neither the caller nor the worker retries records.
    pub fn submit(&self, mut record: Record) -> bool {
        #[cfg(feature = "log-timeline-fixture")]
        use timeline_fixture::Kind;
        #[cfg(feature = "log-timeline-fixture")]
        let seq = record.text.seq;
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if shared.sender.is_none() {
            shared.reject(&record);
            #[cfg(feature = "log-timeline-fixture")]
            shared.trace_queue(seq, Kind::RejectedClosed);
            return false;
        }
        if !record.valid(&self.metadata, shared.source_cursor, shared.text_cursor) {
            shared.reject(&record);
            shared.fail(Failure::InvalidRecord);
            #[cfg(feature = "log-timeline-fixture")]
            shared.trace_queue(seq, Kind::RejectedInvalid);
            return false;
        }
        let raw_bytes = record.raw_bytes();
        let final_record = record.raw.is_none();
        let source_gap = record.raw.as_ref().and_then(|r| r.gap_bytes).unwrap_or(0);
        // Bounds apply to retained allocation as well as logical length.
        if let Some(raw) = &mut record.raw {
            raw.bytes = raw.bytes.as_slice().to_vec();
        }
        record.text.text = record.text.text.as_str().to_owned();
        if shared
            .status
            .accepted_raw_bytes
            .checked_add(raw_bytes)
            .is_none()
            || shared
                .status
                .source_gap_bytes
                .checked_add(source_gap)
                .is_none()
            || shared.text_cursor.checked_add(1).is_none()
            || (!final_record && shared.source_cursor.checked_add(1).is_none())
        {
            shared.reject(&record);
            shared.fail(Failure::CounterExhausted);
            #[cfg(feature = "log-timeline-fixture")]
            shared.trace_queue(seq, Kind::RejectedCounter);
            return false;
        }
        #[cfg(feature = "log-timeline-fixture")]
        shared.trace_queue(seq, Kind::TrySend);
        match shared.sender.as_ref().unwrap().try_send(record) {
            Ok(()) => {
                shared.text_cursor += 1;
                shared.source_cursor += u64::from(!final_record);
                shared.status.accepted_records += 1;
                shared.status.accepted_raw_bytes += raw_bytes;
                shared.status.source_gap_bytes += source_gap;
                #[cfg(feature = "log-timeline-fixture")]
                shared.trace_queue(seq, Kind::Accepted);
                if final_record {
                    shared.status.natural_end = true;
                    shared.status.phase = Phase::Stopping;
                    shared.sender.take();
                }
                true
            }
            Err(TrySendError::Full(record)) => {
                shared.reject(&record);
                #[cfg(feature = "log-timeline-fixture")]
                shared.trace_queue(seq, Kind::QueueFull);
                shared.fail(Failure::QueueFull);
                false
            }
            Err(TrySendError::Disconnected(record)) => {
                shared.reject(&record);
                #[cfg(feature = "log-timeline-fixture")]
                shared.trace_queue(seq, Kind::RejectedDisconnected);
                shared.fail(Failure::Storage);
                false
            }
        }
    }
    pub fn stop(&self) {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        shared.sender.take();
        if !matches!(shared.status.phase, Phase::Failed | Phase::Stopped) {
            shared.status.phase = Phase::Stopping;
        }
    }
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }
    /// Blocking. Invoke outside service/transport event loops. No time bound is
    /// promised for a filesystem driver stuck in a write or sync operation.
    pub fn join(&mut self) -> Status {
        self.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.status()
    }
}
impl Drop for Logger {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests;
