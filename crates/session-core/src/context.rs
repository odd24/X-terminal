//! Time-scoped views reconstructed solely from retained authorized raw events.
use crate::{
    presentation::{MIN_TEXT_PAGE, Presentation, ScreenSnapshot, TextEvent, TextPage},
    session::*,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TimeWindow {
    pub from_ms: u64,
    /// Exclusive Unix millisecond bound; separate from monotonic grant expiry.
    pub until_ms: u64,
}
impl TimeWindow {
    pub fn valid(self) -> bool {
        self.from_ms < self.until_ms && self.until_ms <= 253_402_300_799_999
    }
    pub fn contains(self, other: Self) -> bool {
        self.valid()
            && other.valid()
            && self.from_ms <= other.from_ms
            && self.until_ms >= other.until_ms
    }
    fn includes(self, timestamp: u64) -> bool {
        self.from_ms <= timestamp && timestamp < self.until_ms
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum View {
    Info,
    Raw {
        through_cursor: u64,
        cursor: u64,
        max_bytes: usize,
    },
    Text {
        through_cursor: u64,
        cursor: u64,
        max_bytes: usize,
    },
    Screen {
        through_cursor: u64,
    },
}
impl View {
    pub fn valid(self) -> bool {
        match self {
            Self::Info => true,
            Self::Screen { through_cursor } => through_cursor > 0,
            Self::Raw {
                through_cursor,
                cursor,
                max_bytes,
            } => {
                cursor > 0
                    && cursor <= through_cursor
                    && (EVENT_BYTES..=MAX_APPEND).contains(&max_bytes)
            }
            Self::Text {
                through_cursor,
                cursor,
                max_bytes,
            } => {
                cursor > 0
                    && cursor <= through_cursor
                    && (MIN_TEXT_PAGE..=MAX_APPEND).contains(&max_bytes)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Mode {
    TimeWindowReplay,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub connection: ConnectionRef,
    pub mode: Mode,
    pub window: TimeWindow,
    pub through_cursor: u64,
    pub source_available_from: u64,
    /// Conservative: earlier source has been evicted, even if its timestamps are unknown.
    pub source_truncated: bool,
    pub source_completed: bool,
    pub context_resets: usize,
    pub encoding: String,
    /// Current dimensions, not historical resize replay or the full live screen.
    pub rows: u16,
    pub cols: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Info {
        context: Box<Metadata>,
    },
    Raw {
        context: Box<Metadata>,
        page: OutputPage,
    },
    Text {
        context: Box<Metadata>,
        page: TextPage,
    },
    Screen {
        context: Box<Metadata>,
        screen: ScreenSnapshot,
    },
}
pub(crate) struct Source<'a> {
    pub events: &'a VecDeque<OutputEvent>,
    pub next_cursor: u64,
    pub encoding: &'a str,
    pub rows: u16,
    pub cols: u16,
    pub completed: bool,
}

fn finish_segment(replay: &mut Presentation, events: &mut [TextEvent]) {
    if let Some(tail) = replay.finish()
        && let Some(last) = events.last_mut()
    {
        last.text.push_str(&tail.text);
        last.decode_error |= tail.decode_error;
    }
}

pub(crate) fn read(
    connection: ConnectionRef,
    window: TimeWindow,
    view: View,
    source: Source<'_>,
) -> Result<Reply, ErrorCode> {
    if !window.valid() || !view.valid() {
        return Err(ErrorCode::InvalidArgument);
    }
    let through = match view {
        View::Info => source.next_cursor,
        View::Raw { through_cursor, .. }
        | View::Text { through_cursor, .. }
        | View::Screen { through_cursor } => through_cursor,
    };
    if through > source.next_cursor {
        return Err(ErrorCode::InvalidArgument);
    }
    let oldest = source
        .events
        .front()
        .map_or(source.next_cursor, |event| event.seq);
    let mut meta = Metadata {
        connection,
        mode: Mode::TimeWindowReplay,
        window,
        through_cursor: through,
        source_available_from: oldest.min(through),
        source_truncated: oldest > 1,
        source_completed: source.completed,
        context_resets: 0,
        encoding: source.encoding.into(),
        rows: source.rows,
        cols: source.cols,
    };
    if matches!(view, View::Info) {
        return Ok(Reply::Info {
            context: Box::new(meta),
        });
    }
    if let View::Raw {
        cursor, max_bytes, ..
    } = view
    {
        let start = cursor.max(oldest).min(through);
        let mut events = Vec::new();
        let mut bytes = 0;
        for event in source
            .events
            .iter()
            .filter(|event| event.seq >= start && event.seq < through)
        {
            if window.includes(event.timestamp_ms) {
                if bytes + event.bytes.len() > max_bytes {
                    return Ok(Reply::Raw {
                        page: OutputPage {
                            connection,
                            events,
                            next_cursor: event.seq,
                            available_from: meta.source_available_from,
                            truncated: cursor < oldest,
                            disconnected: source.completed,
                        },
                        context: Box::new(meta),
                    });
                }
                bytes += event.bytes.len();
                events.push(event.clone());
            }
        }
        return Ok(Reply::Raw {
            page: OutputPage {
                connection,
                events,
                next_cursor: through,
                available_from: meta.source_available_from,
                truncated: cursor < oldest,
                disconnected: source.completed,
            },
            context: Box::new(meta),
        });
    }
    let mut replay = Presentation::new(source.encoding, source.rows, source.cols)?;
    let mut text = Vec::new();
    let mut active = false;
    for event in source.events.iter().filter(|event| event.seq < through) {
        if !window.includes(event.timestamp_ms) {
            if active {
                finish_segment(&mut replay, &mut text);
                active = false;
            }
            continue;
        }
        if !active && !text.is_empty() {
            replay = Presentation::new(source.encoding, source.rows, source.cols)?;
            meta.context_resets += 1;
        }
        active = true;
        let mut derived = if let Some(lost) = event.gap_bytes {
            meta.context_resets += 1;
            replay.gap(event.seq, lost, event.timestamp_ms).clone()
        } else {
            replay
                .append(event.seq, &event.bytes, event.timestamp_ms)
                .clone()
        };
        // All Context cursors refer to the retained raw sequence, including text.
        derived.seq = event.seq;
        text.push(derived);
    }
    finish_segment(&mut replay, &mut text);
    if let View::Text {
        cursor, max_bytes, ..
    } = view
    {
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut next = through;
        let start = cursor.max(oldest).min(through);
        for event in text.into_iter().filter(|event| event.seq >= start) {
            if bytes + event.text.len() > max_bytes {
                next = event.seq;
                break;
            }
            bytes += event.text.len();
            events.push(event);
        }
        return Ok(Reply::Text {
            page: TextPage {
                connection,
                encoding: source.encoding.into(),
                events,
                next_cursor: next,
                available_from: meta.source_available_from,
                truncated: cursor < oldest,
                completed: true,
                source_cursor: through,
            },
            context: Box::new(meta),
        });
    }
    let mut screen = replay.snapshot(connection);
    screen.source_cursor = through;
    Ok(Reply::Screen {
        context: Box::new(meta),
        screen,
    })
}

#[cfg(test)]
mod tests;
