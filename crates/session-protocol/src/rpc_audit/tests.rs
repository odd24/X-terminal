use super::*;
use session_core::{
    rpc_audit::{Origin, OriginKind, Phase, Ring, Time},
    session::ConnectionId,
};
fn connection() -> ConnectionRef {
    ConnectionRef {
        connection_id: ConnectionId(Uuid::new_v4()),
        generation: 3,
    }
}
fn envelope(op: serde_json::Value) -> Request {
    serde_json::from_value(op).unwrap()
}
#[test]
fn five_typed_families_extract_only_public_ids_and_never_secret_payloads_or_digests() {
    let c = connection();
    let id = Uuid::new_v4();
    let profile_id = Uuid::new_v4();
    let scope = Scope {
        target: Target::Connection { connection: c },
        action: Action::Read,
    };
    let exec_scope = Scope {
        action: Action::Exec,
        ..scope
    };
    let inputs = [
        serde_json::json!({"op":"ssh","request":{"op":"exec","connection":c,"request_id":id,"command":"synthetic-private-a","timeout_ms":1000,"max_output_bytes":4096}}),
        serde_json::json!({"op":"serial","request":{"op":"send","connection":c,"request_id":id,"content":"synthetic-private-a","format":"text","ending":"none","pace":{"chunk_bytes":1,"interval_ms":0}}}),
        serde_json::json!({"op":"config","request":{"op":"save_profile_key_file","profile":{"id":profile_id,"folder_id":null,"name":"synthetic-private-a","settings":{"protocol":"ssh2","host":"synthetic-private-a","port":22,"username":"synthetic-private-a","auth":"password","encoding":"utf8"}},"key_path":"synthetic-private-a","passphrase":"synthetic-private-a"}}),
        serde_json::json!({"op":"logging","request":{"op":"cleanup_commit","kind":"LOG","id":profile_id,"preview_id":id,"confirmation":Uuid::new_v4()}}),
        serde_json::json!({"op":"agent","request":{"op":"grant_protected","request_id":id,"scopes":[scope],"lifetime_ms":1000,"form":{"kind":"timed_task","task_id":profile_id,"label":"synthetic-private-a"},"redaction":{"sensitive_fields":true,"literals":["synthetic-private-a"]}}}),
        serde_json::json!({"op":"agent","request":{"op":"grant_protected","request_id":id,"scopes":[exec_scope],"lifetime_ms":1000,"form":{"kind":"single_operation","operation":{"protocol":"SSH2","request":{"op":"exec","connection":c,"request_id":profile_id,"command":"synthetic-private-a","timeout_ms":1000,"max_output_bytes":4096}}},"redaction":{"sensitive_fields":true,"literals":["synthetic-private-a"]}}}),
        serde_json::json!({"op":"append_fixture","connection":c,"bytes":b"synthetic-private-a".to_vec()}),
    ];
    for input in inputs {
        let original = envelope(input.clone()).audit_descriptor(9);
        let changed = serde_json::to_string(&input)
            .unwrap()
            .replace("synthetic-private-a", "synthetic-private-b");
        let mut changed: serde_json::Value = serde_json::from_str(&changed).unwrap();
        if input["op"] == "logging" {
            changed["request"]["confirmation"] = serde_json::json!(Uuid::new_v4());
        }
        if input["op"] == "append_fixture" {
            changed["bytes"] = serde_json::json!([0, 255, 123]);
        }
        let alternate = envelope(changed).audit_descriptor(9);
        assert_eq!(original, alternate);
        let wire = serde_json::to_string(&original).unwrap();
        assert!(!wire.contains("synthetic-private"));
        assert!(!format!("{original:?}").contains("synthetic-private"));
        for forbidden in [
            "command",
            "content",
            "key_path",
            "passphrase",
            "literals",
            "fingerprint",
            "confirmation",
            "label",
            "password",
            "bytes",
        ] {
            assert!(!wire.contains(forbidden));
        }
        if input["op"] == "logging" {
            assert!(!wire.contains(input["request"]["confirmation"].as_str().unwrap()));
        }
        assert_eq!(original.wire_id, Some(9));
    }
}
#[test]
fn queries_and_authentication_do_not_invent_control_connect_or_read_permissions() {
    let c = connection();
    let id = Uuid::new_v4();
    let inputs = [
        Request::Agent {
            request: agent::Request::Acquire {
                connection: c,
                lifetime_ms: 1000,
            },
        },
        Request::Agent {
            request: agent::Request::Takeover { connection: c },
        },
        Request::Ssh {
            request: ssh::Request::Authenticate {
                connection: c,
                challenge_id: id,
                use_saved: true,
                password: None,
            },
        },
        Request::Ssh {
            request: ssh::Request::ExecRead {
                connection: c,
                task_id: id,
                cursor: 1,
                max_bytes: 4096,
            },
        },
        Request::Serial {
            request: serial::Request::DisconnectStatus {
                connection: c,
                request_id: id,
            },
        },
        Request::Logging {
            request: logging::Request::Start {
                connection: c,
                request_id: id,
                limits: logging::Limits {
                    segment_bytes: 131072,
                    segments: 1,
                },
            },
        },
    ];
    for input in inputs {
        let d = input.audit_descriptor(1);
        assert!(d.requested_scope.is_none());
        assert_eq!(d.resource.unwrap().connection, Some(c));
    }
    let read = Request::Read {
        connection: c,
        cursor: 1,
        max_bytes: 4096,
    }
    .audit_descriptor(2);
    assert_eq!(read.requested_scope, Some(scope(c, Action::Read)));
    let task = Request::Ssh {
        request: ssh::Request::ExecCancel {
            connection: c,
            task_id: id,
        },
    }
    .audit_descriptor(3);
    assert_eq!(task.resource.unwrap().kind, ResourceKind::Task);
    assert_eq!(task.resource.unwrap().id, id);
}
#[test]
fn read_contract_is_strict_bounded_and_maximal_metadata_page_fits_a_real_frame() {
    for input in [
        serde_json::json!({"kind":"info","owner":Uuid::new_v4()}),
        serde_json::json!({"kind":"page","cursor":0,"through_cursor":1,"limit":1,"path":"synthetic-private"}),
    ] {
        assert!(serde_json::from_value::<View>(input).is_err());
    }
    for view in [
        View::Page {
            cursor: 2,
            through_cursor: 1,
            limit: 1,
        },
        View::Page {
            cursor: 0,
            through_cursor: 1,
            limit: 0,
        },
        View::Page {
            cursor: 0,
            through_cursor: 1,
            limit: 129,
        },
    ] {
        assert!(!view.valid());
    }
    let mut ring = Ring::default();
    let c = connection();
    let id = Uuid::new_v4();
    let origin = Origin {
        pipe_id: id,
        client_id: Some(id),
        kind: OriginKind::Agent,
        peer_pid: Some(u32::MAX),
    };
    let mut d = Request::Read {
        connection: c,
        cursor: 1,
        max_bytes: 4096,
    }
    .audit_descriptor(u32::MAX);
    d.request_id = Some(id);
    d.resource = Some(Resource {
        kind: ResourceKind::Task,
        id,
        connection: Some(c),
    });
    d.requested_scope = Some(Scope {
        target: Target::OutputWindow {
            connection: c,
            window: session_core::context::TimeWindow {
                from_ms: u64::MAX - 1,
                until_ms: u64::MAX,
            },
        },
        action: Action::Read,
    });
    let time = Time {
        unix_ms: u64::MAX,
        elapsed_ms: u64::MAX,
    };
    for _ in 0..128 {
        let event = ring.begin(time, origin, d).unwrap();
        ring.returned(
            event.attempt.attempt_id,
            time,
            Err(ErrorCode::PermissionDenied),
        )
        .unwrap();
        ring.end(event.attempt.attempt_id, time, Phase::ReplyWritten {})
            .unwrap();
    }
    let reply = crate::Response::Ok {
        id: u32::MAX,
        reply: crate::Reply::RpcAudit(Reply::Page {
            service_id: id,
            page: ring.page(0, ring.through_cursor(), 128).unwrap(),
            record_failures: u64::MAX,
            persistent: false,
        }),
    };
    assert!(serde_json::to_vec(&reply).unwrap().len() < crate::MAX_FRAME / 2);
}
