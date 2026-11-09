//! Explicit finite diagnostics; these are not a T19 throughput acceptance run.
use super::*;
use std::fs::File;
use std::sync::atomic::AtomicU64;

struct PhaseGate {
    gate: Arc<Gate>,
    phase: u8,
}
impl Journal for PhaseGate {
    fn append(&mut self, _: &Record) -> io::Result<(u64, u64)> {
        if self.phase == 0 {
            self.gate.block();
        }
        Ok((1, 1))
    }
    fn checkpoint(&mut self, sync: bool) -> io::Result<()> {
        if (self.phase == 1 && !sync) || (self.phase == 2 && sync) {
            self.gate.block();
        }
        Ok(())
    }
    fn finish(&mut self, _: &Status) -> io::Result<()> {
        self.gate.finishes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[test]
fn p22_controlled_io_stalls_consume_exact_queue_without_holding_status_lock() {
    for phase in 0..3 {
        let meta = metadata();
        let gate = Arc::new(Gate::default());
        let g = gate.clone();
        let mut logger = Logger::spawn(meta.clone(), move |_, _| {
            Ok(Box::new(PhaseGate { gate: g, phase }))
        })
        .unwrap();
        wait(|| logger.status().phase == Phase::Recording);
        let inflight = if phase == 0 {
            assert!(logger.submit(data(&meta, 1, &[b'a'; 4096])));
            1
        } else {
            0
        };
        wait(|| gate.entered.load(Ordering::SeqCst) > 0);
        assert!(
            logger.shared.try_lock().is_ok(),
            "blocked I/O must not hold the submission/status mutex"
        );
        let began = Instant::now();
        for seq in 1 + inflight..=32 + inflight {
            assert!(logger.submit(data(&meta, seq, &[b'a'; 4096])));
        }
        assert!(!logger.submit(data(&meta, 33 + inflight, &[b'b'; 4096])));
        let submit_elapsed = began.elapsed();
        let before = logger.status();
        assert_eq!(before.failure, Some(Failure::QueueFull));
        assert_eq!(before.rejected_raw_bytes, 4096);
        gate.release();
        let done = logger.join();
        assert_eq!(done.accepted_records, 32 + inflight);
        assert_eq!(done.written_records, 32 + inflight);
        assert_eq!(gate.finishes.load(Ordering::SeqCst), 0);
        assert!(!done.durable);
        println!(
            "P22_CONTROL {}",
            serde_json::json!({"phase":(["append","flush","sync"][phase as usize]),"queued":32,"inflight":inflight,"accepted":done.accepted_records,"written":done.written_records,"rejected_bytes":done.rejected_raw_bytes,"status_mutex_free":true,"submit_batch_us":submit_elapsed.as_micros()})
        );
    }
}
#[derive(Default)]
struct Timing {
    calls: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
}
impl Timing {
    fn add(&self, began: Instant) {
        let us = began.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.sum_us.fetch_add(us, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
    }
    fn json(&self) -> serde_json::Value {
        serde_json::json!({"calls":self.calls.load(Ordering::Relaxed),"sum_us":self.sum_us.load(Ordering::Relaxed),"max_us":self.max_us.load(Ordering::Relaxed)})
    }
}
#[derive(Default)]
struct Phases {
    setup: Timing,
    append: Timing,
    flush: Timing,
    sync: Timing,
    status: Timing,
}
impl Phases {
    fn json(&self) -> serde_json::Value {
        serde_json::json!({"setup":self.setup.json(),"append":self.append.json(),"flush":self.flush.json(),"sync":self.sync.json(),"status_query":self.status.json()})
    }
}
struct Timed {
    inner: storage::FileJournal,
    timing: Arc<Phases>,
}
impl Journal for Timed {
    fn append(&mut self, r: &Record) -> io::Result<(u64, u64)> {
        let t = Instant::now();
        let v = self.inner.append(r);
        self.timing.append.add(t);
        v
    }
    fn checkpoint(&mut self, sync: bool) -> io::Result<()> {
        let t = Instant::now();
        let v = self.inner.checkpoint(sync);
        if sync {
            self.timing.sync.add(t);
        } else {
            self.timing.flush.add(t);
        }
        v
    }
    fn readable(&self) -> Option<ReadableStatus> {
        self.inner.readable()
    }
    fn readable_guard(&self) -> io::Result<Option<File>> {
        self.inner.readable_guard()
    }
    fn finish(&mut self, s: &Status) -> io::Result<()> {
        self.inner.finish(s)
    }
}
#[test]
#[ignore = "explicit finite local-disk phase diagnosis only"]
fn p22_finite_file_journal_phase_probe() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let root = workspace
        .join("artifacts")
        .join(format!("P22-journal-probe-中文-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut groups = vec![];
    for (label, n, live, audit_on) in [
        ("one-internal", 1, false, false),
        ("eight-internal", 8, false, false),
        ("eight-live", 8, true, false),
        ("eight-live-audit", 8, true, true),
    ] {
        let directory = root.join(label);
        fs::create_dir(&directory).unwrap();
        let managed = ManagedRoot::open(&directory).unwrap();
        let mut loggers = vec![];
        let mut metas = vec![];
        let mut phases = vec![];
        for index in 0..n {
            let meta = metadata();
            let p = Arc::new(Phases::default());
            let stats = p.clone();
            let path = managed.path().to_path_buf();
            let logger = Logger::spawn(meta.clone(), move |id, m| {
                let t = Instant::now();
                let inner = if live {
                    storage::FileJournal::open_readable(
                        path,
                        id,
                        m,
                        Limits::default(),
                        &format!("probe-{index}"),
                    )?
                } else {
                    storage::FileJournal::open(path, id, m, Limits::default())?
                };
                stats.setup.add(t);
                Ok(Box::new(Timed {
                    inner,
                    timing: stats,
                }))
            })
            .unwrap();
            loggers.push(logger);
            metas.push(meta);
            phases.push(p);
        }
        for l in &loggers {
            wait(|| l.status().phase == Phase::Recording);
        }
        let audit = if audit_on {
            Some(crate::audit::Writer::open(&directory, Uuid::new_v4()).unwrap())
        } else {
            None
        };
        let sink = audit.as_ref().map(|a| a.sink());
        let mut audit_ok = 0u64;
        let began = Instant::now();
        let mut counts = vec![0u64; n];
        let mut max_late = 0u128;
        for slot in 0..195u64 {
            let due = Duration::from_nanos(slot * 1_000_000_000 / 65);
            if let Some(wait) = due.checked_sub(began.elapsed()) {
                thread::sleep(wait);
            }
            max_late = max_late.max(began.elapsed().saturating_sub(due).as_micros());
            let i = slot as usize % n;
            for _ in 0..4 {
                counts[i] += 1;
                let _ = loggers[i].submit(data(&metas[i], counts[i], &[b'x'; 4096]));
            }
            if let Some(sink) = &sink {
                use session_core::{audit_journal::Payload, rpc_audit as r};
                let attempt = Uuid::new_v4();
                let origin = r::Origin {
                    pipe_id: metas[i].connection.connection_id.0,
                    client_id: Some(Uuid::new_v4()),
                    kind: r::OriginKind::Desktop,
                    peer_pid: Some(std::process::id()),
                };
                for (j, phase) in [
                    r::Phase::Received {},
                    r::Phase::ReturnedOk {},
                    r::Phase::ReplyWritten {},
                ]
                .into_iter()
                .enumerate()
                {
                    let seq = slot * 3 + j as u64 + 1;
                    let event = r::Event {
                        seq,
                        time: r::Time {
                            unix_ms: seq,
                            elapsed_ms: began.elapsed().as_millis() as u64,
                        },
                        attempt: r::Attempt {
                            attempt_id: attempt,
                            started_seq: slot * 3 + 1,
                            origin,
                            request: r::Descriptor {
                                area: r::Area::Session,
                                verb: r::Verb::Fixture,
                                wire_id: Some(slot as u32 + 1),
                                request_id: None,
                                requested_scope: None,
                                resource: Some(r::Resource {
                                    kind: r::ResourceKind::Connection,
                                    id: metas[i].connection.connection_id.0,
                                    connection: Some(metas[i].connection),
                                }),
                            },
                        },
                        phase,
                    };
                    audit_ok += u64::from(sink.submit(Payload::Rpc(event)));
                }
            }
            for (l, p) in loggers.iter().zip(&phases) {
                let t = Instant::now();
                let _ = l.status();
                p.status.add(t);
            }
        }
        let offered_wall = began.elapsed().as_secs_f64();
        let mut statuses = vec![];
        for l in &mut loggers {
            statuses.push(l.join());
        }
        let audit_status = audit.map(|a| a.close().unwrap());
        let report = serde_json::json!({"group":label,"streams":n,"live":live,"audit":audit_on,"offered_bytes":195*4*4096,"offered_wall_s":offered_wall,"max_schedule_late_us":max_late,"phases":phases.iter().map(|p|p.json()).collect::<Vec<_>>(),"status":statuses,"audit_accepted":audit_ok,"audit_final":audit_status});
        println!("P22_FINITE {}", report);
        groups.push(report);
    }
    serde_json::to_writer_pretty(
        File::create(root.join("phase-result.json")).unwrap(),
        &groups,
    )
    .unwrap();
    println!("P22_DIAGNOSTIC_COMPLETE {}", root.display());
}
