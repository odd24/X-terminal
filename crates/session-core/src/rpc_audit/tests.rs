use super::*;
use crate::{
    access::{Action, Target},
    session::{ConnectionId, ConnectionRef},
};
fn time(n: u64) -> Time {
    Time {
        unix_ms: 1794052800000 + n,
        elapsed_ms: n,
    }
}
fn origin() -> Origin {
    Origin {
        pipe_id: Uuid::new_v4(),
        client_id: Some(Uuid::new_v4()),
        kind: OriginKind::Agent,
        peer_pid: Some(1234),
    }
}
fn request() -> Descriptor {
    Descriptor {
        area: Area::Ssh2,
        verb: Verb::Write,
        wire_id: Some(7),
        request_id: Some(Uuid::new_v4()),
        requested_scope: Some(Scope {
            target: Target::Connection {
                connection: ConnectionRef {
                    connection_id: ConnectionId(Uuid::new_v4()),
                    generation: 2,
                },
            },
            action: Action::Write,
        }),
    }
}
#[test]
fn repeated_wire_and_operation_ids_are_separate_attempts_and_delivery_loss_does_not_erase_returned_result()
 {
    let mut ring = Ring::default();
    let origin = origin();
    let request = request();
    let first = ring.begin(time(1), origin, request).unwrap();
    let second = ring.begin(time(2), origin, request).unwrap();
    assert_ne!(first.attempt.attempt_id, second.attempt.attempt_id);
    let first_id = first.attempt.attempt_id;
    let second_id = second.attempt.attempt_id;
    assert_eq!(
        ring.end(first_id, time(3), Phase::ReplyWritten {}),
        Err(ErrorCode::InvalidState)
    );
    let returned = ring.returned(first_id, time(3), Ok(())).unwrap();
    assert_eq!(returned.phase, Phase::ReturnedOk {});
    let lost = ring
        .end(
            first_id,
            time(4),
            Phase::IoFailure {
                stage: IoStage::ReplyWrite,
                reason: IoReason::Closed,
            },
        )
        .unwrap();
    assert_eq!(lost.attempt, returned.attempt);
    assert_eq!(
        ring.returned(first_id, time(5), Ok(())),
        Err(ErrorCode::NotFound)
    );
    ring.returned(second_id, time(5), Err(ErrorCode::PermissionDenied))
        .unwrap();
    assert_eq!(
        ring.returned(second_id, time(6), Ok(())),
        Err(ErrorCode::InvalidState)
    );
    ring.end(second_id, time(6), Phase::ReplyWritten {})
        .unwrap();
    assert_eq!(ring.active_count(), 0);
    let page = ring.page(0, 6, 128).unwrap();
    assert_eq!(page.events.len(), 6);
    assert!(!page.gap);
    assert_eq!(
        page.events[4].phase,
        Phase::ReturnedError {
            code: ErrorCode::PermissionDenied
        }
    );
    assert_eq!(page.events[5].phase, Phase::ReplyWritten {});
}
#[test]
fn origin_and_failure_phases_are_checked_without_accepting_caller_secrets_or_success_defaults() {
    let mut ring = Ring::default();
    let authenticated = origin();
    for invalid in [
        Origin {
            client_id: None,
            ..authenticated
        },
        Origin {
            kind: OriginKind::Unauthenticated,
            ..authenticated
        },
        Origin {
            pipe_id: Uuid::nil(),
            ..authenticated
        },
        Origin {
            peer_pid: Some(0),
            ..authenticated
        },
    ] {
        assert_eq!(
            ring.begin(time(1), invalid, request()),
            Err(ErrorCode::InvalidArgument)
        );
    }
    let unauth = Origin {
        client_id: None,
        kind: OriginKind::Unauthenticated,
        ..authenticated
    };
    let request = Descriptor {
        area: Area::Transport,
        verb: Verb::Hello,
        wire_id: None,
        request_id: None,
        requested_scope: None,
    };
    let start = ring.begin(time(1), unauth, request).unwrap();
    ring.end(
        start.attempt.attempt_id,
        time(2),
        Phase::IoFailure {
            stage: IoStage::HelloRead,
            reason: IoReason::InvalidFrame,
        },
    )
    .unwrap();
    let start = ring.begin(time(3), unauth, request).unwrap();
    ring.returned(
        start.attempt.attempt_id,
        time(4),
        Err(ErrorCode::VersionMismatch),
    )
    .unwrap();
    assert_eq!(
        ring.end(
            start.attempt.attempt_id,
            time(5),
            Phase::IoFailure {
                stage: IoStage::HelloRead,
                reason: IoReason::Other
            }
        ),
        Err(ErrorCode::InvalidState)
    );
    ring.end(start.attempt.attempt_id, time(5), Phase::Abandoned {})
        .unwrap();
    for value in [
        serde_json::json!({"kind":"returned_error"}),
        serde_json::json!({"kind":"returned_ok","token":"synthetic-private"}),
        serde_json::json!({"kind":"received","body":"synthetic-command"}),
    ] {
        assert!(serde_json::from_value::<Phase>(value).is_err());
    }
    let event = ring.page(0, ring.through_cursor(), 128).unwrap().events[0];
    for key in [
        "token",
        "command",
        "password",
        "literals",
        "path",
        "fingerprint",
    ] {
        let mut invalid = serde_json::to_value(event).unwrap();
        invalid["attempt"]["request"][key] = "synthetic-private".into();
        assert!(serde_json::from_value::<Event>(invalid).is_err());
    }
}
#[test]
fn fixed_watermark_pagination_reports_overwrite_and_never_moves_to_future_events() {
    let mut ring = Ring::default();
    let source = origin();
    let desc = request();
    let first = ring.begin(time(1), source, desc).unwrap();
    ring.returned(first.attempt.attempt_id, time(2), Ok(()))
        .unwrap();
    ring.end(first.attempt.attempt_id, time(3), Phase::ReplyWritten {})
        .unwrap();
    let through = ring.through_cursor();
    let page = ring.page(0, through, 2).unwrap();
    assert_eq!(page.next_cursor, 2);
    for n in 0..300 {
        let e = ring.begin(time(n + 4), source, desc).unwrap();
        ring.end(e.attempt.attempt_id, time(n + 4), Phase::Abandoned {})
            .unwrap();
    }
    assert_eq!(ring.events.len(), 512);
    let lost = ring.page(page.next_cursor, through, 128).unwrap();
    assert!(lost.gap);
    assert!(lost.events.is_empty());
    assert_eq!(lost.next_cursor, through);
    assert!(lost.available_from > through);
    let current = ring.page(0, ring.through_cursor(), 128).unwrap();
    assert!(current.gap);
    assert_eq!(current.events.len(), 128);
    let mut cursor = current.next_cursor;
    let through = current.through_cursor;
    let mut seqs = current.events.iter().map(|e| e.seq).collect::<Vec<_>>();
    while cursor < through {
        let page = ring.page(cursor, through, 128).unwrap();
        assert!(!page.gap);
        seqs.extend(page.events.iter().map(|e| e.seq));
        cursor = page.next_cursor;
    }
    assert_eq!(seqs.len(), 512);
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    assert!(serde_json::to_vec(&current).unwrap().len() < 128 * 1024);
    for (cursor, through, limit) in [
        (0, ring.through_cursor() + 1, 1),
        (2, 1, 1),
        (0, 1, 0),
        (0, 1, 129),
    ] {
        assert!(ring.page(cursor, through, limit).is_err());
    }
}
#[test]
fn active_attempt_capacity_and_sequence_exhaustion_never_evict_live_attempts_or_wrap() {
    let mut ring = Ring::default();
    let source = origin();
    let desc = request();
    let mut ids = Vec::new();
    for n in 0..64 {
        ids.push(
            ring.begin(time(n), source, desc)
                .unwrap()
                .attempt
                .attempt_id,
        );
    }
    assert_eq!(
        ring.begin(time(65), source, desc),
        Err(ErrorCode::CapacityExceeded)
    );
    assert_eq!(ring.active_count(), 64);
    ring.end(ids[0], time(66), Phase::Abandoned {}).unwrap();
    assert_eq!(ring.active_count(), 63);
    ring.begin(time(67), source, desc).unwrap();
    assert_eq!(ring.active_count(), 64);
    ring.next_seq = u64::MAX;
    assert_eq!(
        ring.returned(ids[1], time(68), Ok(())),
        Err(ErrorCode::CapacityExceeded)
    );
    assert_eq!(
        ring.end(ids[1], time(69), Phase::Abandoned {}),
        Err(ErrorCode::CapacityExceeded)
    );
    assert_eq!(ring.through_cursor(), u64::MAX);
    assert_eq!(ring.active_count(), 64);
}

#[test]
fn successful_handshake_binds_server_observed_identity_without_rewriting_the_unauthenticated_origin()
 {
    let mut ring = Ring::default();
    let source = origin();
    let unauth = Origin {
        kind: OriginKind::Unauthenticated,
        client_id: None,
        ..source
    };
    let desc = Descriptor {
        area: Area::Transport,
        verb: Verb::Hello,
        wire_id: None,
        request_id: None,
        requested_scope: None,
    };
    let first = ring.begin(time(1), unauth, desc).unwrap();
    let id = first.attempt.attempt_id;
    assert_eq!(
        ring.begin(time(1), source, desc),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        ring.begin(time(1), unauth, request()),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        ring.returned(id, time(2), Ok(())),
        Err(ErrorCode::InvalidState)
    );
    assert_eq!(
        ring.authenticated(id, time(2), Uuid::nil(), OriginKind::Agent),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        ring.authenticated(
            id,
            time(2),
            source.client_id.unwrap(),
            OriginKind::Unauthenticated
        ),
        Err(ErrorCode::InvalidArgument)
    );
    let accepted = ring
        .authenticated(id, time(2), source.client_id.unwrap(), OriginKind::Agent)
        .unwrap();
    assert_eq!(accepted.attempt.origin, unauth);
    assert_eq!(
        accepted.phase,
        Phase::Authenticated {
            client_id: source.client_id.unwrap(),
            origin_kind: OriginKind::Agent
        }
    );
    assert_eq!(
        ring.authenticated(id, time(3), Uuid::new_v4(), OriginKind::Desktop),
        Err(ErrorCode::InvalidState)
    );
    ring.returned(id, time(3), Ok(())).unwrap();
    ring.end(id, time(4), Phase::ReplyWritten {}).unwrap();
    let rpc = ring.begin(time(5), source, request()).unwrap();
    assert_eq!(
        ring.authenticated(
            rpc.attempt.attempt_id,
            time(6),
            Uuid::new_v4(),
            OriginKind::Desktop
        ),
        Err(ErrorCode::InvalidState)
    );
    ring.end(rpc.attempt.attempt_id, time(6), Phase::Abandoned {})
        .unwrap();
    assert_eq!(ring.page(0, 4, 128).unwrap().events.len(), 4);
}
