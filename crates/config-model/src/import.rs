use crate::{Folder, PortableProfile};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ImportPolicy {
    Reject,
    NewIds,
    Replace,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ImportProblemCode {
    Encoding,
    MalformedJson,
    MissingVersion,
    UnsupportedVersion,
    UnsupportedField,
    DuplicateField,
    InvalidShape,
    Capacity,
    DuplicateId,
    InvalidProfile,
    FolderReference,
    FolderCycle,
    Depth,
    Conflict,
    FolderConflict,
    CredentialEndpoint,
    ProtocolConflict,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportProblem {
    pub code: ImportProblemCode,
    pub row: Option<u16>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportFolderDiff {
    pub source_id: Uuid,
    pub before: Option<Folder>,
    pub after: Folder,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportProfileDiff {
    pub source_id: Uuid,
    pub before: Option<PortableProfile>,
    pub after: PortableProfile,
    pub credential_preserved: bool,
}
#[derive(Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportDiff {
    pub folders: Vec<ImportFolderDiff>,
    pub profiles: Vec<ImportProfileDiff>,
}
impl std::fmt::Debug for ImportDiff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportDiff")
            .field("folders", &self.folders.len())
            .field("profiles", &self.profiles.len())
            .finish()
    }
}
