//! Windows immutable completed-log reader. No caller supplied file names, eager
//! whole-log scans, background writes or implicit repair of damaged content.
use crate::{Limits, ManagedRoot, Metadata, PairReader, Record};
use serde::{Deserialize, Serialize};
use session_core::session::ConnectionRef;
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::Path,
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Completion {
    pub format_version: u32,
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub written_records: u64,
    pub written_raw_bytes: u64,
    pub first_retained_segment: u64,
    pub last_segment: u64,
    pub natural_end: bool,
    /// Earlier v1 writers did not persist this counter. Missing means unknown,
    /// never zero; the retained records are still validated independently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_gap_bytes: Option<u64>,
}
#[derive(Debug, Clone)]
pub struct ArchiveInfo {
    pub completion: Completion,
    pub metadata: Metadata,
    pub limits: Limits,
    pub available_from: u64,
    pub source_available_from: u64,
}
pub struct ArchivePage {
    pub records: Vec<Record>,
    pub next_cursor: u64,
    /// True only after every retained pair and final completion counters pass.
    pub finished: bool,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid completed journal")
}
fn required_segment(error: io::Error) -> io::Error {
    // A completion marker naming absent segment files is damaged, rather than
    // an unfinished capture whose marker has not yet been published.
    if error.kind() == io::ErrorKind::NotFound {
        invalid()
    } else {
        error
    }
}
pub(crate) fn read_file(path: &Path, limit: u64) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Deny writers/rename/deletion for the lifetime of the read snapshot.
        options.share_mode(1).custom_flags(0x00200000);
    }
    #[cfg(not(windows))]
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid());
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    if !metadata.is_file() || metadata.len() > limit {
        return Err(invalid());
    }
    Ok(file)
}

/// Sequential, bounded reads of completed retained segments. Opening validates
/// headers and file policy, not record contents. Keep `finished == false` until
/// the final page verifies the complete retained range. Source bytes are never
/// written to a terminal, interpreted as actions or silently reconstructed.
pub struct ArchiveReader {
    _guards: Vec<File>,
    _marker: File,
    info: ArchiveInfo,
    pairs: VecDeque<PairReader<File, File>>,
    // Keep read handles alive after a segment has been consumed, so every file
    // remains immutable until the entire snapshot is explicitly closed.
    consumed: Vec<PairReader<File, File>>,
    source: u64,
    text: u64,
    emitted: u64,
    raw_bytes: u64,
    gap_bytes: u64,
    final_flush: bool,
    segment_records: u64,
    pending: Option<Record>,
    failed: bool,
    finished: bool,
}
impl ArchiveReader {
    pub fn open(root: &ManagedRoot, id: Uuid, connection: ConnectionRef) -> io::Result<Self> {
        if id.is_nil() || connection.connection_id.0.is_nil() || connection.generation == 0 {
            return Err(invalid());
        }
        Self::open_inner(root, id, Some(connection))
    }
    /// Bounded metadata inspection for a trusted local catalogue. This does not
    /// scan record contents or prove the completion declaration is accurate.
    pub fn inspect(root: &ManagedRoot, id: Uuid) -> io::Result<ArchiveInfo> {
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
        let mut marker = read_file(&directory.join("completion.json"), 1024)?;
        let mut bytes = Vec::new();
        (&mut marker).take(1025).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 {
            return Err(invalid());
        }
        let completion: Completion = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let count = completion
            .last_segment
            .checked_sub(completion.first_retained_segment)
            .and_then(|n| n.checked_add(1))
            .ok_or_else(invalid)?;
        if completion.format_version != 1
            || completion.log_id != id
            || expected.is_some_and(|connection| completion.connection != connection)
            || completion.first_retained_segment == 0
            || count > 16
            || (completion.written_records == 0
                && (completion.first_retained_segment != 1 || completion.last_segment != 1))
        {
            return Err(invalid());
        }
        let mut expected = HashSet::from(["completion.json".to_string()]);
        let mut pairs = VecDeque::new();
        for number in completion.first_retained_segment..=completion.last_segment {
            let raw_name = format!("{number:016}.rawlog");
            let text_name = format!("{number:016}.text.jsonl");
            let raw = read_file(&directory.join(&raw_name), 100 * 1024 * 1024)
                .map_err(required_segment)?;
            let text = read_file(&directory.join(&text_name), 100 * 1024 * 1024)
                .map_err(required_segment)?;
            let size = raw
                .metadata()?
                .len()
                .checked_add(text.metadata()?.len())
                .ok_or_else(invalid)?;
            let pair = PairReader::new(raw, text)?;
            let header = pair.header();
            if header.log_id != id
                || header.segment != number
                || header.metadata.connection != completion.connection
                || count > u64::from(header.limits.segments)
                || size > header.limits.segment_bytes
            {
                return Err(invalid());
            }
            if let Some(first) = pairs.front() {
                let first: &PairReader<File, File> = first;
                if header.metadata != first.header().metadata
                    || header.limits != first.header().limits
                {
                    return Err(invalid());
                }
            }
            expected.insert(raw_name);
            expected.insert(text_name);
            pairs.push_back(pair);
        }
        for entry in fs::read_dir(&directory)? {
            let name = entry?.file_name().into_string().map_err(|_| invalid())?;
            if !expected.remove(&name) {
                return Err(invalid());
            }
        }
        if !expected.is_empty() {
            return Err(invalid());
        }
        let first = pairs.front().ok_or_else(invalid)?.header();
        if completion.first_retained_segment == 1
            && (first.source_cursor != first.metadata.source_cursor
                || first.text_cursor != first.metadata.text_cursor)
        {
            return Err(invalid());
        }
        let info = ArchiveInfo {
            metadata: first.metadata.clone(),
            limits: first.limits,
            available_from: first.text_cursor,
            source_available_from: first.source_cursor,
            completion,
        };
        Ok(Self {
            source: info.source_available_from,
            text: info.available_from,
            info,
            _guards: guards,
            _marker: marker,
            pairs,
            consumed: Vec::new(),
            emitted: 0,
            raw_bytes: 0,
            gap_bytes: 0,
            final_flush: false,
            segment_records: 0,
            pending: None,
            failed: false,
            finished: false,
        })
    }
    pub fn info(&self) -> &ArchiveInfo {
        &self.info
    }

    /// At most 128 records and 256KiB logical payload per page, plus one bounded
    /// lookahead record. Invalid arguments do not move or poison the cursor.
    pub fn read_page(&mut self, max_records: usize, max_bytes: usize) -> io::Result<ArchivePage> {
        if !(1..=128).contains(&max_records) || !(32 * 1024..=256 * 1024).contains(&max_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid archive page limits",
            ));
        }
        if self.failed {
            return Err(invalid());
        }
        let result = self.page(max_records, max_bytes);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn page(&mut self, max_records: usize, max_bytes: usize) -> io::Result<ArchivePage> {
        let mut records = Vec::new();
        let mut bytes = 0;
        while records.len() < max_records {
            let record = match self.pending.take() {
                Some(record) => Some(record),
                None => self.next()?,
            };
            let Some(record) = record else {
                break;
            };
            let size =
                record.text.text.len() + record.raw.as_ref().map_or(0, |r| r.bytes.len()) + 256;
            if bytes + size > max_bytes {
                self.pending = Some(record);
                break;
            }
            bytes += size;
            self.emitted = record.text.seq.checked_add(1).ok_or_else(invalid)?;
            records.push(record);
        }
        Ok(ArchivePage {
            next_cursor: if self.emitted == 0 {
                self.info.available_from
            } else {
                self.emitted
            },
            records,
            finished: self.finished && self.pending.is_none(),
        })
    }
    fn next(&mut self) -> io::Result<Option<Record>> {
        if self.finished {
            return Ok(None);
        }
        while let Some(pair) = self.pairs.front_mut() {
            if self.segment_records == 0
                && (pair.header().source_cursor != self.source
                    || pair.header().text_cursor != self.text)
            {
                return Err(invalid());
            }
            if let Some(record) = pair.next_record()? {
                if self.final_flush {
                    return Err(invalid());
                }
                self.text = self.text.checked_add(1).ok_or_else(invalid)?;
                self.segment_records += 1;
                match &record.raw {
                    Some(raw) => {
                        self.source = self.source.checked_add(1).ok_or_else(invalid)?;
                        self.raw_bytes = self
                            .raw_bytes
                            .checked_add(raw.bytes.len() as u64)
                            .ok_or_else(invalid)?;
                        self.gap_bytes = self
                            .gap_bytes
                            .checked_add(raw.gap_bytes.unwrap_or(0))
                            .ok_or_else(invalid)?;
                    }
                    None => self.final_flush = true,
                }
                return Ok(Some(record));
            }
            if self.segment_records == 0 && self.info.completion.written_records != 0 {
                return Err(invalid());
            }
            self.consumed
                .push(self.pairs.pop_front().ok_or_else(invalid)?);
            self.segment_records = 0;
        }
        let completion = &self.info.completion;
        if self.text.checked_sub(self.info.metadata.text_cursor) != Some(completion.written_records)
            || self.raw_bytes > completion.written_raw_bytes
            || self.final_flush != completion.natural_end
            || completion
                .source_gap_bytes
                .is_some_and(|total| self.gap_bytes > total)
            || (completion.first_retained_segment == 1
                && (self.raw_bytes != completion.written_raw_bytes
                    || completion
                        .source_gap_bytes
                        .is_some_and(|total| self.gap_bytes != total)))
        {
            return Err(invalid());
        }
        self.finished = true;
        Ok(None)
    }
}
