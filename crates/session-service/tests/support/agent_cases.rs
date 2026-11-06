use super::*;
use session_core::access::{Action, AuditKind, Scope, Target};
use session_protocol::agent::{Reply as AR, Request as A};
#[cfg(feature = "serial-ui-fixture")]
#[path = "agent_serial.rs"]
mod serial_dispatch_cases;

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
                    request_id: Uuid::new_v4(),
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
            request_id: Uuid::new_v4(),
            scopes,
            lifetime_ms,
        }))
        .await
        .unwrap())
    {
        Reply::Agent(AR::Grant {
            receipt,
            token: Some(token),
        }) => (receipt.summary.ticket_id, token),
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
            request_id: Uuid::new_v4(),
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
    // SSH resize remains unavailable; a fixture connection is never a serial target.
    for request in [
        Request::Ssh {
            request: ssh::Request::Resize {
                connection: first,
                request_id: Uuid::new_v4(),
                cols: 80,
                rows: 24,
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

#[tokio::test]
async fn agent_ssh_write_uses_shared_connection_and_authentic_receipt_owner() {
    use session_core::input::InputState as I;
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = ssh_connected_fixture(&mut desktop, &remote).await;
    let Reply::ReadTicket {
        token: observer_token,
        ..
    } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 30000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) =
        Client::connect(&service.instance, observer_token.expose(), service.pid)
            .await
            .unwrap();
    for target in [
        connection,
        ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        },
    ] {
        for request in [
            ssh::Request::InputStatus {
                connection: target,
                request_id: Uuid::new_v4(),
            },
            input_write(target, Uuid::new_v4(), b"observer"),
            ssh::Request::WriteText {
                connection: target,
                request_id: Uuid::new_v4(),
                text: Sensitive::new("observer".into()),
            },
        ] {
            assert_eq!(
                error(observer.request(Request::Ssh { request }).await.unwrap()),
                ErrorCode::PermissionDenied
            );
        }
    }
    let scopes = vec![
        scope(connection, Action::Read),
        scope(connection, Action::Write),
    ];
    let (_, token) = issue(&mut desktop, scopes.clone(), 30000).await;
    let (_, second_token) = issue(&mut desktop, scopes, 30000).await;
    let (mut writer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (mut other, _) = Client::connect(&service.instance, second_token.expose(), service.pid)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    assert_eq!(
        error(
            writer
                .request(Request::Ssh {
                    request: input_write(connection, id, b"one")
                })
                .await
                .unwrap()
        ),
        ErrorCode::InputBusy
    );
    let l = lease(&mut writer, connection, 10000).await;
    for _ in 0..2 {
        ssh_call(&mut writer, input_write(connection, id, b"one")).await;
    }
    input_status(&mut writer, connection, id, |r| {
        r.state == I::PipelineQueued
    })
    .await;
    let text_id = Uuid::new_v4();
    ssh_call(
        &mut writer,
        ssh::Request::WriteText {
            connection,
            request_id: text_id,
            text: Sensitive::new("中文\r\n".into()),
        },
    )
    .await;
    input_status(&mut writer, connection, text_id, |r| {
        r.state == I::PipelineQueued
    })
    .await;
    timeout(Duration::from_secs(3), async {
        while remote.received.lock().unwrap().concat() != "one中文\r\n".as_bytes() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    ok(writer
        .request(agent(A::Release {
            connection,
            lease_id: l.lease_id,
        }))
        .await
        .unwrap());
    lease(&mut other, connection, 10000).await;
    for request in [
        input_write(connection, id, b"one"),
        input_write(connection, id, b"different"),
        ssh::Request::InputStatus {
            connection,
            request_id: id,
        },
    ] {
        assert_eq!(
            error(other.request(Request::Ssh { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    // Desktop can inspect uncertain Agent delivery, but cannot repurpose its request ID.
    input_status(&mut desktop, connection, id, |r| {
        r.state == I::PipelineQueued
    })
    .await;
    assert_eq!(
        error(
            desktop
                .request(Request::Ssh {
                    request: input_write(connection, id, b"one")
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    ssh_call(
        &mut desktop,
        input_write(connection, Uuid::new_v4(), b"user"),
    )
    .await;
    assert_eq!(
        error(
            other
                .request(Request::Ssh {
                    request: input_write(connection, Uuid::new_v4(), b"must-not-send")
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert!(matches!(
        ok(writer
            .request(Request::Screen { connection })
            .await
            .unwrap()),
        Reply::Screen(_)
    ));
    ssh_call(&mut desktop, ssh::Request::Close { connection }).await;
    assert_eq!(
        error(
            writer
                .request(Request::Screen { connection })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert!(matches!(
        ok(desktop
            .request(agent(A::Lease { connection }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_ssh_queued_input_rechecks_release_expiry_revoke_and_manual_takeover() {
    use session_core::input::InputState as I;
    for mode in ["release", "expiry", "revoke", "user", "explicit"] {
        let remote = ssh_fixture::Fixture::options(true).await;
        let temp = ConfigTemp::new();
        let mut service = temp.start().await;
        let mut desktop = service.connect().await;
        let connection = ssh_connected_fixture(&mut desktop, &remote).await;
        let scopes = vec![
            scope(connection, Action::Read),
            scope(connection, Action::Write),
        ];
        let (ticket_id, token) = issue(&mut desktop, scopes, 30000).await;
        let (mut writer, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        let l = lease(
            &mut writer,
            connection,
            if mode == "expiry" { 300 } else { 10000 },
        )
        .await;
        let first = Uuid::new_v4();
        let queued = Uuid::new_v4();
        ssh_call(
            &mut writer,
            input_write(connection, first, &vec![b'a'; 65536]),
        )
        .await;
        input_status(&mut writer, connection, first, |r| {
            r.state == I::Dispatching
        })
        .await;
        timeout(Duration::from_secs(3), async {
            while remote.received.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let ssh::Reply::Input(receipt) = ssh_call(
            &mut writer,
            input_write(connection, queued, b"forbidden-tail"),
        )
        .await
        else {
            panic!()
        };
        assert_eq!(receipt.state, I::Pending);
        let user_id = Uuid::new_v4();
        match mode {
            "release" => {
                ok(writer
                    .request(agent(A::Release {
                        connection,
                        lease_id: l.lease_id,
                    }))
                    .await
                    .unwrap());
                lease(&mut writer, connection, 10000).await;
            }
            "expiry" => tokio::time::sleep(Duration::from_millis(350)).await,
            "revoke" => {
                ok(desktop
                    .request(Request::Revoke { ticket_id })
                    .await
                    .unwrap());
            }
            "user" => {
                ssh_call(&mut desktop, input_write(connection, user_id, b"user")).await;
            }
            _ => {
                ok(desktop
                    .request(agent(A::Takeover { connection }))
                    .await
                    .unwrap());
            }
        }
        remote.unblock.notify_one();
        input_status(&mut desktop, connection, first, |r| {
            r.state == I::PipelineQueued
        })
        .await;
        input_status(&mut desktop, connection, queued, |r| {
            r.state == I::CancelledBeforeDispatch
        })
        .await;
        if mode == "user" {
            input_status(&mut desktop, connection, user_id, |r| {
                r.state == I::PipelineQueued
            })
            .await;
        }
        // FIFO barrier proves the actor consumed the invalidated item, with no forbidden bytes.
        let barrier = Uuid::new_v4();
        ssh_call(&mut desktop, input_write(connection, barrier, b"barrier")).await;
        input_status(&mut desktop, connection, barrier, |r| {
            r.state == I::PipelineQueued
        })
        .await;
        timeout(Duration::from_secs(3), async {
            loop {
                let bytes = remote.received.lock().unwrap().concat();
                if bytes.ends_with(b"barrier") {
                    assert!(!bytes.windows(14).any(|w| w == b"forbidden-tail"));
                    assert_eq!(bytes.len(), 65536 + if mode == "user" { 4 } else { 0 } + 7);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        service.stop(&mut desktop).await;
    }
}

async fn agent_exec_start(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
    command: &str,
) -> ssh::TaskStatus {
    let ssh::Reply::Exec(task) = ssh_call(
        client,
        ssh::Request::Exec {
            connection,
            request_id: id,
            command: Sensitive::new(command.into()),
            timeout_ms: 2000,
            max_output_bytes: 4096,
        },
    )
    .await
    else {
        panic!()
    };
    task
}
async fn agent_exec_done(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
) -> ssh::TaskStatus {
    timeout(Duration::from_secs(5), async {
        loop {
            let ssh::Reply::Exec(task) = ssh_call(
                client,
                ssh::Request::ExecStatus {
                    connection,
                    task_id: id,
                },
            )
            .await
            else {
                panic!()
            };
            if task.phase == ssh::TaskPhase::Finished {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn agent_exec_has_independent_scope_and_private_owned_tasks_on_the_same_transport() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = ssh_connected_fixture(&mut desktop, &remote).await;
    let permissions = vec![scope(connection, Action::Exec)];
    let (_, token) = issue(&mut desktop, permissions.clone(), 30000).await;
    let (_, other_token) = issue(&mut desktop, permissions, 30000).await;
    let (mut executor, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (mut other, _) = Client::connect(&service.instance, other_token.expose(), service.pid)
        .await
        .unwrap();
    assert!(
        matches!(ok(executor.request(Request::List {}).await.unwrap()),Reply::Sessions(list) if list.is_empty())
    );
    for request in [
        Request::Screen { connection },
        Request::Ssh {
            request: input_write(connection, Uuid::new_v4(), b"forbidden-shell"),
        },
    ] {
        assert_eq!(
            error(executor.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let Reply::ReadTicket {
        token: observer_token,
        ..
    } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 30000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) =
        Client::connect(&service.instance, observer_token.expose(), service.pid)
            .await
            .unwrap();
    for target in [
        connection,
        ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        },
    ] {
        for request in [
            ssh::Request::Exec {
                connection: target,
                request_id: Uuid::new_v4(),
                command: Sensitive::new("never".into()),
                timeout_ms: 1000,
                max_output_bytes: 4096,
            },
            ssh::Request::ExecStatus {
                connection: target,
                task_id: Uuid::new_v4(),
            },
            ssh::Request::ExecRead {
                connection: target,
                task_id: Uuid::new_v4(),
                cursor: 1,
                max_bytes: 4096,
            },
            ssh::Request::ExecCancel {
                connection: target,
                task_id: Uuid::new_v4(),
            },
        ] {
            assert_eq!(
                error(observer.request(Request::Ssh { request }).await.unwrap()),
                ErrorCode::PermissionDenied
            );
        }
    }
    let id = Uuid::new_v4();
    let request = || ssh::Request::Exec {
        connection,
        request_id: id,
        command: Sensitive::new("fail".into()),
        timeout_ms: 2000,
        max_output_bytes: 4096,
    };
    assert_eq!(
        error(
            executor
                .request(Request::Ssh { request: request() })
                .await
                .unwrap()
        ),
        ErrorCode::InputBusy
    );
    let l = lease(&mut executor, connection, 10000).await;
    let task = agent_exec_start(&mut executor, connection, id, "fail").await;
    assert_eq!(
        agent_exec_start(&mut executor, connection, id, "fail")
            .await
            .task_id,
        task.task_id
    );
    let done = agent_exec_done(&mut executor, connection, task.task_id).await;
    assert_eq!(done.summary.unwrap().exit_status, Some(7));
    let ssh::Reply::ExecOutput { output, .. } = ssh_call(
        &mut executor,
        ssh::Request::ExecRead {
            connection,
            task_id: task.task_id,
            cursor: 1,
            max_bytes: 4096,
        },
    )
    .await
    else {
        panic!()
    };
    assert!(output.completed);
    assert!(!output.events.is_empty());
    assert_eq!(
        remote.exec_calls.lock().unwrap().as_slice(),
        &[b"fail".to_vec()]
    );
    assert!(remote.received.lock().unwrap().is_empty());
    let running = agent_exec_start(&mut executor, connection, Uuid::new_v4(), "stall").await;
    timeout(Duration::from_secs(3), async {
        loop {
            let ssh::Reply::ExecOutput { output, .. } = ssh_call(
                &mut executor,
                ssh::Request::ExecRead {
                    connection,
                    task_id: running.task_id,
                    cursor: 1,
                    max_bytes: 4096,
                },
            )
            .await
            else {
                panic!()
            };
            if !output.events.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    ssh_call(
        &mut executor,
        ssh::Request::ExecCancel {
            connection,
            task_id: running.task_id,
        },
    )
    .await;
    let cancelled = agent_exec_done(&mut executor, connection, running.task_id)
        .await
        .summary
        .unwrap();
    assert_eq!(cancelled.end, ssh::ExecEnd::Cancelled);
    assert!(cancelled.exit_status.is_none());
    assert_eq!(
        *remote.exec_calls.lock().unwrap(),
        vec![b"fail".to_vec(), b"stall".to_vec()]
    );
    ok(executor
        .request(agent(A::Release {
            connection,
            lease_id: l.lease_id,
        }))
        .await
        .unwrap());
    assert_eq!(
        agent_exec_start(&mut executor, connection, id, "fail")
            .await
            .task_id,
        task.task_id
    );
    lease(&mut other, connection, 10000).await;
    for request in [
        ssh::Request::ExecStatus {
            connection,
            task_id: task.task_id,
        },
        ssh::Request::ExecRead {
            connection,
            task_id: task.task_id,
            cursor: 1,
            max_bytes: 4096,
        },
        ssh::Request::ExecCancel {
            connection,
            task_id: task.task_id,
        },
        request(),
    ] {
        assert_eq!(
            error(other.request(Request::Ssh { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let mut changed = request();
    if let ssh::Request::Exec { command, .. } = &mut changed {
        *command = Sensitive::new("changed".into());
    }
    assert_eq!(
        error(
            other
                .request(Request::Ssh { request: changed })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            desktop
                .request(Request::Ssh { request: request() })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    // Takeover removes future execution rights, preserving own result queries/cancellation.
    ssh_call(
        &mut desktop,
        input_write(connection, Uuid::new_v4(), b"user"),
    )
    .await;
    agent_exec_done(&mut executor, connection, task.task_id).await;
    assert_eq!(
        agent_exec_start(&mut executor, connection, id, "fail")
            .await
            .task_id,
        task.task_id
    );
    assert_eq!(
        error(
            executor
                .request(Request::Ssh {
                    request: ssh::Request::Exec {
                        connection,
                        request_id: Uuid::new_v4(),
                        command: Sensitive::new("new-forbidden".into()),
                        timeout_ms: 1000,
                        max_output_bytes: 4096
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        *remote.exec_calls.lock().unwrap(),
        vec![b"fail".to_vec(), b"stall".to_vec()]
    );
    assert!(matches!(
        ssh_call(
            &mut desktop,
            ssh::Request::ExecStatus {
                connection,
                task_id: task.task_id
            }
        )
        .await,
        ssh::Reply::Exec(_)
    ));
    service.stop(&mut desktop).await;
}
#[tokio::test]
async fn agent_queued_exec_is_cancelled_before_remote_dispatch_for_every_ownership_change() {
    use session_core::input::InputState as I;
    for mode in [
        "release",
        "expiry",
        "revoke",
        "user",
        "explicit",
        "user-exec",
    ] {
        let remote = ssh_fixture::Fixture::options(true).await;
        let temp = ConfigTemp::new();
        let mut service = temp.start().await;
        let mut desktop = service.connect().await;
        let connection = ssh_connected_fixture(&mut desktop, &remote).await;
        let permissions = vec![
            scope(connection, Action::Write),
            scope(connection, Action::Exec),
        ];
        let (ticket_id, token) = issue(&mut desktop, permissions, 30000).await;
        let (mut executor, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        let l = lease(
            &mut executor,
            connection,
            if mode == "expiry" { 300 } else { 10000 },
        )
        .await;
        let blocker = Uuid::new_v4();
        ssh_call(
            &mut executor,
            input_write(connection, blocker, &vec![b'b'; 65536]),
        )
        .await;
        input_status(&mut executor, connection, blocker, |r| {
            r.state == I::Dispatching
        })
        .await;
        timeout(Duration::from_secs(3), async {
            while remote.received.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let queued =
            agent_exec_start(&mut executor, connection, Uuid::new_v4(), "never-exec").await;
        assert_eq!(queued.phase, ssh::TaskPhase::Queued);
        let mut user_task = None;
        match mode {
            "release" => {
                ok(executor
                    .request(agent(A::Release {
                        connection,
                        lease_id: l.lease_id,
                    }))
                    .await
                    .unwrap());
                lease(&mut executor, connection, 10000).await;
            }
            "expiry" => tokio::time::sleep(Duration::from_millis(350)).await,
            "revoke" => {
                ok(desktop
                    .request(Request::Revoke { ticket_id })
                    .await
                    .unwrap());
            }
            "user" => {
                ssh_call(
                    &mut desktop,
                    input_write(connection, Uuid::new_v4(), b"user"),
                )
                .await;
            }
            "user-exec" => {
                user_task = Some(
                    agent_exec_start(&mut desktop, connection, Uuid::new_v4(), "fresh-user-exec")
                        .await
                        .task_id,
                );
            }
            _ => {
                ok(desktop
                    .request(agent(A::Takeover { connection }))
                    .await
                    .unwrap());
            }
        }
        remote.unblock.notify_one();
        input_status(&mut desktop, connection, blocker, |r| {
            r.state == I::PipelineQueued
        })
        .await;
        let done = agent_exec_done(&mut desktop, connection, queued.task_id).await;
        assert_eq!(
            done.summary.unwrap().end,
            ssh::ExecEnd::CancelledBeforeDispatch
        );
        if let Some(id) = user_task {
            assert_eq!(
                agent_exec_done(&mut desktop, connection, id)
                    .await
                    .summary
                    .unwrap()
                    .exit_status,
                Some(0)
            );
        }
        let fence = Uuid::new_v4();
        ssh_call(&mut desktop, input_write(connection, fence, b"fence")).await;
        input_status(&mut desktop, connection, fence, |r| {
            r.state == I::PipelineQueued
        })
        .await;
        let expected = if mode == "user-exec" {
            vec![b"fresh-user-exec".to_vec()]
        } else {
            vec![]
        };
        assert_eq!(*remote.exec_calls.lock().unwrap(), expected);
        service.stop(&mut desktop).await;
    }
}

async fn managed(
    client: &mut Client,
    request: A,
) -> (session_core::pairing::grants::View, Option<Sensitive>) {
    match ok(client.request(agent(request)).await.unwrap()) {
        Reply::Agent(AR::Grant { receipt, token }) => (receipt, token),
        _ => panic!("managed grant expected"),
    }
}
#[tokio::test]
async fn managed_grants_recover_same_token_across_clients_and_revoke_without_renewal() {
    use session_core::pairing::grants::State as G;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let id = Uuid::new_v4();
    let scopes = vec![
        scope(connection, Action::Read),
        scope(connection, Action::Write),
    ];
    let (first, token) = managed(
        &mut desktop,
        A::Grant {
            request_id: id,
            scopes: scopes.clone(),
            lifetime_ms: 30000,
        },
    )
    .await;
    let token = token.unwrap();
    // Ignore the first issuance reply as a caller would after opaque delivery loss.
    let mut recovered_desktop = service.connect().await;
    let (status, recovered) =
        managed(&mut recovered_desktop, A::GrantStatus { request_id: id }).await;
    assert_eq!(status.summary.ticket_id, first.summary.ticket_id);
    assert_eq!(status.summary.expires_at_ms, first.summary.expires_at_ms);
    assert_eq!(recovered.unwrap().expose(), token.expose());
    let (replayed, recovered) = managed(
        &mut recovered_desktop,
        A::Grant {
            request_id: id,
            scopes: scopes.iter().rev().copied().collect(),
            lifetime_ms: 30000,
        },
    )
    .await;
    assert_eq!(replayed.summary.ticket_id, first.summary.ticket_id);
    assert_eq!(recovered.unwrap().expose(), token.expose());
    assert_eq!(
        error(
            desktop
                .request(agent(A::Grant {
                    request_id: id,
                    scopes: scopes.clone(),
                    lifetime_ms: 29999
                }))
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    let Reply::Agent(AR::GrantList(list)) =
        ok(desktop.request(agent(A::GrantList {})).await.unwrap())
    else {
        panic!()
    };
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].request_id, id);
    assert_eq!(list[0].effective_scope_count, 2);
    assert!(
        !serde_json::to_string(&list)
            .unwrap()
            .contains(token.expose())
    );
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut client, connection, 5000).await;
    for request in [
        A::GrantStatus { request_id: id },
        A::GrantList {},
        A::GrantRevoke { request_id: id },
    ] {
        assert_eq!(
            error(client.request(agent(request)).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let Reply::ReadTicket {
        token: reader_token,
        ..
    } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 30000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) = Client::connect(&service.instance, reader_token.expose(), service.pid)
        .await
        .unwrap();
    for request in [
        A::GrantStatus { request_id: id },
        A::GrantList {},
        A::GrantRevoke { request_id: id },
    ] {
        assert_eq!(
            error(observer.request(agent(request)).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    ok(desktop
        .request(agent(A::Takeover { connection }))
        .await
        .unwrap());
    let (taken, _) = managed(&mut desktop, A::GrantStatus { request_id: id }).await;
    assert_eq!(taken.approved_scopes.len(), 2);
    assert_eq!(
        taken.effective_scopes,
        vec![scope(connection, Action::Read)]
    );
    let (revoked, none) = managed(&mut recovered_desktop, A::GrantRevoke { request_id: id }).await;
    assert_eq!(revoked.summary.state, G::Revoked);
    assert!(none.is_none());
    let (again, none) = managed(&mut desktop, A::GrantRevoke { request_id: id }).await;
    assert_eq!(again.summary.ticket_id, first.summary.ticket_id);
    assert!(none.is_none());
    let (again, none) = managed(
        &mut desktop,
        A::Grant {
            request_id: id,
            scopes,
            lifetime_ms: 30000,
        },
    )
    .await;
    assert_eq!(again.summary.state, G::Revoked);
    assert!(none.is_none());
    assert_eq!(
        error(client.request(Request::Ping {}).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert!(
        Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .is_err()
    );
    assert!(matches!(
        ok(desktop
            .request(agent(A::Lease { connection }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    assert!(
        matches!(ok(observer.request(Request::List {}).await.unwrap()),Reply::Sessions(list) if list.len()==1),
        "unrelated read ticket remains valid"
    );
    assert_eq!(
        error(
            desktop
                .request(agent(A::GrantStatus {
                    request_id: Uuid::new_v4()
                }))
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    assert_eq!(
        error(
            desktop
                .request(agent(A::GrantRevoke {
                    request_id: Uuid::new_v4()
                }))
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    service.stop(&mut desktop).await;
}
#[tokio::test]
async fn managed_grant_recovery_survives_retired_sources_but_not_service_restart_or_expiry() {
    use session_core::pairing::grants::State as G;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let id = Uuid::new_v4();
    let scopes = vec![scope(connection, Action::Read)];
    let (first, token) = managed(
        &mut desktop,
        A::Grant {
            request_id: id,
            scopes: scopes.clone(),
            lifetime_ms: 30000,
        },
    )
    .await;
    let token = token.unwrap();
    ok(desktop
        .request(Request::CloseFixture { connection })
        .await
        .unwrap());
    ok(desktop
        .request(Request::RemoveFixture { connection })
        .await
        .unwrap());
    let (old, recovered) = managed(
        &mut desktop,
        A::Grant {
            request_id: id,
            scopes: scopes.clone(),
            lifetime_ms: 30000,
        },
    )
    .await;
    assert_eq!(old.summary.ticket_id, first.summary.ticket_id);
    assert!(old.effective_scopes.is_empty());
    assert_eq!(recovered.unwrap().expose(), token.expose());
    assert_eq!(
        error(
            desktop
                .request(agent(A::Grant {
                    request_id: Uuid::new_v4(),
                    scopes,
                    lifetime_ms: 30000
                }))
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    // Profile deletion cannot force a retry to issue a new token or fail lookup.
    let profile = portable();
    config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let profile_id = Uuid::new_v4();
    let profile_scopes = vec![Scope {
        target: Target::Profile {
            profile_id: profile.id,
        },
        action: Action::Connect,
    }];
    let (saved, _) = managed(
        &mut desktop,
        A::Grant {
            request_id: profile_id,
            scopes: profile_scopes.clone(),
            lifetime_ms: 30000,
        },
    )
    .await;
    config_call(
        &mut desktop,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    let (saved_retry, _) = managed(
        &mut desktop,
        A::Grant {
            request_id: profile_id,
            scopes: profile_scopes,
            lifetime_ms: 30000,
        },
    )
    .await;
    assert_eq!(saved_retry.summary.ticket_id, saved.summary.ticket_id);
    assert_eq!(
        saved_retry.summary.expires_at_ms,
        saved.summary.expires_at_ms
    );
    let active = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let expiry = Uuid::new_v4();
    let (expiring, expiring_token) = managed(
        &mut desktop,
        A::Grant {
            request_id: expiry,
            scopes: vec![scope(active, Action::Read)],
            lifetime_ms: 200,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let (expired, none) = managed(&mut desktop, A::GrantStatus { request_id: expiry }).await;
    assert_eq!(expired.summary.state, G::Expired);
    assert!(none.is_none());
    let (expired, none) = managed(
        &mut desktop,
        A::Grant {
            request_id: expiry,
            scopes: vec![scope(active, Action::Read)],
            lifetime_ms: 200,
        },
    )
    .await;
    assert_eq!(
        expired.summary.expires_at_ms,
        expiring.summary.expires_at_ms
    );
    assert!(none.is_none());
    assert!(
        Client::connect(
            &service.instance,
            expiring_token.unwrap().expose(),
            service.pid
        )
        .await
        .is_err()
    );
    service.stop(&mut desktop).await;
    let mut restarted = temp.start().await;
    let mut desktop = restarted.connect().await;
    assert!(
        matches!(ok(desktop.request(agent(A::GrantList {})).await.unwrap()),Reply::Agent(AR::GrantList(list)) if list.is_empty())
    );
    assert_eq!(
        error(
            desktop
                .request(agent(A::GrantStatus { request_id: id }))
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    assert!(
        Client::connect(&restarted.instance, token.expose(), restarted.pid)
            .await
            .is_err()
    );
    restarted.stop(&mut desktop).await;
}

#[tokio::test]
async fn managed_grant_unread_real_pipe_reply_and_concurrent_retries_recover_one_issuance() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let id = Uuid::new_v4();
    let scopes = vec![scope(connection, Action::Read)];
    let mut pipe = service.raw().await;
    write_frame(
        &mut pipe,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-unread-grant".into(),
            token: Sensitive::new(service.token.expose().to_string()),
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        read_frame::<_, Response>(&mut pipe).await.unwrap().unwrap(),
        Response::Ok { id: 0, .. }
    ));
    write_frame(
        &mut pipe,
        &RequestEnvelope {
            id: 1,
            request: agent(A::Grant {
                request_id: id,
                scopes: scopes.clone(),
                lifetime_ms: 30000,
            }),
        },
    )
    .await
    .unwrap();
    // Never read this request's response. A separate authenticated pipe observes
    // actual service completion, then the original transport is discarded.
    let mut recovered = None;
    for _ in 0..200 {
        match desktop
            .request(agent(A::GrantStatus { request_id: id }))
            .await
            .unwrap()
        {
            Response::Ok {
                reply:
                    Reply::Agent(AR::Grant {
                        receipt,
                        token: Some(token),
                    }),
                ..
            } => {
                recovered = Some((receipt, token));
                break;
            }
            Response::Error {
                code: ErrorCode::NotFound,
                ..
            } => tokio::time::sleep(Duration::from_millis(5)).await,
            _ => panic!("unexpected recovery result"),
        }
    }
    drop(pipe);
    let (original, token) = recovered.expect("unread issuance was not observed");
    let (retry, retry_token) = managed(
        &mut desktop,
        A::Grant {
            request_id: id,
            scopes,
            lifetime_ms: 30000,
        },
    )
    .await;
    assert_eq!(retry.summary.ticket_id, original.summary.ticket_id);
    assert_eq!(retry.summary.expires_at_ms, original.summary.expires_at_ms);
    assert_eq!(retry_token.unwrap().expose(), token.expose());
    assert!(
        Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .is_ok()
    );
    let profile = portable();
    config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let request_id = Uuid::new_v4();
    let scope = Scope {
        target: Target::Profile {
            profile_id: profile.id,
        },
        action: Action::Connect,
    };
    let mut other = service.connect().await;
    let (a, b) = tokio::join!(
        managed(
            &mut desktop,
            A::Grant {
                request_id,
                scopes: vec![scope],
                lifetime_ms: 30000
            }
        ),
        managed(
            &mut other,
            A::Grant {
                request_id,
                scopes: vec![scope],
                lifetime_ms: 30000
            }
        )
    );
    assert_eq!(a.0.summary.ticket_id, b.0.summary.ticket_id);
    assert_eq!(a.0.summary.expires_at_ms, b.0.summary.expires_at_ms);
    assert_eq!(a.1.unwrap().expose(), b.1.unwrap().expose());
    let Reply::Agent(AR::GrantList(list)) =
        ok(desktop.request(agent(A::GrantList {})).await.unwrap())
    else {
        panic!()
    };
    assert_eq!(list.len(), 2);
    // The original ticket-id Revoke also clears the managed recovery token.
    ok(desktop
        .request(Request::Revoke {
            ticket_id: original.summary.ticket_id,
        })
        .await
        .unwrap());
    let (revoked, none) = managed(&mut desktop, A::GrantStatus { request_id: id }).await;
    assert_eq!(
        revoked.summary.state,
        session_core::pairing::grants::State::Revoked
    );
    assert!(none.is_none());
    service.stop(&mut desktop).await;
}
