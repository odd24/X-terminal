use super::*;
use std::{
    fs,
    io::Cursor,
    sync::{
        Condvar,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-journal-中文-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-journal-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn metadata() -> Metadata {
    Metadata {
        connection: ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        },
        protocol: Protocol::Serial,
        encoding: "utf-8".into(),
        started_at_ms: 123,
        source_cursor: 1,
        text_cursor: 1,
    }
}
fn data(meta: &Metadata, seq: u64, bytes: &[u8]) -> Record {
    Record {
        connection: meta.connection,
        raw: Some(OutputEvent {
            seq,
            timestamp_ms: seq + 100,
            bytes: bytes.into(),
            gap_bytes: None,
        }),
        text: TextEvent {
            seq,
            source_seq: Some(seq),
            timestamp_ms: seq + 100,
            text: String::from_utf8_lossy(bytes).into(),
            decode_error: false,
            gap_bytes: None,
        },
    }
}
fn eof(meta: &Metadata, seq: u64) -> Record {
    Record {
        connection: meta.connection,
        raw: None,
        text: TextEvent {
            seq,
            source_seq: None,
            timestamp_ms: 777,
            text: "�".into(),
            decode_error: true,
            gap_bytes: None,
        },
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "journal did not settle");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn root(temp: &Temp, logger: &Logger) -> PathBuf {
    temp.0.join(logger.status().log_id.to_string())
}
fn read_pair(
    directory: &std::path::Path,
    segment: u64,
) -> (SegmentHeader, Vec<RawFrame>, Vec<serde_json::Value>) {
    let mut reader =
        RawReader::new(fs::File::open(directory.join(format!("{segment:016}.rawlog"))).unwrap())
            .unwrap();
    let mut raw = Vec::new();
    while let Some(record) = reader.next_record().unwrap() {
        raw.push(record);
    }
    let text = fs::read_to_string(directory.join(format!("{segment:016}.text.jsonl")))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    (reader.header, raw, text)
}

#[test]
fn raw_bytes_text_gaps_and_eof_survive_real_files_without_fabricated_bytes() {
    let temp = Temp::new();
    let mut meta = metadata();
    meta.encoding = "gbk".into();
    let mut logger = Logger::start(temp.0.clone(), meta.clone(), Limits::default()).unwrap();
    let mut first = data(&meta, 1, &[0, 255, 13, 10, 0xd6]);
    first.text.text = "\0�\r\n".into();
    first.text.decode_error = true;
    assert_eq!(format!("{first:?}"), "Record([TERMINAL_CONTENT])");
    assert!(logger.submit(first.clone()));
    let gap = Record {
        connection: meta.connection,
        raw: Some(OutputEvent {
            seq: 2,
            timestamp_ms: 44,
            bytes: vec![],
            gap_bytes: Some(13),
        }),
        text: TextEvent {
            seq: 2,
            source_seq: Some(2),
            timestamp_ms: 44,
            text: String::new(),
            decode_error: false,
            gap_bytes: Some(13),
        },
    };
    assert!(logger.submit(gap));
    assert!(logger.submit(eof(&meta, 3)));
    let status = logger.join();
    assert_eq!(status.phase, Phase::Stopped);
    assert!(status.durable && status.worker_finished && status.natural_end);
    assert_eq!(status.written_records, 3);
    assert_eq!(status.written_raw_bytes, 5);
    let (header, raw, text) = read_pair(&root(&temp, &logger), 1);
    assert_eq!(header.metadata.connection, meta.connection);
    assert_eq!(header.metadata.encoding, "gbk");
    assert_eq!(raw[0].bytes, first.raw.unwrap().bytes);
    assert_eq!(raw[0].timestamp_ms, 101);
    assert_eq!(raw[1].gap_bytes, Some(13));
    assert_eq!(raw[2].source_seq, None);
    assert!(raw[2].bytes.is_empty());
    assert_eq!(text[1]["event"]["text"], "\0�\r\n");
    assert_eq!(text[2]["event"]["gap_bytes"], 13);
    assert_eq!(text[3]["event"]["text"], "�");
    assert!(text[3]["event"]["decode_error"].as_bool().unwrap());
    let completion: serde_json::Value =
        serde_json::from_slice(&fs::read(root(&temp, &logger).join("completion.json")).unwrap())
            .unwrap();
    assert_eq!(completion["written_records"], 3);
    assert_eq!(completion["natural_end"], true);
    let original = fs::read(root(&temp, &logger).join("0000000000000001.rawlog")).unwrap();
    assert_eq!(
        crate::storage::FileJournal::open(temp.0.clone(), status.log_id, meta, Limits::default())
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        fs::read(root(&temp, &logger).join("0000000000000001.rawlog")).unwrap(),
        original
    );
}

#[test]
fn rotation_caps_combined_pairs_and_reports_retired_sequences() {
    let temp = Temp::new();
    let meta = metadata();
    let limits = Limits {
        segment_bytes: 128 * 1024,
        segments: 2,
    };
    let mut logger = Logger::start(temp.0.clone(), meta.clone(), limits).unwrap();
    for seq in 1..=70 {
        let bytes = vec![b'A' + (seq % 26) as u8; EVENT_BYTES];
        assert!(logger.submit(data(&meta, seq, &bytes)));
        wait(|| logger.status().written_records == seq);
    }
    let status = logger.join();
    assert!(status.durable);
    assert!(!status.natural_end);
    assert!(status.retired_segments > 0);
    assert_eq!(status.last_segment - status.first_retained_segment + 1, 2);
    let directory = root(&temp, &logger);
    let files: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|e| e.unwrap())
        .collect();
    assert_eq!(
        files.len(),
        5,
        "two raw/text pairs and one completion marker"
    );
    let mut prior = None;
    for segment in status.first_retained_segment..=status.last_segment {
        let (header, raw, text) = read_pair(&directory, segment);
        assert_eq!(header.segment, segment);
        assert_eq!(header.source_cursor, raw[0].source_seq.unwrap());
        assert_eq!(raw.len() + 1, text.len());
        if let Some(previous) = prior {
            assert_eq!(raw[0].text_seq, previous + 1);
        }
        prior = raw.last().map(|r| r.text_seq);
        for record in raw {
            assert_eq!(
                record.bytes,
                vec![b'A' + (record.text_seq % 26) as u8; EVENT_BYTES]
            );
        }
        let total = fs::metadata(directory.join(format!("{segment:016}.rawlog")))
            .unwrap()
            .len()
            + fs::metadata(directory.join(format!("{segment:016}.text.jsonl")))
                .unwrap()
                .len();
        assert!(total <= limits.segment_bytes);
    }
    assert_eq!(prior, Some(70));
}

#[test]
fn largest_escaped_eof_rotates_with_current_source_cursor_and_bounded_allocations() {
    let temp = Temp::new();
    let meta = metadata();
    let limits = Limits {
        segment_bytes: 128 * 1024,
        segments: 2,
    };
    let mut logger = Logger::start(temp.0.clone(), meta.clone(), limits).unwrap();
    for seq in 1..=15 {
        assert!(logger.submit(data(&meta, seq, &[b'x'; EVENT_BYTES])));
        wait(|| logger.status().written_records == seq);
    }
    let mut final_record = eof(&meta, 16);
    final_record.text.text = String::with_capacity(4 * 1024 * 1024);
    final_record
        .text
        .text
        .extend(std::iter::repeat_n('\0', MAX_TEXT));
    final_record.text.decode_error = false;
    assert!(logger.submit(final_record));
    let status = logger.join();
    assert!(status.natural_end && status.durable);
    assert_eq!(status.last_segment, 2);
    let (header, frames, text) = read_pair(&root(&temp, &logger), 2);
    assert_eq!(
        header.source_cursor, 16,
        "EOF rotation preserves the next raw position"
    );
    assert_eq!(header.text_cursor, 16);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].source_seq, None);
    assert_eq!(text[1]["event"]["text"].as_str().unwrap().len(), MAX_TEXT);

    struct Capacity;
    impl Journal for Capacity {
        fn append(&mut self, record: &Record) -> io::Result<(u64, u64)> {
            assert!(record.raw.as_ref().unwrap().bytes.capacity() <= EVENT_BYTES);
            assert!(record.text.text.capacity() <= MAX_TEXT);
            Ok((1, 1))
        }
        fn finish(&mut self, _: &Status) -> io::Result<()> {
            Ok(())
        }
    }
    let mut logger = Logger::spawn(meta.clone(), |_, _| Ok(Box::new(Capacity))).unwrap();
    let mut oversized_capacity = data(&meta, 1, b"a");
    oversized_capacity
        .raw
        .as_mut()
        .unwrap()
        .bytes
        .reserve(4 * 1024 * 1024);
    oversized_capacity.text.text.reserve(4 * 1024 * 1024);
    assert!(logger.submit(oversized_capacity));
    assert!(logger.join().durable);
}

#[test]
fn scope_generation_sequence_and_record_limits_fail_closed_without_append_or_replay() {
    for mutation in 0..7 {
        let temp = Temp::new();
        let meta = metadata();
        let mut logger = Logger::start(temp.0.clone(), meta.clone(), Limits::default()).unwrap();
        assert!(logger.submit(data(&meta, 1, b"accepted")));
        wait(|| logger.status().written_records == 1);
        let mut bad = data(&meta, 2, b"never-write");
        match mutation {
            0 => bad.connection.generation += 1,
            1 => bad.connection.connection_id = ConnectionId(Uuid::new_v4()),
            2 => bad.text.seq = 1,
            3 => bad.raw.as_mut().unwrap().seq = 99,
            4 => bad.raw.as_mut().unwrap().bytes = vec![0; EVENT_BYTES + 1],
            5 => bad.text.text = "x".repeat(MAX_TEXT + 1),
            _ => bad.text.timestamp_ms += 1,
        }
        assert!(!logger.submit(bad));
        assert!(!logger.submit(data(&meta, 2, b"no-retry")));
        let status = logger.join();
        assert_eq!(status.failure, Some(Failure::InvalidRecord));
        assert_eq!(status.accepted_records, 1);
        assert_eq!(status.rejected_records, 2);
        assert!(!status.durable);
        let directory = root(&temp, &logger);
        assert!(!directory.join("completion.json").exists());
        let (_, raw, _) = read_pair(&directory, 1);
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].bytes, b"accepted");
    }
}

#[derive(Default)]
struct Gate {
    entered: AtomicUsize,
    open: Mutex<bool>,
    wake: Condvar,
    writes: AtomicUsize,
    finishes: AtomicUsize,
}
impl Gate {
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }
    fn block(&self) {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.wake.wait(open).unwrap();
        }
    }
}
struct Fake {
    gate: Arc<Gate>,
    disk_error: bool,
    finish_error: bool,
    panic: bool,
}
impl Journal for Fake {
    fn append(&mut self, _: &Record) -> io::Result<(u64, u64)> {
        self.gate.block();
        assert!(!self.panic, "synthetic worker panic");
        if self.disk_error {
            return Err(io::ErrorKind::StorageFull.into());
        }
        self.gate.writes.fetch_add(1, Ordering::SeqCst);
        Ok((1, 1))
    }
    fn finish(&mut self, _: &Status) -> io::Result<()> {
        if self.finish_error {
            return Err(io::ErrorKind::StorageFull.into());
        }
        self.gate.finishes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn a_blocked_writer_keeps_queue_bounded_and_overflow_never_claims_clean_completion() {
    let meta = metadata();
    let gate = Arc::new(Gate::default());
    let factory = gate.clone();
    let mut logger = Logger::spawn(meta.clone(), move |_, _| {
        Ok(Box::new(Fake {
            gate: factory,
            disk_error: false,
            finish_error: false,
            panic: false,
        }))
    })
    .unwrap();
    assert!(logger.submit(data(&meta, 1, b"inflight")));
    wait(|| gate.entered.load(Ordering::SeqCst) == 1);
    for seq in 2..=33 {
        assert!(logger.submit(data(&meta, seq, b"queued")));
    }
    assert!(!logger.submit(data(&meta, 34, b"lost")));
    assert!(!logger.submit(data(&meta, 35, b"lost-too")));
    let status = logger.status();
    assert_eq!(status.failure, Some(Failure::QueueFull));
    assert_eq!(status.accepted_records, (QUEUE_RECORDS + 1) as u64);
    assert!(!status.worker_finished);
    gate.release();
    let status = logger.join();
    assert_eq!(status.written_records, 33);
    assert_eq!(gate.writes.load(Ordering::SeqCst), 33);
    assert_eq!(gate.finishes.load(Ordering::SeqCst), 0);
    assert!(!status.durable);
}

#[test]
fn manual_stop_drains_accepted_prefix_and_midstream_cursors_remain_independent() {
    let meta = metadata();
    let gate = Arc::new(Gate::default());
    let factory = gate.clone();
    let mut logger = Logger::spawn(meta.clone(), move |_, _| {
        Ok(Box::new(Fake {
            gate: factory,
            disk_error: false,
            finish_error: false,
            panic: false,
        }))
    })
    .unwrap();
    assert!(logger.submit(data(&meta, 1, b"inflight")));
    wait(|| gate.entered.load(Ordering::SeqCst) == 1);
    assert!(logger.submit(data(&meta, 2, b"queued")));
    logger.stop();
    assert_eq!(logger.status().phase, Phase::Stopping);
    assert!(!logger.status().worker_finished);
    assert!(!logger.submit(data(&meta, 3, b"outside-capture-window")));
    gate.release();
    let status = logger.join();
    assert!(status.durable && !status.natural_end);
    assert_eq!(status.written_records, 2);
    assert_eq!(status.rejected_records, 1);
    assert_eq!(gate.finishes.load(Ordering::SeqCst), 1);

    let temp = Temp::new();
    let mut meta = meta;
    meta.source_cursor = 42;
    meta.text_cursor = 99;
    let mut logger = Logger::start(temp.0.clone(), meta.clone(), Limits::default()).unwrap();
    let mut record = data(&meta, 42, b"midstream");
    record.text.seq = 99;
    assert!(logger.submit(record));
    assert!(logger.submit(eof(&meta, 100)));
    assert!(logger.join().durable);
    let (header, records, text) = read_pair(&root(&temp, &logger), 1);
    assert_eq!((header.source_cursor, header.text_cursor), (42, 99));
    assert_eq!((records[0].source_seq, records[0].text_seq), (Some(42), 99));
    assert_eq!(text[1]["event"]["source_seq"], 42);
}

#[test]
fn disk_full_sync_failure_and_worker_panic_preserve_incomplete_status() {
    #[cfg(windows)]
    for code in [39, 112] {
        assert_eq!(
            failure(&io::Error::from_raw_os_error(code)),
            Failure::DiskFull
        );
    }
    for mode in 0..3 {
        let meta = metadata();
        let gate = Arc::new(Gate::default());
        gate.release();
        let factory = gate.clone();
        let mut logger = Logger::spawn(meta.clone(), move |_, _| {
            Ok(Box::new(Fake {
                gate: factory,
                disk_error: mode == 0,
                finish_error: mode == 1,
                panic: mode == 2,
            }))
        })
        .unwrap();
        assert!(logger.submit(data(&meta, 1, b"one")));
        let status = logger.join();
        assert_eq!(status.phase, Phase::Failed);
        assert!(!status.durable);
        assert!(status.worker_finished);
        assert_eq!(
            status.failure,
            Some(if mode == 2 {
                Failure::WorkerPanicked
            } else {
                Failure::DiskFull
            })
        );
        assert_eq!(status.written_records, u64::from(mode == 1));
    }
}

#[test]
fn completion_publication_refuses_existing_partial_or_final_and_never_overwrites() {
    for name in ["completion.partial", "completion.json"] {
        let temp = Temp::new();
        let meta = metadata();
        let mut logger = Logger::start(temp.0.clone(), meta.clone(), Limits::default()).unwrap();
        assert!(logger.submit(data(&meta, 1, b"paired-prefix")));
        wait(|| logger.status().written_records == 1);
        let directory = root(&temp, &logger);
        fs::write(directory.join(name), b"sentinel-must-not-change").unwrap();
        let status = logger.join();
        assert_eq!(status.phase, Phase::Failed);
        assert_eq!(status.failure, Some(Failure::Storage));
        assert!(!status.durable);
        assert_eq!(
            fs::read(directory.join(name)).unwrap(),
            b"sentinel-must-not-change"
        );
        if name == "completion.partial" {
            assert!(!directory.join("completion.json").exists());
        }
        let (_, records, _) = read_pair(&directory, 1);
        assert_eq!(records[0].bytes, b"paired-prefix");
    }
}

#[test]
fn raw_reader_rejects_truncated_and_oversized_frames_before_large_allocation() {
    let meta = metadata();
    let header = SegmentHeader {
        format_version: 1,
        log_id: Uuid::new_v4(),
        segment: 1,
        source_cursor: 1,
        text_cursor: 1,
        metadata: meta.clone(),
        limits: Limits::default(),
    };
    let body = serde_json::to_vec(&header).unwrap();
    let mut bytes = format::MAGIC.to_vec();
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    let prefix = bytes.clone();
    bytes.extend_from_slice(&format::raw_frame(&data(&meta, 1, b"raw\0\xff\r\n")));
    for cut in prefix.len() + 1..bytes.len() {
        let mut reader = RawReader::new(Cursor::new(&bytes[..cut])).unwrap();
        assert_eq!(
            reader.next_record().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    let mut oversized = prefix.clone();
    oversized.extend_from_slice(&u32::MAX.to_le_bytes());
    let mut reader = RawReader::new(Cursor::new(oversized)).unwrap();
    assert_eq!(
        reader.next_record().unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert!(
        reader.next_record().is_err(),
        "a bad frame permanently invalidates this reader"
    );
    let mut reader = RawReader::new(Cursor::new(bytes)).unwrap();
    assert_eq!(
        reader.next_record().unwrap().unwrap().bytes,
        b"raw\0\xff\r\n"
    );
    assert!(reader.next_record().unwrap().is_none());
    let mut bad = prefix;
    bad.extend_from_slice(&format::raw_frame(&data(&meta, 2, b"wrong-sequence")));
    assert_eq!(
        RawReader::new(Cursor::new(bad))
            .unwrap()
            .next_record()
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}

#[test]
fn setup_errors_missing_root_and_counters_are_reported_without_overwriting_existing_files() {
    let temp = Temp::new();
    let meta = metadata();
    assert!(Logger::start(PathBuf::from("relative"), meta.clone(), Limits::default()).is_err());
    assert!(
        Logger::start(
            temp.0.clone(),
            meta.clone(),
            Limits {
                segment_bytes: 1,
                segments: 0
            }
        )
        .is_err()
    );
    let sentinel = temp.0.join("keep.txt");
    fs::write(&sentinel, b"unchanged").unwrap();
    let mut logger =
        Logger::start(temp.0.join("missing"), meta.clone(), Limits::default()).unwrap();
    let status = logger.join();
    assert_eq!(status.failure, Some(Failure::Storage));
    assert!(!status.durable);
    assert_eq!(fs::read(sentinel).unwrap(), b"unchanged");
    let mut traversal = Logger::start(
        temp.0.join("sub").join("..").join("escape"),
        meta.clone(),
        Limits::default(),
    )
    .unwrap();
    assert_eq!(traversal.join().failure, Some(Failure::Storage));
    let mut high = meta;
    high.text_cursor = u64::MAX;
    let mut logger = Logger::start(temp.0.clone(), high.clone(), Limits::default()).unwrap();
    assert!(!logger.submit(eof(&high, u64::MAX)));
    assert_eq!(logger.join().failure, Some(Failure::CounterExhausted));
}

#[cfg(windows)]
#[test]
fn directory_handles_prevent_live_rename_and_reparse_roots_are_rejected() {
    let temp = Temp::new();
    let meta = metadata();
    let mut logger = Logger::start(temp.0.clone(), meta.clone(), Limits::default()).unwrap();
    wait(|| logger.status().phase == Phase::Recording);
    let directory = root(&temp, &logger);
    assert!(fs::rename(&directory, directory.with_extension("moved")).is_err());
    assert!(fs::rename(&temp.0, temp.0.with_extension("moved")).is_err());
    logger.join();
    // Use an NTFS junction in the isolated temp directory; no elevated symlink privilege.
    let target = temp.0.join("target");
    fs::create_dir(&target).unwrap();
    let junction = temp.0.join("junction");
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "isolated junction fixture must be created"
    );
    let mut logger = Logger::start(junction.clone(), meta, Limits::default()).unwrap();
    assert_eq!(logger.join().failure, Some(Failure::Storage));
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    fs::remove_dir(junction).unwrap();
    for path in [r"\\invalid.fixture\share\logs", r"\\.\pipe\not-a-log-root"] {
        let mut logger = Logger::start(PathBuf::from(path), metadata(), Limits::default()).unwrap();
        assert_eq!(
            logger.join().failure,
            Some(Failure::Storage),
            "reject non-local prefixes before filesystem access"
        );
    }
}
