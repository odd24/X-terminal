//! Explicit recovery reads share the history file thread, with separate quotas
//! and request namespace. They never downgrade normal historical reads.
use super::*;
use terminal_log::RecoveryReader;
const READERS: usize = 4;
const RECEIPTS: usize = 64;
struct Entry {
    scope: Scope,
    info: wire::RecoveryInfo,
    reader: Option<RecoveryReader>,
    cursor: u64,
    last: Option<(PageArgs, wire::RecoveryPage)>,
    touched: Instant,
}
impl Entry {
    fn release(&mut self) {
        self.reader = None;
        self.last = None;
    }
}
#[derive(Default)]
pub(super) struct State {
    entries: HashMap<Uuid, Entry>,
    window: RequestWindow,
}
fn info(value: &terminal_log::RecoveryInfo) -> wire::RecoveryInfo {
    wire::RecoveryInfo {
        log_id: value.log_id,
        connection: value.metadata.connection,
        protocol: value.metadata.protocol,
        encoding: value.metadata.encoding.clone(),
        started_at_ms: value.metadata.started_at_ms,
        source_cursor: value.metadata.source_cursor,
        text_cursor: value.metadata.text_cursor,
        limits: wire::Limits {
            segment_bytes: value.limits.segment_bytes,
            segments: value.limits.segments,
        },
        first_segment: value.first_segment,
        last_observed_segment: value.last_observed_segment,
        available_from: value.available_from,
        source_available_from: value.source_available_from,
        completion_present: value.completion_present,
        partial_present: value.partial_present,
    }
}
fn stop(value: terminal_log::RecoveryStop) -> wire::RecoveryStop {
    use terminal_log::RecoveryStopKind as S;
    use wire::RecoveryStopKind as W;
    wire::RecoveryStop {
        kind: match value.kind {
            S::EndOfAvailable => W::EndOfAvailable,
            S::MissingPartner => W::MissingPartner,
            S::MissingSegment => W::MissingSegment,
            S::InvalidHeader => W::InvalidHeader,
            S::Discontinuity => W::Discontinuity,
            S::TruncatedRecord => W::TruncatedRecord,
            S::InvalidRecord => W::InvalidRecord,
            S::Storage => W::Storage,
        },
        segment: value.segment,
        next_cursor: value.next_cursor,
    }
}
impl State {
    pub(super) fn reap(&mut self, now: Instant) {
        for entry in self.entries.values_mut() {
            if now.saturating_duration_since(entry.touched) >= IDLE {
                entry.release();
            }
        }
    }
    fn reserve(&mut self, id: Uuid) -> Result<(), ErrorCode> {
        self.window.check(id)?;
        if self.entries.len() >= RECEIPTS {
            let (id, stamp) = self
                .entries
                .iter()
                .filter(|(_, e)| e.reader.is_none())
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|s| (*id, s)))
                .min_by_key(|(_, s)| *s)
                .ok_or(ErrorCode::CapacityExceeded)?;
            self.entries.remove(&id);
            self.window.retire(stamp);
        }
        self.window.check(id)
    }
    fn entry(&mut self, id: Uuid, scope: Scope) -> Result<&mut Entry, ErrorCode> {
        if !self.entries.contains_key(&id) {
            self.window.check(id)?;
        }
        let entry = self.entries.get_mut(&id).ok_or(ErrorCode::NotFound)?;
        if entry.scope != scope {
            return Err(ErrorCode::InvalidArgument);
        }
        entry.touched = Instant::now();
        Ok(entry)
    }
    pub(super) fn handle(
        &mut self,
        directory: Option<PathBuf>,
        request: Request,
    ) -> Result<Reply, ErrorCode> {
        self.reap(Instant::now());
        match request {
            Request::RecoveryList {} => {
                let root = ManagedRoot::open(&directory.ok_or(ErrorCode::InvalidState)?)
                    .map_err(file_error)?;
                let logs = root
                    .ids()
                    .map_err(file_error)?
                    .into_iter()
                    .map(|id| wire::RecoveryEntry {
                        log_id: id,
                        info: RecoveryReader::inspect(&root, id).ok().map(|v| info(&v)),
                    })
                    .collect();
                Ok(Reply::RecoveryList { logs })
            }
            Request::RecoveryOpen {
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
                    return Ok(Reply::RecoveryOpened {
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
                let reader = RecoveryReader::open(&root, log_id, connection).map_err(file_error)?;
                let info = info(reader.info());
                self.entries.insert(
                    read_id,
                    Entry {
                        scope,
                        cursor: info.available_from,
                        info: info.clone(),
                        reader: Some(reader),
                        last: None,
                        touched: Instant::now(),
                    },
                );
                Ok(Reply::RecoveryOpened {
                    read_id,
                    info: Box::new(info),
                })
            }
            Request::RecoveryRead {
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
                        Ok(Reply::RecoveryPage(Box::new(page.clone())))
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
                let page = wire::RecoveryPage {
                    connection,
                    log_id,
                    read_id,
                    cursor,
                    next_cursor: page.next_cursor,
                    available_from: entry.info.available_from,
                    source_available_from: entry.info.source_available_from,
                    stop: page.stop.map(stop),
                    records: page
                        .records
                        .into_iter()
                        .map(|r| wire::HistoryRecord {
                            raw: r.raw,
                            text: r.text,
                        })
                        .collect(),
                };
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
                Ok(Reply::RecoveryPage(Box::new(page)))
            }
            Request::RecoveryClose {
                connection,
                log_id,
                read_id,
            } => {
                self.entry(read_id, Scope { connection, log_id })?.release();
                Ok(Reply::RecoveryClosed { read_id })
            }
            _ => Err(ErrorCode::InvalidArgument),
        }
    }
}

#[cfg(test)]
mod tests;
