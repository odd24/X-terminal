use super::*;
use ssh::{ExecEnd as E, Request as S, TaskPhase};
async fn start(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
    command: &str,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> ssh::TaskStatus {
    let ssh::Reply::Exec(status) = ssh_call(
        client,
        S::Exec {
            connection,
            request_id: id,
            command: Sensitive::new(command.into()),
            timeout_ms,
            max_output_bytes,
        },
    )
    .await
    else {
        panic!()
    };
    status
}
async fn finished(client: &mut Client, connection: ConnectionRef, id: Uuid) -> ssh::TaskStatus {
    timeout(Duration::from_secs(5), async {
        loop {
            let ssh::Reply::Exec(status) = ssh_call(
                client,
                S::ExecStatus {
                    connection,
                    task_id: id,
                },
            )
            .await
            else {
                panic!()
            };
            if status.phase == TaskPhase::Finished {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
async fn output(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
) -> session_core::task_output::Page {
    let ssh::Reply::ExecOutput {
        connection: actual,
        task_id,
        output,
    } = ssh_call(
        client,
        S::ExecRead {
            connection,
            task_id: id,
            cursor: 1,
            max_bytes: 65536,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(actual, connection);
    assert_eq!(task_id, id);
    output
}
#[tokio::test]
async fn deduplicated_tasks_are_scoped_and_separate_from_the_shared_shell() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let request_id = Uuid::new_v4();
    let task = start(&mut client, connection, request_id, "fail", 2000, 1048576).await;
    assert_eq!(
        start(&mut client, connection, request_id, "fail", 2000, 1048576)
            .await
            .task_id,
        task.task_id
    );
    let summary = finished(&mut client, connection, task.task_id)
        .await
        .summary
        .unwrap();
    assert_eq!(summary.end, E::Completed);
    assert_eq!(summary.exit_status, Some(7));
    assert_eq!(summary.request_accepted, Some(true));
    let page = output(&mut client, connection, task.task_id).await;
    assert!(page.completed);
    assert!(!page.truncated);
    assert_eq!(
        page.events
            .iter()
            .filter(|event| !event.stderr)
            .flat_map(|event| event.bytes.iter())
            .copied()
            .collect::<Vec<_>>(),
        b"early|"
    );
    assert_eq!(
        page.events
            .iter()
            .filter(|event| event.stderr)
            .flat_map(|event| event.bytes.iter())
            .copied()
            .collect::<Vec<_>>(),
        b"err|failure"
    );
    assert_eq!(*remote.exec_calls.lock().unwrap(), [b"fail".to_vec()]);
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Exec {
                    connection,
                    request_id,
                    command: Sensitive::new("different".into()),
                    timeout_ms: 2000,
                    max_output_bytes: 1048576
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(connection, request_id, b"conflicting action")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let written = Uuid::new_v4();
    ssh_call(
        &mut client,
        input_write(connection, written, b"interactive-shell-input"),
    )
    .await;
    input_status(&mut client, connection, written, |receipt| {
        receipt.state == session_core::input::InputState::PipelineQueued
    })
    .await;
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Exec {
                    connection,
                    request_id: written,
                    command: Sensitive::new("different".into()),
                    timeout_ms: 2000,
                    max_output_bytes: 1048576
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let token = match ok(client
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    for request in [
        S::ExecStatus {
            connection,
            task_id: task.task_id,
        },
        S::ExecRead {
            connection,
            task_id: task.task_id,
            cursor: 1,
            max_bytes: 4096,
        },
        S::ExecCancel {
            connection,
            task_id: task.task_id,
        },
        S::Exec {
            connection,
            request_id: Uuid::new_v4(),
            command: Sensitive::new("not permitted".into()),
            timeout_ms: 2000,
            max_output_bytes: 1024,
        },
    ] {
        assert!(matches!(
            observer.request(Request::Ssh { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::PermissionDenied,
                ..
            }
        ));
    }
    let mut stale = connection;
    stale.generation += 1;
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::ExecRead {
                    connection: stale,
                    task_id: task.task_id,
                    cursor: 1,
                    max_bytes: 4096
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::StaleGeneration,
            ..
        }
    ));
    let task = start(
        &mut client,
        connection,
        Uuid::new_v4(),
        "synthetic-default-command",
        2000,
        1048576,
    )
    .await;
    assert_eq!(
        finished(&mut client, connection, task.task_id)
            .await
            .summary
            .unwrap()
            .exit_status,
        Some(0)
    );
    timeout(Duration::from_secs(2), async {
        loop {
            let Reply::Output(shell) = ok(client
                .request(Request::Read {
                    connection,
                    cursor: 1,
                    max_bytes: 65536,
                })
                .await
                .unwrap())
            else {
                panic!()
            };
            let bytes = shell
                .events
                .into_iter()
                .flat_map(|event| event.bytes)
                .collect::<Vec<_>>();
            assert!(
                !bytes
                    .windows(18)
                    .any(|window| window == b"fresh-exec-channel")
            );
            if bytes.ends_with(b"interactive-shell-input") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    service.stop(&mut client).await;
}
#[tokio::test]
async fn incremental_timeout_cancel_and_output_limit_preserve_explicit_results() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let task = start(
        &mut client,
        connection,
        Uuid::new_v4(),
        "no-ack",
        1500,
        1048576,
    )
    .await;
    timeout(Duration::from_secs(1), async {
        while output(&mut client, connection, task.task_id)
            .await
            .events
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let ssh::Reply::Exec(running) = ssh_call(
        &mut client,
        S::ExecStatus {
            connection,
            task_id: task.task_id,
        },
    )
    .await
    else {
        panic!()
    };
    assert_ne!(running.phase, TaskPhase::Finished);
    let summary = finished(&mut client, connection, task.task_id)
        .await
        .summary
        .unwrap();
    assert_eq!(summary.end, E::Timeout);
    assert_eq!(summary.request_accepted, Some(false));
    assert!(summary.exit_status.is_none());
    let task = start(
        &mut client,
        connection,
        Uuid::new_v4(),
        "stall",
        5000,
        1048576,
    )
    .await;
    timeout(Duration::from_secs(1), async {
        while output(&mut client, connection, task.task_id)
            .await
            .events
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    ssh_call(
        &mut client,
        S::ExecCancel {
            connection,
            task_id: task.task_id,
        },
    )
    .await;
    let summary = finished(&mut client, connection, task.task_id)
        .await
        .summary
        .unwrap();
    assert_eq!(summary.end, E::Cancelled);
    assert!(summary.stdout_bytes > 0);
    assert!(summary.exit_status.is_none());
    for (command, end, code) in [
        ("signal", E::RemoteSignal, None),
        ("no-status", E::MissingExitStatus, None),
        ("reject", E::Rejected, None),
        ("big", E::Completed, Some(0)),
    ] {
        let task = start(
            &mut client,
            connection,
            Uuid::new_v4(),
            command,
            2000,
            1048576,
        )
        .await;
        let summary = finished(&mut client, connection, task.task_id)
            .await
            .summary
            .unwrap();
        assert_eq!(summary.end, end, "{command}");
        assert_eq!(summary.exit_status, code);
        if command == "signal" {
            assert_eq!(summary.exit_signal.as_deref(), Some("TERM"));
        }
        if command == "big" {
            let page = output(&mut client, connection, task.task_id).await;
            assert!(page.truncated);
            assert!(page.available_from > 1);
            assert_eq!(summary.stdout_bytes, 131078);
            assert!(!summary.output_truncated);
        }
    }
    let task = start(
        &mut client,
        connection,
        Uuid::new_v4(),
        "overflow",
        2000,
        64,
    )
    .await;
    let summary = finished(&mut client, connection, task.task_id)
        .await
        .summary
        .unwrap();
    assert_eq!(summary.end, E::OutputLimit);
    assert!(summary.output_truncated);
    assert_eq!(summary.stdout_bytes + summary.stderr_bytes, 64);
    ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Connected
    })
    .await;
    remote.end(7).await;
    let ended = ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Disconnected
    })
    .await;
    assert_eq!(ended.shell_exit_status, Some(7));
    service.stop(&mut client).await;
}
#[tokio::test]
async fn queued_cancellation_and_concurrency_limit_never_start_extra_commands() {
    let remote = ssh_fixture::Fixture::options(true).await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let written = Uuid::new_v4();
    ssh_call(
        &mut client,
        input_write(connection, written, &vec![b'x'; 65536]),
    )
    .await;
    input_status(&mut client, connection, written, |receipt| {
        receipt.state == session_core::input::InputState::Dispatching
    })
    .await;
    let task = start(
        &mut client,
        connection,
        Uuid::new_v4(),
        "never-dispatch",
        2000,
        1048576,
    )
    .await;
    assert_eq!(task.phase, TaskPhase::Queued);
    ssh_call(
        &mut client,
        S::ExecCancel {
            connection,
            task_id: task.task_id,
        },
    )
    .await;
    assert_eq!(
        finished(&mut client, connection, task.task_id)
            .await
            .summary
            .unwrap()
            .end,
        E::CancelledBeforeDispatch
    );
    assert!(remote.exec_calls.lock().unwrap().is_empty());
    service.stop(&mut client).await;
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let mut tasks = Vec::new();
    for _ in 0..4 {
        tasks.push(
            start(
                &mut client,
                connection,
                Uuid::new_v4(),
                "stall",
                10000,
                1048576,
            )
            .await
            .task_id,
        );
    }
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Exec {
                    connection,
                    request_id: Uuid::new_v4(),
                    command: Sensitive::new("one too many".into()),
                    timeout_ms: 10000,
                    max_output_bytes: 1048576
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::CapacityExceeded,
            ..
        }
    ));
    for id in &tasks {
        timeout(Duration::from_secs(2), async {
            while output(&mut client, connection, *id).await.events.is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    assert_eq!(remote.exec_calls.lock().unwrap().len(), 4);
    ssh_call(&mut client, S::Close { connection }).await;
    for id in tasks {
        let summary = finished(&mut client, connection, id).await.summary.unwrap();
        assert_eq!(summary.end, E::Cancelled);
        assert!(summary.exit_status.is_none());
    }
    service.stop(&mut client).await;
}

#[tokio::test]
async fn remote_disconnect_keeps_task_result_unknown_without_a_fabricated_exit_code() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let task = start(
        &mut client,
        connection,
        Uuid::new_v4(),
        "disconnect",
        2000,
        1048576,
    )
    .await;
    let summary = finished(&mut client, connection, task.task_id)
        .await
        .summary
        .unwrap();
    assert_eq!(summary.end, E::TransportLost);
    assert!(summary.exit_status.is_none());
    assert!(summary.exit_signal.is_none());
    ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Failed
    })
    .await;
    assert_eq!(*remote.exec_calls.lock().unwrap(), [b"disconnect".to_vec()]);
    service.stop(&mut client).await;
}
#[tokio::test]
async fn global_concurrency_limit_includes_tasks_on_other_connections() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let mut remotes = Vec::new();
    let mut connections = Vec::new();
    for _ in 0..5 {
        let remote = ssh_fixture::Fixture::start().await;
        connections.push(ssh_connected_fixture(&mut client, &remote).await);
        remotes.push(remote);
    }
    for connection in &connections[..4] {
        for _ in 0..4 {
            start(
                &mut client,
                *connection,
                Uuid::new_v4(),
                "stall",
                20000,
                1048576,
            )
            .await;
        }
    }
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Exec {
                    connection: connections[4],
                    request_id: Uuid::new_v4(),
                    command: Sensitive::new("global overflow".into()),
                    timeout_ms: 20000,
                    max_output_bytes: 1048576
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::CapacityExceeded,
            ..
        }
    ));
    assert!(remotes[4].exec_calls.lock().unwrap().is_empty());
    for connection in connections {
        ssh_call(&mut client, S::Close { connection }).await;
    }
    service.stop(&mut client).await;
}

fn ordered_task_id(stamp: u64, nonce: u64) -> Uuid {
    Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | nonce as u128)
}
#[tokio::test]
async fn ordered_finished_tasks_reclaim_local_and_global_capacity_without_reexecution() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    // Keep an older running task and a legacy opaque result while cycling newer results.
    let running = start(
        &mut client,
        connection,
        ordered_task_id(1, 1),
        "stall",
        60000,
        4096,
    )
    .await;
    let opaque_request = Uuid::new_v4();
    let opaque = start(&mut client, connection, opaque_request, "fail", 2000, 4096).await;
    finished(&mut client, connection, opaque.task_id).await;
    for stamp in 2..=100 {
        let id = ordered_task_id(stamp, 1);
        let task = start(&mut client, connection, id, "fail", 2000, 4096).await;
        assert_eq!(task.task_id, id);
        assert_eq!(
            finished(&mut client, connection, id)
                .await
                .summary
                .unwrap()
                .exit_status,
            Some(7)
        );
    }
    assert_eq!(
        start(&mut client, connection, opaque_request, "fail", 2000, 4096)
            .await
            .task_id,
        opaque.task_id
    );
    assert_eq!(
        start(
            &mut client,
            connection,
            ordered_task_id(1, 1),
            "stall",
            60000,
            4096
        )
        .await
        .task_id,
        running.task_id
    );
    for request in [
        S::Exec {
            connection,
            request_id: ordered_task_id(2, 1),
            command: Sensitive::new("fail".into()),
            timeout_ms: 2000,
            max_output_bytes: 4096,
        },
        S::Exec {
            connection,
            request_id: ordered_task_id(2, 2),
            command: Sensitive::new("different".into()),
            timeout_ms: 2000,
            max_output_bytes: 4096,
        },
        input_write(connection, ordered_task_id(2, 1), b"must-not-send"),
        S::Resize {
            connection,
            request_id: ordered_task_id(2, 1),
            cols: 80,
            rows: 24,
        },
        S::ExecStatus {
            connection,
            task_id: ordered_task_id(2, 1),
        },
        S::ExecRead {
            connection,
            task_id: ordered_task_id(2, 1),
            cursor: 1,
            max_bytes: 4096,
        },
        S::ExecCancel {
            connection,
            task_id: ordered_task_id(2, 1),
        },
    ] {
        assert!(matches!(
            client.request(Request::Ssh { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::RequestExpired,
                ..
            }
        ));
    }
    assert_eq!(remote.exec_calls.lock().unwrap().len(), 101);
    assert!(remote.received.lock().unwrap().is_empty());
    ssh_call(
        &mut client,
        S::ExecCancel {
            connection,
            task_id: running.task_id,
        },
    )
    .await;
    finished(&mut client, connection, running.task_id).await;
    // Fill the global result cap across five connections, forcing cross-connection reclamation.
    let mut connections = vec![connection];
    let mut firsts = Vec::new();
    let mut additional_remotes = Vec::new();
    for index in 1..=4 {
        let remote = ssh_fixture::Fixture::start().await;
        let connection = ssh_connected_fixture(&mut client, &remote).await;
        connections.push(connection);
        for offset in 0..16 {
            let id = ordered_task_id(1000 + index * 100 + offset, 1);
            let task = start(&mut client, connection, id, "fail", 2000, 4096).await;
            finished(&mut client, connection, task.task_id).await;
            if offset == 0 {
                firsts.push((connection, id));
            }
        }
        additional_remotes.push(remote);
    }
    let (old_connection, old_id) = firsts[0];
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::ExecStatus {
                    connection: old_connection,
                    task_id: old_id
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::RequestExpired,
            ..
        }
    ));
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(old_connection, old_id, b"must-not-send")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::RequestExpired,
            ..
        }
    ));
    assert_eq!(
        remote.exec_calls.lock().unwrap().len()
            + additional_remotes
                .iter()
                .map(|remote| remote.exec_calls.lock().unwrap().len())
                .sum::<usize>(),
        165
    );
    for connection in connections {
        ssh_call(&mut client, S::Close { connection }).await;
    }
}

#[tokio::test]
async fn legacy_encoding_is_frozen_for_strict_input_exec_and_metadata() {
    use config_store::Encoding;
    for encoding in [Encoding::Gbk, Encoding::Gb18030] {
        let remote = ssh_fixture::Fixture::start().await;
        let temp = ConfigTemp::new();
        let mut service = temp.start().await;
        let mut client = service.connect().await;
        let (connection, mut profile) =
            ssh_connected_encoded_fixture(&mut client, &remote, Uuid::new_v4(), encoding.clone())
                .await;
        if let config_store::Settings::Ssh2 { encoding, .. } = &mut profile.settings {
            *encoding = Encoding::Utf8;
        }
        config_call(
            &mut client,
            config::ConfigRequest::SaveProfile {
                profile,
                credential: config::CredentialEdit::Keep {},
            },
        )
        .await;
        assert_eq!(
            ssh_status(&mut client, connection, |_| true).await.encoding,
            encoding
        );
        let text = if encoding == Encoding::Gbk {
            "中文\r"
        } else {
            "中文𠀀\r"
        };
        let codec = if encoding == Encoding::Gbk {
            encoding_rs::GBK
        } else {
            encoding_rs::GB18030
        };
        let (expected, _, replaced) = codec.encode(text);
        assert!(!replaced);
        let id = Uuid::new_v4();
        for _ in 0..2 {
            assert!(matches!(
                ssh_call(
                    &mut client,
                    S::WriteText {
                        connection,
                        request_id: id,
                        text: Sensitive::new(text.into())
                    }
                )
                .await,
                ssh::Reply::Input(_)
            ));
        }
        input_status(&mut client, connection, id, |r| {
            r.state == session_core::input::InputState::PipelineQueued
        })
        .await;
        timeout(Duration::from_secs(4), async {
            loop {
                if remote.received.lock().unwrap().concat() == expected.as_ref() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let task = start(&mut client, connection, Uuid::new_v4(), text, 2000, 65536).await;
        assert_eq!(task.encoding, encoding);
        finished(&mut client, connection, task.task_id).await;
        assert_eq!(
            remote.exec_calls.lock().unwrap().as_slice(),
            &[expected.to_vec()]
        );
        if encoding == Encoding::Gbk {
            for request in [
                S::WriteText {
                    connection,
                    request_id: Uuid::new_v4(),
                    text: Sensitive::new("𠀀".into()),
                },
                S::Exec {
                    connection,
                    request_id: Uuid::new_v4(),
                    command: Sensitive::new("𠀀".into()),
                    timeout_ms: 1000,
                    max_output_bytes: 4096,
                },
                S::WriteText {
                    connection,
                    request_id: id,
                    text: Sensitive::new("不同".into()),
                },
            ] {
                assert!(matches!(
                    client.request(Request::Ssh { request }).await.unwrap(),
                    Response::Error {
                        code: ErrorCode::InvalidArgument,
                        ..
                    }
                ));
            }
            assert_eq!(remote.exec_calls.lock().unwrap().len(), 1);
        }
        let mut stale = connection;
        stale.generation += 1;
        assert!(matches!(
            client
                .request(Request::Ssh {
                    request: S::WriteText {
                        connection: stale,
                        request_id: Uuid::new_v4(),
                        text: Sensitive::new("中文".into())
                    }
                })
                .await
                .unwrap(),
            Response::Error {
                code: ErrorCode::StaleGeneration,
                ..
            }
        ));
        service.stop(&mut client).await;
    }
}
