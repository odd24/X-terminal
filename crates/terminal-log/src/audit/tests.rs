use super::*;
use session_core::{
    access::{AuditEvent, AuditKind},
    rpc_audit,
};

fn payload(seq: u64) -> Payload {
    Payload::Policy(AuditEvent {
        seq,
        timestamp_ms: seq,
        kind: AuditKind::Denied,
        client_id: Some(Uuid::new_v4()),
        scope: None,
        request_id: Some(Uuid::new_v4()),
        denial: Some(session_core::access::Denial::PermissionDenied),
    })
}
struct Temp(std::path::PathBuf);
fn temp() -> Temp {
    let path = std::env::temp_dir().join(format!("shared-terminal-audit-中文-{}", Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    Temp(path)
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
                .starts_with("shared-terminal-audit-中文-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn sync_restart_fixed_pages_and_service_identity_keep_metadata_not_authority() {
    let root = temp();
    let first = Uuid::new_v4();
    let writer = Writer::open(&root.0, first).unwrap();
    let sink = writer.sink();
    assert!(Writer::open(&root.0, Uuid::new_v4()).is_err());
    for n in 1..=40 {
        assert!(sink.submit(payload(n)));
    }
    let status = sink.flush().unwrap();
    assert_eq!(status.state, State::Healthy);
    assert_eq!(status.accepted_through, 40);
    assert_eq!(status.synced_through, 40);
    let fixed = 35;
    let a = sink.page(0, fixed, 20).unwrap();
    let b = sink.page(a.next_cursor, fixed, 20).unwrap();
    assert_eq!(a.records.len(), 20);
    assert_eq!(b.records.len(), 15);
    assert_eq!(b.next_cursor, fixed);
    assert!(!a.gap);
    assert!(sink.page(0, 41, 1).is_err());
    assert!(sink.page(0, 40, 129).is_err());
    assert_eq!(writer.close().unwrap().state, State::Closed);
    assert!(!sink.submit(payload(41)));
    let second = Uuid::new_v4();
    let writer = Writer::open(&root.0, second).unwrap();
    let sink = writer.sink();
    assert_eq!(sink.status().synced_through, 40);
    assert!(sink.submit(payload(1)));
    sink.flush().unwrap();
    let rows = sink.page(0, 41, 128).unwrap().records;
    assert!(rows[..40].iter().all(|r| r.service_id == first));
    assert_eq!(rows[40].service_id, second);
    writer.close().unwrap();
}

#[test]
fn incomplete_tail_is_never_truncated_and_valid_prefix_survives_restart() {
    let root = temp();
    let writer = Writer::open(&root.0, Uuid::new_v4()).unwrap();
    let sink = writer.sink();
    assert!(sink.submit(payload(1)));
    sink.flush().unwrap();
    writer.close().unwrap();
    let path = root
        .0
        .join("terminal-audit/00000000000000000001.audit.jsonl");
    let mut bytes = fs::read(&path).unwrap();
    bytes.extend_from_slice(b"{\"seq\":2,\"service_id\":");
    fs::write(&path, &bytes).unwrap();
    let writer = Writer::open(&root.0, Uuid::new_v4()).unwrap();
    let sink = writer.sink();
    assert_eq!(sink.status().incomplete_segments, 1);
    assert_eq!(sink.status().synced_through, 1);
    assert!(sink.submit(payload(2)));
    sink.flush().unwrap();
    writer.close().unwrap();
    assert_eq!(fs::read(path).unwrap(), bytes);
    let writer = Writer::open(&root.0, Uuid::new_v4()).unwrap();
    let sink = writer.sink();
    assert_eq!(sink.page(0, 2, 128).unwrap().records.len(), 2);
    assert_eq!(sink.status().incomplete_segments, 1);
    writer.close().unwrap();
}

#[test]
fn actual_rotation_is_bounded_and_reports_fixed_snapshot_retention_gap() {
    let root = temp();
    let mut disk = Disk::open(&root.0).unwrap();
    let service_id = Uuid::new_v4();
    // Small typed metadata events hit the production 1024-record segment bound.
    for seq in 1..=(SEGMENT_RECORDS * (SEGMENTS + 1)) as u64 {
        disk.append(Record {
            seq,
            service_id,
            payload: payload(seq),
        })
        .unwrap();
    }
    disk.sync().unwrap();
    assert_eq!(disk.segments.len(), SEGMENTS);
    drop(disk);
    let writer = Writer::open(&root.0, Uuid::new_v4()).unwrap();
    let sink = writer.sink();
    let status = sink.status();
    assert_eq!(status.retained_records, SEGMENT_RECORDS * SEGMENTS);
    assert_eq!(status.available_from, SEGMENT_RECORDS as u64);
    let old = sink.page(0, 100, 128).unwrap();
    assert!(old.gap);
    assert!(old.records.is_empty());
    assert_eq!(old.next_cursor, 100);
    let page = sink
        .page(status.available_from, status.synced_through, 128)
        .unwrap();
    assert!(!page.gap);
    assert_eq!(page.records[0].seq, status.available_from + 1);
    writer.close().unwrap();
    assert_eq!(
        fs::read_dir(root.0.join("terminal-audit")).unwrap().count(),
        SEGMENTS + 1
    );
}

#[test]
fn queue_pressure_is_sticky_observable_and_never_calls_a_record_synced() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let shared = Arc::new(Mutex::new(Shared {
        status: Status {
            state: State::Healthy,
            accepted_through: 0,
            synced_through: 0,
            rejected_records: 0,
            incomplete_segments: 0,
            available_from: 0,
            retained_records: 0,
        },
        rows: VecDeque::new(),
    }));
    let sink = Sink {
        sender,
        shared,
        service_id: Uuid::new_v4(),
    };
    assert!(sink.submit(payload(1)));
    assert!(!sink.submit(payload(2)));
    drop(receiver);
    assert!(!sink.submit(payload(3)));
    let status = sink.status();
    assert_eq!(status.state, State::QueueFull);
    assert_eq!(status.accepted_through, 1);
    assert_eq!(status.synced_through, 0);
    assert_eq!(status.rejected_records, 2);
}

#[test]
fn actual_storage_write_failure_never_advances_synced_watermark() {
    let root = temp();
    let mut disk = Disk::open(&root.0).unwrap();
    disk.rotate().unwrap();
    // Replace ONLY the test writer's held file with an actual read-only handle.
    // write_all now gets the OS error, not an injected return value.
    let old = disk.segments.pop_back().unwrap();
    drop(old.file);
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options
        .open(disk.path.join("00000000000000000001.audit.jsonl"))
        .unwrap();
    disk.segments.push_back(Segment { file, ..old });
    let shared = Arc::new(Mutex::new(Shared {
        status: Status {
            state: State::Healthy,
            accepted_through: 0,
            synced_through: 0,
            rejected_records: 0,
            incomplete_segments: 0,
            available_from: 0,
            retained_records: 0,
        },
        rows: VecDeque::new(),
    }));
    let (sender, receiver) = mpsc::sync_channel(4);
    // FlushFileBuffers also genuinely fails without write access; no committed
    // rows/watermark are published by the independent sync path.
    assert!(commit(&disk, &shared).is_err());
    assert_eq!(shared.lock().unwrap().status.synced_through, 0);
    let sink = Sink {
        sender,
        shared: shared.clone(),
        service_id: Uuid::new_v4(),
    };
    let thread = thread::spawn(move || run(disk, receiver, shared));
    assert!(sink.submit(payload(1)));
    let status = sink.flush().unwrap();
    assert_eq!(status.state, State::StorageFailure);
    assert_eq!(status.synced_through, 0);
    assert_eq!(status.accepted_through, 1);
    assert!(!sink.submit(payload(2)));
    sink.sender.send(Message::Close).unwrap();
    thread.join().unwrap();
}

#[test]
fn recovered_interior_holes_are_reported_even_when_the_first_segment_survives() {
    let root = temp();
    let mut disk = Disk::open(&root.0).unwrap();
    let service_id = Uuid::new_v4();
    disk.append(Record {
        seq: 1,
        service_id,
        payload: payload(1),
    })
    .unwrap();
    disk.rotate().unwrap();
    disk.append(Record {
        seq: 5,
        service_id,
        payload: payload(5),
    })
    .unwrap();
    disk.sync().unwrap();
    drop(disk);
    let writer = Writer::open(&root.0, Uuid::new_v4()).unwrap();
    let sink = writer.sink();
    let page = sink.page(0, 5, 128).unwrap();
    assert!(page.gap);
    assert_eq!(page.available_from, 0);
    assert_eq!(page.records.len(), 2);
    assert!(!sink.page(4, 5, 128).unwrap().gap);
    assert!(sink.page(1, 4, 128).unwrap().gap);
    writer.close().unwrap();
}

#[test]
fn unknown_files_and_hard_links_are_preserved_and_not_opened_for_append() {
    let root = temp();
    let directory = root.0.join("terminal-audit");
    fs::create_dir(&directory).unwrap();
    let unknown = directory.join("user.txt");
    fs::write(&unknown, b"keep").unwrap();
    assert!(Writer::open(&root.0, Uuid::new_v4()).is_err());
    assert_eq!(fs::read(&unknown).unwrap(), b"keep");
    fs::remove_file(unknown).unwrap();
    let source = root.0.join("outside.txt");
    fs::write(&source, b"keep outside").unwrap();
    let link = directory.join("00000000000000000001.audit.jsonl");
    fs::hard_link(&source, &link).unwrap();
    assert!(Writer::open(&root.0, Uuid::new_v4()).is_err());
    assert_eq!(fs::read(source).unwrap(), b"keep outside");
}

#[test]
fn root_and_leaf_junctions_are_rejected_without_touching_their_targets() {
    let root = temp();
    let target = root.0.join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), b"keep").unwrap();
    let link = root.0.join("terminal-audit");
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    assert!(result.status.success());
    struct Link(std::path::PathBuf);
    impl Drop for Link {
        fn drop(&mut self) {
            fs::remove_dir(&self.0).unwrap();
        }
    }
    let owned = Link(link.clone());
    assert!(Writer::open(&root.0, Uuid::new_v4()).is_err());
    assert!(Writer::open(&link, Uuid::new_v4()).is_err());
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    drop(owned);
    fs::create_dir(&link).unwrap();
    let leaf = link.join("00000000000000000001.audit.jsonl");
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&leaf)
        .arg(&target)
        .output()
        .unwrap();
    assert!(result.status.success());
    let owned = Link(leaf);
    assert!(Writer::open(&root.0, Uuid::new_v4()).is_err());
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
    drop(owned);
}

#[test]
fn interrupted_headers_are_preserved_but_unknown_magic_is_rejected() {
    for bytes in [
        b"".as_slice(),
        b"{\"format\":\"shared-terminal-audit-v1".as_slice(),
    ] {
        let root = temp();
        let dir = root.0.join("terminal-audit");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("00000000000000000001.audit.jsonl");
        fs::write(&path, bytes).unwrap();
        let writer = Writer::open(&root.0, Uuid::new_v4()).unwrap();
        let sink = writer.sink();
        assert_eq!(sink.status().incomplete_segments, 1);
        assert!(sink.submit(payload(1)));
        assert_eq!(sink.flush().unwrap().synced_through, 1);
        writer.close().unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    let root = temp();
    let dir = root.0.join("terminal-audit");
    fs::create_dir(&dir).unwrap();
    let path = dir.join("00000000000000000001.audit.jsonl");
    fs::write(&path, b"user data").unwrap();
    assert!(Writer::open(&root.0, Uuid::new_v4()).is_err());
    assert_eq!(fs::read(path).unwrap(), b"user data");
}

#[test]
fn policy_and_rpc_records_strictly_reject_secret_fields_and_keep_u64_claims_exact() {
    let payload = Payload::Rpc(rpc_audit::Event {
        seq: 1,
        time: rpc_audit::Time {
            unix_ms: 1,
            elapsed_ms: 1,
        },
        attempt: rpc_audit::Attempt {
            attempt_id: Uuid::new_v4(),
            started_seq: 1,
            origin: rpc_audit::Origin {
                pipe_id: Uuid::new_v4(),
                client_id: None,
                kind: rpc_audit::OriginKind::Unauthenticated,
                peer_pid: None,
            },
            request: rpc_audit::Descriptor {
                area: rpc_audit::Area::Transport,
                verb: rpc_audit::Verb::Hello,
                wire_id: None,
                request_id: None,
                requested_scope: None,
                resource: None,
            },
        },
        phase: rpc_audit::Phase::Received {},
    });
    let row = Record {
        seq: u64::MAX,
        service_id: Uuid::new_v4(),
        payload,
    };
    let encoded = serde_json::to_vec(&row).unwrap();
    assert_eq!(serde_json::from_slice::<Record>(&encoded).unwrap(), row);
    let mut value = serde_json::to_value(&row).unwrap();
    value["password"] = serde_json::json!("secret");
    assert!(serde_json::from_value::<Record>(value).is_err());
}
