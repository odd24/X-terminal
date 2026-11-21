use super::*;

impl Inner {
    pub(super) fn observe_disconnect(&mut self, connection: ConnectionRef) {
        if self
            .entries
            .get(&connection.connection_id)
            .is_some_and(|entry| {
                entry.reference == connection
                    && entry.task.as_ref().is_some_and(JoinHandle::is_finished)
                    && entry
                        .transport
                        .as_ref()
                        .is_none_or(TransportCleanup::released)
            })
        {
            self.disconnects.transport_ended(connection);
        }
    }
}

impl Manager {
    // Reconnect/Forget have already joined (or aborted and joined) the Actor.
    // Exec JoinSet drop aborts jobs asynchronously; wait for their final Arc to
    // disappear before claiming local transport teardown or replacing its entry.
    pub(super) async fn wait_transport_release(
        &self,
        connection: ConnectionRef,
    ) -> Result<(), ErrorCode> {
        let cleanup = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            inner
                .entries
                .get(&connection.connection_id)
                .filter(|entry| entry.reference == connection)
                .ok_or(ErrorCode::StaleGeneration)?
                .transport
                .clone()
        };
        timeout(Duration::from_secs(2), async {
            while cleanup
                .as_ref()
                .is_some_and(|transport| !transport.released())
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .map_err(|_| ErrorCode::InvalidState)
    }
    pub(super) fn disconnect_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        request_id: Uuid,
        query: bool,
    ) -> Result<ssh::Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let now = store.now();
        let owner = match identity {
            Some(identity) if store.pairing.is_agent(identity, now)? => Some(identity.ticket_id()),
            Some(identity) => {
                store.pairing.require_desktop(identity, now)?;
                None
            }
            None => None,
        };
        // Scope retirement is a consequence of Disconnect. Original authenticated
        // receipt recovery must precede scope and session lookup, including Forget.
        inner.observe_disconnect(connection);
        if let Some(receipt) = inner.disconnects.lookup(owner, connection, request_id)? {
            return Ok(ssh::Reply::Disconnect(receipt));
        }
        if query {
            return Err(if owner.is_some() {
                ErrorCode::PermissionDenied
            } else {
                ErrorCode::NotFound
            });
        }
        let permit = if let Some(identity) = identity.filter(|_| owner.is_some()) {
            Some(store.pairing.admit_input(
                identity,
                Scope {
                    target: Target::Connection { connection },
                    action: Action::Disconnect,
                },
                request_id,
                now,
            )?)
        } else {
            None
        };
        let info = store.sessions.info(connection)?;
        if info.protocol != Protocol::Ssh2 && !(info.protocol == Protocol::Ssh1 && owner.is_none())
        {
            return Err(ErrorCode::InvalidArgument);
        }
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .filter(|entry| entry.reference == connection)
            .ok_or(ErrorCode::NotFound)?;
        entry.receipts.check_available(request_id)?;
        entry.exec.check_available(request_id)?;
        if inner.requests.contains_key(&request_id) {
            return Err(ErrorCode::InvalidArgument);
        }
        inner.disconnects.reserve(owner, connection, request_id)?;
        // Reservation can fail on capacity; do not record a dispatch before it.
        // Policy and its monotonic timestamp have not changed since admission:
        // no await, lock release or policy mutation occurs in this interval.
        if let (Some(identity), Some(permit)) = (identity, permit.as_ref()) {
            store.pairing.dispatch_input(identity, permit, now)?;
        }
        let entry = inner.entries.get_mut(&connection.connection_id).unwrap();
        entry.cancel.cancel();
        entry.exec.finish_all(true);
        entry.commands = None;
        entry.receipts.connection_lost(InputFailure::Cancelled);
        entry.answer = None;
        entry.challenge = None;
        // Preserve old Desktop lifecycle behavior. Receipt completion is based
        // solely on the observed task/transport cleanup, not these transitions.
        if !matches!(info.state, State::Disconnected | State::Closing) {
            store.sessions.transition(connection, State::Closing)?;
            store.sessions.transition(connection, State::Disconnected)?;
        }
        store.pairing.retire_connection(connection, now);
        inner.observe_disconnect(connection);
        Ok(ssh::Reply::Disconnect(
            inner
                .disconnects
                .lookup(owner, connection, request_id)?
                .unwrap(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::disconnect::State as D;

    fn setup() -> (Manager, ConnectionRef, oneshot::Sender<()>) {
        let store = Store::test_store();
        let connection = {
            let mut store = store.lock().unwrap();
            let initial = store.sessions.create(Protocol::Ssh2).unwrap();
            store
                .sessions
                .begin_connect(initial.reference())
                .unwrap()
                .reference()
        };
        let (config, _) = Access::held_profile();
        let manager = Manager::new(store, config);
        let (send, held) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = held.await;
        });
        manager.inner.lock().unwrap().entries.insert(
            connection.connection_id,
            Entry {
                source_settings: None,
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
                task: Some(task),
                transport: None,
            },
        );
        (manager, connection, send)
    }

    #[tokio::test]
    async fn disconnected_domain_state_does_not_complete_a_still_running_actor_receipt() {
        let (manager, connection, send) = setup();
        let id = Uuid::new_v4();
        let ssh::Reply::Disconnect(first) =
            manager.disconnect_as(None, connection, id, false).unwrap()
        else {
            panic!()
        };
        assert_eq!(first.state, D::Requested);
        assert_eq!(
            manager
                .store
                .lock()
                .unwrap()
                .sessions
                .info(connection)
                .unwrap()
                .state,
            State::Disconnected
        );
        let ssh::Reply::Disconnect(query) =
            manager.disconnect_as(None, connection, id, true).unwrap()
        else {
            panic!()
        };
        assert_eq!(query, first);
        send.send(()).unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                let ssh::Reply::Disconnect(query) =
                    manager.disconnect_as(None, connection, id, true).unwrap()
                else {
                    panic!()
                };
                if query.state == D::TransportEnded {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        manager.close().await;
    }

    #[tokio::test]
    async fn receipt_capacity_failure_does_not_cancel_or_change_the_transport() {
        let (manager, connection, send) = setup();
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
            manager.disconnect_as(None, connection, Uuid::new_v4(), false),
            Err(ErrorCode::CapacityExceeded)
        ));
        assert!(
            !manager.inner.lock().unwrap().entries[&connection.connection_id]
                .cancel
                .is_cancelled()
        );
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
        send.send(()).unwrap();
        manager.close().await;
    }
}
