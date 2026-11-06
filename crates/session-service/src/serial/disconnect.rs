use super::*;

impl Inner {
    pub(super) fn observe_disconnect(&mut self, connection: ConnectionRef) {
        if self
            .entries
            .get(&connection.connection_id)
            .is_some_and(|entry| entry.reference == connection && entry.joined)
        {
            self.disconnects.transport_ended(connection);
        }
    }
}

impl Manager {
    pub(super) fn disconnect_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        request_id: Uuid,
        query: bool,
    ) -> Result<Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::owner(&store, identity)?;
        let now = store.now();
        // Retirement removes authority to act, not ownership of a retained receipt.
        inner.observe_disconnect(connection);
        if let Some(receipt) = inner.disconnects.lookup(owner, connection, request_id)? {
            return Ok(Reply::Disconnect(receipt));
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
        if info.protocol != Protocol::Serial {
            return Err(ErrorCode::InvalidArgument);
        }
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .filter(|entry| entry.reference == connection)
            .ok_or(ErrorCode::NotFound)?;
        if entry.inputs.contains_key(&request_id) || inner.starts.contains_key(&request_id) {
            return Err(ErrorCode::InvalidArgument);
        }
        entry.window.check(request_id)?;
        inner.disconnects.reserve(owner, connection, request_id)?;
        // No await, lock release or policy change between admit and dispatch.
        // Capacity must be reserved before cancellation or Dispatched audit.
        if let (Some(identity), Some(permit)) = (identity, permit.as_ref()) {
            store.pairing.dispatch_input(identity, permit, now)?;
        }
        let entry = inner.entries.get_mut(&connection.connection_id).unwrap();
        entry.closing = true;
        if let Some(worker) = &entry.worker {
            worker.cancel();
        }
        if !matches!(
            info.state,
            State::Closing | State::Disconnected | State::Failed
        ) {
            store.sessions.transition(connection, State::Closing)?;
        }
        store.pairing.retire_connection(connection, now);
        inner.observe_disconnect(connection);
        Ok(Reply::Disconnect(
            inner
                .disconnects
                .lookup(owner, connection, request_id)?
                .unwrap(),
        ))
    }
}
