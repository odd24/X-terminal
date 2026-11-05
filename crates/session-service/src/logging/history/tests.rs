use super::*;
use session_core::presentation::TextEvent;
pub(super) struct Temp(pub(super) PathBuf);
impl Temp {
    pub(super) fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-history-中文-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-history-")
        );
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
pub(super) fn completed(temp: &Temp, huge: bool) -> (Uuid, ConnectionRef) {
    let root = ManagedRoot::open(&temp.0).unwrap();
    let connection = ConnectionRef {
        connection_id: ConnectionId(Uuid::new_v4()),
        generation: 3,
    };
    let metadata = Metadata {
        connection,
        protocol: Protocol::Serial,
        encoding: "utf-8".into(),
        started_at_ms: 1,
        source_cursor: 1,
        text_cursor: 1,
    };
    let mut logger = Logger::start(
        root.path().to_path_buf(),
        metadata,
        terminal_log::Limits::default(),
    )
    .unwrap();
    for seq in 1..=8 {
        assert!(logger.submit(terminal_log::Record {
            connection,
            raw: Some(OutputEvent {
                seq,
                timestamp_ms: seq,
                bytes: if huge {
                    vec![255; EVENT_BYTES]
                } else {
                    vec![seq as u8]
                },
                gap_bytes: None
            }),
            text: TextEvent {
                seq,
                source_seq: Some(seq),
                timestamp_ms: seq,
                text: if huge {
                    "\0".repeat(16 * 1024)
                } else {
                    format!("row-{seq}")
                },
                gap_bytes: None,
                decode_error: false
            },
        }));
    }
    logger.stop();
    let status = logger.join();
    assert!(status.durable);
    (status.log_id, connection)
}
fn open(
    state: &mut State,
    temp: &Temp,
    id: Uuid,
    connection: ConnectionRef,
    read_id: Uuid,
) -> Result<Reply, ErrorCode> {
    state.handle(
        Some(temp.0.clone()),
        Request::HistoryOpen {
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
) -> Result<wire::HistoryPage, ErrorCode> {
    match state.handle(
        None,
        Request::HistoryRead {
            connection,
            log_id: id,
            read_id,
            cursor,
            max_records: count,
            max_bytes: 64 * 1024,
        },
    )? {
        Reply::HistoryPage(page) => Ok(*page),
        _ => panic!(),
    }
}
#[test]
fn scoped_pages_retry_once_without_advance_and_closed_ids_never_reopen() {
    let temp = Temp::new();
    let (id, connection) = completed(&temp, false);
    let mut state = State::default();
    let read_id = Uuid::new_v4();
    open(&mut state, &temp, id, connection, read_id).unwrap();
    open(&mut state, &temp, id, connection, read_id).unwrap();
    let first = read(&mut state, id, connection, read_id, 1, 2).unwrap();
    let duplicate = read(&mut state, id, connection, read_id, 1, 2).unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(duplicate).unwrap()
    );
    assert_eq!(first.next_cursor, 3);
    assert_eq!(
        read(&mut state, id, connection, read_id, 1, 3).unwrap_err(),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        read(&mut state, id, connection, read_id, 4, 2).unwrap_err(),
        ErrorCode::InvalidArgument
    );
    read(&mut state, id, connection, read_id, 3, 2).unwrap();
    assert_eq!(
        read(&mut state, id, connection, read_id, 1, 2).unwrap_err(),
        ErrorCode::RequestExpired
    );
    let wrong = ConnectionRef {
        generation: 4,
        ..connection
    };
    assert!(open(&mut state, &temp, id, wrong, read_id).is_err());
    assert!(read(&mut state, Uuid::new_v4(), connection, read_id, 5, 2).is_err());
    for _ in 0..2 {
        state
            .handle(
                None,
                Request::HistoryClose {
                    connection,
                    log_id: id,
                    read_id,
                },
            )
            .unwrap();
    }
    assert!(matches!(
        open(&mut state, &temp, id, connection, read_id),
        Err(ErrorCode::RequestExpired)
    ));
    assert_eq!(
        read(&mut state, id, connection, read_id, 5, 2).unwrap_err(),
        ErrorCode::RequestExpired
    );
}
#[test]
fn handle_quota_and_idle_expiry_release_files_but_preserve_closed_receipts() {
    let temp = Temp::new();
    let (id, connection) = completed(&temp, false);
    let mut state = State::default();
    let ids: Vec<_> = (0..9).map(|_| Uuid::new_v4()).collect();
    for key in &ids[..8] {
        open(&mut state, &temp, id, connection, *key).unwrap();
    }
    assert!(matches!(
        open(&mut state, &temp, id, connection, ids[8]),
        Err(ErrorCode::CapacityExceeded)
    ));
    let path = temp
        .0
        .join("terminal-logs")
        .join(id.to_string())
        .join("0000000000000001.rawlog");
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
    state.reap(Instant::now() + IDLE);
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_ok());
    assert_eq!(state.entries.len(), 8);
    assert!(matches!(
        open(&mut state, &temp, id, connection, ids[0]),
        Err(ErrorCode::RequestExpired)
    ));
    open(&mut state, &temp, id, connection, ids[8]).unwrap();
}
#[test]
fn ordered_closed_receipts_retire_with_watermark_while_opaque_ids_stay_pinned() {
    let temp = Temp::new();
    let (id, connection) = completed(&temp, false);
    let mut state = State::default();
    let metadata = info(&ArchiveReader::inspect(&ManagedRoot::open(&temp.0).unwrap(), id).unwrap());
    let ordered = |n: u64| Uuid::from_u128((u128::from(n) << 80) | 0x7000_8000_0000_0000_0001);
    for n in 100..228 {
        state.entries.insert(
            ordered(n),
            Entry {
                scope: Scope {
                    connection,
                    log_id: id,
                },
                reader: None,
                info: metadata.clone(),
                cursor: 1,
                last: None,
                touched: Instant::now(),
            },
        );
    }
    state.reserve(ordered(228)).unwrap();
    assert_eq!(
        state.window.check(ordered(100)),
        Err(ErrorCode::RequestExpired)
    );
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
                reader: None,
                info: metadata.clone(),
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
fn escaped_text_and_raw_arrays_fit_real_ipc_frames_until_verified_final_page() {
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
            serde_json::to_vec(&Reply::HistoryPage(Box::new(page.clone())))
                .unwrap()
                .len()
                < session_protocol::MAX_FRAME - 512
        );
        for row in &page.records {
            assert_eq!(row.raw.as_ref().unwrap().bytes, vec![255; EVENT_BYTES]);
            assert_eq!(row.text.text.len(), 16 * 1024);
        }
        assert!(format!("{page:?}").contains("HistoryRecord([TERMINAL_CONTENT])"));
        assert!(!format!("{page:?}").contains("\\0"));
        total += page.records.len();
        cursor = page.next_cursor;
        if page.finished {
            break;
        }
    }
    assert_eq!((total, cursor), (8, 9));
}
