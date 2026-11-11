//! One owned-file pair. The only worker schedule change is the first sync seed.
use super::*;
use serde_json::{Value, json};
use std::{io::BufReader, path::Path, sync::Barrier};

const STREAMS: usize = 8;
const SLOTS: u64 = 195;
const BLOCK: usize = 4096;
const MAX_RECORDS: usize = 100;

struct Checkpoint {
    start_ns: u64,
    end_ns: u64,
}

#[derive(Default)]
struct Observed {
    anchor_ns: AtomicU64,
    appends: Mutex<Vec<u64>>,
    checkpoints: Mutex<Vec<Checkpoint>>,
}

struct Phased {
    journal: storage::FileJournal,
    clock: Instant,
    advance: Duration,
    observed: Arc<Observed>,
}

fn ns(clock: Instant) -> u64 {
    clock.elapsed().as_nanos().try_into().unwrap()
}

impl Journal for Phased {
    fn test_first_sync_advance(&self) -> Duration {
        self.observed
            .anchor_ns
            .store(ns(self.clock), Ordering::Relaxed);
        self.advance
    }

    fn append(&mut self, record: &Record) -> io::Result<(u64, u64)> {
        let start = ns(self.clock);
        let mut calls = self.observed.appends.lock().unwrap();
        assert!(calls.len() < MAX_RECORDS);
        calls.push(start);
        drop(calls);
        self.journal.append(record)
    }

    fn checkpoint(&mut self, sync: bool) -> io::Result<()> {
        let before = self.journal.readable().unwrap();
        self.journal.checkpoint(sync)?;
        let after = self.journal.readable().unwrap();
        assert_eq!(after.written_records, before.written_records);
        assert_eq!(after.flushed_records, after.written_records);
        assert_eq!(after.flushed_bytes, after.written_bytes);
        assert_eq!(
            (after.synced_records, after.synced_bytes),
            if sync {
                (after.written_records, after.written_bytes)
            } else {
                (before.synced_records, before.synced_bytes)
            },
        );
        Ok(())
    }

    fn test_periodic_checkpoint(&mut self, sync: bool) -> io::Result<()> {
        let start_ns = ns(self.clock);
        self.checkpoint(sync)?;
        if sync {
            let mut calls = self.observed.checkpoints.lock().unwrap();
            assert!(calls.len() < 8);
            calls.push(Checkpoint {
                start_ns,
                end_ns: ns(self.clock),
            });
        }
        Ok(())
    }

    fn readable(&self) -> Option<ReadableStatus> {
        self.journal.readable()
    }

    fn readable_guard(&self) -> io::Result<Option<File>> {
        self.journal.readable_guard()
    }

    fn finish(&mut self, status: &Status) -> io::Result<()> {
        self.journal.finish(status)
    }
}

fn bytes(index: usize, seq: u64) -> [u8; BLOCK] {
    [b'a' + ((index as u64 * 7 + seq) % 26) as u8; BLOCK]
}

fn verify(directory: &Path, index: usize, meta: &Metadata, offered: u64, status: &Status) {
    let written = status.written_records;
    let lost = status.rejected_records;
    assert_eq!(written, status.accepted_records);
    assert_eq!(written + lost, offered);
    assert_eq!(status.written_raw_bytes, written * BLOCK as u64);
    assert_eq!(status.rejected_raw_bytes, lost * BLOCK as u64);
    assert_eq!(status.source_gap_bytes, 0);
    assert_eq!(status.retired_segments, 0);
    assert_eq!(status.last_segment, 1);
    assert_eq!(status.failure, (lost != 0).then_some(Failure::QueueFull));
    assert!(status.worker_finished);
    assert_eq!(status.durable, lost == 0);
    let log = directory
        .join("terminal-logs")
        .join(status.log_id.to_string());
    assert_eq!(log.join("completion.json").exists(), status.durable);
    let (_, raw, text) = read_pair(&log, 1);
    assert_eq!(raw.len() as u64, written);
    assert_eq!(text.len() as u64, written + 1);
    let live = status.readable.as_ref().unwrap();
    assert_eq!(live.written_records, written);
    assert_eq!(live.flushed_records, written);
    assert_eq!(live.synced_records, written);
    assert_eq!(live.flushed_bytes, live.written_bytes);
    assert_eq!(live.synced_bytes, live.written_bytes);
    let header = format!(
        "# 终端通信日志 UTF-8\r\n# 日志 {}；连接 {} / {}\r\n# 仅起录后的接收输出/终端回显；不含认证表单，未独立记录发送；起录前内容未记录。\r\n",
        status.log_id, meta.connection.connection_id.0, meta.connection.generation,
    );
    let mut input =
        BufReader::new(File::open(directory.join("logs").join(&live.filename)).unwrap());
    use std::io::Read;
    let mut actual_header = vec![0; header.len()];
    input.read_exact(&mut actual_header).unwrap();
    assert_eq!(actual_header, header.as_bytes());
    for (i, (raw, text)) in raw.into_iter().zip(text.into_iter().skip(1)).enumerate() {
        let seq = i as u64 + 1;
        let expected = bytes(index, seq);
        assert_eq!(raw.text_seq, seq);
        assert_eq!(raw.source_seq, Some(seq));
        assert_eq!(raw.bytes, expected);
        assert_eq!(
            text["event"],
            serde_json::to_value(data(meta, seq, &expected).text).unwrap()
        );
        let mut actual = [0; BLOCK];
        input.read_exact(&mut actual).unwrap();
        assert_eq!(actual, expected);
    }
    assert_eq!(input.read(&mut [0]).unwrap(), 0);
    assert_eq!(
        live.written_bytes,
        header.len() as u64 + written * BLOCK as u64
    );
}

fn group(directory: &Path, phased: bool) -> Value {
    fs::create_dir(directory).unwrap();
    let managed = ManagedRoot::open(directory).unwrap();
    let audit = crate::audit::Writer::open(directory, Uuid::new_v4()).unwrap();
    let sink = audit.sink();
    let clock = Instant::now();
    let opened = Arc::new(Barrier::new(STREAMS + 1));
    let mut streams = vec![];
    for index in 0..STREAMS {
        let mut meta = metadata();
        meta.protocol = Protocol::Fixture;
        let observations = Arc::new(Observed::default());
        let advance_ms = if phased {
            100 * (STREAMS - 1 - index) as u64
        } else {
            0
        };
        let worker_opened = opened.clone();
        let observed = observations.clone();
        let path = managed.path().to_owned();
        let logger = Logger::spawn(meta.clone(), move |id, meta| {
            let journal = storage::FileJournal::open_readable(
                path,
                id,
                meta,
                Limits::default(),
                &format!("phase-{index}"),
            );
            worker_opened.wait();
            Ok(Box::new(Phased {
                journal: journal?,
                clock,
                advance: Duration::from_millis(advance_ms),
                observed,
            }))
        })
        .unwrap();
        streams.push((
            logger,
            meta,
            observations,
            advance_ms,
            0,
            Vec::with_capacity(MAX_RECORDS),
        ));
    }
    opened.wait();
    for (_, _, observations, _, _, _) in &streams {
        wait(|| observations.anchor_ns.load(Ordering::Relaxed) != 0);
    }
    let began = Instant::now();
    let begin_ns = ns(clock);
    assert!(
        streams.iter().all(|(_, _, observed, _, _, _)| {
            begin_ns - observed.anchor_ns.load(Ordering::Relaxed) < 100_000_000
        }),
        "workers did not start in the same initial flush interval"
    );
    let mut audit_accepted = 0;
    let mut max_late_ns = 0;
    for slot in 0..SLOTS {
        let due = Duration::from_nanos(slot * 1_000_000_000 / 65);
        if let Some(delay) = due.checked_sub(began.elapsed()) {
            thread::sleep(delay);
        }
        max_late_ns = max_late_ns.max(began.elapsed().saturating_sub(due).as_nanos());
        let index = slot as usize % STREAMS;
        let (logger, meta, _, _, offered, accepted) = &mut streams[index];
        for _ in 0..4 {
            *offered += 1;
            if logger.submit(data(meta, *offered, &bytes(index, *offered))) {
                accepted.push(ns(clock));
            }
        }
        audit_accepted += submit_audit_burst(&sink, meta, slot, began);
    }
    let end_ns = ns(clock);
    for (logger, ..) in &streams {
        logger.stop();
    }
    let statuses: Vec<_> = streams.iter_mut().map(|stream| stream.0.join()).collect();
    let audit_status = audit.close().unwrap();
    assert_eq!(audit_accepted, SLOTS * 3);
    assert_eq!(audit_status.accepted_through, audit_accepted);
    assert_eq!(audit_status.synced_through, audit_accepted);
    assert_eq!(audit_status.rejected_records, 0);
    assert_eq!(audit_status.incomplete_segments, 0);

    let mut first_syncs = vec![];
    let mut stream_reports = vec![];
    for (index, ((_, meta, observed, advance_ms, offered, accepted), status)) in
        streams.iter().zip(&statuses).enumerate()
    {
        verify(directory, index, meta, *offered, status);
        let appends = observed.appends.lock().unwrap();
        assert_eq!(appends.len(), accepted.len());
        // The next accepted record is at the head of the queue after the
        // preceding dequeue. Clip the measurement before the stop/drain phase.
        let mut previous = begin_ns;
        let mut max_busy_ns = 0;
        for (&dequeued, &accepted_at) in appends.iter().zip(accepted) {
            max_busy_ns = max_busy_ns.max(
                dequeued
                    .min(end_ns)
                    .saturating_sub(previous.max(accepted_at)),
            );
            previous = dequeued;
        }
        let anchor_ns = observed.anchor_ns.load(Ordering::Relaxed);
        let checkpoints = observed.checkpoints.lock().unwrap();
        let mut periodic_syncs = vec![];
        let mut earliest = anchor_ns + (1000 - advance_ms) * 1_000_000;
        for call in checkpoints.iter().filter(|call| call.start_ns < end_ns) {
            assert!(
                call.start_ns >= earliest,
                "periodic sync started before its eligible phase"
            );
            // The test observes the end just before the production clock is reset.
            earliest = call.end_ns + 1_000_000_000;
            periodic_syncs.push([call.start_ns - begin_ns, call.end_ns - begin_ns]);
        }
        if let Some(&first) = periodic_syncs.first() {
            first_syncs.push(first);
        }
        stream_reports.push(json!({
            "source":index,"first_target_ms":1000-advance_ms,"timer_anchor_ns":anchor_ns,
            "offered":offered,"accepted":status.accepted_records,"written":status.written_records,
            "rejected":status.rejected_records,"queue_full":status.failure.is_some(),
            "max_pending_consumer_pause_ns":max_busy_ns,
            "periodic_syncs_ns_from_offer":periodic_syncs,
            "max_periodic_sync_ns":periodic_syncs.iter().map(|[a,b]| (*b).min(end_ns-begin_ns)-a).max(),
            "flushed":status.readable.as_ref().unwrap().flushed_records,
            "synced":status.readable.as_ref().unwrap().synced_records,
            "byte_and_watermark_checks":true,"durable":status.durable,
        }));
    }
    let first_spread_ns = first_syncs
        .iter()
        .map(|p| p[0])
        .max()
        .zip(first_syncs.iter().map(|p| p[0]).min())
        .map(|(last, first)| last - first);
    let peak_first_sync_overlap = first_syncs
        .iter()
        .map(|[start, _]| {
            first_syncs
                .iter()
                .filter(|[a, b]| a <= start && start < b)
                .count()
        })
        .max();
    json!({
        "phased":phased,"sources":stream_reports,"offered_bytes":SLOTS*4*BLOCK as u64,
        "audit_accepted_and_synced":audit_accepted,"max_offer_lateness_ns":max_late_ns,
        "offering_ns":end_ns-begin_ns,"first_sync_observed_count":first_syncs.len(),
        "first_sync_start_spread_ns":first_spread_ns,"peak_first_sync_overlap":peak_first_sync_overlap,
        "queue_full_sources":statuses.iter().filter(|s|s.failure == Some(Failure::QueueFull)).count(),
        "max_pending_consumer_pause_ns":stream_reports.iter().map(|s|s["max_pending_consumer_pause_ns"].as_u64().unwrap()).max(),
    })
}

#[test]
#[ignore = "one explicit owned-file same-phase vs advanced-phase comparison; never service load"]
fn p22_first_periodic_sync_phase_comparison() {
    let artifacts = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../artifacts")
        .canonicalize()
        .unwrap();
    let root = artifacts.join(format!("P22-sync-phase-中文-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut reports = vec![];
    for (name, phased) in [("same-phase", false), ("fixed-phase", true)] {
        let directory = root.join(name);
        reports.push(group(&directory, phased));
        assert_eq!(root.canonicalize().unwrap(), root);
        assert_eq!(directory.canonicalize().unwrap(), directory);
        assert_eq!(directory.parent(), Some(root.as_path()));
        fs::remove_dir_all(directory).unwrap();
        if !phased {
            let control = reports.last().unwrap();
            if control["queue_full_sources"] == 0
                || control["first_sync_observed_count"] != STREAMS
                || control["peak_first_sync_overlap"].as_u64().unwrap_or(0) < 2
                || control["max_offer_lateness_ns"].as_u64().unwrap() > 250_000_000
            {
                break;
            }
        }
    }
    serde_json::to_writer_pretty(
        File::create_new(root.join("comparison.json")).unwrap(),
        &reports,
    )
    .unwrap();
    println!("P22_SYNC_PHASE_COMPLETE {}", root.display());
}
