//! Fixed input for the protected export of retained output from an ended generation.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::{
    input::ordered_timestamp,
    session::{EndedOutput, Protocol},
};
use uuid::Uuid;

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
