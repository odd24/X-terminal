//! Protocol-neutral lifecycle and bounded raw output; no device I/O occurs here.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use uuid::Uuid;

pub const EVENT_BYTES: usize = 4096;
pub const MAX_APPEND: usize = 65536;
pub const MAX_CONNECTIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct ConnectionId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionRef {
    pub connection_id: ConnectionId,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Protocol {
    Ssh1,
    Ssh2,
    Serial,
    Fixture,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    Disconnected,
    Connecting,
    Authenticating,
    Connected,
    Closing,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidArgument,
    NotFound,
    StaleGeneration,
    InvalidState,
    NotConnected,
    PermissionDenied,
    CapacityExceeded,
    RequestExpired,
    Unsupported,
    VersionMismatch,
    AuthRequired,
}
impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ErrorCode {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionInfo {
    pub connection_id: ConnectionId,
    pub generation: u64,
    pub protocol: Protocol,
    pub state: State,
}
impl ConnectionInfo {
    pub fn reference(&self) -> ConnectionRef {
        ConnectionRef {
            connection_id: self.connection_id,
            generation: self.generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OutputEvent {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub bytes: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OutputPage {
    pub connection: ConnectionRef,
    pub events: Vec<OutputEvent>,
    pub next_cursor: u64,
    pub available_from: u64,
    pub truncated: bool,
    pub disconnected: bool,
}

pub struct OutputBuffer {
    events: VecDeque<OutputEvent>,
    bytes: usize,
    next_seq: u64,
    max_bytes: usize,
    max_events: usize,
}
impl OutputBuffer {
    pub fn new(max_bytes: usize, max_events: usize) -> Result<Self, ErrorCode> {
        if !(EVENT_BYTES..=16 * 1024 * 1024).contains(&max_bytes)
            || !(1..=4096).contains(&max_events)
        {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(Self {
            events: VecDeque::new(),
            bytes: 0,
            next_seq: 1,
            max_bytes,
            max_events,
        })
    }
    pub fn append(&mut self, raw: &[u8], timestamp_ms: u64) -> Result<(), ErrorCode> {
        if raw.len() > MAX_APPEND {
            return Err(ErrorCode::InvalidArgument);
        }
        let count = raw.len().div_ceil(EVENT_BYTES);
        self.next_seq
            .checked_add(count as u64)
            .ok_or(ErrorCode::CapacityExceeded)?;
        for bytes in raw.chunks(EVENT_BYTES) {
            while self.bytes + bytes.len() > self.max_bytes || self.events.len() >= self.max_events
            {
                let old = self.events.pop_front().expect("bounded nonempty queue");
                self.bytes -= old.bytes.len();
            }
            self.events.push_back(OutputEvent {
                seq: self.next_seq,
                timestamp_ms,
                bytes: bytes.to_vec(),
                gap_bytes: None,
            });
            self.next_seq += 1;
            self.bytes += bytes.len();
        }
        Ok(())
    }
    pub fn mark_gap(&mut self, lost: u64, timestamp_ms: u64) -> Result<(), ErrorCode> {
        if lost == 0 {
            return Err(ErrorCode::InvalidArgument);
        }
        let next = self
            .next_seq
            .checked_add(1)
            .ok_or(ErrorCode::CapacityExceeded)?;
        while self.events.len() >= self.max_events {
            let old = self.events.pop_front().unwrap();
            self.bytes -= old.bytes.len();
        }
        self.events.push_back(OutputEvent {
            seq: self.next_seq,
            timestamp_ms,
            bytes: vec![],
            gap_bytes: Some(lost),
        });
        self.next_seq = next;
        Ok(())
    }
    pub fn read(
        &self,
        reference: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
        disconnected: bool,
    ) -> Result<OutputPage, ErrorCode> {
        if cursor == 0 || cursor > self.next_seq || !(EVENT_BYTES..=MAX_APPEND).contains(&max_bytes)
        {
            return Err(ErrorCode::InvalidArgument);
        }
        let available_from = self.events.front().map_or(self.next_seq, |event| event.seq);
        let start = cursor.max(available_from);
        let mut events = vec![];
        let mut bytes = 0;
        let mut next_cursor = start;
        for event in self.events.iter().filter(|event| event.seq >= start) {
            if bytes + event.bytes.len() > max_bytes {
                break;
            }
            bytes += event.bytes.len();
            next_cursor = event.seq + 1;
            events.push(event.clone());
        }
        Ok(OutputPage {
            connection: reference,
            events,
            next_cursor,
            available_from,
            truncated: cursor < available_from,
            disconnected,
        })
    }
    pub fn allocated_bytes(&self) -> usize {
        self.bytes
    }
}

struct Connection {
    info: ConnectionInfo,
    output: OutputBuffer,
    presentation: crate::presentation::Presentation,
    capture: Option<(Uuid, std::sync::Arc<dyn crate::capture::OutputCapture>)>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some((_, capture)) = self.capture.take() {
            capture.stop();
        }
    }
}

#[derive(Default)]
pub struct Sessions {
    connections: HashMap<ConnectionId, Connection>,
}
impl Sessions {
    pub fn create(&mut self, protocol: Protocol) -> Result<ConnectionInfo, ErrorCode> {
        if self.connections.len() >= MAX_CONNECTIONS {
            return Err(ErrorCode::CapacityExceeded);
        }
        let info = ConnectionInfo {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 0,
            protocol,
            state: State::Disconnected,
        };
        self.connections.insert(
            info.connection_id,
            Connection {
                info: info.clone(),
                output: Self::buffer(),
                presentation: crate::presentation::Presentation::new("utf-8", 24, 80).unwrap(),
                capture: None,
            },
        );
        Ok(info)
    }
    fn buffer() -> OutputBuffer {
        OutputBuffer::new(256 * 1024, 128).unwrap()
    }
    fn get(&self, reference: ConnectionRef) -> Result<&Connection, ErrorCode> {
        let connection = self
            .connections
            .get(&reference.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if connection.info.generation != reference.generation {
            return Err(ErrorCode::StaleGeneration);
        }
        Ok(connection)
    }
    fn get_mut(&mut self, reference: ConnectionRef) -> Result<&mut Connection, ErrorCode> {
        self.get(reference)?;
        Ok(self.connections.get_mut(&reference.connection_id).unwrap())
    }
    pub fn info(&self, reference: ConnectionRef) -> Result<ConnectionInfo, ErrorCode> {
        Ok(self.get(reference)?.info.clone())
    }
    pub fn list(&self) -> Vec<ConnectionInfo> {
        let mut result: Vec<_> = self.connections.values().map(|c| c.info.clone()).collect();
        result.sort_by_key(|info| info.connection_id.0);
        result
    }
    pub fn begin_connect(&mut self, reference: ConnectionRef) -> Result<ConnectionInfo, ErrorCode> {
        let connection = self.get_mut(reference)?;
        if !matches!(connection.info.state, State::Disconnected | State::Failed) {
            return Err(ErrorCode::InvalidState);
        }
        let generation = reference
            .generation
            .checked_add(1)
            .ok_or(ErrorCode::CapacityExceeded)?;
        if let Some((_, capture)) = connection.capture.take() {
            capture.stop();
        }
        connection.output = Self::buffer();
        connection.presentation = crate::presentation::Presentation::new("utf-8", 24, 80).unwrap();
        connection.info.generation = generation;
        connection.info.state = State::Connecting;
        Ok(connection.info.clone())
    }
    pub fn transition(
        &mut self,
        reference: ConnectionRef,
        target: State,
    ) -> Result<ConnectionInfo, ErrorCode> {
        let connection = self.get_mut(reference)?;
        let current = connection.info.state;
        let ssh = matches!(connection.info.protocol, Protocol::Ssh1 | Protocol::Ssh2);
        let allowed = match (current, target) {
            (State::Connecting, State::Authenticating) => ssh,
            (State::Connecting, State::Connected) => !ssh,
            (State::Authenticating, State::Connected) => true,
            (
                State::Connecting | State::Authenticating | State::Connected | State::Failed,
                State::Closing,
            ) => true,
            (State::Closing, State::Disconnected) => true,
            (_, State::Failed) => true,
            _ => false,
        };
        if !allowed {
            return Err(ErrorCode::InvalidState);
        }
        if matches!(target, State::Disconnected | State::Failed) {
            if let Some(text) = connection.presentation.finish()
                && let Some((_, capture)) = &connection.capture
            {
                capture.record(None, text);
            }
            if let Some((_, capture)) = connection.capture.take() {
                capture.stop();
            }
        }
        connection.info.state = target;
        Ok(connection.info.clone())
    }
    pub fn append(
        &mut self,
        reference: ConnectionRef,
        bytes: &[u8],
        timestamp_ms: u64,
    ) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if connection.info.state != State::Connected {
            return Err(ErrorCode::NotConnected);
        }
        Self::append_output(connection, bytes, timestamp_ms)
    }
    pub fn read(
        &self,
        reference: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
    ) -> Result<OutputPage, ErrorCode> {
        let connection = self.get(reference)?;
        connection.output.read(
            reference,
            cursor,
            max_bytes,
            matches!(connection.info.state, State::Disconnected | State::Failed),
        )
    }
    pub fn remove(&mut self, reference: ConnectionRef) -> Result<(), ErrorCode> {
        let connection = self.get(reference)?;
        if !matches!(connection.info.state, State::Disconnected | State::Failed) {
            return Err(ErrorCode::InvalidState);
        }
        self.connections.remove(&reference.connection_id);
        Ok(())
    }
    /// Transport-only drain path: bytes captured before close still belong to this
    /// exact generation. Public fixture/input paths retain their Connected checks.
    pub fn append_draining(
        &mut self,
        reference: ConnectionRef,
        raw: &[u8],
        timestamp_ms: u64,
    ) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if !matches!(connection.info.state, State::Connected | State::Closing) {
            return Err(ErrorCode::NotConnected);
        }
        Self::append_output(connection, raw, timestamp_ms)
    }
    pub fn mark_gap(
        &mut self,
        reference: ConnectionRef,
        lost: u64,
        timestamp_ms: u64,
    ) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if !matches!(connection.info.state, State::Connected | State::Closing) {
            return Err(ErrorCode::NotConnected);
        }
        connection.presentation.reserve(1)?;
        let seq = connection.output.next_seq;
        connection.output.mark_gap(lost, timestamp_ms)?;
        let text = connection.presentation.gap(seq, lost, timestamp_ms);
        if let Some((_, capture)) = &connection.capture {
            capture.record(
                Some(&OutputEvent {
                    seq,
                    timestamp_ms,
                    bytes: vec![],
                    gap_bytes: Some(lost),
                }),
                text,
            );
        }
        Ok(())
    }

    fn append_output(
        connection: &mut Connection,
        raw: &[u8],
        timestamp_ms: u64,
    ) -> Result<(), ErrorCode> {
        if raw.len() > MAX_APPEND {
            return Err(ErrorCode::InvalidArgument);
        }
        connection
            .presentation
            .reserve(raw.len().div_ceil(EVENT_BYTES))?;
        let first_seq = connection.output.next_seq;
        connection.output.append(raw, timestamp_ms)?;
        for (index, chunk) in raw.chunks(EVENT_BYTES).enumerate() {
            let text =
                connection
                    .presentation
                    .append(first_seq + index as u64, chunk, timestamp_ms);
            if let Some((_, capture)) = &connection.capture {
                capture.record(
                    Some(&OutputEvent {
                        seq: first_seq + index as u64,
                        timestamp_ms,
                        bytes: chunk.to_vec(),
                        gap_bytes: None,
                    }),
                    text,
                );
            }
        }
        Ok(())
    }

    /// Service-owned setup, before any transport output. Never a public write capability.
    pub fn configure_output(
        &mut self,
        reference: ConnectionRef,
        encoding: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if connection.info.state != State::Connecting || connection.output.next_seq != 1 {
            return Err(ErrorCode::InvalidState);
        }
        connection.presentation = crate::presentation::Presentation::new(encoding, rows, cols)?;
        Ok(())
    }

    pub fn resize_screen(
        &mut self,
        reference: ConnectionRef,
        rows: u16,
        cols: u16,
    ) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if connection.info.state != State::Connected {
            return Err(ErrorCode::NotConnected);
        }
        connection.presentation.resize(rows, cols)
    }

    pub fn read_text(
        &self,
        reference: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
    ) -> Result<crate::presentation::TextPage, ErrorCode> {
        self.get(reference)?
            .presentation
            .read(reference, cursor, max_bytes)
    }

    pub fn screen(
        &self,
        reference: ConnectionRef,
    ) -> Result<crate::presentation::ScreenSnapshot, ErrorCode> {
        Ok(self.get(reference)?.presentation.snapshot(reference))
    }

    pub fn output_position(
        &self,
        reference: ConnectionRef,
    ) -> Result<crate::capture::OutputPosition, ErrorCode> {
        let connection = self.get(reference)?;
        if connection.info.state != State::Connected {
            return Err(ErrorCode::NotConnected);
        }
        let (encoding, text_cursor) = connection.presentation.position();
        Ok(crate::capture::OutputPosition {
            connection: reference,
            protocol: connection.info.protocol,
            encoding: encoding.into(),
            source_cursor: connection.output.next_seq,
            text_cursor,
        })
    }
    pub fn capture_id(&self, reference: ConnectionRef) -> Result<Option<Uuid>, ErrorCode> {
        Ok(self.get(reference)?.capture.as_ref().map(|(id, _)| *id))
    }
    pub fn attach_capture(
        &mut self,
        reference: ConnectionRef,
        id: Uuid,
        capture: std::sync::Arc<dyn crate::capture::OutputCapture>,
    ) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if id.is_nil() || connection.info.state != State::Connected || connection.capture.is_some()
        {
            return Err(ErrorCode::InvalidState);
        }
        connection.capture = Some((id, capture));
        Ok(())
    }
    pub fn detach_capture(&mut self, reference: ConnectionRef, id: Uuid) -> Result<(), ErrorCode> {
        let connection = self.get_mut(reference)?;
        if let Some((active, _)) = &connection.capture
            && *active != id
        {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some((_, capture)) = connection.capture.take() {
            capture.stop();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_transport_gaps_are_ordered_bounded_and_independent_of_consumers() {
        let reference = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let mut buffer = OutputBuffer::new(EVENT_BYTES, 3).unwrap();
        buffer.append(b"before", 1).unwrap();
        buffer.mark_gap(9000, 2).unwrap();
        buffer.append(b"after", 3).unwrap();
        let first = buffer.read(reference, 1, EVENT_BYTES, false).unwrap();
        let second = buffer.read(reference, 1, EVENT_BYTES, false).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.events[1].gap_bytes, Some(9000));
        assert!(first.events[1].bytes.is_empty());
        assert_eq!(first.events[2].bytes, b"after");
        for index in 0..20 {
            buffer.mark_gap(index + 1, index).unwrap();
        }
        let page = buffer.read(reference, 1, EVENT_BYTES, true).unwrap();
        assert!(page.truncated && page.disconnected);
        assert_eq!(page.events.len(), 3);
        assert_eq!(buffer.allocated_bytes(), 0);
        assert_eq!(buffer.mark_gap(0, 0), Err(ErrorCode::InvalidArgument));
        buffer.next_seq = u64::MAX;
        assert_eq!(buffer.mark_gap(1, 0), Err(ErrorCode::CapacityExceeded));
    }
    #[test]
    fn close_drain_preserves_generation_but_does_not_make_closed_sessions_writable() {
        let mut sessions = Sessions::default();
        let initial = sessions.create(Protocol::Serial).unwrap();
        let reference = sessions
            .begin_connect(initial.reference())
            .unwrap()
            .reference();
        sessions.transition(reference, State::Connected).unwrap();
        sessions.transition(reference, State::Closing).unwrap();
        assert_eq!(
            sessions.append(reference, b"no", 0),
            Err(ErrorCode::NotConnected)
        );
        sessions.append_draining(reference, b"captured", 1).unwrap();
        sessions.mark_gap(reference, 3, 2).unwrap();
        sessions.transition(reference, State::Disconnected).unwrap();
        assert_eq!(
            sessions.append_draining(reference, b"no", 3),
            Err(ErrorCode::NotConnected)
        );
        let new = sessions.begin_connect(reference).unwrap().reference();
        assert_eq!(
            sessions.mark_gap(reference, 1, 4),
            Err(ErrorCode::StaleGeneration)
        );
        assert_eq!(sessions.mark_gap(new, 1, 4), Err(ErrorCode::NotConnected));
    }
    #[test]
    fn ssh_requires_auth_and_reconnect_expires_old_generation_and_output() {
        let mut sessions = Sessions::default();
        let initial = sessions.create(Protocol::Ssh2).unwrap().reference();
        assert_eq!(
            sessions.transition(initial, State::Connected),
            Err(ErrorCode::InvalidState)
        );
        let active = sessions.begin_connect(initial).unwrap().reference();
        assert_eq!(
            sessions.transition(active, State::Connected),
            Err(ErrorCode::InvalidState)
        );
        assert_eq!(
            sessions.append(active, b"not-authenticated", 0),
            Err(ErrorCode::NotConnected)
        );
        sessions.transition(active, State::Authenticating).unwrap();
        sessions.transition(active, State::Connected).unwrap();
        sessions.append(active, b"old output", 1).unwrap();
        assert_eq!(sessions.begin_connect(active), Err(ErrorCode::InvalidState));
        sessions.transition(active, State::Failed).unwrap();
        let next = sessions.begin_connect(active).unwrap().reference();
        assert_eq!(next.generation, 2);
        assert_eq!(
            sessions.read(active, 1, EVENT_BYTES),
            Err(ErrorCode::StaleGeneration)
        );
        assert!(
            sessions
                .read(next, 1, EVENT_BYTES)
                .unwrap()
                .events
                .is_empty()
        );
    }
    #[test]
    fn serial_skips_auth_but_cannot_be_removed_while_active() {
        let mut sessions = Sessions::default();
        let id = sessions.create(Protocol::Serial).unwrap().reference();
        let active = sessions.begin_connect(id).unwrap().reference();
        assert_eq!(
            sessions.transition(active, State::Authenticating),
            Err(ErrorCode::InvalidState)
        );
        sessions.transition(active, State::Connected).unwrap();
        assert_eq!(sessions.remove(active), Err(ErrorCode::InvalidState));
        sessions.transition(active, State::Closing).unwrap();
        sessions.transition(active, State::Disconnected).unwrap();
        sessions.remove(active).unwrap();
        assert_eq!(sessions.info(active), Err(ErrorCode::NotFound));
    }
    #[test]
    fn event_and_byte_overflow_are_visible_to_independent_consumers() {
        let reference = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let mut buffer = OutputBuffer::new(EVENT_BYTES * 2, 2).unwrap();
        buffer.append(&vec![0xff; EVENT_BYTES * 3], 123).unwrap();
        assert_eq!(buffer.allocated_bytes(), EVENT_BYTES * 2);
        let first = buffer.read(reference, 1, EVENT_BYTES, false).unwrap();
        assert!(first.truncated);
        assert_eq!(first.available_from, 2);
        assert_eq!(first.next_cursor, 3);
        assert_eq!(first.events[0].bytes, vec![0xff; EVENT_BYTES]);
        let other = buffer.read(reference, 2, EVENT_BYTES * 2, false).unwrap();
        assert!(!other.truncated);
        assert_eq!(other.events.len(), 2);
        assert_eq!(
            buffer.read(reference, 5, EVENT_BYTES, false),
            Err(ErrorCode::InvalidArgument)
        );
        let end = buffer.read(reference, 4, EVENT_BYTES, true).unwrap();
        assert!(end.events.is_empty() && end.disconnected);
        assert_eq!(
            buffer.append(&vec![0; MAX_APPEND + 1], 0),
            Err(ErrorCode::InvalidArgument)
        );
    }
    #[test]
    fn event_count_and_connection_count_are_bounded() {
        let mut buffer = OutputBuffer::new(EVENT_BYTES, 2).unwrap();
        for i in 0..100 {
            buffer.append(&[i], i as u64).unwrap();
        }
        assert_eq!(buffer.events.len(), 2);
        assert_eq!(buffer.allocated_bytes(), 2);
        buffer.next_seq = u64::MAX;
        assert_eq!(buffer.append(b"x", 0), Err(ErrorCode::CapacityExceeded));
        let mut sessions = Sessions::default();
        for _ in 0..MAX_CONNECTIONS {
            sessions.create(Protocol::Serial).unwrap();
        }
        assert_eq!(
            sessions.create(Protocol::Serial),
            Err(ErrorCode::CapacityExceeded)
        );
    }
}
