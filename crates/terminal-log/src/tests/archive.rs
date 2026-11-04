use super::*;

fn start(temp: &Temp) -> (ManagedRoot, Metadata, Logger) {
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let logger = Logger::start(
        root.path().to_path_buf(),
        meta.clone(),
        Limits {
            segment_bytes: 128 * 1024,
            segments: 2,
        },
    )
    .unwrap();
    (root, meta, logger)
}
fn drain(reader: &mut ArchiveReader) -> io::Result<Vec<Record>> {
    let mut records = Vec::new();
    loop {
        let page = reader.read_page(2, 32 * 1024)?;
        assert!(page.records.len() <= 2);
        let bytes: usize = page
            .records
            .iter()
            .map(|r| r.text.text.len() + r.raw.as_ref().map_or(0, |r| r.bytes.len()) + 256)
            .sum();
        assert!(bytes <= 32 * 1024);
        records.extend(page.records);
        if page.finished {
            return Ok(records);
        }
    }
}
fn completion_path(root: &ManagedRoot, id: Uuid) -> PathBuf {
    root.path().join(id.to_string()).join("completion.json")
}
fn edit_marker(root: &ManagedRoot, id: Uuid, change: impl FnOnce(&mut serde_json::Value)) {
    let path = completion_path(root, id);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    change(&mut value);
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn archive_survives_restart_and_streams_rotated_retained_range_with_exact_scope() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    for seq in 1..=70 {
        assert!(logger.submit(data(&meta, seq, &vec![seq as u8; EVENT_BYTES])));
        wait(|| logger.status().written_records == seq);
    }
    assert!(logger.submit(eof(&meta, 71)));
    let status = logger.join();
    assert!(status.durable);
    assert!(status.retired_segments > 0);
    drop(logger);
    drop(root);
    let root = ManagedRoot::open(&temp.0).unwrap();
    assert_eq!(root.ids().unwrap(), [status.log_id]);
    let mut reader = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    let first = reader.info().available_from;
    assert!(first > 1);
    assert_eq!(reader.info().metadata, meta);
    assert_eq!(reader.info().completion.written_records, 71);
    let records = drain(&mut reader).unwrap();
    assert_eq!(records.first().unwrap().text.seq, first);
    assert_eq!(records.last().unwrap().text.seq, 71);
    assert!(records.last().unwrap().raw.is_none());
    for record in records.iter().filter(|r| r.raw.is_some()) {
        let raw = record.raw.as_ref().unwrap();
        assert_eq!(raw.bytes, vec![raw.seq as u8; EVENT_BYTES]);
    }
    let done = reader.read_page(1, 32 * 1024).unwrap();
    assert!(done.finished && done.records.is_empty());
    assert_eq!(done.next_cursor, 72);
    let wrong = ConnectionRef {
        generation: 2,
        ..meta.connection
    };
    assert!(ArchiveReader::open(&root, status.log_id, wrong).is_err());
    assert!(ArchiveReader::open(&root, Uuid::new_v4(), meta.connection).is_err());
}

#[test]
fn archive_counts_gap_and_raw_bytes_and_preserves_unknown_legacy_gap_counter() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    assert!(logger.submit(data(&meta, 1, &[0, 255, 13, 10])));
    let mut gap = data(&meta, 2, &[]);
    gap.raw.as_mut().unwrap().gap_bytes = Some(13);
    gap.text.gap_bytes = Some(13);
    assert!(logger.submit(gap));
    logger.stop();
    let status = logger.join();
    assert!(status.durable);
    let mut reader = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    assert!(!reader.info().completion.natural_end);
    assert_eq!(reader.info().completion.source_gap_bytes, Some(13));
    assert_eq!(drain(&mut reader).unwrap().len(), 2);
    drop(reader);
    edit_marker(&root, status.log_id, |v| {
        v.as_object_mut().unwrap().remove("source_gap_bytes");
    });
    let mut legacy = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    assert_eq!(legacy.info().completion.source_gap_bytes, None);
    assert_eq!(drain(&mut legacy).unwrap().len(), 2);
}

#[test]
fn source_gap_overflow_fails_before_acceptance_or_completion() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    for (seq, lost) in [(1, u64::MAX), (2, 1)] {
        let mut gap = data(&meta, seq, &[]);
        gap.raw.as_mut().unwrap().gap_bytes = Some(lost);
        gap.text.gap_bytes = Some(lost);
        assert_eq!(logger.submit(gap), seq == 1);
        if seq == 1 {
            wait(|| logger.status().written_records == 1);
        }
    }
    let status = logger.join();
    assert_eq!(status.failure, Some(Failure::CounterExhausted));
    assert_eq!(status.source_gap_bytes, u64::MAX);
    assert_eq!((status.accepted_records, status.rejected_records), (1, 1));
    assert!(!status.durable);
    assert!(!completion_path(&root, status.log_id).exists());
    assert!(ArchiveReader::open(&root, status.log_id, meta.connection).is_err());
}

#[test]
fn archive_rejects_incomplete_extra_oversize_and_incorrect_completion() {
    for case in 0..11 {
        let temp = Temp::new();
        let (root, meta, mut logger) = start(&temp);
        assert!(logger.submit(data(&meta, 1, b"actual")));
        logger.stop();
        let status = logger.join();
        let directory = root.path().join(status.log_id.to_string());
        match case {
            0 => fs::rename(
                completion_path(&root, status.log_id),
                directory.join("completion.partial"),
            )
            .unwrap(),
            1 => fs::write(directory.join("unexpected"), b"preserve").unwrap(),
            2 => fs::write(completion_path(&root, status.log_id), vec![b' '; 1025]).unwrap(),
            3 => edit_marker(&root, status.log_id, |v| {
                v["last_segment"] = u64::MAX.into()
            }),
            4 => edit_marker(&root, status.log_id, |v| v["written_records"] = 2.into()),
            5 => edit_marker(&root, status.log_id, |v| v["written_raw_bytes"] = 7.into()),
            6 => edit_marker(&root, status.log_id, |v| v["natural_end"] = true.into()),
            7 => edit_marker(&root, status.log_id, |v| v["source_gap_bytes"] = 1.into()),
            8 => {
                fs::OpenOptions::new()
                    .write(true)
                    .open(directory.join("0000000000000001.rawlog"))
                    .unwrap()
                    .set_len(100 * 1024 * 1024 + 1)
                    .unwrap();
            }
            9 => {
                fs::OpenOptions::new()
                    .write(true)
                    .open(directory.join("0000000000000001.rawlog"))
                    .unwrap()
                    .set_len(128 * 1024)
                    .unwrap();
            }
            10 => {
                fs::remove_file(directory.join("0000000000000001.rawlog")).unwrap();
                assert_eq!(
                    ArchiveReader::inspect(&root, status.log_id)
                        .unwrap_err()
                        .kind(),
                    io::ErrorKind::InvalidData
                );
            }
            _ => unreachable!(),
        }
        match ArchiveReader::open(&root, status.log_id, meta.connection) {
            Err(_) => {}
            Ok(mut reader) => {
                assert!(drain(&mut reader).is_err(), "case {case}");
                assert!(reader.read_page(1, 32 * 1024).is_err(), "error must latch");
            }
        }
        assert!(directory.exists());
    }
}

#[test]
fn archive_empty_manual_stop_and_page_arguments_do_not_forge_or_move_cursor() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    logger.stop();
    let status = logger.join();
    let mut reader = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    assert!(reader.read_page(0, 32 * 1024).is_err());
    assert!(reader.read_page(129, 32 * 1024).is_err());
    assert!(reader.read_page(1, 1024).is_err());
    assert!(reader.read_page(1, 256 * 1024 + 1).is_err());
    let page = reader.read_page(1, 32 * 1024).unwrap();
    assert!(page.records.is_empty() && page.finished);
    assert_eq!(page.next_cursor, 1);
}

#[test]
fn archive_byte_budget_lookahead_keeps_public_cursors_and_records_exact() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    for seq in 1..=8 {
        let mut record = data(&meta, seq, &[b'x'; EVENT_BYTES]);
        record.text.text = "x".repeat(MAX_TEXT);
        assert!(logger.submit(record));
        wait(|| logger.status().written_records == seq);
    }
    logger.stop();
    let status = logger.join();
    let mut reader = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    for seq in 1..=8 {
        let page = reader.read_page(128, 32 * 1024).unwrap();
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].text.seq, seq);
        assert_eq!(page.next_cursor, seq + 1);
    }
    assert!(reader.read_page(128, 32 * 1024).unwrap().finished);
}

#[test]
fn archive_detects_discontinuous_segments_even_when_each_pair_is_valid() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    for seq in 1..=20 {
        assert!(logger.submit(data(&meta, seq, &[b'x'; EVENT_BYTES])));
        wait(|| logger.status().written_records == seq);
    }
    logger.stop();
    let status = logger.join();
    assert_eq!(status.first_retained_segment, 1);
    assert_eq!(status.last_segment, 2);
    let directory = root.path().join(status.log_id.to_string());
    let raw_path = directory.join("0000000000000002.rawlog");
    let text_path = directory.join("0000000000000002.text.jsonl");
    let mut pair = PairReader::new(
        fs::File::open(&raw_path).unwrap(),
        fs::File::open(&text_path).unwrap(),
    )
    .unwrap();
    let mut header = pair.header().clone();
    header.source_cursor += 10;
    header.text_cursor += 10;
    let body = serde_json::to_vec(&header).unwrap();
    let mut raw = format::MAGIC.to_vec();
    raw.extend_from_slice(&(body.len() as u32).to_le_bytes());
    raw.extend_from_slice(&body);
    let mut text =
        serde_json::to_vec(&serde_json::json!({"type":"header","header":header})).unwrap();
    text.push(b'\n');
    while let Some(mut record) = pair.next_record().unwrap() {
        record.text.seq += 10;
        record.text.source_seq = record.text.source_seq.map(|seq| seq + 10);
        if let Some(raw) = &mut record.raw {
            raw.seq += 10;
        }
        raw.extend_from_slice(&format::raw_frame(&record));
        text.extend_from_slice(
            &serde_json::to_vec(&serde_json::json!({"type":"output","event":record.text})).unwrap(),
        );
        text.push(b'\n');
    }
    drop(pair);
    fs::write(&raw_path, raw).unwrap();
    fs::write(&text_path, text).unwrap();
    let mut valid_pair = PairReader::new(
        fs::File::open(&raw_path).unwrap(),
        fs::File::open(&text_path).unwrap(),
    )
    .unwrap();
    while valid_pair.next_record().unwrap().is_some() {}
    drop(valid_pair);
    let mut archive = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    assert!(drain(&mut archive).is_err());
    assert!(archive.read_page(1, 32 * 1024).is_err());
}

#[cfg(windows)]
#[test]
fn archive_pins_all_files_and_directory_until_reader_is_dropped() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    assert!(logger.submit(data(&meta, 1, b"immutable")));
    logger.stop();
    let status = logger.join();
    let directory = root.path().join(status.log_id.to_string());
    let mut reader = ArchiveReader::open(&root, status.log_id, meta.connection).unwrap();
    for path in [
        completion_path(&root, status.log_id),
        directory.join("0000000000000001.rawlog"),
        directory.join("0000000000000001.text.jsonl"),
    ] {
        assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::rename(&path, path.with_extension("moved")).is_err());
    }
    drop(root);
    assert!(fs::rename(&directory, temp.0.join("moved")).is_err());
    assert_eq!(drain(&mut reader).unwrap().len(), 1);
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(directory.join("0000000000000001.rawlog"))
            .is_err(),
        "consumed segments must stay immutable until close"
    );
    drop(reader);
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(directory.join("0000000000000001.rawlog"))
            .is_ok()
    );
}

#[cfg(windows)]
#[test]
fn archive_refuses_reparse_entries_without_touching_the_target() {
    let temp = Temp::new();
    let (root, meta, mut logger) = start(&temp);
    assert!(logger.submit(data(&meta, 1, b"preserved")));
    logger.stop();
    let status = logger.join();
    let directory = root.path().join(status.log_id.to_string());
    let raw = directory.join("0000000000000001.rawlog");
    let original = temp.0.join("preserved.rawlog");
    fs::rename(&raw, &original).unwrap();
    let target = temp.0.join("junction-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("sentinel"), b"unchanged").unwrap();
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&raw)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "isolated junction fixture must be created"
    );
    assert!(ArchiveReader::open(&root, status.log_id, meta.connection).is_err());
    assert!(
        fs::read(&original)
            .unwrap()
            .windows(9)
            .any(|part| part == b"preserved")
    );
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"unchanged");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    fs::remove_dir(raw).unwrap();
    assert!(original.exists());
}
