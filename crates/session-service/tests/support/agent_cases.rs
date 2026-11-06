use super::*;
use session_core::access::{Action, AuditKind, Scope, Target};
use session_protocol::agent::{Reply as AR, Request as A};

#[tokio::test]
async fn connect_grants_resolve_saved_profiles_and_do_not_implicitly_authorize_connections() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let profile = portable();
    assert!(matches!(
        config_call(
            &mut desktop,
            config::ConfigRequest::SaveProfile {
                profile: profile.clone(),
                credential: config::CredentialEdit::Keep {}
            }
        )
        .await,
        config::ConfigReply::SavedProfile { .. }
    ));
    let connect = Scope {
        target: Target::Profile {
            profile_id: profile.id,
        },
        action: Action::Connect,
    };
    let (_, token) = issue(&mut desktop, vec![connect], 10000).await;
    let (mut client, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    let current = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    assert!(
        matches!(ok(client.request(Request::List {}).await.unwrap()),Reply::Sessions(list) if list.is_empty())
    );
    for request in [
        Request::Screen {
            connection: current,
        },
        agent(A::Acquire {
            connection: current,
            lifetime_ms: 100,
        }),
        Request::Ssh {
            request: ssh::Request::Start {
                profile_id: profile.id,
                request_id: Uuid::new_v4(),
                cols: 80,
                rows: 24,
            },
        },
    ] {
        assert_eq!(
            error(client.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let missing = Scope {
        target: Target::Profile {
            profile_id: Uuid::new_v4(),
        },
        action: Action::Connect,
    };
    assert_eq!(
        error(
            desktop
                .request(agent(A::Grant {
                    scopes: vec![missing],
                    lifetime_ms: 1000
                }))
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    fixture.stop(&mut desktop).await;
}

fn agent(request: A) -> Request {
    Request::Agent { request }
}
fn scope(connection: ConnectionRef, action: Action) -> Scope {
    Scope {
        target: Target::Connection { connection },
        action,
    }
}
async fn issue(desktop: &mut Client, scopes: Vec<Scope>, lifetime_ms: u64) -> (Uuid, Sensitive) {
    match ok(desktop
        .request(agent(A::Grant {
            scopes,
            lifetime_ms,
        }))
        .await
        .unwrap())
    {
        Reply::Agent(AR::Ticket {
            ticket_id, token, ..
        }) => (ticket_id, token),
        _ => panic!("ticket expected"),
    }
}
async fn lease(
    client: &mut Client,
    connection: ConnectionRef,
    lifetime_ms: u64,
) -> session_core::access::Lease {
    match ok(client
        .request(agent(A::Acquire {
            connection,
            lifetime_ms,
        }))
        .await
        .unwrap())
    {
        Reply::Agent(AR::Lease(Some(lease))) => lease,
        _ => panic!("lease expected"),
    }
}

#[tokio::test]
async fn agent_identity_reads_only_granted_views_and_cannot_promote_or_read_configuration() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let first = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let hidden = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    ok(desktop
        .request(Request::AppendFixture {
            connection: first,
            bytes: "授权共享中文\r\n".as_bytes().to_vec(),
        })
        .await
        .unwrap());
    let (id, token) = issue(&mut desktop, vec![scope(first, Action::Read)], 10000).await;
    let (mut reader, welcome) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    let Reply::Welcome(welcome) = ok(welcome) else {
        panic!("welcome expected")
    };
    assert!(matches!(welcome.kind, ClientKind::Agent));
    assert_eq!(welcome.client_id, id);
    match ok(reader.request(Request::List {}).await.unwrap()) {
        Reply::Sessions(list) => {
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].reference(), first);
        }
        _ => panic!(),
    }
    match ok(reader
        .request(Request::Read {
            connection: first,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => assert_eq!(page.events[0].bytes, "授权共享中文\r\n".as_bytes()),
        _ => panic!(),
    }
    match ok(reader
        .request(Request::Screen { connection: first })
        .await
        .unwrap())
    {
        Reply::Screen(screen) => assert_eq!(screen.contents, "授权共享中文"),
        _ => panic!(),
    }
    assert!(matches!(
        ok(reader
            .request(Request::ReadText {
                connection: first,
                cursor: 1,
                max_bytes: session_core::presentation::MIN_TEXT_PAGE
            })
            .await
            .unwrap()),
        Reply::Text(_)
    ));
    for request in [
        Request::Screen { connection: hidden },
        Request::IssueRead {
            scopes: vec![first],
            lifetime_ms: 1000,
        },
        agent(A::Grant {
            scopes: vec![scope(hidden, Action::Read)],
            lifetime_ms: 1000,
        }),
        agent(A::Takeover { connection: first }),
        agent(A::Audit {
            cursor: 0,
            limit: 128,
        }),
        agent(A::Acquire {
            connection: first,
            lifetime_ms: 100,
        }),
        Request::Revoke { ticket_id: id },
        Request::Config {
            request: config::ConfigRequest::Preferences {},
        },
        Request::Serial {
            request: serial::Request::Inventory {},
        },
        Request::Shutdown {},
        Request::CreateFixture {},
    ] {
        assert_eq!(
            error(reader.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    ok(desktop
        .request(Request::Revoke { ticket_id: id })
        .await
        .unwrap());
    for request in [
        Request::Ping {},
        Request::List {},
        Request::Screen { connection: first },
    ] {
        assert_eq!(
            error(reader.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    assert!(
        Client::connect(&fixture.instance, token.expose(), fixture.pid)
            .await
            .is_err()
    );
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_lease_ownership_takeover_and_audit_are_enforced_by_real_pipe_identity() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let first = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let permissions: Vec<_> = [
        Action::Read,
        Action::Write,
        Action::Exec,
        Action::Control,
        Action::Disconnect,
        Action::Broadcast,
    ]
    .into_iter()
    .map(|a| scope(first, a))
    .collect();
    let (id, token) = issue(&mut desktop, permissions.clone(), 10000).await;
    let (_, other_token) = issue(&mut desktop, permissions, 10000).await;
    let (mut owner, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    let (mut other, _) = Client::connect(&fixture.instance, other_token.expose(), fixture.pid)
        .await
        .unwrap();
    let l = lease(&mut owner, first, 1000).await;
    assert_eq!(l.client_id, id);
    for request in [
        agent(A::Acquire {
            connection: first,
            lifetime_ms: 100,
        }),
        agent(A::Release {
            connection: first,
            lease_id: l.lease_id,
        }),
    ] {
        let expected = if matches!(
            &request,
            Request::Agent {
                request: A::Acquire { .. }
            }
        ) {
            ErrorCode::InputBusy
        } else {
            ErrorCode::PermissionDenied
        };
        assert_eq!(error(other.request(request).await.unwrap()), expected);
    }
    assert!(matches!(
        ok(other
            .request(agent(A::Lease { connection: first }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    assert!(
        matches!(ok(desktop.request(agent(A::Lease {connection:first})).await.unwrap()), Reply::Agent(AR::Lease(Some(found))) if found == l)
    );
    // Full scopes and a lease do not expose transport actions before the FIFO permit integration.
    for request in [
        Request::Ssh {
            request: ssh::Request::Write {
                connection: first,
                request_id: Uuid::new_v4(),
                bytes: SensitiveBytes::new(b"never-send".to_vec()),
            },
        },
        Request::Ssh {
            request: ssh::Request::Exec {
                connection: first,
                request_id: Uuid::new_v4(),
                command: Sensitive::new("never-exec".into()),
                timeout_ms: 1000,
                max_output_bytes: 4096,
            },
        },
        Request::Serial {
            request: serial::Request::Control {
                connection: first,
                request_id: Uuid::new_v4(),
                line: serial::Line::Dtr,
                asserted: true,
            },
        },
    ] {
        assert_eq!(
            error(owner.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    ok(desktop
        .request(agent(A::Takeover { connection: first }))
        .await
        .unwrap());
    for client in [&mut owner, &mut other] {
        assert_eq!(
            error(
                client
                    .request(agent(A::Acquire {
                        connection: first,
                        lifetime_ms: 100
                    }))
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    assert!(matches!(
        ok(owner
            .request(Request::Screen { connection: first })
            .await
            .unwrap()),
        Reply::Screen(_)
    ));
    match ok(desktop
        .request(agent(A::Audit {
            cursor: 0,
            limit: 128,
        }))
        .await
        .unwrap())
    {
        Reply::Agent(AR::Audit(page)) => {
            assert!(!page.gap);
            assert!(
                page.events
                    .iter()
                    .any(|e| e.kind == AuditKind::LeaseAcquired && e.client_id == Some(id))
            );
            assert!(page.events.iter().any(|e| e.kind == AuditKind::Takeover));
            let json = serde_json::to_string(&page).unwrap();
            assert!(!json.contains(token.expose()));
            assert!(!json.contains("never-send"));
        }
        _ => panic!(),
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_expiry_generation_and_release_do_not_extend_authority() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let first = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let (_, token) = issue(
        &mut desktop,
        vec![scope(first, Action::Read), scope(first, Action::Write)],
        10000,
    )
    .await;
    let (mut owner, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    let initial = lease(&mut owner, first, 50).await;
    tokio::time::sleep(Duration::from_millis(75)).await;
    assert!(matches!(
        ok(owner
            .request(agent(A::Lease { connection: first }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    assert_eq!(
        error(
            owner
                .request(agent(A::Release {
                    connection: first,
                    lease_id: initial.lease_id
                }))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let current = lease(&mut owner, first, 500).await;
    assert_ne!(initial.lease_id, current.lease_id);
    ok(owner
        .request(agent(A::Release {
            connection: first,
            lease_id: current.lease_id,
        }))
        .await
        .unwrap());
    let next = reference(ok(desktop
        .request(Request::ReconnectFixture { connection: first })
        .await
        .unwrap()));
    assert_eq!(
        error(
            owner
                .request(Request::Screen { connection: next })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            owner
                .request(agent(A::Acquire {
                    connection: next,
                    lifetime_ms: 100
                }))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    // Grant a short read-only identity after setup so startup latency is excluded.
    let (_, short) = issue(&mut desktop, vec![scope(next, Action::Read)], 500).await;
    let (mut expiring, _) = Client::connect(&fixture.instance, short.expose(), fixture.pid)
        .await
        .unwrap();
    assert!(matches!(
        ok(expiring
            .request(Request::Screen { connection: next })
            .await
            .unwrap()),
        Reply::Screen(_)
    ));
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        error(
            expiring
                .request(Request::Screen { connection: next })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert!(
        Client::connect(&fixture.instance, short.expose(), fixture.pid)
            .await
            .is_err()
    );
    fixture.stop(&mut desktop).await;
}
