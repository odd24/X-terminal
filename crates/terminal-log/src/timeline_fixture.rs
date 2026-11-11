//! Opt-in timing capture for owned synthetic journals.
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::VecDeque,
    io,
    sync::{Arc, Mutex},
    time::Instant,
};

const BEFORE_FAULT: usize = 3583;
const AFTER_FAULT: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Logger(u8),
    Audit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    RawWrite,
    JsonlWrite,
    LiveWrite,
    LiveFlush,
    LiveSync,
    RawSync,
    JsonlSync,
    AuditSync,
    #[cfg(test)]
    TestPause,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    TrySend,
    Accepted,
    QueueFull,
    RejectedClosed,
    RejectedInvalid,
    RejectedCounter,
    RejectedDisconnected,
    Dequeue,
    WorkerFailed,
    IoBegin(Operation),
    IoEnd(Operation),
    IoError(Operation),
}

impl Kind {
    fn fault(self) -> bool {
        matches!(
            self,
            Self::QueueFull
                | Self::RejectedInvalid
                | Self::RejectedCounter
                | Self::RejectedDisconnected
                | Self::WorkerFailed
                | Self::IoError(_)
        )
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Event {
    pub ordinal: u64,
    pub elapsed_ns: u64,
    pub source: Source,
    pub seq: u64,
    pub kind: Kind,
    pub accepted_records: Option<u64>,
    pub written_records: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub first_fault: Event,
    pub evicted_before_fault: u64,
    pub omitted_after_fault: u64,
    pub events: VecDeque<Event>,
}

struct Capture {
    epoch: Instant,
    events: VecDeque<Event>,
    first_fault: Option<Event>,
    evicted: u64,
    omitted: u64,
    remaining: usize,
    next: u64,
    taken: bool,
}

#[derive(Clone)]
pub struct Timeline(Arc<Mutex<Capture>>);

impl Default for Timeline {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Capture {
            epoch: Instant::now(),
            events: VecDeque::with_capacity(BEFORE_FAULT + 1 + AFTER_FAULT),
            first_fault: None,
            evicted: 0,
            omitted: 0,
            remaining: AFTER_FAULT,
            next: 1,
            taken: false,
        })))
    }
}

impl Timeline {
    /// Call around creation of one owned logger. Assign each logger a unique index.
    pub fn with_logger<T>(&self, index: u8, start: impl FnOnce() -> T) -> T {
        assert!(index < 8, "synthetic logger index outside T19 source bound");
        self.with_source(Source::Logger(index), start)
    }

    /// Call around creation of the owned audit worker for the same fixture.
    #[cfg(windows)]
    pub fn with_audit<T>(&self, start: impl FnOnce() -> T) -> T {
        self.with_source(Source::Audit, start)
    }

    fn with_source<T>(&self, source: Source, start: impl FnOnce() -> T) -> T {
        let _scope = install(Some(Context {
            timeline: self.clone(),
            source,
            seq: 0,
        }));
        start()
    }

    /// Take the one summary after the owned workers have joined and a fault was observed.
    pub fn take_summary(&self) -> Option<Summary> {
        let mut capture = self.0.lock().unwrap();
        let first_fault = capture.first_fault.take()?;
        capture.taken = true;
        Some(Summary {
            first_fault,
            evicted_before_fault: capture.evicted,
            omitted_after_fault: capture.omitted,
            events: std::mem::take(&mut capture.events),
        })
    }
}

#[derive(Clone)]
pub(crate) struct Context {
    timeline: Timeline,
    source: Source,
    seq: u64,
}

impl Context {
    pub(crate) fn record(
        &self,
        seq: u64,
        kind: Kind,
        accepted_records: Option<u64>,
        written_records: Option<u64>,
    ) {
        let mut capture = self.timeline.0.lock().unwrap();
        if capture.taken {
            return;
        }
        if capture.first_fault.is_some() {
            if capture.remaining == 0 {
                capture.omitted = capture.omitted.saturating_add(1);
                return;
            }
            capture.remaining -= 1;
        } else if !kind.fault() && capture.events.len() == BEFORE_FAULT {
            capture.events.pop_front();
            capture.evicted = capture.evicted.saturating_add(1);
        }
        // Timestamp under the recorder lock so merged event times never go backwards.
        // No caller holds this lock across an observed I/O operation.
        let event = Event {
            ordinal: capture.next,
            elapsed_ns: u64::try_from(capture.epoch.elapsed().as_nanos()).unwrap_or(u64::MAX),
            source: self.source,
            seq,
            kind,
            accepted_records,
            written_records,
        };
        capture.next = capture.next.saturating_add(1);
        if capture.first_fault.is_none() && kind.fault() {
            capture.first_fault = Some(event);
        }
        capture.events.push_back(event);
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

pub(crate) struct Scope(Option<Context>);
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.set(self.0.take());
    }
}

pub(crate) fn install(context: Option<Context>) -> Scope {
    Scope(CURRENT.replace(context))
}

pub(crate) fn logger_context() -> Option<Context> {
    CURRENT.with_borrow(|context| {
        context
            .as_ref()
            .filter(|context| matches!(context.source, Source::Logger(_)))
            .cloned()
    })
}

#[cfg(windows)]
pub(crate) fn audit_context() -> Option<Context> {
    CURRENT.with_borrow(|context| {
        context
            .as_ref()
            .filter(|context| context.source == Source::Audit)
            .cloned()
    })
}

pub(crate) fn set_sequence(seq: u64) {
    CURRENT.with_borrow_mut(|context| {
        if let Some(context) = context {
            context.seq = seq;
        }
    });
}

fn record_current(kind: Kind, written_records: Option<u64>) {
    CURRENT.with_borrow(|context| {
        if let Some(context) = context {
            context.record(context.seq, kind, None, written_records);
        }
    });
}

pub(crate) fn dequeued(seq: u64) {
    set_sequence(seq);
    record_current(Kind::Dequeue, None);
}

pub(crate) fn worker_failed() {
    record_current(Kind::WorkerFailed, None);
}

pub(crate) fn observe_io<T>(
    operation: Operation,
    written_records: Option<u64>,
    action: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    record_current(Kind::IoBegin(operation), written_records);
    let result = action();
    let kind = if result.is_ok() {
        Kind::IoEnd(operation)
    } else {
        Kind::IoError(operation)
    };
    record_current(kind, written_records);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p22_timeline_retains_first_fault_when_both_capture_windows_fill() {
        let timeline = Timeline::default();
        timeline.with_logger(7, || {
            let context = logger_context().unwrap();
            for seq in 1..=(BEFORE_FAULT as u64 + 10) {
                context.record(seq, Kind::TrySend, None, None);
            }
            assert!(timeline.take_summary().is_none());
            set_sequence(4000);
            let result: io::Result<()> = observe_io(Operation::RawSync, Some(3999), || {
                Err(io::Error::other("synthetic-error-sentinel"))
            });
            assert_eq!(result.unwrap_err().to_string(), "synthetic-error-sentinel");
            for seq in 4001..=(4000 + AFTER_FAULT as u64 + 9) {
                context.record(seq, Kind::QueueFull, None, None);
            }
            let summary = timeline.take_summary().unwrap();
            assert_eq!(summary.events.len(), 4096);
            assert_eq!(summary.evicted_before_fault, 11);
            assert_eq!(summary.omitted_after_fault, 9);
            assert_eq!(summary.first_fault.seq, 4000);
            assert_eq!(summary.first_fault.kind, Kind::IoError(Operation::RawSync));
            assert_eq!(
                summary.events[BEFORE_FAULT].ordinal,
                summary.first_fault.ordinal
            );
            assert_eq!(
                summary.events[BEFORE_FAULT - 1].kind,
                Kind::IoBegin(Operation::RawSync)
            );
            assert!(
                !serde_json::to_string(&summary)
                    .unwrap()
                    .contains("synthetic-error-sentinel")
            );
            assert!(timeline.take_summary().is_none());
        });
        assert!(logger_context().is_none());
    }
}
