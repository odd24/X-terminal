use super::*;
use sha2::Digest;
use std::io::Write;

#[test]
fn readable_text_uses_verified_retained_source_and_same_safe_artifact_budget() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 3);
    let mut store = ExportStore::open(&temp.0).unwrap();
    let id = Uuid::new_v4();
    let artifact = store
        .create_text(&root, status.log_id, meta.connection, id, || false)
        .unwrap();
    let file = store.path().join(id.to_string()).join("export.jsonl");
    let bytes = fs::read(&file).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.starts_with("# 终端通信日志 UTF-8\r\n"));
    assert!(text.contains("中文\\u{0000}\\u{001b}[31m<script>\r\n😀"));
    assert!(!text.contains('\0') && !text.contains('\u{1b}'));
    assert!(text.contains("接收缺口：17 字节"));
    assert!(text.contains("日志结束"));
    assert_eq!(artifact.summary.retained_gap_bytes, 17);
    assert_eq!(artifact.bytes, bytes.len() as u64);
    assert_eq!(artifact.sha256, sha2::Sha256::digest(&bytes).as_slice());
    assert!(
        store
            .create_text(&root, status.log_id, meta.connection, id, || false)
            .is_err()
    );
    assert_eq!(fs::read(file).unwrap(), bytes);
    let cancelled = Uuid::new_v4();
    assert_eq!(
        store
            .create_text(&root, status.log_id, meta.connection, cancelled, || true)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::Interrupted
    );
    assert!(!store.path().join(cancelled.to_string()).exists());
}

pub(super) fn capture(temp: &Temp, count: u64) -> (ManagedRoot, Metadata, Status) {
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger = Logger::start(
        root.path().to_path_buf(),
        meta.clone(),
        Limits {
            segment_bytes: 128 * 1024,
            segments: 2,
        },
    )
    .unwrap();
    for seq in 1..=count {
        let mut record = data(&meta, seq, &vec![seq as u8; EVENT_BYTES]);
        record.text.text = "中文\0\u{1b}[31m<script>\r\n😀".into();
        assert!(logger.submit(record));
        wait(|| logger.status().written_records == seq);
    }
    let mut gap = data(&meta, count + 1, &[]);
    gap.raw.as_mut().unwrap().gap_bytes = Some(17);
    gap.text.gap_bytes = Some(17);
    assert!(logger.submit(gap));
    assert!(logger.submit(eof(&meta, count + 2)));
    let status = logger.join();
    assert!(status.durable);
    (root, meta, status)
}
pub(super) fn lines(bytes: &[u8]) -> Vec<serde_json::Value> {
    std::str::from_utf8(bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn portable_export_preserves_rotated_scope_raw_text_gap_and_flush() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 70);
    assert!(status.retired_segments > 0);
    let mut output = Vec::new();
    let summary =
        export_jsonl(&root, status.log_id, meta.connection, &mut output, || false).unwrap();
    let rows = lines(&output);
    let header = &rows[0];
    assert_eq!(header["format"], "shared-terminal-export");
    assert_eq!(header["metadata"], serde_json::to_value(&meta).unwrap());
    assert_eq!(header["source_completion"]["written_records"], 72);
    let first = header["available_from"].as_u64().unwrap();
    assert!(first > 1);
    assert_eq!(summary.retained_records, 73 - first);
    assert_eq!(
        summary.retained_raw_bytes,
        (71 - first) * EVENT_BYTES as u64
    );
    assert_eq!(summary.retained_gap_bytes, 17);
    assert_eq!(summary.next_cursor, 73);
    for (index, row) in rows[1..rows.len() - 1].iter().enumerate() {
        let seq = first + index as u64;
        assert_eq!(row["text"]["seq"], seq);
        if seq <= 70 {
            let bytes: Vec<u8> = serde_json::from_value(row["raw"]["bytes"].clone()).unwrap();
            assert_eq!(bytes, vec![seq as u8; EVENT_BYTES]);
            assert_eq!(row["text"]["text"], "中文\0\u{1b}[31m<script>\r\n😀");
        } else if seq == 71 {
            assert_eq!(row["raw"]["gap_bytes"], 17);
            assert_eq!(row["text"]["gap_bytes"], 17);
        } else {
            assert!(row["raw"].is_null());
            assert_eq!(row["text"]["decode_error"], true);
        }
    }
    assert_eq!(rows.last().unwrap()["type"], "verified");
    assert_eq!(
        rows.last().unwrap()["retained"],
        serde_json::to_value(summary).unwrap()
    );
    // Export holds no lingering source handles after return.
    let marker = root
        .path()
        .join(status.log_id.to_string())
        .join("completion.json");
    let original = fs::read(&marker).unwrap();
    fs::write(&marker, original).unwrap();
}

#[test]
fn export_rejects_wrong_scope_and_cancellation_without_success_trailer() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 3);
    let mut bytes = Vec::new();
    assert!(
        export_jsonl(
            &root,
            status.log_id,
            ConnectionRef {
                generation: 2,
                ..meta.connection
            },
            &mut bytes,
            || false
        )
        .is_err()
    );
    assert!(bytes.is_empty());
    let mut calls = 0;
    let error = export_jsonl(&root, status.log_id, meta.connection, &mut bytes, || {
        calls += 1;
        calls >= 4
    })
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    let rows = lines(&bytes);
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row["type"] != "verified"));
}

#[test]
fn export_damaged_final_counters_leaves_only_unverified_prefix() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 20);
    let marker = root
        .path()
        .join(status.log_id.to_string())
        .join("completion.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    value["written_raw_bytes"] = 1.into();
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut bytes = Vec::new();
    assert!(export_jsonl(&root, status.log_id, meta.connection, &mut bytes, || false).is_err());
    let rows = lines(&bytes);
    assert!(rows.len() > 1); // Real streamed prefix existed before final validation failed.
    assert!(rows.iter().all(|row| row["type"] != "verified"));
}

#[test]
fn export_empty_manual_stop_and_legacy_unknown_gap_total() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger =
        Logger::start(root.path().to_path_buf(), meta.clone(), Limits::default()).unwrap();
    let status = logger.join();
    assert!(status.durable);
    let marker = root
        .path()
        .join(status.log_id.to_string())
        .join("completion.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("source_gap_bytes");
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut bytes = Vec::new();
    let summary =
        export_jsonl(&root, status.log_id, meta.connection, &mut bytes, || false).unwrap();
    assert_eq!(summary.retained_records, 0);
    let rows = lines(&bytes);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["source_completion"]["natural_end"], false);
    assert!(
        rows[0]["source_completion"]
            .get("source_gap_bytes")
            .is_none()
    );
}

#[test]
fn export_propagates_partial_write_and_final_flush_failures() {
    struct Sink {
        budget: usize,
        flush_error: bool,
    }
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.budget == 0 {
                return Err(io::Error::from(io::ErrorKind::StorageFull));
            }
            let count = bytes.len().min(self.budget);
            self.budget -= count;
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.flush_error {
                Err(io::Error::other("synthetic flush failure"))
            } else {
                Ok(())
            }
        }
    }
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 2);
    for (budget, flush_error) in [(11, false), (usize::MAX, true)] {
        let mut sink = Sink {
            budget,
            flush_error,
        };
        assert!(export_jsonl(&root, status.log_id, meta.connection, &mut sink, || false).is_err());
    }
}

#[test]
fn managed_export_syncs_and_publishes_once_without_overwriting_or_touching_source() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 3);
    let mut store = ExportStore::open(&temp.0).unwrap();
    #[cfg(windows)]
    assert!(ExportStore::open(&temp.0).is_err());
    let id = Uuid::new_v4();
    let artifact = store
        .create(&root, status.log_id, meta.connection, id, || false)
        .unwrap();
    let directory = store.path().join(id.to_string());
    let ready = directory.join("export.jsonl");
    let bytes = fs::read(&ready).unwrap();
    assert_eq!(artifact.export_id, id);
    assert_eq!(artifact.bytes, bytes.len() as u64);
    assert_eq!(
        artifact.sha256,
        <[u8; 32]>::from(sha2::Sha256::digest(&bytes))
    );
    #[cfg(windows)]
    {
        let mut verified = crate::VerifiedExport::open(
            &temp.0,
            id,
            crate::ExportFingerprint {
                bytes: artifact.bytes,
                sha256: artifact.sha256,
            },
            || false,
        )
        .unwrap();
        let mut copied = Vec::new();
        verified.copy_to(&mut copied, || false).unwrap();
        assert_eq!(copied, bytes);
    }
    assert_eq!(artifact.summary.retained_records, 5);
    assert_eq!(lines(&bytes).last().unwrap()["type"], "verified");
    assert!(!directory.join("export.partial").exists());
    assert!(
        store
            .create(&root, status.log_id, meta.connection, id, || false)
            .is_err()
    );
    assert_eq!(fs::read(&ready).unwrap(), bytes);
    assert_eq!(root.ids().unwrap(), [status.log_id]);
    drop(store);
    let _reopened = ExportStore::open(&temp.0).unwrap();
}

#[test]
fn managed_export_cancel_corrupt_source_and_publish_collision_never_publish_success() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 20);
    let mut store = ExportStore::open(&temp.0).unwrap();
    let id = Uuid::new_v4();
    let ready = store.path().join(id.to_string()).join("export.jsonl");
    let partial = ready.with_file_name("export.partial");
    assert!(
        store
            .create(&root, status.log_id, meta.connection, id, || partial
                .exists())
            .is_err()
    );
    assert!(partial.exists());
    assert!(!ready.exists());

    let collision_id = Uuid::new_v4();
    let collision_ready = store
        .path()
        .join(collision_id.to_string())
        .join("export.jsonl");
    let collision_partial = collision_ready.with_file_name("export.partial");
    assert!(
        store
            .create(&root, status.log_id, meta.connection, collision_id, || {
                if collision_partial.exists() && !collision_ready.exists() {
                    fs::write(&collision_ready, b"synthetic sentinel").unwrap();
                }
                false
            })
            .is_err()
    );
    assert_eq!(fs::read(&collision_ready).unwrap(), b"synthetic sentinel");
    assert!(collision_partial.exists());

    let marker = root
        .path()
        .join(status.log_id.to_string())
        .join("completion.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    value["written_raw_bytes"] = 1.into();
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    let corrupt_id = Uuid::new_v4();
    assert!(
        store
            .create(&root, status.log_id, meta.connection, corrupt_id, || false)
            .is_err()
    );
    let corrupt = store.path().join(corrupt_id.to_string());
    assert!(!corrupt.join("export.jsonl").exists());
    assert!(corrupt.join("export.partial").exists());
    assert!(
        lines(&fs::read(corrupt.join("export.partial")).unwrap())
            .iter()
            .all(|row| row["type"] != "verified")
    );
}

#[test]
fn managed_export_caps_catalogue_including_failed_attempts_and_rejects_unknown_entries() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 1);
    let mut store = ExportStore::open(&temp.0).unwrap();
    fs::write(store.path().join("unknown"), b"preserve").unwrap();
    let id = Uuid::new_v4();
    assert!(
        store
            .create(&root, status.log_id, meta.connection, id, || false)
            .is_err()
    );
    assert!(!store.path().join(id.to_string()).exists());
    assert_eq!(fs::read(store.path().join("unknown")).unwrap(), b"preserve");
    fs::remove_file(store.path().join("unknown")).unwrap();
    for _ in 0..8 {
        let id = Uuid::new_v4();
        let partial = store.path().join(id.to_string()).join("export.partial");
        assert!(
            store
                .create(&root, status.log_id, meta.connection, id, || partial
                    .exists())
                .is_err()
        );
    }
    assert_eq!(
        store
            .create(
                &root,
                status.log_id,
                meta.connection,
                Uuid::new_v4(),
                || false
            )
            .unwrap_err()
            .kind(),
        io::ErrorKind::StorageFull
    );
    // Eight failed directories remain; no implicit evidence deletion to free quota.
    assert_eq!(fs::read_dir(store.path()).unwrap().count(), 9);
}

#[test]
fn managed_export_cancel_after_sync_preserves_partial_even_with_verified_trailer() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 0); // gap + final flush, a single page
    let mut store = ExportStore::open(&temp.0).unwrap();
    let id = Uuid::new_v4();
    let mut checks = 0;
    let error = store
        .create(&root, status.log_id, meta.connection, id, || {
            checks += 1;
            // setup, reader, page, 2 records, trailer, flush, then store sync.
            checks == 8
        })
        .unwrap_err();
    assert_eq!(checks, 8);
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    let directory = store.path().join(id.to_string());
    assert!(!directory.join("export.jsonl").exists());
    assert_eq!(
        lines(&fs::read(directory.join("export.partial")).unwrap())
            .last()
            .unwrap()["type"],
        "verified"
    );
}

#[cfg(windows)]
#[test]
fn managed_export_refuses_root_and_catalogue_junctions_without_modifying_target() {
    fn junction(temp: &Temp, link: &std::path::Path, target: &std::path::Path) {
        assert!(link.starts_with(&temp.0) && target.starts_with(&temp.0));
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "isolated junction fixture must be created"
        );
    }
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 1);
    let target = temp.0.join("isolated-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("sentinel"), b"preserve").unwrap();
    let link = temp.0.join("terminal-log-exports");
    junction(&temp, &link, &target);
    assert!(ExportStore::open(&temp.0).is_err());
    fs::remove_dir(&link).unwrap(); // remove only the self-created junction
    let mut store = ExportStore::open(&temp.0).unwrap();
    let child = store.path().join(Uuid::new_v4().to_string());
    junction(&temp, &child, &target);
    assert!(
        store
            .create(
                &root,
                status.log_id,
                meta.connection,
                Uuid::new_v4(),
                || false
            )
            .is_err()
    );
    fs::remove_dir(&child).unwrap();
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"preserve");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
}
