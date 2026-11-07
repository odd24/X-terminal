//! Length-prefixed, strictly typed, local session IPC v1.
pub mod agent;
pub mod config;
pub mod logging;
pub mod operation;
pub mod serial;
pub mod ssh;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use session_core::{PROTOCOL_VERSION, session::*};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_FRAME: usize = 512 * 1024;

#[derive(JsonSchema)]
pub struct SensitiveBytes(#[schemars(with = "Vec<u8>")] Zeroizing<Vec<u8>>);
impl SensitiveBytes {
    pub fn new(value: Vec<u8>) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}
impl std::fmt::Debug for SensitiveBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}
impl Serialize for SensitiveBytes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.expose().serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for SensitiveBytes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<u8>::deserialize(deserializer).map(Self::new)
    }
}

#[derive(JsonSchema)]
pub struct Sensitive(#[schemars(with = "String")] Zeroizing<String>);
impl Sensitive {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for Sensitive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}
impl Serialize for Sensitive {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.expose())
    }
}
impl<'de> Deserialize<'de> for Sensitive {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::new)
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub protocol_version: u32,
    pub client_name: String,
    pub token: Sensitive,
}
impl Hello {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ErrorCode::VersionMismatch);
        }
        if self.client_name.is_empty()
            || self.client_name.len() > 64
            || self.client_name.chars().any(char::is_control)
        {
            return Err(ErrorCode::InvalidArgument);
        }
        if self.token.expose().len() != 64
            || !self.token.expose().bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(ErrorCode::PermissionDenied);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    Desktop,
    Observer,
    Agent,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Welcome {
    pub protocol_version: u32,
    pub service_id: Uuid,
    pub client_id: Uuid,
    pub kind: ClientKind,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub id: u32,
    pub request: Request,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Agent {
        request: agent::Request,
    },
    Logging {
        request: logging::Request,
    },
    Serial {
        request: serial::Request,
    },
    Ssh {
        request: ssh::Request,
    },
    Config {
        request: config::ConfigRequest,
    },
    Ping {},
    List {},
    ProtectedContext {
        connection: ConnectionRef,
        window: Option<session_core::context::TimeWindow>,
        view: session_core::protected_context::View,
    },
    Context {
        connection: ConnectionRef,
        window: session_core::context::TimeWindow,
        view: session_core::context::View,
    },
    Read {
        connection: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
    },
    ReadText {
        connection: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
    },
    Screen {
        connection: ConnectionRef,
    },
    IssueRead {
        scopes: Vec<ConnectionRef>,
        lifetime_ms: u64,
    },
    Revoke {
        ticket_id: Uuid,
    },
    CreateFixture {},
    AppendFixture {
        connection: ConnectionRef,
        bytes: Vec<u8>,
    },
    ReconnectFixture {
        connection: ConnectionRef,
    },
    CloseFixture {
        connection: ConnectionRef,
    },
    RemoveFixture {
        connection: ConnectionRef,
    },
    Shutdown {},
}
impl Request {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        match self {
            Self::ProtectedContext {
                connection,
                window,
                view,
            } => {
                if connection.connection_id.0.is_nil()
                    || connection.generation == 0
                    || window.is_some_and(|w| !w.valid())
                    || !view.valid()
                {
                    return Err(ErrorCode::InvalidArgument);
                }
            }
            Self::Context {
                connection,
                window,
                view,
            } => {
                if connection.connection_id.0.is_nil()
                    || connection.generation == 0
                    || !window.valid()
                    || !view.valid()
                {
                    return Err(ErrorCode::InvalidArgument);
                }
            }
            Self::Agent { request } if !request.validate() => {
                return Err(ErrorCode::InvalidArgument);
            }
            Self::Logging { request } if !request.validate() => {
                return Err(ErrorCode::InvalidArgument);
            }
            Self::Serial { request } if !request.validate() => {
                return Err(ErrorCode::InvalidArgument);
            }
            Self::Ssh { request } if !request.validate() => return Err(ErrorCode::InvalidArgument),
            Self::Config { request } if !request.validate() => {
                return Err(ErrorCode::InvalidArgument);
            }
            Self::Read {
                connection,
                cursor,
                max_bytes,
            } => {
                if connection.generation == 0
                    || *cursor == 0
                    || !(EVENT_BYTES..=MAX_APPEND).contains(max_bytes)
                {
                    return Err(ErrorCode::InvalidArgument);
                }
            }
            Self::IssueRead {
                scopes,
                lifetime_ms,
            } => {
                if scopes.is_empty()
                    || scopes.len() > 64
                    || *lifetime_ms == 0
                    || *lifetime_ms > 30 * 60 * 1000
                    || scopes.iter().any(|scope| scope.generation == 0)
                {
                    return Err(ErrorCode::InvalidArgument);
                }
            }
            Self::ReadText {
                connection,
                cursor,
                max_bytes,
            } => {
                if connection.generation == 0
                    || *cursor == 0
                    || !(session_core::presentation::MIN_TEXT_PAGE..=MAX_APPEND).contains(max_bytes)
                {
                    return Err(ErrorCode::InvalidArgument);
                }
            }
            Self::Screen { connection } if connection.generation == 0 => {
                return Err(ErrorCode::InvalidArgument);
            }
            Self::AppendFixture { connection, bytes } => {
                if connection.generation == 0 || bytes.len() > MAX_APPEND {
                    return Err(ErrorCode::InvalidArgument);
                }
            }
            Self::ReconnectFixture { connection }
            | Self::CloseFixture { connection }
            | Self::RemoveFixture { connection }
                if connection.generation == 0 =>
            {
                return Err(ErrorCode::InvalidArgument);
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Reply {
    Agent(agent::Reply),
    Logging(logging::Reply),
    Serial(serial::Reply),
    Ssh(ssh::Reply),
    Config(config::ConfigReply),
    Welcome(Welcome),
    Pong {
        service_id: Uuid,
        uptime_ms: u64,
    },
    Sessions(Vec<ConnectionInfo>),
    Connection(ConnectionInfo),
    Output(OutputPage),
    Context(session_core::context::Reply),
    ProtectedContext(session_core::protected_context::Reply),
    Text(session_core::presentation::TextPage),
    Screen(session_core::presentation::ScreenSnapshot),
    ReadTicket {
        ticket_id: Uuid,
        token: Sensitive,
        expires_at_ms: u64,
    },
    Ok,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Ok { id: u32, reply: Reply },
    Error { id: u32, code: ErrorCode },
}

pub async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(
    reader: &mut R,
) -> io::Result<Option<T>> {
    let mut header = [0; 4];
    if reader.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..]).await?;
    let size = u32::from_le_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "IPC frame exceeds limit",
        ));
    }
    let mut payload = Zeroizing::new(vec![0; size]);
    reader.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid IPC JSON"))
}

pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid IPC value"))?;
    let payload = Zeroizing::new(payload);
    if payload.is_empty() || payload.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "IPC frame exceeds limit",
        ));
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    #[test]
    fn context_requires_exact_window_watermark_bounds_and_rejects_caller_decoding_or_owner() {
        use super::*;
        let c = ConnectionRef {
            connection_id: session_core::session::ConnectionId(uuid::Uuid::new_v4()),
            generation: 1,
        };
        for view in [
            serde_json::json!({"kind":"info"}),
            serde_json::json!({"kind":"raw","through_cursor":4,"cursor":1,"max_bytes":4096}),
            serde_json::json!({"kind":"text","through_cursor":4,"cursor":1,"max_bytes":16384}),
            serde_json::json!({"kind":"screen","through_cursor":4}),
        ] {
            let value = serde_json::json!({"op":"context","connection":c,"window":{"from_ms":10,"until_ms":20},"view":view});
            assert!(
                serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
                    .is_ok()
            );
            for field in ["encoding", "owner", "token"] {
                let mut altered = value.clone();
                altered[field] = "untrusted".into();
                assert!(serde_json::from_value::<Request>(altered).is_err());
            }
            let mut bad = value;
            bad["window"]["until_ms"] = 10.into();
            assert!(
                serde_json::from_value::<Request>(bad)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        for view in [
            serde_json::json!({"kind":"screen"}),
            serde_json::json!({"kind":"screen","through_cursor":0}),
            serde_json::json!({"kind":"text","through_cursor":1,"cursor":2,"max_bytes":16384}),
        ] {
            let value = serde_json::json!({"op":"context","connection":c,"window":{"from_ms":10,"until_ms":20},"view":view});
            assert!(match serde_json::from_value::<Request>(value) {
                Err(_) => true,
                Ok(r) => r.validate().is_err(),
            });
        }
    }
    use super::*;
    #[tokio::test]
    async fn derived_requests_are_strict_bounded_and_worst_text_frame_fits() {
        let mut sessions = Sessions::default();
        let initial = sessions.create(Protocol::Serial).unwrap();
        let connection = sessions
            .begin_connect(initial.reference())
            .unwrap()
            .reference();
        sessions.transition(connection, State::Connected).unwrap();
        for op in ["read_text", "screen"] {
            let mut value = serde_json::json!({"op":op,"connection":connection});
            if op == "read_text" {
                value["cursor"] = 1.into();
                value["max_bytes"] = 16384.into();
            }
            let request: Request = serde_json::from_value(value.clone()).unwrap();
            assert!(request.validate().is_ok());
            value["encoding"] = "gbk".into();
            assert!(
                serde_json::from_value::<Request>(value).is_err(),
                "reader cannot change decoding"
            );
        }
        assert!(
            Request::ReadText {
                connection,
                cursor: 1,
                max_bytes: 4096
            }
            .validate()
            .is_err()
        );
        assert!(
            Request::Screen {
                connection: ConnectionRef {
                    generation: 0,
                    ..connection
                }
            }
            .validate()
            .is_err()
        );
        sessions.append(connection, &[0; MAX_APPEND], 1).unwrap();
        let page = sessions.read_text(connection, 1, MAX_APPEND).unwrap();
        let reply = Response::Ok {
            id: 1,
            reply: Reply::Text(page),
        };
        assert!(serde_json::to_vec(&reply).unwrap().len() < MAX_FRAME);
        write_frame(&mut tokio::io::sink(), &reply).await.unwrap();
        let reply = Response::Ok {
            id: 2,
            reply: Reply::Screen(sessions.screen(connection).unwrap()),
        };
        write_frame(&mut tokio::io::sink(), &reply).await.unwrap();
    }
    #[test]
    fn strict_contract_rejects_self_assigned_role_unknown_fields_and_bad_uuid() {
        assert!(serde_json::from_value::<Hello>(serde_json::json!({"protocol_version":1,"client_name":"x","token":"a".repeat(64),"role":"desktop"})).is_err());
        assert!(
            serde_json::from_value::<RequestEnvelope>(
                serde_json::json!({"id":1,"request":{"op":"ping","secret":"unexpected"}})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<Request>(serde_json::json!({"op":"read","connection":{"connection_id":"not-a-uuid","generation":1},"cursor":1,"max_bytes":4096})).is_err());
        let mut hello = Hello {
            protocol_version: 2,
            client_name: "x".into(),
            token: Sensitive::new("a".repeat(64)),
        };
        assert_eq!(hello.validate(), Err(ErrorCode::VersionMismatch));
        hello.protocol_version = 1;
        assert!(hello.validate().is_ok());
        assert!(!format!("{hello:?}").contains(&"a".repeat(64)));
        hello.client_name = "bad\nname".into();
        assert_eq!(hello.validate(), Err(ErrorCode::InvalidArgument));
    }
    #[tokio::test]
    async fn frame_round_trip_and_eof_are_distinct_from_partial_frames() {
        let (mut writer, mut reader) = tokio::io::duplex(1024);
        let value = RequestEnvelope {
            id: 7,
            request: Request::Ping {},
        };
        write_frame(&mut writer, &value).await.unwrap();
        writer.shutdown().await.unwrap();
        let actual: RequestEnvelope = read_frame(&mut reader).await.unwrap().unwrap();
        assert_eq!(actual.id, 7);
        assert!(matches!(actual.request, Request::Ping {}));
        assert!(
            read_frame::<_, RequestEnvelope>(&mut reader)
                .await
                .unwrap()
                .is_none()
        );
        let mut partial = &b"\x20\x00"[..];
        assert_eq!(
            read_frame::<_, RequestEnvelope>(&mut partial)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[tokio::test]
    async fn oversized_prefix_fails_without_waiting_for_or_allocating_payload() {
        let header = ((MAX_FRAME + 1) as u32).to_le_bytes();
        let mut reader = &header[..];
        assert_eq!(
            read_frame::<_, RequestEnvelope>(&mut reader)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let mut empty = &b"\0\0\0\0"[..];
        assert_eq!(
            read_frame::<_, RequestEnvelope>(&mut empty)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let mut incomplete_body = &b"\x05\x00\x00\x00{}"[..];
        assert_eq!(
            read_frame::<_, RequestEnvelope>(&mut incomplete_body)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            write_frame(&mut tokio::io::sink(), &"x".repeat(MAX_FRAME))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
