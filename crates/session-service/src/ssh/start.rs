use super::*;
impl Manager {
    fn start_owner(store: &Store, identity: Option<&Identity>) -> Result<Option<Uuid>, ErrorCode> {
        let Some(identity) = identity else {
            return Ok(None);
        };
        let now = store.now();
        if store.pairing.is_agent(identity, now)? {
            Ok(Some(identity.ticket_id()))
        } else {
            store.pairing.require_desktop(identity, now)?;
            Ok(None)
        }
    }
    pub(super) fn check_start(
        store: &mut Store,
        identity: Option<&Identity>,
        authority: Option<&(Identity, Permit)>,
        dispatch: bool,
    ) -> Result<(), ErrorCode> {
        let now = store.now();
        if let Some((identity, permit)) = authority {
            if dispatch {
                store.pairing.dispatch_input(identity, permit, now)
            } else {
                store.pairing.check_input(identity, permit, now)
            }
        } else if let Some(identity) = identity {
            store.pairing.require_desktop(identity, now)
        } else {
            Ok(())
        }
    }
    pub(super) async fn start_as(
        &self,
        identity: Option<&Identity>,
        profile_id: Uuid,
        request_id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<ssh::Reply, ErrorCode> {
        let (owner, authority) = {
            let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
            let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            let now = store.now();
            let owner = Self::start_owner(&store, identity)?;
            let start = Start {
                owner,
                previous: None,
                profile_id,
                cols,
                rows,
            };
            // A retained receipt is a query, even after profile removal; never re-admit.
            if let Some((old, connection)) = inner.requests.get(&request_id) {
                if old.owner != owner {
                    return Err(ErrorCode::PermissionDenied);
                }
                if *old != start {
                    return Err(ErrorCode::InvalidArgument);
                }
                let connection = connection.clone();
                return Ok(ssh::Reply::Started { connection });
            }
            inner.request_window.check(request_id)?;
            let authority = match (identity, owner) {
                (Some(identity), Some(_)) => Some((
                    identity.clone(),
                    store.pairing.admit_input(
                        identity,
                        Scope {
                            target: Target::Profile { profile_id },
                            action: Action::Connect,
                        },
                        request_id,
                        now,
                    )?,
                )),
                _ => None,
            };
            (owner, authority)
        };
        let start = Start {
            owner,
            previous: None,
            profile_id,
            cols,
            rows,
        };
        let lookup = self.config.request(Internal::Profile(profile_id)).await;
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        Self::start_owner(&store, identity)?;
        // Concurrent same-owner completion wins even if lookup now fails (e.g. deletion).
        if let Some((previous, connection)) = inner.requests.get(&request_id) {
            if previous.owner != owner {
                return Err(ErrorCode::PermissionDenied);
            }
            return if *previous == start {
                Ok(ssh::Reply::Started {
                    connection: connection.clone(),
                })
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        Self::check_start(&mut store, identity, authority.as_ref(), false)?;
        let Value::Profile(profile) = lookup.map_err(|_| ErrorCode::InvalidArgument)? else {
            return Err(ErrorCode::InvalidState);
        };
        if !matches!(profile.settings, Settings::Ssh2 { .. }) {
            return Err(ErrorCode::Unsupported);
        }
        if inner.entries.len() >= MAX_CONNECTIONS {
            return Err(ErrorCode::CapacityExceeded);
        }
        inner.reserve_start(request_id)?;
        let initial = store.sessions.create(Protocol::Ssh2)?;
        let connection = store.sessions.begin_connect(initial.reference())?;
        configure_output(
            &mut store.sessions,
            connection.reference(),
            &profile,
            rows,
            cols,
        )?;
        let cancel = Cancellation::default();
        inner.entries.insert(
            connection.connection_id,
            Entry {
                reference: connection.reference(),
                restart_gate: Arc::new(tokio::sync::Mutex::new(())),
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
        inner
            .requests
            .insert(request_id, (start, connection.clone()));
        let actor = Actor {
            inner: self.inner.clone(),
            store: self.store.clone(),
            config: self.config.clone(),
            reference: connection.reference(),
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
            .get_mut(&connection.connection_id)
            .unwrap()
            .task = Some(task);
        Ok(ssh::Reply::Started { connection })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::pairing::{Pairing, SecretToken};

    fn setup(profile_id: Uuid, lifetime: u64) -> (Arc<Mutex<Store>>, Identity, Identity) {
        let store = Store::test_store();
        let token = SecretToken::generate();
        let mut locked = store.lock().unwrap();
        locked.pairing = Pairing::new(&token);
        let now = locked.now();
        let desktop = locked.pairing.authenticate(&token, now).unwrap();
        let (agent, _, _) = locked
            .pairing
            .issue_agent(
                &desktop,
                vec![Scope {
                    target: Target::Profile { profile_id },
                    action: Action::Connect,
                }],
                lifetime,
                now,
            )
            .unwrap();
        drop(locked);
        (store, desktop, agent)
    }
    fn profile(id: Uuid, port: u16) -> Profile {
        Profile {
            id,
            folder_id: None,
            name: "synthetic delayed lookup".into(),
            credential_ref: None,
            settings: Settings::Ssh2 {
                host: "127.0.0.1".into(),
                port,
                username: "synthetic".into(),
                auth: Auth::Password,
                encoding: config_store::Encoding::Utf8,
            },
        }
    }
    #[tokio::test]
    async fn delayed_profile_revalidates_revocation_and_expiry_before_creating_any_connection() {
        for expire in [false, true] {
            let id = Uuid::new_v4();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (store, desktop, agent) = setup(id, if expire { 100 } else { 30000 });
            let (config, query) = Access::held_profile();
            let manager = Arc::new(Manager::new(store.clone(), config));
            let cloned = manager.clone();
            let ticket = agent.ticket_id();
            let pending = tokio::spawn(async move {
                cloned
                    .start_as(Some(&agent), id, Uuid::new_v4(), 80, 24)
                    .await
            });
            let response = query.await; // confirmed lookup is actually waiting, no timing guess
            if expire {
                tokio::time::sleep(Duration::from_millis(150)).await;
            } else {
                let mut s = store.lock().unwrap();
                let now = s.now();
                s.pairing.revoke(&desktop, ticket, now).unwrap();
            }
            response
                .send(Ok(Value::Profile(profile(
                    id,
                    listener.local_addr().unwrap().port(),
                ))))
                .ok()
                .unwrap();
            assert!(matches!(
                pending.await.unwrap(),
                Err(ErrorCode::PermissionDenied)
            ));
            assert!(manager.inner.lock().unwrap().entries.is_empty());
            assert!(manager.inner.lock().unwrap().requests.is_empty());
            assert!(
                timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
            Arc::try_unwrap(manager).ok().unwrap().close().await;
        }
    }
    #[tokio::test]
    async fn revocation_between_start_receipt_and_actor_first_poll_never_opens_socket() {
        let id = Uuid::new_v4();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (store, desktop, agent) = setup(id, 30000);
        let (config, query) = Access::held_profile();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            query
                .await
                .send(Ok(Value::Profile(profile(id, port))))
                .ok()
                .unwrap();
        });
        let manager = Manager::new(store.clone(), config);
        let result = manager
            .start_as(Some(&agent), id, Uuid::new_v4(), 80, 24)
            .await
            .unwrap();
        let ssh::Reply::Started { connection } = result else {
            panic!()
        };
        {
            let mut s = store.lock().unwrap();
            let now = s.now();
            s.pairing.revoke(&desktop, agent.ticket_id(), now).unwrap();
        }
        // Current-thread runtime has not yielded since Start returned; actor cannot have polled.
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );
        {
            let inner = manager.inner.lock().unwrap();
            let entry = &inner.entries[&connection.connection_id];
            assert_eq!(entry.failure, Some(Failure::Cancelled));
        }
        manager.close().await;
    }
}
