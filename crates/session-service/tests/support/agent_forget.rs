use super::*;
use ssh::Request as S;

fn request(connection: ConnectionRef, request_id: Uuid, query: bool) -> Request {
    Request::Ssh {
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
async fn terminal(desktop: &mut Client, remote: &ssh_fixture::Fixture) -> ConnectionRef {
    let c = ssh_connected_fixture(desktop, remote).await;
    let id = Uuid::new_v4();
    ssh_call(
        desktop,
        S::Disconnect {
            connection: c,
            request_id: id,
        },
    )
    .await;
    timeout(Duration::from_secs(5), async {
        loop {
            if matches!(ssh_call(desktop, S::DisconnectStatus { connection: c, request_id: id }).await,
                ssh::Reply::Disconnect(r) if r.state == session_core::disconnect::State::TransportEnded) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    remote.wait_disconnected().await;
    c
}
fn removed(response: Response) -> session_core::forget::Receipt {
    match ok(response) {
        Reply::Ssh(ssh::Reply::Forget(r)) => {
            assert_eq!(r.state, session_core::forget::State::Removed);
            r
        }
        other => panic!("unexpected removal response: {other:?}"),
    }
}

#[tokio::test]
async fn forget_requires_own_scope_lease_and_recovers_unread_completion_after_retirement() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = terminal(&mut desktop, &remote).await;
    for action in [
        Action::Read,
        Action::Disconnect,
        Action::Reconnect,
        Action::Control,
    ] {
        let (_, token) = issue(&mut desktop, vec![scope(c, action)], 30000).await;
        let (mut other, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        assert_eq!(
            error(
                other
                    .request(request(c, Uuid::new_v4(), false))
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            error(
                other
                    .request(request(c, Uuid::new_v4(), true))
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    let (ticket, token) = issue(&mut desktop, vec![scope(c, Action::Forget)], 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let (_, other_token) = issue(&mut desktop, vec![scope(c, Action::Forget)], 30000).await;
    let id = Uuid::new_v4();
    assert_eq!(
        error(client.request(request(c, id, false)).await.unwrap()),
        ErrorCode::InputBusy
    );
    lease(&mut client, c, 10000).await;
    // Forget-only never grants reading, writing, authentication, Close or reconnect.
    for r in [
        Request::Screen { connection: c },
        Request::Ssh {
            request: S::Status { connection: c },
        },
        Request::Ssh {
            request: S::Close { connection: c },
        },
        Request::Ssh {
            request: S::Forget { connection: c },
        },
        Request::Ssh {
            request: S::WriteText {
                connection: c,
                request_id: Uuid::new_v4(),
                text: Sensitive::new("synthetic".into()),
            },
        },
        Request::Ssh {
            request: S::Disconnect {
                connection: c,
                request_id: Uuid::new_v4(),
            },
        },
        Request::Ssh {
            request: S::Reconnect {
                connection: c,
                request_id: Uuid::new_v4(),
                cols: 80,
                rows: 24,
            },
        },
    ] {
        assert_eq!(
            error(client.request(r).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let mut pipe = service.raw().await;
    write_frame(
        &mut pipe,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-unread-forget".into(),
            token: Sensitive::new(token.expose().to_owned()),
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
            request: request(c, id, false),
        },
    )
    .await
    .unwrap();
    // No read of the actual operation response; recover only by the same original ID.
    let receipt = timeout(Duration::from_secs(5), async {
        loop {
            match client.request(request(c, id, true)).await.unwrap() {
                response @ Response::Ok { .. } => break removed(response),
                Response::Error {
                    code: ErrorCode::PermissionDenied,
                    ..
                } => tokio::task::yield_now().await,
                other => panic!("unexpected receipt query: {other:?}"),
            }
        }
    })
    .await
    .unwrap();
    drop(pipe);
    assert_eq!(receipt.connection, c);
    assert_eq!(
        removed(client.request(request(c, id, false)).await.unwrap()),
        receipt
    );
    assert_eq!(
        error(
            desktop
                .request(Request::Ssh {
                    request: S::Status { connection: c }
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    assert!(matches!(
        ok(client
            .request(agent(A::Lease { connection: c }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    for query in [false, true] {
        assert_eq!(
            error(desktop.request(request(c, id, query)).await.unwrap()),
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            error(
                client
                    .request(request(
                        ConnectionRef {
                            generation: c.generation + 1,
                            ..c
                        },
                        id,
                        query
                    ))
                    .await
                    .unwrap()
            ),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            error(
                client
                    .request(request(c, Uuid::new_v4(), query))
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    let (mut other, _) = Client::connect(&service.instance, other_token.expose(), service.pid)
        .await
        .unwrap();
    assert_eq!(
        error(other.request(request(c, id, true)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    // A newly created independent connection remains present when the old ID is retried.
    let new_remote = ssh_fixture::Fixture::start().await;
    let new = ssh_connected_fixture(&mut desktop, &new_remote).await;
    assert_ne!(new.connection_id, c.connection_id);
    assert_eq!(
        removed(client.request(request(c, id, false)).await.unwrap()),
        receipt
    );
    assert!(matches!(
        ssh_call(&mut desktop, S::Status { connection: new }).await,
        ssh::Reply::Status(_)
    ));
    ok(desktop
        .request(Request::Revoke { ticket_id: ticket })
        .await
        .unwrap());
    assert_eq!(
        error(client.request(request(c, id, true)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn forget_live_connection_is_rejected_and_expired_ticket_cannot_query_removed_receipt() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = ssh_connected_fixture(&mut desktop, &remote).await;
    let (_, token) = issue(&mut desktop, vec![scope(c, Action::Forget)], 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut client, c, 10000).await;
    let id = Uuid::new_v4();
    assert_eq!(
        error(client.request(request(c, id, false)).await.unwrap()),
        ErrorCode::InvalidState
    );
    assert_eq!(
        error(client.request(request(c, id, true)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert!(matches!(
        ssh_call(&mut desktop, S::Status { connection: c }).await,
        ssh::Reply::Status(_)
    ));
    ssh_call(&mut desktop, S::Close { connection: c }).await;
    // The live-state rejection did not reserve a false completion.
    let close_id = Uuid::new_v4();
    ssh_call(
        &mut desktop,
        S::Disconnect {
            connection: c,
            request_id: close_id,
        },
    )
    .await;
    timeout(Duration::from_secs(5), async {
        loop {
            if matches!(ssh_call(&mut desktop, S::DisconnectStatus { connection: c, request_id: close_id }).await,
                ssh::Reply::Disconnect(r) if r.state == session_core::disconnect::State::TransportEnded) { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let (_, short_token) = issue(&mut desktop, vec![scope(c, Action::Forget)], 1000).await;
    let (mut short, _) = Client::connect(&service.instance, short_token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut short, c, 500).await;
    removed(short.request(request(c, id, false)).await.unwrap());
    tokio::time::sleep(Duration::from_millis(1050)).await;
    assert_eq!(
        error(short.request(request(c, id, true)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}
