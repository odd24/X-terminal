use super::*;
use session_core::context::{Reply as C, TimeWindow, View};

#[tokio::test]
async fn agent_serial_context_reads_the_shared_worker_echo_only_in_approved_window() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = connected(&mut desktop).await;
    call(&mut desktop, write(c, Uuid::new_v4(), b"scope-readable")).await;
    timeout(Duration::from_secs(3), async {
        while bytes(&mut desktop, c).await != b"scope-readable" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let Reply::Output(source) = ok(desktop
        .request(Request::Read {
            connection: c,
            cursor: 1,
            max_bytes: 65536,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let stamp = source.events.last().unwrap().timestamp_ms;
    let window = TimeWindow {
        from_ms: stamp,
        until_ms: stamp + 1,
    };
    let (_, token) = issue(
        &mut desktop,
        vec![Scope {
            target: Target::OutputWindow {
                connection: c,
                window,
            },
            action: Action::Read,
        }],
        30000,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    for view in [
        View::Raw {
            through_cursor: source.next_cursor,
            cursor: 1,
            max_bytes: 65536,
        },
        View::Text {
            through_cursor: source.next_cursor,
            cursor: 1,
            max_bytes: 65536,
        },
        View::Screen {
            through_cursor: source.next_cursor,
        },
    ] {
        let Reply::Context(result) = ok(client
            .request(Request::Context {
                connection: c,
                window,
                view,
            })
            .await
            .unwrap())
        else {
            panic!()
        };
        match result {
            C::Raw { page, .. } => {
                let expected = source
                    .events
                    .iter()
                    .filter(|e| e.timestamp_ms == stamp)
                    .cloned()
                    .collect::<Vec<_>>();
                assert_eq!(page.events, expected);
            }
            C::Text { page, .. } => assert!(page.events.iter().any(|e| !e.text.is_empty())),
            C::Screen { screen, .. } => assert!(!screen.contents.is_empty()),
            _ => panic!(),
        }
    }
    assert_eq!(
        error(
            client
                .request(Request::Screen { connection: c })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert!(
        matches!(call(&mut desktop, S::Status { connection: c }).await, SR::Status(s) if s.connection.state == State::Connected)
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_serial_protected_output_reads_actual_worker_and_preserves_desktop_bytes() {
    use session_core::protected_context::{Reply as P, View as PV};
    use session_protocol::agent::{ProtectedForm, Redaction};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = connected(&mut desktop).await;
    let expected = b"public synthetic-secret\r\nvisible\r\nlast-padding-row\r\n";
    let write_id = Uuid::new_v4();
    call(&mut desktop, write(c, write_id, expected)).await;
    timeout(Duration::from_secs(3), async {
        while bytes(&mut desktop, c).await != expected {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let Reply::Agent(AR::Grant {
        receipt,
        token: Some(token),
    }) = ok(desktop
        .request(agent(A::GrantProtected {
            request_id: Uuid::new_v4(),
            scopes: vec![scope(c, Action::Read)],
            lifetime_ms: 30000,
            form: ProtectedForm::Scoped {},
            redaction: Redaction {
                sensitive_fields: false,
                literals: vec![Sensitive::new("synthetic-secret".into())],
            },
        }))
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut reader, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let Reply::ProtectedContext(P::Info { context }) = ok(reader
        .request(Request::ProtectedContext {
            connection: c,
            window: None,
            view: PV::Info {},
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    for view in [
        PV::Text {
            through_cursor: context.through_cursor,
            cursor: 1,
            max_bytes: 16384,
        },
        PV::Screen {
            through_cursor: context.through_cursor,
        },
    ] {
        let reply = ok(reader
            .request(Request::ProtectedContext {
                connection: c,
                window: None,
                view,
            })
            .await
            .unwrap());
        let wire = serde_json::to_string(&reply).unwrap();
        assert!(!wire.contains("synthetic-secret"));
        assert!(!wire.contains("synthetic-"));
        assert!(!wire.contains("secret"));
        assert!(wire.contains(&receipt.protection.unwrap().policy_id.to_string()));
    }
    assert_eq!(
        error(
            reader
                .request(Request::Read {
                    connection: c,
                    cursor: 1,
                    max_bytes: 65536
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(bytes(&mut desktop, c).await, expected);
    use session_core::rpc_audit::{Area, OriginKind, Phase, Verb};
    use session_protocol::rpc_audit::{Reply as AuditReply, View as AuditView};
    let Reply::RpcAudit(AuditReply::Info {
        through_cursor,
        persistent,
        record_failures,
        ..
    }) = ok(desktop
        .request(Request::RpcAudit {
            view: AuditView::Info {},
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(!persistent);
    assert_eq!(record_failures, 0);
    let mut cursor = 0;
    let mut events = Vec::new();
    while cursor < through_cursor {
        let Reply::RpcAudit(AuditReply::Page { page, .. }) = ok(desktop
            .request(Request::RpcAudit {
                view: AuditView::Page {
                    cursor,
                    through_cursor,
                    limit: 128,
                },
            })
            .await
            .unwrap())
        else {
            panic!()
        };
        cursor = page.next_cursor;
        events.extend(page.events);
    }
    assert!(events.iter().any(|e| e.attempt.request.area == Area::Serial
        && e.attempt.request.verb == Verb::Write
        && e.attempt.request.request_id == Some(write_id)
        && e.attempt.origin.kind == OriginKind::Desktop
        && e.phase == Phase::ReturnedOk {}));
    assert!(events.iter().any(
        |e| e.attempt.origin.client_id == Some(receipt.summary.ticket_id)
            && e.attempt.request.area == Area::Session
            && e.attempt.request.verb == Verb::Read
            && e.phase
                == Phase::ReturnedError {
                    code: ErrorCode::PermissionDenied
                }
    ));
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("synthetic-secret")
    );
    service.stop(&mut desktop).await;
}
