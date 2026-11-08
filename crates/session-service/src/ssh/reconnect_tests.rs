use super::*;
use session_core::pairing::{Pairing, SecretToken};

fn setup(config: Access, lifetime: u64) -> (Manager, ConnectionRef, Uuid, Identity, Identity) {
    let store = Store::test_store();
    let token = SecretToken::generate();
    let profile_id = Uuid::new_v4();
    let mut s = store.lock().unwrap();
    s.pairing = Pairing::new(&token);
    let desktop = s.pairing.authenticate(&token, 0).unwrap();
    let initial = s.sessions.create(Protocol::Ssh2).unwrap();
    let c = s
        .sessions
        .begin_connect(initial.reference())
        .unwrap()
        .reference();
    s.sessions.transition(c, State::Failed).unwrap();
    let (agent, _, _) = s
        .pairing
        .issue_agent(
            &desktop,
            vec![
                Scope {
                    target: Target::Connection { connection: c },
                    action: Action::Reconnect,
                },
                Scope {
                    target: Target::ProfileRevision {
                        profile_id,
                        revision: Uuid::new_v4(),
                    },
                    action: Action::Connect,
                },
            ],
            lifetime,
            0,
        )
        .unwrap();
    s.pairing
        .acquire_lease(&agent, c, lifetime.min(10000), 0)
        .unwrap();
    drop(s);
    let manager = Manager::new(store, config);
    manager.inner.lock().unwrap().entries.insert(
        c.connection_id,
        Entry {
            temporary: None,
            reference: c,
            restart_gate: Arc::new(tokio::sync::Mutex::new(())),
            exec: exec::Tasks::default(),
            writable: watch::channel(false).0,
            commands: None,
            receipts: Receipts::default(),
            profile_id,
            encoding: config_store::Encoding::Utf8,
            cancel: Cancellation::default(),
            challenge: None,
            answer: None,
            failure: None,
            exit: None,
            signal: None,
            task: None,
            transport: None,
        },
    );
    (manager, c, profile_id, desktop, agent)
}
fn profile(id: Uuid, port: u16) -> Profile {
    Profile {
        id,
        folder_id: None,
        name: "合成重连等待".into(),
        credential_ref: None,
        settings: Settings::Ssh2 {
            host: "127.0.0.1".into(),
            port,
            username: "synthetic".into(),
            auth: Auth::Password,
            encoding: config_store::Encoding::Utf8,
        },
    }
}

#[tokio::test]
async fn a_temporary_target_cannot_borrow_a_colliding_saved_profile_revision_connect_grant() {
    let (config, _query) = Access::held_profile();
    let (manager, c, profile_id, _desktop, agent) = setup(config, 30000);
    manager
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&c.connection_id)
        .unwrap()
        .temporary = Some(profile(profile_id, 2222));
    assert!(matches!(
        manager.grant_profile(c),
        Err(ErrorCode::Unsupported)
    ));
    assert!(matches!(
        timeout(
            Duration::from_millis(100),
            manager.reconnect_as(Some(&agent), c, Uuid::new_v4(), 80, 24)
        )
        .await
        .unwrap(),
        Err(ErrorCode::PermissionDenied)
    ));
    assert_eq!(
        manager
            .store
            .lock()
            .unwrap()
            .sessions
            .info(c)
            .unwrap()
            .generation,
        c.generation
    );
    assert!(manager.inner.lock().unwrap().requests.is_empty());
    manager.close().await;
}

#[tokio::test]
async fn waiting_configuration_rechecks_old_permission_lease_and_profile_before_advancing() {
    for change in ["revoke", "takeover", "reacquire", "expire"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (config, query) = Access::held_profile();
        let (manager, c, profile_id, desktop, agent) =
            setup(config, if change == "expire" { 100 } else { 30000 });
        let manager = Arc::new(manager);
        let cloned = manager.clone();
        let identity = agent.clone();
        let pending = tokio::spawn(async move {
            cloned
                .reconnect_as(Some(&identity), c, Uuid::new_v4(), 80, 24)
                .await
        });
        let reply = query.await;
        if change == "expire" {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        {
            let mut s = manager.store.lock().unwrap();
            let now = s.now();
            match change {
                "revoke" => s.pairing.revoke(&desktop, agent.ticket_id(), now).unwrap(),
                "takeover" => s.pairing.takeover(&desktop, c, now).unwrap(),
                "reacquire" => {
                    let lease = s.pairing.lease(&agent, c, now).unwrap().unwrap();
                    s.pairing
                        .release_lease(&agent, c, lease.lease_id, now)
                        .unwrap();
                    s.pairing.acquire_lease(&agent, c, 10000, now).unwrap();
                }
                "expire" => {}
                _ => unreachable!(),
            }
        }
        reply
            .send(Ok(Value::Profile(profile(
                profile_id,
                listener.local_addr().unwrap().port(),
            ))))
            .ok()
            .unwrap();
        assert!(matches!(
            pending.await.unwrap(),
            Err(ErrorCode::PermissionDenied | ErrorCode::InputBusy)
        ));
        assert_eq!(
            manager
                .store
                .lock()
                .unwrap()
                .sessions
                .info(c)
                .unwrap()
                .state,
            State::Failed
        );
        assert!(manager.inner.lock().unwrap().requests.is_empty());
        assert!(
            timeout(Duration::from_millis(40), listener.accept())
                .await
                .is_err()
        );
        Arc::try_unwrap(manager).ok().unwrap().close().await;
    }
}

#[tokio::test]
async fn waiting_restart_gate_rechecks_reconnect_scope_and_lease_before_configuration() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (config, query) = Access::held_profile();
    let mut query = Box::pin(query);
    let (manager, c, _profile_id, desktop, agent) = setup(config, 30000);
    let gate = manager.inner.lock().unwrap().entries[&c.connection_id]
        .restart_gate
        .clone();
    let held_gate = gate.lock_owned().await;
    let id = Uuid::new_v4();
    let manager = Arc::new(manager);
    let cloned = manager.clone();
    let identity = agent.clone();
    let pending =
        tokio::spawn(async move { cloned.reconnect_as(Some(&identity), c, id, 80, 24).await });

    // Admission is observable in the service's bounded audit log, proving the
    // request has captured its permit and is now waiting for this exact gate.
    timeout(Duration::from_secs(2), async {
        loop {
            let admitted = {
                let store = manager.store.lock().unwrap();
                let now = store.now();
                let page = store.pairing.audit(&desktop, 0, 128, now).unwrap();
                page.events.iter().any(|event| {
                    event.kind == session_core::access::AuditKind::Admitted
                        && event.request_id == Some(id)
                        && event.client_id == Some(agent.ticket_id())
                })
            };
            if admitted {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    {
        let mut store = manager.store.lock().unwrap();
        let now = store.now();
        store.pairing.takeover(&desktop, c, now).unwrap();
    }
    drop(held_gate);
    assert!(matches!(
        pending.await.unwrap(),
        Err(ErrorCode::PermissionDenied | ErrorCode::InputBusy)
    ));
    assert!(
        timeout(Duration::from_millis(40), &mut query)
            .await
            .is_err()
    );
    assert_eq!(
        manager
            .store
            .lock()
            .unwrap()
            .sessions
            .info(c)
            .unwrap()
            .state,
        State::Failed
    );
    assert!(manager.inner.lock().unwrap().requests.is_empty());
    assert!(
        timeout(Duration::from_millis(40), listener.accept())
            .await
            .is_err()
    );
    Arc::try_unwrap(manager).ok().unwrap().close().await;
}

#[tokio::test]
async fn revoked_authority_after_actor_cleanup_wait_does_not_advance_generation() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (config, query) = Access::held_profile();
    let (manager, c, profile_id, desktop, agent) = setup(config, 30000);
    let cancel = manager.inner.lock().unwrap().entries[&c.connection_id]
        .cancel
        .clone();
    let (cleaning_tx, cleaning_rx) = oneshot::channel();
    let (finish_tx, finish_rx) = oneshot::channel();
    let old_task = tokio::spawn(async move {
        cancel.cancelled().await;
        let _ = cleaning_tx.send(());
        let _ = finish_rx.await;
    });
    manager
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&c.connection_id)
        .unwrap()
        .task = Some(old_task);

    let manager = Arc::new(manager);
    let cloned = manager.clone();
    let identity = agent.clone();
    let pending = tokio::spawn(async move {
        cloned
            .reconnect_as(Some(&identity), c, Uuid::new_v4(), 80, 24)
            .await
    });
    let response = query.await;
    response
        .send(Ok(Value::Profile(profile(profile_id, port))))
        .ok()
        .unwrap();

    // This signal is sent only after Reconnect cancels and joins the old Actor;
    // keep that cleanup await pending while revoking the original ticket.
    cleaning_rx.await.unwrap();
    {
        let mut store = manager.store.lock().unwrap();
        let now = store.now();
        store
            .pairing
            .revoke(&desktop, agent.ticket_id(), now)
            .unwrap();
    }
    finish_tx.send(()).unwrap();
    assert!(matches!(
        pending.await.unwrap(),
        Err(ErrorCode::PermissionDenied)
    ));
    assert_eq!(
        manager
            .store
            .lock()
            .unwrap()
            .sessions
            .info(c)
            .unwrap()
            .state,
        State::Failed
    );
    assert!(manager.inner.lock().unwrap().requests.is_empty());
    assert!(
        timeout(Duration::from_millis(40), listener.accept())
            .await
            .is_err()
    );
    Arc::try_unwrap(manager).ok().unwrap().close().await;
}

#[tokio::test]
async fn generation_advance_retires_old_lease_and_actor_rechecks_profile_before_first_poll() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (config, query) = Access::held_profile();
    let (manager, c, profile_id, desktop, agent) = setup(config, 30000);
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        query
            .await
            .send(Ok(Value::Profile(profile(profile_id, port))))
            .ok()
            .unwrap();
    });
    let id = Uuid::new_v4();
    let ssh::Reply::Started { connection } = manager
        .reconnect_as(Some(&agent), c, id, 80, 24)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(connection.connection_id, c.connection_id);
    assert_eq!(connection.generation, c.generation + 1);
    {
        let mut s = manager.store.lock().unwrap();
        let now = s.now();
        assert!(s.pairing.lease(&agent, c, now).unwrap().is_none());
        assert!(
            s.pairing
                .acquire_lease(&agent, connection.reference(), 1000, now)
                .is_err()
        );
        s.pairing.revoke(&desktop, agent.ticket_id(), now).unwrap();
    }
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    assert_eq!(
        manager.inner.lock().unwrap().entries[&c.connection_id].failure,
        Some(Failure::Cancelled)
    );
    manager.close().await;
}
