use super::*;
use session_core::disconnect::{Receipt, State as D};
use ssh::Request as S;

async fn receipt(client: &mut Client, connection: ConnectionRef, id: Uuid, query: bool) -> Receipt {
    let request = if query {
        S::DisconnectStatus {
            connection,
            request_id: id,
        }
    } else {
        S::Disconnect {
            connection,
            request_id: id,
        }
    };
    match ssh_call(client, request).await {
        ssh::Reply::Disconnect(receipt) => receipt,
        other => panic!("disconnect receipt expected: {other:?}"),
    }
}
async fn ended(client: &mut Client, connection: ConnectionRef, id: Uuid) -> Receipt {
    timeout(Duration::from_secs(5), async {
        loop {
            let receipt = receipt(client, connection, id, true).await;
            if receipt.state == D::TransportEnded {
                return receipt;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn unread_disconnect_reply_recovers_after_reconnect_without_closing_the_new_generation() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = ssh_connected_fixture(&mut desktop, &remote).await;
    let (ticket_id, token) = issue(
        &mut desktop,
        vec![scope(connection, Action::Disconnect)],
        30000,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut client, connection, 10000).await;
    let id = Uuid::new_v4();
    let mut pipe = service.raw().await;
    write_frame(
        &mut pipe,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-unread-disconnect".into(),
            token: Sensitive::new(token.expose().to_string()),
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
            request: Request::Ssh {
                request: S::Disconnect {
                    connection,
                    request_id: id,
                },
            },
        },
    )
    .await
    .unwrap();
    // Do not read the Close response: another authenticated Pipe must recover
    // the original receipt, with independent peer evidence that teardown ran.
    timeout(Duration::from_secs(5), async {
        loop {
            match client
                .request(Request::Ssh {
                    request: S::DisconnectStatus {
                        connection,
                        request_id: id,
                    },
                })
                .await
                .unwrap()
            {
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::Disconnect(r)),
                    ..
                } if r.state == D::TransportEnded => break,
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::Disconnect(_)),
                    ..
                }
                | Response::Error {
                    code: ErrorCode::PermissionDenied,
                    ..
                } => tokio::time::sleep(Duration::from_millis(5)).await,
                other => panic!("unexpected original request query: {other:?}"),
            }
        }
    })
    .await
    .unwrap();
    drop(pipe);
    remote.wait_disconnected().await;
    let original = receipt(&mut client, connection, id, true).await;
    let ssh::Reply::Started {
        connection: restarted,
    } = ssh_call(
        &mut desktop,
        S::Reconnect {
            connection,
            request_id: Uuid::new_v4(),
            cols: 80,
            rows: 24,
        },
    )
    .await
    else {
        panic!()
    };
    let current = restarted.reference();
    assert_eq!(current.connection_id, connection.connection_id);
    assert_eq!(current.generation, connection.generation + 1);
    assert_eq!(receipt(&mut client, connection, id, false).await, original);
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection: current,
                        request_id: Uuid::new_v4(),
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let ssh::Reply::Status(status) = ssh_call(
        &mut desktop,
        S::Status {
            connection: current,
        },
    )
    .await
    else {
        panic!()
    };
    assert!(!matches!(
        status.connection.state,
        State::Disconnected | State::Closing | State::Failed
    ));
    ssh_call(
        &mut desktop,
        S::Close {
            connection: current,
        },
    )
    .await;
    ssh_call(
        &mut desktop,
        S::Forget {
            connection: current,
        },
    )
    .await;
    assert_eq!(receipt(&mut client, connection, id, true).await, original);
    ok(desktop
        .request(Request::Revoke { ticket_id })
        .await
        .unwrap());
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::DisconnectStatus {
                        connection,
                        request_id: id
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
async fn agent_disconnect_owns_receipt_and_observes_ssh_cleanup_after_retirement_and_forget() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = ssh_connected_fixture(&mut desktop, &remote).await;
    // Ensure cleanup also covers an already dispatched exec channel.
    let task = agent_exec_start(&mut desktop, connection, Uuid::new_v4(), "stall").await;
    timeout(Duration::from_secs(3), async {
        while remote.exec_calls.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let scopes = vec![scope(connection, Action::Disconnect)];
    let (_, token) = issue(&mut desktop, scopes.clone(), 30000).await;
    let (_, other_token) = issue(&mut desktop, scopes, 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (mut retry, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (mut other, _) = Client::connect(&service.instance, other_token.expose(), service.pid)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::DisconnectStatus {
                        connection,
                        request_id: id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection,
                        request_id: id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InputBusy
    );
    lease(&mut client, connection, 10000).await;
    // Disconnect grants no output, status, input or old unnumbered Close authority.
    for request in [
        Request::Screen { connection },
        Request::Ssh {
            request: S::Status { connection },
        },
        Request::Ssh {
            request: S::Close { connection },
        },
        Request::Ssh {
            request: input_write(connection, Uuid::new_v4(), b"forbidden"),
        },
    ] {
        assert_eq!(
            error(client.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let (first, duplicate) = tokio::join!(
        receipt(&mut client, connection, id, false),
        receipt(&mut retry, connection, id, false)
    );
    assert_eq!(first.request_id, id);
    assert_eq!(first.connection, connection);
    assert_eq!(duplicate.request_id, id);
    let final_receipt = ended(&mut client, connection, id).await;
    remote.wait_disconnected().await;
    let finished = agent_exec_done(&mut desktop, connection, task.task_id).await;
    assert!(matches!(
        finished.summary.unwrap().end,
        ssh::ExecEnd::Cancelled | ssh::ExecEnd::CancelledBeforeDispatch
    ));
    assert!(matches!(
        ok(client
            .request(agent(A::Lease { connection }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    for caller in [&mut other, &mut desktop] {
        for query in [false, true] {
            let request = if query {
                S::DisconnectStatus {
                    connection,
                    request_id: id,
                }
            } else {
                S::Disconnect {
                    connection,
                    request_id: id,
                }
            };
            assert_eq!(
                error(caller.request(Request::Ssh { request }).await.unwrap()),
                ErrorCode::PermissionDenied
            );
        }
    }
    let wrong_generation = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection: wrong_generation,
                        request_id: id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection,
                        request_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    ssh_call(&mut desktop, S::Forget { connection }).await;
    assert_eq!(
        receipt(&mut retry, connection, id, false).await,
        final_receipt
    );
    drop(client);
    let (mut recovered, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    assert_eq!(
        receipt(&mut recovered, connection, id, true).await,
        final_receipt
    );
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()), Reply::Sessions(list) if list.is_empty())
    );
    assert_eq!(remote.exec_calls.lock().unwrap().len(), 1);
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_disconnect_rejects_wrong_scope_released_lease_revocation_expiry_and_observers() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = ssh_connected_fixture(&mut desktop, &remote).await;
    let (_, token) = issue(&mut desktop, vec![scope(connection, Action::Write)], 30000).await;
    let (mut writer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let held = lease(&mut writer, connection, 10000).await;
    assert_eq!(
        error(
            writer
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection,
                        request_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    ok(writer
        .request(agent(A::Release {
            connection,
            lease_id: held.lease_id,
        }))
        .await
        .unwrap());
    let (ticket_id, token) = issue(
        &mut desktop,
        vec![scope(connection, Action::Disconnect)],
        30000,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let held = lease(&mut client, connection, 10000).await;
    ok(client
        .request(agent(A::Release {
            connection,
            lease_id: held.lease_id,
        }))
        .await
        .unwrap());
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection,
                        request_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InputBusy
    );
    lease(&mut client, connection, 10000).await;
    ok(desktop
        .request(Request::Revoke { ticket_id })
        .await
        .unwrap());
    assert_eq!(
        error(
            client
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection,
                        request_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let (_, token) = issue(
        &mut desktop,
        vec![scope(connection, Action::Disconnect)],
        250,
    )
    .await;
    let (mut expired, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut expired, connection, 200).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        error(
            expired
                .request(Request::Ssh {
                    request: S::Disconnect {
                        connection,
                        request_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let Reply::ReadTicket { token, .. } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    for query in [false, true] {
        let request = if query {
            S::DisconnectStatus {
                connection,
                request_id: Uuid::new_v4(),
            }
        } else {
            S::Disconnect {
                connection,
                request_id: Uuid::new_v4(),
            }
        };
        assert_eq!(
            error(observer.request(Request::Ssh { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    ssh_status(&mut desktop, connection, |s| {
        s.connection.state == State::Connected
    })
    .await;
    let id = Uuid::new_v4();
    receipt(&mut desktop, connection, id, false).await;
    ended(&mut desktop, connection, id).await;
    remote.wait_disconnected().await;
    service.stop(&mut desktop).await;
}
