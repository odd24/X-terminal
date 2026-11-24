use super::*;

#[tokio::test]
async fn rpc_audit_connection_capacity_rejects_new_peers_explicitly_while_existing_client_keeps_working()
 {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let mut peers = Vec::new();
    for _ in 0..40 {
        peers.push(fixture.raw().await);
    }
    ok(desktop.request(Request::Ping {}).await.unwrap());
    let events = snapshot(&mut desktop).await;
    assert!(events.iter().any(|e| e.phase
        == Phase::AdmissionRejected {
            code: ErrorCode::CapacityExceeded
        }
        && e.attempt.origin.kind == OriginKind::Unauthenticated
        && e.attempt.origin.peer_pid == Some(std::process::id())
        && e.attempt.request.wire_id.is_none()));
    drop(peers);
    timeout(Duration::from_secs(3), async {
        loop {
            let Reply::RpcAudit(A::Info {
                active_attempts,
                record_failures,
                ..
            }) = ok(desktop
                .request(Request::RpcAudit {
                    view: View::Info {},
                })
                .await
                .unwrap())
            else {
                panic!()
            };
            assert_eq!(record_failures, 0);
            if active_attempts == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.stop(&mut desktop).await;
}
use session_core::{
    access::{Action, Scope, Target},
    rpc_audit::{self as a, Area, IoReason, IoStage, OriginKind, Phase, Verb},
};
use session_protocol::rpc_audit::{Reply as A, View};

async fn info(client: &mut Client) -> (Uuid, u64) {
    let Reply::RpcAudit(A::Info {
        service_id,
        through_cursor,
        record_failures,
        persistent,
        ..
    }) = ok(client
        .request(Request::RpcAudit {
            view: View::Info {},
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(record_failures, 0);
    assert!(!persistent);
    (service_id, through_cursor)
}
async fn page(client: &mut Client, cursor: u64, through: u64) -> a::Page {
    let Reply::RpcAudit(A::Page {
        page,
        record_failures,
        persistent,
        ..
    }) = ok(client
        .request(Request::RpcAudit {
            view: View::Page {
                cursor,
                through_cursor: through,
                limit: 128,
            },
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(record_failures, 0);
    assert!(!persistent);
    page
}
async fn snapshot(client: &mut Client) -> Vec<a::Event> {
    let (_, through) = info(client).await;
    let mut cursor = 0;
    let mut events = Vec::new();
    while cursor < through {
        let p = page(client, cursor, through).await;
        assert!(p.next_cursor > cursor);
        cursor = p.next_cursor;
        events.extend(p.events);
    }
    events
}
async fn raw_authenticated(fixture: &Fixture) -> (NamedPipeClient, Uuid) {
    let mut raw = fixture.raw().await;
    write_frame(
        &mut raw,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-private-client-name".into(),
            token: Sensitive::new(fixture.token.expose().into()),
        },
    )
    .await
    .unwrap();
    let Reply::Welcome(w) = ok(read_frame::<_, Response>(&mut raw).await.unwrap().unwrap()) else {
        panic!()
    };
    (raw, w.client_id)
}

#[tokio::test]
async fn rpc_audit_actual_rejections_cover_all_channels_roles_and_keep_only_trusted_metadata() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let hidden = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let id = Uuid::new_v4();
    let Reply::Agent(agent::Reply::Grant {
        receipt,
        token: Some(token),
    }) = ok(desktop
        .request(Request::Agent {
            request: agent::Request::Grant {
                request_id: id,
                scopes: vec![Scope {
                    target: Target::Connection { connection: c },
                    action: Action::Read,
                }],
                lifetime_ms: 30000,
            },
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut client, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    let requests = [
        Request::Read {
            connection: hidden,
            cursor: 1,
            max_bytes: 4096,
        },
        Request::Config {
            request: config::ConfigRequest::Preferences {},
        },
        Request::Logging {
            request: logging::Request::HistoryList {},
        },
        Request::Serial {
            request: serial::Request::Inventory {},
        },
        Request::Ssh {
            request: ssh::Request::Authenticate {
                connection: c,
                challenge_id: Uuid::new_v4(),
                use_saved: false,
                password: Some(Sensitive::new("synthetic-private-password".into())),
            },
        },
        Request::Agent {
            request: agent::Request::GrantProtected {
                request_id: Uuid::new_v4(),
                scopes: vec![Scope {
                    target: Target::Connection { connection: c },
                    action: Action::Read,
                }],
                lifetime_ms: 1000,
                form: agent::ProtectedForm::Scoped {},
                redaction: agent::Redaction {
                    sensitive_fields: true,
                    literals: vec![Sensitive::new("synthetic-private-rule".into())],
                },
            },
        },
        Request::RpcAudit {
            view: View::Info {},
        },
    ];
    for r in requests {
        assert_eq!(
            error(client.request(r).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    ok(client
        .request(Request::Read {
            connection: c,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap());
    ok(desktop
        .request(Request::Agent {
            request: agent::Request::GrantRevoke { request_id: id },
        })
        .await
        .unwrap());
    assert_eq!(
        error(client.request(Request::Ping {}).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    let Reply::ReadTicket {
        ticket_id: observer_id,
        token: observer_token,
        ..
    } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![c],
            lifetime_ms: 30000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) =
        Client::connect(&fixture.instance, observer_token.expose(), fixture.pid)
            .await
            .unwrap();
    for view in [
        View::Info {},
        View::Page {
            cursor: 0,
            through_cursor: 0,
            limit: 128,
        },
    ] {
        assert_eq!(
            error(observer.request(Request::RpcAudit { view }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let events = snapshot(&mut desktop).await;
    assert!(
        events
            .iter()
            .any(|e| e.attempt.origin.client_id == Some(observer_id)
                && e.attempt.origin.kind == OriginKind::Observer
                && e.phase
                    == Phase::ReturnedError {
                        code: ErrorCode::PermissionDenied
                    })
    );
    let ours = events
        .iter()
        .filter(|e| e.attempt.origin.client_id == Some(receipt.summary.ticket_id))
        .collect::<Vec<_>>();
    for area in [
        Area::Session,
        Area::Agent,
        Area::Configuration,
        Area::Logging,
        Area::Serial,
        Area::Ssh2,
    ] {
        assert!(ours.iter().any(|e| e.attempt.request.area == area
            && e.phase
                == Phase::ReturnedError {
                    code: ErrorCode::PermissionDenied
                }));
    }
    assert!(
        ours.iter()
            .any(|e| e.attempt.request.verb == Verb::Read && e.phase == Phase::ReturnedOk {})
    );
    assert!(ours.iter().any(|e| e.attempt.request.verb == Verb::Ping
        && e.phase
            == Phase::ReturnedError {
                code: ErrorCode::PermissionDenied
            }));
    assert!(
        ours.iter()
            .all(|e| e.attempt.origin.kind == OriginKind::Agent
                && e.attempt.origin.peer_pid == Some(std::process::id()))
    );
    let wire = serde_json::to_string(&events).unwrap();
    for forbidden in [
        "synthetic-private-password",
        "synthetic-private-rule",
        token.expose(),
        observer_token.expose(),
        fixture.token.expose(),
        "synthetic-private-client-name",
    ] {
        assert!(!wire.contains(forbidden));
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn rpc_audit_bad_handshakes_frames_and_server_validation_are_real_pipe_facts_not_payload_logs()
 {
    use tokio::io::AsyncWriteExt;
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let wrong = SecretToken::generate();
    for (version, token, expected) in [
        (999, fixture.token.expose(), ErrorCode::VersionMismatch),
        (
            PROTOCOL_VERSION,
            wrong.expose(),
            ErrorCode::PermissionDenied,
        ),
    ] {
        let mut raw = fixture.raw().await;
        write_frame(
            &mut raw,
            &Hello {
                protocol_version: version,
                client_name: "synthetic-private-name".into(),
                token: Sensitive::new(token.into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            error(read_frame::<_, Response>(&mut raw).await.unwrap().unwrap()),
            expected
        );
    }
    let mut oversized = fixture.raw().await;
    oversized
        .write_all(&((MAX_FRAME + 1) as u32).to_le_bytes())
        .await
        .unwrap();
    assert!(matches!(
        timeout(
            Duration::from_secs(3),
            read_frame::<_, Response>(&mut oversized)
        )
        .await
        .unwrap(),
        Ok(None) | Err(_)
    ));
    let (mut raw, pipe_id) = raw_authenticated(&fixture).await;
    write_frame(
        &mut raw,
        &RequestEnvelope {
            id: 99,
            request: Request::RpcAudit {
                view: View::Page {
                    cursor: 0,
                    through_cursor: 0,
                    limit: 0,
                },
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(
        error(read_frame::<_, Response>(&mut raw).await.unwrap().unwrap()),
        ErrorCode::InvalidArgument
    );
    write_frame(&mut raw,&serde_json::json!({"id":100,"request":{"op":"synthetic_unknown","token":"synthetic-private-payload"}})).await.unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(3), read_frame::<_, Response>(&mut raw))
            .await
            .unwrap(),
        Ok(None) | Err(_)
    ));
    let events = snapshot(&mut desktop).await;
    for code in [ErrorCode::VersionMismatch, ErrorCode::PermissionDenied] {
        assert!(
            events
                .iter()
                .any(|e| e.attempt.origin.kind == OriginKind::Unauthenticated
                    && e.phase == Phase::ReturnedError { code })
        );
    }
    assert!(events.iter().any(|e| matches!(
        e.phase,
        Phase::IoFailure {
            stage: IoStage::HelloRead,
            reason: IoReason::InvalidFrame
        }
    )));
    assert!(events.iter().any(|e| e.attempt.origin.pipe_id == pipe_id
        && matches!(
            e.phase,
            Phase::IoFailure {
                stage: IoStage::RequestRead,
                reason: IoReason::InvalidFrame
            }
        )));
    assert!(events.iter().any(|e| e.attempt.origin.pipe_id == pipe_id
        && e.attempt.request.wire_id == Some(99)
        && e.phase
            == Phase::ReturnedError {
                code: ErrorCode::InvalidArgument
            }));
    assert!(events.iter().any(|e| e.attempt.origin.pipe_id == pipe_id
        && matches!(
            e.phase,
            Phase::Authenticated {
                origin_kind: OriginKind::Desktop,
                ..
            }
        )));
    let wire = serde_json::to_string(&events).unwrap();
    for forbidden in [
        "synthetic-private-name",
        "synthetic-private-payload",
        "synthetic_unknown",
        wrong.expose(),
        fixture.token.expose(),
    ] {
        assert!(!wire.contains(forbidden));
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn rpc_audit_hello_timeout_and_early_close_have_distinct_terminal_phases() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let previous = snapshot(&mut desktop).await;
    let early = fixture.raw().await;
    let early_pipe = timeout(Duration::from_secs(3), async {
        loop {
            let events = snapshot(&mut desktop).await;
            if let Some(event) = events.iter().find(|event| {
                event.attempt.origin.kind == OriginKind::Unauthenticated
                    && event.attempt.request.verb == Verb::Hello
                    && event.phase == Phase::Received {}
                    && previous
                        .iter()
                        .all(|old| old.attempt.attempt_id != event.attempt.attempt_id)
            }) {
                return event.attempt.origin.pipe_id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("early peer was admitted before closing");
    drop(early);

    let mut silent = fixture.raw().await;
    assert!(matches!(
        timeout(
            Duration::from_secs(9),
            read_frame::<_, Response>(&mut silent)
        )
        .await
        .expect("the service closes a silent Hello peer"),
        Ok(None) | Err(_)
    ));
    let events = snapshot(&mut desktop).await;
    for (reason, is_early) in [(IoReason::Closed, true), (IoReason::Timeout, false)] {
        let event = events
            .iter()
            .find(|event| {
                event.attempt.origin.kind == OriginKind::Unauthenticated
                    && event.attempt.request.verb == Verb::Hello
                    && event.phase
                        == Phase::IoFailure {
                            stage: IoStage::HelloRead,
                            reason,
                        }
                    && (event.attempt.origin.pipe_id == early_pipe) == is_early
            })
            .expect("the actual pipe termination was audited");
        assert!(!events.iter().any(|other| {
            other.attempt.attempt_id == event.attempt.attempt_id
                && other.phase == Phase::ReplyWritten {}
        }));
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn rpc_audit_same_wire_retries_are_distinct_and_fixed_watermarks_report_real_overwrite() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let (mut raw, pipe_id) = raw_authenticated(&fixture).await;
    for _ in 0..2 {
        write_frame(
            &mut raw,
            &RequestEnvelope {
                id: 77,
                request: Request::Ping {},
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame::<_, Response>(&mut raw).await.unwrap().unwrap(),
            Response::Ok {
                id: 77,
                reply: Reply::Pong { .. }
            }
        ));
    }
    let events = snapshot(&mut desktop).await;
    let attempts = events
        .iter()
        .filter(|e| {
            e.attempt.origin.pipe_id == pipe_id
                && e.attempt.request.wire_id == Some(77)
                && e.phase == Phase::Received {}
        })
        .collect::<Vec<_>>();
    assert_eq!(attempts.len(), 2);
    assert_ne!(
        attempts[0].attempt.attempt_id,
        attempts[1].attempt.attempt_id
    );
    let (service_id, through) = info(&mut desktop).await;
    for _ in 0..180 {
        ok(desktop.request(Request::Ping {}).await.unwrap());
    }
    let lost = page(&mut desktop, 0, through).await;
    assert!(lost.gap);
    assert!(lost.events.is_empty());
    assert_eq!(lost.next_cursor, through);
    assert!(lost.available_from > through);
    let (_, fixed) = info(&mut desktop).await;
    let first = page(&mut desktop, 0, fixed).await;
    assert!(first.gap);
    let from = first.available_from;
    let mut cursor = first.next_cursor;
    let mut seqs = first.events.iter().map(|e| e.seq).collect::<Vec<_>>();
    while cursor < fixed {
        let p = page(&mut desktop, cursor, fixed).await;
        assert!(!p.gap);
        seqs.extend(p.events.iter().map(|e| e.seq));
        cursor = p.next_cursor;
    }
    assert_eq!(seqs, ((from + 1)..=fixed).collect::<Vec<_>>());
    assert_eq!(info(&mut desktop).await.0, service_id);
    assert_eq!(
        error(
            desktop
                .request(Request::RpcAudit {
                    view: View::Page {
                        cursor: 0,
                        through_cursor: u64::MAX,
                        limit: 128
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    drop(raw);
    fixture.stop(&mut desktop).await;
}
