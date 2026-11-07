use super::*;
use crate::{
    access::{Denial, Policy},
    pairing::{Identity, Pairing, SecretToken},
    session::{ConnectionId, ConnectionRef},
};

fn connection() -> ConnectionRef {
    ConnectionRef {
        connection_id: ConnectionId(Uuid::new_v4()),
        generation: 1,
    }
}
fn scope(c: ConnectionRef, action: Action) -> Scope {
    Scope {
        target: Target::Connection { connection: c },
        action,
    }
}
fn key(bytes: &[u8]) -> OperationKey {
    OperationKey {
        request_id: Uuid::new_v4(),
        fingerprint: OperationFingerprint::of_canonical(bytes),
    }
}
fn setup(form: Form, scopes: Vec<Scope>) -> (Pairing, Identity, Identity, SecretToken) {
    let bootstrap = SecretToken::generate();
    let mut p = Pairing::new(&bootstrap);
    let desktop = p.authenticate(&bootstrap, 0).unwrap();
    let (agent, token, _) = p.issue_agent_form(&desktop, scopes, form, 100, 0).unwrap();
    (p, desktop, agent, token)
}

#[test]
fn canonical_fingerprint_has_a_known_digest_strict_lowercase_wire_and_no_retained_payload() {
    let digest = OperationFingerprint::of_canonical(b"abc");
    assert_eq!(
        digest.hex(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let encoded = serde_json::to_string(&digest).unwrap();
    assert_eq!(encoded.len(), 66);
    assert_eq!(
        serde_json::from_str::<OperationFingerprint>(&encoded).unwrap(),
        digest
    );
    assert_ne!(digest, OperationFingerprint::of_canonical(b"abc\n"));
    for invalid in [
        "A".repeat(64),
        "g".repeat(64),
        "0".repeat(63),
        "0".repeat(65),
    ] {
        assert!(
            serde_json::from_value::<OperationFingerprint>(serde_json::json!(invalid)).is_err()
        );
    }
    let value = serde_json::json!({"kind":"single_operation","operation":{"request_id":Uuid::new_v4(),"fingerprint":digest,"owner":Uuid::new_v4()}});
    assert!(serde_json::from_value::<Form>(value).is_err());
}

#[test]
fn single_identity_requires_the_actual_fixed_request_binding_and_still_requires_lease() {
    let c = connection();
    let s = scope(c, Action::Write);
    let operation = key(b"strictly typed canonical operation");
    let (mut p, desktop, agent, token) = setup(Form::SingleOperation { operation }, vec![s]);
    assert!(p.bind_operation(&desktop, operation, 1).is_err());
    assert!(
        p.bind_operation(
            &agent,
            OperationKey {
                request_id: Uuid::new_v4(),
                ..operation
            },
            1
        )
        .is_err()
    );
    assert!(
        p.bind_operation(
            &agent,
            OperationKey {
                fingerprint: OperationFingerprint::of_canonical(b"changed bytes"),
                ..operation
            },
            1
        )
        .is_err()
    );
    let bound = p.bind_operation(&agent, operation, 1).unwrap();
    assert_eq!(bound.ticket_id(), agent.ticket_id());
    assert!(!format!("{bound:?}").contains(&operation.fingerprint.hex()));
    assert!(matches!(
        p.admit_input(&bound, s, operation.request_id, 1),
        Err(ErrorCode::InputBusy)
    ));
    p.acquire_lease(&agent, c, 50, 2).unwrap();
    assert!(matches!(
        p.admit_input(&agent, s, operation.request_id, 3),
        Err(ErrorCode::PermissionDenied)
    ));
    let authenticated_again = p.authenticate(&token, 3).unwrap();
    assert!(
        p.admit_input(&authenticated_again, s, operation.request_id, 3)
            .is_err(),
        "wire authentication does not mint an operation proof"
    );
    let permit = p.admit_input(&bound, s, operation.request_id, 3).unwrap();
    p.dispatch_input(&bound, &permit, 4).unwrap();
    p.dispatch_input(&bound, &permit, 5).unwrap();
    // This is one operation's final checks / segments, not transport re-execution.
    // Existing request-owner receipt ledgers must separately prevent duplicate enqueue.
    assert!(p.admit_input(&bound, s, Uuid::new_v4(), 5).is_err());
    assert!(p.can_read(&bound, c, 5).is_err());
    assert!(
        p.admit_input(&bound, scope(c, Action::Exec), operation.request_id, 5)
            .is_err()
    );
}

#[test]
fn operation_proofs_cannot_cross_ticket_or_replaced_grant_even_with_the_same_fixed_key() {
    let operation = key(b"connect");
    let s = Scope {
        target: Target::ProfileRevision {
            profile_id: Uuid::new_v4(),
            revision: Uuid::new_v4(),
        },
        action: Action::Connect,
    };
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let mut policy = Policy::default();
    for client in [a, b] {
        policy
            .grant_form(client, vec![s], Form::SingleOperation { operation }, 100, 0)
            .unwrap();
    }
    let proof = policy.bind_operation(a, operation, 1).unwrap();
    let permit = policy
        .admit_bound(a, s, None, operation.request_id, proof, 1)
        .unwrap();
    assert!(matches!(
        policy.admit_bound(b, s, None, operation.request_id, proof, 1),
        Err(Denial::PermissionDenied)
    ));
    assert!(policy.dispatch_for(b, &permit, 1).is_err());
    policy.revoke(a, 2);
    policy
        .grant_form(a, vec![s], Form::SingleOperation { operation }, 100, 3)
        .unwrap();
    assert!(policy.dispatch(&permit, 4).is_err());
    assert!(
        policy
            .admit_bound(a, s, None, operation.request_id, proof, 4)
            .is_err()
    );
    let fresh = policy.bind_operation(a, operation, 4).unwrap();
    let new = policy
        .admit_bound(a, s, None, operation.request_id, fresh, 4)
        .unwrap();
    policy.dispatch(&new, 5).unwrap();
}

#[test]
fn single_final_dispatch_rechecks_revocation_expiry_takeover_retirement_and_released_lease() {
    for cause in [
        "revoke",
        "expiry",
        "takeover",
        "retire",
        "release-reacquire",
    ] {
        let c = connection();
        let s = scope(c, Action::Write);
        let operation = key(b"write");
        let (mut p, desktop, agent, _) = setup(Form::SingleOperation { operation }, vec![s]);
        let bound = p.bind_operation(&agent, operation, 1).unwrap();
        let lease = p.acquire_lease(&bound, c, 80, 1).unwrap();
        let permit = p.admit_input(&bound, s, operation.request_id, 2).unwrap();
        let now = if cause == "expiry" { 100 } else { 3 };
        match cause {
            "revoke" => p.revoke(&desktop, agent.ticket_id(), now).unwrap(),
            "takeover" => p.takeover(&desktop, c, now).unwrap(),
            "retire" => p.retire_connection(c, now),
            "release-reacquire" => {
                p.release_lease(&bound, c, lease.lease_id, now).unwrap();
                p.acquire_lease(&bound, c, 50, now).unwrap();
            }
            _ => {}
        }
        assert!(p.dispatch_input(&bound, &permit, now).is_err(), "{cause}");
    }
}

#[test]
fn a_single_reconnect_can_use_two_fixed_scopes_but_retirement_never_grants_new_generation() {
    let c = connection();
    let profile_id = Uuid::new_v4();
    let revision = Uuid::new_v4();
    let operation = key(b"reconnect exact old connection and parameters");
    let restart = scope(c, Action::Reconnect);
    let connect = Scope {
        target: Target::ProfileRevision {
            profile_id,
            revision,
        },
        action: Action::Connect,
    };
    let (mut p, _, agent, _) = setup(Form::SingleOperation { operation }, vec![restart, connect]);
    let bound = p.bind_operation(&agent, operation, 1).unwrap();
    p.acquire_lease(&bound, c, 50, 1).unwrap();
    let old = p
        .admit_input(&bound, restart, operation.request_id, 2)
        .unwrap();
    let new = p
        .admit_connect(&bound, profile_id, operation.request_id, 2)
        .unwrap();
    assert_eq!(new.profile_revision(), Some(revision));
    p.dispatch_input(&bound, &old, 3).unwrap();
    p.retire_connection(c, 4);
    assert!(p.dispatch_input(&bound, &old, 5).is_err());
    p.dispatch_input(&bound, &new, 5).unwrap();
    let next = ConnectionRef { generation: 2, ..c };
    assert!(p.can_read(&bound, next, 5).is_err());
    assert!(p.acquire_lease(&bound, next, 50, 5).is_err());
    assert!(
        p.admit_input(&bound, scope(next, Action::Write), operation.request_id, 5)
            .is_err()
    );
}

#[test]
fn timed_task_is_metadata_plus_explicit_scopes_and_deadline_not_an_authorization_shortcut() {
    let c = connection();
    let write = scope(c, Action::Write);
    let task_id = Uuid::new_v4();
    let form = Form::TimedTask {
        task_id,
        label: "合成诊断任务".into(),
    };
    let (mut p, desktop, agent, _) = setup(form.clone(), vec![write]);
    assert_eq!(p.authorization_form(&agent, 1).unwrap(), form);
    let mut edited = p.authorization_form(&agent, 1).unwrap();
    if let Form::TimedTask { label, .. } = &mut edited {
        label.clear();
    }
    assert_eq!(p.authorization_form(&agent, 1).unwrap(), form);
    let (other, _, _) = p
        .issue_agent_form(
            &desktop,
            vec![scope(c, Action::Control)],
            form.clone(),
            90,
            1,
        )
        .unwrap();
    assert!(
        p.admit_input(&other, write, Uuid::new_v4(), 2).is_err(),
        "matching task UUID/label does not borrow another ticket's scopes"
    );
    p.acquire_lease(&agent, c, 50, 1).unwrap();
    for bytes in [b"first".as_slice(), b"second"] {
        let operation = key(bytes);
        let bound = p.bind_operation(&agent, operation, 2).unwrap();
        let permit = p
            .admit_input(&bound, write, operation.request_id, 2)
            .unwrap();
        p.dispatch_input(&bound, &permit, 3).unwrap();
    }
    assert!(p.can_read(&agent, c, 3).is_err());
    assert!(
        p.admit_input(&agent, scope(c, Action::Control), Uuid::new_v4(), 3)
            .is_err()
    );
    p.takeover(&desktop, c, 4).unwrap();
    assert!(p.admit_input(&agent, write, Uuid::new_v4(), 5).is_err());
    assert!(p.authorization_form(&agent, 100).is_err());
}

#[test]
fn form_validation_rejects_unreviewable_scope_combinations_labels_and_unfixed_connect() {
    let c = connection();
    let operation = key(b"literal");
    let one = Form::SingleOperation { operation };
    assert!(one.valid_for(&[scope(c, Action::Forget)]));
    assert!(!one.valid_for(&[]));
    assert!(!one.valid_for(&[scope(c, Action::Read)]));
    assert!(!one.valid_for(&[scope(c, Action::Write), scope(c, Action::Exec)]));
    assert!(!one.valid_for(&[Scope {
        target: Target::Profile {
            profile_id: Uuid::new_v4()
        },
        action: Action::Connect
    }]));
    assert!(
        !Form::SingleOperation {
            operation: OperationKey {
                request_id: Uuid::nil(),
                ..operation
            }
        }
        .valid_for(&[scope(c, Action::Write)])
    );
    for label in [
        "".into(),
        " leading".into(),
        "trailing ".into(),
        "line\nbreak".into(),
        "\x1b[31m".into(),
        "中".repeat(86),
    ] {
        assert!(
            !Form::TimedTask {
                task_id: Uuid::new_v4(),
                label
            }
            .valid_for(&[scope(c, Action::Write)])
        );
    }
    assert!(
        Form::TimedTask {
            task_id: Uuid::new_v4(),
            label: "中".repeat(85)
        }
        .valid_for(&[scope(c, Action::Write)])
    );
    assert!(
        !Form::TimedTask {
            task_id: Uuid::nil(),
            label: "task".into()
        }
        .valid_for(&[scope(c, Action::Write)])
    );
    assert!(serde_json::from_value::<Form>(serde_json::json!({"kind":"timed_task","task_id":Uuid::new_v4(),"label":"task","role":"desktop"})).is_err());
}
