use super::*;

#[test]
fn readable_names_use_beijing_start_seconds_and_minimal_windows_normalization() {
    assert_eq!(
        readable_stem("192.168.10.250", 1794204887000).unwrap(),
        "192.168.10.250_2026-11-09_14_14_47"
    );
    assert_eq!(
        readable_stem("COM89", 0).unwrap(),
        "COM89_1970-01-01_08_00_00"
    );
    assert_eq!(
        readable_stem("中", 1709222399000).unwrap(),
        "中_2024-02-29_23_59_59"
    );
    assert_eq!(safe_window_name(" ../a\\b:<x>?. "), "_a_b__x__");
    assert_eq!(safe_window_name("CON"), "CON");
    assert_eq!(safe_window_name("COM7"), "COM7");
    assert_eq!(safe_window_name("CON.note"), "_CON.note");
    assert_eq!(safe_window_name("lpt9.txt"), "_lpt9.txt");
    assert_eq!(safe_window_name("..."), "终端");
    assert!(readable_stem("x", u64::MAX).is_err());
}

#[test]
fn live_text_grows_before_stop_flushes_then_syncs_and_denies_external_replacement() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let mut meta = metadata();
    meta.started_at_ms = 1794204887000;
    let mut logger = Logger::start_readable(
        root.path().into(),
        meta.clone(),
        Limits::default(),
        "192.168.10.250".into(),
    )
    .unwrap();
    wait(|| logger.status().phase == Phase::Recording);
    let name = logger.status().readable.unwrap().filename;
    let path = temp.0.join("logs").join(&name);
    assert_eq!(name, "192.168.10.250_2026-11-09_14_14_47.log");
    let before = fs::read(&path).unwrap().len();
    let began = Instant::now();
    assert!(logger.submit(data(&meta, 1, "第一段\r\n".as_bytes())));
    wait(|| logger.status().readable.as_ref().unwrap().flushed_records >= 1);
    let first = fs::read(&path).unwrap();
    assert!(first.len() > before);
    assert!(String::from_utf8(first).unwrap().contains("第一段\r\n"));
    assert_eq!(logger.status().phase, Phase::Recording);
    assert!(logger.submit(data(&meta, 2, b"second\x1b[31m\n")));
    wait(|| logger.status().readable.as_ref().unwrap().synced_records >= 2);
    let current = logger.status();
    let live = current.readable.unwrap();
    assert_eq!(live.written_records, 2);
    assert_eq!(live.flushed_records, 2);
    assert_eq!(live.synced_records, 2);
    assert!(live.flushed_at_ms >= live.synced_at_ms.saturating_sub(200));
    assert!(began.elapsed() < Duration::from_secs(5));
    assert!(
        String::from_utf8(fs::read(&path).unwrap())
            .unwrap()
            .contains("second\\u{001b}[31m\n")
    );
    #[cfg(windows)]
    {
        assert!(fs::remove_file(&path).is_err());
        assert!(fs::write(&path, b"replacement").is_err());
    }
    logger.stop();
    wait(|| logger.status().worker_finished);
    let stopped = logger.status();
    assert!(stopped.durable);
    assert_eq!(stopped.phase, Phase::Stopped);
    let readable = stopped.readable.unwrap();
    assert_eq!(readable.synced_records, 2);
    // Internal retirement must not silently delete independently retained user text.
    assert_eq!(fs::read_dir(temp.0.join("logs")).unwrap().count(), 1);
    let open = || {
        UserLogFile::open(
            &temp.0,
            &name,
            meta.connection,
            stopped.log_id,
            readable.file_identity,
            false,
        )
    };
    let source = open().unwrap();
    assert_eq!(source.path(), path);
    #[cfg(windows)]
    assert!(
        fs::remove_file(&path).is_err(),
        "only the read operation pins the file"
    );
    drop(source);
    let renamed = path.with_extension("saved");
    fs::rename(&path, &renamed).unwrap();
    assert_eq!(open().err().unwrap().kind(), io::ErrorKind::NotFound);
    fs::copy(&renamed, &path).unwrap();
    assert_eq!(open().err().unwrap().kind(), io::ErrorKind::InvalidData);
    fs::remove_file(&path).unwrap();
    fs::rename(&renamed, &path).unwrap();
    assert!(open().is_ok());
    fs::remove_file(&path).unwrap();
    assert!(logger.join().durable);
}

#[test]
fn same_second_concurrent_windows_and_rounds_share_one_flat_root_without_overwrite() {
    let temp = Temp::new();
    let meta = metadata();
    let mut handles = Vec::new();
    for _ in 0..4 {
        let path = temp.0.clone();
        let meta = meta.clone();
        handles.push(std::thread::spawn(move || {
            let mut live =
                crate::live_text::LiveText::open(&path, "同名窗口", &meta, Uuid::new_v4(), 65536)
                    .unwrap();
            live.append(&data(&meta, 1, b"unique-output")).unwrap();
            live.checkpoint(true).unwrap();
            live.status.filename
        }));
    }
    let mut names = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 4);
    let root = temp.0.join("logs");
    let entries = fs::read_dir(root)
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 4);
    assert!(entries.iter().all(|e| e.file_type().unwrap().is_file()));
    assert!(names.contains(&"同名窗口_1970-01-01_08_00_00.log".into()));
    assert!(names.contains(&"同名窗口_1970-01-01_08_00_00_3.log".into()));
}

#[test]
fn live_capacity_failure_and_source_gaps_are_explicit_without_clean_completion() {
    let temp = Temp::new();
    let meta = metadata();
    let mut live =
        crate::live_text::LiveText::open(&temp.0, "UART", &meta, Uuid::new_v4(), 1024).unwrap();
    let mut gap = data(&meta, 1, b"");
    gap.raw.as_mut().unwrap().gap_bytes = Some(17);
    gap.text.gap_bytes = Some(17);
    live.append(&gap).unwrap();
    live.checkpoint(true).unwrap();
    let path = temp.0.join("logs").join(&live.status.filename);
    assert!(
        String::from_utf8(fs::read(path).unwrap())
            .unwrap()
            .contains("[接收缺口：17 字节]")
    );
    let prior = live.status.written_records;
    assert_eq!(
        live.append(&data(&meta, 2, &vec![b'x'; 1024]))
            .unwrap_err()
            .kind(),
        io::ErrorKind::FileTooLarge
    );
    assert_eq!(live.status.written_records, prior);
}

#[test]
#[cfg(windows)]
fn live_root_junction_is_rejected_without_touching_target() {
    let temp = Temp::new();
    let target = Temp::new();
    let link = temp.0.join("logs");
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target.0)
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(
        crate::live_text::LiveText::open(&temp.0, "x", &metadata(), Uuid::new_v4(), 1024).is_err()
    );
    assert_eq!(fs::read_dir(&target.0).unwrap().count(), 0);
    fs::remove_dir(&link).unwrap();
}

#[test]
fn active_bundle_reads_all_frozen_flushed_bytes_beyond_preview_without_stopping() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger = Logger::start_readable(
        root.path().into(),
        meta.clone(),
        Limits::default(),
        "window".into(),
    )
    .unwrap();
    wait(|| logger.status().phase == Phase::Recording);
    for seq in 1..=160 {
        let bytes = format!("FULL-{seq:03}-{}\r\n", "x".repeat(1000));
        assert!(logger.submit(data(&meta, seq, bytes.as_bytes())));
        if seq % 8 == 0 {
            wait(|| logger.status().written_records >= seq);
        }
    }
    wait(|| logger.status().readable.as_ref().unwrap().flushed_records == 160);
    let status = logger.status();
    let live = status.readable.unwrap();
    let file = temp.0.join("logs").join(&live.filename);
    let frozen = fs::read(&file).unwrap();
    assert!(frozen.len() > 65536);
    let snapshot = ReadableSnapshot {
        directory: None,
        log_id: status.log_id,
        connection: meta.connection,
        filename: live.filename.clone(),
        file_identity: live.file_identity,
        writer_may_be_open: true,
        bytes: live.flushed_bytes,
        flushed_records: live.flushed_records,
        synced_records: live.synced_records,
        flushed_at_ms: live.flushed_at_ms,
        source_gap_bytes: 0,
        rejected_records: 0,
        active: true,
        failed: false,
    };
    assert!(logger.submit(data(&meta, 161, b"AFTER-SNAPSHOT\r\n")));
    wait(|| logger.status().readable.as_ref().unwrap().flushed_records == 161);
    let staging = temp.0.join("menu");
    fs::create_dir(&staging).unwrap();
    let mut store = ExportStore::open(&staging).unwrap();
    let id = Uuid::new_v4();
    let artifact = store
        .create_live_bundle(&temp.0, &[snapshot], meta.connection, id, || false)
        .unwrap();
    let output = fs::read(store.path().join(id.to_string()).join("export.jsonl")).unwrap();
    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("FULL-160-"));
    assert!(!output.contains("AFTER-SNAPSHOT"));
    assert!(output.contains(std::str::from_utf8(&frozen).unwrap()));
    assert_eq!(artifact.summary.retained_records, 160);
    assert_eq!(logger.status().phase, Phase::Recording);
    assert!(
        UserLogFile::open(
            &temp.0,
            &live.filename,
            ConnectionRef {
                generation: 2,
                ..meta.connection
            },
            status.log_id,
            live.file_identity,
            true,
        )
        .is_err()
    );
    assert!(
        UserLogFile::open(
            &temp.0,
            "../other.log",
            meta.connection,
            status.log_id,
            live.file_identity,
            true,
        )
        .is_err()
    );
    logger.join();
}

#[test]
fn display_artifact_preserves_exact_utf8_spaces_blank_lines_and_rejects_controls() {
    let temp = Temp::new();
    let mut store = ExportStore::open(&temp.0).unwrap();
    let text = "中文  \r\n      \r\n尾行  \r\n";
    let id = Uuid::new_v4();
    let artifact = store.create_display(text, id, || false).unwrap();
    assert_eq!(artifact.bytes, text.len() as u64);
    assert_eq!(
        fs::read(store.path().join(id.to_string()).join("export.jsonl")).unwrap(),
        text.as_bytes()
    );
    assert!(
        store
            .create_display("bad\x1b[31m", Uuid::new_v4(), || false)
            .is_err()
    );
}
