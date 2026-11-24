use super::{Input, Manager, QueuedInput};
use session_core::{
    access::{Action, Scope, Target},
    pairing::Identity,
    session::{ConnectionRef, ErrorCode, Protocol, State},
};
use session_protocol::ssh;
use tokio::sync::mpsc;
use uuid::Uuid;

impl Manager {
    pub(super) fn enqueue(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        input: Input,
    ) -> Result<ssh::Reply, ErrorCode> {
        self.enqueue_from(None, connection, id, input)
    }
    pub(super) fn enqueue_from(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        input: Input,
    ) -> Result<ssh::Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let now = store.now();
        let owner = match identity {
            Some(identity) if store.pairing.is_agent(identity, now)? => Some(identity.ticket_id()),
            Some(identity) => {
                store.pairing.require_desktop(identity, now)?;
                None
            }
            None => None,
        };
        let authority = if let Some(identity) = identity.filter(|_| owner.is_some()) {
            Some((
                identity.clone(),
                store.pairing.admit_input(
                    identity,
                    Scope {
                        target: Target::Connection { connection },
                        action: if matches!(&input, Input::Resize { .. }) {
                            Action::Control
                        } else {
                            Action::Write
                        },
                    },
                    id,
                    now,
                )?,
            ))
        } else {
            None
        };
        let info = store.sessions.info(connection)?;
        if owner.is_some()
            && (info.protocol == Protocol::Ssh1
                || (matches!(&input, Input::Resize { .. }) && info.protocol != Protocol::Ssh2))
        {
            return Err(ErrorCode::PermissionDenied);
        }
        if info.protocol == Protocol::Ssh1 {
            match &input {
                Input::Write(bytes) if bytes.expose().len() <= transport_ssh1::MAX_DATA => {}
                Input::Write(_) => return Err(ErrorCode::InvalidArgument),
                Input::Resize { .. } => {}
                _ => return Err(ErrorCode::Unsupported),
            }
        }
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        let fingerprint = input.fingerprint();
        if entry.exec.contains(id) {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(receipt) = entry.receipts.lookup_owned(owner, id, fingerprint)? {
            return Ok(ssh::Reply::Input(receipt));
        }
        entry.exec.check_available(id)?;
        if info.state != State::Connected {
            return Err(ErrorCode::NotConnected);
        }
        if entry.cancel.is_cancelled() || entry.challenge.is_some() || !*entry.writable.borrow() {
            return Err(ErrorCode::InvalidState);
        }
        if let Some(desktop) =
            identity.filter(|_| owner.is_none() && !matches!(&input, Input::Resize { .. }))
        {
            store.pairing.takeover(desktop, connection, now)?;
            entry.receipts.cancel_agent_pending();
            entry.exec.cancel_agent_pending();
        }
        let sender = entry
            .commands
            .as_ref()
            .ok_or(ErrorCode::NotConnected)?
            .clone();
        let permit = sender.try_reserve().map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
            _ => ErrorCode::NotConnected,
        })?;
        let receipt = entry.receipts.remember_owned(owner, id, fingerprint)?;
        permit.send(QueuedInput {
            authority,
            id,
            input,
        });
        Ok(ssh::Reply::Input(receipt))
    }
}
