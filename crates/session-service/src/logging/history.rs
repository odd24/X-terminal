//! One bounded blocking actor owns immutable historical read handles.
use super::*;
use session_core::input::{RequestWindow, ordered_timestamp};
use std::{
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use terminal_log::{ArchiveReader, ManagedRoot};
use tokio::sync::oneshot;

const READERS: usize = 8;
const RECEIPTS: usize = 128;
const IDLE: Duration = Duration::from_secs(120);
mod recovery;
struct Message {
    directory: Option<PathBuf>,
    request: Request,
    reply: oneshot::Sender<Result<Reply, ErrorCode>>,
}
pub(super) struct Worker {
    sender: mpsc::SyncSender<Message>,
    thread: thread::JoinHandle<()>,
}
impl Worker {
    pub(super) fn start() -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Message>(16);
        let thread = thread::Builder::new()
            .name("terminal-log-history".into())
            .spawn(move || {
                let mut state = State::default();
                loop {
                    state.reap(Instant::now());
                    let message = match receiver.recv_timeout(Duration::from_secs(1)) {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if message.reply.is_closed() {
                        continue;
                    }
                    let result = state.handle(message.directory, message.request);
                    let _ = message.reply.send(result);
                }
            })?;
        Ok(Self { sender, thread })
    }
    pub(super) async fn request(
        &self,
        directory: Option<PathBuf>,
        request: Request,
    ) -> Result<Reply, ErrorCode> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Message {
                directory,
                request,
                reply,
            })
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
                _ => ErrorCode::InvalidState,
            })?;
        receiver.await.map_err(|_| ErrorCode::InvalidState)?
    }
    pub(super) async fn close(self) -> io::Result<()> {
        drop(self.sender);
        tokio::task::spawn_blocking(move || self.thread.join())
            .await
            .map_err(|_| io::Error::other("history cleanup task failed"))?
            .map_err(|_| io::Error::other("history worker failed"))
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Scope {
    connection: ConnectionRef,
    log_id: Uuid,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct PageArgs {
    cursor: u64,
    records: u32,
    bytes: u32,
}
struct Entry {
    scope: Scope,
    reader: Option<ArchiveReader>,
    info: wire::ArchiveInfo,
    cursor: u64,
    last: Option<(PageArgs, wire::HistoryPage)>,
    touched: Instant,
}
impl Entry {
    fn release(&mut self) {
        self.reader = None;
        self.last = None;
    }
}
#[derive(Default)]
struct State {
    entries: HashMap<Uuid, Entry>,
    window: RequestWindow,
    recovery: recovery::State,
}
fn info(value: &terminal_log::ArchiveInfo) -> wire::ArchiveInfo {
    let meta = &value.metadata;
    let completed = &value.completion;
    wire::ArchiveInfo {
        log_id: completed.log_id,
        connection: completed.connection,
        protocol: meta.protocol,
        encoding: meta.encoding.clone(),
        started_at_ms: meta.started_at_ms,
        source_cursor: meta.source_cursor,
        text_cursor: meta.text_cursor,
        limits: wire::Limits {
            segment_bytes: value.limits.segment_bytes,
            segments: value.limits.segments,
        },
        available_from: value.available_from,
        source_available_from: value.source_available_from,
        first_retained_segment: completed.first_retained_segment,
        last_segment: completed.last_segment,
        written_records: completed.written_records,
        written_raw_bytes: completed.written_raw_bytes,
        source_gap_bytes: completed.source_gap_bytes,
        natural_end: completed.natural_end,
    }
}
fn file_error(error: io::Error) -> ErrorCode {
    if error.kind() == io::ErrorKind::NotFound {
        ErrorCode::NotFound
    } else {
        ErrorCode::InvalidState
    }
}
impl State {
    fn reap(&mut self, now: Instant) {
        self.recovery.reap(now);
        for entry in self.entries.values_mut() {
            if now.saturating_duration_since(entry.touched) >= IDLE {
                entry.release();
            }
        }
    }
    fn reserve(&mut self, id: Uuid) -> Result<(), ErrorCode> {
        self.window.check(id)?;
        if self.entries.len() >= RECEIPTS {
            let (old, stamp) = self
                .entries
                .iter()
                .filter(|(_, e)| e.reader.is_none())
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            self.entries.remove(&old);
            self.window.retire(stamp);
        }
        self.window.check(id)
    }
    fn entry(&mut self, id: Uuid, scope: Scope) -> Result<&mut Entry, ErrorCode> {
        self.window.check(id).or_else(|error| {
            if self.entries.contains_key(&id) {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        let entry = self.entries.get_mut(&id).ok_or(ErrorCode::NotFound)?;
        if entry.scope != scope {
            return Err(ErrorCode::InvalidArgument);
        }
        entry.touched = Instant::now();
        Ok(entry)
    }
    fn handle(&mut self, directory: Option<PathBuf>, request: Request) -> Result<Reply, ErrorCode> {
        self.reap(Instant::now());
        match request {
            request @ (Request::RecoveryList {}
            | Request::RecoveryOpen { .. }
            | Request::RecoveryRead { .. }
            | Request::RecoveryClose { .. }) => self.recovery.handle(directory, request),
            Request::HistoryList {} => {
                let root = ManagedRoot::open(&directory.ok_or(ErrorCode::InvalidState)?)
                    .map_err(file_error)?;
                let ids = root.ids().map_err(file_error)?;
                let logs = ids
                    .into_iter()
                    .map(|id| {
                        let (state, metadata) = match ArchiveReader::inspect(&root, id) {
                            Ok(value) => (wire::CatalogueState::HeaderChecked, Some(info(&value))),
                            Err(error) => (
                                match error.kind() {
                                    io::ErrorKind::NotFound => wire::CatalogueState::Unfinished,
                                    io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput => {
                                        wire::CatalogueState::Invalid
                                    }
                                    _ => wire::CatalogueState::Unavailable,
                                },
                                None,
                            ),
                        };
                        wire::HistoryEntry {
                            log_id: id,
                            state,
                            info: metadata,
                        }
                    })
                    .collect();
                Ok(Reply::HistoryList { logs })
            }
            Request::HistoryOpen {
                connection,
                log_id,
                read_id,
            } => {
                let scope = Scope { connection, log_id };
                if let Some(entry) = self.entries.get_mut(&read_id) {
                    if entry.scope != scope {
                        return Err(ErrorCode::InvalidArgument);
                    }
                    if entry.reader.is_none() {
                        return Err(ErrorCode::RequestExpired);
                    }
                    entry.touched = Instant::now();
                    return Ok(Reply::HistoryOpened {
                        read_id,
                        info: Box::new(entry.info.clone()),
                    });
                }
                self.reserve(read_id)?;
                if self.entries.values().filter(|e| e.reader.is_some()).count() >= READERS {
                    return Err(ErrorCode::CapacityExceeded);
                }
                let root = ManagedRoot::open(&directory.ok_or(ErrorCode::InvalidState)?)
                    .map_err(file_error)?;
                let reader = ArchiveReader::open(&root, log_id, connection).map_err(file_error)?;
                let metadata = info(reader.info());
                self.entries.insert(
                    read_id,
                    Entry {
                        scope,
                        reader: Some(reader),
                        cursor: metadata.available_from,
                        info: metadata.clone(),
                        last: None,
                        touched: Instant::now(),
                    },
                );
                Ok(Reply::HistoryOpened {
                    read_id,
                    info: Box::new(metadata),
                })
            }
            Request::HistoryRead {
                connection,
                log_id,
                read_id,
                cursor,
                max_records,
                max_bytes,
            } => {
                let entry = self.entry(read_id, Scope { connection, log_id })?;
                if entry.reader.is_none() {
                    return Err(ErrorCode::RequestExpired);
                }
                let args = PageArgs {
                    cursor,
                    records: max_records,
                    bytes: max_bytes,
                };
                if let Some((previous, page)) = &entry.last
                    && previous.cursor == cursor
                {
                    return if *previous == args {
                        Ok(Reply::HistoryPage(Box::new(page.clone())))
                    } else {
                        Err(ErrorCode::InvalidArgument)
                    };
                }
                if cursor != entry.cursor {
                    return Err(if cursor < entry.cursor {
                        ErrorCode::RequestExpired
                    } else {
                        ErrorCode::InvalidArgument
                    });
                }
                let result = entry
                    .reader
                    .as_mut()
                    .ok_or(ErrorCode::RequestExpired)?
                    .read_page(max_records as usize, max_bytes as usize);
                let page = match result {
                    Ok(page) => page,
                    Err(error) => {
                        entry.release();
                        return Err(file_error(error));
                    }
                };
                let page = wire::HistoryPage {
                    connection,
                    log_id,
                    read_id,
                    cursor,
                    next_cursor: page.next_cursor,
                    available_from: entry.info.available_from,
                    source_available_from: entry.info.source_available_from,
                    finished: page.finished,
                    records: page
                        .records
                        .into_iter()
                        .map(|r| wire::HistoryRecord {
                            raw: r.raw,
                            text: r.text,
                        })
                        .collect(),
                };
                // Enforce the real encoded IPC budget too, before returning a page.
                if serde_json::to_vec(&page)
                    .map_err(|_| ErrorCode::InvalidState)?
                    .len()
                    > session_protocol::MAX_FRAME - 1024
                {
                    entry.release();
                    return Err(ErrorCode::CapacityExceeded);
                }
                entry.cursor = page.next_cursor;
                entry.last = Some((args, page.clone()));
                Ok(Reply::HistoryPage(Box::new(page)))
            }
            Request::HistoryClose {
                connection,
                log_id,
                read_id,
            } => {
                self.entry(read_id, Scope { connection, log_id })?.release();
                Ok(Reply::HistoryClosed { read_id })
            }
            _ => Err(ErrorCode::InvalidArgument),
        }
    }
}

#[cfg(test)]
mod tests;
