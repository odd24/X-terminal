//! Opt-in memory OS worker; not physical COM evidence.
use super::*;
use serial::{Reply as R, Request as Q};
async fn call(client: &mut Client, request: Q) -> R {
    let Reply::Serial(reply) = ok(client.request(Request::Serial { request }).await.unwrap())
    else {
        panic!()
    };
    reply
}
async fn receipt(client: &mut Client, c: ConnectionRef, id: Uuid) -> serial::InputReceipt {
    timeout(Duration::from_secs(4), async {
        loop {
            if let R::Input(r) = call(
                client,
                Q::InputStatus {
                    connection: c,
                    request_id: id,
                },
            )
            .await
                && r.state != serial::InputState::Pending
            {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn single_serial_start_input_control_disconnect_forget_use_exact_body_and_original_owner() {
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
    let config::ConfigReply::SavedProfile {
        revision: config_revision,
        ..
    } = config_call(
        &mut desktop,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await
    else {
        panic!()
    };
    let R::Inventory {
        revision, devices, ..
    } = call(&mut desktop, Q::Inventory {}).await
    else {
        panic!()
    };
    let start = Operation::Serial(Q::Start {
        profile_id: profile.id,
        request_id: Uuid::new_v4(),
        revision,
        device_id: devices[0].device_id,
    });
    let (_, _, mut starter) = single(
        &mut desktop,
        &service,
        vec![connect_scope(profile.id, config_revision)],
        &start,
    )
    .await;
    let Reply::Serial(R::Started { connection }) = ok(dispatch(&mut starter, &start).await) else {
        panic!()
    };
    let c = connection.reference();
    timeout(Duration::from_secs(4), async {
        loop {
            if matches!(call(&mut desktop, Q::Status { connection: c }).await, R::Status(s) if s.connection.state == State::Connected) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    config_call(
        &mut desktop,
        config::ConfigRequest::DeleteProfile { id: profile.id },
    )
    .await;
    assert!(
        matches!(ok(dispatch(&mut starter, &start).await), Reply::Serial(R::Started { connection }) if connection.reference() == c)
    );
    let operations = [
        Operation::Serial(Q::Write {
            connection: c,
            request_id: Uuid::new_v4(),
            bytes: SensitiveBytes::new(b"raw".to_vec()),
        }),
        Operation::Serial(Q::Send {
            connection: c,
            request_id: Uuid::new_v4(),
            content: Sensitive::new("中".into()),
            format: serial::Format::Text,
            ending: serial::Ending::CrLf,
            pace: serial::Pace {
                chunk_bytes: 1,
                interval_ms: 2,
            },
        }),
        Operation::Serial(Q::Control {
            connection: c,
            request_id: Uuid::new_v4(),
            line: serial::Line::Dtr,
            asserted: true,
        }),
    ];
    for operation in operations {
        let d = operation.descriptor().unwrap();
        let (_, _, mut client) =
            single(&mut desktop, &service, vec![scope(c, d.action)], &operation).await;
        lease(&mut client, c, 10000).await;
        let mut changed = serde_json::to_value(&operation).unwrap();
        match &operation {
            Operation::Serial(Q::Write { .. }) => {
                changed["request"]["bytes"] = serde_json::json!([7])
            }
            Operation::Serial(Q::Send { .. }) => {
                changed["request"]["pace"]["interval_ms"] = 3.into()
            }
            Operation::Serial(Q::Control { .. }) => changed["request"]["asserted"] = false.into(),
            _ => unreachable!(),
        }
        assert_eq!(
            error(dispatch(&mut client, &serde_json::from_value(changed).unwrap()).await),
            ErrorCode::PermissionDenied
        );
        ok(dispatch(&mut client, &operation).await);
        let first = receipt(&mut client, c, d.request_id).await;
        assert_eq!(
            first.state,
            if d.action == Action::Control {
                serial::InputState::ControlApplied
            } else {
                serial::InputState::DriverAccepted
            }
        );
        ok(dispatch(&mut client, &operation).await);
        let duplicate = receipt(&mut client, c, d.request_id).await;
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(duplicate).unwrap()
        );
        assert_eq!(
            error(
                client
                    .request(Request::Screen { connection: c })
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
        release(&mut client, c).await;
    }
    let grant_id = Uuid::new_v4();
    let Reply::Agent(AR::Grant {
        token: Some(token), ..
    }) = ok(desktop
        .request(agent(A::GrantTask {
            request_id: grant_id,
            task_id: Uuid::new_v4(),
            label: "内存端口有限任务".into(),
            scopes: vec![scope(c, Action::Write)],
            lifetime_ms: 30000,
        }))
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut task, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut task, c, 10000).await;
    for bytes in [b"one".as_slice(), b"two"] {
        let id = Uuid::new_v4();
        call(
            &mut task,
            Q::Write {
                connection: c,
                request_id: id,
                bytes: SensitiveBytes::new(bytes.to_vec()),
            },
        )
        .await;
        assert_eq!(
            receipt(&mut task, c, id).await.state,
            serial::InputState::DriverAccepted
        );
    }
    ok(desktop
        .request(agent(A::GrantRevoke {
            request_id: grant_id,
        }))
        .await
        .unwrap());
    assert_eq!(
        error(
            task.request(Request::Serial {
                request: Q::Control {
                    connection: c,
                    request_id: Uuid::new_v4(),
                    line: serial::Line::Rts,
                    asserted: true
                }
            })
            .await
            .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    // Worker write completion precedes the independent output reader.
    timeout(Duration::from_secs(4), async {
        loop {
            let Reply::Output(page) = ok(desktop
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
            let bytes = page
                .events
                .into_iter()
                .flat_map(|e| e.bytes)
                .collect::<Vec<_>>();
            if bytes == "raw中\r\nonetwo".as_bytes() {
                break;
            }
            assert!("raw中\r\nonetwo".as_bytes().starts_with(&bytes));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let close_id = Uuid::new_v4();
    let close = Operation::Serial(Q::Disconnect {
        connection: c,
        request_id: close_id,
    });
    let (_, _, mut closer) = single(
        &mut desktop,
        &service,
        vec![scope(c, Action::Disconnect)],
        &close,
    )
    .await;
    lease(&mut closer, c, 10000).await;
    ok(dispatch(&mut closer, &close).await);
    timeout(Duration::from_secs(5), async {
        loop {
            if matches!(call(&mut closer, Q::DisconnectStatus { connection: c, request_id: close_id }).await, R::Disconnect(r) if r.state == session_core::disconnect::State::TransportEnded) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let forget_id = Uuid::new_v4();
    let forget = Operation::Serial(Q::ForgetStart {
        connection: c,
        request_id: forget_id,
    });
    let (_, _, mut remover) = single(
        &mut desktop,
        &service,
        vec![scope(c, Action::Forget)],
        &forget,
    )
    .await;
    lease(&mut remover, c, 10000).await;
    for _ in 0..2 {
        assert!(
            matches!(ok(dispatch(&mut remover, &forget).await), Reply::Serial(R::Forget(r)) if r.state == session_core::forget::State::Removed)
        );
    }
    assert!(
        matches!(call(&mut remover, Q::ForgetStatus { connection: c, request_id: forget_id }).await, R::Forget(r) if r.state == session_core::forget::State::Removed)
    );
    assert!(
        matches!(ok(dispatch(&mut closer, &close).await), Reply::Serial(R::Disconnect(r)) if r.state == session_core::disconnect::State::TransportEnded)
    );
    assert!(
        matches!(ok(dispatch(&mut starter, &start).await), Reply::Serial(R::Started { connection }) if connection.reference() == c)
    );
    service.stop(&mut desktop).await;
}
