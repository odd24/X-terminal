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
        scopes: Vec<Scope>,
        lifetime_ms: u64,
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
                scopes,
                lifetime_ms,
            } => {
                !scopes.is_empty()
                    && scopes.len() <= MAX_SCOPES
                    && (1..=MAX_GRANT_MS).contains(lifetime_ms)
                    && scopes.iter().all(|s| match s.target {
                        Target::Connection { connection } => {
                            valid_connection(connection) && s.action != Action::Connect
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
    Ticket {
        ticket_id: Uuid,
        token: Sensitive,
        expires_at_ms: u64,
    },
    Lease(Option<Lease>),
    Audit(AuditPage),
    Ok,
}

#[cfg(test)]
mod tests {
    use super::*;
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
                scopes: vec![s, s],
                lifetime_ms: 1
            }
            .validate()
        );
        assert!(
            !Request::Grant {
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
                scopes: vec![s],
                lifetime_ms: MAX_GRANT_MS
            }
            .validate()
        );
        let reply = Reply::Ticket {
            ticket_id: Uuid::new_v4(),
            token: Sensitive::new("synthetic-secret".into()),
            expires_at_ms: 1,
        };
        assert!(!format!("{reply:?}").contains("synthetic-secret"));
    }
}
