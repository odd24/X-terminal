use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::session::*;
use uuid::Uuid;
mod cleanup;
pub use cleanup::*;
mod recovery;
pub use recovery::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub segment_bytes: u64,
    pub segments: u32,
}
impl Limits {
    pub fn validate(self) -> bool {
        (128 * 1024..=100 * 1024 * 1024).contains(&self.segment_bytes)
            && (1..=16).contains(&self.segments)
    }
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    TextExportStart {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    TextExportStatus {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    TextExportCancel {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    Start {
        connection: ConnectionRef,
        request_id: Uuid,
        limits: Limits,
    },
    List {
        connection: ConnectionRef,
    },
    CaptureList {},
    Status {
        connection: ConnectionRef,
        log_id: Uuid,
    },
    Stop {
        connection: ConnectionRef,
        log_id: Uuid,
    },
    ReleaseFailed {
        connection: ConnectionRef,
        log_id: Uuid,
    },
    HistoryList {},
    RecoveryList {},
    RecoveryOpen {
        connection: ConnectionRef,
        log_id: Uuid,
        read_id: Uuid,
    },
    RecoveryRead {
        connection: ConnectionRef,
        log_id: Uuid,
        read_id: Uuid,
        cursor: u64,
        max_records: u32,
        max_bytes: u32,
    },
    RecoveryClose {
        connection: ConnectionRef,
        log_id: Uuid,
        read_id: Uuid,
    },
    CleanupList {
        kind: CleanupKind,
    },
    CleanupPreview {
        kind: CleanupKind,
        id: Uuid,
        preview_id: Uuid,
    },
    CleanupStatus {
        kind: CleanupKind,
        id: Uuid,
        preview_id: Uuid,
    },
    CleanupCancel {
        kind: CleanupKind,
        id: Uuid,
        preview_id: Uuid,
    },
    CleanupCommit {
        kind: CleanupKind,
        id: Uuid,
        preview_id: Uuid,
        confirmation: Uuid,
    },
    ExportStart {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    RecoveryExportStart {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    RecoveryExportStatus {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    RecoveryExportCancel {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    ExportStatus {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    ExportCancel {
        connection: ConnectionRef,
        log_id: Uuid,
        request_id: Uuid,
    },
    HistoryOpen {
        connection: ConnectionRef,
        log_id: Uuid,
        read_id: Uuid,
    },
    HistoryRead {
        connection: ConnectionRef,
        log_id: Uuid,
        read_id: Uuid,
        cursor: u64,
        max_records: u32,
        max_bytes: u32,
    },
    HistoryClose {
        connection: ConnectionRef,
        log_id: Uuid,
        read_id: Uuid,
    },
}
impl Request {
    pub fn validate(&self) -> bool {
        let connection = match self {
            Self::CaptureList {} => return true,
            Self::CleanupList { .. } => return true,
            Self::CleanupPreview { id, preview_id, .. }
            | Self::CleanupStatus { id, preview_id, .. }
            | Self::CleanupCancel { id, preview_id, .. } => {
                return !id.is_nil() && !preview_id.is_nil();
            }
            Self::CleanupCommit {
                id,
                preview_id,
                confirmation,
                ..
            } => return !id.is_nil() && !preview_id.is_nil() && !confirmation.is_nil(),
            Self::HistoryList {} | Self::RecoveryList {} => return true,
            Self::TextExportStart {
                connection,
                log_id,
                request_id,
            }
            | Self::TextExportStatus {
                connection,
                log_id,
                request_id,
            }
            | Self::TextExportCancel {
                connection,
                log_id,
                request_id,
            }
            | Self::RecoveryExportStart {
                connection,
                log_id,
                request_id,
            }
            | Self::RecoveryExportStatus {
                connection,
                log_id,
                request_id,
            }
            | Self::RecoveryExportCancel {
                connection,
                log_id,
                request_id,
            }
            | Self::ExportStart {
                connection,
                log_id,
                request_id,
            }
            | Self::ExportStatus {
                connection,
                log_id,
                request_id,
            }
            | Self::ExportCancel {
                connection,
                log_id,
                request_id,
            } => {
                if log_id.is_nil() || request_id.is_nil() {
                    return false;
                }
                connection
            }
            Self::RecoveryRead {
                connection,
                log_id,
                read_id,
                cursor,
                max_records,
                max_bytes,
            }
            | Self::HistoryRead {
                connection,
                log_id,
                read_id,
                cursor,
                max_records,
                max_bytes,
            } => {
                if log_id.is_nil()
                    || read_id.is_nil()
                    || *cursor == 0
                    || !(1..=128).contains(max_records)
                    || !(32 * 1024..=64 * 1024).contains(max_bytes)
                {
                    return false;
                }
                connection
            }
            Self::RecoveryOpen {
                connection,
                log_id,
                read_id,
            }
            | Self::RecoveryClose {
                connection,
                log_id,
                read_id,
            }
            | Self::HistoryOpen {
                connection,
                log_id,
                read_id,
            }
            | Self::HistoryClose {
                connection,
                log_id,
                read_id,
            } => {
                if log_id.is_nil() || read_id.is_nil() {
                    return false;
                }
                connection
            }
            Self::Start {
                connection,
                request_id,
                limits,
            } => {
                if request_id.is_nil() || !limits.validate() {
                    return false;
                }
                connection
            }
            Self::List { connection } => connection,
            Self::Status { connection, log_id }
            | Self::Stop { connection, log_id }
            | Self::ReleaseFailed { connection, log_id } => {
                if log_id.is_nil() {
                    return false;
                }
                connection
            }
        };
        connection.generation > 0 && !connection.connection_id.0.is_nil()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArchiveInfo {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub encoding: String,
    pub started_at_ms: u64,
    pub source_cursor: u64,
    pub text_cursor: u64,
    pub limits: Limits,
    pub available_from: u64,
    pub source_available_from: u64,
    pub first_retained_segment: u64,
    pub last_segment: u64,
    pub written_records: u64,
    pub written_raw_bytes: u64,
    pub source_gap_bytes: Option<u64>,
    pub natural_end: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CatalogueState {
    HeaderChecked,
    Unfinished,
    Invalid,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryEntry {
    pub log_id: Uuid,
    pub state: CatalogueState,
    pub info: Option<ArchiveInfo>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryRecord {
    pub raw: Option<OutputEvent>,
    pub text: session_core::presentation::TextEvent,
}
impl std::fmt::Debug for HistoryRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HistoryRecord([TERMINAL_CONTENT])")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryPage {
    pub connection: ConnectionRef,
    pub log_id: Uuid,
    pub read_id: Uuid,
    pub cursor: u64,
    pub next_cursor: u64,
    pub available_from: u64,
    pub source_available_from: u64,
    pub finished: bool,
    pub records: Vec<HistoryRecord>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Phase {
    Removed,
    Released,
    Opening,
    Recording,
    Stopping,
    Stopped,
    Failed,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    QueueFull,
    InvalidRecord,
    CounterExhausted,
    DiskFull,
    Storage,
    WorkerPanicked,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Info {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub encoding: String,
    pub started_at_ms: u64,
    pub source_cursor: u64,
    pub text_cursor: u64,
    pub limits: Limits,
    pub phase: Phase,
    pub failure: Option<Failure>,
    pub active: bool,
    pub accepted_records: u64,
    pub written_records: u64,
    pub accepted_raw_bytes: u64,
    pub written_raw_bytes: u64,
    pub rejected_records: u64,
    pub rejected_raw_bytes: u64,
    pub source_gap_bytes: u64,
    pub first_retained_segment: u64,
    pub last_segment: u64,
    pub retired_segments: u64,
    pub natural_end: bool,
    pub durable: bool,
    pub worker_finished: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportPhase {
    Removed,
    Queued,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportFailure {
    InvalidSource,
    Capacity,
    TooLarge,
    Storage,
    WorkerFailed,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExportInfo {
    pub connection: ConnectionRef,
    pub log_id: Uuid,
    pub request_id: Uuid,
    pub phase: ExportPhase,
    pub failure: Option<ExportFailure>,
    // Present only after successful synchronized, no-overwrite publication.
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub retained_records: Option<u64>,
    pub retained_raw_bytes: Option<u64>,
    pub retained_gap_bytes: Option<u64>,
    pub next_cursor: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    TextExport(Box<ExportInfo>),
    CleanupList {
        kind: CleanupKind,
        ids: Vec<Uuid>,
    },
    Cleanup(Box<CleanupInfo>),
    Export(Box<ExportInfo>),
    RecoveryExport(Box<RecoveryExportInfo>),
    Info(Box<Info>),
    List {
        logs: Vec<Info>,
    },
    HistoryList {
        logs: Vec<HistoryEntry>,
    },
    RecoveryList {
        logs: Vec<RecoveryEntry>,
    },
    RecoveryOpened {
        read_id: Uuid,
        info: Box<RecoveryInfo>,
    },
    RecoveryPage(Box<RecoveryPage>),
    RecoveryClosed {
        read_id: Uuid,
    },
    HistoryOpened {
        read_id: Uuid,
        info: Box<ArchiveInfo>,
    },
    HistoryPage(Box<HistoryPage>),
    HistoryClosed {
        read_id: Uuid,
    },
}
#[cfg(test)]
mod tests {
    #[test]
    fn capture_inventory_is_strict_and_full_registry_with_maximum_counters_fits_ipc() {
        assert!(Request::CaptureList {}.validate());
        for key in ["connection", "path", "role", "limit"] {
            let mut v = serde_json::json!({"op":"capture_list"});
            v[key] = true.into();
            assert!(serde_json::from_value::<Request>(v).is_err());
        }
        let mut v = serde_json::json!({"log_id":Uuid::new_v4(),"connection":{"connection_id":Uuid::new_v4(),"generation":u64::MAX},"protocol":"SSH2","encoding":"gb18030","phase":"FAILED","failure":"WORKER_PANICKED","active":false,"durable":false,"worker_finished":true,"natural_end":false,"limits":{"segment_bytes":104857600,"segments":16}});
        for key in [
            "started_at_ms",
            "source_cursor",
            "text_cursor",
            "accepted_records",
            "written_records",
            "accepted_raw_bytes",
            "written_raw_bytes",
            "rejected_records",
            "rejected_raw_bytes",
            "source_gap_bytes",
            "first_retained_segment",
            "last_segment",
            "retired_segments",
        ] {
            v[key] = u64::MAX.into();
        }
        let info: Info = serde_json::from_value(v).unwrap();
        assert!(
            serde_json::to_vec(&Reply::List {
                logs: vec![info; 64]
            })
            .unwrap()
            .len()
                < crate::MAX_FRAME / 2
        );
    }
    #[test]
    fn release_failed_requires_exact_capture_scope_and_cannot_take_file_options() {
        let value = serde_json::json!({"op":"release_failed","connection":{"connection_id":Uuid::new_v4(),"generation":3},"log_id":Uuid::new_v4()});
        assert!(
            serde_json::from_value::<super::Request>(value.clone())
                .unwrap()
                .validate()
        );
        for field in ["path", "files", "recursive", "role", "request_id"] {
            let mut bad = value.clone();
            bad[field] = true.into();
            assert!(serde_json::from_value::<super::Request>(bad).is_err());
        }
        for field in ["log_id", "connection_id"] {
            let mut bad = value.clone();
            if field == "log_id" {
                bad[field] = Uuid::nil().to_string().into();
            } else {
                bad["connection"][field] = Uuid::nil().to_string().into();
            }
            assert!(
                !serde_json::from_value::<super::Request>(bad)
                    .unwrap()
                    .validate()
            );
        }
    }
    use super::*;
    #[test]
    fn export_contract_requires_exact_scope_and_never_accepts_paths_or_roles() {
        for op in ["export_start", "export_status", "export_cancel"] {
            let value = serde_json::json!({ "op":op,
                "connection": { "connection_id":Uuid::new_v4(), "generation":1 },
                "log_id":Uuid::new_v4(), "request_id":Uuid::new_v4() });
            assert!(
                serde_json::from_value::<Request>(value.clone())
                    .unwrap()
                    .validate()
            );
            for field in ["path", "directory", "filename", "role", "max_bytes"] {
                let mut bad = value.clone();
                bad[field] = "forbidden".into();
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
    fn historical_contract_bounds_identifiers_scopes_payload_and_unknown_fields() {
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let value = serde_json::json!({"op":"history_read","connection":connection,"log_id":Uuid::new_v4(),"read_id":Uuid::new_v4(),"cursor":1,"max_records":128,"max_bytes":65536});
        assert!(
            serde_json::from_value::<Request>(value.clone())
                .unwrap()
                .validate()
        );
        for field in ["path", "offset", "role", "raw_only"] {
            let mut bad = value.clone();
            bad[field] = true.into();
            assert!(serde_json::from_value::<Request>(bad).is_err());
        }
        for (field, invalid) in [
            ("cursor", 0),
            ("max_records", 0),
            ("max_records", 129),
            ("max_bytes", 32767),
            ("max_bytes", 65537),
        ] {
            let mut bad = value.clone();
            bad[field] = invalid.into();
            assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
        }
        for op in ["history_open", "history_close", "history_read"] {
            let mut request = value.clone();
            request["op"] = op.into();
            if op != "history_read" {
                for key in ["cursor", "max_records", "max_bytes"] {
                    request.as_object_mut().unwrap().remove(key);
                }
            }
            assert!(
                serde_json::from_value::<Request>(request.clone())
                    .unwrap()
                    .validate()
            );
            for field in ["log_id", "read_id"] {
                let mut bad = request.clone();
                bad[field] = Uuid::nil().to_string().into();
                assert!(!serde_json::from_value::<Request>(bad).unwrap().validate());
            }
            request["connection"]["generation"] = 0.into();
            assert!(
                !serde_json::from_value::<Request>(request)
                    .unwrap()
                    .validate()
            );
        }
        assert!(Request::HistoryList {}.validate());
        assert!(
            serde_json::from_value::<Request>(
                serde_json::json!({"op":"history_list","path":"forbidden"})
            )
            .is_err()
        );
    }
    #[test]
    fn logging_contract_rejects_paths_unscoped_ids_and_invalid_limits() {
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let value = serde_json::json!({"op":"start","connection":connection,"request_id":Uuid::new_v4(),"limits":{"segment_bytes":131072,"segments":2}});
        assert!(
            serde_json::from_value::<Request>(value.clone())
                .unwrap()
                .validate()
        );
        for field in ["path", "directory", "encoding", "role"] {
            let mut bad = value.clone();
            bad[field] = "forbidden".into();
            assert!(serde_json::from_value::<Request>(bad).is_err());
        }
        let mut invalid = value.clone();
        invalid["connection"]["generation"] = 0.into();
        assert!(
            !serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
        );
        let mut invalid = value;
        invalid["limits"]["segments"] = 17.into();
        assert!(
            !serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
        );
        assert!(
            !Request::Status {
                connection,
                log_id: Uuid::nil()
            }
            .validate()
        );
        assert!(
            !Request::Start {
                connection,
                request_id: Uuid::nil(),
                limits: Limits {
                    segment_bytes: 131072,
                    segments: 1
                }
            }
            .validate()
        );
    }
}
