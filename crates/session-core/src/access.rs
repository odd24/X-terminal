//! Service-owned Agent policy. Callers supply an authenticated ticket identity, never a role.
//! Admission and dispatch must execute under the same policy lock as takeover/revocation.
use crate::session::ConnectionRef;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

pub const MAX_GRANTS: usize = 128;
pub const MAX_SCOPES: usize = 64;
pub const MAX_GRANT_MS: u64 = 30 * 60 * 1000;
pub const MAX_LEASE_MS: u64 = 60 * 1000;
pub const MAX_AUDIT: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Action {
    Read,
    Write,
    Exec,
    Connect,
    Control,
    Disconnect,
    Reconnect,
    Forget,
    Broadcast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Connection { connection: ConnectionRef },
    Profile { profile_id: Uuid },
    ProfileRevision { profile_id: Uuid, revision: Uuid },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub target: Target,
    pub action: Action,
}
impl Scope {
    fn valid(self) -> bool {
        match self.target {
            Target::Profile { profile_id } => {
                !profile_id.is_nil() && self.action == Action::Connect
            }
            Target::ProfileRevision {
                profile_id,
                revision,
            } => !profile_id.is_nil() && !revision.is_nil() && self.action == Action::Connect,
            Target::Connection { connection } => {
                !connection.connection_id.0.is_nil()
                    && connection.generation != 0
                    && self.action != Action::Connect
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Denial {
    InvalidArgument,
    PermissionDenied,
    InputBusy,
    CapacityExceeded,
}

struct Grant {
    grant_id: Uuid,
    scopes: HashSet<Scope>,
    expires_at_ms: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    pub lease_id: Uuid,
    pub client_id: Uuid,
    pub connection: ConnectionRef,
    pub expires_at_ms: u64,
}

/// Opaque in-process queue capability; cannot be reconstructed from a wire request.
#[derive(Clone, Copy)]
pub struct Permit {
    grant_id: Uuid,
    request_id: Uuid,
    client_id: Uuid,
    scope: Scope,
    lease_id: Option<Uuid>,
}

impl Permit {
    pub fn profile_revision(&self) -> Option<Uuid> {
        match self.scope.target {
            Target::ProfileRevision { revision, .. } => Some(revision),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuditKind {
    Granted,
    Revoked,
    LeaseAcquired,
    LeaseReleased,
    Takeover,
    Admitted,
    Dispatched,
    Denied,
    GenerationRetired,
}

/// Metadata only: no tokens, commands, authentication answers, or terminal content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AuditEvent {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub kind: AuditKind,
    pub client_id: Option<Uuid>,
    pub scope: Option<Scope>,
    pub request_id: Option<Uuid>,
    pub denial: Option<Denial>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AuditPage {
    pub events: Vec<AuditEvent>,
    pub available_from: u64,
    pub next_cursor: u64,
    pub gap: bool,
}

#[derive(Default)]
pub struct Policy {
    grants: HashMap<Uuid, Grant>,
    leases: HashMap<ConnectionRef, Lease>,
    audit: VecDeque<AuditEvent>,
    next_seq: u64,
}
impl Policy {
    /// Management metadata only; never an authorization shortcut.
    pub fn effective_scopes(&self, client: Uuid, now: u64) -> Vec<Scope> {
        self.grants
            .get(&client)
            .filter(|grant| grant.expires_at_ms > now)
            .map(|grant| grant.scopes.iter().copied().collect())
            .unwrap_or_default()
    }
    fn record(
        &mut self,
        now: u64,
        kind: AuditKind,
        client: Option<Uuid>,
        scope: Option<Scope>,
        request: Option<Uuid>,
        denial: Option<Denial>,
    ) {
        // Sequence overflow is unreachable within a service lifetime; never wrap a cursor.
        self.next_seq = self
            .next_seq
            .checked_add(1)
            .expect("audit sequence exhausted");
        if self.audit.len() == MAX_AUDIT {
            self.audit.pop_front();
        }
        self.audit.push_back(AuditEvent {
            seq: self.next_seq,
            timestamp_ms: now,
            kind,
            client_id: client,
            scope,
            request_id: request,
            denial,
        });
    }
    fn prune(&mut self, now: u64) {
        self.grants.retain(|_, grant| grant.expires_at_ms > now);
        self.leases.retain(|_, lease| {
            lease.expires_at_ms > now && self.grants.contains_key(&lease.client_id)
        });
    }
    /// Desktop-only caller must enforce authority before calling this method.
    /// Ticket IDs are unique for a service lifetime; a grant cannot be renewed in place.
    pub fn grant(
        &mut self,
        client: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<u64, Denial> {
        let expires = now
            .checked_add(lifetime_ms)
            .ok_or(Denial::InvalidArgument)?;
        if client.is_nil()
            || scopes.is_empty()
            || scopes.len() > MAX_SCOPES
            || lifetime_ms == 0
            || lifetime_ms > MAX_GRANT_MS
            || scopes.iter().any(|scope| !scope.valid())
            || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
        {
            return Err(Denial::InvalidArgument);
        }
        // Check before pruning so an expired identity cannot be resurrected at this call.
        if self.grants.contains_key(&client) {
            return Err(Denial::InvalidArgument);
        }
        self.prune(now);
        if self.grants.len() == MAX_GRANTS {
            return Err(Denial::CapacityExceeded);
        }
        self.grants.insert(
            client,
            Grant {
                grant_id: Uuid::new_v4(),
                scopes: scopes.into_iter().collect(),
                expires_at_ms: expires,
            },
        );
        self.record(now, AuditKind::Granted, Some(client), None, None, None);
        Ok(expires)
    }
    fn allowed(&self, client: Uuid, scope: Scope, now: u64) -> Result<(), Denial> {
        if self
            .grants
            .get(&client)
            .is_some_and(|g| g.expires_at_ms > now && g.scopes.contains(&scope))
        {
            Ok(())
        } else {
            Err(Denial::PermissionDenied)
        }
    }
    pub fn authorize(&self, client: Uuid, scope: Scope, now: u64) -> Result<(), Denial> {
        self.allowed(client, scope, now)
    }
    pub fn revoke(&mut self, client: Uuid, now: u64) {
        self.grants.remove(&client);
        self.leases.retain(|_, lease| lease.client_id != client);
        self.record(now, AuditKind::Revoked, Some(client), None, None, None);
    }
    pub fn acquire(
        &mut self,
        client: Uuid,
        connection: ConnectionRef,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<Lease, Denial> {
        self.prune(now);
        let grant = self.grants.get(&client).ok_or(Denial::PermissionDenied)?;
        if !grant.scopes.iter().any(|s| {
            s.target == Target::Connection { connection } && !matches!(s.action, Action::Read)
        }) {
            return Err(Denial::PermissionDenied);
        }
        let expires = now
            .checked_add(lifetime_ms)
            .ok_or(Denial::InvalidArgument)?;
        if lifetime_ms == 0 || lifetime_ms > MAX_LEASE_MS || expires > grant.expires_at_ms {
            return Err(Denial::InvalidArgument);
        }
        // Even the owner must query/release the original lease, not renew implicitly.
        if self.leases.contains_key(&connection) {
            return Err(Denial::InputBusy);
        }
        if self.leases.len() == MAX_SCOPES {
            return Err(Denial::CapacityExceeded);
        }
        let lease = Lease {
            lease_id: Uuid::new_v4(),
            client_id: client,
            connection,
            expires_at_ms: expires,
        };
        self.leases.insert(connection, lease);
        self.record(
            now,
            AuditKind::LeaseAcquired,
            Some(client),
            Some(Scope {
                target: Target::Connection { connection },
                action: Action::Write,
            }),
            None,
            None,
        );
        Ok(lease)
    }
    pub fn lease(&self, connection: ConnectionRef, now: u64) -> Option<Lease> {
        self.leases
            .get(&connection)
            .filter(|l| {
                l.expires_at_ms > now
                    && self
                        .grants
                        .get(&l.client_id)
                        .is_some_and(|g| g.expires_at_ms > now)
            })
            .copied()
    }
    pub fn release(
        &mut self,
        client: Uuid,
        connection: ConnectionRef,
        lease_id: Uuid,
        now: u64,
    ) -> Result<(), Denial> {
        let lease = self
            .lease(connection, now)
            .ok_or(Denial::PermissionDenied)?;
        if lease.client_id != client || lease.lease_id != lease_id {
            return Err(Denial::PermissionDenied);
        }
        self.leases.remove(&connection);
        self.record(
            now,
            AuditKind::LeaseReleased,
            Some(client),
            None,
            None,
            None,
        );
        Ok(())
    }
    /// Called before admitting human input. Keep observation, revoke automation for this
    /// connection across all clients so a second client cannot immediately reclaim input.
    pub fn takeover(&mut self, connection: ConnectionRef, now: u64) {
        let owner = self.leases.remove(&connection).map(|l| l.client_id);
        for grant in self.grants.values_mut() {
            grant.scopes.retain(|s| {
                s.target != Target::Connection { connection } || s.action == Action::Read
            });
        }
        self.record(
            now,
            AuditKind::Takeover,
            owner,
            Some(Scope {
                target: Target::Connection { connection },
                action: Action::Write,
            }),
            None,
            None,
        );
    }
    /// Retire the exact old generation, including read scopes. Never transfer to a new one.
    pub fn retire(&mut self, connection: ConnectionRef, now: u64) {
        self.leases.remove(&connection);
        for grant in self.grants.values_mut() {
            grant
                .scopes
                .retain(|s| s.target != Target::Connection { connection });
        }
        self.record(
            now,
            AuditKind::GenerationRetired,
            None,
            Some(Scope {
                target: Target::Connection { connection },
                action: Action::Read,
            }),
            None,
            None,
        );
    }
    pub fn admit(
        &mut self,
        client: Uuid,
        scope: Scope,
        lease_id: Option<Uuid>,
        request: Uuid,
        now: u64,
    ) -> Result<Permit, Denial> {
        let permit = Permit {
            grant_id: self.grants.get(&client).map_or(Uuid::nil(), |g| g.grant_id),
            request_id: request,
            client_id: client,
            scope,
            lease_id,
        };
        let result = self.check(&permit, now);
        self.record(
            now,
            if result.is_ok() {
                AuditKind::Admitted
            } else {
                AuditKind::Denied
            },
            Some(client),
            Some(scope),
            Some(request),
            result.err(),
        );
        result.map(|()| permit)
    }
    fn check(&self, permit: &Permit, now: u64) -> Result<(), Denial> {
        self.allowed(permit.client_id, permit.scope, now)?;
        if !self
            .grants
            .get(&permit.client_id)
            .is_some_and(|g| g.grant_id == permit.grant_id)
        {
            return Err(Denial::PermissionDenied);
        }
        if !matches!(permit.scope.action, Action::Read | Action::Connect) {
            let Target::Connection { connection } = permit.scope.target else {
                return Err(Denial::InvalidArgument);
            };
            let lease = self.lease(connection, now).ok_or(Denial::InputBusy)?;
            if lease.client_id != permit.client_id || Some(lease.lease_id) != permit.lease_id {
                return Err(Denial::InputBusy);
            }
        }
        Ok(())
    }
    /// Validate immediately before transport dispatch; permission at enqueue is insufficient.
    pub fn dispatch(&mut self, permit: &Permit, now: u64) -> Result<(), Denial> {
        let result = self.check(permit, now);
        self.record(
            now,
            if result.is_ok() {
                AuditKind::Dispatched
            } else {
                AuditKind::Denied
            },
            Some(permit.client_id),
            Some(permit.scope),
            Some(permit.request_id),
            result.err(),
        );
        result
    }
    pub fn dispatch_for(&mut self, client: Uuid, permit: &Permit, now: u64) -> Result<(), Denial> {
        if permit.client_id != client {
            return Err(Denial::PermissionDenied);
        }
        self.dispatch(permit, now)
    }
    pub fn check_for(&self, client: Uuid, permit: &Permit, now: u64) -> Result<(), Denial> {
        if permit.client_id != client {
            return Err(Denial::PermissionDenied);
        }
        self.check(permit, now)
    }
    pub fn audit(&self, cursor: u64, limit: usize) -> Result<AuditPage, Denial> {
        if limit == 0 || limit > 128 || cursor > self.next_seq {
            return Err(Denial::InvalidArgument);
        }
        let available_from = self.audit.front().map_or(self.next_seq, |e| e.seq - 1);
        let events: Vec<_> = self
            .audit
            .iter()
            .filter(|e| e.seq > cursor)
            .take(limit)
            .cloned()
            .collect();
        let next_cursor = events.last().map_or(cursor.max(available_from), |e| e.seq);
        Ok(AuditPage {
            events,
            available_from,
            next_cursor,
            gap: cursor < available_from,
        })
    }
}

#[cfg(test)]
mod tests;
