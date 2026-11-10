//! Versioned safe stderr metadata; never serializes an underlying error or payload.
use serde::{Deserialize, Serialize};
use session_core::audit_journal::{State, Status};
use terminal_log::audit::Failure;
pub const PREFIX: &str = "audit_close_diagnostic ";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Outcome {
    Closed,
    Incomplete,
    OwnerJoinFailed,
    OwnerCloseFailed,
    SnapshotUnavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloseDiagnostic {
    pub version: u8,
    pub outcome: Outcome,
    pub state: Option<State>,
    #[serde(with = "count")]
    pub accepted: Option<u64>,
    #[serde(with = "count")]
    pub synced: Option<u64>,
    #[serde(with = "count")]
    pub rejected: Option<u64>,
    pub incomplete: Option<u32>,
    pub first_failure: Option<Failure>,
}
impl CloseDiagnostic {
    pub(crate) fn new(outcome: Outcome, snapshot: Option<(Status, Option<Failure>)>) -> Self {
        let (state, accepted, synced, rejected, incomplete, first_failure) = match snapshot {
            Some((s, f)) => (
                Some(s.state),
                Some(s.accepted_through),
                Some(s.synced_through),
                Some(s.rejected_records),
                Some(s.incomplete_segments),
                f,
            ),
            None => (None, None, None, None, None, None),
        };
        Self {
            version: 1,
            outcome,
            state,
            accepted,
            synced,
            rejected,
            incomplete,
            first_failure,
        }
    }
    /// Fixed bounded schema. Failure does not return any original input text.
    pub fn parse_line(line: &str) -> Option<Self> {
        if line.len() > 2048 {
            return None;
        }
        let v: Self = serde_json::from_str(line.strip_prefix(PREFIX)?).ok()?;
        (v.version == 1).then_some(v)
    }
}
mod count {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(n) => s.serialize_some(&n.to_string()),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        let value = Option::<String>::deserialize(d)?;
        value
            .map(|s| {
                let n = s
                    .parse::<u64>()
                    .map_err(|_| serde::de::Error::custom("invalid diagnostic count"))?;
                if s != n.to_string() {
                    return Err(serde::de::Error::custom("invalid diagnostic count"));
                }
                Ok(n)
            })
            .transpose()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_snapshot_is_exact_and_parser_rejects_unknown_or_secret_fields() {
        let status = Status {
            state: State::Closed,
            accepted_through: u64::MAX,
            synced_through: u64::MAX - 1,
            rejected_records: 7,
            incomplete_segments: 1,
            available_from: 0,
            retained_records: 0,
        };
        let report = CloseDiagnostic::new(Outcome::Incomplete, Some((status, None)));
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["accepted"], u64::MAX.to_string());
        let line = format!("{PREFIX}{}", serde_json::to_string(&value).unwrap());
        let parsed = CloseDiagnostic::parse_line(&line).unwrap();
        assert_eq!(parsed.synced, Some(u64::MAX - 1));
        for field in ["body", "path", "token", "error", "payload"] {
            let mut bad = value.clone();
            bad[field] = serde_json::json!("SYNTHETIC_PRIVATE_SECRET");
            assert!(CloseDiagnostic::parse_line(&format!("{PREFIX}{bad}")).is_none());
        }
        for bad_count in [
            serde_json::json!(17),
            serde_json::json!("017"),
            serde_json::json!("SYNTHETIC_PRIVATE_SECRET"),
            serde_json::json!("18446744073709551616"),
        ] {
            let mut bad = value.clone();
            bad["accepted"] = bad_count;
            assert!(CloseDiagnostic::parse_line(&format!("{PREFIX}{bad}")).is_none());
        }
        let mut bad = value;
        bad["version"] = serde_json::json!(2);
        assert!(CloseDiagnostic::parse_line(&format!("{PREFIX}{bad}")).is_none());
        for failure in [
            serde_json::json!({"kind":"IO_FAILURE","stage":"APPEND","path":"SYNTHETIC_PRIVATE"}),
            serde_json::json!({"kind":"IO_FAILURE","stage":"SYNTHETIC_PRIVATE"}),
        ] {
            let mut bad = serde_json::to_value(&report).unwrap();
            bad["first_failure"] = failure;
            assert!(CloseDiagnostic::parse_line(&format!("{PREFIX}{bad}")).is_none());
        }
        let missing = CloseDiagnostic::new(Outcome::OwnerJoinFailed, None);
        assert!(missing.accepted.is_none());
        assert!(serde_json::to_value(missing).unwrap()["accepted"].is_null());
    }
}
