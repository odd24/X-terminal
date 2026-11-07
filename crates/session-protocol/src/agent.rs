//! Agent management/ownership contract. Transport actions retain their own dispatch checks.
use crate::Sensitive;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::{access::*, session::ConnectionRef};
use session_core::{authorization::Form, session::ErrorCode};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Grant {
        request_id: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
    },
    GrantTask {
        request_id: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
        task_id: Uuid,
        label: String,
    },
    GrantOperation {
        request_id: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
        operation: Box<crate::operation::Operation>,
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
pub struct GrantSpec<'a> {
    pub request_id: Uuid,
    pub scopes: &'a [Scope],
    pub lifetime_ms: u64,
    pub form: Form,
}
impl Request {
    pub fn grant_spec(&self) -> Result<Option<GrantSpec<'_>>, ErrorCode> {
        let (request_id, scopes, lifetime_ms, form) = match self {
            Self::Grant {
                request_id,
                scopes,
                lifetime_ms,
            } => (request_id, scopes, lifetime_ms, Form::Scoped),
            Self::GrantTask {
                request_id,
                scopes,
                lifetime_ms,
                task_id,
                label,
            } => (
                request_id,
                scopes,
                lifetime_ms,
                Form::TimedTask {
                    task_id: *task_id,
                    label: label.clone(),
                },
            ),
            Self::GrantOperation {
                request_id,
                scopes,
                lifetime_ms,
                operation,
            } => {
                if !operation
                    .descriptor()
                    .is_some_and(|d| d.matches_scopes(scopes))
                {
                    return Err(ErrorCode::InvalidArgument);
                }
                (
                    request_id,
                    scopes,
                    lifetime_ms,
                    Form::SingleOperation {
                        operation: operation.key()?,
                    },
                )
            }
            _ => return Ok(None),
        };
        if !form.valid_for(scopes) {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(Some(GrantSpec {
            request_id: *request_id,
            scopes,
            lifetime_ms: *lifetime_ms,
            form,
        }))
    }
    pub fn validate(&self) -> bool {
        match self {
            Self::Grant {
                request_id,
                scopes,
                lifetime_ms,
            }
            | Self::GrantTask {
                request_id,
                scopes,
                lifetime_ms,
                ..
            }
            | Self::GrantOperation {
                request_id,
                scopes,
                lifetime_ms,
                ..
            } => {
                !request_id.is_nil()
                    && self.grant_spec().is_ok()
                    && !scopes.is_empty()
                    && scopes.len() <= MAX_SCOPES
                    && (1..=MAX_GRANT_MS).contains(lifetime_ms)
                    && scopes.iter().all(|s| match s.target {
                        Target::OutputWindow { connection, window } => {
                            valid_connection(connection)
                                && window.valid()
                                && s.action == Action::Read
                        }
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
    fn task_and_single_grants_require_explicit_valid_metadata_and_minimum_scopes() {
        let c = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let scope = Scope {
            target: Target::Connection { connection: c },
            action: Action::Write,
        };
        for label in ["", " leading", "trailing ", "line\nfeed", &"中".repeat(86)] {
            assert!(
                !Request::GrantTask {
                    request_id: Uuid::new_v4(),
                    scopes: vec![scope],
                    lifetime_ms: 100,
                    task_id: Uuid::new_v4(),
                    label: label.into()
                }
                .validate()
            );
        }
        assert!(
            !Request::GrantTask {
                request_id: Uuid::new_v4(),
                scopes: vec![scope],
                lifetime_ms: 100,
                task_id: Uuid::nil(),
                label: "任务".into()
            }
            .validate()
        );
        let operation = || {
            Box::new(crate::operation::Operation::Ssh2(
                crate::ssh::Request::WriteText {
                    connection: c,
                    request_id: Uuid::new_v4(),
                    text: Sensitive::new("合成正文".into()),
                },
            ))
        };
        let valid = Request::GrantOperation {
            request_id: Uuid::new_v4(),
            scopes: vec![scope],
            lifetime_ms: 100,
            operation: operation(),
        };
        assert!(valid.validate());
        assert!(!format!("{valid:?}").contains("合成正文"));
        for scopes in [
            vec![],
            vec![Scope {
                action: Action::Read,
                ..scope
            }],
            vec![
                scope,
                Scope {
                    action: Action::Read,
                    ..scope
                },
            ],
        ] {
            assert!(
                !Request::GrantOperation {
                    request_id: Uuid::new_v4(),
                    scopes,
                    lifetime_ms: 100,
                    operation: operation()
                }
                .validate()
            );
        }
        for value in [
            serde_json::json!({"op":"grant_operation", "request_id":Uuid::new_v4(), "scopes":[scope], "lifetime_ms":100, "fingerprint":"0".repeat(64)}),
            serde_json::json!({"op":"grant_task", "request_id":Uuid::new_v4(), "scopes":[scope], "lifetime_ms":100, "task_id":Uuid::new_v4(), "label":"任务", "role":"desktop"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }
    #[test]
    fn output_window_grants_are_strictly_read_only_and_bind_valid_time_and_generation() {
        let c = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let scope = Scope {
            target: Target::OutputWindow {
                connection: c,
                window: session_core::context::TimeWindow {
                    from_ms: 10,
                    until_ms: 20,
                },
            },
            action: Action::Read,
        };
        for action in [
            Action::Read,
            Action::Write,
            Action::Connect,
            Action::Disconnect,
            Action::Forget,
        ] {
            let request = Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![Scope { action, ..scope }],
                lifetime_ms: 100,
            };
            assert_eq!(request.validate(), action == Action::Read);
        }
        let mut value = serde_json::to_value(Request::Grant {
            request_id: Uuid::new_v4(),
            scopes: vec![scope],
            lifetime_ms: 100,
        })
        .unwrap();
        value["scopes"][0]["target"]["window"]["until_ms"] = 10.into();
        assert!(
            !serde_json::from_value::<Request>(value.clone())
                .unwrap()
                .validate()
        );
        value["scopes"][0]["target"]["window"]["future"] = true.into();
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    #[test]
    fn reconnect_is_an_independent_connection_action_never_a_profile_action() {
        let c = session_core::session::ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        for (target, valid) in [
            (Target::Connection { connection: c }, true),
            (
                Target::Profile {
                    profile_id: Uuid::new_v4(),
                },
                false,
            ),
            (
                Target::ProfileRevision {
                    profile_id: Uuid::new_v4(),
                    revision: Uuid::new_v4(),
                },
                false,
            ),
        ] {
            let request = Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![Scope {
                    target,
                    action: Action::Reconnect,
                }],
                lifetime_ms: 1000,
            };
            assert_eq!(request.validate(), valid);
            let value = serde_json::to_value(&request).unwrap();
            assert!(serde_json::from_value::<Request>(value).is_ok());
        }
    }
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
                form: None,
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
                form: None,
            },
            token: Some(Sensitive::new("a".repeat(64))),
        };
        assert!(serde_json::to_vec(&full).unwrap().len() < crate::MAX_FRAME / 2);
    }
}
