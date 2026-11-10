//! Ticket-bound, fixed-watermark projections. No raw representation is offered.
use crate::{
    context::{Source, TimeWindow},
    pairing::protection::{Info, ProtectedPolicy},
    presentation::{MIN_TEXT_PAGE, Presentation, ScreenSnapshot, TextEvent, TextPage},
    redaction::Boundaries,
    session::*,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum View {
    Info {},
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
            Self::Info {} => true,
            Self::Screen { through_cursor } => through_cursor > 0,
            Self::Text {
                through_cursor,
                cursor,
                max_bytes,
            } => {
                through_cursor > 0
                    && cursor > 0
                    && cursor <= through_cursor
                    && (MIN_TEXT_PAGE..=MAX_APPEND).contains(&max_bytes)
            }
        }
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub boundary_guard: bool,
    pub opaque_controls: bool,
    pub screen_withheld: bool,
    pub screen_rows_hidden: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub connection: ConnectionRef,
    pub window: Option<TimeWindow>,
    pub through_cursor: u64,
    pub source_available_from: u64,
    pub source_truncated: bool,
    pub source_completed: bool,
    pub context_resets: usize,
    pub encoding: String,
    pub rows: u16,
    pub cols: u16,
    pub protection: Info,
    pub report: Report,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Info {
        context: Box<Metadata>,
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
fn finish(replay: &mut Presentation, text: &mut [TextEvent]) {
    if let Some(tail) = replay.finish()
        && let Some(last) = text.last_mut()
    {
        last.text.push_str(&tail.text);
        last.decode_error |= tail.decode_error;
    }
}
fn protect(
    policy: &ProtectedPolicy,
    text: &mut [TextEvent],
    boundaries: Boundaries,
    report: &mut Report,
) -> Result<bool, ErrorCode> {
    let parts: Vec<_> = text.iter().map(|event| event.text.as_str()).collect();
    let projection = policy.rules.project(&parts, boundaries)?;
    let obscured = projection.opaque_controls
        || (policy.rules.summary().0 && (boundaries.prefix_cut || projection.field_matches > 0));
    report.boundary_guard |= projection.boundary_guard;
    report.opaque_controls |= projection.opaque_controls;
    for (event, redacted) in text.iter_mut().zip(projection.fragments) {
        event.text = redacted;
    }
    Ok(obscured)
}

impl EndedOutputSnapshot {
    pub fn protected_utf8(self, policy: &ProtectedPolicy) -> Result<String, ErrorCode> {
        let source = self.source;
        let mut replay = Presentation::new(&source.encoding, source.rows, source.cols)?;
        let mut text: Vec<_> = self
            .events
            .iter()
            .map(|event| {
                replay
                    .append(event.seq, &event.bytes, event.timestamp_ms)
                    .clone()
            })
            .collect();
        finish(&mut replay, &mut text);
        if text.iter().any(|event| event.decode_error) {
            return Err(ErrorCode::InvalidState);
        }
        protect(
            policy,
            &mut text,
            Boundaries {
                prefix_cut: source.from_cursor != 1,
                suffix_cut: false,
            },
            &mut Report::default(),
        )?;
        let protected: String = text.into_iter().map(|event| event.text).collect();
        if protected.is_empty() {
            return Err(ErrorCode::InvalidState);
        }
        Ok(protected)
    }
}
pub(crate) fn read(
    connection: ConnectionRef,
    window: Option<TimeWindow>,
    view: View,
    source: Source<'_>,
    policy: &ProtectedPolicy,
) -> Result<Reply, ErrorCode> {
    if window.is_some_and(|w| !w.valid()) || !view.valid() {
        return Err(ErrorCode::InvalidArgument);
    }
    let through = match view {
        View::Info {} => source.next_cursor,
        View::Text { through_cursor, .. } | View::Screen { through_cursor } => through_cursor,
    };
    if through > source.next_cursor {
        return Err(ErrorCode::InvalidArgument);
    }
    let oldest = source.events.front().map_or(source.next_cursor, |e| e.seq);
    let mut meta = Metadata {
        connection,
        window,
        through_cursor: through,
        source_available_from: oldest.min(through),
        source_truncated: oldest > 1,
        source_completed: source.completed,
        context_resets: 0,
        encoding: source.encoding.into(),
        rows: source.rows,
        cols: source.cols,
        protection: policy.info,
        report: Report::default(),
    };
    if matches!(view, View::Info {}) {
        return Ok(Reply::Info {
            context: Box::new(meta),
        });
    }
    let mut replay = Presentation::new(source.encoding, source.rows, source.cols)?;
    let mut text = Vec::new();
    let mut active = false;
    let mut segment_from = 0;
    let mut prefix_cut = false;
    let mut last_obscured = false;
    for event in source.events.iter().filter(|e| e.seq < through) {
        let included = window
            .is_none_or(|w| w.from_ms <= event.timestamp_ms && event.timestamp_ms < w.until_ms);
        if !included || event.gap_bytes.is_some() {
            if active {
                finish(&mut replay, &mut text);
                last_obscured = protect(
                    policy,
                    &mut text[segment_from..],
                    Boundaries {
                        prefix_cut,
                        suffix_cut: true,
                    },
                    &mut meta.report,
                )?;
                active = false;
            }
            if !included {
                continue;
            }
        }
        if !active {
            if !text.is_empty() || event.gap_bytes.is_some() {
                replay = Presentation::new(source.encoding, source.rows, source.cols)?;
                meta.context_resets += 1;
            }
            segment_from = text.len();
            prefix_cut = event.seq != 1 || event.gap_bytes.is_some();
            active = true;
        }
        let mut derived = if let Some(lost) = event.gap_bytes {
            replay.gap(event.seq, lost, event.timestamp_ms).clone()
        } else {
            replay
                .append(event.seq, &event.bytes, event.timestamp_ms)
                .clone()
        };
        derived.seq = event.seq;
        text.push(derived);
    }
    if active {
        finish(&mut replay, &mut text);
        last_obscured = protect(
            policy,
            &mut text[segment_from..],
            Boundaries {
                prefix_cut,
                suffix_cut: !source.completed || through != source.next_cursor,
            },
            &mut meta.report,
        )?;
    }
    if let View::Text {
        cursor, max_bytes, ..
    } = view
    {
        let start = cursor.max(oldest).min(through);
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut next = through;
        for event in text.into_iter().filter(|e| e.seq >= start) {
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
    let projected = policy
        .rules
        .project_screen(&screen.contents, last_obscured)?;
    meta.report.screen_withheld = projected.withheld;
    meta.report.screen_rows_hidden = projected.rows_hidden;
    screen.contents = projected.contents;
    Ok(Reply::Screen {
        context: Box::new(meta),
        screen,
    })
}

#[cfg(test)]
#[path = "protected_context/tests.rs"]
mod tests;
