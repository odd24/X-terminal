//! Agent management/ownership contract. Transport actions retain their own dispatch checks.
use crate::Sensitive;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::{access::*, session::ConnectionRef};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Grant {
        request_id: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
    },
    GrantStatus {
        request_id: Uuid,
    },
    GrantList {},
    GrantRevoke {
        request_id: Uuid,
    },
    Acquire {
        connection: ConnectionRef,
        lifetime_ms: u64,
    },
    Release {
        connection: ConnectionRef,
        lease_id: Uuid,
    },
    Lease {
        connection: ConnectionRef,
    },
    Takeover {
        connection: ConnectionRef,
    },
    Audit {
        cursor: u64,
        limit: usize,
    },
}
impl Request {
    pub fn validate(&self) -> bool {
        match self {
            Self::Grant {
                request_id,
                scopes,
                lifetime_ms,
            } => {
                !request_id.is_nil()
                    && !scopes.is_empty()
                    && scopes.len() <= MAX_SCOPES
                    && (1..=MAX_GRANT_MS).contains(lifetime_ms)
                    && scopes.iter().all(|s| match s.target {
                        Target::Connection { connection } => {
                            valid_connection(connection) && s.action != Action::Connect
                        }
                        Target::ProfileRevision {
                            profile_id,
                            revision,
                        } => {
                            !profile_id.is_nil()
                                && !revision.is_nil()
                                && s.action == Action::Connect
                        }
                        Target::Profile { profile_id } => {
                            !profile_id.is_nil() && s.action == Action::Connect
                        }
                    })
                    && scopes
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == scopes.len()
            }
            Self::GrantStatus { request_id } | Self::GrantRevoke { request_id } => {
                !request_id.is_nil()
            }
            Self::GrantList {} => true,
            Self::Acquire {
                connection,
                lifetime_ms,
            } => valid_connection(*connection) && (1..=MAX_LEASE_MS).contains(lifetime_ms),
            Self::Release {
                connection,
                lease_id,
            } => valid_connection(*connection) && !lease_id.is_nil(),
            Self::Lease { connection } | Self::Takeover { connection } => {
                valid_connection(*connection)
            }
            Self::Audit { limit, .. } => (1..=128).contains(limit),
        }
    }
}
fn valid_connection(c: ConnectionRef) -> bool {
    !c.connection_id.0.is_nil() && c.generation != 0
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Reply {
    Grant {
        receipt: session_core::pairing::grants::View,
        token: Option<Sensitive>,
    },
    GrantList(Vec<session_core::pairing::grants::Summary>),
    Lease(Option<Lease>),
    Audit(AuditPage),
    Ok,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_revision_requires_explicit_non_nil_version_and_connect_only() {
        let profile_id = Uuid::new_v4();
        let revision = Uuid::new_v4();
        for (version, action, valid) in [
            (revision, Action::Connect, true),
            (Uuid::nil(), Action::Connect, false),
            (revision, Action::Control, false),
        ] {
            let request = Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![Scope {
                    target: Target::ProfileRevision {
                        profile_id,
                        revision: version,
                    },
                    action,
                }],
                lifetime_ms: 1000,
            };
            assert_eq!(request.validate(), valid);
        }
        let value = serde_json::json!({"op":"grant","request_id":Uuid::new_v4(),"scopes":[{"target":{"kind":"profile_revision","profile_id":profile_id},"action":"CONNECT"}],"lifetime_ms":1000});
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    #[test]
    fn strict_agent_contract_rejects_role_paths_duplicates_and_invalid_ranges() {
        for value in [
            serde_json::json!({"op":"takeover","connection":{"connection_id":Uuid::new_v4(),"generation":1},"role":"desktop"}),
            serde_json::json!({"op":"audit","cursor":0,"limit":1,"path":"secret"}),
            serde_json::json!({"op":"grant","scopes":[],"lifetime_ms":1,"client_id":Uuid::new_v4()}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        let c = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let s = Scope {
            target: Target::Connection { connection: c },
            action: Action::Read,
        };
        assert!(
            !Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![s, s],
                lifetime_ms: 1
            }
            .validate()
        );
        assert!(
            !Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![Scope {
                    action: Action::Connect,
                    ..s
                }],
                lifetime_ms: 1
            }
            .validate()
        );
        assert!(
            !Request::Acquire {
                connection: c,
                lifetime_ms: MAX_LEASE_MS + 1
            }
            .validate()
        );
        assert!(
            !Request::Release {
                connection: c,
                lease_id: Uuid::nil()
            }
            .validate()
        );
        assert!(
            !Request::Audit {
                cursor: 0,
                limit: 129
            }
            .validate()
        );
        assert!(
            Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![s],
                lifetime_ms: MAX_GRANT_MS
            }
            .validate()
        );
        let reply = Reply::Grant {
            receipt: session_core::pairing::grants::View {
                summary: session_core::pairing::grants::Summary {
                    request_id: Uuid::new_v4(),
                    ticket_id: Uuid::new_v4(),
                    expires_at_ms: 1,
                    state: session_core::pairing::grants::State::Active,
                    effective_scope_count: 1,
                },
                approved_scopes: vec![s],
                effective_scopes: vec![s],
            },
            token: Some(Sensitive::new("synthetic-secret".into())),
        };
        assert!(!format!("{reply:?}").contains("synthetic-secret"));
    }
    #[test]
    fn management_requests_are_strict_and_worst_case_replies_stay_bounded() {
        use session_core::pairing::grants::*;
        for input in [
            serde_json::json!({"op":"grant_list","token":"no"}),
            serde_json::json!({"op":"grant_status","request_id":Uuid::new_v4(),"role":"desktop"}),
            serde_json::json!({"op":"grant","scopes":[],"lifetime_ms":1}),
        ] {
            assert!(serde_json::from_value::<Request>(input).is_err());
        }
        assert!(
            !Request::GrantStatus {
                request_id: Uuid::nil()
            }
            .validate()
        );
        assert!(
            !Request::GrantRevoke {
                request_id: Uuid::nil()
            }
            .validate()
        );
        let summary = Summary {
            request_id: Uuid::new_v4(),
            ticket_id: Uuid::new_v4(),
            expires_at_ms: u64::MAX,
            state: State::Active,
            effective_scope_count: MAX_SCOPES,
        };
        let list = Reply::GrantList(vec![summary.clone(); MAX_GRANT_RECEIPTS]);
        let json = serde_json::to_vec(&list).unwrap();
        assert!(json.len() < crate::MAX_FRAME / 2);
        assert!(!String::from_utf8(json).unwrap().contains("token"));
        let scope = Scope {
            target: Target::Connection {
                connection: ConnectionRef {
                    connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
                    generation: u64::MAX,
                },
            },
            action: Action::Read,
        };
        let full = Reply::Grant {
            receipt: View {
                summary,
                approved_scopes: vec![scope; MAX_SCOPES],
                effective_scopes: vec![scope; MAX_SCOPES],
            },
            token: Some(Sensitive::new("a".repeat(64))),
        };
        assert!(serde_json::to_vec(&full).unwrap().len() < crate::MAX_FRAME / 2);
    }
}
