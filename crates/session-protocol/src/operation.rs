//! Exact, typed mutations eligible for a single-operation grant.
use crate::{export, serial, ssh};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_core::{
    access::{Action, Scope, Target},
    authorization::{OperationFingerprint, OperationKey},
    session::{ConnectionRef, ErrorCode, Protocol},
};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "protocol",
    content = "request",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum Operation {
    Ssh2(ssh::Request),
    Serial(serial::Request),
    Export(export::Start),
}
#[derive(Serialize)]
#[serde(
    tag = "protocol",
    content = "request",
    rename_all = "SCREAMING_SNAKE_CASE"
)]
enum Borrowed<'a> {
    Ssh2(&'a ssh::Request),
    Serial(&'a serial::Request),
    Export(&'a export::Start),
}
#[derive(Clone, Copy)]
pub struct Descriptor {
    pub request_id: Uuid,
    pub action: Action,
    pub connection: Option<ConnectionRef>,
    pub profile_id: Option<Uuid>,
    pub protocol: Protocol,
}
impl Descriptor {
    /// The service verifies the live protocol and (for reconnect) original profile
    /// separately. Caller scopes cannot add unrelated capabilities.
    pub fn matches_scopes(self, scopes: &[Scope]) -> bool {
        let connection_scope = self.connection.map(|connection| Scope {
            target: Target::Connection { connection },
            action: self.action,
        });
        let fixed_connect = |scope: &Scope| {
            matches!(scope.target, Target::ProfileRevision { profile_id, revision }
                if !revision.is_nil() && !profile_id.is_nil()
                    && self.profile_id.is_none_or(|id| id == profile_id))
                && scope.action == Action::Connect
        };
        if self.action == Action::Reconnect {
            scopes.len() == 2
                && scopes.iter().any(|s| Some(*s) == connection_scope)
                && scopes.iter().any(fixed_connect)
        } else if self.action == Action::Connect {
            scopes.len() == 1 && fixed_connect(&scopes[0])
        } else {
            scopes.len() == 1 && Some(scopes[0]) == connection_scope
        }
    }
}
fn ssh_descriptor(request: &ssh::Request) -> Option<Descriptor> {
    use ssh::Request::*;
    let (request_id, action, connection, profile_id) = match request {
        Start {
            request_id,
            profile_id,
            ..
        }
        | StartFixed {
            request_id,
            profile_id,
            ..
        } => (*request_id, Action::Connect, None, Some(*profile_id)),
        Reconnect {
            request_id,
            connection,
            ..
        } => (*request_id, Action::Reconnect, Some(*connection), None),
        Write {
            request_id,
            connection,
            ..
        }
        | WriteText {
            request_id,
            connection,
            ..
        } => (*request_id, Action::Write, Some(*connection), None),
        Resize {
            request_id,
            connection,
            ..
        } => (*request_id, Action::Control, Some(*connection), None),
        Exec {
            request_id,
            connection,
            ..
        } => (*request_id, Action::Exec, Some(*connection), None),
        Disconnect {
            request_id,
            connection,
        } => (*request_id, Action::Disconnect, Some(*connection), None),
        ForgetStart {
            request_id,
            connection,
        } => (*request_id, Action::Forget, Some(*connection), None),
        _ => return None,
    };
    Some(Descriptor {
        request_id,
        action,
        connection,
        profile_id,
        protocol: Protocol::Ssh2,
    })
}
fn serial_descriptor(request: &serial::Request) -> Option<Descriptor> {
    use serial::Request::*;
    let (request_id, action, connection, profile_id) = match request {
        Start {
            request_id,
            profile_id,
            ..
        } => (*request_id, Action::Connect, None, Some(*profile_id)),
        StartFixed { target } => (
            target.request_id,
            Action::Connect,
            None,
            Some(target.profile_id),
        ),
        Send {
            request_id,
            connection,
            ..
        }
        | Write {
            request_id,
            connection,
            ..
        } => (*request_id, Action::Write, Some(*connection), None),
        Control {
            request_id,
            connection,
            ..
        } => (*request_id, Action::Control, Some(*connection), None),
        Disconnect {
            request_id,
            connection,
        } => (*request_id, Action::Disconnect, Some(*connection), None),
        ForgetStart {
            request_id,
            connection,
        } => (*request_id, Action::Forget, Some(*connection), None),
        _ => return None,
    };
    Some(Descriptor {
        request_id,
        action,
        connection,
        profile_id,
        protocol: Protocol::Serial,
    })
}
fn key(request: Borrowed<'_>, descriptor: Descriptor) -> Result<OperationKey, ErrorCode> {
    // The temporary includes sensitive text/bytes; never retain it in receipts or Debug.
    let bytes =
        Zeroizing::new(serde_json::to_vec(&request).map_err(|_| ErrorCode::InvalidArgument)?);
    if bytes.len() > crate::MAX_FRAME {
        return Err(ErrorCode::InvalidArgument);
    }
    Ok(OperationKey {
        request_id: descriptor.request_id,
        fingerprint: OperationFingerprint::of_canonical(&bytes),
    })
}
pub fn ssh_key(request: &ssh::Request) -> Result<Option<OperationKey>, ErrorCode> {
    ssh_descriptor(request)
        .map(|d| {
            if !request.validate() {
                return Err(ErrorCode::InvalidArgument);
            }
            // Existing Single Start approval already freezes ProfileRevision in
            // its scope. StartFixed separately requires that exact scope at dispatch.
            if let ssh::Request::StartFixed {
                profile_id,
                request_id,
                cols,
                rows,
                ..
            } = request
            {
                key(
                    Borrowed::Ssh2(&ssh::Request::Start {
                        profile_id: *profile_id,
                        request_id: *request_id,
                        cols: *cols,
                        rows: *rows,
                    }),
                    d,
                )
            } else {
                key(Borrowed::Ssh2(request), d)
            }
        })
        .transpose()
}
pub fn serial_key(request: &serial::Request) -> Result<Option<OperationKey>, ErrorCode> {
    serial_descriptor(request)
        .map(|d| {
            if !request.validate() {
                return Err(ErrorCode::InvalidArgument);
            }
            // The existing Single recipe binds the inventory and device. The
            // service requires the exact profile revision scope independently.
            if let serial::Request::StartFixed { target } = request {
                key(
                    Borrowed::Serial(&serial::Request::Start {
                        profile_id: target.profile_id,
                        request_id: target.request_id,
                        revision: target.inventory_revision,
                        device_id: target.device_id,
                    }),
                    d,
                )
            } else {
                key(Borrowed::Serial(request), d)
            }
        })
        .transpose()
}
impl Operation {
    pub fn descriptor(&self) -> Option<Descriptor> {
        match self {
            Self::Ssh2(ssh::Request::StartFixed { .. }) => None,
            Self::Serial(serial::Request::StartFixed { .. }) => None,
            Self::Ssh2(r) => ssh_descriptor(r),
            Self::Serial(r) => serial_descriptor(r),
            Self::Export(request) => Some(Descriptor {
                request_id: request.request_id,
                action: Action::Export,
                connection: Some(request.retained_ended_output.connection),
                profile_id: None,
                protocol: request.retained_ended_output.protocol,
            }),
        }
    }
    pub fn key(&self) -> Result<OperationKey, ErrorCode> {
        match self {
            Self::Ssh2(ssh::Request::StartFixed { .. }) => Err(ErrorCode::InvalidArgument),
            Self::Serial(serial::Request::StartFixed { .. }) => Err(ErrorCode::InvalidArgument),
            Self::Ssh2(r) => ssh_key(r),
            Self::Serial(r) => serial_key(r),
            Self::Export(request) => {
                if !request.validate() {
                    return Err(ErrorCode::InvalidArgument);
                }
                key(
                    Borrowed::Export(request),
                    self.descriptor().ok_or(ErrorCode::InvalidArgument)?,
                )
                .map(Some)
            }
        }?
        .ok_or(ErrorCode::InvalidArgument)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Sensitive, SensitiveBytes};
    fn connection() -> ConnectionRef {
        ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 2,
        }
    }
    #[test]
    fn fixed_serial_start_preserves_device_single_key_and_excludes_queries() {
        let target = serial::ConnectTarget {
            profile_id: Uuid::new_v4(),
            profile_revision: Uuid::new_v4(),
            inventory_revision: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            request_id: Uuid::new_v4(),
        };
        let existing = serial::Request::Start {
            profile_id: target.profile_id,
            request_id: target.request_id,
            revision: target.inventory_revision,
            device_id: target.device_id,
        };
        let start = serial::Request::StartFixed { target };
        assert_eq!(serial_key(&start).unwrap(), serial_key(&existing).unwrap());
        let changed = serial::Request::StartFixed {
            target: serial::ConnectTarget {
                device_id: Uuid::new_v4(),
                ..target
            },
        };
        assert_ne!(serial_key(&start).unwrap(), serial_key(&changed).unwrap());
        assert!(Operation::Serial(start).key().is_err());
        assert_eq!(
            serial_key(&serial::Request::ConnectStatus { target }).unwrap(),
            None
        );
    }
    #[test]
    fn fixed_start_consumes_existing_single_key_but_is_not_a_grant_recipe() {
        let profile_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let revision = Uuid::new_v4();
        let start = ssh::Request::Start {
            profile_id,
            request_id,
            cols: 80,
            rows: 24,
        };
        let fixed = ssh::Request::StartFixed {
            profile_id,
            revision,
            request_id,
            cols: 80,
            rows: 24,
        };
        assert_eq!(ssh_key(&fixed).unwrap(), ssh_key(&start).unwrap());
        assert_eq!(
            ssh_key(&ssh::Request::ConnectStatus {
                profile_id,
                revision,
                request_id
            })
            .unwrap(),
            None
        );
        let recipe = Operation::Ssh2(fixed);
        assert!(recipe.descriptor().is_none());
        assert!(recipe.key().is_err());
    }
    #[test]
    fn canonical_typed_operations_cover_mutations_and_every_parameter_is_bound() {
        let c = connection();
        let id = Uuid::new_v4();
        let profile = Uuid::new_v4();
        let mut operations = vec![
            Operation::Ssh2(ssh::Request::Start {
                profile_id: profile,
                request_id: id,
                cols: 80,
                rows: 24,
            }),
            Operation::Ssh2(ssh::Request::Reconnect {
                connection: c,
                request_id: id,
                cols: 80,
                rows: 24,
            }),
            Operation::Ssh2(ssh::Request::Write {
                connection: c,
                request_id: id,
                bytes: SensitiveBytes::new(vec![0, 255]),
            }),
            Operation::Ssh2(ssh::Request::WriteText {
                connection: c,
                request_id: id,
                text: Sensitive::new("命令\r\n".into()),
            }),
            Operation::Ssh2(ssh::Request::Exec {
                connection: c,
                request_id: id,
                command: Sensitive::new("命令".into()),
                timeout_ms: 10,
                max_output_bytes: 32,
            }),
            Operation::Ssh2(ssh::Request::Resize {
                connection: c,
                request_id: id,
                cols: 80,
                rows: 24,
            }),
            Operation::Ssh2(ssh::Request::Disconnect {
                connection: c,
                request_id: id,
            }),
            Operation::Ssh2(ssh::Request::ForgetStart {
                connection: c,
                request_id: id,
            }),
            Operation::Serial(serial::Request::Start {
                profile_id: profile,
                request_id: id,
                revision: Uuid::new_v4(),
                device_id: Uuid::new_v4(),
            }),
            Operation::Serial(serial::Request::Send {
                connection: c,
                request_id: id,
                content: Sensitive::new("命令".into()),
                format: serial::Format::Text,
                ending: serial::Ending::None,
                pace: serial::Pace {
                    chunk_bytes: 1,
                    interval_ms: 0,
                },
            }),
            Operation::Serial(serial::Request::Write {
                connection: c,
                request_id: id,
                bytes: SensitiveBytes::new(vec![0, 255]),
            }),
            Operation::Serial(serial::Request::Control {
                connection: c,
                request_id: id,
                line: serial::Line::Dtr,
                asserted: false,
            }),
            Operation::Serial(serial::Request::Disconnect {
                connection: c,
                request_id: id,
            }),
            Operation::Serial(serial::Request::ForgetStart {
                connection: c,
                request_id: id,
            }),
        ];
        let keys: Vec<_> = operations.iter().map(|op| op.key().unwrap()).collect();
        for (index, operation) in operations.iter_mut().enumerate() {
            let bytes = serde_json::to_vec(operation).unwrap();
            assert_eq!(
                OperationFingerprint::of_canonical(&bytes),
                keys[index].fingerprint
            );
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            // Every serialized leaf (including protocol, action, target, pacing, limits
            // and payload) contributes to the same key used by actual dispatch.
            fn change_leaves(value: &serde_json::Value, original: &[u8]) {
                fn paths(v: &serde_json::Value, prefix: String, out: &mut Vec<String>) {
                    match v {
                        serde_json::Value::Object(map) => {
                            for (k, v) in map {
                                paths(v, format!("{prefix}/{k}"), out);
                            }
                        }
                        serde_json::Value::Array(list) => {
                            for (k, v) in list.iter().enumerate() {
                                paths(v, format!("{prefix}/{k}"), out);
                            }
                        }
                        _ => out.push(prefix),
                    }
                }
                let mut leaves = vec![];
                paths(value, String::new(), &mut leaves);
                for path in leaves {
                    let mut changed = value.clone();
                    let leaf = changed.pointer_mut(&path).unwrap();
                    *leaf = match leaf {
                        serde_json::Value::Bool(b) => (!*b).into(),
                        serde_json::Value::Number(n) => (n.as_u64().unwrap() + 1).into(),
                        serde_json::Value::String(s) => format!("{s}x").into(),
                        _ => panic!(),
                    };
                    if let Ok(changed) = serde_json::from_value::<Operation>(changed)
                        && let Ok(key) = changed.key()
                    {
                        assert_ne!(
                            key.fingerprint,
                            OperationFingerprint::of_canonical(original),
                            "{path}"
                        );
                    }
                }
            }
            change_leaves(&value, &bytes);
            let descriptor = operation.descriptor().unwrap();
            let mut scopes = if descriptor.action == Action::Connect {
                vec![]
            } else {
                vec![Scope {
                    target: Target::Connection { connection: c },
                    action: descriptor.action,
                }]
            };
            if matches!(descriptor.action, Action::Connect | Action::Reconnect) {
                scopes.push(Scope {
                    target: Target::ProfileRevision {
                        profile_id: profile,
                        revision: Uuid::new_v4(),
                    },
                    action: Action::Connect,
                });
            }
            assert!(descriptor.matches_scopes(&scopes));
            scopes.push(Scope {
                target: Target::Connection { connection: c },
                action: Action::Read,
            });
            assert!(!descriptor.matches_scopes(&scopes));
        }
        for i in 0..keys.len() {
            for j in 0..i {
                assert_ne!(keys[i], keys[j]);
            }
        }
    }
    #[test]
    fn queries_legacy_close_and_authentication_cannot_be_single_operations() {
        let c = connection();
        for request in [
            ssh::Request::Close { connection: c },
            ssh::Request::Forget { connection: c },
            ssh::Request::InputStatus {
                connection: c,
                request_id: Uuid::new_v4(),
            },
            ssh::Request::Authenticate {
                connection: c,
                challenge_id: Uuid::new_v4(),
                use_saved: true,
                password: None,
            },
            ssh::Request::ExecCancel {
                connection: c,
                task_id: Uuid::new_v4(),
            },
        ] {
            assert!(Operation::Ssh2(request).key().is_err());
        }
        for request in [
            serial::Request::Inventory {},
            serial::Request::Close { connection: c },
            serial::Request::Forget { connection: c },
            serial::Request::DisconnectStatus {
                connection: c,
                request_id: Uuid::new_v4(),
            },
        ] {
            assert!(Operation::Serial(request).key().is_err());
        }
        let value = serde_json::json!({"protocol":"SSH2","request":{"op":"disconnect","connection":c,"request_id":Uuid::new_v4()},"fingerprint":"0".repeat(64)});
        assert!(serde_json::from_value::<Operation>(value).is_err());
    }
}
