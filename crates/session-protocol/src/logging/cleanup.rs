use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CleanupKind {
    Log,
    Export,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CleanupPhase {
    Preview,
    Cancelled,
    Expired,
    Applied,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CleanupFile {
    pub name: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CleanupFailure {
    Changed,
    Storage,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CleanupReport {
    pub removed_files: u32,
    pub removed_logical_bytes: u64,
    pub directory_removed: bool,
    pub failure: Option<CleanupFailure>,
    pub os_code: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CleanupInfo {
    pub kind: CleanupKind,
    pub id: Uuid,
    pub preview_id: Uuid,
    pub phase: CleanupPhase,
    pub expires_at_ms: u64,
    pub confirmation: Option<Uuid>,
    pub files: Vec<CleanupFile>,
    pub logical_bytes: u64,
    pub report: Option<CleanupReport>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_contract_rejects_paths_nils_foreign_kinds_and_missing_confirmation() {
        for op in [
            "cleanup_preview",
            "cleanup_status",
            "cleanup_cancel",
            "cleanup_commit",
        ] {
            let mut value = serde_json::json!({"op":op,"kind":"LOG","id":Uuid::new_v4(),"preview_id":Uuid::new_v4()});
            if op == "cleanup_commit" {
                value["confirmation"] = Uuid::new_v4().to_string().into();
            }
            assert!(
                serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            for field in ["path", "directory", "files", "role", "recursive"] {
                let mut bad = value.clone();
                bad[field] = true.into();
                assert!(serde_json::from_value::<Request>(bad).is_err());
            }
            for field in ["id", "preview_id"] {
                let mut bad = value.clone();
                bad[field] = Uuid::nil().to_string().into();
                assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
            }
            let mut bad = value.clone();
            bad["kind"] = "PROFILE".into();
            assert!(serde_json::from_value::<Request>(bad).is_err());
            if op == "cleanup_commit" {
                value.as_object_mut().unwrap().remove("confirmation");
                assert!(serde_json::from_value::<Request>(value).is_err());
            }
        }
    }
}
