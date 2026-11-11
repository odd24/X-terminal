//! Waits outside the native pipe. Each probe borrows it for one ordinary frame.
use super::*;
use session_core::{
    context, pairing::protection, presentation::TextPage, protected_context, session::ErrorCode,
};
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::{sync::watch, time::Instant};

const FULL: TimeWindow = TimeWindow {
    from_ms: 0,
    until_ms: 253_402_300_799_999,
};
const PAGE_BYTES: usize = 16 * 1024;
const MAX_PAGES: usize = 128;
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Args {
    connection: ConnectionRef,
    #[schemars(range(min = 1))]
    cursor: u64,
    #[schemars(length(min = 1, max = 256))]
    pattern: Sensitive,
    #[schemars(range(min = 1, max = 30000))]
    timeout_ms: u64,
}

#[derive(Debug)]
enum Fault {
    Service(ErrorCode),
    Read,
    Pipe,
    Stopped,
    Budget,
}
impl Fault {
    fn reply(self) -> CallToolResponse {
        match self {
            Self::Service(code) => {
                let value = serde_json::to_value(code).unwrap_or(Value::Null);
                fail(value.as_str().unwrap_or("INVALID_STATE"))
            }
            Self::Read => fail("WAIT_READ_ERROR"),
            Self::Pipe => fail("UNKNOWN_DELIVERY"),
            Self::Stopped => fail("CANCELLED"),
            Self::Budget => fail("CAPACITY_EXCEEDED"),
        }
    }
}

fn result(state: &str, next_cursor: u64, evidence: Value) -> CallToolResponse {
    CallToolResult::structured(json!({
        "mock": false,
        "reply": {"result": "wait", "data": {
            "state": state, "next_cursor": next_cursor, "evidence": evidence
        }}
    }))
    .into()
}

impl Bridge {
    pub(super) async fn wait_for_text(
        &self,
        value: Value,
        context: RequestContext<RoleServer>,
    ) -> CallToolResponse {
        let Ok(args) = serde_json::from_value::<Args>(value) else {
            return fail("INVALID_ARGUMENT");
        };
        if args.connection.connection_id.0.is_nil()
            || args.connection.generation == 0
            || args.cursor == 0
            || !(1..=256).contains(&args.pattern.expose().len())
            || !(1..=30000).contains(&args.timeout_ms)
        {
            return fail("INVALID_ARGUMENT");
        }
        let Ok(permit) = self.wait_slot.clone().try_acquire_owned() else {
            return fail("INPUT_BUSY");
        };
        let deadline = Instant::now() + Duration::from_millis(args.timeout_ms);
        let (_stop, stopped) = watch::channel(false);
        // Keep the slot until a sent frame is drained. Cancellation drops the
        // sender immediately, without abandoning that frame or starting another.
        let checked = Arc::new(AtomicU64::new(0));
        let pipe = self.pipe.clone();
        let progress = checked.clone();
        let worker = tokio::spawn(async move {
            let _permit = permit;
            run(&pipe, args, stopped, &progress).await
        });
        tokio::select! {
            biased;
            _ = context.ct.cancelled() => fail("CANCELLED"),
            _ = tokio::time::sleep_until(deadline) => match checked.load(Ordering::Acquire) {
                0 => fail("WAIT_READ_DEADLINE"),
                cursor => result("TIMEOUT", cursor, Value::Null),
            },
            finished = worker => match finished {
                Ok(Ok(reply)) => reply,
                Ok(Err(error)) => error.reply(),
                Err(_) => fail("WAIT_READ_ERROR"),
            }
        }
    }
}

#[derive(PartialEq, Eq)]
struct Snapshot {
    through: u64,
    available: u64,
    complete: bool,
    encoding: String,
    policy: Option<protection::Info>,
}
impl Snapshot {
    fn plain(meta: context::Metadata, connection: ConnectionRef) -> Result<Self, Fault> {
        if meta.connection != connection || meta.window != FULL {
            return Err(Fault::Read);
        }
        Ok(Self {
            through: meta.through_cursor,
            available: meta.source_available_from,
            complete: meta.source_completed,
            encoding: meta.encoding,
            policy: None,
        })
    }
    fn protected(
        meta: protected_context::Metadata,
        connection: ConnectionRef,
    ) -> Result<Self, Fault> {
        if meta.connection != connection || meta.window.is_some() {
            return Err(Fault::Read);
        }
        Ok(Self {
            through: meta.through_cursor,
            available: meta.source_available_from,
            complete: meta.source_completed,
            encoding: meta.encoding,
            policy: Some(meta.protection),
        })
    }
}

async fn read(
    pipe: &Pipe,
    stopped: &mut watch::Receiver<bool>,
    connection: ConnectionRef,
    view: View,
) -> Result<(Snapshot, Option<TextPage>), Fault> {
    let mut slot = tokio::select! {
        biased;
        _ = stopped.changed() => return Err(Fault::Stopped),
        slot = pipe.lock() => slot,
    };
    if stopped.has_changed().is_err() {
        return Err(Fault::Stopped);
    }
    let reply = Bridge::request_on_pipe(
        &mut slot,
        RequestMessage::Call {
            request: Operation::WaitRead { connection, view },
        },
    )
    .await
    .map_err(|_| Fault::Pipe)?;
    drop(slot);
    if stopped.has_changed().is_err() {
        return Err(Fault::Stopped);
    }
    match reply {
        ResultMessage::Context(reply) => match *reply {
            context::Reply::Info { context } => Ok((Snapshot::plain(*context, connection)?, None)),
            context::Reply::Text { context, page } => {
                Ok((Snapshot::plain(*context, connection)?, Some(page)))
            }
            _ => Err(Fault::Read),
        },
        ResultMessage::ProtectedContext(reply) => match *reply {
            protected_context::Reply::Info { context } => {
                Ok((Snapshot::protected(*context, connection)?, None))
            }
            protected_context::Reply::Text { context, page } => {
                Ok((Snapshot::protected(*context, connection)?, Some(page)))
            }
            _ => Err(Fault::Read),
        },
        ResultMessage::Error(code) => Err(Fault::Service(code)),
        _ => Err(Fault::Read),
    }
}

async fn run(
    pipe: &Pipe,
    args: Args,
    mut stopped: watch::Receiver<bool>,
    checked: &AtomicU64,
) -> Result<CallToolResponse, Fault> {
    let mut previous = None;
    let mut budget = Budget {
        pages: MAX_PAGES,
        bytes: MAX_BYTES,
    };
    loop {
        checked.store(0, Ordering::Release);
        let (snapshot, page) = read(pipe, &mut stopped, args.connection, View::Info {}).await?;
        if page.is_some() || snapshot.available == 0 || snapshot.available > snapshot.through {
            return Err(Fault::Read);
        }
        if args.cursor > snapshot.through {
            return Err(Fault::Service(ErrorCode::InvalidArgument));
        }
        if args.cursor < snapshot.available {
            return Ok(gap(snapshot.available, "OVERWRITTEN"));
        }
        if previous.as_ref() != Some(&snapshot)
            && let Some(reply) = scan(pipe, &mut stopped, &args, &snapshot, &mut budget).await?
        {
            return Ok(reply);
        }
        if snapshot.complete {
            return Ok(result("DISCONNECTED", snapshot.through, Value::Null));
        }
        checked.store(snapshot.through, Ordering::Release);
        previous = Some(snapshot);
        tokio::select! {
            _ = stopped.changed() => return Err(Fault::Stopped),
            _ = tokio::time::sleep(Duration::from_millis(250)) => (),
        }
    }
}

struct Budget {
    pages: usize,
    bytes: usize,
}

fn gap(next_cursor: u64, reason: &str) -> CallToolResponse {
    result("GAP", next_cursor, json!({"reason": reason}))
}

async fn scan(
    pipe: &Pipe,
    stopped: &mut watch::Receiver<bool>,
    args: &Args,
    snapshot: &Snapshot,
    budget: &mut Budget,
) -> Result<Option<CallToolResponse>, Fault> {
    let mut cursor = args.cursor;
    let mut matcher = Literal::new(args.pattern.expose().as_bytes());
    while cursor < snapshot.through {
        budget.pages = budget.pages.checked_sub(1).ok_or(Fault::Budget)?;
        let (meta, page) = read(
            pipe,
            stopped,
            args.connection,
            View::Text {
                through_cursor: snapshot.through,
                cursor,
                max_bytes: PAGE_BYTES,
            },
        )
        .await?;
        let page = page.ok_or(Fault::Read)?;
        if page.truncated || meta.available > args.cursor {
            return Ok(Some(gap(meta.available, "OVERWRITTEN")));
        }
        if meta != *snapshot
            || page.connection != args.connection
            || page.encoding != snapshot.encoding
            || page.source_cursor != snapshot.through
            || page.available_from != snapshot.available
            || page.next_cursor <= cursor
            || page.next_cursor > snapshot.through
        {
            return Err(Fault::Read);
        }
        if let Some(reply) = scan_page(
            page,
            &mut cursor,
            &mut matcher,
            budget,
            args.pattern.expose(),
        )? {
            return Ok(Some(reply));
        }
    }
    Ok(None)
}

fn scan_page(
    page: TextPage,
    cursor: &mut u64,
    matcher: &mut Literal<'_>,
    budget: &mut Budget,
    pattern: &str,
) -> Result<Option<CallToolResponse>, Fault> {
    for event in page.events {
        if event.seq != *cursor {
            return Ok(Some(gap(*cursor, "SOURCE_SEQUENCE")));
        }
        *cursor += 1;
        if event.gap_bytes.is_some() {
            return Ok(Some(gap(*cursor, "SOURCE_GAP")));
        }
        if event.decode_error {
            return Ok(Some(gap(*cursor, "DECODE_ERROR")));
        }
        budget.bytes = budget
            .bytes
            .checked_sub(event.text.len())
            .ok_or(Fault::Budget)?;
        if let Some(first_cursor) = matcher.feed(event.text.as_bytes(), event.seq) {
            return Ok(Some(result(
                "MATCHED",
                *cursor,
                json!({
                    "first_cursor": first_cursor,
                    "last_cursor": event.seq,
                    "text": pattern,
                }),
            )));
        }
    }
    if *cursor != page.next_cursor {
        return Ok(Some(gap(*cursor, "SOURCE_SEQUENCE")));
    }
    Ok(None)
}

/// KMP state and only enough source cursors to locate one match.
struct Literal<'a> {
    pattern: &'a [u8],
    fallback: Vec<usize>,
    matched: usize,
    recent: VecDeque<u64>,
}
impl<'a> Literal<'a> {
    fn new(pattern: &'a [u8]) -> Self {
        let mut fallback = vec![0; pattern.len()];
        let mut prefix = 0;
        for index in 1..pattern.len() {
            while prefix > 0 && pattern[prefix] != pattern[index] {
                prefix = fallback[prefix - 1];
            }
            if pattern[prefix] == pattern[index] {
                prefix += 1;
            }
            fallback[index] = prefix;
        }
        Self {
            pattern,
            fallback,
            matched: 0,
            recent: VecDeque::with_capacity(pattern.len()),
        }
    }
    fn feed(&mut self, bytes: &[u8], source: u64) -> Option<u64> {
        for &byte in bytes {
            if self.recent.len() == self.pattern.len() {
                self.recent.pop_front();
            }
            self.recent.push_back(source);
            while self.matched > 0 && self.pattern[self.matched] != byte {
                self.matched = self.fallback[self.matched - 1];
            }
            if self.pattern[self.matched] == byte {
                self.matched += 1;
                if self.matched == self.pattern.len() {
                    return self.recent.front().copied();
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::{presentation::TextEvent, session::ConnectionId};

    #[test]
    fn literal_crosses_source_events_and_keeps_the_exact_start() {
        let mut matcher = Literal::new("aab终".as_bytes());
        assert_eq!(matcher.feed(b"aaaa", 13), None);
        assert_eq!(matcher.feed(b"b", 14), None);
        assert_eq!(matcher.feed("终suffix".as_bytes(), 15), Some(13));
    }

    #[test]
    fn wait_page_scan_returns_source_gap_before_joining_a_literal() {
        let pattern = "join-me";
        let page = |events, next_cursor| TextPage {
            connection: ConnectionRef {
                connection_id: ConnectionId(Uuid::from_u128(1)),
                generation: 1,
            },
            encoding: "utf-8".into(),
            events,
            next_cursor,
            available_from: 13,
            truncated: false,
            completed: true,
            source_cursor: 16,
        };
        let event = |seq, text: &str, gap_bytes| TextEvent {
            seq,
            source_seq: Some(seq),
            timestamp_ms: seq,
            text: text.into(),
            decode_error: false,
            gap_bytes,
        };
        for missing in [Some(17), None] {
            let mut cursor = 13;
            let mut matcher = Literal::new(pattern.as_bytes());
            let mut budget = Budget {
                pages: 2,
                bytes: 32,
            };
            assert!(
                scan_page(
                    page(vec![event(13, "join-", None)], 14),
                    &mut cursor,
                    &mut matcher,
                    &mut budget,
                    pattern
                )
                .unwrap()
                .is_none()
            );
            let reply = scan_page(
                page(vec![event(14, "", missing), event(15, "me", None)], 16),
                &mut cursor,
                &mut matcher,
                &mut budget,
                pattern,
            )
            .unwrap()
            .expect("the scan must finish at a gap or a match");
            let CallToolResponse::Complete(reply) = reply else {
                panic!("expected a completed wait result");
            };
            let response = reply.structured_content.unwrap();
            assert_eq!(response["reply"]["result"], "wait");
            let data = &response["reply"]["data"];
            if missing.is_some() {
                assert_eq!(cursor, 15);
                assert_eq!(
                    data,
                    &json!({"state":"GAP","next_cursor":15,"evidence":{"reason":"SOURCE_GAP"}})
                );
            } else {
                assert_eq!(cursor, 16);
                assert_eq!(
                    data,
                    &json!({"state":"MATCHED","next_cursor":16,
                    "evidence":{"first_cursor":13,"last_cursor":15,"text":pattern}})
                );
            }
        }
    }
}
