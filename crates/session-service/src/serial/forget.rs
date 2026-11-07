use super::*;

impl Manager {
    pub(super) fn forget_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        request_id: Uuid,
        query: bool,
    ) -> Result<Reply, ErrorCode> {
        // Serial lifecycle operations and worker observations use this same lock
        // order. No await or worker cancellation is needed for completed removal.
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::owner(&store, identity)?;
        if let Some(receipt) = inner.forgets.lookup(owner, connection, request_id)? {
            return Ok(Reply::Forget(receipt));
        }
        if query {
            return Err(if owner.is_some() {
                ErrorCode::PermissionDenied
            } else {
                ErrorCode::NotFound
            });
        }
        let now = store.now();
        let permit = if let Some(identity) = identity.filter(|_| owner.is_some()) {
            Some(store.pairing.admit_input(
                identity,
                Scope {
                    target: Target::Connection { connection },
                    action: Action::Forget,
                },
                request_id,
                now,
            )?)
        } else {
            None
        };
        let info = store.sessions.info(connection)?;
        if info.protocol != Protocol::Serial
            || !matches!(info.state, State::Disconnected | State::Failed)
        {
            return Err(ErrorCode::InvalidState);
        }
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .filter(|entry| entry.reference == connection)
            .ok_or(ErrorCode::NotFound)?;
        // Only a received actual join result proves the OS worker was reclaimed.
        // A lost reporting channel and unsettled input tickets cannot prove it.
        if !entry.joined || !entry.tickets.is_empty() {
            return Err(ErrorCode::InvalidState);
        }
        entry.window.check(request_id)?;
        if entry.inputs.contains_key(&request_id)
            || inner.starts.contains_key(&request_id)
            || inner
                .disconnects
                .lookup(owner, connection, request_id)?
                .is_some()
        {
            return Err(ErrorCode::InvalidArgument);
        }
        let Inner {
            forgets,
            disconnects,
            entries,
            ..
        } = &mut *inner;
        let receipt = forgets.remove_with(owner, connection, request_id, || {
            if let (Some(identity), Some(permit)) = (identity, permit.as_ref()) {
                store.pairing.dispatch_input(identity, permit, now)?;
            }
            store.sessions.remove(connection)?;
            store.pairing.retire_connection(connection, now);
            disconnects.transport_ended(connection);
            entries.remove(&connection.connection_id);
            Ok(())
        })?;
        Ok(Reply::Forget(receipt))
    }
}
