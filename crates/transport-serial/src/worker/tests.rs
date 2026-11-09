use super::*;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
enum Op {
    Write(Vec<u8>),
    Dtr(bool),
    Rts(bool),
    Break(bool),
    Closed,
}
struct Fake {
    log: Arc<Mutex<Vec<Op>>>,
    gate: Option<mpsc::Receiver<()>>,
    entered: Option<mpsc::SyncSender<()>>,
    chunks: usize,
    generated: usize,
    fail_write: bool,
    write_calls: usize,
    fail_control: bool,
    fail_break_assert: bool,
    stop_on_write: Option<Arc<AtomicBool>>,
}
impl Fake {
    fn new() -> Self {
        Self {
            log: Arc::default(),
            gate: None,
            entered: None,
            chunks: 0,
            generated: 0,
            fail_write: false,
            write_calls: 0,
            fail_control: false,
            fail_break_assert: false,
            stop_on_write: None,
        }
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.log.lock().unwrap().push(Op::Closed);
    }
}
impl Port for Fake {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(gate) = self.gate.take() {
            gate.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        if self.chunks > 0 {
            if self.generated == self.chunks {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            buffer.fill((self.generated % 256) as u8);
            self.generated += 1;
            Ok(ReadOutcome::Data(buffer.len()))
        } else {
            thread::sleep(Duration::from_millis(1));
            Ok(ReadOutcome::Idle)
        }
    }
    fn write_once(&mut self, bytes: &[u8]) -> io::Result<usize> {
        assert!(bytes.len() <= 1024);
        self.write_calls += 1;
        if self.fail_write && self.write_calls > 1 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let count = if self.fail_write {
            2.min(bytes.len())
        } else {
            bytes.len()
        };
        self.log
            .lock()
            .unwrap()
            .push(Op::Write(bytes[..count].to_vec()));
        if let Some(stop) = &self.stop_on_write {
            stop.store(true, Ordering::Release);
        }
        Ok(count)
    }
    fn control(&mut self, command: &Command) -> io::Result<()> {
        let operation = match command {
            Command::Dtr(v) => Op::Dtr(*v),
            Command::Rts(v) => Op::Rts(*v),
            Command::Break(v) => Op::Break(*v),
            _ => panic!(),
        };
        self.log.lock().unwrap().push(operation);
        if (self.fail_control && matches!(command, Command::Rts(_) | Command::Break(false)))
            || (self.fail_break_assert && matches!(command, Command::Break(true)))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(())
    }
}
fn until(mut test: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !test() {
        assert!(Instant::now() < deadline, "worker did not settle");
        thread::sleep(Duration::from_millis(1));
    }
}

// A driver may return many tiny reads within one service polling period.
// Do not need a device, sleeps, or real logs to reproduce that burst.
struct Fragmented {
    remaining: usize,
    offset: usize,
}
impl Port for Fragmented {
    fn bytes_to_read(&self) -> io::Result<u32> {
        Ok(self.remaining as u32)
    }
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
        if self.remaining == 0 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        buffer[0] = (self.offset % 251) as u8;
        self.offset += 1;
        self.remaining -= 1;
        Ok(ReadOutcome::Data(1))
    }
    fn write_once(&mut self, _: &[u8]) -> io::Result<usize> {
        panic!("receive-only test must not write")
    }
    fn control(&mut self, _: &Command) -> io::Result<()> {
        panic!("receive-only test must not change lines")
    }
}

#[test]
fn byte_bound_partial_overflow_and_recovery_never_merge_across_a_gap() {
    let mut state = ReceiveState::default();
    let capacity = OUTPUT_CHUNKS * READ_BYTES;
    for _ in 0..capacity - 2 {
        state.receive(&[1]).unwrap();
    }
    state.receive(&[2, 3, 4, 5, 6]).unwrap();
    assert_eq!(state.status.read_bytes, (capacity + 3) as u64);
    assert_eq!(state.status.dropped_bytes, 3);
    assert_eq!(state.output.len(), OUTPUT_CHUNKS);
    assert_eq!(
        state.output.iter().map(|c| c.bytes.len()).sum::<usize>(),
        capacity
    );
    assert!(
        state
            .output
            .iter()
            .all(|c| c.bytes.capacity() == READ_BYTES)
    );
    assert_eq!(
        &state.output.back().unwrap().bytes[READ_BYTES - 2..],
        &[2, 3]
    );
    state.output.pop_front();
    state.receive(&[7, 8]).unwrap();
    let tail = state.output.back().unwrap();
    assert_eq!(tail.offset, (capacity + 3) as u64);
    assert_eq!(tail.bytes, [7, 8]);
    // A counter failure must not partially append or wrap a gap count.
    state.status.read_bytes = u64::MAX;
    assert!(state.receive(&[9]).is_err());
    assert_eq!(state.status.dropped_bytes, 3);
    assert_eq!(state.output.back().unwrap().bytes, [7, 8]);
}

#[test]
fn paced_write_receive_pump_uses_the_same_bounded_fragment_queue() {
    let state = Mutex::new(ReceiveState::default());
    let mut port = Fragmented {
        remaining: 100,
        offset: 0,
    };
    while port.remaining > 0 {
        pump_available(&mut port, &state).unwrap();
    }
    let state = state.lock().unwrap();
    assert_eq!(state.status.read_bytes, 100);
    assert_eq!(state.status.dropped_bytes, 0);
    assert_eq!(state.output.len(), 1);
    assert_eq!(state.output[0].bytes, (0..100).collect::<Vec<u8>>());
}

#[test]
fn ten_ms_consumer_preserves_exact_data_or_explicit_gap_for_fragmented_overload() {
    let length = OUTPUT_CHUNKS * READ_BYTES * 4 + 103;
    let mut worker = Worker::start(
        move || {
            Ok(Fragmented {
                remaining: length,
                offset: 0,
            })
        },
        None,
    )
    .unwrap();
    let mut cursor = 0;
    let mut gaps = 0;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(
            Instant::now() < deadline,
            "fragmented worker did not settle"
        );
        thread::sleep(Duration::from_millis(10));
        loop {
            match worker.read_output() {
                Output::Data { offset, bytes } => {
                    assert_eq!(offset, cursor);
                    for (index, byte) in bytes.iter().enumerate() {
                        assert_eq!(*byte, ((offset as usize + index) % 251) as u8);
                    }
                    cursor += bytes.len() as u64;
                }
                Output::Gap { from, to } => {
                    assert_eq!(from, cursor);
                    assert!(to > from);
                    gaps += to - from;
                    cursor = to;
                }
                Output::Idle => break,
                Output::Closed(End::ReadFailed(io::ErrorKind::BrokenPipe)) => {
                    let status = worker.join().unwrap();
                    assert_eq!(cursor, length as u64);
                    assert_eq!(status.read_bytes, cursor);
                    assert_eq!(status.dropped_bytes, gaps);
                    return;
                }
                _ => panic!("unexpected terminal state"),
            }
        }
    }
}

#[test]
fn cancellation_and_join_keep_the_unfilled_receive_tail() {
    struct Tail {
        burst: Fragmented,
        idle: Arc<AtomicBool>,
    }
    impl Port for Tail {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
            if self.burst.remaining > 0 {
                return self.burst.read(buffer);
            }
            self.idle.store(true, Ordering::Release);
            thread::sleep(Duration::from_millis(1));
            Ok(ReadOutcome::Idle)
        }
        fn write_once(&mut self, _: &[u8]) -> io::Result<usize> {
            panic!()
        }
        fn control(&mut self, _: &Command) -> io::Result<()> {
            panic!()
        }
    }
    let idle = Arc::new(AtomicBool::new(false));
    let signal = idle.clone();
    let mut worker = Worker::start(
        move || {
            Ok(Tail {
                burst: Fragmented {
                    remaining: 137,
                    offset: 0,
                },
                idle: signal,
            })
        },
        None,
    )
    .unwrap();
    until(|| idle.load(Ordering::Acquire));
    assert_eq!(worker.join().unwrap().phase, Phase::Ended(End::Cancelled));
    assert!(
        matches!(worker.read_output(), Output::Data { offset: 0, bytes } if bytes == (0..137).collect::<Vec<u8>>())
    );
    assert!(matches!(
        worker.read_output(),
        Output::Closed(End::Cancelled)
    ));
}

#[test]
fn small_read_burst_retains_bytes_until_consumer_polls_and_after_join() {
    let length = READ_BYTES * 2 + 137;
    let mut worker = Worker::start(
        move || {
            Ok(Fragmented {
                remaining: length,
                offset: 0,
            })
        },
        None,
    )
    .unwrap();
    until(|| worker.is_finished());
    let status = worker.join().unwrap();
    assert_eq!(status.read_bytes, length as u64);
    assert_eq!(status.dropped_bytes, 0);
    let mut actual = Vec::new();
    loop {
        match worker.read_output() {
            Output::Data { offset, bytes } => {
                assert_eq!(offset, actual.len() as u64);
                actual.extend(bytes);
            }
            Output::Closed(End::ReadFailed(io::ErrorKind::BrokenPipe)) => break,
            _ => panic!("burst lost data or terminal state"),
        }
    }
    assert_eq!(
        actual,
        (0..length).map(|i| (i % 251) as u8).collect::<Vec<_>>()
    );
}
fn outcome(ticket: &Ticket) -> Outcome {
    let mut result = None;
    until(|| {
        result = ticket.poll().unwrap();
        result.is_some()
    });
    result.unwrap()
}
fn gated(mut fake: Fake) -> (Worker, mpsc::Sender<()>, Arc<Mutex<Vec<Op>>>) {
    let log = fake.log.clone();
    let (release, gate) = mpsc::channel();
    let (signal, entered) = mpsc::sync_channel(1);
    fake.gate = Some(gate);
    fake.entered = Some(signal);
    let worker = Worker::start(move || Ok(fake), None).unwrap();
    entered.recv_timeout(Duration::from_secs(3)).unwrap();
    (worker, release, log)
}

#[test]
fn raw_writes_and_controls_share_fifo_and_break_is_released_before_close() {
    let (mut worker, release, log) = gated(Fake::new());
    let raw = vec![0, 255, 13, 10];
    let commands = [
        Command::Write(raw.clone()),
        Command::Dtr(false),
        Command::Rts(true),
        Command::Break(true),
        Command::Write(b"tail".to_vec()),
    ];
    let tickets: Vec<_> = commands
        .into_iter()
        .map(|command| worker.submit(command).unwrap())
        .collect();
    release.send(()).unwrap();
    assert_eq!(
        outcome(&tickets[0]),
        Outcome::Written {
            driver_accepted: 4,
            complete: true,
            error: None,
            cancelled: false
        }
    );
    for ticket in &tickets[1..4] {
        assert_eq!(outcome(ticket), Outcome::Controlled);
    }
    assert!(matches!(
        outcome(&tickets[4]),
        Outcome::Written { complete: true, .. }
    ));
    let status = worker.join().unwrap();
    assert_eq!(status.phase, Phase::Ended(End::Cancelled));
    assert_eq!(
        *log.lock().unwrap(),
        [
            Op::Write(raw),
            Op::Dtr(false),
            Op::Rts(true),
            Op::Break(true),
            Op::Write(b"tail".to_vec()),
            Op::Break(false),
            Op::Closed
        ]
    );
    assert!(matches!(
        worker.read_output(),
        Output::Closed(End::Cancelled)
    ));
}

#[test]
fn queue_is_bounded_and_cancellation_settles_unsent_commands_without_dispatch() {
    let (mut worker, release, log) = gated(Fake::new());
    let tickets: Vec<_> = (0..QUEUED_COMMANDS)
        .map(|_| worker.submit(Command::Write(vec![1])).unwrap())
        .collect();
    assert!(matches!(
        worker.submit(Command::Dtr(true)),
        Err(SubmitError::Full)
    ));
    assert!(matches!(
        worker.submit(Command::Write(vec![])),
        Err(SubmitError::InvalidInput)
    ));
    assert!(matches!(
        worker.submit(Command::Write(vec![0; super::super::MAX_CHUNK + 1])),
        Err(SubmitError::InvalidInput)
    ));
    assert!(matches!(
        worker.submit(Command::PacedWrite {
            bytes: vec![0; 65536],
            chunk_bytes: 1,
            interval: Duration::from_nanos(999999)
        }),
        Err(SubmitError::InvalidInput)
    ));
    worker.cancel();
    assert!(matches!(
        worker.submit(Command::Dtr(true)),
        Err(SubmitError::Stopped)
    ));
    release.send(()).unwrap();
    worker.join().unwrap();
    for ticket in tickets {
        assert_eq!(outcome(&ticket), Outcome::CancelledBeforeDispatch);
    }
    assert_eq!(*log.lock().unwrap(), [Op::Closed]);
}

#[test]
fn partial_write_failure_stops_the_connection_and_never_dispatches_queued_tail() {
    let mut fake = Fake::new();
    fake.fail_write = true;
    let (mut worker, release, log) = gated(fake);
    let first = worker.submit(Command::Write(b"abcd".to_vec())).unwrap();
    let tail = worker
        .submit(Command::Write(b"never-send".to_vec()))
        .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        outcome(&first),
        Outcome::Written {
            driver_accepted: 2,
            complete: false,
            error: Some(io::ErrorKind::BrokenPipe),
            cancelled: false
        }
    );
    assert_eq!(outcome(&tail), Outcome::CancelledBeforeDispatch);
    until(|| worker.is_finished());
    assert_eq!(
        worker.join().unwrap().phase,
        Phase::Ended(End::WriteFailed(io::ErrorKind::BrokenPipe))
    );
    assert_eq!(
        *log.lock().unwrap(),
        [Op::Write(b"ab".to_vec()), Op::Closed]
    );
}

#[test]
fn slow_consumer_does_not_block_reads_and_missing_tail_is_an_explicit_gap() {
    let mut fake = Fake::new();
    fake.chunks = 40;
    let mut worker = Worker::start(move || Ok(fake), None).unwrap();
    until(|| worker.is_finished());
    let status = worker.status();
    assert_eq!(status.read_bytes, (40 * READ_BYTES) as u64);
    assert_eq!(
        status.dropped_bytes,
        ((40 - OUTPUT_CHUNKS) * READ_BYTES) as u64
    );
    for index in 0..OUTPUT_CHUNKS {
        let Output::Data { offset, bytes } = worker.read_output() else {
            panic!()
        };
        assert_eq!(offset, (index * READ_BYTES) as u64);
        assert_eq!(bytes, vec![index as u8; READ_BYTES]);
    }
    assert!(
        matches!(worker.read_output(), Output::Gap { from, to } if from == (OUTPUT_CHUNKS * READ_BYTES) as u64 && to == status.read_bytes)
    );
    assert!(matches!(
        worker.read_output(),
        Output::Closed(End::ReadFailed(io::ErrorKind::BrokenPipe))
    ));
    worker.join().unwrap();
}

#[test]
fn concurrent_consumer_accounts_for_every_byte_as_data_or_gap_without_false_offsets() {
    let mut fake = Fake::new();
    fake.chunks = 2000;
    let mut worker = Worker::start(move || Ok(fake), None).unwrap();
    let mut cursor = 0;
    let mut gaps = 0;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(Instant::now() < deadline);
        match worker.read_output() {
            Output::Data { offset, bytes } => {
                assert_eq!(offset, cursor);
                cursor += bytes.len() as u64;
            }
            Output::Gap { from, to } => {
                assert_eq!(from, cursor);
                assert!(to > from);
                gaps += to - from;
                cursor = to;
            }
            Output::Idle => thread::yield_now(),
            Output::Closed(End::ReadFailed(io::ErrorKind::BrokenPipe)) => break,
            _ => panic!(),
        }
    }
    let status = worker.join().unwrap();
    assert_eq!(cursor, (2000 * READ_BYTES) as u64);
    assert_eq!(status.read_bytes, cursor);
    assert_eq!(status.dropped_bytes, gaps);
}

#[test]
fn control_failure_is_visible_and_failed_break_cleanup_is_not_hidden() {
    let mut fake = Fake::new();
    fake.fail_control = true;
    let (mut worker, release, log) = gated(fake);
    let denied = worker.submit(Command::Rts(true)).unwrap();
    let valid = worker.submit(Command::Dtr(false)).unwrap();
    let brk = worker.submit(Command::Break(true)).unwrap();
    release.send(()).unwrap();
    assert_eq!(
        outcome(&denied),
        Outcome::ControlFailed(io::ErrorKind::InvalidInput)
    );
    assert_eq!(outcome(&valid), Outcome::Controlled);
    assert_eq!(outcome(&brk), Outcome::Controlled);
    let status = worker.join().unwrap();
    assert_eq!(
        status.break_cleanup_error,
        Some(io::ErrorKind::InvalidInput)
    );
    assert_eq!(log.lock().unwrap().last(), Some(&Op::Closed));
}

#[test]
fn open_failure_has_no_ready_connection_or_fabricated_exit_status() {
    let mut worker =
        Worker::start::<Fake>(|| Err(io::ErrorKind::PermissionDenied.into()), None).unwrap();
    until(|| worker.is_finished());
    assert_eq!(
        worker.status().phase,
        Phase::Ended(End::OpenFailed(io::ErrorKind::PermissionDenied))
    );
    assert!(matches!(
        worker.submit(Command::Dtr(true)),
        Err(SubmitError::Stopped)
    ));
    assert!(matches!(
        worker.read_output(),
        Output::Closed(End::OpenFailed(io::ErrorKind::PermissionDenied))
    ));
    worker.join().unwrap();
}

#[test]
fn cancellation_during_write_stops_after_the_known_prefix_without_replay() {
    let stop = Arc::new(AtomicBool::new(false));
    let mut fake = Fake::new();
    fake.stop_on_write = Some(stop.clone());
    let bytes = vec![2; 4096];
    assert_eq!(
        write(&mut fake, &bytes, &stop),
        Outcome::Written {
            driver_accepted: 1024,
            complete: false,
            error: None,
            cancelled: true
        }
    );
    assert_eq!(*fake.log.lock().unwrap(), [Op::Write(vec![2; 1024])]);
}

#[test]
fn failed_break_assertion_still_attempts_clear_before_closing() {
    let mut fake = Fake::new();
    fake.fail_break_assert = true;
    let (mut worker, release, log) = gated(fake);
    let ticket = worker.submit(Command::Break(true)).unwrap();
    release.send(()).unwrap();
    assert_eq!(
        outcome(&ticket),
        Outcome::ControlFailed(io::ErrorKind::InvalidInput)
    );
    let status = worker.join().unwrap();
    assert_eq!(status.break_cleanup_error, None);
    assert_eq!(
        *log.lock().unwrap(),
        [Op::Break(true), Op::Break(false), Op::Closed]
    );
}

#[test]
fn paced_write_waits_at_least_the_requested_interval_between_complete_chunks() {
    struct Timed(Vec<Instant>);
    impl Port for Timed {
        fn read(&mut self, _: &mut [u8]) -> io::Result<ReadOutcome> {
            Ok(ReadOutcome::Idle)
        }
        fn write_once(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.push(Instant::now());
            assert_eq!(bytes.len(), 1);
            Ok(1)
        }
        fn control(&mut self, _: &Command) -> io::Result<()> {
            Ok(())
        }
    }
    let mut port = Timed(vec![]);
    let interval = Duration::from_millis(20);
    assert!(matches!(
        write_paced(
            &mut port,
            b"abc",
            &AtomicBool::new(false),
            1,
            interval,
            None,
            |_| Ok(())
        ),
        Outcome::Written {
            complete: true,
            driver_accepted: 3,
            ..
        }
    ));
    assert_eq!(port.0.len(), 3);
    for times in port.0.windows(2) {
        assert!(times[1].duration_since(times[0]) >= interval);
    }
}

#[test]
fn revoked_queued_commands_never_reach_driver_and_worker_keeps_serving_user() {
    let (mut worker, release, log) = gated(Fake::new());
    let allowed = Arc::new(AtomicBool::new(true));
    let flag = allowed.clone();
    let dispatch: DispatchGuard = Arc::new(move || flag.load(Ordering::Acquire));
    let write = worker
        .submit_guarded(Command::Write(b"never".to_vec()), Some(dispatch.clone()))
        .unwrap();
    let control = worker
        .submit_guarded(Command::Break(true), Some(dispatch))
        .unwrap();
    allowed.store(false, Ordering::Release);
    let user = worker.submit(Command::Write(b"user".to_vec())).unwrap();
    release.send(()).unwrap();
    assert_eq!(outcome(&write), Outcome::CancelledBeforeDispatch);
    assert_eq!(outcome(&control), Outcome::CancelledBeforeDispatch);
    assert!(matches!(
        outcome(&user),
        Outcome::Written {
            complete: true,
            driver_accepted: 4,
            ..
        }
    ));
    assert_eq!(*log.lock().unwrap(), [Op::Write(b"user".to_vec())]);
    assert_eq!(worker.status().phase, Phase::Ready);
    worker.join().unwrap();
}

#[test]
fn revocation_after_a_driver_call_stops_the_tail_without_ending_the_connection() {
    // Even without a pacing delay, every short write/driver chunk must recheck.
    for short in [false, true] {
        let revoked = Arc::new(AtomicBool::new(false));
        let mut fake = Fake::new();
        fake.stop_on_write = Some(revoked.clone());
        fake.fail_write = short;
        let (mut worker, release, log) = gated(fake);
        let flag = revoked.clone();
        let dispatch: DispatchGuard = Arc::new(move || !flag.load(Ordering::Acquire));
        let ticket = worker
            .submit_guarded(
                Command::PacedWrite {
                    bytes: vec![42; 4096],
                    chunk_bytes: 1024,
                    interval: Duration::from_millis(10),
                },
                Some(dispatch),
            )
            .unwrap();
        release.send(()).unwrap();
        let accepted = if short { 2 } else { 1024 };
        assert_eq!(
            outcome(&ticket),
            Outcome::Written {
                driver_accepted: accepted,
                complete: false,
                error: None,
                cancelled: true
            }
        );
        assert_eq!(*log.lock().unwrap(), [Op::Write(vec![42; accepted])]);
        assert_eq!(worker.status().phase, Phase::Ready);
        // A control fence succeeds on the same OS worker after revocation.
        assert_eq!(
            outcome(&worker.submit(Command::Dtr(true)).unwrap()),
            Outcome::Controlled
        );
        worker.join().unwrap();
    }
}

#[test]
fn revocation_after_interrupted_driver_call_keeps_zero_known_bytes_unknown() {
    struct Interrupted(Arc<AtomicBool>);
    impl Port for Interrupted {
        fn read(&mut self, _: &mut [u8]) -> io::Result<ReadOutcome> {
            Ok(ReadOutcome::Idle)
        }
        fn write_once(&mut self, _: &[u8]) -> io::Result<usize> {
            self.0.store(false, Ordering::Release);
            Err(io::ErrorKind::Interrupted.into())
        }
        fn control(&mut self, _: &Command) -> io::Result<()> {
            panic!("unexpected control")
        }
    }
    let allowed = Arc::new(AtomicBool::new(true));
    let flag = allowed.clone();
    let dispatch: DispatchGuard = Arc::new(move || flag.load(Ordering::Acquire));
    let mut port = Interrupted(allowed);
    assert_eq!(
        write_paced(
            &mut port,
            b"a",
            &AtomicBool::new(false),
            1,
            Duration::ZERO,
            Some(&dispatch),
            |_| Ok(())
        ),
        Outcome::Written {
            driver_accepted: 0,
            complete: false,
            error: None,
            cancelled: true
        }
    );
}
