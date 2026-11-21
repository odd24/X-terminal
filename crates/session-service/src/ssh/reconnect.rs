use super::*;

impl Start {
    fn matches_reconnect(&self, previous: ConnectionRef, fixed: Option<ssh::FixedProfile>) -> bool {
        self.previous == Some(previous)
            && match fixed {
                Some(profile) => {
                    self.profile_id == profile.profile_id && self.revision == Some(profile.revision)
                }
                None => self.revision.is_none(),
            }
    }
}

impl Manager {
    pub(super) fn reconnect_status(
        &self,
        identity: &Identity,
        previous: ConnectionRef,
        request_id: Uuid,
        fixed: Option<ssh::FixedProfile>,
    ) -> Result<ssh::Reply, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::start_owner(&store, Some(identity))?;
        if fixed.is_some() && owner.is_some() {
            return Err(ErrorCode::PermissionDenied);
        }
        let Some((start, connection)) = inner.requests.get(&request_id) else {
            inner.request_window.check(request_id)?;
            return Err(if owner.is_some() {
                ErrorCode::PermissionDenied
            } else {
                ErrorCode::NotFound
            });
        };
        if start.owner != owner
            || start.previous.is_none()
            || start.revision.is_some() != fixed.is_some()
        {
            return Err(ErrorCode::PermissionDenied);
        }
        if !start.matches_reconnect(previous, fixed) {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(profile) = fixed {
            return Ok(ssh::Reply::ReconnectFixedReceipt(
                ssh::ReconnectFixedReceipt {
                    request_id,
                    previous,
                    profile,
                    connection: connection.clone(),
                },
            ));
        }
        Ok(ssh::Reply::ReconnectReceipt(ssh::ReconnectReceipt {
            request_id,
            previous,
            connection: connection.clone(),
        }))
    }

    fn reconnect_duplicate(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        cols: u32,
        rows: u32,
        fixed: Option<ssh::FixedProfile>,
    ) -> Result<Option<ssh::Reply>, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::start_owner(&store, identity)?;
        match inner.requests.get(&id) {
            Some((old, _)) if old.owner != owner => Err(ErrorCode::PermissionDenied),
            Some((old, result))
                if old.matches_reconnect(connection, fixed)
                    && old.cols == cols
                    && old.rows == rows =>
            {
                Ok(Some(Self::reconnect_reply(
                    connection,
                    id,
                    fixed,
                    result.clone(),
                )))
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
        self.reconnect_from(identity, connection, id, cols, rows, None)
            .await
    }

    pub(super) async fn reconnect_fixed(
        &self,
        identity: &Identity,
        connection: ConnectionRef,
        profile: ssh::FixedProfile,
        id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<ssh::Reply, ErrorCode> {
        {
            let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            store.pairing.require_desktop(identity, store.now())?;
        }
        self.reconnect_from(Some(identity), connection, id, cols, rows, Some(profile))
            .await
    }

    fn reconnect_reply(
        previous: ConnectionRef,
        request_id: Uuid,
        fixed: Option<ssh::FixedProfile>,
        connection: ConnectionInfo,
    ) -> ssh::Reply {
        match fixed {
            Some(profile) => ssh::Reply::ReconnectFixedReceipt(ssh::ReconnectFixedReceipt {
                request_id,
                previous,
                profile,
                connection,
            }),
            None => ssh::Reply::Started { connection },
        }
    }

    async fn reconnect_from(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        cols: u32,
        rows: u32,
        fixed: Option<ssh::FixedProfile>,
    ) -> Result<ssh::Reply, ErrorCode> {
        if let Some(reply) =
            self.reconnect_duplicate(identity, connection, id, cols, rows, fixed)?
        {
            return Ok(reply);
        }
        let (gate, owner, restart, authority, profile_id, temporary) = {
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
            if !matches!(
                (info.protocol, fixed),
                (Protocol::Ssh2, None) | (Protocol::Ssh1, Some(_))
            ) || fixed.is_some() && !legacy::configured()
            {
                return Err(ErrorCode::Unsupported);
            }
            if !matches!(info.state, State::Disconnected | State::Failed) {
                return Err(ErrorCode::InvalidState);
            }
            let entry = inner
                .entries
                .get(&connection.connection_id)
                .ok_or(ErrorCode::NotFound)?;
            if fixed.is_some_and(|profile| {
                profile.profile_id != entry.profile_id || entry.temporary.is_some()
            }) {
                return Err(ErrorCode::InvalidArgument);
            }
            if owner.is_some() && entry.temporary.is_some() {
                return Err(ErrorCode::PermissionDenied);
            }
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
                entry.temporary.clone(),
            )
        };
        // Serialize only restarts of this connection; no session/configuration lock is held while awaiting cleanup.
        let _guard = gate.lock().await;
        if let Some(reply) =
            self.reconnect_duplicate(identity, connection, id, cols, rows, fixed)?
        {
            return Ok(reply);
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
        let query = fixed
            .map(|profile| profile.revision)
            .or_else(|| {
                authority
                    .as_ref()
                    .and_then(|(_, permit)| permit.profile_revision())
            })
            .map_or(Internal::Profile(profile_id), |revision| {
                Internal::ProfileRevision {
                    id: profile_id,
                    revision,
                }
            });
        let lookup = if let Some(profile) = &temporary {
            Ok(Value::Profile(profile.clone()))
        } else {
            self.config.request(query).await
        };
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
                    if matches!(
                        (fixed, &profile.settings),
                        (None, Settings::Ssh2 { .. })
                            | (
                                Some(_),
                                Settings::Ssh1 {
                                    explicitly_enabled: true,
                                    ..
                                }
                            )
                    ) => {}
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
            return if old.matches_reconnect(connection, fixed)
                && old.cols == cols
                && old.rows == rows
            {
                Ok(Self::reconnect_reply(connection, id, fixed, result.clone()))
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        Self::check_start(&mut store, identity, restart.as_ref(), false)?;
        Self::check_start(&mut store, identity, authority.as_ref(), false)?;
        let Value::Profile(profile) = lookup.map_err(|_| ErrorCode::InvalidArgument)? else {
            return Err(ErrorCode::InvalidState);
        };
        let host = match &profile.settings {
            Settings::Ssh1 { host, .. } | Settings::Ssh2 { host, .. } => host.clone(),
            _ => return Err(ErrorCode::Unsupported),
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
        let legacy_released = fixed.map(|_| Arc::new(AtomicBool::new(true)));
        inner.entries.insert(
            connection.connection_id,
            Entry {
                server_host: host,
                source_settings: (current.protocol == Protocol::Ssh2)
                    .then(|| profile.settings.clone()),
                temporary,
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
                transport: legacy_released.clone().map(TransportCleanup::Ssh1),
            },
        );
        inner.requests.insert(
            id,
            (
                Start {
                    temporary: None,
                    owner,
                    previous: Some(connection),
                    profile_id,
                    revision: fixed.map(|profile| profile.revision),
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
            let result = if let Some(released) = legacy_released {
                actor
                    .run_legacy(profile, cols, rows, id, identity_owned, released)
                    .await
            } else {
                actor
                    .run_as(profile, cols, rows, identity_owned, authority)
                    .await
            };
            actor.finish(result);
        });
        inner
            .entries
            .get_mut(&reference.connection_id)
            .unwrap()
            .task = Some(task);
        Ok(Self::reconnect_reply(connection, id, fixed, current))
    }
}
