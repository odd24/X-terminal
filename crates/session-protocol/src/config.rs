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
    PreviewBatch {
        id: Uuid,
        revision: Uuid,
        ids: Vec<Uuid>,
        patch: config_model::BatchPatch,
    },
    ApplyBatch {
        id: Uuid,
    },
    BatchStatus {
        id: Uuid,
    },
    CancelBatch {
        id: Uuid,
    },
    Recheck {
        service_id: Uuid,
    },
    QuickCommands {},
    SaveQuickCommand {
        command: config_model::QuickCommand,
        revision: Uuid,
    },
    DeleteQuickCommand {
        id: Uuid,
        revision: Uuid,
    },
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
            Self::PreviewBatch {
                id,
                revision,
                ids,
                patch,
            } => {
                !id.is_nil()
                    && !revision.is_nil()
                    && config_model::valid_batch_ids(ids)
                    && patch.validate().is_ok()
            }
            Self::ApplyBatch { id } | Self::BatchStatus { id } | Self::CancelBatch { id } => {
                !id.is_nil()
            }
            Self::Recheck { service_id } => !service_id.is_nil(),
            Self::QuickCommands {} => true,
            Self::SaveQuickCommand { command, revision } => {
                !revision.is_nil() && command.validate().is_ok()
            }
            Self::DeleteQuickCommand { id, revision } => !id.is_nil() && !revision.is_nil(),
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
    Batch {
        receipt: BatchReceipt,
    },
    Rechecked {
        service_id: Uuid,
    },
    QuickCommands {
        commands: Vec<config_model::QuickCommand>,
        revision: Uuid,
    },
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
        quick_commands: u32,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BatchState {
    Preview,
    Applied,
    Cancelled,
    Rejected,
    Expired,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BatchReceipt {
    pub id: Uuid,
    pub revision: Uuid,
    pub state: BatchState,
    pub reason: Option<ConfigError>,
    pub changed_count: u32,
    pub rows: Vec<config_model::BatchDiff>,
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
    fn configuration_recheck_is_strict_and_bound_to_a_service() {
        let id = Uuid::new_v4();
        assert!(ConfigRequest::Recheck { service_id: id }.validate());
        assert!(
            !ConfigRequest::Recheck {
                service_id: Uuid::nil()
            }
            .validate()
        );
        assert!(
            serde_json::from_value::<ConfigRequest>(serde_json::json!({
                "op":"recheck", "service_id":id, "directory":"untrusted"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ConfigRequest>(serde_json::json!({"op":"recheck"})).is_err()
        );
        let reply = serde_json::to_value(ConfigReply::Rechecked { service_id: id }).unwrap();
        assert_eq!(reply["service_id"], id.to_string());
    }
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

#[cfg(test)]
mod workspace_split_contract_tests {
    use super::*;
    #[test]
    fn split_is_required_nullable_in_both_wire_and_schema_and_cannot_carry_connection_capabilities()
    {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let profile = Uuid::new_v4();
        let workspace = serde_json::json!({"id":Uuid::new_v4(),"name":"layout","groups":[],"tabs":[{"id":first,"profile_id":profile,"group_id":null},{"id":second,"profile_id":profile,"group_id":null}],"selected_tab":first,"navigation_open":false,"split":null});
        let mut request = serde_json::json!({"op":"save_workspace","workspace":workspace,"revision":Uuid::new_v4()});
        assert!(
            serde_json::from_value::<ConfigRequest>(request.clone())
                .unwrap()
                .validate()
        );
        request["workspace"]
            .as_object_mut()
            .unwrap()
            .remove("split");
        assert!(serde_json::from_value::<ConfigRequest>(request.clone()).is_err());
        request["workspace"]["split"] =
            serde_json::json!({"direction":"horizontal","tabs":[first,second]});
        assert!(
            serde_json::from_value::<ConfigRequest>(request.clone())
                .unwrap()
                .validate()
        );
        request["workspace"]["split"]["generation"] = 1.into();
        assert!(serde_json::from_value::<ConfigRequest>(request).is_err());
        let schema = serde_json::to_value(schemars::schema_for!(config_model::Workspace)).unwrap();
        assert!(
            schema["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "split")
        );
        assert!(schema["properties"]["split"].to_string().contains("null"));
    }
}

#[cfg(test)]
mod quick_command_contract_tests {
    use super::*;
    #[test]
    fn named_templates_are_strict_bounded_and_debug_redacted() {
        let command = config_model::QuickCommand {
            id: Uuid::new_v4(),
            name: "synthetic-name".into(),
            group: "synthetic-group".into(),
            template: "synthetic-secret-body {{x}}".into(),
            ending: config_model::CommandEnding::None,
        };
        let request = ConfigRequest::SaveQuickCommand {
            command: command.clone(),
            revision: Uuid::new_v4(),
        };
        assert!(request.validate());
        let debug = format!("{request:?}");
        for value in [&command.name, &command.group, &command.template] {
            assert!(!debug.contains(value));
        }
        let descriptor = crate::Request::Config { request }.audit_descriptor(1);
        let text = serde_json::to_string(&descriptor).unwrap();
        assert!(!text.contains("synthetic"));
        let mut value = serde_json::json!({"op":"save_quick_command","revision":Uuid::new_v4(),"command":command});
        value["command"]["values"] = serde_json::json!({"x":"must not persist"});
        assert!(serde_json::from_value::<ConfigRequest>(value).is_err());
    }
}

#[cfg(test)]
mod batch_contract_tests {
    use super::*;
    #[test]
    fn batch_config_strict_selection_patch_and_redacted_audit() {
        assert!(
            serde_json::from_value::<config_model::BatchFolder>(serde_json::json!({"kind":"move"}))
                .is_err(),
            "moving to root must explicitly supply null"
        );
        assert!(
            serde_json::from_value::<config_model::BatchFolder>(
                serde_json::json!({"kind":"move","folder_id":null})
            )
            .is_ok()
        );

        let schema = schemars::schema_for!(config_model::BatchFolder);
        assert!(
            schema
                .get("oneOf")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|variant| {
                    variant["required"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|field| field == "folder_id")
                })
        );
        let value = serde_json::json!({"op":"preview_batch","id":Uuid::new_v4(),"revision":Uuid::new_v4(),"ids":[Uuid::new_v4(),Uuid::new_v4()],"patch":{"folder":{"kind":"keep"},"encoding":"gbk","ssh_port":2222,"serial_baud":null}});
        let request: ConfigRequest = serde_json::from_value(value.clone()).unwrap();
        assert!(request.validate());
        assert!(!format!("{request:?}").contains("2222"));
        let audit = crate::Request::Config { request }.audit_descriptor(1);
        let audit = serde_json::to_string(&audit).unwrap();
        assert!(!audit.contains("2222"));
        assert!(!audit.contains("gbk"));
        for path in ["owner", "credential_ref", "host"] {
            let mut v = value.clone();
            v["patch"][path] = serde_json::json!("synthetic");
            assert!(serde_json::from_value::<ConfigRequest>(v).is_err());
        }
        let mut duplicate = value.clone();
        duplicate["ids"][1] = duplicate["ids"][0].clone();
        assert!(
            !serde_json::from_value::<ConfigRequest>(duplicate)
                .unwrap()
                .validate()
        );
        let mut huge = value.clone();
        huge["ids"] = serde_json::json!((0..65).map(|_| Uuid::new_v4()).collect::<Vec<_>>());
        assert!(
            !serde_json::from_value::<ConfigRequest>(huge)
                .unwrap()
                .validate()
        );
        let mut both = value;
        both["patch"]["serial_baud"] = serde_json::json!(115200);
        assert!(
            !serde_json::from_value::<ConfigRequest>(both)
                .unwrap()
                .validate()
        );
        assert!(
            serde_json::from_value::<ConfigRequest>(
                serde_json::json!({"op":"apply_batch","id":Uuid::new_v4(),"patch":{}})
            )
            .is_err()
        );
    }
}
