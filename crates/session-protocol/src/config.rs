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
    Workspaces {},
    SaveWorkspace {
        workspace: config_model::Workspace,
        revision: Uuid,
    },
    DeleteWorkspace {
        id: Uuid,
        revision: Uuid,
    },
    Preferences {},
    SavePreferences {
        preferences: config_model::DesktopPreferences,
        revision: Uuid,
    },
    CredentialsPage {
        revision: Option<Uuid>,
        offset: u32,
    },
    InspectCredential {
        id: Uuid,
    },
    ForgetCredential {
        id: Uuid,
        revision: Uuid,
    },
    Archives {},
    CreateBackup {},
    ExportConfig {},
    InspectBackup {
        id: Uuid,
    },
    RestoreBackup {
        id: Uuid,
        digest: String,
        current_revision: Uuid,
    },
    RecoverBackup {
        id: Uuid,
        digest: String,
    },
    DeleteArchive {
        id: Uuid,
        kind: ArchiveKind,
    },
    HostKeysPage {
        revision: Option<Uuid>,
        offset: u32,
    },
    ForgetHostKey {
        endpoint: config_model::HostEndpoint,
        algorithm: String,
        expected_fingerprint: String,
    },
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
    SaveProfileKeyFile {
        profile: PortableProfile,
        key_path: String,
        passphrase: Option<Sensitive>,
    },
    DeleteProfile {
        id: Uuid,
    },
}
impl ConfigRequest {
    pub fn validate(&self) -> bool {
        match self {
            Self::Workspaces {} => true,
            Self::SaveWorkspace {
                workspace,
                revision,
            } => !revision.is_nil() && workspace.validate().is_ok(),
            Self::DeleteWorkspace { id, revision } => !id.is_nil() && !revision.is_nil(),
            Self::Preferences {} => true,
            Self::SavePreferences {
                preferences,
                revision,
            } => !revision.is_nil() && preferences.validate().is_ok(),
            Self::CredentialsPage { revision, offset } => {
                *offset <= 10000 && (*offset == 0 || revision.is_some())
            }
            Self::InspectCredential { id } => !id.is_nil(),
            Self::ForgetCredential { id, revision } => !id.is_nil() && !revision.is_nil(),
            Self::Archives {} | Self::CreateBackup {} | Self::ExportConfig {} => true,
            Self::InspectBackup { id } | Self::DeleteArchive { id, .. } => !id.is_nil(),
            Self::RestoreBackup {
                id,
                digest,
                current_revision,
            } => !id.is_nil() && !current_revision.is_nil() && valid_digest(digest),
            Self::RecoverBackup { id, digest } => !id.is_nil() && valid_digest(digest),
            Self::HostKeysPage { revision, offset } => {
                *offset <= 1024 && (*offset == 0 || revision.is_some())
            }
            Self::ForgetHostKey {
                endpoint,
                algorithm,
                expected_fingerprint,
            } => {
                endpoint.canonical().is_ok()
                    && !algorithm.is_empty()
                    && algorithm.len() <= 128
                    && !algorithm.chars().any(char::is_control)
                    && expected_fingerprint.len() == 50
                    && expected_fingerprint.starts_with("SHA256:")
                    && expected_fingerprint[7..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
            }
            Self::SaveProfileKeyFile {
                profile,
                key_path,
                passphrase,
            } => {
                !profile.id.is_nil()
                    && config_model::valid_text(&profile.name, 256)
                    && profile.settings.validate().is_ok()
                    && matches!(
                        profile.settings,
                        config_model::Settings::Ssh2 {
                            auth: config_model::Auth::PublicKey,
                            ..
                        }
                    )
                    && !key_path.is_empty()
                    && key_path.len() <= 32767
                    && !key_path.chars().any(char::is_control)
                    && passphrase
                        .as_ref()
                        .is_none_or(|value| value.expose().len() <= 4096)
            }
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
    InUse,
    Capacity,
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
    Workspaces {
        workspaces: Vec<config_model::Workspace>,
        revision: Uuid,
    },
    Preferences {
        preferences: config_model::DesktopPreferences,
        revision: Uuid,
    },
    CredentialsPage {
        revision: Uuid,
        entries: Vec<CredentialInfo>,
        next_offset: Option<u32>,
    },
    CredentialPreview {
        id: Uuid,
        revision: Uuid,
        current_profiles: u32,
        backup_profiles: u32,
    },
    Archives {
        entries: Vec<ArchiveInfo>,
    },
    Artifact {
        artifact: ArchiveInfo,
    },
    BackupPreview {
        workspaces: u32,
        id: Uuid,
        digest: String,
        folders: u32,
        profiles: u32,
        host_keys: u32,
        missing_credentials: u32,
        current_revision: Option<Uuid>,
        sample_profiles: Vec<String>,
        preferences: config_model::DesktopPreferences,
    },
    Restored {
        revision: Uuid,
        safety_backup: ArchiveInfo,
        missing_credentials: u32,
    },
    Recovered {
        directory_id: Uuid,
        missing_credentials: u32,
    },
    HostKeysPage {
        revision: Uuid,
        keys: Vec<config_model::HostKeySummary>,
        next_offset: Option<u32>,
    },
    Page {
        revision: Uuid,
        folders: Vec<Folder>,
        profiles: Vec<Profile>,
        next_offset: Option<u32>,
        missing_credential_profiles: Vec<Uuid>,
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

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CredentialInfo {
    pub id: Uuid,
    pub current_profiles: u32,
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveKind {
    Backup,
    Export,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArchiveInfo {
    pub id: Uuid,
    pub kind: ArchiveKind,
    pub filename: String,
    pub bytes: u64,
    pub modified_ms: u64,
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

#[cfg(test)]
mod preference_tests {
    use super::*;
    #[test]
    fn preference_fields_enums_bounds_and_revision_are_strict() {
        let mut value = serde_json::json!({"op":"save_preferences","revision":Uuid::new_v4(),"preferences":config_model::DesktopPreferences::default()});
        assert!(
            serde_json::from_value::<ConfigRequest>(value.clone())
                .unwrap()
                .validate()
        );
        value["preferences"]["font_size"] = 29.into();
        assert!(
            !serde_json::from_value::<ConfigRequest>(value.clone())
                .unwrap()
                .validate()
        );
        value["preferences"]["font_size"] = 15.into();
        value["preferences"]["terminal_font"] = "unknown".into();
        assert!(serde_json::from_value::<ConfigRequest>(value.clone()).is_err());
        value["preferences"]["terminal_font"] = "consolas".into();
        value["preferences"]["terminal_palette"] = "unknown".into();
        assert!(serde_json::from_value::<ConfigRequest>(value.clone()).is_err());
        value["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("terminal_palette");
        assert!(serde_json::from_value::<ConfigRequest>(value.clone()).is_err());
        value["preferences"]["terminal_palette"] = "black_green".into();
        value["revision"] = Uuid::nil().to_string().into();
        assert!(
            !serde_json::from_value::<ConfigRequest>(value.clone())
                .unwrap()
                .validate()
        );
        value["preferences"]["draft"] = "forbidden".into();
        assert!(serde_json::from_value::<ConfigRequest>(value).is_err());
    }
}
