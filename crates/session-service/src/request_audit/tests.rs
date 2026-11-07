use super::*;
fn origin() -> Origin {
    Origin {
        pipe_id: Uuid::new_v4(),
        client_id: Some(Uuid::new_v4()),
        kind: OriginKind::Agent,
        peer_pid: Some(1),
    }
}
fn desc() -> Descriptor {
    Descriptor {
        area: Area::Ssh2,
        verb: Verb::Write,
        wire_id: Some(1),
        request_id: Some(Uuid::new_v4()),
        requested_scope: None,
        resource: None,
    }
}
#[tokio::test]
async fn actual_future_abort_records_abandoned_without_fabricating_reply() {
    let audit = Audit::new(Uuid::new_v4(), Instant::now());
    let guard = audit.begin(origin(), desc()).unwrap();
    let copy = audit.clone();
    let (ready, started) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let _guard = guard;
        ready.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    started.await.unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    let wire::Reply::Info {
        through_cursor,
        active_attempts,
        record_failures,
        persistent,
        ..
    } = copy.query(wire::View::Info {}).unwrap()
    else {
        panic!()
    };
    assert_eq!(active_attempts, 0);
    assert_eq!(record_failures, 0);
    assert!(!persistent);
    let wire::Reply::Page { page, .. } = copy
        .query(wire::View::Page {
            cursor: 0,
            through_cursor,
            limit: 128,
        })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events[1].phase, Phase::Abandoned {});
}

#[tokio::test]
async fn real_pipe_write_failure_preserves_recorded_result_without_claiming_peer_received() {
    let security = crate::security::PipeSecurity::current_user().unwrap();
    let name = crate::security::pipe_name(&Uuid::new_v4().to_string()).unwrap();
    let mut server = security.create(&name, true).unwrap();
    let peer = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&name)
        .unwrap();
    server.connect().await.unwrap();
    assert_eq!(peer_pid(&server), Some(std::process::id()));
    drop(peer);
    let audit = Audit::new(Uuid::new_v4(), Instant::now());
    let guard = audit.begin(origin(), desc()).unwrap();
    guard.returned(Ok(())).unwrap();
    assert!(
        write_response(
            &mut server,
            guard,
            &session_protocol::Response::Ok {
                id: 1,
                reply: session_protocol::Reply::Ok
            }
        )
        .await
        .is_err()
    );
    let wire::Reply::Info {
        through_cursor,
        active_attempts,
        record_failures,
        ..
    } = audit.query(wire::View::Info {}).unwrap()
    else {
        panic!()
    };
    assert_eq!(active_attempts, 0);
    assert_eq!(record_failures, 0);
    let wire::Reply::Page { page, .. } = audit
        .query(wire::View::Page {
            cursor: 0,
            through_cursor,
            limit: 128,
        })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(page.events[1].phase, Phase::ReturnedOk {});
    assert!(matches!(
        page.events[2].phase,
        Phase::IoFailure {
            stage: IoStage::ReplyWrite,
            ..
        }
    ));
    assert!(
        page.events
            .iter()
            .all(|e| e.phase != Phase::ReplyWritten {})
    );
}
#[test]
fn capacity_failures_are_explicit_and_never_silently_dispatch_an_unrecorded_attempt() {
    let audit = Audit::new(Uuid::new_v4(), Instant::now());
    let mut guards = Vec::new();
    for _ in 0..MAX_ACTIVE {
        guards.push(audit.begin(origin(), desc()).unwrap());
    }
    assert!(audit.begin(origin(), desc()).is_err());
    let wire::Reply::Info {
        active_attempts,
        record_failures,
        ..
    } = audit.query(wire::View::Info {}).unwrap()
    else {
        panic!()
    };
    assert_eq!(active_attempts, 64);
    assert_eq!(record_failures, 1);
    drop(guards);
    let wire::Reply::Info {
        active_attempts,
        record_failures,
        ..
    } = audit.query(wire::View::Info {}).unwrap()
    else {
        panic!()
    };
    assert_eq!(active_attempts, 0);
    assert_eq!(record_failures, 1);
    assert!(
        audit
            .query(wire::View::Page {
                cursor: 0,
                through_cursor: u64::MAX,
                limit: 128
            })
            .is_err()
    );
    let wire::Reply::Info {
        record_failures, ..
    } = audit.query(wire::View::Info {}).unwrap()
    else {
        panic!()
    };
    assert_eq!(record_failures, 1);
}
