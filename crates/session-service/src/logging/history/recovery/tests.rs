use super::super::tests::{Temp, completed};
use super::*;
fn open(
    state: &mut State,
    temp: &Temp,
    id: Uuid,
    connection: ConnectionRef,
    read_id: Uuid,
) -> Result<Reply, ErrorCode> {
    state.handle(
        Some(temp.0.clone()),
        Request::RecoveryOpen {
            connection,
            log_id: id,
            read_id,
        },
    )
}
fn read(
    state: &mut State,
    id: Uuid,
    connection: ConnectionRef,
    read_id: Uuid,
    cursor: u64,
    count: u32,
) -> Result<wire::RecoveryPage, ErrorCode> {
    match state.handle(
        None,
        Request::RecoveryRead {
            connection,
            log_id: id,
            read_id,
            cursor,
            max_records: count,
            max_bytes: 65536,
        },
    )? {
        Reply::RecoveryPage(page) => Ok(*page),
        _ => panic!(),
    }
}
#[test]
fn recovery_pages_preserve_prefix_retry_scope_and_explicit_close_without_normal_fallback() {
    let temp = Temp::new();
    let (id, connection) = completed(&temp, false);
    let dir = temp.0.join("terminal-logs").join(id.to_string());
    std::fs::remove_file(dir.join("completion.json")).unwrap();
    let text = dir.join("0000000000000001.text.jsonl");
    let bytes = std::fs::read(&text).unwrap();
    std::fs::write(&text, &bytes[..bytes.len() - 1]).unwrap();
    let mut state = State::default();
    let read_id = Uuid::new_v4();
    let Reply::RecoveryList { logs } = state
        .handle(Some(temp.0.clone()), Request::RecoveryList {})
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(logs[0].info.as_ref().unwrap().connection, connection);
    assert!(!logs[0].info.as_ref().unwrap().completion_present);
    open(&mut state, &temp, id, connection, read_id).unwrap();
    let first = read(&mut state, id, connection, read_id, 1, 2).unwrap();
    let retry = read(&mut state, id, connection, read_id, 1, 2).unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(retry).unwrap()
    );
    assert_eq!(first.next_cursor, 3);
    assert_eq!(
        read(&mut state, id, connection, read_id, 1, 3).unwrap_err(),
        ErrorCode::InvalidArgument
    );
    assert!(
        open(
            &mut state,
            &temp,
            id,
            ConnectionRef {
                generation: 4,
                ..connection
            },
            read_id
        )
        .is_err()
    );
    let last = read(&mut state, id, connection, read_id, 3, 128).unwrap();
    assert_eq!(last.records.len(), 5);
    assert_eq!(last.next_cursor, 8);
    assert_eq!(
        last.stop.as_ref().unwrap().kind,
        wire::RecoveryStopKind::TruncatedRecord
    );
    assert!(ArchiveReader::open(&ManagedRoot::open(&temp.0).unwrap(), id, connection).is_err());
    assert!(read(&mut state, id, connection, read_id, 1, 2).is_err());
    state
        .handle(
            None,
            Request::RecoveryClose {
                connection,
                log_id: id,
                read_id,
            },
        )
        .unwrap();
    assert!(matches!(
        open(&mut state, &temp, id, connection, read_id),
        Err(ErrorCode::RequestExpired)
    ));
    assert!(std::fs::OpenOptions::new().write(true).open(&text).is_ok());
}
#[test]
fn recovery_quota_expiry_and_retirement_do_not_reopen_old_or_opaque_receipts() {
    let temp = Temp::new();
    let (id, connection) = completed(&temp, false);
    let mut state = State::default();
    let keys: Vec<_> = (0..5).map(|_| Uuid::new_v4()).collect();
    for key in &keys[..4] {
        open(&mut state, &temp, id, connection, *key).unwrap();
    }
    assert!(matches!(
        open(&mut state, &temp, id, connection, keys[4]),
        Err(ErrorCode::CapacityExceeded)
    ));
    state.reap(Instant::now() + IDLE);
    assert!(matches!(
        open(&mut state, &temp, id, connection, keys[0]),
        Err(ErrorCode::RequestExpired)
    ));
    open(&mut state, &temp, id, connection, keys[4]).unwrap();
    let metadata = state.entries[&keys[4]].info.clone();
    state.entries.clear();
    let ordered = |n: u64| Uuid::from_u128((u128::from(n) << 80) | 0x7000_8000_0000_0000_0001);
    for n in 100..164 {
        state.entries.insert(
            ordered(n),
            Entry {
                scope: Scope {
                    connection,
                    log_id: id,
                },
                info: metadata.clone(),
                reader: None,
                cursor: 1,
                last: None,
                touched: Instant::now(),
            },
        );
    }
    state.reserve(ordered(164)).unwrap();
    assert!(matches!(
        open(&mut state, &temp, id, connection, ordered(100)),
        Err(ErrorCode::RequestExpired)
    ));
    state.entries.clear();
    for _ in 0..RECEIPTS {
        state.entries.insert(
            Uuid::new_v4(),
            Entry {
                scope: Scope {
                    connection,
                    log_id: id,
                },
                info: metadata.clone(),
                reader: None,
                cursor: 1,
                last: None,
                touched: Instant::now(),
            },
        );
    }
    assert_eq!(
        state.reserve(ordered(300)),
        Err(ErrorCode::CapacityExceeded)
    );
    assert_eq!(state.entries.len(), RECEIPTS);
}
#[test]
fn recovery_worst_case_pages_fit_real_frame_and_keep_stable_end_report() {
    let temp = Temp::new();
    let (id, connection) = completed(&temp, true);
    let mut state = State::default();
    let read_id = Uuid::new_v4();
    open(&mut state, &temp, id, connection, read_id).unwrap();
    let mut cursor = 1;
    let mut total = 0;
    loop {
        let page = read(&mut state, id, connection, read_id, cursor, 128).unwrap();
        assert!(
            serde_json::to_vec(&Reply::RecoveryPage(Box::new(page.clone())))
                .unwrap()
                .len()
                < session_protocol::MAX_FRAME - 512
        );
        assert!(!format!("{page:?}").contains("\\0"));
        total += page.records.len();
        cursor = page.next_cursor;
        if let Some(stop) = page.stop {
            assert_eq!(stop.kind, wire::RecoveryStopKind::EndOfAvailable);
            let again = read(&mut state, id, connection, read_id, cursor, 128).unwrap();
            assert!(again.records.is_empty());
            assert_eq!(again.stop, Some(stop));
            break;
        }
    }
    assert_eq!((total, cursor), (8, 9));
}
