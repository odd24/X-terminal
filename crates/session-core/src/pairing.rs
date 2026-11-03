//! In-memory capability identity. Full Agent write policy belongs to P14.
use crate::session::{ConnectionRef, ErrorCode};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_TICKETS: usize = 128;
const MAX_READ_LIFETIME_MS: u64 = 30 * 60 * 1000;

/// Deliberately neither Debug nor Serialize; never log or send to a renderer.
pub struct SecretToken(Zeroizing<String>);
impl SecretToken {
    pub fn generate() -> Self {
        let bytes: [u8; 32] = rand::random();
        Self(Zeroizing::new(
            bytes.iter().map(|b| format!("{b:02x}")).collect(),
        ))
    }
    pub fn parse(text: String) -> Result<Self, ErrorCode> {
        let text = Zeroizing::new(text);
        if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ErrorCode::PermissionDenied);
        }
        Ok(Self(text))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.0.as_bytes()).into()
    }
}

#[derive(Debug, Clone)]
pub struct Identity {
    ticket_id: Uuid,
}
impl Identity {
    pub fn ticket_id(&self) -> Uuid {
        self.ticket_id
    }
}

enum Authority {
    Desktop,
    Observer(Vec<ConnectionRef>),
}
struct Ticket {
    identity: Identity,
    authority: Authority,
    expires_at_ms: u64,
}
pub struct Pairing {
    tickets: HashMap<[u8; 32], Ticket>,
}

impl Pairing {
    /// Bootstrap arrives over the parent process's anonymous pipe, not argv/env.
    pub fn new(bootstrap: &SecretToken) -> Self {
        let ticket = Ticket {
            identity: Identity {
                ticket_id: Uuid::new_v4(),
            },
            authority: Authority::Desktop,
            expires_at_ms: u64::MAX,
        };
        Self {
            tickets: HashMap::from([(bootstrap.digest(), ticket)]),
        }
    }
    pub fn authenticate(&self, token: &SecretToken, now_ms: u64) -> Result<Identity, ErrorCode> {
        let ticket = self
            .tickets
            .get(&token.digest())
            .ok_or(ErrorCode::PermissionDenied)?;
        if now_ms >= ticket.expires_at_ms {
            return Err(ErrorCode::PermissionDenied);
        }
        Ok(ticket.identity.clone())
    }
    fn ticket(&self, identity: &Identity, now_ms: u64) -> Result<&Ticket, ErrorCode> {
        let ticket = self
            .tickets
            .values()
            .find(|ticket| ticket.identity.ticket_id == identity.ticket_id)
            .ok_or(ErrorCode::PermissionDenied)?;
        if now_ms >= ticket.expires_at_ms {
            return Err(ErrorCode::PermissionDenied);
        }
        Ok(ticket)
    }
    pub fn require_desktop(&self, identity: &Identity, now_ms: u64) -> Result<(), ErrorCode> {
        if matches!(self.ticket(identity, now_ms)?.authority, Authority::Desktop) {
            Ok(())
        } else {
            Err(ErrorCode::PermissionDenied)
        }
    }
    pub fn require_active(&self, identity: &Identity, now_ms: u64) -> Result<(), ErrorCode> {
        self.ticket(identity, now_ms).map(|_| ())
    }
    pub fn can_read(
        &self,
        identity: &Identity,
        reference: ConnectionRef,
        now_ms: u64,
    ) -> Result<(), ErrorCode> {
        match &self.ticket(identity, now_ms)?.authority {
            Authority::Desktop => Ok(()),
            Authority::Observer(scopes) if scopes.contains(&reference) => Ok(()),
            _ => Err(ErrorCode::PermissionDenied),
        }
    }
    pub fn issue_read(
        &mut self,
        desktop: &Identity,
        scopes: Vec<ConnectionRef>,
        expires_at_ms: u64,
        now_ms: u64,
    ) -> Result<(Identity, SecretToken), ErrorCode> {
        self.require_desktop(desktop, now_ms)?;
        if scopes.is_empty()
            || scopes.len() > 64
            || scopes.iter().any(|scope| scope.generation == 0)
            || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
            || expires_at_ms <= now_ms
            || expires_at_ms
                > now_ms
                    .checked_add(MAX_READ_LIFETIME_MS)
                    .ok_or(ErrorCode::InvalidArgument)?
        {
            return Err(ErrorCode::InvalidArgument);
        }
        self.tickets
            .retain(|_, ticket| ticket.expires_at_ms > now_ms);
        if self.tickets.len() >= MAX_TICKETS {
            return Err(ErrorCode::CapacityExceeded);
        }
        let token = SecretToken::generate();
        let identity = Identity {
            ticket_id: Uuid::new_v4(),
        };
        self.tickets.insert(
            token.digest(),
            Ticket {
                identity: identity.clone(),
                authority: Authority::Observer(scopes),
                expires_at_ms,
            },
        );
        Ok((identity, token))
    }
    pub fn revoke(
        &mut self,
        desktop: &Identity,
        ticket_id: Uuid,
        now_ms: u64,
    ) -> Result<(), ErrorCode> {
        self.require_desktop(desktop, now_ms)?;
        // Revoke observers only: a client cannot revoke the runtime's UI bootstrap.
        let key = self
            .tickets
            .iter()
            .find(|(_, ticket)| {
                ticket.identity.ticket_id == ticket_id
                    && matches!(ticket.authority, Authority::Observer(_))
            })
            .map(|(key, _)| *key)
            .ok_or(ErrorCode::NotFound)?;
        self.tickets.remove(&key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ConnectionId;
    #[test]
    fn unknown_identity_and_self_promotion_fail() {
        let bootstrap = SecretToken::generate();
        let mut pairing = Pairing::new(&bootstrap);
        assert!(matches!(
            pairing.authenticate(&SecretToken::generate(), 0),
            Err(ErrorCode::PermissionDenied)
        ));
        let desktop = pairing.authenticate(&bootstrap, 0).unwrap();
        let scope = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let (observer, _) = pairing.issue_read(&desktop, vec![scope], 100, 0).unwrap();
        assert_eq!(
            pairing.require_desktop(&observer, 0),
            Err(ErrorCode::PermissionDenied)
        );
        assert!(matches!(
            pairing.issue_read(&observer, vec![scope], 100, 0),
            Err(ErrorCode::PermissionDenied)
        ));
        assert!(SecretToken::parse("not-a-ticket".into()).is_err());
    }
    #[test]
    fn grants_are_exact_generation_scoped_expiring_and_revocable() {
        let bootstrap = SecretToken::generate();
        let mut pairing = Pairing::new(&bootstrap);
        let desktop = pairing.authenticate(&bootstrap, 0).unwrap();
        let scope = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let (observer, token) = pairing.issue_read(&desktop, vec![scope], 100, 0).unwrap();
        assert!(pairing.authenticate(&token, 1).is_ok());
        assert!(pairing.can_read(&observer, scope, 99).is_ok());
        assert_eq!(
            pairing.can_read(
                &observer,
                ConnectionRef {
                    generation: 2,
                    ..scope
                },
                1
            ),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            pairing.can_read(
                &observer,
                ConnectionRef {
                    connection_id: ConnectionId(Uuid::new_v4()),
                    ..scope
                },
                1
            ),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            pairing.can_read(&observer, scope, 100),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            pairing.require_active(&observer, 100),
            Err(ErrorCode::PermissionDenied)
        );
        pairing.revoke(&desktop, observer.ticket_id(), 1).unwrap();
        assert!(pairing.authenticate(&token, 1).is_err());
        assert!(pairing.can_read(&observer, scope, 1).is_err());
        assert!(pairing.require_active(&observer, 1).is_err());
        assert!(pairing.revoke(&desktop, desktop.ticket_id(), 1).is_err());
    }
    #[test]
    fn scope_and_ticket_lifetime_limits_fail_before_insertion() {
        let bootstrap = SecretToken::generate();
        let mut pairing = Pairing::new(&bootstrap);
        let desktop = pairing.authenticate(&bootstrap, 0).unwrap();
        let scope = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        assert!(pairing.issue_read(&desktop, vec![], 10, 0).is_err());
        assert!(
            pairing
                .issue_read(&desktop, vec![scope, scope], 10, 0)
                .is_err()
        );
        assert!(pairing.issue_read(&desktop, vec![scope], 0, 0).is_err());
        assert!(
            pairing
                .issue_read(&desktop, vec![scope], MAX_READ_LIFETIME_MS + 1, 0)
                .is_err()
        );
        for _ in 1..MAX_TICKETS {
            pairing.issue_read(&desktop, vec![scope], 10, 0).unwrap();
        }
        assert!(matches!(
            pairing.issue_read(&desktop, vec![scope], 10, 0),
            Err(ErrorCode::CapacityExceeded)
        ));
        assert!(pairing.issue_read(&desktop, vec![scope], 20, 10).is_ok());
    }
}
