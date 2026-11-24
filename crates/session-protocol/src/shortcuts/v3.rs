//! Explicitly selected four-type shortcut management with descriptions.
use super::{
    Scope, Sensitive, Uuid,
    v2::{MoveBlock, Target},
};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Version {
    V3,
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
#[serde(deny_unknown_fields)]
pub struct CreateItem {
    #[schemars(length(max = 64))]
    pub name: Option<Sensitive>,
    #[schemars(with = "Option<String>", length(max = 500))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<Sensitive>,
    pub target: Target,
    #[serde(default)]
    pub pinned: bool,
    pub close_on_success: Option<bool>,
    pub append_enter: Option<bool>,
}

impl From<super::v2::CreateItem> for CreateItem {
    fn from(item: super::v2::CreateItem) -> Self {
        Self {
            name: item.name,
            description: None,
            target: item.target,
            pinned: item.pinned,
            close_on_success: item.close_on_success,
            append_enter: item.append_enter,
        }
    }
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

fn description_patch<'de, D: Deserializer<'de>>(input: D) -> Result<Option<Sensitive>, D::Error> {
    Ok(Some(
        Option::deserialize(input)?.unwrap_or_else(|| Sensitive::new(String::new())),
    ))
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub id: Uuid,
    #[schemars(length(max = 64))]
    pub name: Option<Sensitive>,
    #[schemars(with = "Option<String>", length(max = 500))]
    #[serde(
        default,
        deserialize_with = "description_patch",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Sensitive>,
    pub target: Option<Target>,
    pub pinned: Option<bool>,
    pub close_on_success: Option<bool>,
    pub append_enter: Option<bool>,
}

impl From<super::v2::Change> for Change {
    fn from(change: super::v2::Change) -> Self {
        Self {
            id: change.id,
            name: change.name,
            description: None,
            target: change.target,
            pinned: change.pinned,
            close_on_success: change.close_on_success,
            append_enter: change.append_enter,
        }
    }
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
            Self::List(args) if args.receipt_request_id.is_none() => Scope::DescriptionView,
            _ => Scope::DescriptionManage,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Sensitive>,
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
