//! Explicitly selected four-type shortcut management.
use super::{Move, Scope, Sensitive, Uuid};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Version {
    V2,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct List {
    pub version: Version,
    #[schemars(length(max = 256))]
    pub query: Option<Sensitive>,
    pub receipt_request_id: Option<Uuid>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Adb {
        #[schemars(length(min = 1, max = 8192))]
        command: Sensitive,
    },
    Script {
        #[schemars(length(min = 1, max = 2048))]
        path: Sensitive,
    },
    Local {
        #[schemars(length(min = 1, max = 8192))]
        command: Sensitive,
    },
    Send {
        #[schemars(length(min = 1, max = 8192))]
        text: Sensitive,
    },
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateItem {
    #[schemars(length(max = 64))]
    pub name: Option<Sensitive>,
    pub target: Target,
    #[serde(default)]
    pub pinned: bool,
    pub close_on_success: Option<bool>,
    pub append_enter: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub version: Version,
    pub request_id: Uuid,
    pub revision: Uuid,
    #[schemars(length(min = 1, max = 32))]
    pub items: Vec<CreateItem>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub id: Uuid,
    #[schemars(length(max = 64))]
    pub name: Option<Sensitive>,
    pub target: Option<Target>,
    pub pinned: Option<bool>,
    pub close_on_success: Option<bool>,
    pub append_enter: Option<bool>,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    First,
    Last,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MoveToEdge {
    #[schemars(length(min = 1, max = 32))]
    pub ids: Vec<Uuid>,
    pub edge: Edge,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MoveBlock {
    Anchor(Move),
    Edge(MoveToEdge),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub version: Version,
    pub request_id: Uuid,
    pub revision: Uuid,
    #[serde(default)]
    #[schemars(length(max = 32))]
    pub changes: Vec<Change>,
    #[serde(default)]
    #[schemars(length(max = 32))]
    pub moves: Vec<MoveBlock>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Remove {
    pub version: Version,
    pub request_id: Uuid,
    pub revision: Uuid,
    #[schemars(length(min = 1, max = 32))]
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "args",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Request {
    List(List),
    Create(Create),
    Update(Update),
    Remove(Remove),
}

impl Request {
    pub fn scope(&self) -> Scope {
        match self {
            Self::List(args) if args.receipt_request_id.is_none() => Scope::ExtendedView,
            _ => Scope::ExtendedManage,
        }
    }

    pub fn write_key(&self) -> Option<(Uuid, Uuid)> {
        match self {
            Self::Create(args) => Some((args.request_id, args.revision)),
            Self::Update(args) => Some((args.request_id, args.revision)),
            Self::Remove(args) => Some((args.request_id, args.revision)),
            Self::List(_) => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: Uuid,
    pub name: Sensitive,
    pub target: Target,
    pub pinned: bool,
    pub order: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_on_success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_enter: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub version: Version,
    pub revision: Uuid,
    pub items: Vec<Item>,
}
