use thiserror::Error;
#[derive(Debug, Error)]
#[error("invalid configuration: {0}")]
pub struct ValidationError(pub &'static str);
type Result<T> = std::result::Result<T, ValidationError>;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    Utf8,
    Gbk,
    Gb18030,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Auth {
    Password,
    PublicKey,
    KeyboardInteractive,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Parity {
    None,
    Odd,
    Even,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Flow {
    None,
    Software,
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "protocol", rename_all = "snake_case", deny_unknown_fields)]
pub enum Settings {
    Ssh2 {
        host: String,
        port: u16,
        username: String,
        auth: Auth,
        encoding: Encoding,
    },
    Ssh1 {
        host: String,
        port: u16,
        username: String,
        explicitly_enabled: bool,
        encoding: Encoding,
    },
    Serial {
        port: String,
        baud_rate: u32,
        data_bits: u8,
        stop_bits: u8,
        parity: Parity,
        flow: Flow,
        dtr_on_open: bool,
        rts_on_open: Option<bool>,
        encoding: Encoding,
    },
}

pub fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Ssh2 {
                host,
                port,
                username,
                ..
            }
            | Self::Ssh1 {
                host,
                port,
                username,
                ..
            } => {
                if !valid_text(host, 253)
                    || host.chars().any(char::is_whitespace)
                    || *port == 0
                    || !valid_text(username, 128)
                {
                    return Err(ValidationError("SSH endpoint"));
                }
                if matches!(
                    self,
                    Self::Ssh1 {
                        explicitly_enabled: false,
                        ..
                    }
                ) {
                    return Err(ValidationError("SSH1 requires explicit enable"));
                }
            }
            Self::Serial {
                port,
                baud_rate,
                data_bits,
                stop_bits,
                flow,
                rts_on_open,
                ..
            } => {
                let number = port.strip_prefix("COM").and_then(|v| v.parse::<u16>().ok());
                if !matches!(number, Some(1..))
                    || !port[3..].bytes().all(|b| b.is_ascii_digit())
                    || *baud_rate == 0
                    || !(5..=8).contains(data_bits)
                    || ![1, 2].contains(stop_bits)
                    || (*flow == Flow::Hardware) != rts_on_open.is_none()
                {
                    return Err(ValidationError("serial settings"));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Folder {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: Uuid,
    pub folder_id: Option<Uuid>,
    pub name: String,
    pub credential_ref: Option<Uuid>,
    pub settings: Settings,
}
impl Profile {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_nil()
            || !valid_text(&self.name, 256)
            || self.credential_ref.is_some_and(|id| id.is_nil())
        {
            return Err(ValidationError("profile identity/name"));
        }
        if matches!(self.settings, Settings::Serial { .. }) && self.credential_ref.is_some() {
            return Err(ValidationError("serial credential reference"));
        }
        self.settings.validate()
    }
}

/// Portable export intentionally has no credential_ref field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortableProfile {
    pub id: Uuid,
    pub folder_id: Option<Uuid>,
    pub name: String,
    pub settings: Settings,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub format_version: u32,
    pub folders: Vec<Folder>,
    pub profiles: Vec<PortableProfile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostProtocol {
    Ssh1,
    Ssh2,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HostEndpoint {
    pub protocol: HostProtocol,
    pub host: String,
    pub port: u16,
}
impl HostEndpoint {
    pub fn canonical(&self) -> Result<Self> {
        if !valid_text(&self.host, 253)
            || self.host.chars().any(char::is_whitespace)
            || self.port == 0
        {
            return Err(ValidationError("host endpoint"));
        }
        Ok(Self {
            protocol: self.protocol,
            host: self.host.to_ascii_lowercase(),
            port: self.port,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HostKey {
    pub endpoint: HostEndpoint,
    pub algorithm: String,
    pub key: Vec<u8>,
}
impl HostKey {
    pub fn validate(&self) -> Result<()> {
        self.endpoint.canonical()?;
        if self.algorithm.is_empty()
            || self.algorithm.len() > 128
            || !self
                .algorithm
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.@+".contains(&b))
            || self.key.is_empty()
            || self.key.len() > 16384
        {
            return Err(ValidationError("host key"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HostKeySummary {
    pub endpoint: HostEndpoint,
    pub algorithm: String,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyStatus {
    Unknown,
    Known,
    Changed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HostKeyReview {
    pub candidate: HostKeySummary,
    pub known: Vec<HostKeySummary>,
    pub status: HostKeyStatus,
    pub revision: String,
}
