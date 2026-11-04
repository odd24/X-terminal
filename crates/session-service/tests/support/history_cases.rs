use super::*;
use ssh::Request as S;

fn ordered(stamp: u64, nonce: u64) -> Uuid {
    Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | nonce as u128)
}
fn start(profile_id: Uuid, request_id: Uuid) -> S {
    S::Start {
        profile_id,
        request_id,
        cols: 80,
        rows: 24,
    }
}
async fn rejected(client: &mut Client, request: S, expected: ErrorCode) {
    let Response::Error { code, .. } = client.request(Request::Ssh { request }).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(code, expected);
}
async fn forget(client: &mut Client, connection: ConnectionRef) {
    ssh_call(client, S::Close { connection }).await;
    assert!(matches!(
        ssh_call(client, S::Forget { connection }).await,
        ssh::Reply::Accepted
    ));
}

#[tokio::test]
async fn forgetting_terminal_connections_frees_capacity_without_replaying_creation_requests() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let anchor = ssh_connected_fixture_with_request(&mut client, &remote, ordered(0, 1)).await;
    let anchor_profile = ssh_status(&mut client, anchor, |_| true).await.profile_id;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    rejected(
        &mut client,
        S::Forget { connection: anchor },
        ErrorCode::InvalidState,
    )
    .await;
    rejected(
        &mut client,
        S::Forget {
            connection: ConnectionRef {
                generation: anchor.generation + 1,
                ..anchor
            },
        },
        ErrorCode::StaleGeneration,
    )
    .await;

    let Reply::ReadTicket { token, .. } = ok(client
        .request(Request::IssueRead {
            scopes: vec![anchor],
            lifetime_ms: 60000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    rejected(
        &mut observer,
        S::Forget { connection: anchor },
        ErrorCode::PermissionDenied,
    )
    .await;

    let mut history = Vec::new();
    let opaque_id = Uuid::new_v4();
    for stamp in 1..=63 {
        history.push(
            ssh_start(
                &mut client,
                profile.id,
                if stamp == 63 {
                    opaque_id
                } else {
                    ordered(stamp, 1)
                },
            )
            .await,
        );
    }
    rejected(
        &mut client,
        start(profile.id, ordered(64, 1)),
        ErrorCode::CapacityExceeded,
    )
    .await;
    let first = history[0].clone();
    let opaque_result = history.last().unwrap().clone();
    for info in history {
        forget(&mut client, info.reference()).await;
    }
    assert_eq!(
        ssh_start(&mut client, profile.id, ordered(1, 1)).await,
        first
    );
    rejected(
        &mut client,
        S::Status {
            connection: first.reference(),
        },
        ErrorCode::NotFound,
    )
    .await;
    rejected(
        &mut client,
        S::Forget {
            connection: first.reference(),
        },
        ErrorCode::NotFound,
    )
    .await;

    let old = ssh_start(&mut client, profile.id, ordered(64, 1))
        .await
        .reference();
    ssh_call(&mut client, S::Close { connection: old }).await;
    let ssh::Reply::Started {
        connection: restarted,
    } = ssh_call(
        &mut client,
        S::Reconnect {
            connection: old,
            request_id: ordered(65, 1),
            cols: 80,
            rows: 24,
        },
    )
    .await
    else {
        panic!()
    };
    rejected(
        &mut client,
        S::Forget { connection: old },
        ErrorCode::StaleGeneration,
    )
    .await;
    forget(&mut client, restarted.reference()).await;
    let ssh::Reply::Started {
        connection: duplicate,
    } = ssh_call(
        &mut client,
        S::Reconnect {
            connection: old,
            request_id: ordered(65, 1),
            cols: 80,
            rows: 24,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(duplicate, restarted);
    rejected(
        &mut client,
        start(profile.id, ordered(65, 1)),
        ErrorCode::InvalidArgument,
    )
    .await;

    let mut last = None;
    for stamp in 66..=1100 {
        let info = ssh_start(&mut client, profile.id, ordered(stamp, 1)).await;
        forget(&mut client, info.reference()).await;
        last = Some(info);
    }
    assert_eq!(
        ssh_start(&mut client, profile.id, ordered(1100, 1)).await,
        last.unwrap()
    );
    for id in [ordered(1, 1), ordered(1, 2), ordered(65, 1)] {
        rejected(
            &mut client,
            start(profile.id, id),
            ErrorCode::RequestExpired,
        )
        .await;
        rejected(
            &mut client,
            S::Reconnect {
                connection: old,
                request_id: id,
                cols: 80,
                rows: 24,
            },
            ErrorCode::RequestExpired,
        )
        .await;
    }
    let Reply::Sessions(list) = ok(client.request(Request::List {}).await.unwrap()) else {
        panic!()
    };
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].reference(), anchor);
    assert_eq!(list[0].state, State::Connected);
    assert_eq!(
        ssh_start(&mut client, anchor_profile, ordered(0, 1))
            .await
            .reference(),
        anchor
    );
    assert_eq!(
        ssh_start(&mut client, profile.id, opaque_id).await,
        opaque_result
    );
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(remote.received.lock().unwrap().is_empty());
    assert!(remote.exec_calls.lock().unwrap().is_empty());
    forget(&mut client, anchor).await;
    let Reply::Sessions(list) = ok(client.request(Request::List {}).await.unwrap()) else {
        panic!()
    };
    assert!(list.is_empty());
    service.stop(&mut client).await;
}

#[tokio::test]
async fn removal_and_restart_are_generation_scoped_under_concurrent_desktop_requests() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut left = service.connect().await;
    let mut right = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    config_call(
        &mut left,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    for _ in 0..16 {
        let connection = ssh_start(&mut left, profile.id, Uuid::new_v4())
            .await
            .reference();
        ssh_call(&mut left, S::Close { connection }).await;
        let (removed, restarted) = tokio::join!(
            left.request(Request::Ssh {
                request: S::Forget { connection }
            }),
            right.request(Request::Ssh {
                request: S::Reconnect {
                    connection,
                    request_id: Uuid::new_v4(),
                    cols: 80,
                    rows: 24,
                }
            })
        );
        match (removed.unwrap(), restarted.unwrap()) {
            (
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::Accepted),
                    ..
                },
                Response::Error {
                    code: ErrorCode::NotFound,
                    ..
                },
            ) => {}
            (
                Response::Error {
                    code: ErrorCode::StaleGeneration,
                    ..
                },
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::Started { connection: new }),
                    ..
                },
            ) => {
                assert_eq!(new.connection_id, connection.connection_id);
                assert_eq!(new.generation, connection.generation + 1);
                forget(&mut left, new.reference()).await;
            }
            pair => panic!("unexpected race result: {pair:?}"),
        }
    }
    // Different connection gates must still enforce the global creation request ID.
    let a = ssh_start(&mut left, profile.id, Uuid::new_v4())
        .await
        .reference();
    let b = ssh_start(&mut left, profile.id, Uuid::new_v4())
        .await
        .reference();
    ssh_call(&mut left, S::Close { connection: a }).await;
    ssh_call(&mut left, S::Close { connection: b }).await;
    let id = Uuid::new_v4();
    let reconnect = |connection| Request::Ssh {
        request: S::Reconnect {
            connection,
            request_id: id,
            cols: 80,
            rows: 24,
        },
    };
    let (a_result, b_result) =
        tokio::join!(left.request(reconnect(a)), right.request(reconnect(b)));
    let results = [a_result.unwrap(), b_result.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Response::Ok { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Response::Error {
                    code: ErrorCode::InvalidArgument,
                    ..
                }
            ))
            .count(),
        1
    );
    let Reply::Sessions(list) = ok(left.request(Request::List {}).await.unwrap()) else {
        panic!()
    };
    assert_eq!(list.len(), 2);
    assert_eq!(
        list.iter()
            .filter(|info| info.generation == a.generation + 1)
            .count(),
        1
    );
    for info in list {
        forget(&mut left, info.reference()).await;
    }
    service.stop(&mut left).await;
}
