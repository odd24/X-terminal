//! Independent bounded stdout/stderr task stream; overwrites are explicit to each reader.
use crate::session::ErrorCode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub seq: u64,
    pub stderr: bool,
    pub bytes: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub events: Vec<Event>,
    pub next_cursor: u64,
    pub available_from: u64,
    pub truncated: bool,
    pub completed: bool,
}
pub struct Buffer {
    events: VecDeque<Event>,
    bytes: usize,
    next: u64,
}
impl Default for Buffer {
    fn default() -> Self {
        Self {
            events: VecDeque::new(),
            bytes: 0,
            next: 1,
        }
    }
}
impl Buffer {
    pub fn protected_read(
        &self,
        completed: bool,
        encoding: &str,
        view: crate::protected_task::View,
        policy: &crate::pairing::protection::ProtectedPolicy,
    ) -> Result<crate::protected_task::Reply, ErrorCode> {
        crate::protected_task::read(&self.events, self.next, completed, encoding, view, policy)
    }
    pub fn append(&mut self, stderr: bool, bytes: &[u8]) {
        for chunk in bytes.chunks(4096) {
            while self.bytes + chunk.len() > 65536 || self.events.len() >= 128 {
                let old = self.events.pop_front().unwrap();
                self.bytes -= old.bytes.len();
            }
            self.events.push_back(Event {
                seq: self.next,
                stderr,
                bytes: chunk.to_vec(),
            });
            self.next += 1;
            self.bytes += chunk.len();
        }
    }
    pub fn read(&self, cursor: u64, max_bytes: usize, completed: bool) -> Result<Page, ErrorCode> {
        if cursor == 0 || cursor > self.next || !(4096..=65536).contains(&max_bytes) {
            return Err(ErrorCode::InvalidArgument);
        }
        let available_from = self
            .events
            .front()
            .map(|event| event.seq)
            .unwrap_or(self.next);
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut next_cursor = cursor.max(available_from);
        for event in self.events.iter().filter(|event| event.seq >= cursor) {
            if bytes + event.bytes.len() > max_bytes {
                break;
            }
            bytes += event.bytes.len();
            events.push(event.clone());
            next_cursor = event.seq + 1;
        }
        Ok(Page {
            events,
            next_cursor,
            available_from,
            truncated: cursor < available_from,
            completed,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_readers_keep_stream_tags_and_see_overwritten_output_gaps() {
        let mut buffer = Buffer::default();
        buffer.append(false, b"stdout");
        buffer.append(true, b"stderr");
        let first = buffer.read(1, 4096, false).unwrap();
        assert_eq!(first.events.len(), 2);
        assert!(!first.events[0].stderr);
        assert!(first.events[1].stderr);
        assert_eq!(first.events, buffer.read(1, 4096, false).unwrap().events);
        buffer.append(false, &vec![b'x'; 70000]);
        let old = buffer.read(1, 65536, true).unwrap();
        assert!(old.truncated);
        assert!(old.available_from > 1);
        assert!(old.completed);
        assert!(
            old.events
                .iter()
                .map(|event| event.bytes.len())
                .sum::<usize>()
                <= 65536
        );
        assert!(
            buffer
                .read(old.next_cursor, 4096, true)
                .unwrap()
                .events
                .is_empty()
        );
        assert!(buffer.read(0, 4096, false).is_err());
        assert!(buffer.read(old.next_cursor + 1, 4096, false).is_err());
        for _ in 0..1000 {
            buffer.append(true, b"x");
        }
        assert!(buffer.read(old.next_cursor, 4096, false).unwrap().truncated);
    }
}
