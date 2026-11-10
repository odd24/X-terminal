use super::*;
use ssh::Request as S;

fn request(connection: ConnectionRef, request_id: Uuid) -> Request {
    Request::Ssh {
        request: S::Reconnect {
            connection,
            request_id,
            cols: 80,
            rows: 24,
        },
    }
}
fn status(connection: ConnectionRef, request_id: Uuid) -> Request {
    Request::Ssh {
        request: S::ReconnectStatus {
            connection,
            request_id,
        },
    }
}
async fn terminal(
    desktop: &mut Client,
    remote: &ssh_fixture::Fixture,
) -> (ConnectionRef, config_store::PortableProfile, Uuid) {
    let (c, profile) = ssh_connected_encoded_fixture(
        desktop,
        remote,
        Uuid::new_v4(),
        config_store::Encoding::Utf8,
    )
    .await;
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
    let config::ConfigReply::SavedProfile { revision, .. } = config_call(
        desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await
    else {
        panic!()
    };
    (c, profile, revision)
}
fn connect(profile_id: Uuid, revision: Uuid) -> Scope {
    Scope {
        target: Target::ProfileRevision {
            profile_id,
            revision,
        },
        action: Action::Connect,
    }
}

#[tokio::test]
async fn reconnect_requires_independent_old_generation_lease_and_fixed_profile_and_recovers_unread_reply()
 {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let (old, profile, revision) = terminal(&mut desktop, &remote).await;
    for scopes in [
        vec![connect(profile.id, revision)],
        vec![
            scope(old, Action::Disconnect),
            connect(profile.id, revision),
        ],
        vec![scope(old, Action::Reconnect)],
        vec![
            scope(old, Action::Reconnect),
            Scope {
                target: Target::Profile {
                    profile_id: profile.id,
                },
                action: Action::Connect,
            },
        ],
    ] {
        let (_, token) = issue(&mut desktop, scopes.clone(), 30000).await;
        let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        if scopes
            .iter()
            .any(|s| s.target == Target::Connection { connection: old })
        {
            lease(&mut client, old, 1000).await;
        }
        assert_eq!(
            error(client.request(request(old, Uuid::new_v4())).await.unwrap()),
            ErrorCode::PermissionDenied
        );
        // Explicitly release before testing a different principal on the same old ref.
        if let Reply::Agent(AR::Lease(Some(l))) = ok(client
            .request(agent(A::Lease { connection: old }))
            .await
            .unwrap())
        {
            ok(client
                .request(agent(A::Release {
                    connection: old,
                    lease_id: l.lease_id,
                }))
                .await
                .unwrap());
        }
    }
    let scopes = vec![scope(old, Action::Reconnect), connect(profile.id, revision)];
    let (ticket, token) = issue(&mut desktop, scopes.clone(), 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    assert_eq!(
        error(client.request(request(old, Uuid::new_v4())).await.unwrap()),
        ErrorCode::InputBusy
    );
    lease(&mut client, old, 10000).await;
    let id = Uuid::new_v4();
    assert_eq!(
        error(client.request(status(old, id)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert_eq!(remote.accepted_connections(), 1);
    let mut pipe = service.raw().await;
    write_frame(
        &mut pipe,
        &Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "synthetic-unread-reconnect".into(),
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
            request: request(old, id),
        },
    )
    .await
    .unwrap();
    // Recover the original request over another authenticated Pipe; never read its response.
    let result = timeout(Duration::from_secs(5), async {
        loop {
            match client.request(status(old, id)).await.unwrap() {
                Response::Ok {
                    reply: Reply::Ssh(ssh::Reply::ReconnectReceipt(receipt)),
                    ..
                } => {
                    assert_eq!(receipt.previous, old);
                    assert_eq!(receipt.request_id, id);
                    break receipt.connection;
                }
                Response::Error {
                    code: ErrorCode::PermissionDenied,
                    ..
                } => tokio::task::yield_now().await,
                other => panic!("unexpected restart result: {other:?}"),
            }
        }
    })
    .await
    .unwrap();
    drop(pipe);
    assert_eq!(result.connection_id, old.connection_id);
    assert_eq!(result.generation, old.generation + 1);
    let current = result.reference();
    assert_eq!(
        error(client.request(status(current, id)).await.unwrap()),
        ErrorCode::InvalidArgument
    );
    assert!(matches!(
        ok(client
            .request(agent(A::Lease { connection: old }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    for r in [
        Request::Screen {
            connection: current,
        },
        agent(A::Acquire {
            connection: current,
            lifetime_ms: 100,
        }),
        Request::Ssh {
            request: S::Status {
                connection: current,
            },
        },
    ] {
        assert_eq!(
            error(client.request(r).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    assert_eq!(
        error(desktop.request(request(old, id)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    let (_, other_token) = issue(&mut desktop, vec![connect(profile.id, revision)], 30000).await;
    let (mut other, _) = Client::connect(&service.instance, other_token.expose(), service.pid)
        .await
        .unwrap();
    assert_eq!(
        error(other.request(request(old, id)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(other.request(status(old, id)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    // Removing config and the newly-created connection cannot turn original retry into Start.
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
    config_call(
        &mut desktop,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    let duplicate = ok(client.request(request(old, id)).await.unwrap());
    assert!(
        matches!(duplicate, Reply::Ssh(ssh::Reply::Started { connection }) if connection == result)
    );
    assert!(matches!(
        ok(client.request(status(old, id)).await.unwrap()),
        Reply::Ssh(ssh::Reply::ReconnectReceipt(r)) if r.connection == result
    ));
    assert_eq!(
        error(client.request(request(old, Uuid::new_v4())).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()), Reply::Sessions(v) if v.is_empty())
    );
    ok(desktop
        .request(Request::Revoke { ticket_id: ticket })
        .await
        .unwrap());
    assert_eq!(
        error(client.request(request(old, id)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(client.request(status(old, id)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn reconnect_rejects_changed_configuration_and_does_not_advance_the_old_generation() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let (old, mut profile, revision) = terminal(&mut desktop, &remote).await;
    let (_, token) = issue(
        &mut desktop,
        vec![scope(old, Action::Reconnect), connect(profile.id, revision)],
        30000,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut client, old, 10000).await;
    profile.name = "合成重连配置已修改".into();
    config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile,
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    assert_eq!(
        error(client.request(request(old, Uuid::new_v4())).await.unwrap()),
        ErrorCode::InvalidArgument
    );
    let status = ssh_status(&mut desktop, old, |_| true).await;
    assert_eq!(status.connection.reference(), old);
    assert_eq!(status.connection.state, State::Disconnected);
    service.stop(&mut desktop).await;
}
