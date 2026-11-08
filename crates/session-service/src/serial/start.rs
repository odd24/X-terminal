use super::*;
impl Manager {
    pub(super) async fn start_as(
        &self,
        identity: Option<&Identity>,
        profile_id: Uuid,
        request_id: Uuid,
        revision: Uuid,
        device_id: Uuid,
    ) -> Result<Reply, ErrorCode> {
        self.start_from(identity, profile_id, request_id, revision, device_id, None)
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
    ) -> Result<Reply, ErrorCode> {
        let (start, authority) = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            let owner = Self::owner(&store, identity)?;
            if temporary.is_some() && owner.is_some() {
                return Err(ErrorCode::PermissionDenied);
            }
            let spec = Start {
                temporary: temporary.clone(),
                owner,
                profile_id,
                revision,
                device_id,
            };
            if let Some(connection) = Self::duplicate(&inner, request_id, &spec)? {
                return Ok(Reply::Started { connection });
            }
            let now = store.now();
            let authority = if owner.is_some() {
                Some((
                    identity.unwrap().clone(),
                    store
                        .pairing
                        .admit_connect(identity.unwrap(), profile_id, request_id, now)?,
                ))
            } else {
                None
            };
            (spec, authority)
        };
        let query = authority
            .as_ref()
            .and_then(|(_, permit)| permit.profile_revision())
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
            return Ok(Reply::Started { connection });
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
            Arc::new(move || {
                let Ok(mut store) = store.lock() else {
                    return false;
                };
                let now = store.now();
                store
                    .pairing
                    .dispatch_input(&identity, &permit, now)
                    .is_ok()
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
        inner.starts.insert(request_id, (start, connection.clone()));
        Ok(Reply::Started { connection })
    }
}
