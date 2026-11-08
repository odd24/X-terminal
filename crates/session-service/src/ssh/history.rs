use super::*;
use session_core::input::ordered_timestamp;

impl Inner {
    // Retained receipts win over the watermark. Callers must resolve duplicates first.
    pub(super) fn reserve_start(&mut self, id: Uuid) -> Result<(), ErrorCode> {
        self.request_window.check(id)?;
        if self.requests.len() >= 1024 {
            let (old, stamp) = self
                .requests
                .iter()
                .filter(|(_, (_, result))| {
                    self.entries.get(&result.connection_id).is_none_or(|entry| {
                        entry.reference != result.reference()
                            || entry.task.as_ref().is_some_and(JoinHandle::is_finished)
                    })
                })
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            self.request_window.retire(stamp);
            self.requests.remove(&old);
        }
        self.request_window.check(id)
    }
}

impl Manager {
    pub(super) async fn forget(&self, connection: ConnectionRef) -> Result<ssh::Reply, ErrorCode> {
        let gate = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            self.require_terminal(connection)?;
            inner
                .entries
                .get(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?
                .restart_gate
                .clone()
        };
        // Reconnect and removal share one per-connection gate. Never hold manager/store
        // locks while joining the old actor, and revalidate the exact generation afterward.
        let _guard = gate.lock().await;
        let old = {
            let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            self.require_terminal(connection)?;
            let entry = inner
                .entries
                .get_mut(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?;
            entry.cancel.cancel();
            entry.task.take()
        };
        if let Some(mut task) = old
            && timeout(Duration::from_secs(2), &mut task).await.is_err()
        {
            task.abort();
            let _ = task.await;
        }
        self.wait_transport_release(connection).await?;
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        inner.disconnects.transport_ended(connection);
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let now = store.now();
        store.pairing.retire_connection(connection, now);
        store.sessions.remove(connection)?;
        inner.entries.remove(&connection.connection_id);
        // Start/reconnect receipts remain independently bounded. Forgetting a connection
        // must not make its original creation request eligible to create another one.
        Ok(ssh::Reply::Accepted)
    }

    fn require_terminal(&self, connection: ConnectionRef) -> Result<(), ErrorCode> {
        let info = self
            .store
            .lock()
            .map_err(|_| ErrorCode::InvalidState)?
            .sessions
            .info(connection)?;
        if !matches!(info.state, State::Disconnected | State::Failed) {
            return Err(ErrorCode::InvalidState);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_start_receipts_remain_pinned_after_their_connections_are_removed() {
        let mut inner = Inner::default();
        let start = Start {
            temporary: None,
            owner: None,
            previous: None,
            profile_id: Uuid::new_v4(),
            cols: 80,
            rows: 24,
        };
        let result = ConnectionInfo {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 2,
            protocol: Protocol::Ssh2,
            state: State::Connecting,
        };
        for _ in 0..1024 {
            inner
                .requests
                .insert(Uuid::new_v4(), (start.clone(), result.clone()));
        }
        let retained: Vec<_> = inner.requests.keys().copied().collect();
        let ordered = Uuid::from_u128((100u128 << 80) | 0x7000_8000_0000_0000_0001);
        assert_eq!(
            inner.reserve_start(ordered),
            Err(ErrorCode::CapacityExceeded)
        );
        assert_eq!(
            inner.reserve_start(Uuid::new_v4()),
            Err(ErrorCode::CapacityExceeded)
        );
        assert_eq!(inner.requests.len(), 1024);
        assert!(retained.iter().all(|id| inner.requests.contains_key(id)));
        assert_eq!(inner.request_window.check(ordered), Ok(()));
    }
}
