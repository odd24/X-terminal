use super::*;
use ssh::{Challenge as H, Request as S};
fn request(connection: ConnectionRef, id: Uuid) -> Request {
    Request::Ssh {
        request: S::Reconnect {
            connection,
            request_id: id,
            cols: 80,
            rows: 24,
        },
    }
}
fn started(response: Response) -> ConnectionInfo {
    let Reply::Ssh(ssh::Reply::Started { connection }) = ok(response) else {
        panic!()
    };
    connection
}
async fn restart(client: &mut Client, connection: ConnectionRef) -> ConnectionRef {
    started(
        client
            .request(request(connection, Uuid::new_v4()))
            .await
            .unwrap(),
    )
    .reference()
}
async fn credentials(client: &mut Client, connection: ConnectionRef) -> Uuid {
    let status = ssh_status(client, connection, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    status.challenge.unwrap().id()
}
async fn authenticate(client: &mut Client, connection: ConnectionRef, id: Uuid) {
    ssh_call(
        client,
        S::Authenticate {
            connection,
            challenge_id: id,
            use_saved: true,
            password: None,
        },
    )
    .await;
    ssh_status(client, connection, |status| {
        status.connection.state == State::Connected
    })
    .await;
}
#[tokio::test]
async fn explicit_restart_keeps_id_advances_generation_and_never_inherits_commands_tasks_or_read_grants()
 {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let old = ssh_connected_fixture(&mut client, &remote).await;
    assert!(matches!(
        client.request(request(old, Uuid::new_v4())).await.unwrap(),
        Response::Error {
            code: ErrorCode::InvalidState,
            ..
        }
    ));
    let written = Uuid::new_v4();
    ssh_call(
        &mut client,
        input_write(old, written, b"old-generation-input"),
    )
    .await;
    input_status(&mut client, old, written, |receipt| {
        receipt.state == session_core::input::InputState::PipelineQueued
    })
    .await;
    timeout(Duration::from_secs(2), async {
        while remote.received.lock().unwrap().concat() != b"old-generation-input" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let ordered_exec_id = Uuid::from_u128((42u128 << 80) | 0x7000_8000_0000_0000_0001);
    let ssh::Reply::Exec(task) = ssh_call(
        &mut client,
        S::Exec {
            connection: old,
            request_id: ordered_exec_id,
            command: Sensitive::new("stall".into()),
            timeout_ms: 30000,
            max_output_bytes: 1024,
        },
    )
    .await
    else {
        panic!()
    };
    timeout(Duration::from_secs(2), async {
        while remote.exec_calls.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let token = match ok(client
        .request(Request::IssueRead {
            scopes: vec![old],
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
    assert!(matches!(
        observer
            .request(request(old, Uuid::new_v4()))
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::PermissionDenied,
            ..
        }
    ));
    ssh_call(&mut client, S::Close { connection: old }).await;
    assert!(matches!(
        client.request(request(old, written)).await.unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let id = Uuid::new_v4();
    let mut other = service.connect().await;
    let (first, second) = tokio::join!(
        client.request(request(old, id)),
        other.request(request(old, id))
    );
    let next = started(first.unwrap());
    assert_eq!(next, started(second.unwrap()));
    let new = next.reference();
    assert_eq!(new.connection_id, old.connection_id);
    assert_eq!(new.generation, old.generation + 1);
    assert_eq!(
        next,
        started(client.request(request(old, id)).await.unwrap())
    );
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Reconnect {
                    connection: old,
                    request_id: id,
                    cols: 81,
                    rows: 24
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let challenge = credentials(&mut client, new).await;
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    for op in [
        S::Status { connection: old },
        input_write(old, Uuid::new_v4(), b"stale input"),
        S::ExecStatus {
            connection: old,
            task_id: task.task_id,
        },
        S::Authenticate {
            connection: old,
            challenge_id: challenge,
            use_saved: true,
            password: None,
        },
        S::Close { connection: old },
    ] {
        assert!(matches!(
            client.request(Request::Ssh { request: op }).await.unwrap(),
            Response::Error {
                code: ErrorCode::StaleGeneration,
                ..
            }
        ));
    }
    assert!(matches!(
        observer
            .request(Request::Read {
                connection: new,
                cursor: 1,
                max_bytes: 4096
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::PermissionDenied,
            ..
        }
    ));
    assert!(matches!(
        observer
            .request(Request::Read {
                connection: old,
                cursor: 1,
                max_bytes: 4096
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::StaleGeneration,
            ..
        }
    ));
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::InputStatus {
                    connection: new,
                    request_id: written
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::NotFound,
            ..
        }
    ));
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::ExecStatus {
                    connection: new,
                    task_id: task.task_id
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::NotFound,
            ..
        }
    ));
    authenticate(&mut client, new, challenge).await;
    let ssh::Reply::Exec(reused) = ssh_call(
        &mut client,
        S::Exec {
            connection: new,
            request_id: ordered_exec_id,
            command: Sensitive::new("fail".into()),
            timeout_ms: 2000,
            max_output_bytes: 1024,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(reused.task_id, task.task_id);
    let done = timeout(Duration::from_secs(4), async {
        loop {
            let ssh::Reply::Exec(status) = ssh_call(
                &mut client,
                S::ExecStatus {
                    connection: new,
                    task_id: reused.task_id,
                },
            )
            .await
            else {
                panic!()
            };
            if status.phase == ssh::TaskPhase::Finished {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(done.summary.unwrap().exit_status, Some(7));
    timeout(Duration::from_secs(2), async {
        loop {
            let Reply::Output(output) = ok(client
                .request(Request::Read {
                    connection: new,
                    cursor: 1,
                    max_bytes: 65536,
                })
                .await
                .unwrap())
            else {
                panic!()
            };
            let bytes = output
                .events
                .iter()
                .flat_map(|event| event.bytes.iter())
                .copied()
                .collect::<Vec<_>>();
            assert!(
                !bytes
                    .windows(20)
                    .any(|window| window == b"old-generation-input")
            );
            if bytes == b"before-pty|before-shell|service-shared-shell\r\n" {
                assert_eq!(output.events[0].seq, 1);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        *remote.exec_calls.lock().unwrap(),
        [b"stall".to_vec(), b"fail".to_vec()]
    );
    assert_eq!(
        remote.received.lock().unwrap().concat(),
        b"old-generation-input"
    );
    ssh_call(
        &mut client,
        input_write(new, Uuid::new_v4(), b"new-generation-input"),
    )
    .await;
    timeout(Duration::from_secs(2), async {
        while remote.received.lock().unwrap().concat()
            != b"old-generation-inputnew-generation-input"
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    service.stop(&mut client).await;
}
#[tokio::test]
async fn restart_after_failure_reads_current_profile_and_requires_fresh_endpoint_trust_and_authentication()
 {
    let remote = ssh_fixture::Fixture::start().await;
    let replacement = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let old = ssh_connected_fixture(&mut client, &remote).await;
    remote.disconnect().await;
    let old_status = ssh_status(&mut client, old, |status| {
        status.connection.state == State::Failed
    })
    .await;
    let mut profile = ssh_profile(&replacement, config_store::Auth::Password);
    profile.id = old_status.profile_id;
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&replacement.password),
        },
    )
    .await;
    let new = restart(&mut client, old).await;
    let pending = ssh_status(&mut client, new, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    let Some(H::HostKey { id, review }) = pending.challenge else {
        panic!()
    };
    assert_eq!(review.candidate.endpoint.port, replacement.port);
    assert_eq!(review.candidate.fingerprint, replacement.pin);
    assert_eq!(review.status, config_store::HostKeyStatus::Unknown);
    assert_eq!(
        replacement
            .attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection: new,
            challenge_id: id,
            approve: false,
        },
    )
    .await;
    ssh_status(&mut client, new, |status| {
        status.connection.state == State::Failed
    })
    .await;
    let current = restart(&mut client, new).await;
    assert_eq!(current.generation, old.generation + 2);
    let pending = ssh_status(&mut client, current, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    let new_id = pending.challenge.unwrap().id();
    assert_ne!(new_id, id);
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::AnswerHost {
                    connection: current,
                    challenge_id: id,
                    approve: true
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidState,
            ..
        }
    ));
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection: current,
            challenge_id: new_id,
            approve: true,
        },
    )
    .await;
    let id = credentials(&mut client, current).await;
    authenticate(&mut client, current, id).await;
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        replacement
            .attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    ssh_call(
        &mut client,
        S::Close {
            connection: current,
        },
    )
    .await;
    config_call(
        &mut client,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    assert!(matches!(
        client
            .request(request(current, Uuid::new_v4()))
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    ssh_status(&mut client, current, |status| {
        status.connection.state == State::Disconnected
    })
    .await;
    service.stop(&mut client).await;
}
#[tokio::test]
async fn restart_while_old_host_confirmation_is_closed_rejects_late_answers_and_duplicate_generations()
 {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&remote.password),
        },
    )
    .await;
    let old = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let pending = ssh_status(&mut client, old, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    let old_challenge = pending.challenge.unwrap().id();
    ssh_call(&mut client, S::Close { connection: old }).await;
    let mut other = service.connect().await;
    let (first, second) = tokio::join!(
        client.request(request(old, Uuid::new_v4())),
        other.request(request(old, Uuid::new_v4()))
    );
    let (new, rejected) = match (&first, &second) {
        (Ok(Response::Ok { .. }), _) => (started(first.unwrap()).reference(), second.unwrap()),
        _ => (started(second.unwrap()).reference(), first.unwrap()),
    };
    assert!(matches!(
        rejected,
        Response::Error {
            code: ErrorCode::StaleGeneration,
            ..
        }
    ));
    assert_eq!(new.generation, old.generation + 1);
    let pending = ssh_status(&mut client, new, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    let challenge = pending.challenge.unwrap().id();
    assert_ne!(challenge, old_challenge);
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::AnswerHost {
                    connection: new,
                    challenge_id: old_challenge,
                    approve: true
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidState,
            ..
        }
    ));
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 0);
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection: new,
            challenge_id: challenge,
            approve: true,
        },
    )
    .await;
    let id = credentials(&mut client, new).await;
    authenticate(&mut client, new, id).await;
    service.stop(&mut client).await;
}

#[tokio::test]
async fn restart_discards_backpressured_unsent_input_without_resending_the_partial_prefix() {
    let remote = ssh_fixture::Fixture::options(true).await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let old = ssh_connected_fixture(&mut client, &remote).await;
    let first = Uuid::new_v4();
    let queued = Uuid::new_v4();
    ssh_call(&mut client, input_write(old, first, &vec![b'r'; 65536])).await;
    input_status(&mut client, old, first, |receipt| {
        receipt.state == session_core::input::InputState::Dispatching
    })
    .await;
    ssh_call(
        &mut client,
        input_write(old, queued, b"must not replay on a new generation"),
    )
    .await;
    timeout(Duration::from_secs(2), async {
        while remote.received.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    ssh_call(&mut client, S::Close { connection: old }).await;
    let new = restart(&mut client, old).await;
    let id = credentials(&mut client, new).await;
    authenticate(&mut client, new, id).await;
    assert_eq!(remote.received.lock().unwrap().concat(), vec![b'r'; 32768]);
    for id in [first, queued] {
        assert!(matches!(
            client
                .request(Request::Ssh {
                    request: S::InputStatus {
                        connection: new,
                        request_id: id
                    }
                })
                .await
                .unwrap(),
            Response::Error {
                code: ErrorCode::NotFound,
                ..
            }
        ));
    }
    assert!(remote.exec_calls.lock().unwrap().is_empty());
    service.stop(&mut client).await;
}
