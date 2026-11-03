//! Length-prefixed, strictly typed, local session IPC v1.
pub mod config;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use session_core::{PROTOCOL_VERSION, session::*};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_FRAME: usize = 512 * 1024;

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
    Config {
        request: config::ConfigRequest,
    },
    Ping {},
    List {},
    Read {
        connection: ConnectionRef,
        cursor: u64,
        max_bytes: usize,
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
    Config(config::ConfigReply),
    Welcome(Welcome),
    Pong {
        service_id: Uuid,
        uptime_ms: u64,
    },
    Sessions(Vec<ConnectionInfo>),
    Connection(ConnectionInfo),
    Output(OutputPage),
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
    use super::*;
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
