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

#[cfg(feature = "serial-mcp-fixture")]
#[tokio::test]
async fn serial_driver_read_error_retires_agent_but_preserves_observer_prefix() {
    async fn start(desktop: &mut Client, profile_id: Uuid) -> ConnectionRef {
        let R::Inventory {
            revision, devices, ..
        } = call(desktop, Q::Inventory {}).await
        else {
            panic!("inventory expected")
        };
        assert_eq!(devices.len(), 1);
        let R::Started { connection } = call(
            desktop,
            Q::Start {
                profile_id,
                request_id: Uuid::new_v4(),
                revision,
                device_id: devices[0].device_id,
            },
        )
        .await
        else {
            panic!("serial start expected")
        };
        let c = connection.reference();
        terminal_state(desktop, c, State::Connected).await;
        c
    }

    async fn terminal_state(
        desktop: &mut Client,
        c: ConnectionRef,
        state: State,
    ) -> serial::Status {
        timeout(Duration::from_secs(4), async {
            loop {
                if let R::Status(status) = call(desktop, Q::Status { connection: c }).await
                    && status.connection.state == state
                    && !status.cleanup_pending
                {
                    return status;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    let directory = std::env::temp_dir().join(format!(
        "shared-terminal-mcp-serial-control-中文-read-failure-{}",
        Uuid::new_v4()
    ));
    std::fs::create_dir(&directory).unwrap();
    let temp = ConfigTemp(directory);
    let mut service = Fixture::on_instance_with_args(
        Uuid::new_v4().to_string(),
        true,
        Some(&temp.0),
        &["--serial-mcp-fixture"],
    )
    .await;
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
    assert!(matches!(
        config_call(
            &mut desktop,
            config::ConfigRequest::SaveProfile {
                profile: profile.clone(),
                credential: config::CredentialEdit::Keep {},
            }
        )
        .await,
        config::ConfigReply::SavedProfile { .. }
    ));
    let original = start(&mut desktop, profile.id).await;
    let (_, token) = issue(
        &mut desktop,
        vec![
            scope(original, Action::Read),
            scope(original, Action::Write),
        ],
        30000,
    )
    .await;
    let (mut writer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    lease(&mut writer, original, 10000).await;
    let Reply::ReadTicket { token, .. } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![original],
            lifetime_ms: 30000,
        })
        .await
        .unwrap())
    else {
        panic!("observer ticket expected")
    };
    let (mut observer, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();

    let prefix = b"P24 UART RX\r\n";
    let write_id = Uuid::new_v4();
    let write = |connection, request_id, bytes: &[u8]| Request::Serial {
        request: Q::Write {
            connection,
            request_id,
            bytes: SensitiveBytes::new(bytes.to_vec()),
        },
    };
    ok(writer
        .request(write(original, write_id, prefix))
        .await
        .unwrap());
    let accepted = receipt(&mut writer, original, write_id).await;
    assert_eq!(accepted.state, serial::InputState::DriverAccepted);
    assert_eq!(accepted.driver_accepted, Some(prefix.len()));
    let read = |connection| Request::Read {
        connection,
        cursor: 1,
        max_bytes: 4096,
    };
    let captured = timeout(Duration::from_secs(4), async {
        loop {
            let Reply::Output(page) = ok(observer.request(read(original)).await.unwrap()) else {
                panic!("observer output expected")
            };
            if !page.events.is_empty() {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        captured
            .events
            .iter()
            .flat_map(|event| event.bytes.iter().copied())
            .collect::<Vec<_>>(),
        prefix
    );
    assert!(!captured.disconnected && !captured.truncated);
    assert!(
        captured
            .events
            .iter()
            .all(|event| event.gap_bytes.is_none())
    );
    assert!(
        matches!(ok(writer.request(read(original)).await.unwrap()), Reply::Output(page) if page == captured)
    );

    let counters = || -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(temp.0.join("serial-mcp-controller.json")).unwrap())
            .unwrap()
    };
    let before = counters();
    assert_eq!(before["opened"], 1);
    assert_eq!(before["write_calls"], 1);
    assert_eq!(before["write_bytes"], prefix.len());
    assert_eq!(before["control_calls"], 0);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp.0.join("serial-mcp-fail-read"))
        .unwrap();
    let failed = terminal_state(&mut desktop, original, State::Failed).await;
    assert_eq!(failed.connection.reference(), original);
    assert_eq!(failed.failure, Some(serial::Failure::Io));
    assert_eq!(failed.read_bytes, prefix.len() as u64);
    assert_eq!(failed.dropped_bytes, 0);
    assert_eq!(receipt(&mut writer, original, write_id).await, accepted);
    assert!(matches!(
        ok(writer
            .request(agent(A::Lease {
                connection: original
            }))
            .await
            .unwrap()),
        Reply::Agent(AR::Lease(None))
    ));
    assert_eq!(
        error(writer.request(read(original)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            writer
                .request(write(original, Uuid::new_v4(), b"denied old write"))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            observer
                .request(write(original, Uuid::new_v4(), b"observer cannot write"))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let Reply::Output(ended) = ok(observer.request(read(original)).await.unwrap()) else {
        panic!("retained observer output expected")
    };
    assert!(ended.disconnected);
    assert_eq!(
        ended,
        OutputPage {
            disconnected: true,
            ..captured
        }
    );
    assert!(
        matches!(ok(desktop.request(read(original)).await.unwrap()), Reply::Output(page) if page == ended)
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(counters(), before);
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()), Reply::Sessions(list) if list.len() == 1 && list[0].reference() == original)
    );

    let fresh = start(&mut desktop, profile.id).await;
    assert_ne!(fresh.connection_id, original.connection_id);
    assert_eq!(
        error(
            writer
                .request(write(fresh, Uuid::new_v4(), b"denied new write"))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(observer.request(read(fresh)).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    assert!(
        matches!(ok(desktop.request(read(fresh)).await.unwrap()), Reply::Output(page) if page.events.is_empty() && !page.disconnected)
    );
    let mut expected = before;
    expected["opened"] = 2.into();
    assert_eq!(counters(), expected);
    service.stop(&mut desktop).await;
    println!(
        "Serial read fault IPC: FAILED/IO, prefix {} bytes, observer retained, Agent lease retired, explicit fresh identity, two memory opens and one write",
        prefix.len()
    );
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
