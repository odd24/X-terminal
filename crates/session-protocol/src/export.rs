//! Fixed input for the protected export of retained output from an ended generation.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::{
    input::ordered_timestamp,
    session::{ConnectionRef, EndedOutput, Protocol},
};
use uuid::Uuid;

pub const MANAGED_DIRECTORY: &str = "protected-output-exports";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    ProtectedUtf8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Start {
    pub service_id: Uuid,
    pub request_id: Uuid,
    pub retained_ended_output: EndedOutput,
    pub format: Format,
}
impl Start {
    pub fn validate(&self) -> bool {
        let source = &self.retained_ended_output;
        !self.service_id.is_nil()
            && ordered_timestamp(self.request_id).is_some()
            && matches!(source.protocol, Protocol::Ssh2 | Protocol::Serial)
            && !source.connection.connection_id.0.is_nil()
            && source.connection.generation > 0
            && source.from_cursor > 0
            && source.from_cursor < source.through_cursor
            && source.through_cursor - source.from_cursor <= 128
            && !source.encoding.is_empty()
            && source.encoding.len() <= 64
            && source.rows > 0
            && source.cols > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub connection: ConnectionRef,
    pub request_id: Uuid,
}
impl Query {
    pub fn validate(self) -> bool {
        crate::agent::valid_connection(self.connection)
            && ordered_timestamp(self.request_id).is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactScope {
    pub service_id: Uuid,
    pub query: Query,
    pub artifact_id: Uuid,
}
impl ArtifactScope {
    pub fn validate(self) -> bool {
        !self.service_id.is_nil() && !self.artifact_id.is_nil() && self.query.validate()
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Prepare { connection: ConnectionRef },
    Start { target: Start },
    Status { query: Query },
    Cancel { query: Query },
    InspectSave { scope: ArtifactScope },
    CommitSave { scope: ArtifactScope, save_id: Uuid },
}
impl Request {
    pub fn validate(&self) -> bool {
        match self {
            Self::Prepare { connection } => crate::agent::valid_connection(*connection),
            Self::Start { target } => target.validate(),
            Self::Status { query } | Self::Cancel { query } => query.validate(),
            Self::InspectSave { scope } => scope.validate(),
            Self::CommitSave { scope, save_id } => scope.validate() && !save_id.is_nil(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "phase",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum Phase {
    Preparing,
    Completed {
        artifact_id: Uuid,
    },
    Failed {
        code: session_core::session::ErrorCode,
    },
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub query: Query,
    pub state: Phase,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Prepared {
        service_id: Uuid,
        source: EndedOutput,
    },
    Receipt(Receipt),
    SaveSource {
        scope: ArtifactScope,
        bytes: u64,
        sha256: [u8; 32],
    },
    SaveCommitted {
        scope: ArtifactScope,
        save_id: Uuid,
    },
}
