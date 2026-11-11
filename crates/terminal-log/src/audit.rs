//! Separate bounded JSONL audit writer. No terminal content or caller paths.
use crate::storage;
use serde::{Deserialize, Serialize};
use session_core::audit_journal::{MAX_PAGE, Page, Payload, Record, State, Status};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::Path,
    sync::{
        Arc, Mutex,
        mpsc::{self, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::*;

const SEGMENTS: usize = 8;
const SEGMENT_BYTES: usize = 1024 * 1024;
const SEGMENT_RECORDS: usize = 1024;
const LINE_BYTES: usize = 8192;
const QUEUE: usize = 1024;
const MAGIC: &str = "shared-terminal-audit-v1";
#[cfg(any(test, feature = "audit-diagnostics-fixture"))]
mod fixture;
#[cfg(feature = "audit-diagnostics-fixture")]
pub use fixture::configure as configure_diagnostic_fixture;
#[cfg(feature = "audit-diagnostics-fixture")]
pub use fixture::drop_shutdown_reply as diagnostic_drop_shutdown_reply;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum FailureKind {
    QueueFull,
    ChannelDisconnected,
    SequenceExhausted,
    IoFailure,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum FailureStage {
    Submit,
    Append,
    Checkpoint,
    FlushBarrier,
    CloseBarrier,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub kind: FailureKind,
    pub stage: FailureStage,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    format: String,
    segment: u64,
}
struct Segment {
    number: u64,
    file: File,
    bytes: usize,
    records: Vec<Record>,
    incomplete: bool,
}
struct Disk {
    _guards: Vec<File>,
    _lock: File,
    path: std::path::PathBuf,
    segments: VecDeque<Segment>,
    #[cfg(any(test, feature = "audit-diagnostics-fixture"))]
    fault: Option<fixture::Control>,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid audit storage")
}
fn leaf(path: &Path, create: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(create)
        .share_mode(0)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.file_attributes() & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_READONLY) != 0
    {
        return Err(invalid());
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.nNumberOfLinks != 1 {
        return Err(invalid());
    }
    Ok(file)
}
fn discard(file: &File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of_val(&disposition) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
impl Disk {
    fn open(root: &Path) -> io::Result<Self> {
        let mut guards = storage::guards(root)?;
        let path = root.join("terminal-audit");
        match fs::create_dir(&path) {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e),
        }
        guards.push(storage::pin(&path)?);
        // Existing lock is opened without truncation; unknown bytes are never overwritten.
        let lock_path = path.join("audit.lock");
        let lock = match leaf(&lock_path, true) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => leaf(&lock_path, false)?,
            Err(e) => return Err(e),
        };
        if lock.metadata()?.len() != 0 {
            return Err(invalid());
        }
        let mut names = Vec::new();
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            if entry.file_name() == "audit.lock" {
                continue;
            }
            let name = entry.file_name().into_string().map_err(|_| invalid())?;
            let number = name
                .strip_suffix(".audit.jsonl")
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v > 0)
                .ok_or_else(invalid)?;
            if name != format!("{number:020}.audit.jsonl") || names.len() >= SEGMENTS {
                return Err(invalid());
            }
            names.push((number, entry.path()));
        }
        names.sort_unstable();
        let mut result = Self {
            _guards: guards,
            _lock: lock,
            path,
            segments: VecDeque::new(),
            #[cfg(any(test, feature = "audit-diagnostics-fixture"))]
            fault: fixture::for_root(root),
        };
        let mut previous = 0;
        for (number, path) in names {
            let mut file = leaf(&path, false)?;
            let size = file.metadata()?.len();
            if size > SEGMENT_BYTES as u64 {
                return Err(invalid());
            }
            let mut data = Vec::with_capacity(size as usize);
            file.read_to_end(&mut data)?;
            let mut lines = data.split_inclusive(|b| *b == b'\n');
            let header = lines.next().unwrap_or_default();
            // A crash during header creation is an incomplete segment, not an empty valid journal.
            let valid_header = header.len() <= LINE_BYTES
                && header.ends_with(b"\n")
                && serde_json::from_slice::<Header>(header)
                    .is_ok_and(|h| h.format == MAGIC && h.segment == number);
            if !valid_header {
                let mut expected = serde_json::to_vec(&Header {
                    format: MAGIC.into(),
                    segment: number,
                })?;
                expected.push(b'\n');
                if !expected.starts_with(&data) {
                    return Err(invalid());
                }
            }
            let mut records = Vec::new();
            let mut incomplete = !valid_header;
            if valid_header {
                for line in lines {
                    if line.len() > LINE_BYTES
                        || !line.ends_with(b"\n")
                        || records.len() >= SEGMENT_RECORDS
                    {
                        incomplete = true;
                        break;
                    }
                    let Ok(row) = serde_json::from_slice::<Record>(line) else {
                        incomplete = true;
                        break;
                    };
                    if row.seq <= previous || row.service_id.is_nil() {
                        incomplete = true;
                        break;
                    }
                    previous = row.seq;
                    records.push(row);
                }
            }
            file.seek(SeekFrom::End(0))?;
            result.segments.push_back(Segment {
                number,
                file,
                bytes: size as usize,
                records,
                incomplete,
            });
        }
        Ok(result)
    }
    fn last_seq(&self) -> u64 {
        self.segments
            .iter()
            .rev()
            .find_map(|s| s.records.last().map(|r| r.seq))
            .unwrap_or(0)
    }
    fn rows(&self) -> VecDeque<Record> {
        self.segments
            .iter()
            .flat_map(|s| s.records.iter().cloned())
            .collect()
    }
    fn incomplete(&self) -> u32 {
        self.segments.iter().filter(|s| s.incomplete).count() as u32
    }
    fn rotate(&mut self) -> io::Result<()> {
        let number = self
            .segments
            .back()
            .map_or(Some(1), |s| s.number.checked_add(1))
            .ok_or_else(invalid)?;
        if self.segments.len() == SEGMENTS {
            // Only the already-open, exclusive, plain, singly-linked owned file is retired.
            discard(&self.segments.front().unwrap().file)?;
            self.segments.pop_front();
        }
        let mut file = leaf(&self.path.join(format!("{number:020}.audit.jsonl")), true)?;
        let mut header = serde_json::to_vec(&Header {
            format: MAGIC.into(),
            segment: number,
        })?;
        header.push(b'\n');
        file.write_all(&header)?;
        file.sync_all()?;
        self.segments.push_back(Segment {
            number,
            file,
            bytes: header.len(),
            records: Vec::new(),
            incomplete: false,
        });
        Ok(())
    }
    fn append(&mut self, row: Record) -> io::Result<()> {
        #[cfg(any(test, feature = "audit-diagnostics-fixture"))]
        if let Some(fault) = &self.fault {
            fault.before(FailureStage::Append)?;
        }
        let mut data = serde_json::to_vec(&row)?;
        data.push(b'\n');
        if data.len() > LINE_BYTES {
            return Err(invalid());
        }
        if self.segments.back().is_none_or(|s| {
            s.incomplete
                || s.records.len() == SEGMENT_RECORDS
                || s.bytes + data.len() > SEGMENT_BYTES
        }) {
            if let Some(s) = self.segments.back() {
                s.file.sync_all()?;
            }
            self.rotate()?;
        }
        let s = self.segments.back_mut().unwrap();
        s.file.write_all(&data)?;
        s.bytes += data.len();
        s.records.push(row);
        Ok(())
    }
    fn sync(&self) -> io::Result<()> {
        if let Some(s) = self.segments.back() {
            timeline_io!(AuditSync, None, s.file.sync_all())?;
        }
        Ok(())
    }
}
struct Shared {
    status: Status,
    rows: VecDeque<Record>,
    first_failure: Option<Failure>,
}
impl Shared {
    fn fail(&mut self, kind: FailureKind, stage: FailureStage) {
        self.first_failure.get_or_insert(Failure { kind, stage });
    }
}
enum Message {
    Record(Box<Record>),
    Flush(SyncSender<Status>),
    Close,
}
#[derive(Clone)]
pub struct Sink {
    sender: SyncSender<Message>,
    shared: Arc<Mutex<Shared>>,
    service_id: Uuid,
}
impl Sink {
    /// Nonblocking. False means no accepted record; failure is sticky and visible.
    pub fn submit(&self, payload: Payload) -> bool {
        let Ok(mut shared) = self.shared.lock() else {
            return false;
        };
        if shared.status.state != State::Healthy {
            shared.status.rejected_records = shared.status.rejected_records.saturating_add(1);
            return false;
        }
        let Some(seq) = shared.status.accepted_through.checked_add(1) else {
            shared.status.state = State::StorageFailure;
            shared.fail(FailureKind::SequenceExhausted, FailureStage::Submit);
            return false;
        };
        match self.sender.try_send(Message::Record(Box::new(Record {
            seq,
            service_id: self.service_id,
            payload,
        }))) {
            Ok(()) => {
                shared.status.accepted_through = seq;
                true
            }
            Err(e) => {
                shared.fail(
                    match &e {
                        TrySendError::Full(_) => FailureKind::QueueFull,
                        TrySendError::Disconnected(_) => FailureKind::ChannelDisconnected,
                    },
                    FailureStage::Submit,
                );
                shared.status.state = match e {
                    TrySendError::Full(_) => State::QueueFull,
                    TrySendError::Disconnected(_) => State::StorageFailure,
                };
                shared.status.rejected_records = shared.status.rejected_records.saturating_add(1);
                false
            }
        }
    }
    pub fn status(&self) -> Status {
        self.shared.lock().unwrap().status.clone()
    }
    /// Safe metadata only. Never formats a payload or a storage error.
    pub fn diagnostic_snapshot(&self) -> io::Result<(Status, Option<Failure>)> {
        let shared = self.shared.lock().map_err(|_| invalid())?;
        Ok((shared.status.clone(), shared.first_failure))
    }
    pub fn page(&self, cursor: u64, through: u64, limit: usize) -> io::Result<Page> {
        let shared = self.shared.lock().map_err(|_| invalid())?;
        if cursor > through
            || through > shared.status.synced_through
            || !(1..=MAX_PAGE).contains(&limit)
        {
            return Err(invalid());
        }
        let records: Vec<_> = shared
            .rows
            .iter()
            .filter(|r| r.seq > cursor && r.seq <= through)
            .take(limit)
            .cloned()
            .collect();
        let next_cursor = records.last().map_or(through, |r| r.seq);
        let mut previous = cursor;
        let mut gap = cursor < shared.status.available_from;
        for row in &records {
            gap |= previous.checked_add(1) != Some(row.seq);
            previous = row.seq;
        }
        if records.len() < limit && previous < through {
            gap = true;
        }
        Ok(Page {
            records,
            next_cursor,
            through_cursor: through,
            available_from: shared.status.available_from,
            gap,
        })
    }
    /// Blocking durability barrier for a blocking worker/test, never a Store lock.
    pub fn flush(&self) -> io::Result<Status> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Message::Flush(sender))
            .map_err(|_| invalid())?;
        receiver.recv().map_err(|_| invalid())
    }
}
pub struct Writer {
    sink: Sink,
    thread: Option<JoinHandle<()>>,
}
impl Writer {
    /// Call on a blocking owner. The root must already be an owned local directory.
    pub fn open(root: &Path, service_id: Uuid) -> io::Result<Self> {
        if service_id.is_nil() {
            return Err(invalid());
        }
        let disk = Disk::open(root)?;
        Self::from_disk(disk, service_id)
    }
    fn from_disk(disk: Disk, service_id: Uuid) -> io::Result<Self> {
        let seq = disk.last_seq();
        let rows = disk.rows();
        let available_from = rows.front().map_or(seq, |r| r.seq - 1);
        let shared = Arc::new(Mutex::new(Shared {
            status: Status {
                state: State::Healthy,
                accepted_through: seq,
                synced_through: seq,
                rejected_records: 0,
                incomplete_segments: disk.incomplete(),
                available_from,
                retained_records: rows.len(),
            },
            rows,
            first_failure: None,
        }));
        let (sender, receiver) = mpsc::sync_channel(QUEUE);
        let sink = Sink {
            sender,
            shared: shared.clone(),
            service_id,
        };
        #[cfg(feature = "log-timeline-fixture")]
        let timeline = crate::timeline_fixture::audit_context();
        let thread = thread::Builder::new()
            .name("audit-journal".into())
            .spawn(move || {
                #[cfg(feature = "log-timeline-fixture")]
                let _timeline = crate::timeline_fixture::install(timeline);
                run(disk, receiver, shared)
            })?;
        Ok(Self {
            sink,
            thread: Some(thread),
        })
    }
    pub fn sink(&self) -> Sink {
        self.sink.clone()
    }
    pub fn close(mut self) -> io::Result<Status> {
        self.stop()
    }
    fn stop(&mut self) -> io::Result<Status> {
        if let Some(thread) = self.thread.take() {
            #[cfg(feature = "audit-diagnostics-fixture")]
            fixture::mark_closing();
            {
                let mut s = self.sink.shared.lock().map_err(|_| invalid())?;
                if s.status.state == State::Healthy {
                    s.status.state = State::Closed;
                }
            }
            let _ = self.sink.sender.send(Message::Close);
            thread.join().map_err(|_| invalid())?;
        }
        Ok(self.sink.status())
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
#[cfg(test)]
fn commit(disk: &Disk, shared: &Mutex<Shared>) -> io::Result<()> {
    commit_at(disk, shared, FailureStage::Checkpoint)
}
fn commit_at(disk: &Disk, shared: &Mutex<Shared>, _stage: FailureStage) -> io::Result<()> {
    #[cfg(feature = "log-timeline-fixture")]
    crate::timeline_fixture::set_sequence(disk.last_seq());
    #[cfg(any(test, feature = "audit-diagnostics-fixture"))]
    if let Some(fault) = &disk.fault {
        fault.before(_stage)?;
    }
    disk.sync()?;
    let rows = disk.rows();
    let mut s = shared.lock().map_err(|_| invalid())?;
    s.status.synced_through = disk.last_seq();
    s.status.available_from = rows.front().map_or(s.status.synced_through, |r| r.seq - 1);
    s.status.retained_records = rows.len();
    s.status.incomplete_segments = disk.incomplete();
    s.rows = rows;
    Ok(())
}
fn run(mut disk: Disk, receiver: mpsc::Receiver<Message>, shared: Arc<Mutex<Shared>>) {
    let mut failed = false;
    let mut pending = None;
    loop {
        let message = match pending.take().or_else(|| receiver.recv().ok()) {
            Some(v) => v,
            None => break,
        };
        match message {
            Message::Record(row) => {
                if failed {
                    continue;
                }
                let result = (|| {
                    disk.append(*row).map_err(|_| FailureStage::Append)?;
                    for _ in 1..64 {
                        match receiver.try_recv() {
                            Ok(Message::Record(row)) => {
                                disk.append(*row).map_err(|_| FailureStage::Append)?
                            }
                            Ok(other) => {
                                pending = Some(other);
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    commit_at(&disk, &shared, FailureStage::Checkpoint)
                        .map_err(|_| FailureStage::Checkpoint)
                })();
                if let Err(stage) = result {
                    failed = true;
                    let mut state = shared.lock().unwrap();
                    state.status.state = State::StorageFailure;
                    state.fail(FailureKind::IoFailure, stage);
                }
            }
            Message::Flush(reply) => {
                if !failed && commit_at(&disk, &shared, FailureStage::FlushBarrier).is_err() {
                    failed = true;
                    let mut state = shared.lock().unwrap();
                    state.status.state = State::StorageFailure;
                    state.fail(FailureKind::IoFailure, FailureStage::FlushBarrier);
                }
                let _ = reply.send(shared.lock().unwrap().status.clone());
            }
            Message::Close => {
                if !failed && commit_at(&disk, &shared, FailureStage::CloseBarrier).is_err() {
                    let mut state = shared.lock().unwrap();
                    state.status.state = State::StorageFailure;
                    state.fail(FailureKind::IoFailure, FailureStage::CloseBarrier);
                }
                break;
            }
        }
    }
}
#[cfg(test)]
mod tests;
