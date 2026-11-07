use super::*;

fn request(connection: ConnectionRef, request_id: Uuid, query: bool) -> Request {
    Request::Serial {
        request: if query {
            S::ForgetStatus {
                connection,
                request_id,
            }
        } else {
            S::ForgetStart {
                connection,
                request_id,
            }
        },
    }
}
fn removed(response: Response) -> session_core::forget::Receipt {
    let Reply::Serial(SR::Forget(receipt)) = ok(response) else {
        panic!()
    };
    assert_eq!(receipt.state, session_core::forget::State::Removed);
    receipt
}
async fn terminal(desktop: &mut Client, connection: ConnectionRef) {
    let id = Uuid::new_v4();
    disconnect_cases::disconnect(desktop, connection, id, false).await;
    disconnect_cases::ended(desktop, connection, id).await;
}

#[tokio::test]
async fn agent_serial_forget_requires_independent_scope_lease_and_recovers_unread_original_owner() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = connected(&mut desktop).await;
    let (_, live_token) = issue(&mut desktop, vec![scope(connection, Action::Forget)], 30000).await;
    let (mut live, _) = Client::connect(&service.instance, live_token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut live, connection, 10000).await;
    assert_eq!(
        error(
            live.request(request(connection, Uuid::new_v4(), false))
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    assert!(
        matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(s) if s.connection.state == State::Connected && !s.cleanup_pending)
    );
    terminal(&mut desktop, connection).await;
    for action in [
        Action::Read,
        Action::Write,
        Action::Control,
        Action::Disconnect,
    ] {
        let (_, token) = issue(&mut desktop, vec![scope(connection, action)], 30000).await;
        let (mut other, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        for query in [true, false] {
            assert_eq!(
                error(
                    other
                        .request(request(connection, Uuid::new_v4(), query))
                        .await
                        .unwrap()
                ),
                ErrorCode::PermissionDenied
            );
        }
    }
    let (ticket, token) = issue(&mut desktop, vec![scope(connection, Action::Forget)], 30000).await;
    let (_, other_token) =
        issue(&mut desktop, vec![scope(connection, Action::Forget)], 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    assert_eq!(
        error(
            client
                .request(request(connection, id, false))
                .await
                .unwrap()
        ),
        ErrorCode::InputBusy
    );
    lease(&mut client, connection, 10000).await;
    for r in [
        Request::Screen { connection },
        Request::Read {
            connection,
            cursor: 1,
            max_bytes: 4096,
        },
        Request::Serial {
            request: S::Status { connection },
        },
        Request::Serial {
            request: S::Close { connection },
        },
        Request::Serial {
            request: S::Forget { connection },
        },
        Request::Serial {
            request: write(connection, Uuid::new_v4(), b"forbidden"),
        },
        Request::Serial {
            request: S::Disconnect {
                connection,
                request_id: Uuid::new_v4(),
            },
        },
    ] {
        assert_eq!(
            error(client.request(r).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    assert_eq!(
        error(client.request(request(connection, id, true)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    // Send the real request over an authenticated Pipe and never read its reply.
    let mut pipe = service.raw().await;
    write_frame(
        &mut pipe,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-serial-unread-forget".into(),
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
            request: request(connection, id, false),
        },
    )
    .await
    .unwrap();
    let receipt = timeout(Duration::from_secs(3), async {
        loop {
            match client.request(request(connection, id, true)).await.unwrap() {
                Response::Ok {
                    reply: Reply::Serial(SR::Forget(r)),
                    ..
                } => break r,
                Response::Error {
                    code: ErrorCode::PermissionDenied,
                    ..
                } => tokio::time::sleep(Duration::from_millis(5)).await,
                other => panic!("unexpected forget query: {other:?}"),
            }
        }
    })
    .await
    .unwrap();
    drop(pipe);
    assert_eq!(receipt.state, session_core::forget::State::Removed);
    let (mut other, _) = Client::connect(&service.instance, other_token.expose(), service.pid)
        .await
        .unwrap();
    for peer in [&mut other, &mut desktop] {
        assert_eq!(
            error(peer.request(request(connection, id, true)).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let wrong = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    assert_eq!(
        error(client.request(request(wrong, id, false)).await.unwrap()),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        error(
            client
                .request(request(connection, Uuid::new_v4(), false))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let new = connected(&mut desktop).await;
    let (mut retry, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        client.request(request(connection, id, false)),
        retry.request(request(connection, id, true))
    );
    assert_eq!(removed(a.unwrap()), receipt);
    assert_eq!(removed(b.unwrap()), receipt);
    assert!(
        matches!(call(&mut desktop, S::Status { connection: new }).await, SR::Status(s) if s.connection.state == State::Connected)
    );
    ok(desktop
        .request(Request::Revoke { ticket_id: ticket })
        .await
        .unwrap());
    assert_eq!(
        error(retry.request(request(connection, id, true)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_serial_forget_expiry_takeover_and_observer_never_revive_retired_authority() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = connected(&mut desktop).await;
    terminal(&mut desktop, connection).await;
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
        for query in [true, false] {
            assert_eq!(
                error(
                    observer
                        .request(request(target, Uuid::new_v4(), query))
                        .await
                        .unwrap()
                ),
                ErrorCode::PermissionDenied
            );
        }
    }
    let (_, token) = issue(&mut desktop, vec![scope(connection, Action::Forget)], 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut client, connection, 10000).await;
    ok(desktop
        .request(agent(A::Takeover { connection }))
        .await
        .unwrap());
    let id = Uuid::new_v4();
    assert_eq!(
        error(
            client
                .request(request(connection, id, false))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert!(
        matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(s) if s.connection.state == State::Disconnected)
    );
    let (_, short) = issue(&mut desktop, vec![scope(connection, Action::Forget)], 500).await;
    let (mut expiring, _) = Client::connect(&service.instance, short.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut expiring, connection, 400).await;
    let receipt = removed(
        expiring
            .request(request(connection, id, false))
            .await
            .unwrap(),
    );
    assert_eq!(
        removed(
            expiring
                .request(request(connection, id, true))
                .await
                .unwrap()
        ),
        receipt
    );
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        error(
            expiring
                .request(request(connection, id, true))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}
