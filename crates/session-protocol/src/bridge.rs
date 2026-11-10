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
    Reconnect {
        connection: ConnectionRef,
        request_id: Uuid,
        cols: u32,
        rows: u32,
    },
    ReconnectStatus {
        connection: ConnectionRef,
        request_id: Uuid,
    },
    Forget {
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    },
    ForgetStatus {
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    },
    Disconnect {
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    },
    DisconnectStatus {
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    },
    SerialWrite {
        connection: ConnectionRef,
        request_id: Uuid,
        bytes: SensitiveBytes,
    },
    SerialControl {
        connection: ConnectionRef,
        request_id: Uuid,
        line: serial::Line,
        asserted: bool,
    },
    Exec {
        connection: ConnectionRef,
        request_id: Uuid,
        command: Sensitive,
        timeout_ms: u64,
        max_output_bytes: usize,
    },
    TaskGet {
        connection: ConnectionRef,
        task_id: Uuid,
        view: TaskView,
    },
    TaskCancel {
        connection: ConnectionRef,
        task_id: Uuid,
    },
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
    pub fn reconnect_target(&self) -> Option<(ConnectionRef, Uuid, bool)> {
        match self {
            Self::Reconnect {
                connection,
                request_id,
                ..
            } => Some((*connection, *request_id, false)),
            Self::ReconnectStatus {
                connection,
                request_id,
            } => Some((*connection, *request_id, true)),
            _ => None,
        }
    }

    pub fn forget_target(&self) -> Option<(Transport, ConnectionRef, Uuid)> {
        match self {
            Self::Forget {
                transport,
                connection,
                request_id,
            }
            | Self::ForgetStatus {
                transport,
                connection,
                request_id,
            } => Some((*transport, *connection, *request_id)),
            _ => None,
        }
    }

    pub fn disconnect_target(&self) -> Option<(Transport, ConnectionRef, Uuid)> {
        match self {
            Self::Disconnect {
                transport,
                connection,
                request_id,
            }
            | Self::DisconnectStatus {
                transport,
                connection,
                request_id,
            } => Some((*transport, *connection, *request_id)),
            _ => None,
        }
    }

    pub fn serial_target(&self) -> Option<(ConnectionRef, Uuid, bool)> {
        match self {
            Self::SerialWrite {
                connection,
                request_id,
                ..
            }
            | Self::SerialControl {
                connection,
                request_id,
                ..
            } => Some((*connection, *request_id, true)),
            Self::Send {
                transport: Transport::Serial,
                connection,
                request_id,
                ..
            }
            | Self::InputStatus {
                transport: Transport::Serial,
                connection,
                request_id,
            } => Some((*connection, *request_id, false)),
            _ => None,
        }
    }
    pub fn task_target(&self) -> Option<(ConnectionRef, Uuid, bool)> {
        match self {
            Self::Exec {
                connection,
                request_id,
                ..
            } => Some((*connection, *request_id, true)),
            Self::TaskCancel {
                connection,
                task_id,
            } => Some((*connection, *task_id, true)),
            Self::TaskGet {
                connection,
                task_id,
                view,
            } => Some((*connection, *task_id, matches!(view, TaskView::Status {}))),
            _ => None,
        }
    }
    pub fn into_service(
        self,
        protected: bool,
    ) -> Result<Request, session_core::session::ErrorCode> {
        let request = match self {
            Self::Reconnect {
                connection,
                request_id,
                cols,
                rows,
            } => Request::Ssh {
                request: ssh::Request::Reconnect {
                    connection,
                    request_id,
                    cols,
                    rows,
                },
            },
            Self::ReconnectStatus {
                connection,
                request_id,
            } => Request::Ssh {
                request: ssh::Request::ReconnectStatus {
                    connection,
                    request_id,
                },
            },
            Self::Forget {
                transport: Transport::Ssh2,
                connection,
                request_id,
            } => Request::Ssh {
                request: ssh::Request::ForgetStart {
                    connection,
                    request_id,
                },
            },
            Self::Forget {
                transport: Transport::Serial,
                connection,
                request_id,
            } => Request::Serial {
                request: serial::Request::ForgetStart {
                    connection,
                    request_id,
                },
            },
            Self::ForgetStatus {
                transport: Transport::Ssh2,
                connection,
                request_id,
            } => Request::Ssh {
                request: ssh::Request::ForgetStatus {
                    connection,
                    request_id,
                },
            },
            Self::ForgetStatus {
                transport: Transport::Serial,
                connection,
                request_id,
            } => Request::Serial {
                request: serial::Request::ForgetStatus {
                    connection,
                    request_id,
                },
            },
            Self::Disconnect {
                transport: Transport::Ssh2,
                connection,
                request_id,
            } => Request::Ssh {
                request: ssh::Request::Disconnect {
                    connection,
                    request_id,
                },
            },
            Self::Disconnect {
                transport: Transport::Serial,
                connection,
                request_id,
            } => Request::Serial {
                request: serial::Request::Disconnect {
                    connection,
                    request_id,
                },
            },
            Self::DisconnectStatus {
                transport: Transport::Ssh2,
                connection,
                request_id,
            } => Request::Ssh {
                request: ssh::Request::DisconnectStatus {
                    connection,
                    request_id,
                },
            },
            Self::DisconnectStatus {
                transport: Transport::Serial,
                connection,
                request_id,
            } => Request::Serial {
                request: serial::Request::DisconnectStatus {
                    connection,
                    request_id,
                },
            },
            Self::SerialWrite {
                connection,
                request_id,
                bytes,
            } => {
                if bytes.expose().is_empty() || bytes.expose().len() > 16384 {
                    return Err(session_core::session::ErrorCode::InvalidArgument);
                }
                Request::Serial {
                    request: serial::Request::Write {
                        connection,
                        request_id,
                        bytes,
                    },
                }
            }
            Self::SerialControl {
                connection,
                request_id,
                line,
                asserted,
            } => Request::Serial {
                request: serial::Request::Control {
                    connection,
                    request_id,
                    line,
                    asserted,
                },
            },
            Self::Exec {
                connection,
                request_id,
                command,
                timeout_ms,
                max_output_bytes,
            } => {
                if session_core::input::ordered_timestamp(request_id).is_none()
                    || command.expose().is_empty()
                    || command.expose().len() > 16384
                    || !(1..=120000).contains(&timeout_ms)
                    || !(1..=1048576).contains(&max_output_bytes)
                {
                    return Err(session_core::session::ErrorCode::InvalidArgument);
                }
                Request::Ssh {
                    request: ssh::Request::Exec {
                        connection,
                        request_id,
                        command,
                        timeout_ms,
                        max_output_bytes,
                    },
                }
            }
            Self::TaskCancel {
                connection,
                task_id,
            } => Request::Ssh {
                request: ssh::Request::ExecCancel {
                    connection,
                    task_id,
                },
            },
            Self::TaskGet {
                connection,
                task_id,
                view,
            } => Request::Ssh {
                request: match view {
                    TaskView::Status {} => ssh::Request::ExecStatus {
                        connection,
                        task_id,
                    },
                    TaskView::Output {
                        cursor,
                        max_bytes,
                        through_cursor,
                    } => {
                        if cursor == 0
                            || !(16384..=65536).contains(&max_bytes)
                            || (!protected && through_cursor.is_some())
                        {
                            return Err(session_core::session::ErrorCode::InvalidArgument);
                        }
                        if protected {
                            let view = match through_cursor {
                                Some(through_cursor) => session_core::protected_task::View::Text {
                                    through_cursor,
                                    cursor,
                                    max_bytes,
                                },
                                None => session_core::protected_task::View::Info {},
                            };
                            if !view.valid() {
                                return Err(session_core::session::ErrorCode::InvalidArgument);
                            }
                            ssh::Request::ExecReadProtected {
                                connection,
                                task_id,
                                view,
                            }
                        } else {
                            ssh::Request::ExecRead {
                                connection,
                                task_id,
                                cursor,
                                max_bytes,
                            }
                        }
                    }
                },
            },
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
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskView {
    Status {},
    Output {
        #[schemars(range(min = 1))]
        cursor: u64,
        #[schemars(range(min = 16384, max = 65536))]
        max_bytes: usize,
        through_cursor: Option<u64>,
    },
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
    Reconnect(ssh::ReconnectReceipt),
    Forget(session_core::forget::Receipt),
    Disconnect(session_core::disconnect::Receipt),
    SerialOperation {
        connection: ConnectionRef,
        receipt: serial::InputReceipt,
    },
    Task(ssh::TaskStatus),
    TaskOutput {
        connection: ConnectionRef,
        task_id: Uuid,
        output: session_core::task_output::Page,
    },
    TaskProtectedOutput {
        connection: ConnectionRef,
        task_id: Uuid,
        output: Box<session_core::protected_task::Reply>,
    },
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
    pub fn from_reconnect_service(
        response: Response,
        previous: ConnectionRef,
        request_id: Uuid,
        query: bool,
    ) -> std::io::Result<Self> {
        use session_core::session::{Protocol, State};
        let receipt = match response {
            Response::Error { code, .. } => return Ok(Self::Error(code)),
            Response::Ok {
                reply: Reply::Ssh(ssh::Reply::Started { connection }),
                ..
            } if !query => ssh::ReconnectReceipt {
                request_id,
                previous,
                connection,
            },
            Response::Ok {
                reply: Reply::Ssh(ssh::Reply::ReconnectReceipt(receipt)),
                ..
            } if query && receipt.previous == previous && receipt.request_id == request_id => {
                receipt
            }
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unmatched Reconnect response",
                ));
            }
        };
        if receipt.connection.connection_id != previous.connection_id
            || Some(receipt.connection.generation) != previous.generation.checked_add(1)
            || receipt.connection.protocol != Protocol::Ssh2
            || receipt.connection.state != State::Connecting
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid Reconnect creation snapshot",
            ));
        }
        Ok(Self::Reconnect(receipt))
    }

    pub fn from_forget_service(
        response: Response,
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    ) -> std::io::Result<Self> {
        match (transport, response) {
            (_, Response::Error { code, .. }) => Ok(Self::Error(code)),
            (
                Transport::Ssh2,
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::Forget(receipt)),
                    ..
                },
            )
            | (
                Transport::Serial,
                Response::Ok {
                    reply: Reply::Serial(serial::Reply::Forget(receipt)),
                    ..
                },
            ) if receipt.connection == connection && receipt.request_id == request_id => {
                Ok(Self::Forget(receipt))
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unmatched Forget response",
            )),
        }
    }

    pub fn from_disconnect_service(
        response: Response,
        transport: Transport,
        connection: ConnectionRef,
        request_id: Uuid,
    ) -> Self {
        use session_core::session::ErrorCode;
        match (transport, response) {
            (_, Response::Error { code, .. }) => Self::Error(code),
            (
                Transport::Ssh2,
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::Disconnect(receipt)),
                    ..
                },
            )
            | (
                Transport::Serial,
                Response::Ok {
                    reply: Reply::Serial(serial::Reply::Disconnect(receipt)),
                    ..
                },
            ) if receipt.connection == connection && receipt.request_id == request_id => {
                Self::Disconnect(receipt)
            }
            _ => Self::Error(ErrorCode::InvalidState),
        }
    }

    /// `connection` is the native-frozen request binding, not a service-reported field.
    pub fn from_serial_service(
        response: Response,
        connection: ConnectionRef,
        request_id: Uuid,
        envelope: bool,
    ) -> Self {
        match response {
            Response::Error { code, .. } => Self::Error(code),
            Response::Ok {
                reply: Reply::Serial(serial::Reply::Input(receipt)),
                ..
            } if receipt.request_id == request_id => {
                if envelope {
                    Self::SerialOperation {
                        connection,
                        receipt,
                    }
                } else {
                    Self::SerialInput(receipt)
                }
            }
            _ => Self::Error(session_core::session::ErrorCode::InvalidState),
        }
    }
    pub fn from_task_service(
        response: Response,
        connection: ConnectionRef,
        task_id: Uuid,
        protected: bool,
        status_only: bool,
    ) -> Self {
        match response {
            Response::Error { code, .. } => Self::Error(code),
            Response::Ok {
                reply: Reply::Ssh(reply),
                ..
            } => match reply {
                ssh::Reply::Exec(v)
                    if status_only && v.connection == connection && v.task_id == task_id =>
                {
                    Self::Task(v)
                }
                ssh::Reply::ExecOutput {
                    connection: c,
                    task_id: t,
                    output,
                } if !status_only && !protected && c == connection && t == task_id => {
                    Self::TaskOutput {
                        connection: c,
                        task_id: t,
                        output,
                    }
                }
                ssh::Reply::ExecProtectedOutput {
                    connection: c,
                    task_id: t,
                    output,
                } if !status_only && protected && c == connection && t == task_id => {
                    Self::TaskProtectedOutput {
                        connection: c,
                        task_id: t,
                        output,
                    }
                }
                _ => Self::Error(session_core::session::ErrorCode::InvalidState),
            },
            _ => Self::Error(session_core::session::ErrorCode::InvalidState),
        }
    }
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
    fn reconnect_checks_snapshot_and_accepts_only_the_reply_for_each_operation() {
        use session_core::session::{Protocol, State};
        let previous = target();
        let request_id = Uuid::new_v4();
        let connection = ConnectionInfo {
            connection_id: previous.connection_id,
            generation: previous.generation + 1,
            protocol: Protocol::Ssh2,
            state: State::Connecting,
        };
        let receipt = ssh::ReconnectReceipt {
            request_id,
            previous,
            connection: connection.clone(),
        };
        let project = |reply, query| {
            ResultMessage::from_reconnect_service(
                Response::Ok {
                    id: 1,
                    reply: Reply::Ssh(reply),
                },
                previous,
                request_id,
                query,
            )
        };
        for (reply, query) in [
            (
                ssh::Reply::Started {
                    connection: connection.clone(),
                },
                false,
            ),
            (ssh::Reply::ReconnectReceipt(receipt.clone()), true),
        ] {
            assert!(
                matches!(project(reply, query), Ok(ResultMessage::Reconnect(r)) if r == receipt)
            );
        }
        assert!(
            project(
                ssh::Reply::Started {
                    connection: connection.clone()
                },
                true
            )
            .is_err()
        );
        assert!(project(ssh::Reply::ReconnectReceipt(receipt.clone()), false).is_err());
        assert!(
            project(
                ssh::Reply::ReconnectReceipt(ssh::ReconnectReceipt {
                    request_id: Uuid::new_v4(),
                    ..receipt
                }),
                true
            )
            .is_err()
        );
        for changed in [
            ConnectionInfo {
                generation: previous.generation,
                ..connection.clone()
            },
            ConnectionInfo {
                protocol: Protocol::Serial,
                ..connection.clone()
            },
            ConnectionInfo {
                state: State::Connected,
                ..connection
            },
        ] {
            assert!(
                project(
                    ssh::Reply::Started {
                        connection: changed
                    },
                    false
                )
                .is_err()
            );
        }
    }

    #[test]
    fn forget_preserves_known_rejection_and_treats_mismatched_receipts_as_unknown() {
        use session_core::{forget, session::ErrorCode};
        let connection = target();
        let id = Uuid::new_v4();
        let receipt = forget::Receipt {
            request_id: id,
            connection,
            state: forget::State::Removed,
        };
        let project = |reply, transport, connection, request_id| {
            ResultMessage::from_forget_service(
                Response::Ok { id: 1, reply },
                transport,
                connection,
                request_id,
            )
        };
        for (transport, reply) in [
            (
                Transport::Ssh2,
                Reply::Ssh(ssh::Reply::Forget(receipt.clone())),
            ),
            (
                Transport::Serial,
                Reply::Serial(serial::Reply::Forget(receipt.clone())),
            ),
        ] {
            assert!(
                matches!(project(reply, transport, connection, id), Ok(ResultMessage::Forget(v)) if v == receipt)
            );
        }
        assert!(matches!(
            ResultMessage::from_forget_service(
                Response::Error {
                    id: 1,
                    code: ErrorCode::InvalidState
                },
                Transport::Ssh2,
                connection,
                id,
            ),
            Ok(ResultMessage::Error(ErrorCode::InvalidState))
        ));
        let wrong_generation = ConnectionRef {
            generation: connection.generation + 1,
            ..connection
        };
        for (transport, expected_connection, expected_id) in [
            (Transport::Serial, connection, id),
            (Transport::Ssh2, wrong_generation, id),
            (Transport::Ssh2, connection, Uuid::new_v4()),
        ] {
            let reply = Reply::Ssh(ssh::Reply::Forget(receipt.clone()));
            assert!(project(reply, transport, expected_connection, expected_id).is_err());
        }
        assert!(
            project(
                Reply::Ssh(ssh::Reply::Disconnect(session_core::disconnect::Receipt {
                    request_id: id,
                    connection,
                    state: session_core::disconnect::State::TransportEnded,
                })),
                Transport::Ssh2,
                connection,
                id,
            )
            .is_err()
        );
    }

    #[test]
    fn disconnect_projection_requires_exact_service_receipt() {
        use session_core::{disconnect, session::ErrorCode};
        let connection = target();
        let id = Uuid::new_v4();
        let receipt = disconnect::Receipt {
            request_id: id,
            connection,
            state: disconnect::State::Requested,
        };
        let response = |reply| Response::Ok { id: 1, reply };
        for (transport, reply) in [
            (
                Transport::Ssh2,
                Reply::Ssh(ssh::Reply::Disconnect(receipt.clone())),
            ),
            (
                Transport::Serial,
                Reply::Serial(serial::Reply::Disconnect(receipt.clone())),
            ),
        ] {
            assert!(matches!(
                ResultMessage::from_disconnect_service(response(reply), transport, connection, id),
                ResultMessage::Disconnect(v) if v == receipt
            ));
        }
        let wrong_generation = ConnectionRef {
            generation: connection.generation + 1,
            ..connection
        };
        for (transport, expected_connection, expected_id) in [
            (Transport::Serial, connection, id),
            (Transport::Ssh2, wrong_generation, id),
            (Transport::Ssh2, connection, Uuid::new_v4()),
        ] {
            let reply = Reply::Ssh(ssh::Reply::Disconnect(receipt.clone()));
            assert!(matches!(
                ResultMessage::from_disconnect_service(
                    response(reply),
                    transport,
                    expected_connection,
                    expected_id
                ),
                ResultMessage::Error(ErrorCode::InvalidState)
            ));
        }
    }

    #[test]
    fn serial_bytes_controls_and_request_bound_projection_are_strict() {
        let c = target();
        let id = Uuid::new_v4();
        let write = |bytes| Operation::SerialWrite {
            connection: c,
            request_id: id,
            bytes: SensitiveBytes::new(bytes),
        };
        assert!(
            matches!(write(vec![0,255,3,13,10]).into_service(false),Ok(Request::Serial {request:serial::Request::Write {bytes,..}}) if bytes.expose()==[0,255,3,13,10])
        );
        assert!(write(vec![]).into_service(false).is_err());
        assert!(write(vec![0; 16385]).into_service(false).is_err());
        for bytes in [
            serde_json::json!([-1]),
            serde_json::json!([256]),
            serde_json::json!([1.5]),
            serde_json::json!("00ff"),
        ] {
            assert!(serde_json::from_value::<Operation>(serde_json::json!({"op":"serial_write","connection":c,"request_id":id,"bytes":bytes})).is_err());
        }
        for line in ["DTR", "RTS", "BREAK"] {
            let v = serde_json::json!({"op":"serial_control","connection":c,"request_id":id,"line":line,"asserted":false});
            let op = serde_json::from_value::<Operation>(v.clone()).unwrap();
            assert_eq!(op.serial_target(), Some((c, id, true)));
            assert!(matches!(
                op.into_service(true),
                Ok(Request::Serial {
                    request: serial::Request::Control {
                        asserted: false,
                        ..
                    }
                })
            ));
            for extra in [
                serde_json::json!({"line":"PULSE"}),
                serde_json::json!({"asserted":1}),
                serde_json::json!({"duration_ms":100}),
            ] {
                let mut bad = v.clone();
                for (k, val) in extra.as_object().unwrap() {
                    bad[k] = val.clone();
                }
                assert!(serde_json::from_value::<Operation>(bad).is_err());
            }
        }
        let response = |request_id| Response::Ok {
            id: 1,
            reply: Reply::Serial(serial::Reply::Input(serial::InputReceipt {
                request_id,
                state: serial::InputState::ControlApplied,
                driver_accepted: None,
                failure: None,
            })),
        };
        assert!(
            matches!(ResultMessage::from_serial_service(response(id),c,id,true),ResultMessage::SerialOperation {connection,..} if connection==c)
        );
        assert!(matches!(
            ResultMessage::from_serial_service(response(id), c, id, false),
            ResultMessage::SerialInput(_)
        ));
        assert!(matches!(
            ResultMessage::from_serial_service(response(Uuid::new_v4()), c, id, true),
            ResultMessage::Error(_)
        ));
        assert!(matches!(
            ResultMessage::from_serial_service(
                Response::Ok {
                    id: 1,
                    reply: Reply::Ok
                },
                c,
                id,
                true
            ),
            ResultMessage::Error(_)
        ));
        assert!(serde_json::from_value::<serial::InputReceipt>(serde_json::json!({"request_id":id,"state":"CONTROL_APPLIED","driver_accepted":null,"failure":null,"connection":c})).is_err());
        let status = Operation::InputStatus {
            transport: Transport::Serial,
            connection: c,
            request_id: id,
        };
        assert_eq!(status.serial_target(), Some((c, id, false)));
        let swapped = Operation::InputStatus {
            transport: Transport::Serial,
            connection: ConnectionRef { generation: 2, ..c },
            request_id: id,
        };
        assert_ne!(swapped.serial_target(), status.serial_target());
    }
    fn target() -> ConnectionRef {
        ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        }
    }
    fn v7() -> Uuid {
        Uuid::parse_str("019a5c00-0001-7000-8000-000000000001").unwrap()
    }
    fn exec(id: Uuid) -> Operation {
        Operation::Exec {
            connection: target(),
            request_id: id,
            command: Sensitive::new("synthetic".into()),
            timeout_ms: 1000,
            max_output_bytes: 65536,
        }
    }
    #[test]
    fn exec_requires_service_v7_and_bounded_exact_parameters_before_dispatch() {
        assert!(
            matches!(exec(v7()).into_service(false),Ok(Request::Ssh {request:ssh::Request::Exec {request_id,..}}) if request_id==v7())
        );
        for id in [
            Uuid::new_v4(),
            Uuid::nil(),
            Uuid::parse_str("019a5c00-0001-7000-c000-000000000001").unwrap(),
        ] {
            assert!(exec(id).into_service(false).is_err());
        }
        let value = serde_json::to_value(exec(v7())).unwrap();
        for (key, bad) in [
            ("timeout_ms", serde_json::json!(0)),
            ("timeout_ms", serde_json::json!(120001)),
            ("max_output_bytes", serde_json::json!(1048577)),
            ("command", serde_json::json!("x".repeat(16385))),
        ] {
            let mut v = value.clone();
            v[key] = bad;
            assert!(
                serde_json::from_value::<Operation>(v)
                    .unwrap()
                    .into_service(false)
                    .is_err()
            );
        }
        let mut unknown = value.clone();
        unknown["path"] = serde_json::json!("synthetic-file");
        assert!(serde_json::from_value::<Operation>(unknown).is_err());
        let mut fractional = value;
        fractional["timeout_ms"] = serde_json::json!(1.5);
        assert!(serde_json::from_value::<Operation>(fractional).is_err());
    }
    #[test]
    fn task_output_enforces_protected_route_watermark_and_typed_reply_identity() {
        let c = target();
        let id = v7();
        let read = |through_cursor| Operation::TaskGet {
            connection: c,
            task_id: id,
            view: TaskView::Output {
                cursor: 1,
                max_bytes: 65536,
                through_cursor,
            },
        };
        assert!(matches!(
            read(None).into_service(true),
            Ok(Request::Ssh {
                request: ssh::Request::ExecReadProtected {
                    view: session_core::protected_task::View::Info {},
                    ..
                }
            })
        ));
        assert!(matches!(
            read(Some(3)).into_service(true),
            Ok(Request::Ssh {
                request: ssh::Request::ExecReadProtected {
                    view: session_core::protected_task::View::Text {
                        through_cursor: 3,
                        ..
                    },
                    ..
                }
            })
        ));
        assert!(read(Some(0)).into_service(true).is_err());
        assert!(read(Some(3)).into_service(false).is_err());
        assert!(matches!(
            read(None).into_service(false),
            Ok(Request::Ssh {
                request: ssh::Request::ExecRead { .. }
            })
        ));
        let response = || Response::Ok {
            id: 1,
            reply: Reply::Ssh(ssh::Reply::ExecOutput {
                connection: c,
                task_id: id,
                output: session_core::task_output::Page {
                    events: vec![],
                    next_cursor: 1,
                    available_from: 1,
                    truncated: false,
                    completed: false,
                },
            }),
        };
        assert!(matches!(
            ResultMessage::from_task_service(response(), c, id, false, false),
            ResultMessage::TaskOutput { .. }
        ));
        assert!(matches!(
            ResultMessage::from_task_service(response(), c, id, true, false),
            ResultMessage::Error(_)
        ));
        assert!(matches!(
            ResultMessage::from_task_service(response(), target(), id, false, false),
            ResultMessage::Error(_)
        ));
        assert!(matches!(
            ResultMessage::from_task_service(response(), c, Uuid::new_v4(), false, false),
            ResultMessage::Error(_)
        ));
        assert!(matches!(
            ResultMessage::from_task_service(response(), c, id, false, true),
            ResultMessage::Error(_)
        ));
        let status = |task_id| Response::Ok {
            id: 1,
            reply: Reply::Ssh(ssh::Reply::Exec(ssh::TaskStatus {
                task_id,
                connection: c,
                phase: ssh::TaskPhase::Queued,
                encoding: config_model::Encoding::Utf8,
                summary: None,
            })),
        };
        assert!(matches!(
            ResultMessage::from_task_service(status(id), c, id, false, true),
            ResultMessage::Task(_)
        ));
        assert!(matches!(
            ResultMessage::from_task_service(status(Uuid::new_v4()), c, id, false, true),
            ResultMessage::Error(_)
        ));
    }
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
