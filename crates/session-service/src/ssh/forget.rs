use super::*;

impl Manager {
    pub(super) async fn forget_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        request_id: Uuid,
        query: bool,
    ) -> Result<ssh::Reply, ErrorCode> {
        let (gate, authority) = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            let owner = Self::start_owner(&store, identity)?;
            if let Some(receipt) = inner.forgets.lookup(owner, connection, request_id)? {
                return Ok(ssh::Reply::Forget(receipt));
            }
            if query {
                return Err(if owner.is_some() {
                    ErrorCode::PermissionDenied
                } else {
                    ErrorCode::NotFound
                });
            }
            let now = store.now();
            let authority = if let Some(identity) = identity.filter(|_| owner.is_some()) {
                Some((
                    identity.clone(),
                    store.pairing.admit_input(
                        identity,
                        Scope {
                            target: Target::Connection { connection },
                            action: Action::Forget,
                        },
                        request_id,
                        now,
                    )?,
                ))
            } else {
                None
            };
            let info = store.sessions.info(connection)?;
            if info.protocol != Protocol::Ssh2
                || !matches!(info.state, State::Disconnected | State::Failed)
            {
                return Err(ErrorCode::InvalidState);
            }
            let entry = inner
                .entries
                .get(&connection.connection_id)
                .filter(|entry| entry.reference == connection)
                .ok_or(ErrorCode::NotFound)?;
            (entry.restart_gate.clone(), authority)
        };
        // Only wait for lifecycle serialization; never cancel, join or abort a live
        // transport on the strength of Forget. Capture/recheck the SAME permit.
        let _guard = gate.lock().await;
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::start_owner(&store, identity)?;
        if let Some(receipt) = inner.forgets.lookup(owner, connection, request_id)? {
            return Ok(ssh::Reply::Forget(receipt));
        }
        Self::check_start(&mut store, identity, authority.as_ref(), false)?;
        let info = store.sessions.info(connection)?;
        if info.protocol != Protocol::Ssh2
            || !matches!(info.state, State::Disconnected | State::Failed)
        {
            return Err(ErrorCode::InvalidState);
        }
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .filter(|entry| entry.reference == connection)
            .ok_or(ErrorCode::NotFound)?;
        if !entry.task.as_ref().is_some_and(JoinHandle::is_finished)
            || entry
                .transport
                .as_ref()
                .is_some_and(|transport| !transport.released())
        {
            return Err(ErrorCode::InvalidState);
        }
        entry.receipts.check_available(request_id)?;
        entry.exec.check_available(request_id)?;
        if inner.requests.contains_key(&request_id)
            || inner
                .disconnects
                .lookup(owner, connection, request_id)?
                .is_some()
        {
            return Err(ErrorCode::InvalidArgument);
        }
        // Disjoint fields permit an atomic receipt/removal transaction. Everything
        // fallible precedes remove; no await/policy change occurs inside the closure.
        let Inner {
            forgets,
            disconnects,
            entries,
            ..
        } = &mut *inner;
        let receipt = forgets.remove_with(owner, connection, request_id, || {
            Self::check_start(&mut store, identity, authority.as_ref(), true)?;
            store.sessions.remove(connection)?;
            let now = store.now();
            store.pairing.retire_connection(connection, now);
            disconnects.transport_ended(connection);
            entries.remove(&connection.connection_id);
            Ok(())
        })?;
        Ok(ssh::Reply::Forget(receipt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::pairing::{Pairing, SecretToken};

    fn setup(
        lifetime: u64,
    ) -> (
        Manager,
        ConnectionRef,
        Identity,
        Identity,
        oneshot::Sender<()>,
    ) {
        let store = Store::test_store();
        let token = SecretToken::generate();
        let (connection, desktop, agent) = {
            let mut s = store.lock().unwrap();
            s.pairing = Pairing::new(&token);
            let desktop = s.pairing.authenticate(&token, 0).unwrap();
            let initial = s.sessions.create(Protocol::Ssh2).unwrap();
            let connection = s
                .sessions
                .begin_connect(initial.reference())
                .unwrap()
                .reference();
            s.sessions.transition(connection, State::Failed).unwrap();
            let (agent, _, _) = s
                .pairing
                .issue_agent(
                    &desktop,
                    vec![Scope {
                        target: Target::Connection { connection },
                        action: Action::Forget,
                    }],
                    lifetime,
                    0,
                )
                .unwrap();
            s.pairing
                .acquire_lease(&agent, connection, lifetime.min(10000), 0)
                .unwrap();
            (connection, desktop, agent)
        };
        let (config, _) = Access::held_profile();
        let manager = Manager::new(store, config);
        let (send, held) = oneshot::channel();
        manager.inner.lock().unwrap().entries.insert(
            connection.connection_id,
            Entry {
                server_host: "synthetic".into(),
                temporary: None,
                reference: connection,
                restart_gate: Arc::new(tokio::sync::Mutex::new(())),
                exec: exec::Tasks::default(),
                writable: watch::channel(false).0,
                commands: None,
                receipts: Receipts::default(),
                profile_id: Uuid::new_v4(),
                encoding: config_store::Encoding::Utf8,
                cancel: Cancellation::default(),
                challenge: None,
                answer: None,
                failure: None,
                exit: None,
                signal: None,
                task: Some(tokio::spawn(async move {
                    let _ = held.await;
                })),
                transport: None,
            },
        );
        (manager, connection, desktop, agent, send)
    }
    async fn finish(manager: &Manager, c: ConnectionRef, send: oneshot::Sender<()>) {
        send.send(()).unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if manager.inner.lock().unwrap().entries[&c.connection_id]
                    .task
                    .as_ref()
                    .unwrap()
                    .is_finished()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn running_actor_is_not_cancelled_or_removed_and_original_id_can_retry_after_cleanup() {
        let (manager, c, _, agent, send) = setup(30000);
        let id = Uuid::new_v4();
        assert!(matches!(
            manager.forget_as(Some(&agent), c, id, false).await,
            Err(ErrorCode::InvalidState)
        ));
        {
            let inner = manager.inner.lock().unwrap();
            assert!(!inner.entries[&c.connection_id].cancel.is_cancelled());
            assert_eq!(
                inner.forgets.lookup(Some(agent.ticket_id()), c, id),
                Ok(None)
            );
        }
        finish(&manager, c, send).await;
        assert!(matches!(
            manager.forget_as(Some(&agent), c, id, false).await,
            Ok(ssh::Reply::Forget(_))
        ));
        assert!(matches!(
            manager.forget_as(Some(&agent), c, id, true).await,
            Ok(ssh::Reply::Forget(_))
        ));
        assert_eq!(
            manager.store.lock().unwrap().sessions.info(c),
            Err(ErrorCode::NotFound)
        );
    }

    #[tokio::test]
    async fn gate_wait_rechecks_revocation_takeover_reacquired_lease_and_cancelled_future() {
        for change in ["revoke", "takeover", "reacquire", "expire", "cancel"] {
            let (manager, c, desktop, agent, send) =
                setup(if change == "expire" { 100 } else { 30000 });
            finish(&manager, c, send).await;
            let gate = manager.inner.lock().unwrap().entries[&c.connection_id]
                .restart_gate
                .clone();
            let guard = gate.lock().await;
            let id = Uuid::new_v4();
            let mut pending = Box::pin(manager.forget_as(Some(&agent), c, id, false));
            // Poll the actual operation to its held gate before changing policy.
            tokio::select! { biased;
                _ = &mut pending => panic!("gate was not held"),
                _ = tokio::task::yield_now() => {}
            }
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
                    "cancel" | "expire" => {}
                    _ => unreachable!(),
                }
            }
            drop(guard);
            if change == "cancel" {
                drop(pending);
            } else {
                assert!(matches!(
                    pending.await,
                    Err(ErrorCode::PermissionDenied | ErrorCode::InputBusy)
                ));
            }
            assert!(manager.store.lock().unwrap().sessions.info(c).is_ok());
            assert_eq!(
                manager
                    .inner
                    .lock()
                    .unwrap()
                    .forgets
                    .lookup(Some(agent.ticket_id()), c, id),
                Ok(None)
            );
        }
    }

    #[tokio::test]
    async fn capacity_failure_leaves_session_and_authority_untouched() {
        let (manager, c, _, agent, send) = setup(30000);
        finish(&manager, c, send).await;
        {
            let mut inner = manager.inner.lock().unwrap();
            for _ in 0..1024 {
                inner
                    .forgets
                    .remove_with(None, c, Uuid::new_v4(), || Ok(()))
                    .unwrap();
            }
        }
        assert!(matches!(
            manager
                .forget_as(Some(&agent), c, Uuid::new_v4(), false)
                .await,
            Err(ErrorCode::CapacityExceeded)
        ));
        let s = manager.store.lock().unwrap();
        assert!(s.sessions.info(c).is_ok());
        assert!(s.pairing.lease(&agent, c, s.now()).unwrap().is_some());
    }
}
