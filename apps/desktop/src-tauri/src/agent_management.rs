//! Desktop management only. Agent bearer tokens never cross the WebView boundary.
use serde::{Deserialize, Serialize};
use session_core::{
    access::{AuditPage, Lease, Scope},
    pairing::grants::{Summary, View},
    session::ConnectionRef,
};
use session_protocol::agent;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
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
        operation: Box<session_protocol::operation::Operation>,
    },
    GrantStatus {
        request_id: Uuid,
    },
    GrantList {},
    GrantRevoke {
        request_id: Uuid,
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
    pub fn into_protocol(self) -> Result<agent::Request, String> {
        let request = match self {
            Self::Grant {
                request_id,
                scopes,
                lifetime_ms,
            } => agent::Request::Grant {
                request_id,
                scopes,
                lifetime_ms,
            },
            Self::GrantStatus { request_id } => agent::Request::GrantStatus { request_id },
            Self::GrantTask {
                request_id,
                scopes,
                lifetime_ms,
                task_id,
                label,
            } => agent::Request::GrantTask {
                request_id,
                scopes,
                lifetime_ms,
                task_id,
                label,
            },
            Self::GrantOperation {
                request_id,
                scopes,
                lifetime_ms,
                operation,
            } => agent::Request::GrantOperation {
                request_id,
                scopes,
                lifetime_ms,
                operation,
            },
            Self::GrantList {} => agent::Request::GrantList {},
            Self::GrantRevoke { request_id } => agent::Request::GrantRevoke { request_id },
            Self::Lease { connection } => agent::Request::Lease { connection },
            Self::Takeover { connection } => agent::Request::Takeover { connection },
            Self::Audit { cursor, limit } => agent::Request::Audit { cursor, limit },
        };
        if !request.validate() {
            return Err("INVALID_AGENT_REQUEST".into());
        }
        Ok(request)
    }
}

// Intentionally distinct from protocol::Reply: adding a protocol secret cannot
// accidentally make it serializable through this native command.
#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Reply {
    Grant(View),
    GrantList(Vec<Summary>),
    Lease(Option<Lease>),
    Audit(AuditPage),
    Ok,
}
impl From<agent::Reply> for Reply {
    fn from(reply: agent::Reply) -> Self {
        match reply {
            agent::Reply::Grant { receipt, token: _ } => Self::Grant(receipt),
            agent::Reply::GrantList(list) => Self::GrantList(list),
            agent::Reply::Lease(lease) => Self::Lease(lease),
            agent::Reply::Audit(page) => Self::Audit(page),
            agent::Reply::Ok => Self::Ok,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::{
        access::{Action, Target},
        pairing::grants::State,
        session::ConnectionId,
    };
    #[test]
    fn new_forms_require_complete_typed_body_or_valid_task_without_identity_override() {
        let connection = serde_json::json!({"connection_id":Uuid::new_v4(),"generation":1});
        let scope = serde_json::json!({"target":{"kind":"connection","connection":connection},"action":"DISCONNECT"});
        let task = serde_json::json!({"op":"grant_task","request_id":Uuid::new_v4(),"task_id":Uuid::new_v4(),"label":"合成有限任务","scopes":[scope],"lifetime_ms":1000});
        assert!(
            serde_json::from_value::<Request>(task.clone())
                .unwrap()
                .into_protocol()
                .is_ok()
        );
        let single = serde_json::json!({"op":"grant_operation","request_id":Uuid::new_v4(),"operation":{"protocol":"SSH2","request":{"op":"disconnect","connection":connection,"request_id":Uuid::new_v4()}},"scopes":[scope],"lifetime_ms":1000});
        assert!(
            serde_json::from_value::<Request>(single.clone())
                .unwrap()
                .into_protocol()
                .is_ok()
        );
        for mut value in [task, single.clone()] {
            value["token"] = "synthetic-forbidden".into();
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        let mut invalid = single.clone();
        invalid["operation"]["request"] = serde_json::json!({"op":"authenticate","connection":connection,"challenge_id":Uuid::new_v4(),"use_saved":true,"password":null});
        assert!(
            serde_json::from_value::<Request>(invalid)
                .unwrap()
                .into_protocol()
                .is_err()
        );
        let mut invalid = single;
        invalid.as_object_mut().unwrap().remove("operation");
        invalid["fingerprint"] = "0".repeat(64).into();
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }

    #[test]
    fn new_form_projection_keeps_only_receipt_metadata_and_never_the_bearer() {
        use session_core::authorization::{Form, OperationFingerprint, OperationKey};
        for form in [
            Form::TimedTask {
                task_id: Uuid::new_v4(),
                label: "合成任务".into(),
            },
            Form::SingleOperation {
                operation: OperationKey {
                    request_id: Uuid::new_v4(),
                    fingerprint: OperationFingerprint::of_canonical(b"synthetic-private-body"),
                },
            },
        ] {
            let view = View {
                summary: Summary {
                    request_id: Uuid::new_v4(),
                    ticket_id: Uuid::new_v4(),
                    expires_at_ms: 1000,
                    state: State::Active,
                    effective_scope_count: 0,
                },
                approved_scopes: vec![],
                effective_scopes: vec![],
                form: Some(Box::new(form.clone())),
            };
            let reply = Reply::from(agent::Reply::Grant {
                receipt: view,
                token: Some(session_protocol::Sensitive::new(
                    "synthetic-private-bearer".into(),
                )),
            });
            let wire = serde_json::to_value(&reply).unwrap();
            assert_eq!(wire["data"]["form"], serde_json::to_value(form).unwrap());
            let text = serde_json::to_string(&reply).unwrap();
            assert!(!text.contains("synthetic-private-body"));
            assert!(!text.contains("synthetic-private-bearer"));
            assert!(!text.contains("token"));
        }
    }

    #[test]
    fn webview_cannot_supply_identity_secret_paths_or_agent_lease_actions() {
        let connection = serde_json::json!({"connection_id":Uuid::new_v4(),"generation":1});
        for value in [
            serde_json::json!({"op":"grant_list","role":"desktop"}),
            serde_json::json!({"op":"grant_status","request_id":Uuid::new_v4(),"token":"secret"}),
            serde_json::json!({"op":"audit","cursor":0,"limit":1,"path":"file"}),
            serde_json::json!({"op":"acquire","connection":connection,"lifetime_ms":1000}),
            serde_json::json!({"op":"release","connection":connection,"lease_id":Uuid::new_v4()}),
            serde_json::json!({"op":"grant","request_id":Uuid::new_v4(),"scopes":[],"lifetime_ms":1,"client_id":Uuid::new_v4()}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        for request in [
            Request::GrantStatus {
                request_id: Uuid::nil(),
            },
            Request::Audit {
                cursor: 0,
                limit: 129,
            },
            Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![],
                lifetime_ms: 1,
            },
        ] {
            assert!(request.into_protocol().is_err());
        }
    }

    #[test]
    fn native_projection_drops_token_preserving_current_and_approved_scopes() {
        let scope = Scope {
            target: Target::Connection {
                connection: ConnectionRef {
                    connection_id: ConnectionId(Uuid::new_v4()),
                    generation: 1,
                },
            },
            action: Action::Write,
        };
        let view = View {
            summary: Summary {
                request_id: Uuid::new_v4(),
                ticket_id: Uuid::new_v4(),
                expires_at_ms: 123,
                state: State::Active,
                effective_scope_count: 0,
            },
            approved_scopes: vec![scope],
            effective_scopes: vec![],
            form: None,
        };
        let before = serde_json::to_value(&view).unwrap();
        let reply = Reply::from(agent::Reply::Grant {
            receipt: view,
            token: Some(session_protocol::Sensitive::new(
                "synthetic-bearer-secret".into(),
            )),
        });
        let output = serde_json::to_value(&reply).unwrap();
        assert_eq!(output["data"], before);
        let serialized = serde_json::to_string(&reply).unwrap();
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("synthetic-bearer-secret"));
        assert!(!format!("{reply:?}").contains("synthetic-bearer-secret"));
    }
}
