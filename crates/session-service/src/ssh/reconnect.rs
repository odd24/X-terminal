use super::*;
impl Manager {
    fn reconnect_duplicate(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<Option<ConnectionInfo>, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        match inner.requests.get(&id) {
            Some((old, result))
                if old.previous == Some(connection) && old.cols == cols && old.rows == rows =>
            {
                Ok(Some(result.clone()))
            }
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => {
                inner.request_window.check(id)?;
                Ok(None)
            }
        }
    }
    pub(super) async fn reconnect(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<ssh::Reply, ErrorCode> {
        if let Some(result) = self.reconnect_duplicate(connection, id, cols, rows)? {
            return Ok(ssh::Reply::Started { connection: result });
        }
        let gate = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let info = self
                .store
                .lock()
                .map_err(|_| ErrorCode::InvalidState)?
                .sessions
                .info(connection)?;
            if !matches!(info.state, State::Disconnected | State::Failed) {
                return Err(ErrorCode::InvalidState);
            }
            let entry = inner
                .entries
                .get(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?;
            entry.receipts.check_available(id)?;
            entry.exec.check_available(id)?;
            entry.restart_gate.clone()
        };
        // Serialize only restarts of this connection; no session/configuration lock is held while awaiting cleanup.
        let _guard = gate.lock().await;
        if let Some(result) = self.reconnect_duplicate(connection, id, cols, rows)? {
            return Ok(ssh::Reply::Started { connection: result });
        }
        let profile_id = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            self.store
                .lock()
                .map_err(|_| ErrorCode::InvalidState)?
                .sessions
                .info(connection)?;
            inner
                .entries
                .get(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?
                .profile_id
        };
        let Value::Profile(profile) = self
            .config
            .request(Internal::Profile(profile_id))
            .await
            .map_err(|_| ErrorCode::InvalidArgument)?
        else {
            return Err(ErrorCode::InvalidState);
        };
        if !matches!(profile.settings, Settings::Ssh2 { .. }) {
            return Err(ErrorCode::Unsupported);
        }
        let old = {
            let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let info = self
                .store
                .lock()
                .map_err(|_| ErrorCode::InvalidState)?
                .sessions
                .info(connection)?;
            if !matches!(info.state, State::Disconnected | State::Failed) {
                return Err(ErrorCode::InvalidState);
            }
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
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        // Another connection can use the same global request ID while this restart
        // awaits cleanup. Resolve that collision before advancing either generation.
        if let Some((old, result)) = inner.requests.get(&id) {
            return if old.previous == Some(connection) && old.cols == cols && old.rows == rows {
                Ok(ssh::Reply::Started {
                    connection: result.clone(),
                })
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        inner.reserve_start(id)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let current = store.sessions.begin_connect(connection)?;
        configure_output(
            &mut store.sessions,
            current.reference(),
            &profile,
            rows,
            cols,
        )?;
        let reference = current.reference();
        let cancel = Cancellation::default();
        inner.entries.insert(
            connection.connection_id,
            Entry {
                reference,
                restart_gate: gate.clone(),
                exec: exec::Tasks::default(),
                writable: watch::channel(false).0,
                commands: None,
                receipts: Receipts::default(),
                profile_id,
                cancel: cancel.clone(),
                challenge: None,
                answer: None,
                failure: None,
                exit: None,
                signal: None,
                task: None,
            },
        );
        inner.requests.insert(
            id,
            (
                Start {
                    previous: Some(connection),
                    profile_id,
                    cols,
                    rows,
                },
                current.clone(),
            ),
        );
        let actor = Actor {
            inner: self.inner.clone(),
            store: self.store.clone(),
            config: self.config.clone(),
            reference,
            cancel,
        };
        let task = tokio::spawn(async move {
            let result = actor.run(profile, cols, rows).await;
            actor.finish(result);
        });
        inner
            .entries
            .get_mut(&reference.connection_id)
            .unwrap()
            .task = Some(task);
        Ok(ssh::Reply::Started {
            connection: current,
        })
    }
}
