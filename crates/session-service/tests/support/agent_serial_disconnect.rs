use super::*;
use session_core::disconnect::{Receipt, State as D};

async fn disconnect(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
    query: bool,
) -> Receipt {
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
    let SR::Disconnect(receipt) = call(client, request).await else {
        panic!()
    };
    receipt
}
async fn ended(client: &mut Client, connection: ConnectionRef, id: Uuid) -> Receipt {
    timeout(Duration::from_secs(5), async {
        loop {
            let receipt = disconnect(client, connection, id, true).await;
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
async fn agent_serial_disconnect_independent_lease_owner_partial_write_and_forget_recovery() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = connected(&mut desktop).await;
    let (_, writer_token) =
        issue(&mut desktop, vec![scope(connection, Action::Write)], 30000).await;
    let (mut writer, _) = Client::connect(&service.instance, writer_token.expose(), service.pid)
        .await
        .unwrap();
    let l = lease(&mut writer, connection, 10000).await;
    assert_eq!(
        error(
            writer
                .request(Request::Serial {
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
    // Allow writer's lease to end without performing user input or takeover.
    ok(writer
        .request(agent(A::Release {
            connection,
            lease_id: l.lease_id,
        }))
        .await
        .unwrap());
    let (ticket, token) = issue(
        &mut desktop,
        vec![
            scope(connection, Action::Disconnect),
            scope(connection, Action::Write),
        ],
        30000,
    )
    .await;
    let (_, other_token) = issue(
        &mut desktop,
        vec![scope(connection, Action::Disconnect)],
        30000,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (mut other, _) = Client::connect(&service.instance, other_token.expose(), service.pid)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    assert_eq!(
        error(
            client
                .request(Request::Serial {
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
                .request(Request::Serial {
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
    for request in [
        Request::Serial {
            request: S::Status { connection },
        },
        Request::Serial {
            request: S::Close { connection },
        },
        Request::Read {
            connection,
            cursor: 1,
            max_bytes: 4096,
        },
    ] {
        assert_eq!(
            error(client.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let input = Uuid::new_v4();
    call(
        &mut client,
        S::Send {
            connection,
            request_id: input,
            content: Sensitive::new("abc".into()),
            format: s::Format::Text,
            ending: s::Ending::None,
            pace: s::Pace {
                chunk_bytes: 1,
                interval_ms: 1000,
            },
        },
    )
    .await;
    let tail = Uuid::new_v4();
    call(&mut client, write(connection, tail, b"never")).await;
    timeout(Duration::from_secs(2), async {
        while bytes(&mut desktop, connection).await != b"a" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let first = disconnect(&mut client, connection, id, false).await;
    assert_eq!(first.request_id, id);
    let final_receipt = ended(&mut client, connection, id).await;
    assert_eq!(
        receipt(&mut client, connection, input)
            .await
            .driver_accepted,
        Some(1)
    );
    assert_eq!(
        receipt(&mut client, connection, input).await.failure,
        Some(s::Failure::Cancelled)
    );
    assert_eq!(
        receipt(&mut client, connection, tail).await.state,
        InputState::CancelledBeforeDispatch
    );
    assert_eq!(bytes(&mut desktop, connection).await, b"a");
    for peer in [&mut other, &mut desktop] {
        assert_eq!(
            error(
                peer.request(Request::Serial {
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
    }
    let wrong = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    assert_eq!(
        error(
            client
                .request(Request::Serial {
                    request: S::Disconnect {
                        connection: wrong,
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
                .request(Request::Serial {
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
    call(&mut desktop, S::Forget { connection }).await;
    let new = connected(&mut desktop).await;
    assert_ne!(new.connection_id, connection.connection_id);
    let (mut retry, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        disconnect(&mut client, connection, id, false),
        disconnect(&mut retry, connection, id, true)
    );
    assert_eq!(a, final_receipt);
    assert_eq!(b, final_receipt);
    assert!(
        matches!(call(&mut desktop, S::Status { connection: new }).await, SR::Status(status) if status.connection.state == State::Connected)
    );
    ok(desktop
        .request(Request::Revoke { ticket_id: ticket })
        .await
        .unwrap());
    assert_eq!(
        error(
            retry
                .request(Request::Serial {
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
async fn agent_serial_disconnect_unread_pipe_reply_and_expired_ticket_cannot_revive_authority() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = connected(&mut desktop).await;
    let (_, token) = issue(
        &mut desktop,
        vec![scope(connection, Action::Disconnect)],
        1800,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut client, connection, 1000).await;
    let id = Uuid::new_v4();
    let mut pipe = service.raw().await;
    write_frame(
        &mut pipe,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-serial-unread-disconnect".into(),
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
            request: Request::Serial {
                request: S::Disconnect {
                    connection,
                    request_id: id,
                },
            },
        },
    )
    .await
    .unwrap();
    // The sending Pipe never reads its response. Query the original number only.
    timeout(Duration::from_secs(1), async {
        loop {
            match client
                .request(Request::Serial {
                    request: S::DisconnectStatus {
                        connection,
                        request_id: id,
                    },
                })
                .await
                .unwrap()
            {
                Response::Ok {
                    reply: Reply::Serial(SR::Disconnect(r)),
                    ..
                } if r.state == D::TransportEnded => break,
                Response::Ok {
                    reply: Reply::Serial(SR::Disconnect(_)),
                    ..
                }
                | Response::Error {
                    code: ErrorCode::PermissionDenied,
                    ..
                } => tokio::time::sleep(Duration::from_millis(5)).await,
                other => panic!("unexpected disconnect query: {other:?}"),
            }
        }
    })
    .await
    .unwrap();
    drop(pipe);
    call(&mut desktop, S::Forget { connection }).await;
    assert_eq!(
        disconnect(&mut client, connection, id, false).await.state,
        D::TransportEnded
    );
    tokio::time::sleep(Duration::from_millis(1850)).await;
    assert_eq!(
        error(
            client
                .request(Request::Serial {
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
