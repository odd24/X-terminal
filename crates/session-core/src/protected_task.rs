//! Protected task output keeps stdout/stderr decoding and masking independent.
use crate::{
    pairing::protection::{Info, ProtectedPolicy},
    protected_context::Report,
    redaction::Boundaries,
    screen::StreamDecoder,
    session::ErrorCode,
    task_output::Event,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum View {
    Info {},
    Text {
        through_cursor: u64,
        cursor: u64,
        max_bytes: usize,
    },
}
impl View {
    pub fn valid(self) -> bool {
        match self {
            Self::Info {} => true,
            Self::Text {
                through_cursor,
                cursor,
                max_bytes,
            } => cursor > 0 && cursor <= through_cursor && (16384..=65536).contains(&max_bytes),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TextEvent {
    pub seq: u64,
    pub stderr: bool,
    pub text: String,
    pub decode_error: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub through_cursor: u64,
    pub source_available_from: u64,
    pub source_truncated: bool,
    pub source_completed: bool,
    pub encoding: String,
    pub protection: Info,
    pub report: Report,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Info {
        context: Metadata,
    },
    Text {
        context: Metadata,
        events: Vec<TextEvent>,
        next_cursor: u64,
        truncated: bool,
    },
}
pub(crate) fn read(
    source: &VecDeque<Event>,
    next: u64,
    completed: bool,
    encoding: &str,
    view: View,
    policy: &ProtectedPolicy,
) -> Result<Reply, ErrorCode> {
    if !view.valid() {
        return Err(ErrorCode::InvalidArgument);
    }
    let through = match view {
        View::Info {} => next,
        View::Text { through_cursor, .. } => through_cursor,
    };
    if through > next {
        return Err(ErrorCode::InvalidArgument);
    }
    let oldest = source.front().map_or(next, |e| e.seq);
    let mut meta = Metadata {
        through_cursor: through,
        source_available_from: oldest.min(through),
        source_truncated: oldest > 1,
        source_completed: completed,
        encoding: encoding.into(),
        protection: policy.info,
        report: Report::default(),
    };
    if matches!(view, View::Info {}) {
        return Ok(Reply::Info { context: meta });
    }
    let mut decoder = [
        StreamDecoder::new(encoding).map_err(|_| ErrorCode::InvalidArgument)?,
        StreamDecoder::new(encoding).map_err(|_| ErrorCode::InvalidArgument)?,
    ];
    let mut events = Vec::new();
    let mut indices: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
    for event in source.iter().filter(|e| e.seq < through) {
        let stream = usize::from(event.stderr);
        let (text, decode_error) = decoder[stream]
            .decode(&event.bytes, false)
            .map_err(|_| ErrorCode::InvalidState)?;
        indices[stream].push(events.len());
        events.push(TextEvent {
            seq: event.seq,
            stderr: event.stderr,
            text,
            decode_error,
        });
    }
    for stream in 0..2 {
        let (tail, error) = decoder[stream]
            .decode(&[], true)
            .map_err(|_| ErrorCode::InvalidState)?;
        if let Some(last) = indices[stream].last().copied() {
            events[last].text.push_str(&tail);
            events[last].decode_error |= error;
        }
        let parts: Vec<_> = indices[stream]
            .iter()
            .map(|i| events[*i].text.as_str())
            .collect();
        let p = policy.rules.project(
            &parts,
            Boundaries {
                prefix_cut: oldest > 1,
                suffix_cut: !completed || through != next,
            },
        )?;
        meta.report.boundary_guard |= p.boundary_guard;
        meta.report.opaque_controls |= p.opaque_controls;
        for (index, text) in indices[stream].iter().zip(p.fragments) {
            events[*index].text = text;
        }
    }
    let View::Text {
        cursor, max_bytes, ..
    } = view
    else {
        unreachable!()
    };
    let mut out = Vec::new();
    let mut bytes = 0;
    let mut next_cursor = through;
    for event in events.into_iter().filter(|e| e.seq >= cursor.max(oldest)) {
        if bytes + event.text.len() > max_bytes {
            next_cursor = event.seq;
            break;
        }
        bytes += event.text.len();
        out.push(event);
    }
    Ok(Reply::Text {
        context: meta,
        events: out,
        next_cursor,
        truncated: cursor < oldest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{redaction::Policy, task_output::Buffer};
    use std::sync::Arc;
    use uuid::Uuid;
    fn policy(fields: bool) -> ProtectedPolicy {
        ProtectedPolicy {
            info: Info {
                policy_id: Uuid::new_v4(),
                sensitive_fields: fields,
                literal_count: 1,
            },
            rules: Arc::new(Policy::new(vec!["synthetic-secret".into()], fields).unwrap()),
        }
    }
    fn page(
        b: &Buffer,
        through: u64,
        cursor: u64,
        p: &ProtectedPolicy,
    ) -> (Metadata, Vec<TextEvent>, u64) {
        let Reply::Text {
            context,
            events,
            next_cursor,
            ..
        } = b
            .protected_read(
                true,
                "utf-8",
                View::Text {
                    through_cursor: through,
                    cursor,
                    max_bytes: 16384,
                },
                p,
            )
            .unwrap()
        else {
            panic!()
        };
        (context, events, next_cursor)
    }
    #[test]
    fn masks_across_same_stream_fragments_before_paging_without_joining_other_stream() {
        let mut b = Buffer::default();
        b.append(false, b"synthetic-");
        b.append(true, b"public\n");
        b.append(false, b"secret\n");
        let p = policy(false);
        let (_, events, next) = page(&b, 4, 2, &p);
        assert_eq!(next, 4);
        assert!(events[0].stderr);
        assert_eq!(events[0].text, "public\n");
        assert_eq!(events[1].text, "******\n");
        assert_eq!(
            b.read(1, 65536, true).unwrap().events[0].bytes,
            b"synthetic-"
        );
        let mut b = Buffer::default();
        b.append(false, b"synthetic-");
        b.append(true, b"secret\n");
        let (_, events, _) = page(&b, 3, 1, &p);
        assert_eq!(events[0].text, "synthetic-");
        assert_eq!(events[1].text, "secret\n");
    }
    #[test]
    fn each_stream_has_its_own_incremental_decoder_and_cutoffs_finish_without_future_bytes() {
        let mut b = Buffer::default();
        b.append(false, &[0xe4, 0xb8]);
        b.append(true, b"error\n");
        b.append(false, &[0xad]);
        let p = policy(false);
        let (_, events, _) = page(&b, 4, 1, &p);
        assert_eq!(events[0].text, "");
        assert_eq!(events[1].text, "error\n");
        assert_eq!(events[2].text, "中");
        assert!(events.iter().all(|e| !e.decode_error));
        let (m, events, _) = page(&b, 3, 1, &p);
        assert!(m.report.boundary_guard);
        assert!(events[0].decode_error);
        assert!(!events.iter().any(|e| e.text.contains('中')));
    }
    #[test]
    fn overwritten_prefix_and_fields_are_hidden_and_source_loss_is_reported_separately() {
        let mut b = Buffer::default();
        b.append(false, &vec![b'x'; 70000]);
        let p = policy(true);
        let Reply::Info { context } = b.protected_read(true, "utf-8", View::Info {}, &p).unwrap()
        else {
            panic!()
        };
        assert!(context.source_truncated);
        let Reply::Text {
            context,
            events,
            truncated,
            ..
        } = b
            .protected_read(
                true,
                "utf-8",
                View::Text {
                    through_cursor: context.through_cursor,
                    cursor: 1,
                    max_bytes: 16384,
                },
                &p,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(truncated);
        assert!(context.report.boundary_guard);
        assert!(events.iter().all(|e| e.text.bytes().all(|b| b == b'*')));
        assert!(context.source_available_from > 1);
    }
}
