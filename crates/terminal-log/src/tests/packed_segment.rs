//! Isolated v2 segment experiment. No production reader or writer uses this format.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque, fs::File, io::Write, os::windows::fs::OpenOptionsExt, path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_WRITE,
};

const MAGIC: &[u8; 8] = b"STPAIR02";
pub(super) const MAX_SEGMENT: u64 = 1024 * 1024;
const MAX_FRAME: usize = session_core::session::EVENT_BYTES + 37 + crate::MAX_TEXT * 6 + 512;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SyncStage {
    Rotation,
    Segment,
    Live,
}

pub(super) struct PackedJournal {
    _guards: Vec<File>,
    directory: PathBuf,
    id: Uuid,
    metadata: Metadata,
    limits: Limits,
    segments: VecDeque<(u64, File)>,
    live: crate::live_text::LiveText,
    bytes: u64,
    source_cursor: u64,
    fail_sync: Option<SyncStage>,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid packed probe segment")
}

pub(super) fn segment_path(directory: &Path, number: u64) -> PathBuf {
    directory.join(format!("{number:016}.pair-probe"))
}

fn line(value: serde_json::Value) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn sync(stage: SyncStage, fault: &mut Option<SyncStage>, file: &File) -> io::Result<()> {
    if *fault == Some(stage) {
        *fault = None;
        return Err(io::Error::other("injected probe sync failure"));
    }
    file.sync_all()
}

impl PackedJournal {
    pub(super) fn open(
        root: &Path,
        id: Uuid,
        metadata: Metadata,
        limits: Limits,
        name: &str,
    ) -> io::Result<Self> {
        if !limits.valid() || limits.segment_bytes > MAX_SEGMENT {
            return Err(invalid());
        }
        let mut guards = storage::guards(root)?;
        let directory = root.join(id.to_string());
        fs::create_dir(&directory)?;
        guards.push(storage::pin(&directory)?);
        let live = crate::live_text::LiveText::open(
            root.parent().ok_or_else(invalid)?,
            name,
            &metadata,
            id,
            crate::live_text::MAX_LIVE_BYTES,
        )?;
        let source_cursor = metadata.source_cursor;
        let text_cursor = metadata.text_cursor;
        let mut journal = Self {
            _guards: guards,
            directory,
            id,
            metadata,
            limits,
            segments: VecDeque::new(),
            live,
            bytes: 0,
            source_cursor,
            fail_sync: None,
        };
        journal.rotate(1, source_cursor, text_cursor)?;
        Ok(journal)
    }

    fn rotate(&mut self, number: u64, source_cursor: u64, text_cursor: u64) -> io::Result<()> {
        if let Some((_, current)) = self.segments.back() {
            sync(SyncStage::Rotation, &mut self.fail_sync, current)?;
        }
        if self.segments.len() == self.limits.segments as usize {
            crate::selected_save::remove_owned(&self.segments.front().unwrap().1)?;
            self.segments.pop_front();
        }
        // Keep these bounded handles exclusive until retirement or stop.
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .access_mode(FILE_GENERIC_WRITE | DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(segment_path(&self.directory, number))?;
        let header = serde_json::to_vec(&SegmentHeader {
            format_version: 1, // v1 projection metadata; the packed envelope has its own magic.
            log_id: self.id,
            segment: number,
            metadata: self.metadata.clone(),
            limits: self.limits,
            source_cursor,
            text_cursor,
        })?;
        file.write_all(MAGIC)?;
        file.write_all(&(header.len() as u32).to_le_bytes())?;
        file.write_all(&header)?;
        self.bytes = 12 + header.len() as u64;
        self.segments.push_back((number, file));
        Ok(())
    }
}

impl Journal for PackedJournal {
    fn append(&mut self, record: &Record) -> io::Result<(u64, u64)> {
        let raw = format::raw_frame(record);
        let text = line(serde_json::json!({"type":"output","event":record.text}))?;
        let mut frame = Vec::with_capacity(8 + raw.len() + text.len() + 32);
        frame.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        frame.extend_from_slice(&(text.len() as u32).to_le_bytes());
        frame.extend_from_slice(&raw);
        frame.extend_from_slice(&text);
        frame.extend_from_slice(&Sha256::digest(&frame));
        let size = frame.len() as u64;
        let (current, _) = self.segments.back().unwrap();
        if self.bytes + size > self.limits.segment_bytes {
            let next = current.checked_add(1).ok_or_else(invalid)?;
            let source = record
                .raw
                .as_ref()
                .map_or(self.source_cursor, |raw| raw.seq);
            self.rotate(next, source, record.text.seq)?;
        }
        if self.bytes + size > self.limits.segment_bytes {
            return Err(invalid());
        }
        let (last, file) = self.segments.back_mut().unwrap();
        let last = *last;
        file.write_all(&frame)?;
        self.live.append(record)?;
        self.bytes += size;
        if let Some(raw) = &record.raw {
            self.source_cursor = raw.seq + 1;
        }
        Ok((self.segments.front().unwrap().0, last))
    }

    fn checkpoint(&mut self, durable: bool) -> io::Result<()> {
        self.live.checkpoint(false)?;
        if durable {
            sync(
                SyncStage::Segment,
                &mut self.fail_sync,
                &self.segments.back().unwrap().1,
            )?;
            sync(
                SyncStage::Live,
                &mut self.fail_sync,
                self.live.probe_sync_file(),
            )?;
            self.live.probe_publish_synced();
        }
        Ok(())
    }

    fn readable(&self) -> Option<ReadableStatus> {
        Some(self.live.status.clone())
    }

    fn finish(&mut self, status: &Status) -> io::Result<()> {
        self.checkpoint(true)?;
        let marker = self.directory.join("completion.partial");
        let mut file = storage::file(&marker)?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({
                "format_version": 2,
                "written_records": status.written_records,
                "first_retained_segment": self.segments.front().unwrap().0,
                "last_segment": self.segments.back().unwrap().0,
            }),
        )?;
        file.sync_all()?;
        drop(file);
        storage::publish(&marker, &self.directory.join("completion.json"))
    }
}

/// Test-only projection. The bool denotes a complete physical segment boundary,
/// independent of the completion marker and published sync watermarks.
pub(super) fn project(bytes: &[u8]) -> io::Result<(Vec<u8>, Vec<u8>, bool)> {
    let header_len = bytes.get(8..12).ok_or_else(invalid)?;
    let header_len = u32::from_le_bytes(header_len.try_into().unwrap()) as usize;
    if !bytes.starts_with(MAGIC)
        || !(1..=4096).contains(&header_len)
        || bytes.len() as u64 > MAX_SEGMENT
    {
        return Err(invalid());
    }
    let header = bytes.get(12..12 + header_len).ok_or_else(invalid)?;
    let parsed: SegmentHeader = serde_json::from_slice(header)?;
    let mut raw = format::MAGIC.to_vec();
    raw.extend_from_slice(&(header_len as u32).to_le_bytes());
    raw.extend_from_slice(header);
    let mut text = line(serde_json::json!({"type":"header","header":parsed}))?;
    let mut rest = &bytes[12 + header_len..];
    while !rest.is_empty() {
        let Some(lengths) = rest.get(..8) else { break };
        let raw_size = u32::from_le_bytes(lengths[..4].try_into().unwrap()) as usize;
        let text_size = u32::from_le_bytes(lengths[4..].try_into().unwrap()) as usize;
        if !(37..=session_core::session::EVENT_BYTES + 37).contains(&raw_size)
            || !(1..=crate::MAX_TEXT * 6 + 512).contains(&text_size)
            || raw_size + text_size > MAX_FRAME
        {
            break;
        }
        let body_end = 8 + raw_size + text_size;
        let Some(frame) = rest.get(..body_end + 32) else {
            break;
        };
        if frame[body_end..] != Sha256::digest(&frame[..body_end])[..] {
            break;
        }
        raw.extend_from_slice(&frame[8..8 + raw_size]);
        text.extend_from_slice(&frame[8 + raw_size..body_end]);
        rest = &rest[frame.len()..];
    }
    Ok((raw, text, rest.is_empty()))
}

#[test]
fn p22_packed_projection_matches_v1_and_rejects_bad_tail() {
    let temp = Temp::new();
    let pair = temp.0.join("pair");
    let packed = temp.0.join("packed");
    fs::create_dir(&pair).unwrap();
    fs::create_dir(&packed).unwrap();
    let ordinary_root = ManagedRoot::open(&pair).unwrap();
    let packed_root = ManagedRoot::open(&packed).unwrap();
    let meta = metadata();
    let id = Uuid::new_v4();
    let limits = Limits {
        segment_bytes: MAX_SEGMENT,
        segments: 2,
    };
    let mut ordinary = storage::FileJournal::open_readable(
        ordinary_root.path().to_owned(),
        id,
        meta.clone(),
        limits,
        "probe",
    )
    .unwrap();
    let mut probe =
        PackedJournal::open(packed_root.path(), id, meta.clone(), limits, "probe").unwrap();
    for seq in 1..=4 {
        let record = data(&meta, seq, &[b'x', 0, b'\n', b'\\']);
        assert_eq!(
            ordinary.append(&record).unwrap(),
            probe.append(&record).unwrap()
        );
    }
    probe.checkpoint(false).unwrap();
    let state = probe.readable().unwrap();
    assert_eq!(
        (
            state.written_records,
            state.flushed_records,
            state.synced_records
        ),
        (4, 4, 0)
    );
    ordinary.checkpoint(true).unwrap();
    probe.checkpoint(true).unwrap();
    let normal = ordinary.readable().unwrap();
    let state = probe.readable().unwrap();
    assert_eq!(state.synced_records, 4);
    assert_eq!(state.synced_bytes, normal.synced_bytes);
    drop(ordinary);
    drop(probe);
    let ordinary_dir = ordinary_root.path().join(id.to_string());
    let bytes = fs::read(segment_path(&packed_root.path().join(id.to_string()), 1)).unwrap();
    let (raw, text, complete) = project(&bytes).unwrap();
    assert!(complete);
    assert_eq!(
        raw,
        fs::read(ordinary_dir.join("0000000000000001.rawlog")).unwrap()
    );
    assert_eq!(
        text,
        fs::read(ordinary_dir.join("0000000000000001.text.jsonl")).unwrap()
    );
    assert_eq!(
        fs::read(pair.join("logs").join(normal.filename)).unwrap(),
        fs::read(packed.join("logs").join(state.filename)).unwrap(),
    );
    let mut corrupt = bytes.clone();
    let last = corrupt.len() - 1;
    corrupt[last] ^= 1;
    for bad in [&bytes[..bytes.len() - 1], corrupt.as_slice()] {
        let (raw_prefix, text_prefix, complete) = project(bad).unwrap();
        assert!(!complete);
        let mut reader = PairReader::new(raw_prefix.as_slice(), text_prefix.as_slice()).unwrap();
        for seq in 1..=3 {
            let row = reader.next_record().unwrap().unwrap();
            assert_eq!(row.text.seq, seq);
        }
        assert!(reader.next_record().unwrap().is_none());
    }
}

#[test]
fn p22_packed_sync_fault_keeps_common_watermark_and_stop_fails_closed() {
    for stage in [SyncStage::Segment, SyncStage::Live] {
        let temp = Temp::new();
        let root = ManagedRoot::open(&temp.0).unwrap();
        let meta = metadata();
        let path = root.path().to_owned();
        let mut logger = Logger::spawn(meta.clone(), move |id, meta| {
            let mut journal = PackedJournal::open(
                &path,
                id,
                meta.clone(),
                Limits {
                    segment_bytes: MAX_SEGMENT,
                    segments: 2,
                },
                "probe",
            )?;
            journal.fail_sync = Some(stage);
            Ok(Box::new(journal))
        })
        .unwrap();
        assert!(logger.submit(data(&meta, 1, b"admitted before failed sync")));
        logger.stop();
        let result = logger.join();
        assert_eq!(result.failure, Some(Failure::Storage));
        assert!(result.worker_finished);
        assert!(!result.durable);
        assert_eq!(result.written_records, 1);
        assert_eq!(result.readable.unwrap().synced_records, 0);
        assert!(
            !root
                .path()
                .join(result.log_id.to_string())
                .join("completion.json")
                .exists()
        );
    }
}

#[test]
fn p22_packed_rotation_retires_owned_handle_and_keeps_retained_prefix() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let path = root.path().to_owned();
    let limits = Limits {
        segment_bytes: 128 * 1024,
        segments: 1,
    };
    let mut logger = Logger::spawn(meta.clone(), move |id, meta| {
        Ok(Box::new(PackedJournal::open(
            &path,
            id,
            meta.clone(),
            limits,
            "probe",
        )?))
    })
    .unwrap();
    for seq in 1..=20 {
        assert!(logger.submit(data(&meta, seq, &[b'x'; 4096])));
    }
    logger.stop();
    let result = logger.join();
    assert!(result.durable);
    assert_eq!(result.written_records, 20);
    assert_eq!(
        (
            result.first_retained_segment,
            result.last_segment,
            result.retired_segments
        ),
        (2, 2, 1)
    );
    assert_eq!(result.readable.unwrap().synced_records, 20);
    let directory = root.path().join(result.log_id.to_string());
    assert!(!segment_path(&directory, 1).exists());
    let retained = fs::read(segment_path(&directory, 2)).unwrap();
    assert!(retained.len() as u64 <= limits.segment_bytes);
    let (raw, text, complete) = project(&retained).unwrap();
    assert!(complete);
    let mut reader = PairReader::new(raw.as_slice(), text.as_slice()).unwrap();
    assert_eq!(reader.header().text_cursor, 16);
    for seq in 16..=20 {
        let row = reader.next_record().unwrap().unwrap();
        assert_eq!(row.text.seq, seq);
        assert_eq!(row.raw.unwrap().bytes, [b'x'; 4096]);
    }
    assert!(reader.next_record().unwrap().is_none());
    assert!(directory.join("completion.json").exists());
}

#[test]
fn p22_packed_rotation_sync_failure_cannot_retire_old_segment() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let id = Uuid::new_v4();
    let limits = Limits {
        segment_bytes: 128 * 1024,
        segments: 1,
    };
    let mut journal = PackedJournal::open(root.path(), id, meta.clone(), limits, "probe").unwrap();
    for seq in 1..=15 {
        journal.append(&data(&meta, seq, &[b'x'; 4096])).unwrap();
    }
    journal.checkpoint(true).unwrap();
    journal.fail_sync = Some(SyncStage::Rotation);
    assert!(journal.append(&data(&meta, 16, &[b'x'; 4096])).is_err());
    let state = journal.readable().unwrap();
    assert_eq!((state.written_records, state.synced_records), (15, 15));
    drop(journal);
    let directory = root.path().join(id.to_string());
    assert!(segment_path(&directory, 1).exists());
    assert!(!segment_path(&directory, 2).exists());
    assert!(!directory.join("completion.json").exists());
}

#[test]
#[ignore = "one owned D-volume pair per checkpoint shape; no T19 calibration load"]
fn p22_packed_checkpoint_shapes() {
    use std::sync::Barrier;
    use std::time::Instant;

    const SOURCES: usize = 8;
    const RECORDS: u64 = 16;
    const AUDIT_SLOTS: u64 = 32;
    let temp = Temp::new();
    let mut results = Vec::new();
    // Exactly one observation per cell. Measure from append entry through sync
    // return, with either (1,1) or (1,2) required from the measured append.
    for (rotate, packed) in [(false, false), (false, true), (true, false), (true, true)] {
        let folder = temp.0.join(format!("{rotate}-{packed}"));
        fs::create_dir(&folder).unwrap();
        let root = ManagedRoot::open(&folder).unwrap();
        let limits = Limits {
            segment_bytes: if rotate { 128 * 1024 } else { MAX_SEGMENT },
            segments: 2,
        };
        let audit = crate::audit::Writer::open(&folder, Uuid::new_v4()).unwrap();
        let sink = audit.sink();
        let mut streams = Vec::new();
        for index in 0..SOURCES {
            let id = Uuid::new_v4();
            let meta = metadata();
            let bytes = [b'a' + index as u8; 4096];
            let mut journal: Box<dyn Journal> = if packed {
                Box::new(
                    PackedJournal::open(root.path(), id, meta.clone(), limits, "probe").unwrap(),
                )
            } else {
                Box::new(
                    storage::FileJournal::open_readable(
                        root.path().to_owned(),
                        id,
                        meta.clone(),
                        limits,
                        "probe",
                    )
                    .unwrap(),
                )
            };
            for seq in 1..RECORDS {
                assert_eq!(journal.append(&data(&meta, seq, &bytes)).unwrap(), (1, 1));
            }
            streams.push((id, meta, bytes, journal));
        }
        let barrier = Barrier::new(SOURCES + 1);
        let began = Instant::now();
        let last_segment = if rotate { 2 } else { 1 };
        let samples = thread::scope(|scope| {
            let workers: Vec<_> = streams
                .iter_mut()
                .map(|(_, meta, bytes, journal)| {
                    let barrier = &barrier;
                    scope.spawn(move || {
                        let row = data(meta, RECORDS, bytes);
                        barrier.wait();
                        let start = Instant::now();
                        assert_eq!(journal.append(&row).unwrap(), (1, last_segment));
                        let append_ns = start.elapsed().as_nanos();
                        journal.checkpoint(true).unwrap();
                        let total_ns = start.elapsed().as_nanos();
                        assert_eq!(journal.readable().unwrap().synced_records, RECORDS);
                        [append_ns, total_ns]
                    })
                })
                .collect();
            barrier.wait();
            let offered = Instant::now();
            let mut accepted = 0;
            let audit_meta = metadata();
            for slot in 0..AUDIT_SLOTS {
                let due = Duration::from_nanos(slot * 1_000_000_000 / 65);
                if let Some(delay) = due.checked_sub(offered.elapsed()) {
                    thread::sleep(delay);
                }
                accepted += super::throughput::submit_audit_burst(&sink, &audit_meta, slot, began);
            }
            assert_eq!(accepted, AUDIT_SLOTS * 3);
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        let audit = audit.close().unwrap();
        assert_eq!(audit.synced_through, AUDIT_SLOTS * 3);
        assert_eq!(audit.rejected_records, 0);
        assert_eq!(audit.incomplete_segments, 0);

        for (id, meta, bytes, journal) in streams {
            let readable = journal.readable().unwrap();
            drop(journal);
            let directory = root.path().join(id.to_string());
            let mut next = 1;
            for number in 1..=last_segment {
                let (raw, text) = if packed {
                    let (raw, text, complete) =
                        project(&fs::read(segment_path(&directory, number)).unwrap()).unwrap();
                    assert!(complete);
                    (raw, text)
                } else {
                    (
                        fs::read(directory.join(format!("{number:016}.rawlog"))).unwrap(),
                        fs::read(directory.join(format!("{number:016}.text.jsonl"))).unwrap(),
                    )
                };
                let mut reader = PairReader::new(raw.as_slice(), text.as_slice()).unwrap();
                assert_eq!(reader.header().text_cursor, next);
                while let Some(row) = reader.next_record().unwrap() {
                    assert_eq!(row.text.seq, next);
                    assert_eq!(row.raw.unwrap().bytes, bytes);
                    assert_eq!(row.text, data(&meta, next, &bytes).text);
                    next += 1;
                }
            }
            assert_eq!(next, RECORDS + 1);
            let live = fs::read(folder.join("logs").join(readable.filename)).unwrap();
            assert_eq!(live.len() as u64, readable.synced_bytes);
            assert_eq!(
                live[live.len() - RECORDS as usize * bytes.len()..],
                bytes.repeat(RECORDS as usize)
            );
        }
        results.push(serde_json::json!({
            "packed": packed,
            "rotation": rotate,
            "append_and_total_ns_by_source": samples,
            "audit_synced": audit.synced_through,
        }));
    }
    println!(
        "P22_PACKED_CHECKPOINT_SHAPES {}",
        serde_json::json!(results)
    );
}
