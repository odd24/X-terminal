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
    GrantProtected {
        request_id: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
        form: ProtectedForm,
        redaction: Redaction,
    },
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
    pub redaction: Option<&'a Redaction>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProtectedForm {
    Scoped {},
    TimedTask {
        task_id: Uuid,
        label: String,
    },
    SingleOperation {
        operation: Box<crate::operation::Operation>,
    },
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Redaction {
    pub sensitive_fields: bool,
    pub literals: Vec<Sensitive>,
}
impl Redaction {
    pub fn valid(&self) -> bool {
        (self.sensitive_fields || !self.literals.is_empty())
            && self.literals.len() <= session_core::redaction::MAX_LITERALS
            && self.literals.iter().all(|v| {
                !v.expose().is_empty()
                    && v.expose().len() <= session_core::redaction::MAX_LITERAL_BYTES
            })
            && self.literals.iter().enumerate().all(|(i, v)| {
                !self.literals[..i]
                    .iter()
                    .any(|old| old.expose() == v.expose())
            })
    }
}

#[cfg(test)]
mod protected_contract_tests {
    use super::*;
    #[test]
    fn protected_grants_reject_empty_duplicate_oversized_or_unknown_rules_without_debug_leakage() {
        let c = ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let base = serde_json::json!({"op":"grant_protected", "request_id":Uuid::new_v4(), "scopes":[{"target":{"kind":"connection","connection":c},"action":"READ"}], "lifetime_ms":1000, "form":{"kind":"scoped"}, "redaction":{"sensitive_fields":false,"literals":["synthetic-secret"]}});
        // Construct typed baseline, so wire enum spelling remains driven by serde.
        let typed = Request::GrantProtected {
            request_id: Uuid::new_v4(),
            scopes: vec![Scope {
                target: Target::Connection { connection: c },
                action: Action::Read,
            }],
            lifetime_ms: 1000,
            form: ProtectedForm::Scoped {},
            redaction: Redaction {
                sensitive_fields: false,
                literals: vec![Sensitive::new("synthetic-secret".into())],
            },
        };
        assert!(typed.validate());
        assert!(!format!("{typed:?}").contains("synthetic-secret"));
        let mut wire = serde_json::to_value(&typed).unwrap();
        assert_eq!(wire["op"], base["op"]);
        for literals in [
            serde_json::json!([]),
            serde_json::json!([""]),
            serde_json::json!(["duplicate", "duplicate"]),
            serde_json::json!(["x".repeat(257)]),
            serde_json::json!((0..33).map(|i| i.to_string()).collect::<Vec<_>>()),
        ] {
            wire["redaction"]["literals"] = literals;
            assert!(
                !serde_json::from_value::<Request>(wire.clone())
                    .unwrap()
                    .validate()
            );
        }
        let mut wire = serde_json::to_value(&typed).unwrap();
        wire["redaction"]["policy_id"] = serde_json::json!(Uuid::new_v4());
        assert!(serde_json::from_value::<Request>(wire).is_err());
        let mut wire = serde_json::to_value(&typed).unwrap();
        wire["form"]["auto_execute"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Request>(wire).is_err());
        let Request::GrantProtected {
            mut scopes,
            redaction,
            ..
        } = typed
        else {
            panic!()
        };
        scopes[0].action = Action::Write;
        assert!(
            !Request::GrantProtected {
                request_id: Uuid::new_v4(),
                scopes,
                lifetime_ms: 1000,
                form: ProtectedForm::Scoped {},
                redaction
            }
            .validate()
        );
    }
}
impl GrantSpec<'_> {
    pub fn definition(self) -> Result<session_core::pairing::protection::Definition, ErrorCode> {
        Ok(session_core::pairing::protection::Definition {
            scopes: self.scopes.to_vec(),
            form: self.form,
            redaction: self
                .redaction
                .map(|r| {
                    session_core::redaction::Policy::new(
                        r.literals.iter().map(|v| v.expose().to_owned()).collect(),
                        r.sensitive_fields,
                    )
                    .map(std::sync::Arc::new)
                })
                .transpose()?,
        })
    }
}
impl Request {
    pub fn operation(&self) -> Option<&crate::operation::Operation> {
        match self {
            Self::GrantOperation { operation, .. }
            | Self::GrantProtected {
                form: ProtectedForm::SingleOperation { operation },
                ..
            } => Some(operation),
            _ => None,
        }
    }
    pub fn grant_spec(&self) -> Result<Option<GrantSpec<'_>>, ErrorCode> {
        let (request_id, scopes, lifetime_ms, form, redaction) = match self {
            Self::Grant {
                request_id,
                scopes,
                lifetime_ms,
            } => (request_id, scopes, lifetime_ms, Form::Scoped, None),
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
                None,
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
                    None,
                )
            }
            Self::GrantProtected {
                request_id,
                scopes,
                lifetime_ms,
                form,
                redaction,
            } => {
                if !redaction.valid()
                    || !scopes
                        .iter()
                        .any(|s| matches!(s.action, Action::Read | Action::Exec))
                {
                    return Err(ErrorCode::InvalidArgument);
                }
                let form = match form {
                    ProtectedForm::Scoped {} => Form::Scoped,
                    ProtectedForm::TimedTask { task_id, label } => Form::TimedTask {
                        task_id: *task_id,
                        label: label.clone(),
                    },
                    ProtectedForm::SingleOperation { operation } => {
                        if !operation
                            .descriptor()
                            .is_some_and(|d| d.matches_scopes(scopes))
                        {
                            return Err(ErrorCode::InvalidArgument);
                        }
                        Form::SingleOperation {
                            operation: operation.key()?,
                        }
                    }
                };
                (request_id, scopes, lifetime_ms, form, Some(redaction))
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
            redaction,
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
            }
            | Self::GrantProtected {
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
                protection: None,
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
                protection: None,
            },
            token: Some(Sensitive::new("a".repeat(64))),
        };
        assert!(serde_json::to_vec(&full).unwrap().len() < crate::MAX_FRAME / 2);
    }
}
