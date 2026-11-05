//! Explicit read-only salvage. Never repairs a source or certifies completion.
use crate::{Limits, ManagedRoot, Metadata, PairReader, Record, SegmentHeader};
use serde::Serialize;
use session_core::session::ConnectionRef;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io,
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryInfo {
    pub log_id: Uuid,
    pub metadata: Metadata,
    pub limits: Limits,
    pub first_segment: u64,
    pub last_observed_segment: u64,
    pub available_from: u64,
    pub source_available_from: u64,
    /// Presence only: neither marker is interpreted as proof of completion.
    pub completion_present: bool,
    pub partial_present: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecoveryStopKind {
    EndOfAvailable,
    MissingPartner,
    MissingSegment,
    InvalidHeader,
    Discontinuity,
    TruncatedRecord,
    InvalidRecord,
    Storage,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecoveryStop {
    pub kind: RecoveryStopKind,
    pub segment: u64,
    /// First undelivered text sequence, not a physical file offset.
    pub next_cursor: u64,
}
pub struct RecoveryPage {
    pub records: Vec<Record>,
    pub next_cursor: u64,
    /// Stable terminal report. EndOfAvailable still does not mean completed.
    pub stop: Option<RecoveryStop>,
}
#[derive(Default)]
struct Files {
    raw: Option<File>,
    text: Option<File>,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid recovery snapshot")
}

/// Windows snapshot holds all observed files read-only until closed. Call on a
/// bounded file worker; no pathname supplied by IPC, no eager payload scan.
pub struct RecoveryReader {
    _guards: Vec<File>,
    _markers: Vec<File>,
    info: RecoveryInfo,
    files: BTreeMap<u64, Files>,
    pair: PairReader<File, File>,
    consumed: Vec<PairReader<File, File>>,
    segment: u64,
    source: u64,
    text: u64,
    final_flush: bool,
    stop: Option<RecoveryStop>,
}
impl RecoveryReader {
    pub fn open(root: &ManagedRoot, id: Uuid, connection: ConnectionRef) -> io::Result<Self> {
        if id.is_nil() || connection.connection_id.0.is_nil() || connection.generation == 0 {
            return Err(invalid());
        }
        Self::open_inner(root, id, Some(connection))
    }
    /// Header/file policy inspection only, never a payload or completion check.
    pub fn inspect(root: &ManagedRoot, id: Uuid) -> io::Result<RecoveryInfo> {
        Ok(Self::open_inner(root, id, None)?.info.clone())
    }
    fn open_inner(
        root: &ManagedRoot,
        id: Uuid,
        expected: Option<ConnectionRef>,
    ) -> io::Result<Self> {
        if id.is_nil() {
            return Err(invalid());
        }
        let mut guards = crate::storage::guards(root.path())?;
        let directory = root.path().join(id.to_string());
        guards.push(crate::storage::pin(&directory)?);
        let mut files = BTreeMap::<u64, Files>::new();
        let mut markers = Vec::new();
        let mut completion_present = false;
        let mut partial_present = false;
        // Snapshot every observed file before returning any payload. Unknown,
        // oversized, reparse and occupied files reject the entire open.
        for (index, entry) in fs::read_dir(&directory)?.enumerate() {
            if index >= 34 {
                return Err(invalid());
            }
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| invalid())?;
            if name == "completion.json" || name == "completion.partial" {
                markers.push(crate::archive::read_file(&entry.path(), 1024)?);
                completion_present |= name == "completion.json";
                partial_present |= name == "completion.partial";
                continue;
            }
            let (number, raw) = if let Some(number) = name.strip_suffix(".rawlog") {
                (number, true)
            } else if let Some(number) = name.strip_suffix(".text.jsonl") {
                (number, false)
            } else {
                return Err(invalid());
            };
            let segment: u64 = number.parse().map_err(|_| invalid())?;
            if segment == 0 || format!("{segment:016}") != number {
                return Err(invalid());
            }
            let file = crate::archive::read_file(&entry.path(), 100 * 1024 * 1024)?;
            let slot = files.entry(segment).or_default();
            if raw {
                slot.raw = Some(file);
            } else {
                slot.text = Some(file);
            }
        }
        if files.len() > 16 {
            return Err(invalid());
        }
        let last = *files.keys().next_back().ok_or_else(invalid)?;
        let (segment, first) = files.pop_first().ok_or_else(invalid)?;
        let pair = Self::pair(first)?;
        let header = pair.header();
        if header.log_id != id
            || header.segment != segment
            || expected.is_some_and(|connection| header.metadata.connection != connection)
            || files.len() + 1 > header.limits.segments as usize
            || (segment == 1
                && (header.source_cursor != header.metadata.source_cursor
                    || header.text_cursor != header.metadata.text_cursor))
        {
            return Err(invalid());
        }
        let info = RecoveryInfo {
            log_id: id,
            metadata: header.metadata.clone(),
            limits: header.limits,
            first_segment: segment,
            last_observed_segment: last,
            available_from: header.text_cursor,
            source_available_from: header.source_cursor,
            completion_present,
            partial_present,
        };
        Ok(Self {
            _guards: guards,
            _markers: markers,
            source: info.source_available_from,
            text: info.available_from,
            info,
            files,
            pair,
            consumed: Vec::new(),
            segment,
            final_flush: false,
            stop: None,
        })
    }
    fn pair(files: Files) -> io::Result<PairReader<File, File>> {
        let raw = files.raw.ok_or_else(invalid)?;
        let text = files.text.ok_or_else(invalid)?;
        let size = raw
            .metadata()?
            .len()
            .checked_add(text.metadata()?.len())
            .ok_or_else(invalid)?;
        let pair = PairReader::new(raw, text)?;
        if size > pair.header().limits.segment_bytes {
            return Err(invalid());
        }
        Ok(pair)
    }
    pub fn info(&self) -> &RecoveryInfo {
        &self.info
    }
    fn halt(&mut self, kind: RecoveryStopKind) {
        self.stop = Some(RecoveryStop {
            kind,
            segment: self.segment,
            next_cursor: self.text,
        });
    }
    fn matches(&self, header: &SegmentHeader) -> bool {
        header.log_id == self.info.log_id
            && header.segment == self.segment
            && header.metadata == self.info.metadata
            && header.limits == self.info.limits
            && header.source_cursor == self.source
            && header.text_cursor == self.text
    }
    fn next(&mut self) -> Option<Record> {
        loop {
            if self.stop.is_some() {
                return None;
            }
            match self.pair.next_record() {
                Ok(Some(record)) => {
                    if self.final_flush {
                        self.halt(RecoveryStopKind::Discontinuity);
                        return None;
                    }
                    // RawReader has already checked sequence increments for overflow.
                    self.text += 1;
                    if record.raw.is_some() {
                        self.source += 1;
                    } else {
                        self.final_flush = true;
                    }
                    return Some(record);
                }
                Err(error) => {
                    self.halt(match error.kind() {
                        io::ErrorKind::UnexpectedEof => RecoveryStopKind::TruncatedRecord,
                        io::ErrorKind::InvalidData => RecoveryStopKind::InvalidRecord,
                        _ => RecoveryStopKind::Storage,
                    });
                    return None;
                }
                Ok(None) => {}
            }
            let Some((&number, _)) = self.files.first_key_value() else {
                self.halt(RecoveryStopKind::EndOfAvailable);
                return None;
            };
            let expected = self.segment.checked_add(1);
            if expected != Some(number) {
                self.halt(RecoveryStopKind::MissingSegment);
                return None;
            }
            self.segment = number;
            if self.final_flush {
                self.halt(RecoveryStopKind::Discontinuity);
                return None;
            }
            let files = self.files.get_mut(&number).expect("observed segment");
            if files.raw.is_none() || files.text.is_none() {
                self.halt(RecoveryStopKind::MissingPartner);
                return None;
            }
            // Clone handles before parsing so even a corrupt header keeps the
            // original files pinned for this snapshot's entire lifetime.
            let cloned = (|| {
                Ok::<_, io::Error>(Files {
                    raw: Some(files.raw.as_ref().unwrap().try_clone()?),
                    text: Some(files.text.as_ref().unwrap().try_clone()?),
                })
            })();
            let pair = match cloned.and_then(Self::pair) {
                Ok(pair) => pair,
                Err(error) => {
                    self.halt(
                        if matches!(
                            error.kind(),
                            io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof
                        ) {
                            RecoveryStopKind::InvalidHeader
                        } else {
                            RecoveryStopKind::Storage
                        },
                    );
                    return None;
                }
            };
            if !self.matches(pair.header()) {
                self.halt(RecoveryStopKind::Discontinuity);
                return None;
            }
            self.files.remove(&number);
            self.consumed.push(std::mem::replace(&mut self.pair, pair));
        }
    }
    /// No lookahead: only consume a record when the maximum legal record fits.
    /// Pages can be smaller than requested. Invalid limits do not move cursors.
    pub fn read_page(&mut self, max_records: usize, max_bytes: usize) -> io::Result<RecoveryPage> {
        if !(1..=128).contains(&max_records) || !(32 * 1024..=256 * 1024).contains(&max_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid recovery page limits",
            ));
        }
        let mut records = Vec::new();
        let mut bytes = 0;
        const RECORD_BUDGET: usize = crate::MAX_TEXT + session_core::session::EVENT_BYTES + 256;
        while records.len() < max_records && max_bytes - bytes >= RECORD_BUDGET {
            let Some(record) = self.next() else {
                break;
            };
            bytes +=
                record.text.text.len() + record.raw.as_ref().map_or(0, |r| r.bytes.len()) + 256;
            records.push(record);
        }
        Ok(RecoveryPage {
            records,
            next_cursor: self.text,
            stop: self.stop.clone(),
        })
    }
}
