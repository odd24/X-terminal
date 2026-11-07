use super::*;
impl Manager {
    fn reconnect_duplicate(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<Option<ConnectionInfo>, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::start_owner(&store, identity)?;
        match inner.requests.get(&id) {
            Some((old, _)) if old.owner != owner => Err(ErrorCode::PermissionDenied),
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
    pub(super) async fn reconnect_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<ssh::Reply, ErrorCode> {
        if let Some(result) = self.reconnect_duplicate(identity, connection, id, cols, rows)? {
            return Ok(ssh::Reply::Started { connection: result });
        }
        let (gate, owner, restart, authority, profile_id) = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            let owner = Self::start_owner(&store, identity)?;
            let now = store.now();
            // Require the old-generation capability before exposing session/profile data.
            let restart = if let Some(identity) = identity.filter(|_| owner.is_some()) {
                Some((
                    identity.clone(),
                    store.pairing.admit_input(
                        identity,
                        Scope {
                            target: Target::Connection { connection },
                            action: Action::Reconnect,
                        },
                        id,
                        now,
                    )?,
                ))
            } else {
                None
            };
            let info = store.sessions.info(connection)?;
            if !matches!(info.state, State::Disconnected | State::Failed) {
                return Err(ErrorCode::InvalidState);
            }
            let entry = inner
                .entries
                .get(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?;
            entry.receipts.check_available(id)?;
            entry.exec.check_available(id)?;
            if inner.disconnects.lookup(owner, connection, id)?.is_some() {
                return Err(ErrorCode::InvalidArgument);
            }
            let authority = if let Some(identity) = identity.filter(|_| owner.is_some()) {
                let permit = store
                    .pairing
                    .admit_connect(identity, entry.profile_id, id, now)?;
                // Reconnect has no legacy ID-only approval fallback: new parameters must
                // have an explicit configuration revision, even for older API clients.
                if permit.profile_revision().is_none() {
                    return Err(ErrorCode::PermissionDenied);
                }
                Some((identity.clone(), permit))
            } else {
                None
            };
            (
                entry.restart_gate.clone(),
                owner,
                restart,
                authority,
                entry.profile_id,
            )
        };
        // Serialize only restarts of this connection; no session/configuration lock is held while awaiting cleanup.
        let _guard = gate.lock().await;
        if let Some(result) = self.reconnect_duplicate(identity, connection, id, cols, rows)? {
            return Ok(ssh::Reply::Started { connection: result });
        }
        {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            Self::check_start(&mut store, identity, restart.as_ref(), false)?;
            Self::check_start(&mut store, identity, authority.as_ref(), false)?;
            store.sessions.info(connection)?;
            let entry = inner
                .entries
                .get(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?;
            if entry.profile_id != profile_id {
                return Err(ErrorCode::InvalidState);
            }
        }
        let query = authority
            .as_ref()
            .and_then(|(_, permit)| permit.profile_revision())
            .map_or(Internal::Profile(profile_id), |revision| {
                Internal::ProfileRevision {
                    id: profile_id,
                    revision,
                }
            });
        let lookup = self.config.request(query).await;
        let old = {
            let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            Self::check_start(&mut store, identity, restart.as_ref(), false)?;
            Self::check_start(&mut store, identity, authority.as_ref(), false)?;
            let info = store.sessions.info(connection)?;
            if !matches!(info.state, State::Disconnected | State::Failed) {
                return Err(ErrorCode::InvalidState);
            }
            // Do not cancel/join the old Actor when configuration lookup failed.
            match &lookup {
                Ok(Value::Profile(profile))
                    if matches!(profile.settings, Settings::Ssh2 { .. }) => {}
                Ok(Value::Profile(_)) => return Err(ErrorCode::Unsupported),
                Ok(_) => return Err(ErrorCode::InvalidState),
                Err(_) => return Err(ErrorCode::InvalidArgument),
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
        self.wait_transport_release(connection).await?;
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        Self::start_owner(&store, identity)?;
        inner.disconnects.transport_ended(connection);
        // Another connection can use the same global request ID while this restart
        // awaits cleanup. Resolve that collision before advancing either generation.
        if let Some((old, result)) = inner.requests.get(&id) {
            if old.owner != owner {
                return Err(ErrorCode::PermissionDenied);
            }
            return if old.previous == Some(connection) && old.cols == cols && old.rows == rows {
                Ok(ssh::Reply::Started {
                    connection: result.clone(),
                })
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        Self::check_start(&mut store, identity, restart.as_ref(), false)?;
        Self::check_start(&mut store, identity, authority.as_ref(), false)?;
        let Value::Profile(profile) = lookup.map_err(|_| ErrorCode::InvalidArgument)? else {
            return Err(ErrorCode::InvalidState);
        };
        if !matches!(
            store.sessions.info(connection)?.state,
            State::Disconnected | State::Failed
        ) {
            return Err(ErrorCode::InvalidState);
        }
        inner.reserve_start(id)?;
        // Old-generation permission is consumed at generation advancement. Its
        // retirement must not invalidate the separate Profile Connect permit.
        Self::check_start(&mut store, identity, restart.as_ref(), true)?;
        let now = store.now();
        store.pairing.retire_connection(connection, now);
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
                encoding: profile_encoding(&profile)?,
                cancel: cancel.clone(),
                challenge: None,
                answer: None,
                failure: None,
                exit: None,
                signal: None,
                task: None,
                transport: None,
            },
        );
        inner.requests.insert(
            id,
            (
                Start {
                    owner,
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
        let identity_owned = identity.cloned();
        let task = tokio::spawn(async move {
            let result = actor
                .run_as(profile, cols, rows, identity_owned, authority)
                .await;
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
