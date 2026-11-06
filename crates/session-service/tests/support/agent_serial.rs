//! Real Windows IPC with the opt-in OS-thread memory port, never native COM.
use super::*;
use session_protocol::serial::{self as s, InputState, Reply as SR, Request as S};

async fn call(client: &mut Client, request: S) -> SR {
    match ok(client.request(Request::Serial { request }).await.unwrap()) {
        Reply::Serial(reply) => reply,
        _ => panic!("serial reply expected"),
    }
}
fn write(connection: ConnectionRef, request_id: Uuid, bytes: &[u8]) -> S {
    S::Write {
        connection,
        request_id,
        bytes: SensitiveBytes::new(bytes.to_vec()),
    }
}
async fn connected(desktop: &mut Client) -> ConnectionRef {
    let mut profile = portable();
    profile.settings = config_store::Settings::Serial {
        port: "COM7".into(),
        baud_rate: 115200,
        data_bits: 8,
        stop_bits: 1,
        parity: config_store::Parity::None,
        flow: config_store::Flow::None,
        dtr_on_open: false,
        rts_on_open: Some(false),
        encoding: config_store::Encoding::Utf8,
    };
    config_call(
        desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let SR::Inventory {
        revision, devices, ..
    } = call(desktop, S::Inventory {}).await
    else {
        panic!()
    };
    let SR::Started { connection } = call(
        desktop,
        S::Start {
            profile_id: profile.id,
            request_id: Uuid::new_v4(),
            revision,
            device_id: devices[0].device_id,
        },
    )
    .await
    else {
        panic!()
    };
    let reference = connection.reference();
    for _ in 0..400 {
        if matches!(call(desktop, S::Status { connection: reference }).await, SR::Status(status) if status.connection.state == State::Connected)
        {
            return reference;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("serial connection did not settle")
}
async fn receipt(
    client: &mut Client,
    connection: ConnectionRef,
    request_id: Uuid,
) -> s::InputReceipt {
    for _ in 0..600 {
        if let SR::Input(receipt) = call(
            client,
            S::InputStatus {
                connection,
                request_id,
            },
        )
        .await
            && receipt.state != InputState::Pending
        {
            return receipt;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("serial receipt did not settle")
}
async fn bytes(client: &mut Client, connection: ConnectionRef) -> Vec<u8> {
    let Reply::Output(page) = ok(client
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
    page.events
        .into_iter()
        .flat_map(|event| event.bytes)
        .collect()
}

#[tokio::test]
async fn agent_serial_ipc_enforces_independent_scopes_receipt_owner_and_observer_gate() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let connection = connected(&mut desktop).await;
    let (_, token) = issue(&mut desktop, vec![scope(connection, Action::Write)], 30000).await;
    let (mut writer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut writer, connection, 10000).await;
    let id = Uuid::new_v4();
    call(
        &mut writer,
        S::Send {
            connection,
            request_id: id,
            content: Sensitive::new("中文\r\n".into()),
            format: s::Format::Text,
            ending: s::Ending::None,
            pace: s::Pace::default(),
        },
    )
    .await;
    assert_eq!(
        receipt(&mut writer, connection, id).await.driver_accepted,
        Some(8)
    );
    call(
        &mut writer,
        S::Send {
            connection,
            request_id: id,
            content: Sensitive::new("中文\r\n".into()),
            format: s::Format::Text,
            ending: s::Ending::None,
            pace: s::Pace::default(),
        },
    )
    .await;
    assert_eq!(
        error(
            writer
                .request(Request::Serial {
                    request: S::Control {
                        connection,
                        request_id: Uuid::new_v4(),
                        line: s::Line::Dtr,
                        asserted: true
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            writer
                .request(Request::Screen { connection })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let (_, token) = issue(
        &mut desktop,
        vec![scope(connection, Action::Control)],
        30000,
    )
    .await;
    let (mut controller, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let l = match ok(writer
        .request(agent(A::Lease { connection }))
        .await
        .unwrap())
    {
        Reply::Agent(AR::Lease(Some(l))) => l,
        _ => panic!(),
    };
    ok(writer
        .request(agent(A::Release {
            connection,
            lease_id: l.lease_id,
        }))
        .await
        .unwrap());
    lease(&mut controller, connection, 10000).await;
    assert_eq!(
        error(
            controller
                .request(Request::Serial {
                    request: write(connection, Uuid::new_v4(), b"never")
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            controller
                .request(Request::Serial {
                    request: S::InputStatus {
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
            desktop
                .request(Request::Serial {
                    request: write(connection, id, b"steal")
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let control = Uuid::new_v4();
    call(
        &mut controller,
        S::Control {
            connection,
            request_id: control,
            line: s::Line::Dtr,
            asserted: true,
        },
    )
    .await;
    assert_eq!(
        receipt(&mut controller, connection, control).await.state,
        InputState::ControlApplied
    );
    assert_eq!(
        receipt(&mut writer, connection, id).await.state,
        InputState::DriverAccepted
    );
    let Reply::ReadTicket { token, .. } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 30000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    for target in [
        connection,
        ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        },
    ] {
        for request in [
            write(target, Uuid::new_v4(), b"never"),
            S::InputStatus {
                connection: target,
                request_id: id,
            },
            S::Control {
                connection: target,
                request_id: Uuid::new_v4(),
                line: s::Line::Break,
                asserted: true,
            },
            S::Send {
                connection: target,
                request_id: Uuid::new_v4(),
                content: Sensitive::new("never".into()),
                format: s::Format::Text,
                ending: s::Ending::None,
                pace: s::Pace::default(),
            },
        ] {
            assert_eq!(
                error(observer.request(Request::Serial { request }).await.unwrap()),
                ErrorCode::PermissionDenied
            );
        }
    }
    let fence = Uuid::new_v4();
    call(&mut desktop, write(connection, fence, b"fence")).await;
    receipt(&mut desktop, connection, fence).await;
    assert_eq!(
        bytes(&mut desktop, connection).await,
        "中文\r\nfence".as_bytes()
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_serial_ipc_paced_tail_revokes_without_closing_the_shared_worker() {
    for cause in [
        "release",
        "lease-expiry",
        "grant-expiry",
        "revoke",
        "takeover",
        "user",
        "user-control",
    ] {
        let temp = ConfigTemp::new();
        let mut service = temp.start().await;
        let mut desktop = service.connect().await;
        let connection = connected(&mut desktop).await;
        let (ticket, token) = issue(
            &mut desktop,
            vec![
                scope(connection, Action::Write),
                scope(connection, Action::Control),
            ],
            if cause == "grant-expiry" { 800 } else { 30000 },
        )
        .await;
        let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
            .await
            .unwrap();
        let l = lease(
            &mut client,
            connection,
            if cause == "lease-expiry" || cause == "grant-expiry" {
                400
            } else {
                10000
            },
        )
        .await;
        let id = Uuid::new_v4();
        call(
            &mut client,
            S::Send {
                connection,
                request_id: id,
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
        let control = Uuid::new_v4();
        call(
            &mut client,
            S::Control {
                connection,
                request_id: control,
                line: s::Line::Break,
                asserted: true,
            },
        )
        .await;
        let mut observed = false;
        for _ in 0..100 {
            if bytes(&mut desktop, connection).await == b"a" {
                observed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(observed, "first actual worker write not observed: {cause}");
        match cause {
            "release" => {
                ok(client
                    .request(agent(A::Release {
                        connection,
                        lease_id: l.lease_id,
                    }))
                    .await
                    .unwrap());
                lease(&mut client, connection, 5000).await;
            }
            "lease-expiry" => tokio::time::sleep(Duration::from_millis(450)).await,
            "grant-expiry" => tokio::time::sleep(Duration::from_millis(850)).await,
            "revoke" => {
                ok(desktop
                    .request(Request::Revoke { ticket_id: ticket })
                    .await
                    .unwrap());
            }
            "takeover" => {
                ok(desktop
                    .request(agent(A::Takeover { connection }))
                    .await
                    .unwrap());
            }
            "user" => {
                call(&mut desktop, write(connection, Uuid::new_v4(), b"user")).await;
            }
            "user-control" => {
                call(
                    &mut desktop,
                    S::Control {
                        connection,
                        request_id: Uuid::new_v4(),
                        line: s::Line::Dtr,
                        asserted: true,
                    },
                )
                .await;
            }
            _ => unreachable!(),
        }
        let result = receipt(&mut desktop, connection, id).await;
        assert_eq!(result.state, InputState::Unknown, "{cause}");
        assert_eq!(result.driver_accepted, Some(1));
        assert_eq!(result.failure, Some(s::Failure::Cancelled));
        assert_eq!(
            receipt(&mut desktop, connection, tail).await.state,
            InputState::CancelledBeforeDispatch
        );
        assert_eq!(
            receipt(&mut desktop, connection, control).await.state,
            InputState::CancelledBeforeDispatch
        );
        let fence = Uuid::new_v4();
        call(&mut desktop, write(connection, fence, b"fence")).await;
        assert_eq!(
            receipt(&mut desktop, connection, fence).await.state,
            InputState::DriverAccepted
        );
        assert_eq!(
            bytes(&mut desktop, connection).await,
            if cause == "user" {
                b"auserfence".as_slice()
            } else {
                b"afence".as_slice()
            },
            "{cause}"
        );
        assert!(
            matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(status) if status.connection.state == State::Connected)
        );
        service.stop(&mut desktop).await;
    }
}

#[tokio::test]
async fn agent_serial_connect_retains_owner_without_inventory_read_or_control_authority() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let mut profile = portable();
    profile.settings = config_store::Settings::Serial {
        port: "COM7".into(),
        baud_rate: 115200,
        data_bits: 8,
        stop_bits: 1,
        parity: config_store::Parity::None,
        flow: config_store::Flow::None,
        dtr_on_open: false,
        rts_on_open: Some(false),
        encoding: config_store::Encoding::Utf8,
    };
    config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let SR::Inventory {
        revision, devices, ..
    } = call(&mut desktop, S::Inventory {}).await
    else {
        panic!()
    };
    let device_id = devices[0].device_id;
    let scopes = vec![Scope {
        target: Target::Profile {
            profile_id: profile.id,
        },
        action: Action::Connect,
    }];
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
    let start = || S::Start {
        profile_id: profile.id,
        request_id: id,
        revision,
        device_id,
    };
    let (first, second) = tokio::join!(call(&mut client, start()), call(&mut retry, start()));
    let SR::Started {
        connection: created,
    } = first
    else {
        panic!()
    };
    assert!(matches!(second, SR::Started { connection } if connection == created));
    let connection = created.reference();
    for caller in [&mut other, &mut desktop] {
        assert_eq!(
            error(
                caller
                    .request(Request::Serial { request: start() })
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    assert_eq!(
        error(
            client
                .request(Request::Serial {
                    request: S::Start {
                        profile_id: profile.id,
                        request_id: id,
                        revision: Uuid::new_v4(),
                        device_id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    assert!(
        matches!(ok(client.request(Request::List {}).await.unwrap()), Reply::Sessions(list) if list.is_empty())
    );
    for request in [
        S::Inventory {},
        S::Status { connection },
        S::Close { connection },
        S::Forget { connection },
        write(connection, Uuid::new_v4(), b"never"),
        S::Control {
            connection,
            request_id: Uuid::new_v4(),
            line: s::Line::Dtr,
            asserted: true,
        },
        S::Start {
            profile_id: Uuid::new_v4(),
            request_id: Uuid::new_v4(),
            revision,
            device_id,
        },
    ] {
        assert_eq!(
            error(client.request(Request::Serial { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    assert_eq!(
        error(
            client
                .request(Request::Screen { connection })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            client
                .request(agent(A::Acquire {
                    connection,
                    lifetime_ms: 1000
                }))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    for _ in 0..400 {
        if matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(s) if s.connection.state == State::Connected)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(s) if s.connection.state == State::Connected)
    );
    call(&mut desktop, S::Close { connection }).await;
    for _ in 0..400 {
        if matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(s) if s.connection.state == State::Disconnected)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        matches!(call(&mut desktop, S::Status { connection }).await, SR::Status(s) if s.connection.state == State::Disconnected)
    );
    call(&mut desktop, S::Forget { connection }).await;
    config_call(
        &mut desktop,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    // A fresh inventory revision must not turn a retained Start into a new open.
    call(&mut desktop, S::Inventory {}).await;
    assert!(
        matches!(call(&mut retry, start()).await, SR::Started { connection } if connection == created)
    );
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()), Reply::Sessions(list) if list.is_empty())
    );
    service.stop(&mut desktop).await;
}
