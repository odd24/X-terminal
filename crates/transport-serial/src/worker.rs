//! Bounded, service-owned blocking I/O. No device exit codes, reconnect or replay.
//! `join` must run outside UI/Tokio event threads. Drop requests cancellation;
//! the owner must join before retiring/replacing a connection generation.
use super::{Config, ReadOutcome, SerialConnection, device::Device, invalid};
use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
};

#[cfg(test)]
mod tests;

pub const QUEUED_COMMANDS: usize = 16;
pub const OUTPUT_CHUNKS: usize = 16;
pub const READ_BYTES: usize = 4096;
pub const MAX_WORKERS: usize = 64;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
struct Permit;
impl Permit {
    fn acquire() -> io::Result<Self> {
        ACTIVE
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_WORKERS).then_some(count + 1)
            })
            .map(|_| Self)
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "serial worker limit reached"))
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Cancelled,
    OpenFailed(io::ErrorKind),
    ReadFailed(io::ErrorKind),
    WriteFailed(io::ErrorKind),
    WorkerFailed,
    CounterExhausted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Opening,
    Ready,
    Ended(End),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    pub phase: Phase,
    pub read_bytes: u64,
    pub dropped_bytes: u64,
    pub break_cleanup_error: Option<io::ErrorKind>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            phase: Phase::Opening,
            read_bytes: 0,
            dropped_bytes: 0,
            break_cleanup_error: None,
        }
    }
}

// Deliberately no Debug for commands or received raw data.
pub enum Command {
    Write(Vec<u8>),
    PacedWrite {
        bytes: Vec<u8>,
        chunk_bytes: usize,
        interval: std::time::Duration,
    },
    Dtr(bool),
    Rts(bool),
    Break(bool),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Count covers only successful driver writes. A failed/cancelled call may
    /// have transmitted additional bytes; complete never means device execution.
    Written {
        driver_accepted: usize,
        complete: bool,
        error: Option<io::ErrorKind>,
        cancelled: bool,
    },
    Controlled,
    ControlFailed(io::ErrorKind),
    CancelledBeforeDispatch,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitError {
    InvalidInput,
    NotReady,
    Full,
    Stopped,
}
pub struct Ticket(mpsc::Receiver<Outcome>);
impl Ticket {
    /// A lost worker can leave an in-flight action unknown. A disconnected ticket
    /// must never be interpreted as proof that no bytes/control action were sent.
    pub fn poll(&self) -> Result<Option<Outcome>, mpsc::TryRecvError> {
        match self.0.try_recv() {
            Ok(result) => Ok(Some(result)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
struct Work {
    command: Command,
    reply: mpsc::SyncSender<Outcome>,
    dispatch: Option<DispatchGuard>,
}
/// Trusted in-process service callback, never supplied through IPC. Called after
/// waits and before each driver operation (including short-write retries). True
/// commits at most one <=1024-byte attempt; revocation cannot retract that call.
pub type DispatchGuard = Arc<dyn Fn() -> bool + Send + Sync>;
struct Chunk {
    offset: u64,
    bytes: Vec<u8>,
}
pub enum Output {
    Data { offset: u64, bytes: Vec<u8> },
    Gap { from: u64, to: u64 },
    Idle,
    Closed(End),
}
pub struct Worker {
    commands: mpsc::SyncSender<Work>,
    output: mpsc::Receiver<Chunk>,
    pending: Option<Chunk>,
    cursor: u64,
    state: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}
/// In-process transport adapter, never an IPC surface. Production service uses
/// SerialConnection; test factories are gated by the test-backend Cargo feature.
pub trait Port: Send {
    fn bytes_to_read(&self) -> io::Result<u32> {
        Ok(0)
    }
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<ReadOutcome>;
    fn write_once(&mut self, bytes: &[u8]) -> io::Result<usize>;
    fn control(&mut self, command: &Command) -> io::Result<()>;
}
impl Port for SerialConnection {
    fn bytes_to_read(&self) -> io::Result<u32> {
        self.port.bytes_to_read().map_err(Into::into)
    }
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<ReadOutcome> {
        self.read(bytes)
    }
    fn write_once(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.port.write(bytes)
    }
    fn control(&mut self, command: &Command) -> io::Result<()> {
        match command {
            Command::Dtr(value) => self.set_dtr(*value).map_err(Into::into),
            Command::Rts(value) => self.set_rts(*value).map_err(Into::into),
            Command::Break(value) => self.set_break(*value).map_err(Into::into),
            Command::Write(_) | Command::PacedWrite { .. } => Err(invalid("not a control command")),
        }
    }
}

impl Worker {
    #[cfg(feature = "test-backend")]
    pub fn test_backend<P: Port + 'static>(port: P) -> io::Result<Self> {
        Self::start(move || Ok(port), None)
    }
    pub fn spawn(config: Config, selected: Device) -> io::Result<Self> {
        Self::spawn_guarded(config, selected, None)
    }
    /// Runs the service's final authorization on the OS worker before opening a device.
    pub fn spawn_guarded(
        config: Config,
        selected: Device,
        dispatch: Option<DispatchGuard>,
    ) -> io::Result<Self> {
        config.validate()?;
        Self::start(
            move || SerialConnection::open_selected(&config, &selected),
            dispatch,
        )
    }
    #[cfg(feature = "test-backend")]
    pub fn test_backend_guarded<P: Port + 'static>(
        open: impl FnOnce() -> io::Result<P> + Send + 'static,
        dispatch: Option<DispatchGuard>,
    ) -> io::Result<Self> {
        Self::start(open, dispatch)
    }
    fn start<P: Port + 'static>(
        open: impl FnOnce() -> io::Result<P> + Send + 'static,
        dispatch: Option<DispatchGuard>,
    ) -> io::Result<Self> {
        let permit = Permit::acquire()?;
        let (commands, receiver) = mpsc::sync_channel(QUEUED_COMMANDS);
        let (sender, output) = mpsc::sync_channel(OUTPUT_CHUNKS);
        let state = Arc::new(Mutex::new(Status::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_state = state.clone();
        let thread_stop = stop.clone();
        let task = thread::Builder::new()
            .name("serial-io".into())
            .spawn(move || {
                let _permit = permit;
                let end_guard = EndGuard(thread_state.clone());
                let end = if thread_stop.load(Ordering::Acquire)
                    || dispatch.as_ref().is_some_and(|allow| !allow())
                    || thread_stop.load(Ordering::Acquire)
                {
                    End::Cancelled
                } else {
                    match open() {
                        Ok(mut port) => {
                            thread_state.lock().unwrap().phase = Phase::Ready;
                            run(&mut port, &receiver, &sender, &thread_state, &thread_stop)
                        }
                        Err(error) => End::OpenFailed(error.kind()),
                    }
                };
                // Unsent commands get an explicit settlement before publishing terminal state.
                for work in receiver.try_iter() {
                    let _ = work.reply.try_send(Outcome::CancelledBeforeDispatch);
                }
                end_guard.0.lock().unwrap().phase = Phase::Ended(end);
            })?;
        Ok(Self {
            commands,
            output,
            pending: None,
            cursor: 0,
            state,
            stop,
            task: Some(task),
        })
    }
    pub fn status(&self) -> Status {
        *self.state.lock().unwrap()
    }
    pub fn submit(&self, command: Command) -> Result<Ticket, SubmitError> {
        self.submit_guarded(command, None)
    }
    pub fn submit_guarded(
        &self,
        mut command: Command,
        dispatch: Option<DispatchGuard>,
    ) -> Result<Ticket, SubmitError> {
        if let Command::PacedWrite {
            bytes,
            chunk_bytes,
            interval,
        } = &command
            && (bytes.is_empty()
                || bytes.len() > super::MAX_CHUNK
                || !(1..=1024).contains(chunk_bytes)
                || *interval > std::time::Duration::from_secs(1)
                || interval
                    .as_nanos()
                    .saturating_mul(bytes.len().div_ceil(*chunk_bytes).saturating_sub(1) as u128)
                    > 60_000_000_000)
        {
            return Err(SubmitError::InvalidInput);
        }
        if matches!(&command, Command::Write(bytes) if bytes.is_empty() || bytes.len() > super::MAX_CHUNK)
        {
            return Err(SubmitError::InvalidInput);
        }
        if self.stop.load(Ordering::Acquire) {
            return Err(SubmitError::Stopped);
        }
        match self.status().phase {
            Phase::Opening => return Err(SubmitError::NotReady),
            Phase::Ended(_) => return Err(SubmitError::Stopped),
            Phase::Ready => {}
        }
        if let Command::Write(bytes) | Command::PacedWrite { bytes, .. } = &mut command {
            // Retain payload length, not an arbitrarily overallocated caller buffer.
            *bytes = std::mem::take(bytes).into_boxed_slice().into_vec();
        }
        let (reply, ticket) = mpsc::sync_channel(1);
        self.commands
            .try_send(Work {
                command,
                reply,
                dispatch,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => SubmitError::Full,
                mpsc::TrySendError::Disconnected(_) => SubmitError::Stopped,
            })?;
        Ok(Ticket(ticket))
    }
    pub fn read_output(&mut self) -> Output {
        if let Some(chunk) = self.pending.take() {
            self.cursor = chunk.offset + chunk.bytes.len() as u64;
            return Output::Data {
                offset: chunk.offset,
                bytes: chunk.bytes,
            };
        }
        // Producers publish a chunk/counters under this same lock. Empty+counter
        // observation is atomic, so a concurrent send cannot manufacture a false gap.
        let state = self.state.lock().unwrap();
        match self.output.try_recv() {
            Ok(chunk) if chunk.offset > self.cursor => {
                let from = self.cursor;
                self.cursor = chunk.offset;
                self.pending = Some(chunk);
                Output::Gap {
                    from,
                    to: self.cursor,
                }
            }
            Ok(chunk) => {
                self.cursor = chunk.offset + chunk.bytes.len() as u64;
                Output::Data {
                    offset: chunk.offset,
                    bytes: chunk.bytes,
                }
            }
            Err(_) if state.read_bytes > self.cursor => {
                let from = self.cursor;
                self.cursor = state.read_bytes;
                Output::Gap {
                    from,
                    to: self.cursor,
                }
            }
            Err(_) => match state.phase {
                Phase::Ended(end) => Output::Closed(end),
                _ => Output::Idle,
            },
        }
    }
    pub fn cancel(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(task) = &self.task {
            task.thread().unpark();
        }
        #[cfg(windows)]
        if let Some(task) = &self.task {
            use std::os::windows::io::AsRawHandle;
            // Best effort only: a driver/open/control can still fail to honor cancellation.
            unsafe {
                windows_sys::Win32::System::IO::CancelSynchronousIo(task.as_raw_handle());
            }
        }
    }
    pub fn is_finished(&self) -> bool {
        self.task.as_ref().is_none_or(JoinHandle::is_finished)
    }
    /// Blocking. The service must isolate this join and may ultimately need to end
    /// its owned process for a broken driver; there is no promised remote rollback.
    pub fn join(&mut self) -> io::Result<Status> {
        self.cancel();
        if let Some(task) = self.task.take() {
            task.join()
                .map_err(|_| io::Error::other("serial worker failed"))?;
        }
        Ok(self.status())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel();
    }
}
struct EndGuard(Arc<Mutex<Status>>);
impl Drop for EndGuard {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        if !matches!(state.phase, Phase::Ended(_)) {
            state.phase = Phase::Ended(End::WorkerFailed);
        }
    }
}

#[cfg(test)]
fn write<P: Port>(port: &mut P, bytes: &[u8], stop: &AtomicBool) -> Outcome {
    write_paced(
        port,
        bytes,
        stop,
        1024,
        std::time::Duration::ZERO,
        None,
        |_| Ok(()),
    )
}
fn write_paced<P: Port>(
    port: &mut P,
    bytes: &[u8],
    stop: &AtomicBool,
    chunk_bytes: usize,
    interval: std::time::Duration,
    dispatch: Option<&DispatchGuard>,
    mut pump: impl FnMut(&mut P) -> io::Result<()>,
) -> Outcome {
    let mut accepted = 0;
    let mut attempted = false;
    let mut interruptions = 0;
    loop {
        if accepted == bytes.len() {
            return Outcome::Written {
                driver_accepted: accepted,
                complete: true,
                error: None,
                cancelled: false,
            };
        }
        if stop.load(Ordering::Acquire) {
            return Outcome::Written {
                driver_accepted: accepted,
                complete: false,
                error: None,
                cancelled: true,
            };
        }
        let end = ((accepted / chunk_bytes + 1) * chunk_bytes).min(bytes.len());
        if dispatch.is_some_and(|allow| !allow()) {
            return if !attempted {
                Outcome::CancelledBeforeDispatch
            } else {
                Outcome::Written {
                    driver_accepted: accepted,
                    complete: false,
                    error: None,
                    cancelled: true,
                }
            };
        }
        attempted = true;
        match port.write_once(&bytes[accepted..end]) {
            Ok(count) if count > 0 && count <= end - accepted => {
                accepted += count;
                if accepted == end
                    && accepted < bytes.len()
                    && let Err(error) = pump(port)
                {
                    return Outcome::Written {
                        driver_accepted: accepted,
                        complete: false,
                        error: Some(error.kind()),
                        cancelled: stop.load(Ordering::Acquire),
                    };
                }
                if accepted == end && accepted < bytes.len() && !interval.is_zero() {
                    let deadline = std::time::Instant::now() + interval;
                    while !stop.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                        if let Err(error) = pump(port) {
                            return Outcome::Written {
                                driver_accepted: accepted,
                                complete: false,
                                error: Some(error.kind()),
                                cancelled: stop.load(Ordering::Acquire),
                            };
                        }
                        thread::park_timeout(
                            deadline
                                .saturating_duration_since(std::time::Instant::now())
                                .min(std::time::Duration::from_millis(10)),
                        );
                    }
                }
            }
            Ok(0) => {
                return Outcome::Written {
                    driver_accepted: accepted,
                    complete: false,
                    error: Some(io::ErrorKind::WriteZero),
                    cancelled: false,
                };
            }
            Ok(_) => {
                return Outcome::Written {
                    driver_accepted: accepted,
                    complete: false,
                    error: Some(io::ErrorKind::InvalidData),
                    cancelled: false,
                };
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted && interruptions < 8 => {
                interruptions += 1
            }
            Err(error) => {
                return Outcome::Written {
                    driver_accepted: accepted,
                    complete: false,
                    error: Some(error.kind()),
                    cancelled: stop.load(Ordering::Acquire),
                };
            }
        }
    }
}
fn run<P: Port>(
    port: &mut P,
    commands: &mpsc::Receiver<Work>,
    output: &mpsc::SyncSender<Chunk>,
    state: &Mutex<Status>,
    stop: &AtomicBool,
) -> End {
    let mut buffer = [0u8; READ_BYTES];
    let mut break_asserted = false;
    let end = loop {
        if stop.load(Ordering::Acquire) {
            break End::Cancelled;
        }
        if let Ok(work) = commands.try_recv() {
            let result = if stop.load(Ordering::Acquire) {
                Outcome::CancelledBeforeDispatch
            } else {
                match &work.command {
                    Command::Write(bytes) => write_paced(
                        port,
                        bytes,
                        stop,
                        1024,
                        std::time::Duration::ZERO,
                        work.dispatch.as_ref(),
                        |port| pump_available(port, output, state),
                    ),
                    Command::PacedWrite {
                        bytes,
                        chunk_bytes,
                        interval,
                    } => write_paced(
                        port,
                        bytes,
                        stop,
                        *chunk_bytes,
                        *interval,
                        work.dispatch.as_ref(),
                        |port| pump_available(port, output, state),
                    ),
                    command => {
                        if work.dispatch.as_ref().is_some_and(|allow| !allow()) {
                            let _ = work.reply.try_send(Outcome::CancelledBeforeDispatch);
                            continue;
                        }
                        // A failed assertion can still have changed the line. Keep a
                        // best-effort clear pending until an explicit clear succeeds.
                        if matches!(command, Command::Break(true)) {
                            break_asserted = true;
                        }
                        match port.control(command) {
                            Ok(()) => {
                                if let Command::Break(value) = command {
                                    break_asserted = *value;
                                }
                                Outcome::Controlled
                            }
                            Err(error) => Outcome::ControlFailed(error.kind()),
                        }
                    }
                }
            };
            let _ = work.reply.try_send(result);
            match result {
                Outcome::Written {
                    cancelled: true, ..
                } if stop.load(Ordering::Acquire) => break End::Cancelled,
                Outcome::Written {
                    error: Some(error), ..
                } => break End::WriteFailed(error),
                _ => {}
            }
        }
        if stop.load(Ordering::Acquire) {
            break End::Cancelled;
        }
        match port.read(&mut buffer) {
            Ok(ReadOutcome::Idle) => {}
            Ok(ReadOutcome::Data(count)) if count > 0 && count <= buffer.len() => {
                let mut state = state.lock().unwrap();
                let Some(next) = state.read_bytes.checked_add(count as u64) else {
                    break End::CounterExhausted;
                };
                let chunk = Chunk {
                    offset: state.read_bytes,
                    bytes: buffer[..count].to_vec(),
                };
                state.read_bytes = next;
                if output.try_send(chunk).is_err() {
                    state.dropped_bytes += count as u64;
                }
            }
            Ok(_) => break End::ReadFailed(io::ErrorKind::InvalidData),
            Err(error) => {
                break if stop.load(Ordering::Acquire) {
                    End::Cancelled
                } else {
                    End::ReadFailed(error.kind())
                };
            }
        }
    };
    if break_asserted && let Err(error) = port.control(&Command::Break(false)) {
        state.lock().unwrap().break_cleanup_error = Some(error.kind());
    }
    end
}

fn pump_available<P: Port>(
    port: &mut P,
    output: &mpsc::SyncSender<Chunk>,
    state: &Mutex<Status>,
) -> io::Result<()> {
    let mut buffer = [0u8; READ_BYTES];
    for _ in 0..OUTPUT_CHUNKS {
        let available = (port.bytes_to_read()? as usize).min(buffer.len());
        if available == 0 {
            break;
        }
        match port.read(&mut buffer[..available])? {
            ReadOutcome::Idle => break,
            ReadOutcome::Data(count) if count > 0 && count <= available => {
                let mut state = state.lock().unwrap();
                let next = state
                    .read_bytes
                    .checked_add(count as u64)
                    .ok_or_else(|| io::Error::other("serial receive counter exhausted"))?;
                let chunk = Chunk {
                    offset: state.read_bytes,
                    bytes: buffer[..count].to_vec(),
                };
                state.read_bytes = next;
                if output.try_send(chunk).is_err() {
                    state.dropped_bytes += count as u64;
                }
            }
            _ => return Err(io::ErrorKind::InvalidData.into()),
        }
    }
    Ok(())
}
