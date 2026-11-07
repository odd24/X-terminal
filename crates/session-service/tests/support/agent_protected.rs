//! Real named-pipe protection, never a second shell or a caller-selected policy.

#[tokio::test]
async fn protected_ticket_expiry_does_not_restore_legacy_reads_or_renew_original_receipt() {
    let mut service = Fixture::start(true).await;
    let mut desktop = service.connect().await;
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let id = Uuid::new_v4();
    let request = || {
        agent(A::GrantProtected {
            request_id: id,
            scopes: vec![scope(c, Action::Read)],
            lifetime_ms: 1000,
            form: ProtectedForm::Scoped {},
            redaction: Redaction {
                sensitive_fields: true,
                literals: vec![],
            },
        })
    };
    let Reply::Agent(AR::Grant {
        receipt,
        token: Some(token),
    }) = ok(desktop.request(request()).await.unwrap())
    else {
        panic!()
    };
    let (mut reader, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    ok(reader
        .request(protected(c, None, View::Info {}))
        .await
        .unwrap());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        error(
            reader
                .request(protected(c, None, View::Info {}))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
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
    let Reply::Agent(AR::Grant {
        receipt: replay,
        token: None,
    }) = ok(desktop.request(request()).await.unwrap())
    else {
        panic!()
    };
    assert_eq!(
        replay.summary.state,
        session_core::pairing::grants::State::Expired
    );
    assert_eq!(replay.summary.expires_at_ms, receipt.summary.expires_at_ms);
    assert_eq!(replay.protection, receipt.protection);
    service.stop(&mut desktop).await;
}
use super::*;
use session_core::{
    pairing::grants::View as GrantView,
    protected_context::{Reply as C, View},
    protected_task::{Reply as T, View as TV},
};
use session_protocol::agent::{ProtectedForm, Redaction};

fn grant(id: Uuid, scopes: Vec<Scope>, form: ProtectedForm, literal: &str) -> Request {
    agent(A::GrantProtected {
        request_id: id,
        scopes,
        lifetime_ms: 30000,
        form,
        redaction: Redaction {
            sensitive_fields: false,
            literals: vec![Sensitive::new(literal.into())],
        },
    })
}
async fn issue_protected(
    desktop: &mut Client,
    service: &Fixture,
    c: ConnectionRef,
    action: Action,
    form: ProtectedForm,
    literal: &str,
) -> (Uuid, GrantView, Client) {
    let id = Uuid::new_v4();
    let Reply::Agent(AR::Grant {
        receipt,
        token: Some(token),
    }) = ok(desktop
        .request(grant(id, vec![scope(c, action)], form, literal))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(!serde_json::to_string(&receipt).unwrap().contains(literal));
    let (client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    (id, receipt, client)
}
fn protected(
    c: ConnectionRef,
    window: Option<session_core::context::TimeWindow>,
    view: View,
) -> Request {
    Request::ProtectedContext {
        connection: c,
        window,
        view,
    }
}

#[tokio::test]
async fn protected_context_real_pipe_masks_before_paging_denies_all_legacy_views_and_keeps_desktop_source()
 {
    let mut service = Fixture::start(true).await;
    let mut desktop = service.connect().await;
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    for part in [
        b"safe synthetic-".as_slice(),
        b"secret\r\npublic\r\n",
        b"padding-last-line\r\n",
    ] {
        ok(desktop
            .request(Request::AppendFixture {
                connection: c,
                bytes: part.to_vec(),
            })
            .await
            .unwrap());
    }
    let (id, receipt, mut reader) = issue_protected(
        &mut desktop,
        &service,
        c,
        Action::Read,
        ProtectedForm::Scoped {},
        "synthetic-secret",
    )
    .await;
    let info = receipt.protection.unwrap();
    let Reply::ProtectedContext(C::Info { context }) = ok(reader
        .request(protected(c, None, View::Info {}))
        .await
        .unwrap())
    else {
        panic!()
    };
    let through = context.through_cursor;
    assert_eq!(context.protection, info);
    for cursor in [1, 2] {
        let Reply::ProtectedContext(C::Text { page, context }) = ok(reader
            .request(protected(
                c,
                None,
                View::Text {
                    through_cursor: through,
                    cursor,
                    max_bytes: 16384,
                },
            ))
            .await
            .unwrap())
        else {
            panic!()
        };
        let text: String = page.events.iter().map(|e| e.text.as_str()).collect();
        assert!(!text.contains("secret"));
        assert!(!text.contains("synthetic"));
        assert!(text.contains("public"));
        assert_eq!(page.source_cursor, through);
        assert_eq!(context.protection, info);
    }
    let Reply::ProtectedContext(C::Screen { screen, context }) = ok(reader
        .request(protected(
            c,
            None,
            View::Screen {
                through_cursor: through,
            },
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(!screen.contents.contains("secret"));
    assert!(context.report.screen_rows_hidden > 0);
    let window = session_core::context::TimeWindow {
        from_ms: 0,
        until_ms: 253_402_300_799_999,
    };
    for request in [
        Request::Read {
            connection: c,
            cursor: 1,
            max_bytes: 65536,
        },
        Request::ReadText {
            connection: c,
            cursor: 1,
            max_bytes: 65536,
        },
        Request::Screen { connection: c },
        Request::Context {
            connection: c,
            window,
            view: session_core::context::View::Raw {
                through_cursor: through,
                cursor: 1,
                max_bytes: 65536,
            },
        },
        Request::Context {
            connection: c,
            window,
            view: session_core::context::View::Text {
                through_cursor: through,
                cursor: 1,
                max_bytes: 65536,
            },
        },
        Request::Context {
            connection: c,
            window,
            view: session_core::context::View::Screen {
                through_cursor: through,
            },
        },
        grant(
            Uuid::new_v4(),
            vec![scope(c, Action::Read)],
            ProtectedForm::Scoped {},
            "bypass",
        ),
    ] {
        assert_eq!(
            error(reader.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let Reply::Output(original) = ok(desktop
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
    assert!(
        String::from_utf8(
            original
                .events
                .iter()
                .flat_map(|e| e.bytes.iter().copied())
                .collect()
        )
        .unwrap()
        .contains("synthetic-secret")
    );
    let Reply::Agent(AR::Grant {
        receipt: replay, ..
    }) = ok(desktop
        .request(grant(
            id,
            vec![scope(c, Action::Read)],
            ProtectedForm::Scoped {},
            "synthetic-secret",
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(replay.protection, Some(info));
    assert_eq!(replay.summary.expires_at_ms, receipt.summary.expires_at_ms);
    assert_eq!(
        error(
            desktop
                .request(grant(
                    id,
                    vec![scope(c, Action::Read)],
                    ProtectedForm::Scoped {},
                    "changed"
                ))
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    ok(desktop
        .request(agent(A::GrantRevoke { request_id: id }))
        .await
        .unwrap());
    assert_eq!(
        error(
            reader
                .request(protected(c, None, View::Info {}))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn protected_exec_single_operation_masks_both_actual_streams_and_cannot_borrow_another_owner()
{
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = ssh_connected_fixture(&mut desktop, &remote).await;
    let request_id = Uuid::new_v4();
    let operation = session_protocol::operation::Operation::Ssh2(ssh::Request::Exec {
        connection: c,
        request_id,
        command: Sensitive::new("utf8".into()),
        timeout_ms: 2000,
        max_output_bytes: 4096,
    });
    let (_, _, mut executor) = issue_protected(
        &mut desktop,
        &service,
        c,
        Action::Exec,
        ProtectedForm::SingleOperation {
            operation: Box::new(operation),
        },
        "中",
    )
    .await;
    lease(&mut executor, c, 10000).await;
    let task = agent_exec_start(&mut executor, c, request_id, "utf8").await;
    agent_exec_done(&mut executor, c, task.task_id).await;
    let read = |view| Request::Ssh {
        request: ssh::Request::ExecReadProtected {
            connection: c,
            task_id: task.task_id,
            view,
        },
    };
    let Reply::Ssh(ssh::Reply::ExecProtectedOutput { output, .. }) =
        ok(executor.request(read(TV::Info {})).await.unwrap())
    else {
        panic!()
    };
    let T::Info { context } = *output else {
        panic!()
    };
    let view = TV::Text {
        through_cursor: context.through_cursor,
        cursor: 1,
        max_bytes: 16384,
    };
    let Reply::Ssh(ssh::Reply::ExecProtectedOutput { output, .. }) =
        ok(executor.request(read(view)).await.unwrap())
    else {
        panic!()
    };
    let T::Text { events, .. } = *output else {
        panic!()
    };
    assert_eq!(
        events
            .iter()
            .filter(|e| !e.stderr)
            .map(|e| e.text.as_str())
            .collect::<String>(),
        "early|***"
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.stderr)
            .map(|e| e.text.as_str())
            .collect::<String>(),
        "err|测"
    );
    assert_eq!(
        error(
            executor
                .request(Request::Ssh {
                    request: ssh::Request::ExecRead {
                        connection: c,
                        task_id: task.task_id,
                        cursor: 1,
                        max_bytes: 4096
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            executor
                .request(protected(c, None, View::Info {}))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let (_, _, mut other) = issue_protected(
        &mut desktop,
        &service,
        c,
        Action::Exec,
        ProtectedForm::TimedTask {
            task_id: Uuid::new_v4(),
            label: "合成读取".into(),
        },
        "中",
    )
    .await;
    assert_eq!(
        error(other.request(read(view)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(desktop.request(read(view)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        remote.exec_calls.lock().unwrap().as_slice(),
        [b"utf8".to_vec()]
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn protected_window_task_never_expands_to_full_output_or_restores_after_retirement() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let (c, window, through) = super::context_cases::source(&mut desktop).await;
    let id = Uuid::new_v4();
    let scopes = vec![Scope {
        target: Target::OutputWindow {
            connection: c,
            window,
        },
        action: Action::Read,
    }];
    let task_id = Uuid::new_v4();
    let request = || {
        agent(A::GrantProtected {
            request_id: id,
            scopes: scopes.clone(),
            lifetime_ms: 30000,
            form: ProtectedForm::TimedTask {
                task_id,
                label: "限定时窗".into(),
            },
            redaction: Redaction {
                sensitive_fields: true,
                literals: vec![],
            },
        })
    };
    let Reply::Agent(AR::Grant {
        token: Some(token),
        receipt,
    }) = ok(desktop.request(request()).await.unwrap())
    else {
        panic!()
    };
    let (mut reader, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let Reply::ProtectedContext(C::Text { page, context }) = ok(reader
        .request(protected(
            c,
            Some(window),
            View::Text {
                through_cursor: through,
                cursor: 1,
                max_bytes: 16384,
            },
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(context.report.boundary_guard);
    assert_eq!(page.events.len(), 1);
    assert!(page.events[0].text.bytes().all(|b| b == b'*'));
    for window in [
        None,
        Some(session_core::context::TimeWindow {
            from_ms: 0,
            until_ms: window.until_ms + 1,
        }),
    ] {
        assert_eq!(
            error(
                reader
                    .request(protected(c, window, View::Info {}))
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    ok(desktop
        .request(Request::CloseFixture { connection: c })
        .await
        .unwrap());
    ok(desktop
        .request(Request::RemoveFixture { connection: c })
        .await
        .unwrap());
    let Reply::Agent(AR::Grant {
        receipt: replay,
        token: Some(replayed),
    }) = ok(desktop.request(request()).await.unwrap())
    else {
        panic!()
    };
    assert!(replay.effective_scopes.is_empty());
    assert_eq!(replay.protection, receipt.protection);
    assert_eq!(replayed.expose(), token.expose());
    assert_eq!(
        error(
            reader
                .request(protected(c, Some(window), View::Info {}))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn protected_exec_status_cancel_and_replayed_start_mask_remote_signal_but_keep_original_status()
 {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = ssh_connected_fixture(&mut desktop, &remote).await;
    let (_, _, mut executor) = issue_protected(
        &mut desktop,
        &service,
        c,
        Action::Exec,
        ProtectedForm::Scoped {},
        "synthetic-secret",
    )
    .await;
    lease(&mut executor, c, 10000).await;
    let id = Uuid::new_v4();
    let task = agent_exec_start(&mut executor, c, id, "protected-signal").await;
    let done = agent_exec_done(&mut executor, c, task.task_id).await;
    assert_eq!(
        done.summary.unwrap().exit_signal.as_deref(),
        Some("****************")
    );
    let retried = agent_exec_start(&mut executor, c, id, "protected-signal").await;
    assert_eq!(retried.task_id, task.task_id);
    assert_eq!(
        retried.summary.unwrap().exit_signal.as_deref(),
        Some("****************")
    );
    let ssh::Reply::Exec(cancelled) = ssh_call(
        &mut executor,
        ssh::Request::ExecCancel {
            connection: c,
            task_id: task.task_id,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(
        cancelled.summary.unwrap().exit_signal.as_deref(),
        Some("****************")
    );
    let ssh::Reply::Exec(original) = ssh_call(
        &mut desktop,
        ssh::Request::ExecStatus {
            connection: c,
            task_id: task.task_id,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(
        original.summary.unwrap().exit_signal.as_deref(),
        Some("synthetic-secret")
    );
    assert_eq!(remote.exec_calls.lock().unwrap().len(), 1);
    service.stop(&mut desktop).await;
}
