use crate::{Encoding, PortableProfile, Profile, Result, Settings, ValidationError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchFolder {
    Keep {},
    Move { folder_id: Option<Uuid> },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BatchPatch {
    pub folder: BatchFolder,
    pub encoding: Option<Encoding>,
    pub ssh_port: Option<u16>,
    pub serial_baud: Option<u32>,
}
impl std::fmt::Debug for BatchPatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BatchPatch([redacted])")
    }
}
impl BatchPatch {
    pub fn validate(&self) -> Result<()> {
        if matches!(self.folder, BatchFolder::Move { folder_id: Some(id) } if id.is_nil())
            || self.ssh_port == Some(0)
            || self.serial_baud == Some(0)
            || (self.ssh_port.is_some() && self.serial_baud.is_some())
            || (matches!(self.folder, BatchFolder::Keep {})
                && self.encoding.is_none()
                && self.ssh_port.is_none()
                && self.serial_baud.is_none())
        {
            return Err(ValidationError("batch patch"));
        }
        Ok(())
    }
    pub fn apply(&self, profile: &Profile) -> Result<Profile> {
        self.validate()?;
        let mut after = profile.clone();
        if let BatchFolder::Move { folder_id } = self.folder {
            after.folder_id = folder_id;
        }
        match &mut after.settings {
            Settings::Ssh1 { port, encoding, .. } | Settings::Ssh2 { port, encoding, .. } => {
                if self.serial_baud.is_some() {
                    return Err(ValidationError("batch protocol"));
                }
                if let Some(value) = self.ssh_port {
                    *port = value;
                }
                if let Some(value) = &self.encoding {
                    *encoding = value.clone();
                }
            }
            Settings::Serial {
                baud_rate,
                encoding,
                ..
            } => {
                if self.ssh_port.is_some() {
                    return Err(ValidationError("batch protocol"));
                }
                if let Some(value) = self.serial_baud {
                    *baud_rate = value;
                }
                if let Some(value) = &self.encoding {
                    *encoding = value.clone();
                }
            }
        }
        after.validate()?;
        Ok(after)
    }
}
pub fn valid_batch_ids(ids: &[Uuid]) -> bool {
    (2..=64).contains(&ids.len())
        && ids.iter().all(|id| !id.is_nil())
        && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BatchDiff {
    pub before: PortableProfile,
    pub after: PortableProfile,
}
impl std::fmt::Debug for BatchDiff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BatchDiff")
            .field("id", &self.before.id)
            .finish_non_exhaustive()
    }
}
impl From<&Profile> for PortableProfile {
    fn from(value: &Profile) -> Self {
        Self {
            id: value.id,
            folder_id: value.folder_id,
            name: value.name.clone(),
            settings: value.settings.clone(),
        }
    }
}
