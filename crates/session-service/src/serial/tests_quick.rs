use super::*;

#[tokio::test]
async fn temporary_serial_snapshot_is_desktop_only_bound_deduplicated_and_passive() {
    let (_temp, config, mut manager, wire, profile) = setup().await;
    let (desktop, agent) = connect_identities(&manager, profile, 10000);
    let (held, _query) = Access::held_profile();
    manager.config = held; // QuickStart must never need or save a Profile.
    let (revision, device_id) = selection(&manager).await;
    let id = Uuid::new_v4();
    let settings = config_store::Settings::Serial {
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
    let request = || Request::QuickStart {
        settings: settings.clone(),
        request_id: id,
        revision,
        device_id,
    };
    assert!(matches!(
        manager.handle_authenticated(&agent, request()).await,
        Err(ErrorCode::PermissionDenied)
    ));
    assert!(matches!(
        manager
            .handle_authenticated(&desktop, Request::StartStatus { request_id: id })
            .await,
        Err(ErrorCode::NotFound)
    ));
    assert_eq!(wire.opens.load(Ordering::Acquire), 0);
    let Reply::Started { connection } = tokio::time::timeout(
        Duration::from_secs(2),
        manager.handle_authenticated(&desktop, request()),
    )
    .await
    .unwrap()
    .unwrap() else {
        panic!()
    };
    let target = connection.reference();
    status(&manager, target, State::Connected).await;
    for request in [request(), Request::StartStatus { request_id: id }] {
        let Reply::Started { connection: again } = manager
            .handle_authenticated(&desktop, request)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(again.reference(), target);
    }
    assert!(matches!(
        manager
            .handle_authenticated(&agent, Request::StartStatus { request_id: id })
            .await,
        Err(ErrorCode::PermissionDenied)
    ));
    let mut changed = settings.clone();
    if let config_store::Settings::Serial { baud_rate, .. } = &mut changed {
        *baud_rate = 9600;
    }
    assert!(matches!(
        manager
            .handle(Request::QuickStart {
                settings: changed,
                request_id: id,
                revision,
                device_id
            })
            .await,
        Err(ErrorCode::InvalidArgument)
    ));
    assert!(matches!(
        manager
            .handle(Request::QuickStart {
                settings: settings.clone(),
                request_id: Uuid::new_v4(),
                revision,
                device_id
            })
            .await,
        Err(ErrorCode::InvalidState)
    ));
    wire.output
        .lock()
        .unwrap()
        .push_back("UART只接收\r\n".as_bytes().to_vec());
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let s = status(&manager, target, State::Connected).await;
        if s.read_bytes > 0 {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(
        wire.writes.load(Ordering::Acquire),
        0,
        "receiving must not send commands"
    );
    assert_eq!(wire.opens.load(Ordering::Acquire), 1);
    manager
        .handle(Request::Close { connection: target })
        .await
        .unwrap();
    status(&manager, target, State::Disconnected).await;
    // A duplicate/query after close remains the original receipt, never reopens.
    manager.handle(request()).await.unwrap();
    assert_eq!(wire.opens.load(Ordering::Acquire), 1);
    selection(&manager).await;
    assert!(matches!(
        manager
            .handle(Request::QuickStart {
                settings,
                request_id: Uuid::new_v4(),
                revision,
                device_id
            })
            .await,
        Err(ErrorCode::InvalidState)
    ));
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
