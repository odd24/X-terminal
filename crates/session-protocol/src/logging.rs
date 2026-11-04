use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::session::*;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub segment_bytes: u64,
    pub segments: u32,
}
impl Limits {
    pub fn validate(self) -> bool {
        (128 * 1024..=100 * 1024 * 1024).contains(&self.segment_bytes)
            && (1..=16).contains(&self.segments)
    }
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Start {
        connection: ConnectionRef,
        request_id: Uuid,
        limits: Limits,
    },
    List {
        connection: ConnectionRef,
    },
    Status {
        connection: ConnectionRef,
        log_id: Uuid,
    },
    Stop {
        connection: ConnectionRef,
        log_id: Uuid,
    },
}
impl Request {
    pub fn validate(&self) -> bool {
        let connection = match self {
            Self::Start {
                connection,
                request_id,
                limits,
            } => {
                if request_id.is_nil() || !limits.validate() {
                    return false;
                }
                connection
            }
            Self::List { connection } => connection,
            Self::Status { connection, log_id } | Self::Stop { connection, log_id } => {
                if log_id.is_nil() {
                    return false;
                }
                connection
            }
        };
        connection.generation > 0 && !connection.connection_id.0.is_nil()
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Phase {
    Opening,
    Recording,
    Stopping,
    Stopped,
    Failed,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    QueueFull,
    InvalidRecord,
    CounterExhausted,
    DiskFull,
    Storage,
    WorkerPanicked,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Info {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub encoding: String,
    pub started_at_ms: u64,
    pub source_cursor: u64,
    pub text_cursor: u64,
    pub limits: Limits,
    pub phase: Phase,
    pub failure: Option<Failure>,
    pub active: bool,
    pub accepted_records: u64,
    pub written_records: u64,
    pub accepted_raw_bytes: u64,
    pub written_raw_bytes: u64,
    pub rejected_records: u64,
    pub rejected_raw_bytes: u64,
    pub source_gap_bytes: u64,
    pub first_retained_segment: u64,
    pub last_segment: u64,
    pub retired_segments: u64,
    pub natural_end: bool,
    pub durable: bool,
    pub worker_finished: bool,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Info(Box<Info>),
    List { logs: Vec<Info> },
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logging_contract_rejects_paths_unscoped_ids_and_invalid_limits() {
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let value = serde_json::json!({"op":"start","connection":connection,"request_id":Uuid::new_v4(),"limits":{"segment_bytes":131072,"segments":2}});
        assert!(
            serde_json::from_value::<Request>(value.clone())
                .unwrap()
                .validate()
        );
        for field in ["path", "directory", "encoding", "role"] {
            let mut bad = value.clone();
            bad[field] = "forbidden".into();
            assert!(serde_json::from_value::<Request>(bad).is_err());
        }
        let mut invalid = value.clone();
        invalid["connection"]["generation"] = 0.into();
        assert!(
            !serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
        );
        let mut invalid = value;
        invalid["limits"]["segments"] = 17.into();
        assert!(
            !serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
        );
        assert!(
            !Request::Status {
                connection,
                log_id: Uuid::nil()
            }
            .validate()
        );
        assert!(
            !Request::Start {
                connection,
                request_id: Uuid::nil(),
                limits: Limits {
                    segment_bytes: 131072,
                    segments: 1
                }
            }
            .validate()
        );
    }
}
