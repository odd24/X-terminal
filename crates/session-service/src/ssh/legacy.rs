//! SSH1 runs in a separate matched executable. The service owns policy and receipts.
mod child;
use super::*;
use child::Managed;
use tokio::time::{Instant, sleep_until};
use transport_ssh1::{self as wire, Event, Request};

#[derive(Clone, Copy, PartialEq, Eq)]
enum LegacyAcceptance {
    Input(usize),
    Resize { cols: u16, rows: u16 },
}

pub(crate) fn configured() -> bool {
    child::image_pin().is_some()
}

fn end_failure(reason: wire::EndReason) -> Failure {
    match reason {
        wire::EndReason::HostDeclined => Failure::HostKeyRejected,
        wire::EndReason::AuthFailed => Failure::AuthenticationRejected,
        wire::EndReason::Timeout => Failure::TransportTimeout,
        _ => Failure::Transport,
    }
}

impl Actor {
    fn authorize_legacy(&self, identity: &Identity) -> Result<(), Failure> {
        let mut store = self.store.lock().map_err(|_| Failure::Transport)?;
        if self.cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        Manager::check_start(&mut store, Some(identity), None, true).map_err(|_| Failure::Cancelled)
    }

    pub(super) async fn run_legacy(
        &self,
        profile: Profile,
        cols: u32,
        rows: u32,
        start_id: Uuid,
        identity: Option<Identity>,
        released: Arc<AtomicBool>,
    ) -> Result<(), Failure> {
        let Settings::Ssh1 {
            host,
            port,
            username,
            explicitly_enabled: true,
            ..
        } = &profile.settings
        else {
            return Err(Failure::Configuration);
        };
        let identity = identity.ok_or(Failure::Configuration)?;
        let pin = child::image_pin().ok_or(Failure::Configuration)?;
        self.authorize_legacy(&identity)?;
        let mut helper = Managed::spawn(pin, &released)
            .await
            .map_err(|_| Failure::Configuration)?;
        let session = wire::Session {
            connection: self.reference,
            start_id,
        };
        let endpoint = wire::Endpoint {
            host: host.clone(),
            port: *port,
        };
        let result = async {
            self.authorize_legacy(&identity)?;
            helper
                .send(&Request::Start {
                    version: wire::VERSION,
                    protocol: wire::Protocol::Ssh1,
                    session,
                    endpoint: endpoint.clone(),
                    username: username.clone(),
                    cols: cols as u16,
                    rows: rows as u16,
                })
                .await
                .map_err(|_| Failure::Transport)?;
            self.legacy_handshake(&mut helper, session, endpoint, &profile, &identity)
                .await?;
            self.legacy_terminal(&mut helper, session).await
        }
        .await;
        if matches!(result, Err(Failure::Cancelled)) {
            // A timed-out write is never followed by another frame on that stream.
            let _ = timeout(
                Duration::from_millis(250),
                helper.send(&Request::Close { session }),
            )
            .await;
        }
        let reaped = helper.reap().await.map_err(|_| Failure::Transport)?;
        released.store(true, Ordering::Release);
        result?;
        if !reaped.success() {
            return Err(Failure::Transport);
        }
        self.transition(State::Closing)?;
        self.transition(State::Disconnected)
    }

    async fn legacy_event(
        &self,
        helper: &mut Managed,
        session: wire::Session,
    ) -> Result<Event, Failure> {
        let event = tokio::select! { biased;
            _=self.cancel.cancelled()=>return Err(Failure::Cancelled),
            event=timeout(Duration::from_secs(32),helper.events.recv())=>
                event.map_err(|_|Failure::TransportTimeout)?.ok_or(Failure::Transport)?,
        };
        match event {
            Event::Ended {
                session: original,
                reason,
                ..
            } if original == session => Err(end_failure(reason)),
            other => Ok(other),
        }
    }

    async fn legacy_approval<T>(
        &self,
        helper: &mut Managed,
        session: wire::Session,
        approval: impl std::future::Future<Output = Result<T, Failure>>,
    ) -> Result<T, Failure> {
        tokio::select! { biased;
            end=self.legacy_event(helper,session)=>match end {
                Err(Failure::TransportTimeout)=>Err(Failure::ApprovalTimeout),
                Err(error)=>Err(error),
                Ok(_)=>Err(Failure::Transport),
            },
            answer=approval=>answer,
        }
    }

    async fn legacy_handshake(
        &self,
        helper: &mut Managed,
        session: wire::Session,
        endpoint: wire::Endpoint,
        profile: &Profile,
        identity: &Identity,
    ) -> Result<(), Failure> {
        let Event::HostChallenge {
            challenge,
            endpoint: actual,
            algorithm,
            fingerprint,
            key,
        } = self.legacy_event(helper, session).await?
        else {
            return Err(Failure::Transport);
        };
        if actual != endpoint
            || challenge.session != session
            || challenge.id.is_nil()
            || challenge.kind != wire::ChallengeKind::HostTrust
            || algorithm != "rsa1"
            || !wire::valid_rsa1_key(&key)
            || fingerprint.len() > 64
            || fingerprint.is_empty()
        {
            return Err(Failure::Transport);
        }
        let review_endpoint = HostEndpoint {
            protocol: HostProtocol::Ssh1,
            host: endpoint.host,
            port: endpoint.port,
        };
        let host_key = HostKey {
            endpoint: review_endpoint,
            algorithm,
            key: key.into_bytes(),
        };
        let decision = self
            .legacy_approval(helper, session, self.host_key(host_key))
            .await;
        if let Err(Failure::HostKeyRejected) = decision {
            helper
                .send(&Request::HostAnswer {
                    challenge,
                    fingerprint,
                    approve: false,
                })
                .await
                .map_err(|_| Failure::Transport)?;
            return Err(Failure::HostKeyRejected);
        }
        decision?;
        helper
            .send(&Request::HostAnswer {
                challenge,
                fingerprint,
                approve: true,
            })
            .await
            .map_err(|_| Failure::Transport)?;

        let Event::PasswordChallenge {
            challenge: password,
        } = self.legacy_event(helper, session).await?
        else {
            return Err(Failure::Transport);
        };
        if password.session != session
            || password.kind != wire::ChallengeKind::Password
            || password.id.is_nil()
            || password.id == challenge.id
        {
            return Err(Failure::Transport);
        }
        self.transition(State::Authenticating)?;
        let answer = self
            .legacy_approval(
                helper,
                session,
                self.ask(Challenge::Credentials {
                    id: password.id,
                    auth: Auth::Password,
                    stored_available: profile.credential_ref.is_some(),
                }),
            )
            .await?;
        let value = match answer {
            Answer::Credentials {
                use_saved: false,
                password: Some(value),
            } => value,
            Answer::Credentials {
                use_saved: true,
                password: None,
            } => {
                self.legacy_approval(helper, session, async {
                    match self
                        .config
                        .request(Internal::Credential(profile.clone()))
                        .await
                    {
                        Ok(Value::Credential(bundle)) => {
                            bundle.password.ok_or(Failure::CredentialUnavailable)
                        }
                        Err(session_protocol::config::ConfigError::Conflict) => {
                            Err(Failure::CredentialConfigurationChanged)
                        }
                        _ => Err(Failure::CredentialUnavailable),
                    }
                })
                .await?
            }
            _ => return Err(Failure::CredentialUnavailable),
        };
        self.authorize_legacy(identity)?;
        let password_bytes =
            session_protocol::SensitiveBytes::new(value.expose().as_bytes().to_vec());
        drop(value);
        helper
            .send(&Request::PasswordAnswer {
                challenge: password,
                value: password_bytes,
            })
            .await
            .map_err(|_| Failure::Transport)?;
        match self.legacy_event(helper, session).await? {
            Event::Ready { session: original } if original == session => Ok(()),
            _ => Err(Failure::Transport),
        }
    }

    async fn legacy_terminal(
        &self,
        helper: &mut Managed,
        session: wire::Session,
    ) -> Result<(), Failure> {
        let (sender, mut commands) = mpsc::channel(16);
        {
            let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
            let entry = inner
                .entries
                .get_mut(&self.reference.connection_id)
                .filter(|entry| entry.reference == self.reference)
                .ok_or(Failure::Transport)?;
            if self.cancel.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            entry.commands = Some(sender);
            entry.writable.send_replace(true);
        }
        self.transition(State::Connected)?;
        let mut in_flight = None;
        loop {
            let deadline = in_flight.map_or_else(Instant::now, |(_, _, deadline)| deadline);
            tokio::select! { biased;
                _=self.cancel.cancelled()=>return Err(Failure::Cancelled),
                _=sleep_until(deadline),if in_flight.is_some()=> {
                    if let Some((id, _, _)) = in_flight {
                        self.legacy_receipt(id, Err(InputFailure::Timeout))?;
                    }
                    return Err(Failure::TransportTimeout);
                }
                event=helper.events.recv()=>match event.ok_or(Failure::Transport)? {
                    Event::Output { session: original, bytes, .. } if original == session
                        && !bytes.expose().is_empty() && bytes.expose().len() <= wire::MAX_DATA =>
                    {
                        let time = SystemTime::now().duration_since(UNIX_EPOCH)
                            .map_err(|_| Failure::Transport)?.as_millis() as u64;
                        self.store.lock().map_err(|_| Failure::Transport)?
                            .sessions.append(self.reference, bytes.expose(), time)
                            .map_err(|_| Failure::Transport)?;
                    }
                    Event::InputAccepted { session: original, request_id, bytes }
                        if original == session && in_flight.is_some_and(|(id, expected, _)|
                            request_id == id && expected == LegacyAcceptance::Input(bytes)) =>
                    {
                        self.legacy_receipt(request_id, Ok(Some(bytes)))?;
                        in_flight = None;
                    }
                    Event::ResizeAccepted { session: original, request_id, cols, rows }
                        if original == session && in_flight.is_some_and(|(id, expected, _)|
                            request_id == id && expected == (LegacyAcceptance::Resize { cols, rows })) =>
                    {
                        self.store.lock().map_err(|_| Failure::Transport)?
                            .sessions.resize_screen(self.reference, rows, cols)
                            .map_err(|_| Failure::Transport)?;
                        self.legacy_receipt(request_id, Ok(None))?;
                        in_flight = None;
                    }
                    Event::Ended { session: original, reason: wire::EndReason::BackendExit, .. } if original == session =>
                        return Ok(()),
                    Event::Ended { session: original, reason, .. } if original == session =>
                        return Err(end_failure(reason)),
                    _=>return Err(Failure::Transport),
                },
                command=commands.recv(), if in_flight.is_none()=>{
                    let QueuedInput { id, input, authority: None } =
                        command.ok_or(Failure::Cancelled)?
                    else { return Err(Failure::Transport) };
                    {
                        let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
                        let entry = inner.entries.get_mut(&self.reference.connection_id)
                            .filter(|entry| entry.reference == self.reference)
                            .ok_or(Failure::Transport)?;
                        if self.cancel.is_cancelled() {
                            return Err(Failure::Cancelled);
                        }
                        if !entry.receipts.dispatch(id) {
                            return Err(Failure::Transport);
                        }
                    }
                    let (request, expected) = match input {
                        Input::Write(bytes) => {
                            let expected = LegacyAcceptance::Input(bytes.expose().len());
                            (Request::Input { session, request_id: id, bytes }, expected)
                        }
                        Input::Resize { cols, rows } => {
                            let cols = cols as u16;
                            let rows = rows as u16;
                            (Request::Resize { session, request_id: id, cols, rows },
                                LegacyAcceptance::Resize { cols, rows })
                        }
                        _ => return Err(Failure::Transport),
                    };
                    helper.send(&request).await.map_err(|_| Failure::Transport)?;
                    in_flight = Some((id, expected, Instant::now() + Duration::from_secs(2)));
                }
            }
        }
    }

    fn legacy_receipt(
        &self,
        id: Uuid,
        result: Result<Option<usize>, InputFailure>,
    ) -> Result<(), Failure> {
        let mut inner = self.inner.lock().map_err(|_| Failure::Transport)?;
        let entry = inner
            .entries
            .get_mut(&self.reference.connection_id)
            .filter(|entry| entry.reference == self.reference)
            .ok_or(Failure::Transport)?;
        entry.receipts.complete(id, result);
        Ok(())
    }
}
