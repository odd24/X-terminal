//! Single/task grants through real Windows pipes and synthetic transports.
use super::*;
use session_core::{authorization::Form, pairing::grants::View};
use session_protocol::operation::Operation;
use ssh::Request as S;
#[cfg(feature = "serial-ui-fixture")]
#[path = "agent_forms_serial.rs"]
mod serial_forms;

fn copy_operation(operation: &Operation) -> Operation {
    // Test fixture only; production never copies payload into management receipts.
    serde_json::from_value(serde_json::to_value(operation).unwrap()).unwrap()
}
async fn single(
    desktop: &mut Client,
    service: &Fixture,
    scopes: Vec<Scope>,
    operation: &Operation,
) -> (Uuid, View, Client) {
    let id = Uuid::new_v4();
    let mut first = None;
    for attempt in 0..2 {
        let Reply::Agent(AR::Grant {
            receipt,
            token: Some(token),
        }) = ok(desktop
            .request(agent(A::GrantOperation {
                request_id: id,
                scopes: scopes.clone(),
                lifetime_ms: 30000,
                operation: Box::new(copy_operation(operation)),
            }))
            .await
            .unwrap())
        else {
            panic!()
        };
        assert_eq!(
            receipt.form.as_deref(),
            Some(&Form::SingleOperation {
                operation: operation.key().unwrap()
            })
        );
        if let Some((old, ref old_token)) = first {
            assert_eq!(old, receipt.summary.expires_at_ms);
            assert_eq!(old_token, token.expose());
        } else {
            first = Some((receipt.summary.expires_at_ms, token.expose().to_owned()));
        }
        if let Some((_, token)) = &first {
            assert!(!serde_json::to_string(&receipt).unwrap().contains(token));
        }
        if attempt == 0 {
            continue;
        }
        let (client, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        return (id, receipt, client);
    }
    unreachable!()
}
async fn dispatch(client: &mut Client, operation: &Operation) -> Response {
    match copy_operation(operation) {
        Operation::Ssh2(request) => client.request(Request::Ssh { request }).await.unwrap(),
        Operation::Serial(request) => client.request(Request::Serial { request }).await.unwrap(),
    }
}
async fn release(client: &mut Client, c: ConnectionRef) {
    if let Reply::Agent(AR::Lease(Some(l))) = ok(client
        .request(agent(A::Lease { connection: c }))
        .await
        .unwrap())
    {
        ok(client
            .request(agent(A::Release {
                connection: c,
                lease_id: l.lease_id,
            }))
            .await
            .unwrap());
    }
}
async fn ended(client: &mut Client, c: ConnectionRef, id: Uuid) {
    timeout(Duration::from_secs(5), async {
        loop {
            if matches!(ssh_call(client, S::DisconnectStatus { connection: c, request_id: id }).await,
                ssh::Reply::Disconnect(r) if r.state == session_core::disconnect::State::TransportEnded) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
}
fn connect_scope(profile_id: Uuid, revision: Uuid) -> Scope {
    Scope {
        target: Target::ProfileRevision {
            profile_id,
            revision,
        },
        action: Action::Connect,
    }
}

#[tokio::test]
async fn single_start_requires_fixed_profile_and_recovers_after_profile_deletion() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    let config::ConfigReply::SavedProfile { revision, .. } = config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&remote.password),
        },
    )
    .await
    else {
        panic!()
    };
    let operation = Operation::Ssh2(S::Start {
        profile_id: profile.id,
        request_id: Uuid::new_v4(),
        cols: 80,
        rows: 24,
    });
    let scopes = vec![connect_scope(profile.id, revision)];
    let (id, receipt, mut client) =
        single(&mut desktop, &service, scopes.clone(), &operation).await;
    let original = ok(dispatch(&mut client, &operation).await);
    let Reply::Ssh(ssh::Reply::Started { connection }) = &original else {
        panic!()
    };
    assert_eq!(
        error(
            client
                .request(Request::Screen {
                    connection: connection.reference()
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    config_call(
        &mut desktop,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    assert_eq!(
        serde_json::to_value(ok(dispatch(&mut client, &operation).await)).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    let Reply::Agent(AR::Grant {
        receipt: replay, ..
    }) = ok(desktop
        .request(agent(A::GrantOperation {
            request_id: id,
            scopes,
            lifetime_ms: 30000,
            operation: Box::new(copy_operation(&operation)),
        }))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(receipt.summary.ticket_id, replay.summary.ticket_id);
    assert_eq!(receipt.summary.expires_at_ms, replay.summary.expires_at_ms);
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Start {
                        profile_id: profile.id,
                        request_id: Uuid::new_v4(),
                        cols: 80,
                        rows: 24
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn single_disconnect_reconnect_and_forget_recover_after_retirement_without_reexecution() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let (c, profile) = ssh_connected_encoded_fixture(
        &mut desktop,
        &remote,
        Uuid::new_v4(),
        config_store::Encoding::Utf8,
    )
    .await;
    let disconnect = Operation::Ssh2(S::Disconnect {
        connection: c,
        request_id: Uuid::new_v4(),
    });
    let (_, _, mut closer) = single(
        &mut desktop,
        &service,
        vec![scope(c, Action::Disconnect)],
        &disconnect,
    )
    .await;
    lease(&mut closer, c, 10000).await;
    ok(dispatch(&mut closer, &disconnect).await);
    ended(&mut closer, c, disconnect.descriptor().unwrap().request_id).await;
    let config::ConfigReply::SavedProfile { revision, .. } = config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await
    else {
        panic!()
    };
    let reconnect = Operation::Ssh2(S::Reconnect {
        connection: c,
        request_id: Uuid::new_v4(),
        cols: 81,
        rows: 25,
    });
    let scopes = vec![
        scope(c, Action::Reconnect),
        connect_scope(profile.id, revision),
    ];
    let (grant_id, _, mut restarter) =
        single(&mut desktop, &service, scopes.clone(), &reconnect).await;
    lease(&mut restarter, c, 10000).await;
    let original = ok(dispatch(&mut restarter, &reconnect).await);
    let Reply::Ssh(ssh::Reply::Started { connection }) = &original else {
        panic!()
    };
    let next = connection.reference();
    assert_eq!(next.generation, c.generation + 1);
    assert_eq!(
        error(
            restarter
                .request(Request::Screen { connection: next })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    config_call(
        &mut desktop,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    assert_eq!(
        serde_json::to_value(ok(dispatch(&mut restarter, &reconnect).await)).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    ok(desktop
        .request(agent(A::GrantOperation {
            request_id: grant_id,
            scopes,
            lifetime_ms: 30000,
            operation: Box::new(copy_operation(&reconnect)),
        }))
        .await
        .unwrap());
    assert!(
        matches!(ok(dispatch(&mut closer, &disconnect).await), Reply::Ssh(ssh::Reply::Disconnect(r)) if r.state == session_core::disconnect::State::TransportEnded)
    );
    let close_id = Uuid::new_v4();
    ssh_call(
        &mut desktop,
        S::Disconnect {
            connection: next,
            request_id: close_id,
        },
    )
    .await;
    ended(&mut desktop, next, close_id).await;
    let forget = Operation::Ssh2(S::ForgetStart {
        connection: next,
        request_id: Uuid::new_v4(),
    });
    let (grant_id, _, mut remover) = single(
        &mut desktop,
        &service,
        vec![scope(next, Action::Forget)],
        &forget,
    )
    .await;
    lease(&mut remover, next, 10000).await;
    assert!(
        matches!(ok(dispatch(&mut remover, &forget).await), Reply::Ssh(ssh::Reply::Forget(r)) if r.state == session_core::forget::State::Removed)
    );
    assert!(
        matches!(ok(dispatch(&mut remover, &forget).await), Reply::Ssh(ssh::Reply::Forget(r)) if r.state == session_core::forget::State::Removed)
    );
    ssh_call(
        &mut remover,
        S::ForgetStatus {
            connection: next,
            request_id: forget.descriptor().unwrap().request_id,
        },
    )
    .await;
    assert_eq!(
        error(
            desktop
                .request(Request::Ssh {
                    request: S::Status { connection: next }
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    let Reply::Agent(AR::Grant { receipt, .. }) = ok(desktop
        .request(agent(A::GrantStatus {
            request_id: grant_id,
        }))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(receipt.effective_scopes.is_empty());
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn single_ssh_input_parameters_and_receipts_are_bound_before_shared_dispatch() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = ssh_connected_fixture(&mut desktop, &remote).await;
    let operations = [
        Operation::Ssh2(input_write(c, Uuid::new_v4(), b"raw")),
        Operation::Ssh2(S::WriteText {
            connection: c,
            request_id: Uuid::new_v4(),
            text: Sensitive::new("中文\r\n".into()),
        }),
        Operation::Ssh2(S::Resize {
            connection: c,
            request_id: Uuid::new_v4(),
            cols: 93,
            rows: 31,
        }),
        Operation::Ssh2(S::Exec {
            connection: c,
            request_id: Uuid::new_v4(),
            command: Sensitive::new("stall".into()),
            timeout_ms: 30000,
            max_output_bytes: 256,
        }),
    ];
    for operation in operations {
        let d = operation.descriptor().unwrap();
        let (grant_id, receipt, mut client) =
            single(&mut desktop, &service, vec![scope(c, d.action)], &operation).await;
        assert_eq!(
            error(
                client
                    .request(Request::Screen { connection: c })
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            error(dispatch(&mut client, &operation).await),
            ErrorCode::InputBusy
        );
        lease(&mut client, c, 10000).await;
        for field in [
            "request_id",
            "connection",
            match d.action {
                Action::Write => {
                    if matches!(&operation, Operation::Ssh2(S::Write { .. })) {
                        "bytes"
                    } else {
                        "text"
                    }
                }
                Action::Control => "cols",
                Action::Exec => "command",
                _ => unreachable!(),
            },
        ] {
            let mut value = serde_json::to_value(&operation).unwrap();
            value["request"][field] = match field {
                "request_id" => Uuid::new_v4().to_string().into(),
                "connection" => serde_json::to_value(ConnectionRef {
                    generation: c.generation + 1,
                    ..c
                })
                .unwrap(),
                "bytes" => serde_json::json!([9]),
                "text" | "command" => "changed".into(),
                "cols" => 94.into(),
                _ => unreachable!(),
            };
            let changed: Operation = serde_json::from_value(value).unwrap();
            assert_eq!(
                error(dispatch(&mut client, &changed).await),
                ErrorCode::PermissionDenied
            );
            assert_eq!(
                error(
                    desktop
                        .request(agent(A::GrantOperation {
                            request_id: grant_id,
                            scopes: vec![scope(
                                changed.descriptor().unwrap().connection.unwrap(),
                                d.action
                            )],
                            lifetime_ms: 30000,
                            operation: Box::new(changed)
                        }))
                        .await
                        .unwrap()
                ),
                ErrorCode::InvalidArgument
            );
        }
        assert_eq!(
            error(
                desktop
                    .request(agent(A::Grant {
                        request_id: grant_id,
                        scopes: vec![scope(c, d.action)],
                        lifetime_ms: 30000
                    }))
                    .await
                    .unwrap()
            ),
            ErrorCode::InvalidArgument
        );
        let first = ok(dispatch(&mut client, &operation).await);
        let duplicate = ok(dispatch(&mut client, &operation).await);
        match (&first, &duplicate) {
            (Reply::Ssh(ssh::Reply::Input(a)), Reply::Ssh(ssh::Reply::Input(b))) => {
                assert_eq!(a.request_id, b.request_id)
            }
            (Reply::Ssh(ssh::Reply::Exec(a)), Reply::Ssh(ssh::Reply::Exec(b))) => {
                assert_eq!(a.task_id, b.task_id)
            }
            _ => panic!("same operation must recover its original receipt"),
        }
        match first {
            Reply::Ssh(ssh::Reply::Exec(task)) => {
                // Confirm actual channel dispatch before exercising cancellation;
                // returning a local task is not evidence that the peer ran it.
                timeout(Duration::from_secs(3), async {
                    while remote.exec_calls.lock().unwrap().len() != 1 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                ssh_call(
                    &mut client,
                    S::ExecRead {
                        connection: c,
                        task_id: task.task_id,
                        cursor: 1,
                        max_bytes: 4096,
                    },
                )
                .await;
                ssh_call(
                    &mut client,
                    S::ExecStatus {
                        connection: c,
                        task_id: task.task_id,
                    },
                )
                .await;
                ssh_call(
                    &mut client,
                    S::ExecCancel {
                        connection: c,
                        task_id: task.task_id,
                    },
                )
                .await;
            }
            _ => {
                input_status(&mut client, c, d.request_id, |r| {
                    r.state == session_core::input::InputState::PipelineQueued
                })
                .await;
            }
        }
        let Reply::Agent(AR::Grant {
            receipt: replay, ..
        }) = ok(desktop
            .request(agent(A::GrantStatus {
                request_id: grant_id,
            }))
            .await
            .unwrap())
        else {
            panic!()
        };
        assert_eq!(receipt.summary.expires_at_ms, replay.summary.expires_at_ms);
        release(&mut client, c).await;
        let (_, _, mut other) =
            single(&mut desktop, &service, vec![scope(c, d.action)], &operation).await;
        // Isolate receipt ownership from the independent exclusive-lease gate.
        lease(&mut other, c, 10000).await;
        assert_eq!(
            error(dispatch(&mut other, &operation).await),
            ErrorCode::PermissionDenied
        );
        release(&mut other, c).await;
    }
    timeout(Duration::from_secs(3), async {
        while remote.received.lock().unwrap().concat() != "raw中文\r\n".as_bytes() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(remote.exec_calls.lock().unwrap().len(), 1);
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn timed_task_preserves_scope_lease_owner_and_absolute_expiry_across_multiple_operations() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = ssh_connected_fixture(&mut desktop, &remote).await;
    let id = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let grant = |task_id, label: &str| {
        agent(A::GrantTask {
            request_id: id,
            task_id,
            label: label.into(),
            scopes: vec![scope(c, Action::Write)],
            lifetime_ms: 30000,
        })
    };
    let Reply::Agent(AR::Grant {
        receipt: first,
        token: Some(token),
    }) = ok(desktop.request(grant(task_id, "有限诊断")).await.unwrap())
    else {
        panic!()
    };
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    for (task, label) in [(Uuid::new_v4(), "有限诊断"), (task_id, "changed")] {
        assert_eq!(
            error(desktop.request(grant(task, label)).await.unwrap()),
            ErrorCode::InvalidArgument
        );
    }
    lease(&mut client, c, 10000).await;
    for bytes in [b"one".as_slice(), b"two"] {
        let id = Uuid::new_v4();
        ssh_call(&mut client, input_write(c, id, bytes)).await;
        input_status(&mut client, c, id, |r| {
            r.state == session_core::input::InputState::PipelineQueued
        })
        .await;
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
    ok(desktop
        .request(agent(A::Takeover { connection: c }))
        .await
        .unwrap());
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: input_write(c, Uuid::new_v4(), b"blocked")
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let Reply::Agent(AR::Grant {
        receipt: replay, ..
    }) = ok(desktop.request(grant(task_id, "有限诊断")).await.unwrap())
    else {
        panic!()
    };
    assert_eq!(first.summary.expires_at_ms, replay.summary.expires_at_ms);
    assert!(replay.effective_scopes.is_empty());
    ok(desktop
        .request(agent(A::GrantRevoke { request_id: id }))
        .await
        .unwrap());
    assert_eq!(
        error(client.request(Request::List {}).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    timeout(Duration::from_secs(3), async {
        while remote.received.lock().unwrap().concat() != b"onetwo" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    service.stop(&mut desktop).await;
}
