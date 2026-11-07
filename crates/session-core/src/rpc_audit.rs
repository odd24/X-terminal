//! Metadata-only RPC attempts. ReturnedOk and ReplyWritten never mean a remote
//! action completed or the peer consumed the reply. No service hook or disk I/O.
use crate::{access::Scope, session::ErrorCode};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use uuid::Uuid;

pub const MAX_EVENTS: usize = 512;
pub const MAX_ACTIVE: usize = 64;
pub const MAX_PAGE: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OriginKind {
    Unauthenticated,
    Desktop,
    Observer,
    Agent,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    /// Server-generated pipe identity, separate from the authenticated ticket.
    pub pipe_id: Uuid,
    pub client_id: Option<Uuid>,
    pub kind: OriginKind,
    /// Only an OS observation; never copied from a Hello or RPC argument.
    pub peer_pid: Option<u32>,
}
impl Origin {
    fn valid(self) -> bool {
        !self.pipe_id.is_nil()
            && self.peer_pid != Some(0)
            && match self.kind {
                OriginKind::Unauthenticated => self.client_id.is_none(),
                _ => self.client_id.is_some_and(|id| !id.is_nil()),
            }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Area {
    Transport,
    Session,
    Agent,
    Ssh2,
    Serial,
    Configuration,
    Logging,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verb {
    Hello,
    Receive,
    Ping,
    List,
    Read,
    Screen,
    Write,
    Exec,
    Connect,
    Control,
    Disconnect,
    Reconnect,
    Forget,
    Authorize,
    Revoke,
    Acquire,
    Release,
    Takeover,
    Status,
    Cancel,
    Inspect,
    Configure,
    Log,
    Export,
    Maintain,
    Audit,
    Fixture,
}
/// Coarse, exhaustive service classification, with no caller text/paths/digests.
/// Requested scope is a claim to audit, never proof of actual authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub area: Area,
    pub verb: Verb,
    pub wire_id: Option<u32>,
    pub request_id: Option<Uuid>,
    pub requested_scope: Option<Scope>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Time {
    pub unix_ms: u64,
    pub elapsed_ms: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IoStage {
    HelloRead,
    RequestRead,
    ReplyWrite,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IoReason {
    Timeout,
    InvalidFrame,
    Closed,
    Other,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Phase {
    Received {},
    /// Only the server's actual authentication result may supply this identity.
    Authenticated {
        client_id: Uuid,
        origin_kind: OriginKind,
    },
    /// A returned Ok reply, not successful execution of its target action.
    ReturnedOk {},
    ReturnedError {
        code: ErrorCode,
    },
    /// Local write_frame completed, not a client acknowledgement.
    ReplyWritten {},
    IoFailure {
        stage: IoStage,
        reason: IoReason,
    },
    Abandoned {},
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub attempt_id: Uuid,
    pub started_seq: u64,
    pub origin: Origin,
    pub request: Descriptor,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub seq: u64,
    pub time: Time,
    pub attempt: Attempt,
    pub phase: Phase,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub events: Vec<Event>,
    /// Cursor is exclusive: the last returned event sequence.
    pub next_cursor: u64,
    /// Exclusive cursor before the first retained event.
    pub available_from: u64,
    pub through_cursor: u64,
    pub gap: bool,
}
struct Active {
    attempt: Attempt,
    returned: bool,
    identity_recorded: bool,
}
/// The returned Event is also the exact item a later bounded journal sink must
/// accept. Polling a ring cannot be used as a claim of lossless persistence.
#[derive(Default)]
pub struct Ring {
    events: VecDeque<Event>,
    active: HashMap<Uuid, Active>,
    next_seq: u64,
}
impl Ring {
    pub fn through_cursor(&self) -> u64 {
        self.next_seq
    }
    pub fn active_count(&self) -> usize {
        self.active.len()
    }
    fn next(&self) -> Result<u64, ErrorCode> {
        self.next_seq
            .checked_add(1)
            .ok_or(ErrorCode::CapacityExceeded)
    }
    fn push(&mut self, event: Event) -> Event {
        self.next_seq = event.seq;
        if self.events.len() == MAX_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(event);
        event
    }
    pub fn begin(
        &mut self,
        time: Time,
        origin: Origin,
        request: Descriptor,
    ) -> Result<Event, ErrorCode> {
        if !origin.valid()
            || (origin.kind == OriginKind::Unauthenticated && request.area != Area::Transport)
            || (request.area == Area::Transport
                && request.verb == Verb::Hello
                && origin.kind != OriginKind::Unauthenticated)
        {
            return Err(ErrorCode::InvalidArgument);
        }
        if self.active.len() >= MAX_ACTIVE {
            return Err(ErrorCode::CapacityExceeded);
        }
        let seq = self.next()?;
        let id = Uuid::new_v4();
        if self.active.contains_key(&id) {
            return Err(ErrorCode::CapacityExceeded);
        }
        let attempt = Attempt {
            attempt_id: id,
            started_seq: seq,
            origin,
            request,
        };
        self.active.insert(
            id,
            Active {
                attempt,
                returned: false,
                identity_recorded: false,
            },
        );
        Ok(self.push(Event {
            seq,
            time,
            attempt,
            phase: Phase::Received {},
        }))
    }
    pub fn authenticated(
        &mut self,
        id: Uuid,
        time: Time,
        client_id: Uuid,
        kind: OriginKind,
    ) -> Result<Event, ErrorCode> {
        if client_id.is_nil() || kind == OriginKind::Unauthenticated {
            return Err(ErrorCode::InvalidArgument);
        }
        let seq = self.next()?;
        let live = self.active.get_mut(&id).ok_or(ErrorCode::NotFound)?;
        if live.returned
            || live.identity_recorded
            || live.attempt.origin.kind != OriginKind::Unauthenticated
            || live.attempt.request.area != Area::Transport
            || live.attempt.request.verb != Verb::Hello
        {
            return Err(ErrorCode::InvalidState);
        }
        live.identity_recorded = true;
        let attempt = live.attempt;
        Ok(self.push(Event {
            seq,
            time,
            attempt,
            phase: Phase::Authenticated {
                client_id,
                origin_kind: kind,
            },
        }))
    }
    pub fn returned(
        &mut self,
        id: Uuid,
        time: Time,
        result: Result<(), ErrorCode>,
    ) -> Result<Event, ErrorCode> {
        let seq = self.next()?;
        let live = self.active.get_mut(&id).ok_or(ErrorCode::NotFound)?;
        if live.returned {
            return Err(ErrorCode::InvalidState);
        }
        if result.is_ok()
            && live.attempt.request.area == Area::Transport
            && live.attempt.request.verb == Verb::Hello
            && !live.identity_recorded
        {
            return Err(ErrorCode::InvalidState);
        }
        live.returned = true;
        let attempt = live.attempt;
        let phase = match result {
            Ok(()) => Phase::ReturnedOk {},
            Err(code) => Phase::ReturnedError { code },
        };
        Ok(self.push(Event {
            seq,
            time,
            attempt,
            phase,
        }))
    }
    pub fn end(&mut self, id: Uuid, time: Time, phase: Phase) -> Result<Event, ErrorCode> {
        let seq = self.next()?;
        let live = self.active.get(&id).ok_or(ErrorCode::NotFound)?;
        let allowed = match phase {
            Phase::ReplyWritten {} => live.returned,
            Phase::IoFailure {
                stage: IoStage::ReplyWrite,
                ..
            } => live.returned,
            Phase::IoFailure { .. } => {
                !live.returned && live.attempt.request.area == Area::Transport
            }
            Phase::Abandoned {} => true,
            _ => false,
        };
        if !allowed {
            return Err(ErrorCode::InvalidState);
        }
        let attempt = self.active.remove(&id).unwrap().attempt;
        Ok(self.push(Event {
            seq,
            time,
            attempt,
            phase,
        }))
    }
    pub fn page(&self, cursor: u64, through: u64, limit: usize) -> Result<Page, ErrorCode> {
        if cursor > through || through > self.next_seq || !(1..=MAX_PAGE).contains(&limit) {
            return Err(ErrorCode::InvalidArgument);
        }
        let available_from = self.events.front().map_or(self.next_seq, |e| e.seq - 1);
        let events: Vec<_> = self
            .events
            .iter()
            .filter(|e| cursor < e.seq && e.seq <= through)
            .take(limit)
            .copied()
            .collect();
        let next_cursor = events
            .last()
            .map_or(cursor.max(available_from).min(through), |e| e.seq);
        Ok(Page {
            events,
            next_cursor,
            available_from,
            through_cursor: through,
            gap: cursor < available_from && cursor < through,
        })
    }
}

#[cfg(test)]
#[path = "rpc_audit/tests.rs"]
mod tests;
