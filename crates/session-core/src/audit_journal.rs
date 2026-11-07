//! Durable audit metadata. Never a source of authorization or business receipts.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_PAGE: usize = 128;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "event",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Payload {
    Rpc(crate::rpc_audit::Event),
    Policy(crate::access::AuditEvent),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub seq: u64,
    pub service_id: Uuid,
    pub payload: Payload,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    Disabled,
    Healthy,
    QueueFull,
    StorageFailure,
    Closed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub state: State,
    /// Last queue acceptance, NOT a durability acknowledgement.
    pub accepted_through: u64,
    /// Only advances after the writer's sync_all succeeds.
    pub synced_through: u64,
    pub rejected_records: u64,
    /// Historical malformed/incomplete segment tails; their valid prefixes survive.
    pub incomplete_segments: u32,
    pub available_from: u64,
    pub retained_records: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub records: Vec<Record>,
    pub next_cursor: u64,
    pub through_cursor: u64,
    pub available_from: u64,
    pub gap: bool,
}
