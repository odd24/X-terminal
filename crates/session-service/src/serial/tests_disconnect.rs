use super::*;
use session_core::disconnect::{Receipt as DisconnectReceipt, State as D};

async fn disconnect(
    manager: &Manager,
    connection: ConnectionRef,
    id: Uuid,
    query: bool,
) -> DisconnectReceipt {
    let request = if query {
        Request::DisconnectStatus {
            connection,
            request_id: id,
        }
    } else {
        Request::Disconnect {
            connection,
            request_id: id,
        }
    };
    let Reply::Disconnect(receipt) = manager.handle(request).await.unwrap() else {
        panic!()
    };
    receipt
}

#[tokio::test]
async fn serial_disconnect_waits_for_worker_and_preserves_original_receipt_after_forget_and_reopen()
{
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    wire.pause.store(true, Ordering::Release);
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !wire.read_waiting.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let input = Uuid::new_v4();
    manager
        .handle(write(connection, input, b"unsent"))
        .await
        .unwrap();
    let id = Uuid::new_v4();
    assert_eq!(
        disconnect(&manager, connection, id, false).await.state,
        D::Requested
    );
    assert!(
        status(&manager, connection, State::Closing)
            .await
            .cleanup_pending
    );
    assert_eq!(
        disconnect(&manager, connection, id, true).await.state,
        D::Requested
    );
    assert!(matches!(
        manager.handle(Request::Forget { connection }).await,
        Err(ErrorCode::InvalidState)
    ));
    assert!(matches!(
        manager
            .handle(Request::Start {
                profile_id: profile,
                request_id: Uuid::new_v4(),
                revision,
                device_id: device
            })
            .await,
        Err(ErrorCode::InvalidState)
    ));
    wire.pause.store(false, Ordering::Release);
    status(&manager, connection, State::Disconnected).await;
    let ended = disconnect(&manager, connection, id, true).await;
    assert_eq!(ended.state, D::TransportEnded);
    assert_eq!(
        receipt(&manager, connection, input).await.state,
        InputState::CancelledBeforeDispatch
    );
    assert!(wire.accepted.lock().unwrap().is_empty());
    manager
        .handle(Request::Forget { connection })
        .await
        .unwrap();
    let new = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, new, State::Connected).await;
    assert_eq!(disconnect(&manager, connection, id, false).await, ended);
    assert_eq!(wire.driver_opens.load(Ordering::Acquire), 2);
    assert_eq!(
        status(&manager, new, State::Connected)
            .await
            .connection
            .reference(),
        new
    );
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn serial_disconnect_capacity_failure_does_not_cancel_and_guard_wait_disconnect_never_opens()
{
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    wire.open_pause.store(true, Ordering::Release);
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !wire.open_waiting.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    {
        let mut inner = manager.inner.lock().unwrap();
        for _ in 0..1024 {
            inner
                .disconnects
                .reserve(None, connection, Uuid::new_v4())
                .unwrap();
        }
    }
    assert!(matches!(
        manager
            .handle(Request::Disconnect {
                connection,
                request_id: Uuid::new_v4()
            })
            .await,
        Err(ErrorCode::CapacityExceeded)
    ));
    assert!(!manager.inner.lock().unwrap().entries[&connection.connection_id].closing);
    assert_eq!(
        manager
            .store
            .lock()
            .unwrap()
            .sessions
            .info(connection)
            .unwrap()
            .state,
        State::Connecting
    );
    // Reset only the synthetic ledger; the first failed operation made no cancellation.
    manager.inner.lock().unwrap().disconnects = Default::default();
    let id = Uuid::new_v4();
    assert_eq!(
        disconnect(&manager, connection, id, false).await.state,
        D::Requested
    );
    wire.open_pause.store(false, Ordering::Release);
    status(&manager, connection, State::Disconnected).await;
    assert_eq!(
        disconnect(&manager, connection, id, true).await.state,
        D::TransportEnded
    );
    assert_eq!(wire.driver_opens.load(Ordering::Acquire), 0);
    assert!(wire.accepted.lock().unwrap().is_empty());
    assert!(wire.controls.lock().unwrap().is_empty());
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn serial_disconnect_lost_join_report_does_not_prove_transport_cleanup() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    let id = Uuid::new_v4();
    disconnect(&manager, connection, id, false).await;
    // Keep the actual Worker owned locally while its reporting channel is lost.
    let mut worker = {
        let mut inner = manager.inner.lock().unwrap();
        let entry = inner.entries.get_mut(&connection.connection_id).unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(sender);
        entry.joining = Some(receiver);
        entry.worker.take().unwrap()
    };
    let failed = status(&manager, connection, State::Failed).await;
    assert!(failed.cleanup_pending);
    let forget_id = Uuid::new_v4();
    assert!(matches!(
        manager
            .handle(Request::ForgetStart {
                connection,
                request_id: forget_id
            })
            .await,
        Err(ErrorCode::InvalidState)
    ));
    assert!(matches!(
        manager
            .handle(Request::ForgetStatus {
                connection,
                request_id: forget_id
            })
            .await,
        Err(ErrorCode::NotFound)
    ));
    assert_eq!(
        disconnect(&manager, connection, id, true).await.state,
        D::Requested
    );
    assert!(matches!(
        manager.handle(Request::Forget { connection }).await,
        Err(ErrorCode::InvalidState)
    ));
    assert_eq!(wire.driver_opens.load(Ordering::Acquire), 1);
    // Explicitly join the test's retained worker; no detached synthetic thread.
    tokio::task::spawn_blocking(move || worker.join())
        .await
        .unwrap()
        .unwrap();
    manager
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&connection.connection_id)
        .unwrap()
        .joined = true;
    assert_eq!(
        disconnect(&manager, connection, id, true).await.state,
        D::TransportEnded
    );
    assert!(matches!(
        manager
            .handle(Request::ForgetStart {
                connection,
                request_id: forget_id
            })
            .await,
        Ok(Reply::Forget(_))
    ));
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
