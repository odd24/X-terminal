use crate::Sensitive;
use config_model::{Folder, PortableProfile, Profile};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CredentialBundle {
    pub password: Option<Sensitive>,
    pub private_key: Option<Sensitive>,
    pub passphrase: Option<Sensitive>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialEdit {
    Keep {},
    Clear {},
    Replace { value: CredentialBundle },
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigRequest {
    Page {
        revision: Option<Uuid>,
        offset: u32,
        folders: bool,
    },
    SaveFolder {
        folder: Folder,
    },
    DeleteFolder {
        id: Uuid,
    },
    SaveProfile {
        profile: PortableProfile,
        credential: CredentialEdit,
    },
    DeleteProfile {
        id: Uuid,
    },
}
impl ConfigRequest {
    pub fn validate(&self) -> bool {
        match self {
            Self::Page {
                revision, offset, ..
            } => *offset <= 10000 && (*offset == 0 || revision.is_some()),
            Self::SaveFolder { folder } => {
                !folder.id.is_nil() && config_model::valid_text(&folder.name, 256)
            }
            Self::SaveProfile {
                profile,
                credential,
            } => {
                !profile.id.is_nil()
                    && config_model::valid_text(&profile.name, 256)
                    && profile.settings.validate().is_ok()
                    && match credential {
                        CredentialEdit::Replace { value } => {
                            [&value.password, &value.private_key, &value.passphrase]
                                .into_iter()
                                .flatten()
                                .all(|value| value.expose().len() <= 64 * 1024)
                        }
                        _ => true,
                    }
            }
            Self::DeleteFolder { id } | Self::DeleteProfile { id } => !id.is_nil(),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigError {
    Invalid,
    NotFound,
    Conflict,
    Storage,
    UnsupportedSchema,
    Corrupt,
    CredentialUnavailable,
    Locked,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigReply {
    Page {
        revision: Uuid,
        folders: Vec<Folder>,
        profiles: Vec<Profile>,
        next_offset: Option<u32>,
    },
    SavedProfile {
        profile: Profile,
        revision: Uuid,
    },
    Updated {
        revision: Uuid,
    },
    Error {
        code: ConfigError,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_configuration_contract_rejects_secret_reference_injection_and_unknown_ops() {
        let profile = PortableProfile {
            id: Uuid::from_u128(1),
            folder_id: None,
            name: "synthetic".into(),
            settings: config_model::Settings::Ssh1 {
                host: "example.invalid".into(),
                port: 22,
                username: "synthetic".into(),
                explicitly_enabled: true,
                encoding: config_model::Encoding::Utf8,
            },
        };
        let mut value = serde_json::json!({"op":"save_profile","profile":profile,"credential":{"action":"keep"}});
        assert!(
            serde_json::from_value::<ConfigRequest>(value.clone())
                .unwrap()
                .validate()
        );
        value["profile"]["credential_ref"] = serde_json::json!(Uuid::from_u128(2));
        assert!(serde_json::from_value::<ConfigRequest>(value).is_err());
        assert!(
            serde_json::from_value::<ConfigRequest>(
                serde_json::json!({"op":"read_credential","id":Uuid::from_u128(2)})
            )
            .is_err()
        );
        assert!(
            !ConfigRequest::Page {
                revision: None,
                offset: 64,
                folders: false
            }
            .validate()
        );
        assert!(
            serde_json::from_value::<CredentialEdit>(
                serde_json::json!({"action":"keep","secret":"unexpected"})
            )
            .is_err()
        );
    }
}
