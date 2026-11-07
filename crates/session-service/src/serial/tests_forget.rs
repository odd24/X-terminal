use super::*;

fn request(connection: ConnectionRef, request_id: Uuid, query: bool) -> Request {
    if query {
        Request::ForgetStatus {
            connection,
            request_id,
        }
    } else {
        Request::ForgetStart {
            connection,
            request_id,
        }
    }
}

#[tokio::test]
async fn serial_forget_failed_state_does_not_cancel_live_worker_and_original_number_retries() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    wire.pause.store(true, Ordering::Release);
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    manager
        .store
        .lock()
        .unwrap()
        .sessions
        .transition(connection, State::Failed)
        .unwrap();
    let id = Uuid::new_v4();
    assert!(matches!(
        manager.handle(request(connection, id, false)).await,
        Err(ErrorCode::InvalidState)
    ));
    assert!(matches!(
        manager.handle(request(connection, id, true)).await,
        Err(ErrorCode::NotFound)
    ));
    {
        let inner = manager.inner.lock().unwrap();
        let entry = &inner.entries[&connection.connection_id];
        assert!(!entry.closing);
        assert!(!entry.joined);
        assert!(!entry.worker.as_ref().unwrap().is_finished());
    }
    manager.handle(Request::Close { connection }).await.unwrap();
    wire.pause.store(false, Ordering::Release);
    // Failed is terminal in the existing domain state machine. Close joins the
    // worker without rewriting that state; observe the actual cleanup proof.
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            manager.tick();
            if manager.inner.lock().unwrap().entries[&connection.connection_id].joined {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    status(&manager, connection, State::Failed).await;
    let Reply::Forget(receipt) = manager
        .handle(request(connection, id, false))
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(receipt.state, session_core::forget::State::Removed);
    let new = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, new, State::Connected).await;
    for query in [true, false] {
        assert!(
            matches!(manager.handle(request(connection, id, query)).await, Ok(Reply::Forget(r)) if r == receipt)
        );
    }
    assert_eq!(wire.driver_opens.load(Ordering::Acquire), 2);
    status(&manager, new, State::Connected).await;
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn serial_forget_full_ledger_and_conflicting_numbers_preserve_joined_connection() {
    let (_temp, config, manager, _, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    let start_id = Uuid::new_v4();
    let connection = start(&manager, profile, start_id, revision, device).await;
    status(&manager, connection, State::Connected).await;
    let disconnect_id = Uuid::new_v4();
    manager
        .handle(Request::Disconnect {
            connection,
            request_id: disconnect_id,
        })
        .await
        .unwrap();
    status(&manager, connection, State::Disconnected).await;
    for id in [start_id, disconnect_id] {
        assert!(matches!(
            manager.handle(request(connection, id, false)).await,
            Err(ErrorCode::InvalidArgument)
        ));
    }
    {
        let mut inner = manager.inner.lock().unwrap();
        for _ in 0..1024 {
            inner
                .forgets
                .remove_with(None, connection, Uuid::new_v4(), || Ok(()))
                .unwrap();
        }
    }
    let id = Uuid::new_v4();
    assert!(matches!(
        manager.handle(request(connection, id, false)).await,
        Err(ErrorCode::CapacityExceeded)
    ));
    assert!(
        manager
            .inner
            .lock()
            .unwrap()
            .entries
            .contains_key(&connection.connection_id)
    );
    assert!(
        manager
            .store
            .lock()
            .unwrap()
            .sessions
            .info(connection)
            .is_ok()
    );
    assert!(matches!(
        manager.handle(request(connection, id, true)).await,
        Err(ErrorCode::NotFound)
    ));
    manager.inner.lock().unwrap().forgets = Default::default();
    assert!(matches!(
        manager.handle(request(connection, id, false)).await,
        Ok(Reply::Forget(_))
    ));
    assert!(
        matches!(manager.handle(Request::DisconnectStatus { connection, request_id: disconnect_id }).await,
        Ok(Reply::Disconnect(r)) if r.state == session_core::disconnect::State::TransportEnded)
    );
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
