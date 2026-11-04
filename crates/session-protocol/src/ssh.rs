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
}
impl Request {
    pub fn validate(&self) -> bool {
        match self {
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
            Self::Status { connection } | Self::Close { connection } => valid(*connection),
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
    pub challenge: Option<Challenge>,
    pub failure: Option<Failure>,
    pub shell_exit_status: Option<u32>,
    pub shell_exit_signal: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Started { connection: ConnectionInfo },
    Status(Box<Status>),
    Accepted,
}

#[cfg(test)]
mod tests {
    use super::*;
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
