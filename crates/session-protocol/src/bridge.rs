//! Narrow native half of the stdio bridge. No bearer/credential/configuration RPC.
use crate::*;
use session_core::{
    access::Lease, context::TimeWindow, pairing::protection::Info, protected_context::View,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Transport {
    Ssh2,
    Serial,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    List {},
    Output {
        connection: ConnectionRef,
        window: Option<TimeWindow>,
        view: View,
    },
    Send {
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
        text: Sensitive,
    },
    InputStatus {
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    },
    Lease {
        connection: ConnectionRef,
    },
    Acquire {
        connection: ConnectionRef,
        lifetime_ms: u64,
    },
    Release {
        connection: ConnectionRef,
        lease_id: Uuid,
    },
}
impl Operation {
    pub fn into_service(
        self,
        protected: bool,
    ) -> Result<Request, session_core::session::ErrorCode> {
        let request = match self {
            Self::List {} => Request::List {},
            Self::Output {
                connection,
                window,
                view,
            } => {
                if !view.valid()
                    || window.is_some_and(|w| !w.valid())
                    || matches!(view,View::Text {max_bytes,..} if max_bytes>65536)
                {
                    return Err(session_core::session::ErrorCode::InvalidArgument);
                }
                if protected {
                    Request::ProtectedContext {
                        connection,
                        window,
                        view,
                    }
                } else {
                    let view = match view {
                        View::Info {} => session_core::context::View::Info {},
                        View::Text {
                            through_cursor,
                            cursor,
                            max_bytes,
                        } => session_core::context::View::Text {
                            through_cursor,
                            cursor,
                            max_bytes,
                        },
                        View::Screen { through_cursor } => {
                            session_core::context::View::Screen { through_cursor }
                        }
                    };
                    Request::Context {
                        connection,
                        window: window.unwrap_or(TimeWindow {
                            from_ms: 0,
                            until_ms: 253_402_300_799_999,
                        }),
                        view,
                    }
                }
            }
            Self::Send {
                transport,
                connection,
                request_id,
                text,
            } => {
                if text.expose().is_empty() || text.expose().len() > 16384 {
                    return Err(session_core::session::ErrorCode::InvalidArgument);
                }
                match transport {
                    Transport::Ssh2 => Request::Ssh {
                        request: ssh::Request::WriteText {
                            connection,
                            request_id,
                            text,
                        },
                    },
                    Transport::Serial => Request::Serial {
                        request: serial::Request::Send {
                            connection,
                            request_id,
                            content: text,
                            format: serial::Format::Text,
                            ending: serial::Ending::None,
                            pace: serial::Pace {
                                chunk_bytes: 1024,
                                interval_ms: 0,
                            },
                        },
                    },
                }
            }
            Self::InputStatus {
                transport,
                connection,
                request_id,
            } => match transport {
                Transport::Ssh2 => Request::Ssh {
                    request: ssh::Request::InputStatus {
                        connection,
                        request_id,
                    },
                },
                Transport::Serial => Request::Serial {
                    request: serial::Request::InputStatus {
                        connection,
                        request_id,
                    },
                },
            },
            Self::Lease { connection } => Request::Agent {
                request: agent::Request::Lease { connection },
            },
            Self::Acquire {
                connection,
                lifetime_ms,
            } => Request::Agent {
                request: agent::Request::Acquire {
                    connection,
                    lifetime_ms,
                },
            },
            Self::Release {
                connection,
                lease_id,
            } => Request::Agent {
                request: agent::Request::Release {
                    connection,
                    lease_id,
                },
            },
        };
        request.validate()?;
        Ok(request)
    }
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestMessage {
    Status {},
    Call { request: Operation },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub broker_id: Uuid,
    pub service_id: Uuid,
    pub peer_pid: u32,
    pub paired_ticket: Option<Uuid>,
    /// Approval snapshot, not a statement that the ticket/scopes remain active.
    pub approved_scopes: Vec<session_core::access::Scope>,
    pub protection: Option<Info>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "result",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ResultMessage {
    Status(Status),
    Sessions(Vec<ConnectionInfo>),
    Context(Box<session_core::context::Reply>),
    ProtectedContext(Box<session_core::protected_context::Reply>),
    SshInput(session_core::input::Receipt),
    SerialInput(serial::InputReceipt),
    Lease(Option<Lease>),
    Ok,
    Error(session_core::session::ErrorCode),
}
impl ResultMessage {
    /// Explicit reply projection prevents a future service secret from escaping.
    pub fn from_service(response: Response) -> Self {
        match response {
            Response::Error { code, .. } => Self::Error(code),
            Response::Ok { reply, .. } => match reply {
                Reply::Sessions(v) => Self::Sessions(v),
                Reply::Context(v) => Self::Context(Box::new(v)),
                Reply::ProtectedContext(v) => Self::ProtectedContext(Box::new(v)),
                Reply::Ssh(ssh::Reply::Input(v)) => Self::SshInput(v),
                Reply::Serial(serial::Reply::Input(v)) => Self::SerialInput(v),
                Reply::Agent(agent::Reply::Lease(v)) => Self::Lease(v),
                Reply::Agent(agent::Reply::Ok) => Self::Ok,
                _ => Self::Error(session_core::session::ErrorCode::InvalidState),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_is_a_closed_whitelist_and_never_projects_bearers_or_management_replies() {
        for value in [
            serde_json::json!({"op":"grant","scopes":[]}),
            serde_json::json!({"op":"call","request":{"op":"config"}}),
            serde_json::json!({"op":"status","token":"secret"}),
        ] {
            assert!(serde_json::from_value::<RequestMessage>(value).is_err());
        }
        let protected = Operation::Output {
            connection: ConnectionRef {
                connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
                generation: 1,
            },
            window: None,
            view: View::Info {},
        }
        .into_service(true)
        .unwrap();
        assert!(matches!(protected, Request::ProtectedContext { .. }));
        let ordinary = Operation::Output {
            connection: ConnectionRef {
                connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
                generation: 1,
            },
            window: None,
            view: View::Info {},
        }
        .into_service(false)
        .unwrap();
        assert!(
            matches!(ordinary,Request::Context {window,..} if window.valid() && window.from_ms==0)
        );
        let denied = ResultMessage::from_service(Response::Ok {
            id: 1,
            reply: Reply::ReadTicket {
                ticket_id: Uuid::new_v4(),
                token: Sensitive::new("do-not-forward".into()),
                expires_at_ms: 100,
            },
        });
        assert!(
            !serde_json::to_string(&denied)
                .unwrap()
                .contains("do-not-forward")
        );
    }
}
