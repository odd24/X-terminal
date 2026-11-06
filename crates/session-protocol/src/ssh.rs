//! Desktop SSH2 control. Secret/configuration resolution remains private to the service.
use crate::Sensitive;
use config_model::{Auth, HostKeyReview};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::session::{ConnectionInfo, ConnectionRef};
use uuid::Uuid;
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Disconnect {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    DisconnectStatus {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    Reconnect {
        connection: ConnectionRef,
        request_id: Uuid,
        cols: u32,
        rows: u32,
    },
    Exec {
        connection: ConnectionRef,
        request_id: Uuid,
        command: Sensitive,
        timeout_ms: u64,
        max_output_bytes: usize,
    },
    ExecStatus {
        connection: ConnectionRef,
        task_id: Uuid,
    },
    ExecRead {
        connection: ConnectionRef,
        task_id: Uuid,
        cursor: u64,
        max_bytes: usize,
    },
    ExecCancel {
        connection: ConnectionRef,
        task_id: Uuid,
    },
    WriteText {
        connection: ConnectionRef,
        request_id: Uuid,
        text: Sensitive,
    },
    Write {
        connection: ConnectionRef,
        request_id: Uuid,
        bytes: crate::SensitiveBytes,
    },
    Resize {
        connection: ConnectionRef,
        request_id: Uuid,
        cols: u32,
        rows: u32,
    },
    InputStatus {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    Start {
        profile_id: Uuid,
        request_id: Uuid,
        cols: u32,
        rows: u32,
    },
    Status {
        connection: ConnectionRef,
    },
    AnswerHost {
        connection: ConnectionRef,
        challenge_id: Uuid,
        approve: bool,
    },
    Authenticate {
        connection: ConnectionRef,
        challenge_id: Uuid,
        use_saved: bool,
        password: Option<Sensitive>,
    },
    AnswerInteractive {
        connection: ConnectionRef,
        challenge_id: Uuid,
        answers: Vec<Sensitive>,
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
        match self {
            Self::Reconnect {
                connection,
                request_id,
                cols,
                rows,
            } => {
                valid(*connection)
                    && !request_id.is_nil()
                    && (2..=500).contains(cols)
                    && (1..=200).contains(rows)
            }
            Self::Exec {
                connection,
                request_id,
                command,
                timeout_ms,
                max_output_bytes,
            } => {
                valid(*connection)
                    && !request_id.is_nil()
                    && !command.expose().is_empty()
                    && command.expose().len() <= 65536
                    && !command.expose().contains('\0')
                    && (1..=86400000).contains(timeout_ms)
                    && (1..=1048576).contains(max_output_bytes)
            }
            Self::ExecStatus {
                connection,
                task_id,
            }
            | Self::ExecCancel {
                connection,
                task_id,
            } => valid(*connection) && !task_id.is_nil(),
            Self::ExecRead {
                connection,
                task_id,
                cursor,
                max_bytes,
            } => {
                valid(*connection)
                    && !task_id.is_nil()
                    && *cursor > 0
                    && (4096..=65536).contains(max_bytes)
            }
            Self::WriteText {
                connection,
                request_id,
                text,
            } => {
                valid(*connection)
                    && !request_id.is_nil()
                    && !text.expose().is_empty()
                    && text.expose().len() <= 196608
            }
            Self::Write {
                connection,
                request_id,
                bytes,
            } => {
                valid(*connection)
                    && !request_id.is_nil()
                    && !bytes.expose().is_empty()
                    && bytes.expose().len() <= 65536
            }
            Self::Resize {
                connection,
                request_id,
                cols,
                rows,
            } => {
                valid(*connection)
                    && !request_id.is_nil()
                    && (2..=500).contains(cols)
                    && (1..=200).contains(rows)
            }
            Self::Disconnect {
                connection,
                request_id,
            }
            | Self::DisconnectStatus {
                connection,
                request_id,
            }
            | Self::InputStatus {
                connection,
                request_id,
            } => valid(*connection) && !request_id.is_nil(),
            Self::Start {
                profile_id,
                request_id,
                cols,
                rows,
            } => {
                !profile_id.is_nil()
                    && !request_id.is_nil()
                    && (2..=500).contains(cols)
                    && (1..=200).contains(rows)
            }
            Self::Status { connection }
            | Self::Close { connection }
            | Self::Forget { connection } => valid(*connection),
            Self::AnswerHost {
                connection,
                challenge_id,
                ..
            } => valid(*connection) && !challenge_id.is_nil(),
            Self::Authenticate {
                connection,
                challenge_id,
                use_saved,
                password,
            } => {
                valid(*connection)
                    && !challenge_id.is_nil()
                    && if *use_saved {
                        password.is_none()
                    } else {
                        password
                            .as_ref()
                            .is_some_and(|value| value.expose().len() <= 65536)
                    }
            }
            Self::AnswerInteractive {
                connection,
                challenge_id,
                answers,
            } => {
                valid(*connection)
                    && !challenge_id.is_nil()
                    && answers.len() <= 16
                    && answers
                        .iter()
                        .map(|answer| answer.expose().len())
                        .sum::<usize>()
                        <= 8192
            }
        }
    }
}
fn valid(connection: ConnectionRef) -> bool {
    !connection.connection_id.0.is_nil() && connection.generation > 0
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Prompt {
    pub text: String,
    pub echo: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Challenge {
    HostKey {
        id: Uuid,
        review: HostKeyReview,
    },
    Credentials {
        id: Uuid,
        auth: Auth,
        stored_available: bool,
    },
    Interactive {
        id: Uuid,
        name: String,
        instructions: String,
        prompts: Vec<Prompt>,
    },
}
impl Challenge {
    pub fn id(&self) -> Uuid {
        match self {
            Self::HostKey { id, .. }
            | Self::Credentials { id, .. }
            | Self::Interactive { id, .. } => *id,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    Configuration,
    HostKeyRejected,
    HostKeyConflict,
    ApprovalTimeout,
    TransportTimeout,
    AuthenticationRejected,
    CredentialUnavailable,
    Transport,
    Cancelled,
    ProtocolLimit,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub connection: ConnectionInfo,
    pub profile_id: Uuid,
    pub encoding: config_model::Encoding,
    pub challenge: Option<Challenge>,
    pub failure: Option<Failure>,
    pub shell_exit_status: Option<u32>,
    pub shell_exit_signal: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Disconnect(session_core::disconnect::Receipt),
    Exec(TaskStatus),
    ExecOutput {
        connection: ConnectionRef,
        task_id: Uuid,
        output: session_core::task_output::Page,
    },
    Input(session_core::input::Receipt),
    Started {
        connection: ConnectionInfo,
    },
    Status(Box<Status>),
    Accepted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskPhase {
    Queued,
    Running,
    Cancelling,
    Finished,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecEnd {
    Completed,
    RemoteSignal,
    MissingExitStatus,
    TransportLost,
    Rejected,
    Timeout,
    Cancelled,
    OutputLimit,
    ProtocolFailure,
    CancelledBeforeDispatch,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecSummary {
    pub end: ExecEnd,
    pub exit_status: Option<u32>,
    pub exit_signal: Option<String>,
    pub request_accepted: Option<bool>,
    pub output_truncated: bool,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskStatus {
    pub task_id: Uuid,
    pub connection: ConnectionRef,
    pub phase: TaskPhase,
    pub encoding: config_model::Encoding,
    pub summary: Option<ExecSummary>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbered_disconnect_requires_exact_target_and_rejects_caller_authority() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        for query in [false, true] {
            let request = if query {
                Request::DisconnectStatus {
                    connection,
                    request_id: Uuid::new_v4(),
                }
            } else {
                Request::Disconnect {
                    connection,
                    request_id: Uuid::new_v4(),
                }
            };
            assert!(request.validate());
            let mut value = serde_json::to_value(request).unwrap();
            value["owner"] = serde_json::json!(Uuid::new_v4());
            assert!(serde_json::from_value::<Request>(value.clone()).is_err());
            value.as_object_mut().unwrap().remove("owner");
            value["request_id"] = serde_json::json!(Uuid::nil());
            assert!(
                !serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            value["request_id"] = serde_json::json!(Uuid::new_v4());
            value["connection"]["generation"] = serde_json::json!(0);
            assert!(!serde_json::from_value::<Request>(value).unwrap().validate());
        }
    }
    #[test]
    fn text_input_is_bounded_scoped_sensitive_and_strict_unicode() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        for (text, expected) in [
            ("中文".into(), true),
            (String::new(), false),
            ("中".repeat(65536), true),
            ("中".repeat(65537), false),
        ] {
            let request = Request::WriteText {
                connection,
                request_id: Uuid::new_v4(),
                text: Sensitive::new(text),
            };
            assert_eq!(request.validate(), expected);
            assert!(!format!("{request:?}").contains("中文"));
        }
        let mut value = serde_json::to_value(Request::WriteText {
            connection,
            request_id: Uuid::new_v4(),
            text: Sensitive::new("synthetic".into()),
        })
        .unwrap();
        value["encoding"] = serde_json::json!("utf8");
        assert!(serde_json::from_value::<Request>(value).is_err());
        let json = format!(
            r#"{{"op":"write_text","connection":{},"request_id":"{}","text":"\ud800"}}"#,
            serde_json::to_string(&connection).unwrap(),
            Uuid::new_v4()
        );
        assert!(serde_json::from_str::<Request>(&json).is_err());
    }
    #[test]
    fn reconnect_contract_requires_source_generation_request_id_and_valid_size() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let request_id = Uuid::new_v4();
        assert!(
            Request::Reconnect {
                connection,
                request_id,
                cols: 80,
                rows: 24
            }
            .validate()
        );
        for (generation, id, cols, rows) in [
            (0, request_id, 80, 24),
            (1, Uuid::nil(), 80, 24),
            (1, request_id, 501, 24),
            (1, request_id, 80, 0),
        ] {
            assert!(
                !Request::Reconnect {
                    connection: ConnectionRef {
                        generation,
                        ..connection
                    },
                    request_id: id,
                    cols,
                    rows
                }
                .validate()
            );
        }
        let mut value = serde_json::to_value(Request::Reconnect {
            connection,
            request_id,
            cols: 80,
            rows: 24,
        })
        .unwrap();
        value["replay_pending"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    #[test]
    fn forget_requires_an_exact_reference_and_rejects_extra_controls() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 2,
        };
        assert!(Request::Forget { connection }.validate());
        assert!(
            !Request::Forget {
                connection: ConnectionRef {
                    generation: 0,
                    ..connection
                }
            }
            .validate()
        );
        let mut value = serde_json::to_value(Request::Forget { connection }).unwrap();
        value["force"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    #[test]
    fn exec_contract_bounds_commands_and_task_reads_and_redacts_command_debug() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let id = Uuid::new_v4();
        let request = Request::Exec {
            connection,
            request_id: id,
            command: Sensitive::new("synthetic sensitive command".into()),
            timeout_ms: 600000,
            max_output_bytes: 1048576,
        };
        assert!(request.validate());
        assert!(!format!("{request:?}").contains("synthetic sensitive command"));
        for command in [String::new(), "x".repeat(65537), "bad\0command".into()] {
            assert!(
                !Request::Exec {
                    connection,
                    request_id: id,
                    command: Sensitive::new(command),
                    timeout_ms: 1,
                    max_output_bytes: 1
                }
                .validate()
            );
        }
        for (timeout_ms, max_output_bytes) in [(0, 1), (86400001, 1), (1, 0), (1, 1048577)] {
            assert!(
                !Request::Exec {
                    connection,
                    request_id: id,
                    command: Sensitive::new("command".into()),
                    timeout_ms,
                    max_output_bytes
                }
                .validate()
            );
        }
        assert!(
            !Request::ExecRead {
                connection,
                task_id: id,
                cursor: 0,
                max_bytes: 4096
            }
            .validate()
        );
        assert!(
            !Request::ExecRead {
                connection,
                task_id: id,
                cursor: 1,
                max_bytes: 65537
            }
            .validate()
        );
        assert!(
            !Request::ExecCancel {
                connection,
                task_id: Uuid::nil()
            }
            .validate()
        );
    }
    #[test]
    fn input_contract_requires_bounded_payloads_scopes_and_request_ids_and_redacts_debug() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let request_id = Uuid::new_v4();
        let bytes = b"synthetic input secret".to_vec();
        let request = Request::Write {
            connection,
            request_id,
            bytes: crate::SensitiveBytes::new(bytes.clone()),
        };
        assert!(request.validate());
        assert!(!format!("{request:?}").contains("[115, 121, 110"));
        assert!(format!("{request:?}").contains("[REDACTED]"));
        assert!(!format!("{request:?}").contains("synthetic"));
        let Request::Write {
            bytes: roundtrip, ..
        } = serde_json::from_str::<Request>(&serde_json::to_string(&request).unwrap()).unwrap()
        else {
            panic!()
        };
        assert_eq!(roundtrip.expose(), bytes);
        for bytes in [Vec::new(), vec![0; 65537]] {
            assert!(
                !Request::Write {
                    connection,
                    request_id,
                    bytes: crate::SensitiveBytes::new(bytes)
                }
                .validate()
            );
        }
        assert!(
            !Request::InputStatus {
                connection,
                request_id: Uuid::nil()
            }
            .validate()
        );
        assert!(
            !Request::Resize {
                connection,
                request_id,
                cols: 501,
                rows: 24
            }
            .validate()
        );
        let mut value = serde_json::to_value(request).unwrap();
        value["bytes"] = serde_json::json!([256]);
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    #[test]
    fn ssh_contract_rejects_raw_keys_invalid_credentials_and_unscoped_decisions() {
        let connection = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let challenge_id = Uuid::new_v4();
        assert!(
            !Request::Authenticate {
                connection,
                challenge_id,
                use_saved: true,
                password: Some(Sensitive::new("synthetic secret".into()))
            }
            .validate()
        );
        assert!(
            !Request::Authenticate {
                connection,
                challenge_id,
                use_saved: false,
                password: None
            }
            .validate()
        );
        assert!(
            !Request::AnswerHost {
                connection,
                challenge_id: Uuid::nil(),
                approve: true
            }
            .validate()
        );
        let mut stale = connection;
        stale.generation = 0;
        assert!(!Request::Close { connection: stale }.validate());
        assert!(
            !Request::AnswerInteractive {
                connection,
                challenge_id,
                answers: (0..17).map(|_| Sensitive::new(String::new())).collect()
            }
            .validate()
        );
        assert!(
            !Request::AnswerInteractive {
                connection,
                challenge_id,
                answers: vec![Sensitive::new("x".repeat(8193))]
            }
            .validate()
        );
        let request = Request::Authenticate {
            connection,
            challenge_id,
            use_saved: false,
            password: Some(Sensitive::new("synthetic protocol secret".into())),
        };
        assert!(request.validate());
        assert!(!format!("{request:?}").contains("synthetic protocol secret"));
        let mut value = serde_json::to_value(&request).unwrap();
        value["private_key"] = serde_json::json!("raw key forbidden");
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
}
