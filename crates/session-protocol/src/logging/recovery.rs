use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryInfo {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub encoding: String,
    pub started_at_ms: u64,
    pub source_cursor: u64,
    pub text_cursor: u64,
    pub limits: Limits,
    pub first_segment: u64,
    pub last_observed_segment: u64,
    pub available_from: u64,
    pub source_available_from: u64,
    pub completion_present: bool,
    pub partial_present: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryEntry {
    pub log_id: Uuid,
    /// None means unavailable/unidentifiable; it does not authorize a read.
    pub info: Option<RecoveryInfo>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecoveryStopKind {
    EndOfAvailable,
    MissingPartner,
    MissingSegment,
    InvalidHeader,
    Discontinuity,
    TruncatedRecord,
    InvalidRecord,
    Storage,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryStop {
    pub kind: RecoveryStopKind,
    pub segment: u64,
    pub next_cursor: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryPage {
    pub connection: ConnectionRef,
    pub log_id: Uuid,
    pub read_id: Uuid,
    pub cursor: u64,
    pub next_cursor: u64,
    pub available_from: u64,
    pub source_available_from: u64,
    pub stop: Option<RecoveryStop>,
    pub records: Vec<HistoryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryExportSummary {
    pub recovered_records: u64,
    pub recovered_raw_bytes: u64,
    pub recovered_gap_bytes: u64,
    pub next_cursor: u64,
    pub stop: RecoveryStop,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryExportInfo {
    pub connection: ConnectionRef,
    pub log_id: Uuid,
    pub request_id: Uuid,
    pub phase: ExportPhase,
    pub failure: Option<ExportFailure>,
    /// Always true, including after successful artifact publication.
    pub incomplete: bool,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub recovered: Option<RecoveryExportSummary>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_export_requests_require_explicit_operations_and_cannot_supply_artifact_details() {
        for op in [
            "recovery_export_start",
            "recovery_export_status",
            "recovery_export_cancel",
        ] {
            let value = serde_json::json!({"op":op,"connection":{"connection_id":Uuid::new_v4(),"generation":2},"log_id":Uuid::new_v4(),"request_id":Uuid::new_v4()});
            assert!(
                serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            for field in [
                "path",
                "role",
                "mode",
                "sha256",
                "recovered",
                "incomplete",
                "read_id",
            ] {
                let mut bad = value.clone();
                bad[field] = true.into();
                assert!(serde_json::from_value::<Request>(bad).is_err());
            }
            for field in ["log_id", "request_id"] {
                let mut bad = value.clone();
                bad[field] = Uuid::nil().to_string().into();
                assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
            }
            let mut bad = value;
            bad["connection"]["generation"] = 0.into();
            assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
        }
    }
    #[test]
    fn recovery_contract_is_explicit_scoped_bounded_and_cannot_take_paths_or_roles() {
        assert!(Request::RecoveryList {}.validate());
        for op in ["recovery_open", "recovery_read", "recovery_close"] {
            let mut value = serde_json::json!({"op":op,"connection":{"connection_id":Uuid::new_v4(),"generation":2},"log_id":Uuid::new_v4(),"read_id":Uuid::new_v4()});
            if op == "recovery_read" {
                value["cursor"] = 1.into();
                value["max_records"] = 128.into();
                value["max_bytes"] = 65536.into();
            }
            assert!(
                serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            for field in ["path", "role", "repair", "skip_invalid"] {
                let mut bad = value.clone();
                bad[field] = true.into();
                assert!(serde_json::from_value::<Request>(bad).is_err());
            }
            for field in ["read_id", "log_id"] {
                let mut bad = value.clone();
                bad[field] = Uuid::nil().to_string().into();
                assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
            }
            if op == "recovery_read" {
                for (field, number) in [("cursor", 0), ("max_records", 129), ("max_bytes", 65537)] {
                    let mut bad = value.clone();
                    bad[field] = number.into();
                    assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
                }
            }
            value["connection"]["generation"] = 0.into();
            assert!(!serde_json::from_value::<Request>(value).unwrap().validate());
        }
    }
}
