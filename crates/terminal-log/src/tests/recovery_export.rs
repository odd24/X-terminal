use super::export::{capture, lines};
use super::*;
use std::io::Write;

fn snapshot(root: &ManagedRoot, id: Uuid) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = fs::read_dir(root.path().join(id.to_string()))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
#[test]
fn recovery_export_preserves_exact_rotated_prefix_and_stops_before_truncated_final_text() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 70);
    let dir = root.path().join(status.log_id.to_string());
    fs::remove_file(dir.join("completion.json")).unwrap();
    let path = dir.join(format!("{:016}.text.jsonl", status.last_segment));
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
    let before = snapshot(&root, status.log_id);
    let mut output = Vec::new();
    let summary =
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut output, || false)
            .unwrap();
    let rows = lines(&output);
    let header = &rows[0];
    assert_eq!(header["format"], "shared-terminal-recovery-export");
    assert_eq!(header["incomplete"], true);
    assert_eq!(
        header["source"]["metadata"],
        serde_json::to_value(&meta).unwrap()
    );
    assert_eq!(header["source"]["completion_present"], false);
    let first = header["source"]["available_from"].as_u64().unwrap();
    assert!(first > 1);
    assert_eq!(summary.recovered_records, 72 - first);
    assert_eq!(summary.next_cursor, 72);
    assert_eq!(summary.recovered_gap_bytes, 17);
    assert_eq!(summary.stop.kind, RecoveryStopKind::TruncatedRecord);
    assert_eq!(summary.stop.segment, status.last_segment);
    assert_eq!(
        summary.recovered_raw_bytes,
        (71 - first) * EVENT_BYTES as u64
    );
    for (index, row) in rows[1..rows.len() - 1].iter().enumerate() {
        let seq = first + index as u64;
        assert_eq!(row["type"], "record");
        assert_eq!(row["text"]["seq"], seq);
        if seq <= 70 {
            assert_eq!(
                row["raw"]["bytes"],
                serde_json::json!(vec![seq as u8; EVENT_BYTES])
            );
            assert_eq!(row["text"]["text"], "中文\0\u{1b}[31m<script>\r\n😀");
        }
    }
    assert_eq!(rows.last().unwrap()["type"], "recovery_stopped");
    assert_eq!(
        rows.last().unwrap()["recovered"],
        serde_json::to_value(&summary).unwrap()
    );
    assert!(
        rows.iter()
            .all(|row| row["type"] != "verified" && row.get("source_completion").is_none())
    );
    assert_eq!(snapshot(&root, status.log_id), before);
    let mut normal = Vec::new();
    assert!(export_jsonl(&root, status.log_id, meta.connection, &mut normal, || false).is_err());
    assert!(normal.is_empty());
}
#[test]
fn clean_or_empty_recovery_exports_still_declare_incomplete_instead_of_source_completion() {
    for empty in [false, true] {
        let temp = Temp::new();
        let (root, meta, status) = if empty {
            let root = ManagedRoot::open(&temp.0).unwrap();
            let meta = metadata();
            let mut logger =
                Logger::start(root.path().into(), meta.clone(), Limits::default()).unwrap();
            logger.stop();
            let status = logger.join();
            (root, meta, status)
        } else {
            capture(&temp, 1)
        };
        let mut output = Vec::new();
        let summary =
            export_recovery_jsonl(&root, status.log_id, meta.connection, &mut output, || false)
                .unwrap();
        assert_eq!(summary.stop.kind, RecoveryStopKind::EndOfAvailable);
        assert_eq!(summary.recovered_records, if empty { 0 } else { 3 });
        let rows = lines(&output);
        assert_eq!(rows[0]["source"]["completion_present"], true);
        assert_eq!(rows.last().unwrap()["incomplete"], true);
        assert!(rows.iter().all(|row| row["type"] != "verified"));
        if !empty {
            assert!(rows[3]["raw"].is_null());
        }
    }
}
struct Sink {
    bytes: Vec<u8>,
    max_write: usize,
    limit: usize,
    fail_flush: bool,
    flushed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Sink {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            max_write: 3,
            limit: usize::MAX,
            fail_flush: false,
            flushed: Default::default(),
        }
    }
}
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len() >= self.limit {
            return Err(io::Error::other("synthetic sink full"));
        }
        let n = bytes
            .len()
            .min(self.max_write)
            .min(self.limit - self.bytes.len());
        self.bytes.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flushed.store(true, Ordering::SeqCst);
        if self.fail_flush {
            Err(io::Error::other("synthetic flush failure"))
        } else {
            Ok(())
        }
    }
}
#[test]
fn recovery_export_propagates_short_write_failure_and_flush_failure_without_publishing() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 1);
    let mut good = Sink::new();
    export_recovery_jsonl(&root, status.log_id, meta.connection, &mut good, || false).unwrap();
    assert_eq!(
        lines(&good.bytes).last().unwrap()["type"],
        "recovery_stopped"
    );
    let mut partial = Sink::new();
    partial.limit = 700;
    assert!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut partial, || {
            false
        })
        .is_err()
    );
    assert_eq!(partial.bytes.len(), 700);
    let mut flushed = Sink::new();
    flushed.fail_flush = true;
    assert!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut flushed, || {
            false
        })
        .is_err()
    );
    assert_eq!(
        lines(&flushed.bytes).last().unwrap()["type"],
        "recovery_stopped",
        "a trailer alone cannot prove a successful return or publication"
    );
}
#[test]
fn recovery_export_cancellation_before_open_during_records_and_after_final_flush_is_not_success() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 3);
    let mut output = Vec::new();
    assert_eq!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut output, || true)
            .unwrap_err()
            .kind(),
        io::ErrorKind::Interrupted
    );
    assert!(output.is_empty());
    let mut checks = 0;
    assert_eq!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut output, || {
            checks += 1;
            checks > 4
        })
        .unwrap_err()
        .kind(),
        io::ErrorKind::Interrupted
    );
    assert!(!output.is_empty());
    assert!(
        lines(&output)
            .iter()
            .all(|row| row["type"] != "recovery_stopped")
    );
    let mut sink = Sink::new();
    let flag = sink.flushed.clone();
    assert_eq!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut sink, || flag
            .load(Ordering::SeqCst))
        .unwrap_err()
        .kind(),
        io::ErrorKind::Interrupted
    );
    assert_eq!(
        lines(&sink.bytes).last().unwrap()["type"],
        "recovery_stopped"
    );
}
#[test]
fn recovery_export_rejects_wrong_generation_and_bad_first_header_before_writing() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 1);
    let mut output = Vec::new();
    assert!(
        export_recovery_jsonl(
            &root,
            status.log_id,
            ConnectionRef {
                generation: meta.connection.generation + 1,
                ..meta.connection
            },
            &mut output,
            || false
        )
        .is_err()
    );
    assert!(output.is_empty());
    fs::write(
        root.path()
            .join(status.log_id.to_string())
            .join("0000000000000001.text.jsonl"),
        b"bad\n",
    )
    .unwrap();
    assert!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut output, || false)
            .is_err()
    );
    assert!(output.is_empty());
}
#[test]
fn recovery_export_counter_overflow_never_writes_a_terminal_report() {
    let temp = Temp::new();
    let (root, meta, status) = capture(&temp, 1);
    let dir = root.path().join(status.log_id.to_string());
    let header = RawReader::new(fs::File::open(dir.join("0000000000000001.rawlog")).unwrap())
        .unwrap()
        .header;
    let body = serde_json::to_vec(&header).unwrap();
    let mut raw = format::MAGIC.to_vec();
    raw.extend_from_slice(&(body.len() as u32).to_le_bytes());
    raw.extend_from_slice(&body);
    let mut text =
        serde_json::to_vec(&serde_json::json!({"type":"header","header":header})).unwrap();
    text.push(b'\n');
    for (seq, lost) in [(1, u64::MAX), (2, 1)] {
        let mut record = data(&meta, seq, &[]);
        record.raw.as_mut().unwrap().gap_bytes = Some(lost);
        record.text.gap_bytes = Some(lost);
        raw.extend_from_slice(&format::raw_frame(&record));
        text.extend_from_slice(
            &serde_json::to_vec(&serde_json::json!({"type":"output","event":record.text})).unwrap(),
        );
        text.push(b'\n');
    }
    fs::write(dir.join("0000000000000001.rawlog"), raw).unwrap();
    fs::write(dir.join("0000000000000001.text.jsonl"), text).unwrap();
    let mut output = Vec::new();
    assert!(
        export_recovery_jsonl(&root, status.log_id, meta.connection, &mut output, || false)
            .is_err()
    );
    assert!(
        lines(&output)
            .iter()
            .all(|row| row["type"] != "recovery_stopped")
    );
}
