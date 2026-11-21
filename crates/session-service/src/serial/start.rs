use super::*;

impl Start {
    fn target(&self, request_id: Uuid) -> Option<serial::ConnectTarget> {
        Some(serial::ConnectTarget {
            profile_id: self.profile_id,
            profile_revision: self.profile_revision?,
            inventory_revision: self.revision,
            device_id: self.device_id,
            request_id,
        })
    }

    fn reply(&self, request_id: Uuid, connection: ConnectionInfo) -> Reply {
        match self.target(request_id) {
            Some(target) => Reply::ConnectReceipt(serial::ConnectReceipt { target, connection }),
            None => Reply::Started { connection },
        }
    }
}

impl Manager {
    pub(super) fn connect_status(
        &self,
        identity: Option<&Identity>,
        target: serial::ConnectTarget,
    ) -> Result<Reply, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::owner(&store, identity)?.ok_or(ErrorCode::PermissionDenied)?;
        let Some((start, connection)) = inner.starts.get(&target.request_id) else {
            inner.window.check(target.request_id)?;
            return Err(ErrorCode::PermissionDenied);
        };
        if start.owner != Some(owner) || start.profile_revision.is_none() {
            return Err(ErrorCode::PermissionDenied);
        }
        if start.target(target.request_id) != Some(target) {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(start.reply(target.request_id, connection.clone()))
    }

    pub(super) async fn start_as(
        &self,
        identity: Option<&Identity>,
        profile_id: Uuid,
        request_id: Uuid,
        revision: Uuid,
        device_id: Uuid,
    ) -> Result<Reply, ErrorCode> {
        self.start_from(
            identity, profile_id, request_id, revision, device_id, None, None,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn start_from(
        &self,
        identity: Option<&Identity>,
        profile_id: Uuid,
        request_id: Uuid,
        revision: Uuid,
        device_id: Uuid,
        temporary: Option<config_store::Settings>,
        profile_revision: Option<Uuid>,
    ) -> Result<Reply, ErrorCode> {
        let (start, authority) = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            let owner = Self::owner(&store, identity)?;
            if temporary.is_some() && owner.is_some() {
                return Err(ErrorCode::PermissionDenied);
            }
            if profile_revision.is_some() {
                let agent = identity
                    .filter(|_| owner.is_some())
                    .ok_or(ErrorCode::PermissionDenied)?;
                if !matches!(
                    store.pairing.authorization_form(agent, store.now())?,
                    session_core::authorization::Form::SingleOperation { .. }
                ) {
                    return Err(ErrorCode::PermissionDenied);
                }
            }
            let spec = Start {
                temporary: temporary.clone(),
                owner,
                profile_id,
                profile_revision,
                revision,
                device_id,
            };
            if let Some(connection) = Self::duplicate(&inner, request_id, &spec)? {
                return Ok(spec.reply(request_id, connection));
            }
            let now = store.now();
            let authority = if let Some(identity) = identity.filter(|_| owner.is_some()) {
                let permit = if let Some(profile_revision) = profile_revision {
                    store.pairing.admit_input(
                        identity,
                        Scope {
                            target: Target::ProfileRevision {
                                profile_id,
                                revision: profile_revision,
                            },
                            action: Action::Connect,
                        },
                        request_id,
                        now,
                    )?
                } else {
                    store
                        .pairing
                        .admit_connect(identity, profile_id, request_id, now)?
                };
                Some((identity.clone(), permit))
            } else {
                None
            };
            (spec, authority)
        };
        let query = profile_revision
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
        let lookup = if let Some(settings) = temporary {
            Ok(Value::Profile(config_store::Profile {
                id: profile_id,
                folder_id: None,
                name: "Temporary serial".into(),
                settings,
                credential_ref: None,
            }))
        } else {
            self.config.request(query).await
        };
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        Self::owner(&store, identity)?;
        if let Some(connection) = Self::duplicate(&inner, request_id, &start)? {
            return Ok(start.reply(request_id, connection));
        }
        if let Some((identity, permit)) = &authority {
            store.pairing.check_input(identity, permit, store.now())?;
        }
        let Value::Profile(profile) = lookup.map_err(|_| ErrorCode::InvalidArgument)? else {
            return Err(ErrorCode::InvalidState);
        };
        let config = parameters(&profile.settings)?;
        let encoding = match &profile.settings {
            config_store::Settings::Serial { encoding, .. } => encoding.clone(),
            _ => unreachable!(),
        };
        let port = config.port.clone();
        let hardware_rts = config.flow_control == serialport::FlowControl::Hardware;
        if inner.revision != revision {
            return Err(ErrorCode::InvalidState);
        }
        let device = inner
            .devices
            .get(&device_id)
            .ok_or(ErrorCode::NotFound)?
            .clone();
        if device.port_name() != config.port {
            return Err(ErrorCode::InvalidArgument);
        }
        if inner
            .entries
            .values()
            .any(|entry| !entry.joined && (entry.port == config.port || entry.device == device))
        {
            return Err(ErrorCode::InvalidState);
        }
        if inner.entries.len() >= MAX_CONNECTIONS {
            return Err(ErrorCode::CapacityExceeded);
        }
        if inner.starts.len() >= 1024 {
            let (old, stamp) = inner
                .starts
                .iter()
                .filter(|(_, (_, result))| {
                    inner
                        .entries
                        .get(&result.connection_id)
                        .is_none_or(|entry| entry.joined)
                })
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            inner.window.retire(stamp);
            inner.starts.remove(&old);
            inner.window.check(request_id)?;
        }
        let initial = store.sessions.create(Protocol::Serial)?;
        let connection = store.sessions.begin_connect(initial.reference())?;
        store.sessions.configure_output(
            connection.reference(),
            crate::encoding_label(&encoding),
            24,
            80,
        )?;
        let dispatch: Option<worker::DispatchGuard> = authority.map(|(identity, permit)| {
            let store = self.store.clone();
            let inventory = profile_revision.map(|_| Arc::downgrade(&self.inner));
            Arc::new(move || {
                let current = inventory.as_ref().and_then(|inventory| inventory.upgrade());
                let guard = match &current {
                    Some(current) => match current.lock() {
                        Ok(guard)
                            if guard.revision == revision
                                && guard.devices.contains_key(&device_id) =>
                        {
                            Some(guard)
                        }
                        _ => return false,
                    },
                    None if inventory.is_some() => return false,
                    None => None,
                };
                let Ok(mut store) = store.lock() else {
                    return false;
                };
                let now = store.now();
                let allowed = store
                    .pairing
                    .dispatch_input(&identity, &permit, now)
                    .is_ok();
                drop(guard);
                allowed
            }) as worker::DispatchGuard
        });
        let worker = match self.factory.open(config, device.clone(), dispatch) {
            Ok(worker) => worker,
            Err(error) => {
                store
                    .sessions
                    .transition(connection.reference(), State::Failed)?;
                store.sessions.remove(connection.reference())?;
                return Err(if error.kind() == io::ErrorKind::WouldBlock {
                    ErrorCode::CapacityExceeded
                } else {
                    ErrorCode::InvalidState
                });
            }
        };
        inner.entries.insert(
            connection.connection_id,
            Entry {
                source_settings: profile.settings,
                hardware_rts,
                encoding,
                device,
                reference: connection.reference(),
                profile_id,
                port,
                worker: Some(worker),
                joining: None,
                joined: false,
                closing: false,
                status: worker::Status::default(),
                failure: None,
                inputs: HashMap::new(),
                tickets: HashMap::new(),
                window: RequestWindow::default(),
            },
        );
        let reply = start.reply(request_id, connection.clone());
        inner.starts.insert(request_id, (start, connection));
        Ok(reply)
    }
}
