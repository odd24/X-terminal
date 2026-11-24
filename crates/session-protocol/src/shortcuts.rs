//! Desktop-owned shortcut metadata. These types do not describe executable actions.
use crate::{Sensitive, Uuid};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub mod v2;
pub mod v3;

pub const MAX_ITEMS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    View,
    Manage,
    ExtendedView,
    ExtendedManage,
    DescriptionView,
    DescriptionManage,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Compatible<Legacy, Extended, Described> {
    Legacy(Legacy),
    Extended(Extended),
    Described(Described),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct List {
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
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateItem {
    #[schemars(length(min = 1, max = 64))]
    pub name: Sensitive,
    pub target: Target,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub request_id: Uuid,
    pub revision: Uuid,
    #[schemars(length(min = 1, max = 32))]
    pub items: Vec<CreateItem>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub id: Uuid,
    #[schemars(length(min = 1, max = 64))]
    pub name: Option<Sensitive>,
    pub target: Option<Target>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Before,
    After,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Move {
    #[schemars(length(min = 1, max = 32))]
    pub ids: Vec<Uuid>,
    pub anchor: Uuid,
    pub side: Side,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub request_id: Uuid,
    pub revision: Uuid,
    #[serde(default)]
    #[schemars(length(max = 32))]
    pub changes: Vec<Change>,
    #[serde(default)]
    #[schemars(length(max = 32))]
    pub moves: Vec<Move>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Remove {
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
            Self::List(args) if args.receipt_request_id.is_none() => Scope::View,
            _ => Scope::Manage,
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

pub type Call = Compatible<Request, v2::Request, v3::Request>;

impl Call {
    pub fn scope(&self) -> Scope {
        match self {
            Self::Legacy(request) => request.scope(),
            Self::Extended(request) => request.scope(),
            Self::Described(request) => request.scope(),
        }
    }

    pub fn write_key(&self) -> Option<(Uuid, Uuid)> {
        match self {
            Self::Legacy(request) => request.write_key(),
            Self::Extended(request) => request.write_key(),
            Self::Described(request) => request.write_key(),
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
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub revision: Uuid,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: Uuid,
    pub revision: Uuid,
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Error {
    PermissionDenied,
    InvalidArgument,
    NotFound,
    RevisionConflict,
    RequestConflict,
    InputBusy,
    CapacityExceeded,
    StorageUnavailable,
    UnknownDelivery,
}
