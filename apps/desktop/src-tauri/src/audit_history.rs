//! Dedicated read-only projection. All integers become exact decimal strings;
//! serialized metadata is rendered as text, never parsed back into authority.
use serde::{Deserialize, Serialize};
use session_core::audit_journal::{Payload, Status as CoreStatus};
use session_protocol::rpc_audit::{Reply as ProtocolReply, View};
use uuid::Uuid;
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Info {},
    Page {
        cursor: String,
        through_cursor: String,
    },
}
fn decimal(value: String) -> Result<u64, String> {
    if value.len() > 20 {
        return Err("INVALID_AUDIT_CURSOR".into());
    }
    let parsed = value
        .parse::<u64>()
        .map_err(|_| "INVALID_AUDIT_CURSOR".to_string())?;
    if parsed.to_string() != value {
        return Err("INVALID_AUDIT_CURSOR".into());
    }
    Ok(parsed)
}
impl Request {
    pub fn into_protocol(self) -> Result<View, String> {
        let view = match self {
            Self::Info {} => View::JournalInfo {},
            Self::Page {
                cursor,
                through_cursor,
            } => View::JournalPage {
                cursor: decimal(cursor)?,
                through_cursor: decimal(through_cursor)?,
                limit: 64,
            },
        };
        if !view.valid() {
            return Err("INVALID_AUDIT_CURSOR".into());
        }
        Ok(view)
    }
}
#[derive(Debug, Serialize)]
pub struct Status {
    state: session_core::audit_journal::State,
    accepted_through: String,
    synced_through: String,
    rejected_records: String,
    incomplete_segments: String,
    available_from: String,
    retained_records: String,
}
impl From<CoreStatus> for Status {
    fn from(s: CoreStatus) -> Self {
        Self {
            state: s.state,
            accepted_through: s.accepted_through.to_string(),
            synced_through: s.synced_through.to_string(),
            rejected_records: s.rejected_records.to_string(),
            incomplete_segments: s.incomplete_segments.to_string(),
            available_from: s.available_from.to_string(),
            retained_records: s.retained_records.to_string(),
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Row {
    seq: String,
    service_id: Uuid,
    category: &'static str,
    summary: String,
    metadata: String,
}
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Info {
        service_id: Uuid,
        status: Status,
    },
    Page {
        service_id: Uuid,
        status: Status,
        records: Vec<Row>,
        next_cursor: String,
        through_cursor: String,
        available_from: String,
        gap: bool,
    },
}
impl Reply {
    pub fn project(value: ProtocolReply) -> Result<Self, String> {
        match value {
            ProtocolReply::JournalInfo { service_id, status } => Ok(Self::Info {
                service_id,
                status: status.into(),
            }),
            ProtocolReply::JournalPage {
                service_id,
                status,
                page,
            } => {
                let mut records = Vec::with_capacity(page.records.len());
                for row in page.records {
                    let (category, summary) = match &row.payload {
                        Payload::Rpc(e) => (
                            "RPC",
                            format!(
                                "{:?} / {:?} / {:?}",
                                e.attempt.request.area, e.attempt.request.verb, e.phase
                            ),
                        ),
                        Payload::Policy(e) => ("POLICY", format!("{:?}", e.kind)),
                    };
                    let metadata =
                        serde_json::to_string_pretty(&row).map_err(|_| "INVALID_AUDIT_REPLY")?;
                    records.push(Row {
                        seq: row.seq.to_string(),
                        service_id: row.service_id,
                        category,
                        summary,
                        metadata,
                    });
                }
                Ok(Self::Page {
                    service_id,
                    status: status.into(),
                    records,
                    next_cursor: page.next_cursor.to_string(),
                    through_cursor: page.through_cursor.to_string(),
                    available_from: page.available_from.to_string(),
                    gap: page.gap,
                })
            }
            _ => Err("INVALID_AUDIT_REPLY".into()),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_is_read_only_and_decimal_claims_never_cross_webview_as_numbers() {
        for value in [
            serde_json::json!({"op":"info","path":"x"}),
            serde_json::json!({"op":"page","cursor":0,"through_cursor":"1"}),
            serde_json::json!({"op":"grant"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        for value in ["01", "-1", "+1", " 1", "18446744073709551616"] {
            assert!(decimal(value.into()).is_err());
        }
        assert_eq!(decimal(u64::MAX.to_string()).unwrap(), u64::MAX);
        let status = CoreStatus {
            state: session_core::audit_journal::State::Healthy,
            accepted_through: u64::MAX,
            synced_through: u64::MAX,
            rejected_records: 0,
            incomplete_segments: 0,
            available_from: 0,
            retained_records: 0,
        };
        let reply = Reply::project(ProtocolReply::JournalInfo {
            service_id: Uuid::new_v4(),
            status,
        })
        .unwrap();
        let value = serde_json::to_value(reply).unwrap();
        assert_eq!(value["status"]["synced_through"], u64::MAX.to_string());
        let row = session_core::audit_journal::Record {
            seq: u64::MAX,
            service_id: Uuid::new_v4(),
            payload: Payload::Policy(session_core::access::AuditEvent {
                seq: u64::MAX,
                timestamp_ms: u64::MAX,
                kind: session_core::access::AuditKind::Denied,
                client_id: None,
                scope: Some(session_core::access::Scope {
                    target: session_core::access::Target::Connection {
                        connection: session_core::session::ConnectionRef {
                            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
                            generation: u64::MAX,
                        },
                    },
                    action: session_core::access::Action::Read,
                }),
                request_id: None,
                denial: Some(session_core::access::Denial::PermissionDenied),
            }),
        };
        let metadata = serde_json::to_string_pretty(&row).unwrap();
        assert!(metadata.contains("18446744073709551615"));
        let status=serde_json::from_value::<CoreStatus>(serde_json::json!({"state":"HEALTHY","accepted_through":u64::MAX,"synced_through":u64::MAX,"rejected_records":0,"incomplete_segments":0,"available_from":0,"retained_records":1})).unwrap();
        let projected = Reply::project(ProtocolReply::JournalPage {
            service_id: Uuid::new_v4(),
            status,
            page: session_core::audit_journal::Page {
                records: vec![row],
                next_cursor: u64::MAX,
                through_cursor: u64::MAX,
                available_from: 0,
                gap: true,
            },
        })
        .unwrap();
        let output = serde_json::to_value(projected).unwrap();
        assert_eq!(output["records"][0]["metadata"], metadata);
        assert_eq!(output["records"][0]["seq"], u64::MAX.to_string());
    }
}
