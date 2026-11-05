use super::*;

fn sample(count: u64) -> (Temp, ManagedRoot, Metadata, Status) {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger = Logger::start(
        root.path().into(),
        meta.clone(),
        Limits {
            segment_bytes: 128 * 1024,
            segments: 2,
        },
    )
    .unwrap();
    for seq in 1..=count {
        assert!(logger.submit(data(&meta, seq, &[b'x'; EVENT_BYTES])));
        wait(|| logger.status().written_records == seq);
    }
    logger.stop();
    let status = logger.join();
    assert!(status.durable);
    (temp, root, meta, status)
}
fn drain(reader: &mut RecoveryReader) -> (Vec<Record>, RecoveryStop) {
    let mut result = Vec::new();
    loop {
        let page = reader.read_page(128, 32 * 1024).unwrap();
        assert!(
            page.records
                .iter()
                .map(|r| r.text.text.len() + r.raw.as_ref().map_or(0, |r| r.bytes.len()) + 256)
                .sum::<usize>()
                <= 32 * 1024
        );
        result.extend(page.records);
        if let Some(stop) = page.stop {
            assert_eq!(stop.next_cursor, page.next_cursor);
            let again = reader.read_page(1, 32 * 1024).unwrap();
            assert!(again.records.is_empty());
            assert_eq!(again.stop, Some(stop.clone()));
            return (result, stop);
        }
    }
}
fn paths(root: &ManagedRoot, id: Uuid) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(root.path().join(id.to_string()))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}
fn contents(root: &ManagedRoot, id: Uuid) -> Vec<(PathBuf, Vec<u8>)> {
    paths(root, id)
        .into_iter()
        .map(|p| {
            let bytes = fs::read(&p).unwrap();
            (p, bytes)
        })
        .collect()
}

#[test]
fn recovery_without_completion_is_read_only_and_never_certifies_completion() {
    let (_temp, root, meta, status) = sample(3);
    let dir = root.path().join(status.log_id.to_string());
    fs::rename(dir.join("completion.json"), dir.join("completion.partial")).unwrap();
    fs::write(dir.join("completion.partial"), b"incomplete marker").unwrap();
    let before = contents(&root, status.log_id);
    let mut reader = RecoveryReader::open(&root, status.log_id, meta.connection).unwrap();
    assert!(!reader.info().completion_present && reader.info().partial_present);
    assert!(reader.read_page(0, 32 * 1024).is_err());
    let (records, stop) = drain(&mut reader);
    assert_eq!(records.len(), 3);
    assert_eq!(
        (stop.kind, stop.next_cursor),
        (RecoveryStopKind::EndOfAvailable, 4)
    );
    assert_eq!(contents(&root, status.log_id), before);
    assert!(ArchiveReader::open(&root, status.log_id, meta.connection).is_err());
    assert!(
        RecoveryReader::open(
            &root,
            status.log_id,
            ConnectionRef {
                generation: 2,
                ..meta.connection
            }
        )
        .is_err()
    );
    #[cfg(windows)]
    {
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(dir.join("0000000000000001.rawlog"))
                .is_err()
        );
        assert!(root.preview_cleanup(status.log_id).is_err());
    }
}

#[test]
fn recovery_preserves_valid_same_page_prefix_before_raw_or_text_tail_failure() {
    for text in [false, true] {
        let (_temp, root, meta, status) = sample(3);
        let path = root.path().join(status.log_id.to_string()).join(if text {
            "0000000000000001.text.jsonl"
        } else {
            "0000000000000001.rawlog"
        });
        let bytes = fs::read(&path).unwrap();
        fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
        let before = contents(&root, status.log_id);
        let mut reader = RecoveryReader::open(&root, status.log_id, meta.connection).unwrap();
        let (records, stop) = drain(&mut reader);
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].text.seq, 2);
        assert_eq!(
            (stop.kind, stop.next_cursor),
            (RecoveryStopKind::TruncatedRecord, 3)
        );
        assert_eq!(contents(&root, status.log_id), before);
    }
}

#[test]
fn recovery_does_not_skip_invalid_record_or_search_for_later_good_records() {
    let (_temp, root, meta, status) = sample(3);
    let path = root
        .path()
        .join(status.log_id.to_string())
        .join("0000000000000001.text.jsonl");
    let text = fs::read_to_string(&path).unwrap();
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut second: serde_json::Value = serde_json::from_str(&lines[2]).unwrap();
    second["event"]["timestamp_ms"] = 999.into();
    lines[2] = serde_json::to_string(&second).unwrap();
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    let mut reader = RecoveryReader::open(&root, status.log_id, meta.connection).unwrap();
    let (records, stop) = drain(&mut reader);
    assert_eq!(records.len(), 1);
    assert_eq!(
        (stop.kind, stop.next_cursor),
        (RecoveryStopKind::InvalidRecord, 2)
    );
}

#[test]
fn recovery_reads_retained_rotation_and_stops_before_damaged_or_missing_later_pair() {
    for case in 0..4 {
        let (_temp, root, meta, status) = sample(70);
        assert!(status.retired_segments > 0);
        let dir = root.path().join(status.log_id.to_string());
        let marker: Completion =
            serde_json::from_slice(&fs::read(dir.join("completion.json")).unwrap()).unwrap();
        let last = marker.last_segment;
        assert!(last > marker.first_retained_segment);
        let text = dir.join(format!("{last:016}.text.jsonl"));
        match case {
            0 => {}
            1 => fs::remove_file(&text).unwrap(),
            2 => fs::write(&text, b"bad header\n").unwrap(),
            3 => {
                for suffix in ["rawlog", "text.jsonl"] {
                    fs::rename(
                        dir.join(format!("{last:016}.{suffix}")),
                        dir.join(format!("{:016}.{suffix}", last + 1)),
                    )
                    .unwrap();
                }
            }
            _ => unreachable!(),
        }
        let before = contents(&root, status.log_id);
        let mut reader = RecoveryReader::open(&root, status.log_id, meta.connection).unwrap();
        assert!(reader.info().available_from > 1);
        let start = reader.info().available_from;
        let (records, stop) = drain(&mut reader);
        assert!(!records.is_empty());
        for (i, record) in records.iter().enumerate() {
            assert_eq!(record.text.seq, start + i as u64);
        }
        assert_eq!(
            stop.kind,
            [
                RecoveryStopKind::EndOfAvailable,
                RecoveryStopKind::MissingPartner,
                RecoveryStopKind::InvalidHeader,
                RecoveryStopKind::MissingSegment
            ][case]
        );
        if case == 0 {
            assert_eq!(stop.next_cursor, 71);
        } else {
            assert!(stop.next_cursor < 71);
        }
        assert_eq!(contents(&root, status.log_id), before);
        #[cfg(windows)]
        if case == 2 {
            assert!(fs::OpenOptions::new().write(true).open(&text).is_err());
        }
    }
}

#[test]
fn recovery_rejects_unknown_oversized_unscoped_and_missing_first_header() {
    for case in 0..5 {
        let (_temp, root, meta, status) = sample(1);
        let dir = root.path().join(status.log_id.to_string());
        match case {
            0 => fs::write(dir.join("unknown"), b"preserve").unwrap(),
            1 => fs::write(dir.join("completion.partial"), vec![b'x'; 1025]).unwrap(),
            2 => fs::write(dir.join("0000000000000001.text.jsonl"), b"bad\n").unwrap(),
            3 => fs::remove_file(dir.join("0000000000000001.rawlog")).unwrap(),
            4 => {
                fs::create_dir(dir.join("0000000000000002.rawlog")).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(RecoveryReader::open(&root, status.log_id, meta.connection).is_err());
        assert!(dir.exists());
    }
}

#[test]
fn recovery_handles_empty_capture_gap_and_natural_end_without_completion_claim() {
    for count in [0, 2] {
        let temp = Temp::new();
        let root = ManagedRoot::open(&temp.0).unwrap();
        let meta = metadata();
        let mut logger =
            Logger::start(root.path().into(), meta.clone(), Limits::default()).unwrap();
        if count == 2 {
            let mut gap = data(&meta, 1, &[]);
            gap.raw.as_mut().unwrap().gap_bytes = Some(42);
            gap.text.gap_bytes = Some(42);
            assert!(logger.submit(gap));
            assert!(logger.submit(eof(&meta, 2)));
        } else {
            logger.stop();
        }
        let status = logger.join();
        let mut reader = RecoveryReader::open(&root, status.log_id, meta.connection).unwrap();
        let (records, stop) = drain(&mut reader);
        assert_eq!(records.len(), count);
        assert_eq!(stop.kind, RecoveryStopKind::EndOfAvailable);
        if count == 2 {
            assert_eq!(records[0].text.gap_bytes, Some(42));
            assert!(records[1].raw.is_none());
        }
    }
}

#[test]
fn recovery_rejects_cross_segment_identity_and_cursor_changes_before_delivery() {
    for case in 0..3 {
        let (_temp, root, meta, status) = sample(70);
        let dir = root.path().join(status.log_id.to_string());
        let raw_path = dir.join(format!("{:016}.rawlog", status.last_segment));
        let text_path = dir.join(format!("{:016}.text.jsonl", status.last_segment));
        let mut pair = PairReader::new(
            fs::File::open(&raw_path).unwrap(),
            fs::File::open(&text_path).unwrap(),
        )
        .unwrap();
        let mut header = pair.header().clone();
        match case {
            0 => header.metadata.connection.generation += 1,
            1 => header.text_cursor += 1,
            2 => header.log_id = Uuid::new_v4(),
            _ => unreachable!(),
        }
        let body = serde_json::to_vec(&header).unwrap();
        let mut raw = format::MAGIC.to_vec();
        raw.extend_from_slice(&(body.len() as u32).to_le_bytes());
        raw.extend_from_slice(&body);
        let mut text =
            serde_json::to_vec(&serde_json::json!({"type":"header","header":header})).unwrap();
        text.push(b'\n');
        while let Some(record) = pair.next_record().unwrap() {
            raw.extend_from_slice(&format::raw_frame(&record));
            text.extend_from_slice(
                &serde_json::to_vec(&serde_json::json!({"type":"output","event":record.text}))
                    .unwrap(),
            );
            text.push(b'\n');
        }
        drop(pair);
        fs::write(&raw_path, raw).unwrap();
        fs::write(&text_path, text).unwrap();
        let mut reader = RecoveryReader::open(&root, status.log_id, meta.connection).unwrap();
        let (records, stop) = drain(&mut reader);
        assert!(!records.is_empty());
        assert_eq!(stop.kind, RecoveryStopKind::Discontinuity);
        assert_eq!(stop.segment, status.last_segment);
        assert!(stop.next_cursor < 71);
        #[cfg(windows)]
        assert!(fs::OpenOptions::new().write(true).open(&text_path).is_err());
    }
}

#[cfg(windows)]
#[test]
fn recovery_rejects_active_writer_and_junction_without_touching_other_content() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger = Logger::start(root.path().into(), meta.clone(), Limits::default()).unwrap();
    assert!(logger.submit(data(&meta, 1, b"preserved")));
    wait(|| logger.status().written_records == 1);
    let id = logger.status().log_id;
    assert!(RecoveryReader::open(&root, id, meta.connection).is_err());
    logger.stop();
    assert!(logger.join().durable);
    let dir = root.path().join(id.to_string());
    let file = dir.join("0000000000000001.rawlog");
    let original = temp.0.join("original.rawlog");
    fs::rename(&file, &original).unwrap();
    let target = temp.0.join("isolated-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("sentinel"), b"preserve").unwrap();
    assert!(file.starts_with(&temp.0) && target.starts_with(&temp.0));
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&file)
        .arg(&target)
        .output()
        .unwrap();
    assert!(result.status.success());
    let refused = RecoveryReader::open(&root, id, meta.connection).is_err();
    // Remove only this test's junction before the Temp recursive cleanup.
    fs::remove_dir(&file).unwrap();
    assert!(refused);
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"preserve");
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
    assert!(
        fs::read(original)
            .unwrap()
            .windows(9)
            .any(|b| b == b"preserved")
    );
}
