//! Desktop serial control; observers use the common scoped Read endpoint.
use crate::SensitiveBytes;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use session_core::serial_input::{Ending, Format, Pace};
use session_core::session::{ConnectionInfo, ConnectionRef};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Send {
        connection: ConnectionRef,
        request_id: Uuid,
        content: crate::Sensitive,
        format: Format,
        ending: Ending,
        pace: Pace,
    },
    Inventory {},
    Start {
        profile_id: Uuid,
        request_id: Uuid,
        revision: Uuid,
        device_id: Uuid,
    },
    Status {
        connection: ConnectionRef,
    },
    Write {
        connection: ConnectionRef,
        request_id: Uuid,
        bytes: SensitiveBytes,
    },
    Control {
        connection: ConnectionRef,
        request_id: Uuid,
        line: Line,
        asserted: bool,
    },
    InputStatus {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    Close {
        connection: ConnectionRef,
    },
    Forget {
        connection: ConnectionRef,
    },
}
impl Request {
    pub fn validate(&self) -> bool {
        let valid = |reference: &ConnectionRef| {
            !reference.connection_id.0.is_nil() && reference.generation > 0
        };
        match self {
            Self::Send {
                connection,
                request_id,
                content,
                pace,
                ..
            } => {
                valid(connection)
                    && !request_id.is_nil()
                    && content.expose().len() <= 196608
                    && (1..=1024).contains(&pace.chunk_bytes)
                    && pace.interval_ms <= 1000
            }
            Self::Inventory {} => true,
            Self::Start {
                profile_id,
                request_id,
                revision,
                device_id,
            } => [profile_id, request_id, revision, device_id]
                .iter()
                .all(|id| !id.is_nil()),
            Self::Write {
                connection,
                request_id,
                bytes,
            } => {
                valid(connection)
                    && !request_id.is_nil()
                    && !bytes.expose().is_empty()
                    && bytes.expose().len() <= 65536
            }
            Self::Control {
                connection,
                request_id,
                ..
            }
            | Self::InputStatus {
                connection,
                request_id,
            } => valid(connection) && !request_id.is_nil(),
            Self::Status { connection }
            | Self::Close { connection }
            | Self::Forget { connection } => valid(connection),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Line {
    Dtr,
    Rts,
    Break,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    DeviceUnavailable,
    AccessOrBusy,
    InvalidParameters,
    Io,
    Cancelled,
    WorkerFailed,
    CounterExhausted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InputState {
    Pending,
    DriverAccepted,
    ControlApplied,
    CancelledBeforeDispatch,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InputReceipt {
    pub request_id: Uuid,
    /// Pending may already be executing; it is not proof of non-dispatch.
    pub state: InputState,
    pub driver_accepted: Option<usize>,
    pub failure: Option<Failure>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceSummary {
    pub device_id: Uuid,
    pub port: String,
    pub instance_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub hardware_rts: bool,
    pub encoding: config_model::Encoding,
    pub connection: ConnectionInfo,
    pub profile_id: Uuid,
    pub port: String,
    pub cleanup_pending: bool,
    pub failure: Option<Failure>,
    pub read_bytes: u64,
    pub dropped_bytes: u64,
    pub break_cleanup_failure: Option<Failure>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Inventory {
        revision: Uuid,
        devices: Vec<DeviceSummary>,
        unidentified_ports: Vec<String>,
        metadata_failures: usize,
    },
    Started {
        connection: ConnectionInfo,
    },
    Status(Status),
    Input(InputReceipt),
    Accepted,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serial_contract_requires_scopes_bounds_and_redacts_payloads() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let request = Request::Write {
            connection,
            request_id: Uuid::new_v4(),
            bytes: SensitiveBytes::new(b"synthetic-private-input".to_vec()),
        };
        assert!(request.validate());
        assert!(!format!("{request:?}").contains("synthetic-private-input"));
        for (generation, id, size) in [
            (0, Uuid::new_v4(), 1),
            (1, Uuid::nil(), 1),
            (1, Uuid::new_v4(), 0),
            (1, Uuid::new_v4(), 65537),
        ] {
            assert!(
                !Request::Write {
                    connection: ConnectionRef {
                        generation,
                        ..connection
                    },
                    request_id: id,
                    bytes: SensitiveBytes::new(vec![0; size])
                }
                .validate()
            );
        }
        let mut value = serde_json::to_value(Request::Start {
            profile_id: Uuid::new_v4(),
            request_id: Uuid::new_v4(),
            revision: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
        })
        .unwrap();
        value["path"] = serde_json::json!(r"\\.\COM7");
        assert!(serde_json::from_value::<Request>(value).is_err());
        let value = serde_json::json!({"op":"control","connection":connection,"request_id":Uuid::new_v4(),"line":"EXIT","asserted":true});
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
}
