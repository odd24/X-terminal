use super::*;
use crate::session::ConnectionId;

fn connection() -> ConnectionRef {
    ConnectionRef {
        connection_id: ConnectionId(Uuid::new_v4()),
        generation: 1,
    }
}
fn scope(connection: ConnectionRef, action: Action) -> Scope {
    Scope {
        target: Target::Connection { connection },
        action,
    }
}
fn grant(policy: &mut Policy, client: Uuid, connection: ConnectionRef) {
    policy
        .grant(
            client,
            vec![
                scope(connection, Action::Read),
                scope(connection, Action::Write),
            ],
            1000,
            0,
        )
        .unwrap();
}

#[test]
fn capabilities_are_independent_and_exact_generation_scoped() {
    let mut p = Policy::default();
    let client = Uuid::new_v4();
    let c = connection();
    grant(&mut p, client, c);
    for action in [Action::Read, Action::Write] {
        assert_eq!(p.authorize(client, scope(c, action), 999), Ok(()));
    }
    for action in [
        Action::Exec,
        Action::Control,
        Action::Disconnect,
        Action::Reconnect,
        Action::Broadcast,
    ] {
        assert_eq!(
            p.authorize(client, scope(c, action), 1),
            Err(Denial::PermissionDenied)
        );
    }
    assert_eq!(
        p.authorize(client, scope(connection(), Action::Read), 1),
        Err(Denial::PermissionDenied)
    );
    assert_eq!(
        p.authorize(
            client,
            scope(ConnectionRef { generation: 2, ..c }, Action::Read),
            1
        ),
        Err(Denial::PermissionDenied)
    );
    assert_eq!(
        p.authorize(client, scope(c, Action::Read), 1000),
        Err(Denial::PermissionDenied)
    );
    assert_eq!(
        p.authorize(Uuid::new_v4(), scope(c, Action::Read), 1),
        Err(Denial::PermissionDenied)
    );
}

#[test]
fn connect_is_an_explicit_profile_scope_and_grants_no_connection_access() {
    let mut p = Policy::default();
    let client = Uuid::new_v4();
    let s = Scope {
        target: Target::Profile {
            profile_id: Uuid::new_v4(),
        },
        action: Action::Connect,
    };
    p.grant(client, vec![s], 100, 0).unwrap();
    let permit = p.admit(client, s, None, Uuid::new_v4(), 1).unwrap();
    assert_eq!(p.dispatch(&permit, 2), Ok(()));
    for action in [Action::Read, Action::Write, Action::Exec] {
        assert_eq!(
            p.authorize(client, scope(connection(), action), 2),
            Err(Denial::PermissionDenied)
        );
    }
    let invalid = Scope {
        action: Action::Write,
        ..s
    };
    assert_eq!(
        p.grant(Uuid::new_v4(), vec![invalid], 100, 0),
        Err(Denial::InvalidArgument)
    );
    assert_eq!(
        p.grant(
            Uuid::new_v4(),
            vec![scope(connection(), Action::Connect)],
            100,
            0
        ),
        Err(Denial::InvalidArgument)
    );
}

#[test]
fn lease_is_exclusive_and_read_only_clients_cannot_acquire_it() {
    let mut p = Policy::default();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = connection();
    grant(&mut p, a, c);
    grant(&mut p, b, c);
    let observer = Uuid::new_v4();
    p.grant(observer, vec![scope(c, Action::Read)], 1000, 0)
        .unwrap();
    assert_eq!(
        p.acquire(observer, c, 100, 0),
        Err(Denial::PermissionDenied)
    );
    assert!(matches!(
        p.admit(a, scope(c, Action::Write), None, Uuid::new_v4(), 0),
        Err(Denial::InputBusy)
    ));
    let lease = p.acquire(a, c, 100, 0).unwrap();
    assert_eq!(p.acquire(b, c, 100, 1), Err(Denial::InputBusy));
    assert_eq!(p.acquire(a, c, 100, 1), Err(Denial::InputBusy));
    assert_eq!(
        p.release(b, c, lease.lease_id, 1),
        Err(Denial::PermissionDenied)
    );
    assert_eq!(
        p.release(a, c, Uuid::new_v4(), 1),
        Err(Denial::PermissionDenied)
    );
    p.release(a, c, lease.lease_id, 1).unwrap();
    assert!(p.acquire(b, c, 100, 2).is_ok());
}

#[test]
fn release_reacquire_and_takeover_never_revive_queued_permits() {
    let mut p = Policy::default();
    let a = Uuid::new_v4();
    let c = connection();
    grant(&mut p, a, c);
    let other = Uuid::new_v4();
    grant(&mut p, other, c);
    let first = p.acquire(a, c, 100, 0).unwrap();
    let request = Uuid::new_v4();
    let queued = p
        .admit(a, scope(c, Action::Write), Some(first.lease_id), request, 1)
        .unwrap();
    p.release(a, c, first.lease_id, 2).unwrap();
    assert_eq!(p.dispatch(&queued, 2), Err(Denial::InputBusy));
    let second = p.acquire(a, c, 100, 3).unwrap();
    assert_ne!(first.lease_id, second.lease_id);
    assert_eq!(p.dispatch(&queued, 4), Err(Denial::InputBusy));
    let current = p
        .admit(
            a,
            scope(c, Action::Write),
            Some(second.lease_id),
            Uuid::new_v4(),
            4,
        )
        .unwrap();
    assert_eq!(p.dispatch(&current, 5), Ok(()));
    // The policy only cancels pending dispatch; the successful earlier dispatch is not undone.
    p.takeover(c, 6);
    assert_eq!(p.acquire(a, c, 100, 7), Err(Denial::PermissionDenied));
    assert_eq!(p.acquire(other, c, 100, 7), Err(Denial::PermissionDenied));
    assert_eq!(p.dispatch(&current, 7), Err(Denial::PermissionDenied));
    assert_eq!(p.authorize(a, scope(c, Action::Read), 7), Ok(()));
    assert_eq!(
        p.audit(0, 128)
            .unwrap()
            .events
            .iter()
            .filter(|e| e.kind == AuditKind::Dispatched)
            .count(),
        1
    );
}

#[test]
fn expiry_revocation_and_retirement_are_rechecked_at_dispatch() {
    let mut p = Policy::default();
    let a = Uuid::new_v4();
    let c = connection();
    grant(&mut p, a, c);
    let l = p.acquire(a, c, 100, 0).unwrap();
    let queued = p
        .admit(
            a,
            scope(c, Action::Write),
            Some(l.lease_id),
            Uuid::new_v4(),
            1,
        )
        .unwrap();
    assert_eq!(p.dispatch(&queued, 100), Err(Denial::InputBusy));
    let read = p
        .admit(a, scope(c, Action::Read), None, Uuid::new_v4(), 2)
        .unwrap();
    p.revoke(a, 3);
    assert_eq!(p.dispatch(&read, 4), Err(Denial::PermissionDenied));
    // Even an erroneous caller reusing an ID cannot revive a previously queued permit.
    p.grant(a, vec![scope(c, Action::Read)], 100, 4).unwrap();
    assert_eq!(p.dispatch(&read, 5), Err(Denial::PermissionDenied));
    p.retire(c, 6);
    assert_eq!(
        p.authorize(a, scope(c, Action::Read), 7),
        Err(Denial::PermissionDenied)
    );
    assert_eq!(
        p.authorize(
            a,
            scope(ConnectionRef { generation: 2, ..c }, Action::Read),
            7
        ),
        Err(Denial::PermissionDenied)
    );
}

#[test]
fn lifetimes_arguments_and_capacity_fail_closed() {
    let mut p = Policy::default();
    let a = Uuid::new_v4();
    let c = connection();
    let s = scope(c, Action::Write);
    for lifetime in [0, MAX_GRANT_MS + 1, u64::MAX] {
        assert_eq!(
            p.grant(a, vec![s], lifetime, 1),
            Err(Denial::InvalidArgument)
        );
    }
    assert_eq!(p.grant(a, vec![], 10, 0), Err(Denial::InvalidArgument));
    assert_eq!(p.grant(a, vec![s, s], 10, 0), Err(Denial::InvalidArgument));
    assert_eq!(
        p.grant(Uuid::nil(), vec![s], 10, 0),
        Err(Denial::InvalidArgument)
    );
    assert_eq!(
        p.grant(
            a,
            vec![scope(ConnectionRef { generation: 0, ..c }, Action::Read)],
            10,
            0
        ),
        Err(Denial::InvalidArgument)
    );
    grant(&mut p, a, c);
    for lifetime in [0, 1001, MAX_LEASE_MS + 1, u64::MAX] {
        assert_eq!(p.acquire(a, c, lifetime, 0), Err(Denial::InvalidArgument));
    }
    for _ in 1..MAX_GRANTS {
        p.grant(Uuid::new_v4(), vec![s], 1000, 0).unwrap();
    }
    assert_eq!(
        p.grant(Uuid::new_v4(), vec![s], 1000, 0),
        Err(Denial::CapacityExceeded)
    );
    assert!(p.grant(Uuid::new_v4(), vec![s], 1000, 1000).is_ok());
    assert_eq!(p.grants.len(), 1);
}

#[test]
fn all_mutating_connection_actions_require_the_exact_lease() {
    let mut p = Policy::default();
    let a = Uuid::new_v4();
    let c = connection();
    let actions = [
        Action::Write,
        Action::Exec,
        Action::Control,
        Action::Disconnect,
        Action::Reconnect,
        Action::Broadcast,
    ];
    p.grant(a, actions.iter().map(|a| scope(c, *a)).collect(), 1000, 0)
        .unwrap();
    let lease = p.acquire(a, c, 100, 0).unwrap();
    for action in actions {
        assert!(matches!(
            p.admit(a, scope(c, action), Some(Uuid::new_v4()), Uuid::new_v4(), 1),
            Err(Denial::InputBusy)
        ));
        let permit = p
            .admit(a, scope(c, action), Some(lease.lease_id), Uuid::new_v4(), 1)
            .unwrap();
        assert_eq!(p.dispatch(&permit, 2), Ok(()));
    }
}

#[test]
fn audit_is_bounded_paginated_and_reports_overwritten_ranges() {
    let mut p = Policy::default();
    let client = Uuid::new_v4();
    let c = connection();
    for _ in 0..700 {
        assert!(
            p.admit(client, scope(c, Action::Read), None, Uuid::new_v4(), 10)
                .is_err()
        );
    }
    assert_eq!(p.audit.len(), MAX_AUDIT);
    let first = p.audit(0, 128).unwrap();
    assert!(first.gap);
    assert_eq!(first.available_from, 188);
    assert_eq!(first.events[0].seq, 189);
    assert_eq!(first.next_cursor, 316);
    let second = p.audit(first.next_cursor, 128).unwrap();
    assert!(!second.gap);
    assert_eq!(second.events[0].seq, 317);
    assert!(p.audit(701, 128).is_err());
    assert!(p.audit(0, 129).is_err());
    assert!(p.audit(0, 0).is_err());
    let serialized = serde_json::to_string(&first).unwrap();
    assert!(!serialized.contains("token"));
    assert!(!serialized.contains("payload"));
}

#[test]
fn lease_and_scope_limits_are_independent_and_expiry_reclaims_capacity() {
    let mut p = Policy::default();
    let client = Uuid::new_v4();
    let scopes: Vec<_> = (0..MAX_SCOPES)
        .map(|_| scope(connection(), Action::Write))
        .collect();
    let mut too_many = scopes.clone();
    too_many.push(scope(connection(), Action::Write));
    assert_eq!(
        p.grant(client, too_many, 1000, 0),
        Err(Denial::InvalidArgument)
    );
    p.grant(client, scopes.clone(), 1000, 0).unwrap();
    for s in scopes {
        let Target::Connection { connection } = s.target else {
            unreachable!()
        };
        p.acquire(client, connection, 10, 0).unwrap();
    }
    let next = connection();
    let another = Uuid::new_v4();
    grant(&mut p, another, next);
    assert_eq!(
        p.acquire(another, next, 10, 1),
        Err(Denial::CapacityExceeded)
    );
    assert!(p.acquire(another, next, 10, 10).is_ok());
    assert_eq!(p.leases.len(), 1);
    assert_eq!(
        p.grant(Uuid::new_v4(), vec![scope(next, Action::Read)], 1, u64::MAX),
        Err(Denial::InvalidArgument)
    );
}

#[test]
fn profile_revision_cannot_authorize_other_revisions_or_connection_actions() {
    let mut policy = Policy::default();
    let client = Uuid::new_v4();
    let profile_id = Uuid::new_v4();
    let revision = Uuid::new_v4();
    let scope = Scope {
        target: Target::ProfileRevision {
            profile_id,
            revision,
        },
        action: Action::Connect,
    };
    policy.grant(client, vec![scope], 1000, 0).unwrap();
    let permit = policy
        .admit(client, scope, None, Uuid::new_v4(), 1)
        .unwrap();
    assert_eq!(permit.profile_revision(), Some(revision));
    policy.dispatch(&permit, 2).unwrap();
    for wrong in [
        Scope {
            target: Target::Profile { profile_id },
            ..scope
        },
        Scope {
            target: Target::ProfileRevision {
                profile_id,
                revision: Uuid::new_v4(),
            },
            ..scope
        },
    ] {
        assert!(
            policy
                .admit(client, wrong, None, Uuid::new_v4(), 2)
                .is_err()
        );
    }
    for action in [
        Action::Read,
        Action::Write,
        Action::Control,
        Action::Disconnect,
    ] {
        assert!(
            policy
                .grant(Uuid::new_v4(), vec![Scope { action, ..scope }], 1000, 0)
                .is_err()
        );
    }
    policy.revoke(client, 3);
    assert!(policy.dispatch(&permit, 4).is_err());
}
