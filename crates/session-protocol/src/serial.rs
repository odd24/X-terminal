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
    StartFixed {
        target: ConnectTarget,
    },
    ConnectStatus {
        target: ConnectTarget,
    },
    QuickStart {
        settings: config_model::Settings,
        request_id: Uuid,
        revision: Uuid,
        device_id: Uuid,
    },
    StartStatus {
        request_id: Uuid,
    },
    ForgetStart {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    ForgetStatus {
        connection: ConnectionRef,
        request_id: Uuid,
    },
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
    Disconnect {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    DisconnectStatus {
        connection: ConnectionRef,
        request_id: Uuid,
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
            Self::StartFixed { target } | Self::ConnectStatus { target } => target.valid(),
            Self::QuickStart {
                settings,
                request_id,
                revision,
                device_id,
            } => {
                matches!(settings, config_model::Settings::Serial { .. })
                    && settings.validate().is_ok()
                    && [request_id, revision, device_id]
                        .iter()
                        .all(|id| !id.is_nil())
            }
            Self::StartStatus { request_id } => !request_id.is_nil(),
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
            Self::ForgetStart {
                connection,
                request_id,
            }
            | Self::ForgetStatus {
                connection,
                request_id,
            }
            | Self::Control {
                connection,
                request_id,
                ..
            }
            | Self::InputStatus {
                connection,
                request_id,
            }
            | Self::Disconnect {
                connection,
                request_id,
            }
            | Self::DisconnectStatus {
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
    ConnectReceipt(ConnectReceipt),
    Forget(session_core::forget::Receipt),
    Disconnect(session_core::disconnect::Receipt),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectTarget {
    pub profile_id: Uuid,
    pub profile_revision: Uuid,
    pub inventory_revision: Uuid,
    pub device_id: Uuid,
    pub request_id: Uuid,
}
impl ConnectTarget {
    fn valid(self) -> bool {
        [
            self.profile_id,
            self.profile_revision,
            self.inventory_revision,
            self.device_id,
            self.request_id,
        ]
        .iter()
        .all(|id| !id.is_nil())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectReceipt {
    pub target: ConnectTarget,
    pub connection: ConnectionInfo,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quick_start_is_strict_serial_only_and_status_is_number_only() {
        let id = Uuid::new_v4();
        let value = serde_json::json!({"op":"quick_start","request_id":id,"revision":id,"device_id":id,"settings":{"protocol":"serial","port":"COM7","baud_rate":115200,"data_bits":8,"stop_bits":1,"parity":"none","flow":"none","dtr_on_open":false,"rts_on_open":false,"encoding":"utf8"}});
        assert!(
            serde_json::from_value::<Request>(value.clone())
                .unwrap()
                .validate()
        );
        let mut invalid = value.clone();
        invalid["settings"]["rts_on_open"] = serde_json::Value::Null;
        assert!(
            !serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
        );
        let mut invalid = value;
        invalid["owner"] = serde_json::json!(id);
        assert!(serde_json::from_value::<Request>(invalid).is_err());
        assert!(Request::StartStatus { request_id: id }.validate());
        assert!(
            !Request::StartStatus {
                request_id: Uuid::nil()
            }
            .validate()
        );
    }
    #[test]
    fn disconnect_requires_original_number_and_generation_without_caller_owner() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        for op in [
            "disconnect",
            "disconnect_status",
            "forget_start",
            "forget_status",
        ] {
            let mut value = serde_json::json!({"op": op, "connection": connection, "request_id": Uuid::new_v4()});
            assert!(
                serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            value["owner"] = serde_json::json!(Uuid::new_v4());
            assert!(serde_json::from_value::<Request>(value.clone()).is_err());
            value.as_object_mut().unwrap().remove("owner");
            value["connection"]["generation"] = serde_json::json!(0);
            assert!(
                !serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            value["connection"]["generation"] = serde_json::json!(1);
            value["request_id"] = serde_json::json!(Uuid::nil());
            assert!(
                !serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            value.as_object_mut().unwrap().remove("request_id");
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }
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
