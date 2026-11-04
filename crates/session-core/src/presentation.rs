//! Bounded, service-owned derived views. Raw output remains a separate stream.
use crate::{
    screen::{Screen, StreamDecoder},
    session::*,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const MIN_TEXT_PAGE: usize = 16 * 1024;
const TEXT_BYTES: usize = 256 * 1024;
const TEXT_EVENTS: usize = 128;
const SCREEN_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TextEvent {
    pub seq: u64,
    /// None only for the final decoder flush, which consumes no raw event.
    pub source_seq: Option<u64>,
    pub timestamp_ms: u64,
    pub text: String,
    pub decode_error: bool,
    pub gap_bytes: Option<u64>,
}

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TextPage {
    pub connection: ConnectionRef,
    pub encoding: String,
    pub events: Vec<TextEvent>,
    pub next_cursor: u64,
    pub available_from: u64,
    pub truncated: bool,
    /// Producer finalized, even if this page does not yet contain the tail.
    pub completed: bool,
    pub source_cursor: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScreenSnapshot {
    pub connection: ConnectionRef,
    pub encoding: String,
    pub parser: String,
    pub resize_reflow: bool,
    pub rows: u16,
    pub cols: u16,
    pub contents: String,
    pub contents_truncated: bool,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub alternate: bool,
    pub source_cursor: u64,
    pub completed: bool,
    pub gap_bytes: u64,
    pub decode_error_events: u64,
}

pub(crate) struct Presentation {
    encoding: String,
    decoder: StreamDecoder,
    screen: Screen,
    rows: u16,
    cols: u16,
    events: VecDeque<TextEvent>,
    bytes: usize,
    next_seq: u64,
    source_cursor: u64,
    last_timestamp: u64,
    completed: bool,
    gap_bytes: u64,
    decode_error_events: u64,
}

impl Presentation {
    pub(crate) fn new(encoding: &str, rows: u16, cols: u16) -> Result<Self, ErrorCode> {
        Ok(Self {
            encoding: encoding.into(),
            decoder: StreamDecoder::new(encoding).map_err(|_| ErrorCode::InvalidArgument)?,
            screen: Screen::new(rows, cols).map_err(|_| ErrorCode::InvalidArgument)?,
            rows,
            cols,
            events: VecDeque::new(),
            bytes: 0,
            next_seq: 1,
            source_cursor: 1,
            last_timestamp: 0,
            completed: false,
            gap_bytes: 0,
            decode_error_events: 0,
        })
    }

    pub(crate) fn reserve(&self, count: usize) -> Result<(), ErrorCode> {
        if self.completed {
            return Err(ErrorCode::InvalidState);
        }
        // Reserve one extra slot for EOF so terminal transitions cannot overflow.
        self.next_seq
            .checked_add(count as u64)
            .and_then(|next| next.checked_add(1))
            .ok_or(ErrorCode::CapacityExceeded)?;
        Ok(())
    }

    fn publish(
        &mut self,
        source_seq: Option<u64>,
        timestamp_ms: u64,
        text: String,
        decode_error: bool,
        gap_bytes: Option<u64>,
    ) {
        while self.events.len() >= TEXT_EVENTS || self.bytes + text.len() > TEXT_BYTES {
            self.bytes -= self
                .events
                .pop_front()
                .expect("bounded text queue")
                .text
                .len();
        }
        self.bytes += text.len();
        self.events.push_back(TextEvent {
            seq: self.next_seq,
            source_seq,
            timestamp_ms,
            text,
            decode_error,
            gap_bytes,
        });
        self.next_seq += 1;
        self.decode_error_events = self
            .decode_error_events
            .saturating_add(u64::from(decode_error));
    }

    pub(crate) fn append(&mut self, source_seq: u64, raw: &[u8], timestamp_ms: u64) {
        // Caller splits at the raw stream's 4096-byte boundary; expansion fits 16KiB.
        let (text, error) = self
            .decoder
            .decode(raw, false)
            .expect("bounded valid decoder state");
        self.screen
            .push(text.as_bytes())
            .expect("bounded decoded screen chunk");
        self.publish(Some(source_seq), timestamp_ms, text, error, None);
        self.source_cursor = source_seq + 1;
        self.last_timestamp = timestamp_ms;
    }

    pub(crate) fn gap(&mut self, source_seq: u64, lost: u64, timestamp_ms: u64) {
        // Discard buffered lead bytes and parser state, rather than joining across loss.
        self.decoder = StreamDecoder::new(&self.encoding).unwrap();
        self.screen = Screen::new(self.rows, self.cols).unwrap();
        self.gap_bytes = self.gap_bytes.saturating_add(lost);
        self.publish(
            Some(source_seq),
            timestamp_ms,
            String::new(),
            false,
            Some(lost),
        );
        self.source_cursor = source_seq + 1;
        self.last_timestamp = timestamp_ms;
    }

    pub(crate) fn finish(&mut self) {
        if self.completed {
            return;
        }
        let (text, error) = self
            .decoder
            .decode(&[], true)
            .expect("unfinished bounded decoder");
        self.screen.push(text.as_bytes()).unwrap();
        self.publish(None, self.last_timestamp, text, error, None);
        self.completed = true;
    }

    pub(crate) fn resize(&mut self, rows: u16, cols: u16) -> Result<(), ErrorCode> {
        self.screen
            .resize(rows, cols)
            .map_err(|_| ErrorCode::InvalidArgument)?;
        self.rows = rows;
        self.cols = cols;
        Ok(())
    }

    pub(crate) fn read(
        &self,
        connection: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
    ) -> Result<TextPage, ErrorCode> {
        if cursor == 0
            || cursor > self.next_seq
            || !(MIN_TEXT_PAGE..=MAX_APPEND).contains(&max_bytes)
        {
            return Err(ErrorCode::InvalidArgument);
        }
        let available_from = self.events.front().map_or(self.next_seq, |event| event.seq);
        let start = cursor.max(available_from);
        let mut bytes = 0;
        let mut events = Vec::new();
        let mut next_cursor = start;
        for event in self.events.iter().filter(|event| event.seq >= start) {
            if bytes + event.text.len() > max_bytes {
                break;
            }
            bytes += event.text.len();
            next_cursor = event.seq + 1;
            events.push(event.clone());
        }
        Ok(TextPage {
            connection,
            encoding: self.encoding.clone(),
            events,
            next_cursor,
            available_from,
            truncated: cursor < available_from,
            completed: self.completed,
            source_cursor: self.source_cursor,
        })
    }

    pub(crate) fn snapshot(&self, connection: ConnectionRef) -> ScreenSnapshot {
        let mut contents = self.screen.contents();
        let contents_truncated = contents.len() > SCREEN_BYTES;
        if contents_truncated {
            let mut end = SCREEN_BYTES;
            while !contents.is_char_boundary(end) {
                end -= 1;
            }
            contents.truncate(end);
        }
        let (cursor_row, cursor_col) = self.screen.cursor();
        ScreenSnapshot {
            connection,
            encoding: self.encoding.clone(),
            parser: "vt100-0.18.1+local.1".into(),
            resize_reflow: false,
            rows: self.rows,
            cols: self.cols,
            contents,
            contents_truncated,
            cursor_row,
            cursor_col,
            alternate: self.screen.alternate(),
            source_cursor: self.source_cursor,
            completed: self.completed,
            gap_bytes: self.gap_bytes,
            decode_error_events: self.decode_error_events,
        }
    }
}
