use super::*;
use crate::timeline_fixture::{Event, Kind, Operation, Source, Timeline};
use session_core::access::{AuditEvent, AuditKind, Denial};
use session_core::audit_journal::Payload;

struct PausedJournal {
    journal: storage::FileJournal,
    entered: mpsc::Sender<()>,
    resume: mpsc::Receiver<()>,
}

impl Journal for PausedJournal {
    fn checkpoint(&mut self, sync: bool) -> io::Result<()> {
        self.journal.checkpoint(sync)
    }

    fn readable(&self) -> Option<ReadableStatus> {
        self.journal.readable()
    }

    fn append(&mut self, record: &Record) -> io::Result<(u64, u64)> {
        if record.text.seq == 2 {
            timeline_io!(TestPause, None, {
                self.entered.send(()).unwrap();
                self.resume.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })?;
        }
        self.journal.append(record)
    }

    fn finish(&mut self, status: &Status) -> io::Result<()> {
        self.journal.finish(status)
    }
}

#[test]
fn p22_timeline_joins_real_file_operations_and_audit_around_first_queue_fault() {
    let temp = Temp::new();
    let managed = ManagedRoot::open(&temp.0).unwrap();
    let audit_root = temp.0.join("audit-fixture");
    fs::create_dir(&audit_root).unwrap();
    let timeline = Timeline::default();
    let audit = timeline
        .with_audit(|| audit::Writer::open(&audit_root, Uuid::new_v4()))
        .unwrap();
    let root = managed.path().to_owned();
    let meta = metadata();
    let (entered, wait_entered) = mpsc::channel();
    let (resume, wait_resume) = mpsc::channel();
    let mut logger = timeline
        .with_logger(0, || {
            Logger::spawn(meta.clone(), move |id, meta| {
                Ok(Box::new(PausedJournal {
                    journal: storage::FileJournal::open_readable(
                        root,
                        id,
                        meta,
                        Limits::default(),
                        "synthetic",
                    )?,
                    entered,
                    resume: wait_resume,
                }))
            })
        })
        .unwrap();
    assert!(!timeline.has_fault());
    assert!(logger.submit(data(&meta, 1, b"synthetic-sentinel")));
    assert!(logger.submit(data(&meta, 2, b"synthetic-sentinel")));
    wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();

    let audit_sink = audit.sink();
    assert!(audit_sink.submit(Payload::Policy(AuditEvent {
        seq: 1,
        timestamp_ms: 123,
        kind: AuditKind::Denied,
        client_id: Some(Uuid::new_v4()),
        scope: None,
        request_id: Some(Uuid::new_v4()),
        denial: Some(Denial::PermissionDenied),
    })));
    assert_eq!(audit_sink.flush().unwrap().synced_through, 1);
    let last_accepted = QUEUE_RECORDS as u64 + 2;
    for seq in 3..=last_accepted {
        assert!(logger.submit(data(&meta, seq, b"synthetic-sentinel")));
    }
    assert!(!logger.submit(data(&meta, last_accepted + 1, b"synthetic-sentinel")));
    assert!(!logger.submit(data(&meta, last_accepted + 2, b"synthetic-sentinel")));
    resume.send(()).unwrap();
    let status = logger.join();
    assert_eq!(status.failure, Some(Failure::QueueFull));
    assert_eq!(status.accepted_records, last_accepted);
    assert_eq!(status.written_records, last_accepted);
    assert_eq!(status.rejected_records, 2);
    assert!(!status.durable);
    assert!(
        !managed
            .path()
            .join(status.log_id.to_string())
            .join("completion.json")
            .exists()
    );
    assert_eq!(audit.close().unwrap().synced_through, 1);

    let summary = timeline.take_summary().unwrap();
    assert!(timeline.take_summary().is_none());
    assert_eq!(summary.evicted_before_fault, 0);
    assert_eq!(summary.omitted_after_fault, 0);
    let first = summary.first_fault.unwrap();
    assert_eq!(first.source, Source::Logger(0));
    assert_eq!(first.kind, Kind::QueueFull);
    assert_eq!(first.seq, last_accepted + 1);
    assert_eq!(first.accepted_records, Some(last_accepted));
    assert_eq!(first.written_records, Some(1));
    assert!(
        summary
            .events
            .iter()
            .zip(summary.events.iter().skip(1))
            .all(|(a, b)| { a.ordinal + 1 == b.ordinal && a.elapsed_ns <= b.elapsed_ns })
    );
    let event = |source, seq, kind| -> Event {
        *summary
            .events
            .iter()
            .find(|event| (event.source, event.seq, event.kind) == (source, seq, kind))
            .unwrap_or_else(|| panic!("missing {source:?} {seq} {kind:?}"))
    };
    let source = Source::Logger(0);
    for seq in 1..=last_accepted {
        let attempt = event(source, seq, Kind::TrySend);
        let accepted = event(source, seq, Kind::Accepted);
        let dequeue = event(source, seq, Kind::Dequeue);
        assert!(attempt.ordinal < accepted.ordinal);
        assert!(attempt.ordinal < dequeue.ordinal);
        let mut previous = dequeue.ordinal;
        for operation in [
            Operation::RawWrite,
            Operation::JsonlWrite,
            Operation::LiveWrite,
        ] {
            let begin = event(source, seq, Kind::IoBegin(operation));
            let end = event(source, seq, Kind::IoEnd(operation));
            assert!(previous < begin.ordinal && begin.ordinal < end.ordinal);
            previous = end.ordinal;
        }
    }
    assert_eq!(
        summary
            .events
            .iter()
            .filter(|event| event.kind == Kind::Dequeue)
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        (1..=last_accepted).collect::<Vec<_>>()
    );
    let pause = event(source, 2, Kind::IoBegin(Operation::TestPause));
    let resumed = event(source, 2, Kind::IoEnd(Operation::TestPause));
    let audit_begin = event(Source::Audit, 1, Kind::IoBegin(Operation::AuditSync));
    let audit_end = event(Source::Audit, 1, Kind::IoEnd(Operation::AuditSync));
    let rejected_closed = event(source, last_accepted + 2, Kind::RejectedClosed);
    assert!(pause.ordinal < audit_begin.ordinal && audit_begin.ordinal < audit_end.ordinal);
    assert!(audit_end.ordinal < first.ordinal && first.ordinal < rejected_closed.ordinal);
    assert!(rejected_closed.ordinal < resumed.ordinal);
    let mut previous = event(source, last_accepted, Kind::IoEnd(Operation::LiveWrite)).ordinal;
    for operation in [
        Operation::LiveFlush,
        Operation::LiveSync,
        Operation::RawSync,
        Operation::JsonlSync,
    ] {
        // The final draining barrier may follow an earlier periodic checkpoint at this sequence.
        let checkpoint_event = |kind| {
            summary
                .events
                .iter()
                .rev()
                .find(|event| {
                    (event.source, event.seq, event.kind) == (source, last_accepted, kind)
                })
                .unwrap()
        };
        let begin = checkpoint_event(Kind::IoBegin(operation));
        let end = checkpoint_event(Kind::IoEnd(operation));
        assert_eq!(begin.written_records, Some(last_accepted));
        assert_eq!(end.written_records, Some(last_accepted));
        assert!(previous < begin.ordinal && begin.ordinal < end.ordinal);
        previous = end.ordinal;
    }
    let json = serde_json::to_string(&summary).unwrap();
    assert!(!json.contains("synthetic-sentinel"));
    assert!(!json.contains(&status.log_id.to_string()));
    println!("P22_TIMELINE {json}");
}
