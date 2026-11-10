//! In-memory capability identities. Transport dispatch must separately enforce P14 permits.
use crate::access::{self, Action, Denial, Policy, Scope, Target};
use crate::session::{ConnectionRef, ErrorCode};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
use zeroize::Zeroizing;
pub mod grants;
pub mod protection;

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

#[derive(Clone)]
pub struct Identity {
    ticket_id: Uuid,
    operation: Option<std::sync::Arc<crate::authorization::OperationProof>>,
}
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("ticket_id", &self.ticket_id)
            .finish()
    }
}
impl Identity {
    pub fn ticket_id(&self) -> Uuid {
        self.ticket_id
    }
}

enum Authority {
    Desktop,
    Observer(Vec<ConnectionRef>),
    Agent,
}
struct Ticket {
    identity: Identity,
    authority: Authority,
    expires_at_ms: u64,
    protection: Option<std::sync::Arc<protection::ProtectedPolicy>>,
}
pub struct Pairing {
    tickets: HashMap<[u8; 32], Ticket>,
    policy: Policy,
    grants: grants::Ledger,
}

impl Pairing {
    pub fn set_audit_sink(&mut self, sink: std::sync::Arc<dyn access::AuditSink>) {
        self.policy.set_audit_sink(sink);
    }
    /// Bootstrap arrives over the parent process's anonymous pipe, not argv/env.
    pub fn new(bootstrap: &SecretToken) -> Self {
        let ticket = Ticket {
            identity: Identity {
                ticket_id: Uuid::new_v4(),
                operation: None,
            },
            authority: Authority::Desktop,
            expires_at_ms: u64::MAX,
            protection: None,
        };
        Self {
            tickets: HashMap::from([(bootstrap.digest(), ticket)]),
            policy: Policy::default(),
            grants: grants::Ledger::default(),
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
            Authority::Agent => self
                .policy
                .authorize(
                    identity.ticket_id,
                    Scope {
                        target: Target::Connection {
                            connection: reference,
                        },
                        action: Action::Read,
                    },
                    now_ms,
                )
                .map_err(policy_error),
            _ => Err(ErrorCode::PermissionDenied),
        }
    }
    /// Metadata discovery only; never use this in place of body authorization.
    pub fn can_observe(
        &self,
        identity: &Identity,
        reference: ConnectionRef,
        now: u64,
    ) -> Result<(), ErrorCode> {
        if self.can_read(identity, reference, now).is_ok() {
            return Ok(());
        }
        if self.is_agent(identity, now)?
            && self
                .policy
                .effective_scopes(identity.ticket_id, now)
                .iter()
                .any(|scope| {
                    scope.action == Action::Read && scope.target.connection() == Some(reference)
                })
        {
            Ok(())
        } else {
            Err(ErrorCode::PermissionDenied)
        }
    }
    pub fn can_read_context(
        &self,
        identity: &Identity,
        reference: ConnectionRef,
        window: crate::context::TimeWindow,
        now: u64,
    ) -> Result<(), ErrorCode> {
        if !window.valid() {
            return Err(ErrorCode::InvalidArgument);
        }
        match self.can_read(identity, reference, now) {
            Ok(()) => return Ok(()),
            Err(ErrorCode::PermissionDenied) => (),
            // A failed recorder is not a missing full-Read scope. Never allow
            // the window fallback to bypass that independent health boundary.
            Err(error) => return Err(error),
        }
        if self.is_agent(identity, now)? && self.policy.effective_scopes(identity.ticket_id, now).iter().any(|scope| {
            matches!(scope.target, Target::OutputWindow { connection, window: approved } if connection == reference && approved.contains(window)) && scope.action == Action::Read
        }) { Ok(()) } else { Err(ErrorCode::PermissionDenied) }
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
            operation: None,
        };
        self.tickets.insert(
            token.digest(),
            Ticket {
                identity: identity.clone(),
                authority: Authority::Observer(scopes),
                expires_at_ms,
                protection: None,
            },
        );
        Ok((identity, token))
    }
    pub fn is_agent(&self, identity: &Identity, now: u64) -> Result<bool, ErrorCode> {
        Ok(matches!(
            self.ticket(identity, now)?.authority,
            Authority::Agent
        ))
    }
    pub fn issue_agent(
        &mut self,
        desktop: &Identity,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<(Identity, SecretToken, u64), ErrorCode> {
        self.issue_agent_form(
            desktop,
            scopes,
            crate::authorization::Form::Scoped,
            lifetime_ms,
            now,
        )
    }
    pub fn issue_agent_form(
        &mut self,
        desktop: &Identity,
        scopes: Vec<Scope>,
        form: crate::authorization::Form,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<(Identity, SecretToken, u64), ErrorCode> {
        self.issue_agent_definition(
            desktop,
            protection::Definition {
                scopes,
                form,
                redaction: None,
            },
            lifetime_ms,
            now,
        )
    }
    /// Service-only binding: compute this key from the ACTUAL strict request,
    /// never from a client-reported hash. The authenticated wire identity is unbound.
    pub fn bind_operation(
        &self,
        identity: &Identity,
        operation: crate::authorization::OperationKey,
        now: u64,
    ) -> Result<Identity, ErrorCode> {
        self.require_agent(identity, now)?;
        if operation.request_id.is_nil() {
            return Err(ErrorCode::InvalidArgument);
        }
        let mut bound = identity.clone();
        bound.operation = self
            .policy
            .bind_operation(identity.ticket_id, operation, now)
            .map_err(policy_error)?
            .map(std::sync::Arc::new);
        Ok(bound)
    }
    pub fn authorization_form(
        &self,
        identity: &Identity,
        now: u64,
    ) -> Result<crate::authorization::Form, ErrorCode> {
        self.require_agent(identity, now)?;
        self.policy
            .form(identity.ticket_id, now)
            .map_err(policy_error)
    }
    pub fn require_agent(&self, identity: &Identity, now: u64) -> Result<(), ErrorCode> {
        if self.is_agent(identity, now)? {
            Ok(())
        } else {
            Err(ErrorCode::PermissionDenied)
        }
    }
    /// Choose the exact approved configuration revision before asynchronous lookup.
    /// Legacy Profile grants remain ID-only; a revision grant never falls back to one.
    pub fn admit_connect(
        &mut self,
        identity: &Identity,
        profile_id: Uuid,
        request_id: Uuid,
        now: u64,
    ) -> Result<access::Permit, ErrorCode> {
        self.require_agent(identity, now)?;
        let scopes = self.policy.effective_scopes(identity.ticket_id, now);
        let bound: Vec<_> = scopes
            .iter()
            .filter(|s| {
                matches!(s.target,
            Target::ProfileRevision { profile_id: id, .. } if id == profile_id)
            })
            .copied()
            .collect();
        // Multiple revisions are ambiguous: do not choose an arbitrary configuration.
        if bound.len() > 1 {
            return Err(ErrorCode::InvalidArgument);
        }
        let scope = bound.first().copied().unwrap_or(Scope {
            target: Target::Profile { profile_id },
            action: Action::Connect,
        });
        self.admit_input(identity, scope, request_id, now)
    }
    /// Capture the current lease in an opaque queue permit; callers cannot supply an owner.
    pub fn admit_input(
        &mut self,
        identity: &Identity,
        scope: Scope,
        request_id: Uuid,
        now: u64,
    ) -> Result<access::Permit, ErrorCode> {
        self.require_agent(identity, now)?;
        if scope.action == Action::Export {
            return Err(ErrorCode::InvalidArgument);
        }
        let lease = match scope.target {
            Target::Connection { connection } => self
                .policy
                .lease(connection, now)
                .map(|lease| lease.lease_id),
            Target::Profile { .. }
            | Target::ProfileRevision { .. }
            | Target::OutputWindow { .. } => None,
        };
        self.policy
            .admit_bound(
                identity.ticket_id,
                scope,
                lease,
                request_id,
                identity.operation.as_deref().copied(),
                now,
            )
            .map_err(policy_error)
    }
    pub fn admit_export(
        &mut self,
        identity: &Identity,
        connection: ConnectionRef,
        operation: crate::authorization::OperationKey,
        now: u64,
    ) -> Result<access::Permit, ErrorCode> {
        self.require_agent(identity, now)?;
        if self.output_protection(identity, now)?.is_none() {
            return Err(ErrorCode::PermissionDenied);
        }
        let bound = self.bind_operation(identity, operation, now)?;
        self.policy
            .admit_bound(
                identity.ticket_id,
                Scope {
                    target: Target::Connection { connection },
                    action: Action::Export,
                },
                None,
                operation.request_id,
                bound.operation.as_deref().copied(),
                now,
            )
            .map_err(policy_error)
    }
    /// Must share the service lock with the final scheduler decision, after all waits.
    pub fn dispatch_input(
        &mut self,
        identity: &Identity,
        permit: &access::Permit,
        now: u64,
    ) -> Result<(), ErrorCode> {
        self.require_agent(identity, now)?;
        self.policy
            .dispatch_for(identity.ticket_id, permit, now)
            .map_err(policy_error)
    }
    pub fn check_input(
        &self,
        identity: &Identity,
        permit: &access::Permit,
        now: u64,
    ) -> Result<(), ErrorCode> {
        self.require_agent(identity, now)?;
        self.policy
            .check_for(identity.ticket_id, permit, now)
            .map_err(policy_error)
    }
    pub fn check_action(
        &self,
        identity: &Identity,
        scope: Scope,
        now: u64,
    ) -> Result<(), ErrorCode> {
        self.require_agent(identity, now)?;
        self.policy
            .authorize(identity.ticket_id, scope, now)
            .map_err(policy_error)?;
        if let Target::Connection { connection } = scope.target
            && !self
                .policy
                .lease(connection, now)
                .is_some_and(|lease| lease.client_id == identity.ticket_id)
        {
            return Err(ErrorCode::InputBusy);
        }
        Ok(())
    }
    pub fn acquire_lease(
        &mut self,
        identity: &Identity,
        connection: ConnectionRef,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<access::Lease, ErrorCode> {
        self.require_agent(identity, now)?;
        self.policy
            .acquire(identity.ticket_id, connection, lifetime_ms, now)
            .map_err(policy_error)
    }
    pub fn can_acquire(
        &self,
        identity: &Identity,
        connection: ConnectionRef,
        now: u64,
    ) -> Result<(), ErrorCode> {
        self.require_agent(identity, now)?;
        if [
            Action::Write,
            Action::Exec,
            Action::Control,
            Action::Disconnect,
            Action::Reconnect,
            Action::Forget,
            Action::Broadcast,
        ]
        .into_iter()
        .any(|action| {
            self.policy
                .authorize(
                    identity.ticket_id,
                    Scope {
                        target: Target::Connection { connection },
                        action,
                    },
                    now,
                )
                .is_ok()
        }) {
            Ok(())
        } else {
            Err(ErrorCode::PermissionDenied)
        }
    }
    pub fn release_lease(
        &mut self,
        identity: &Identity,
        connection: ConnectionRef,
        lease_id: Uuid,
        now: u64,
    ) -> Result<(), ErrorCode> {
        self.require_agent(identity, now)?;
        self.policy
            .release(identity.ticket_id, connection, lease_id, now)
            .map_err(policy_error)
    }
    pub fn lease(
        &self,
        identity: &Identity,
        connection: ConnectionRef,
        now: u64,
    ) -> Result<Option<access::Lease>, ErrorCode> {
        self.require_active(identity, now)?;
        if self.require_desktop(identity, now).is_ok() {
            return Ok(self.policy.lease(connection, now));
        }
        self.require_agent(identity, now)?;
        // A caller may inspect only its own ownership; no scope or other owner is disclosed.
        Ok(self
            .policy
            .lease(connection, now)
            .filter(|l| l.client_id == identity.ticket_id))
    }
    pub fn takeover(
        &mut self,
        desktop: &Identity,
        connection: ConnectionRef,
        now: u64,
    ) -> Result<(), ErrorCode> {
        self.require_desktop(desktop, now)?;
        self.policy.takeover(connection, now);
        Ok(())
    }
    /// Service lifecycle hook; not an Agent RPC.
    pub fn retire_connection(&mut self, connection: ConnectionRef, now: u64) {
        self.policy.retire(connection, now);
    }
    pub fn audit(
        &self,
        desktop: &Identity,
        cursor: u64,
        limit: usize,
        now: u64,
    ) -> Result<access::AuditPage, ErrorCode> {
        self.require_desktop(desktop, now)?;
        self.policy.audit(cursor, limit).map_err(policy_error)
    }
    pub fn revoke(
        &mut self,
        desktop: &Identity,
        ticket_id: Uuid,
        now_ms: u64,
    ) -> Result<(), ErrorCode> {
        self.require_desktop(desktop, now_ms)?;
        // Never revoke the runtime's UI bootstrap.
        let key = self
            .tickets
            .iter()
            .find(|(_, ticket)| {
                ticket.identity.ticket_id == ticket_id
                    && !matches!(ticket.authority, Authority::Desktop)
            })
            .map(|(key, _)| *key)
            .ok_or(ErrorCode::NotFound)?;
        self.tickets.remove(&key);
        self.grants.clear_token(ticket_id);
        self.policy.revoke(ticket_id, now_ms);
        Ok(())
    }
}

pub fn policy_error(error: Denial) -> ErrorCode {
    match error {
        Denial::InvalidArgument => ErrorCode::InvalidArgument,
        Denial::PermissionDenied => ErrorCode::PermissionDenied,
        Denial::InputBusy => ErrorCode::InputBusy,
        Denial::CapacityExceeded => ErrorCode::CapacityExceeded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ConnectionId;
    #[test]
    fn agent_tickets_cannot_issue_authority_and_revocation_releases_ownership() {
        let bootstrap = SecretToken::generate();
        let mut p = Pairing::new(&bootstrap);
        let desktop = p.authenticate(&bootstrap, 0).unwrap();
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let scopes = vec![
            Scope {
                target: Target::Connection { connection },
                action: Action::Read,
            },
            Scope {
                target: Target::Connection { connection },
                action: Action::Write,
            },
        ];
        let (agent, token, expires) = p.issue_agent(&desktop, scopes.clone(), 1000, 0).unwrap();
        assert_eq!(expires, 1000);
        assert_eq!(
            p.authenticate(&token, 1).unwrap().ticket_id(),
            agent.ticket_id()
        );
        assert_eq!(
            p.require_desktop(&agent, 1),
            Err(ErrorCode::PermissionDenied)
        );
        assert!(matches!(
            p.issue_agent(&agent, scopes, 100, 1),
            Err(ErrorCode::PermissionDenied)
        ));
        assert!(matches!(
            p.issue_read(&agent, vec![connection], 100, 1),
            Err(ErrorCode::PermissionDenied)
        ));
        p.acquire_lease(&agent, connection, 100, 1).unwrap();
        assert!(p.lease(&desktop, connection, 2).unwrap().is_some());
        p.revoke(&desktop, agent.ticket_id(), 2).unwrap();
        assert!(p.authenticate(&token, 3).is_err());
        assert_eq!(
            p.can_read(&agent, connection, 3),
            Err(ErrorCode::PermissionDenied)
        );
        assert!(p.lease(&desktop, connection, 3).unwrap().is_none());
        assert!(p.revoke(&desktop, desktop.ticket_id(), 3).is_err());
    }
    #[test]
    fn reconnect_scope_can_acquire_its_own_old_generation_lease_only() {
        let bootstrap = SecretToken::generate();
        let mut pairing = Pairing::new(&bootstrap);
        let desktop = pairing.authenticate(&bootstrap, 0).unwrap();
        let old = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 7,
        };
        let (agent, _, _) = pairing
            .issue_agent(
                &desktop,
                vec![Scope {
                    target: Target::Connection { connection: old },
                    action: Action::Reconnect,
                }],
                10_000,
                0,
            )
            .unwrap();

        assert_eq!(pairing.can_acquire(&agent, old, 1), Ok(()));
        let lease = pairing.acquire_lease(&agent, old, 1000, 1).unwrap();
        assert_eq!(lease.connection, old);
        assert!(
            pairing
                .lease(
                    &agent,
                    ConnectionRef {
                        generation: 8,
                        ..old
                    },
                    2
                )
                .unwrap()
                .is_none()
        );
        assert_eq!(
            pairing.can_read(&agent, old, 2),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            pairing.check_action(
                &agent,
                Scope {
                    target: Target::Connection { connection: old },
                    action: Action::Write,
                },
                2,
            ),
            Err(ErrorCode::PermissionDenied)
        );
    }
    #[test]
    fn agent_expiry_and_retired_generation_are_not_renewed_by_active_connections() {
        let bootstrap = SecretToken::generate();
        let mut p = Pairing::new(&bootstrap);
        let desktop = p.authenticate(&bootstrap, 0).unwrap();
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let (agent, token, _) = p
            .issue_agent(
                &desktop,
                vec![Scope {
                    target: Target::Connection { connection },
                    action: Action::Read,
                }],
                100,
                0,
            )
            .unwrap();
        assert_eq!(p.can_read(&agent, connection, 99), Ok(()));
        assert!(p.authenticate(&token, 100).is_err());
        assert_eq!(
            p.can_read(&agent, connection, 100),
            Err(ErrorCode::PermissionDenied)
        );
        p.retire_connection(connection, 50);
        assert_eq!(
            p.can_read(&agent, connection, 51),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            p.can_read(
                &agent,
                ConnectionRef {
                    generation: 2,
                    ..connection
                },
                51
            ),
            Err(ErrorCode::PermissionDenied)
        );
    }
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
    #[test]
    fn queued_identity_permits_do_not_cross_clients_or_survive_lease_and_ticket_changes() {
        let bootstrap = SecretToken::generate();
        let mut pairing = Pairing::new(&bootstrap);
        let desktop = pairing.authenticate(&bootstrap, 0).unwrap();
        let connection = ConnectionRef {
            connection_id: crate::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let scope = Scope {
            target: Target::Connection { connection },
            action: Action::Write,
        };
        let (alice, _, _) = pairing.issue_agent(&desktop, vec![scope], 1000, 0).unwrap();
        let (bob, _, _) = pairing.issue_agent(&desktop, vec![scope], 1000, 0).unwrap();
        assert_eq!(
            pairing.check_action(&alice, scope, 1),
            Err(ErrorCode::InputBusy)
        );
        let lease = pairing.acquire_lease(&alice, connection, 100, 1).unwrap();
        let permit = pairing
            .admit_input(&alice, scope, Uuid::new_v4(), 2)
            .unwrap();
        assert_eq!(
            pairing.dispatch_input(&bob, &permit, 3),
            Err(ErrorCode::PermissionDenied)
        );
        pairing.dispatch_input(&alice, &permit, 3).unwrap();
        pairing
            .release_lease(&alice, connection, lease.lease_id, 4)
            .unwrap();
        pairing.acquire_lease(&alice, connection, 100, 5).unwrap();
        assert_eq!(
            pairing.check_input(&alice, &permit, 6),
            Err(ErrorCode::InputBusy)
        );
        let next = pairing
            .admit_input(&alice, scope, Uuid::new_v4(), 7)
            .unwrap();
        assert_eq!(
            pairing.check_input(&alice, &next, 105),
            Err(ErrorCode::InputBusy)
        );
        pairing.takeover(&desktop, connection, 106).unwrap();
        assert_eq!(
            pairing.check_input(&alice, &next, 107),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            pairing.check_action(&bob, scope, 107),
            Err(ErrorCode::PermissionDenied)
        );
        pairing.revoke(&desktop, alice.ticket_id(), 108).unwrap();
        assert_eq!(
            pairing.dispatch_input(&alice, &next, 109),
            Err(ErrorCode::PermissionDenied)
        );
    }
}
