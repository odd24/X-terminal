use super::*;
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "shared-terminal-log-service-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
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
                .starts_with("shared-terminal-log-service-")
        );
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn connection(store: &Arc<Mutex<Store>>) -> ConnectionRef {
    let mut store = store.lock().unwrap();
    let initial = store.sessions.create(Protocol::Serial).unwrap();
    let reference = store
        .sessions
        .begin_connect(initial.reference())
        .unwrap()
        .reference();
    store
        .sessions
        .configure_output(reference, "gbk", 24, 80)
        .unwrap();
    store
        .sessions
        .transition(reference, State::Connected)
        .unwrap();
    reference
}
fn limits() -> wire::Limits {
    wire::Limits {
        segment_bytes: 131072,
        segments: 2,
    }
}

#[tokio::test]
async fn start_status_is_query_only_and_readable_target_is_frozen_service_metadata() {
    let temp = Temp::new();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let store = Store::test_store();
    let manager = Manager::new(store.clone(), config.access()).unwrap();
    let connection = connection(&store);
    let request_id = Uuid::new_v4();
    assert_eq!(
        manager
            .handle(Request::StartStatus {
                connection,
                request_id
            })
            .await
            .unwrap_err(),
        ErrorCode::NotFound
    );
    assert_eq!(
        store
            .lock()
            .unwrap()
            .sessions
            .capture_id(connection)
            .unwrap(),
        None
    );
    let Reply::Info(first) = manager
        .handle_named(
            Request::Start {
                connection,
                request_id,
                limits: limits(),
            },
            Some("192.168.10.250".into()),
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    let log_id = first.log_id;
    let query = loop {
        let Reply::Info(info) = manager
            .handle(Request::StartStatus {
                connection,
                request_id,
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        if info.readable.is_some() {
            break info;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    };
    let name = query.readable.unwrap().filename;
    assert!(name.starts_with("192.168.10.250_"));
    assert!(name.ends_with(".log"));
    let Reply::Info(duplicate) = manager
        .handle_named(
            Request::Start {
                connection,
                request_id,
                limits: limits(),
            },
            Some("changed-label".into()),
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(duplicate.log_id, log_id);
    assert_eq!(duplicate.readable.unwrap().filename, name);
    assert_eq!(
        manager
            .handle(Request::StartStatus {
                connection: ConnectionRef {
                    generation: connection.generation + 1,
                    ..connection
                },
                request_id
            })
            .await
            .unwrap_err(),
        ErrorCode::InvalidArgument
    );
    manager
        .handle(Request::Stop { connection, log_id })
        .await
        .unwrap();
    let Reply::Info(query) = manager
        .handle(Request::StartStatus {
            connection,
            request_id,
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(query.log_id, log_id);
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
async fn failed_without_directory(
    manager: &Manager,
    path: &std::path::Path,
    connection: ConnectionRef,
    request_id: Uuid,
) -> Uuid {
    let metadata = Metadata {
        connection,
        protocol: Protocol::Serial,
        encoding: "gbk".into(),
        started_at_ms: 1,
        source_cursor: 1,
        text_cursor: 1,
    };
    let logger = Arc::new(
        Logger::start(
            path.to_path_buf(),
            metadata.clone(),
            terminal_log::Limits {
                segment_bytes: limits().segment_bytes,
                segments: limits().segments,
            },
        )
        .unwrap(),
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !logger.status().worker_finished {
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(logger.status().phase, terminal_log::Phase::Failed);
    let id = logger.status().log_id;
    assert!(!path.join(id.to_string()).exists());
    let mut inner = manager.inner.lock().unwrap();
    inner.entries.insert(
        id,
        Entry {
            logger: logger.clone(),
            metadata,
            limits: limits(),
        },
    );
    inner.starts.insert(
        request_id,
        (
            Start {
                connection,
                limits: limits(),
            },
            id,
        ),
    );
    manager
        .store
        .lock()
        .unwrap()
        .sessions
        .attach_capture(connection, id, Arc::new(Sink { logger, connection }))
        .unwrap();
    id
}
#[tokio::test]
async fn capture_inventory_finds_directoryless_failures_after_reconnect_and_connection_removal() {
    let temp = Temp::new();
    let blocked = temp.0.join("合成失败根");
    std::fs::write(&blocked, b"keep").unwrap();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let store = Store::test_store();
    let manager = Manager::new(store.clone(), config.access()).unwrap();
    let original = connection(&store);
    let id = failed_without_directory(&manager, &blocked, original, Uuid::new_v4()).await;
    {
        let mut store = store.lock().unwrap();
        store.sessions.transition(original, State::Failed).unwrap();
        let next = store.sessions.begin_connect(original).unwrap().reference();
        store.sessions.transition(next, State::Connected).unwrap();
        store.sessions.transition(next, State::Failed).unwrap();
        store.sessions.remove(next).unwrap();
    }
    let Reply::List { logs } = manager.handle(Request::CaptureList {}).await.unwrap() else {
        panic!()
    };
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].log_id, id);
    assert_eq!(logs[0].connection, original);
    assert!(!logs[0].active);
    assert!(matches!(logs[0].phase, wire::Phase::Failed));
    manager
        .handle(Request::ReleaseFailed {
            connection: logs[0].connection,
            log_id: id,
        })
        .await
        .unwrap();
    let Reply::List { logs } = manager.handle(Request::CaptureList {}).await.unwrap() else {
        panic!()
    };
    assert!(matches!(logs[0].phase, wire::Phase::Released));
    assert!(!blocked.join(id.to_string()).exists());
    assert_eq!(std::fs::read(blocked).unwrap(), b"keep");
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
#[tokio::test]
async fn release_failed_without_a_directory_preserves_failure_and_never_detaches_a_new_capture() {
    let temp = Temp::new();
    let blocked = temp.0.join("合成不可用目录");
    std::fs::write(&blocked, b"synthetic sentinel").unwrap();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let store = Store::test_store();
    let manager = Manager::new(store.clone(), config.access()).unwrap();
    let connection = connection(&store);
    let request_id = Uuid::new_v4();
    let log_id = failed_without_directory(&manager, &blocked, connection, request_id).await;
    let wrong = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    assert_eq!(
        manager
            .handle(Request::ReleaseFailed {
                connection: wrong,
                log_id
            })
            .await
            .unwrap_err(),
        ErrorCode::NotFound
    );
    let Reply::Info(released) = manager
        .handle(Request::ReleaseFailed { connection, log_id })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(released.phase, wire::Phase::Released));
    assert!(!released.active && !released.durable);
    assert!(released.failure.is_some());
    let Reply::Info(duplicate) = manager
        .handle(Request::Start {
            connection,
            request_id,
            limits: limits(),
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(duplicate.log_id, log_id);
    assert!(matches!(duplicate.phase, wire::Phase::Released));
    let Reply::Info(live) = manager
        .handle(Request::Start {
            connection,
            request_id: Uuid::new_v4(),
            limits: limits(),
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        manager
            .handle(Request::ReleaseFailed {
                connection,
                log_id: live.log_id
            })
            .await
            .unwrap_err(),
        ErrorCode::InvalidState
    );
    manager
        .handle(Request::ReleaseFailed { connection, log_id })
        .await
        .unwrap();
    assert_eq!(
        store
            .lock()
            .unwrap()
            .sessions
            .capture_id(connection)
            .unwrap(),
        Some(live.log_id)
    );
    assert_eq!(std::fs::read(&blocked).unwrap(), b"synthetic sentinel");
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
#[tokio::test]
async fn released_failed_receipts_retire_only_ordered_ids_without_inventing_file_deletion() {
    let temp = Temp::new();
    let blocked = temp.0.join("合成失败根");
    std::fs::write(&blocked, b"keep").unwrap();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let store = Store::test_store();
    let manager = Manager::new(store.clone(), config.access()).unwrap();
    let connection = connection(&store);
    let opaque = Uuid::new_v4();
    let mut first = None;
    for n in 0..64u128 {
        let id = if n == 0 {
            opaque
        } else {
            Uuid::from_u128((n << 80) | 0x7000_8000_0000_0000_0000)
        };
        let log_id = failed_without_directory(&manager, &blocked, connection, id).await;
        manager
            .handle(Request::ReleaseFailed { connection, log_id })
            .await
            .unwrap();
        if n == 1 {
            first = Some(id);
        }
    }
    let next = Uuid::from_u128((100u128 << 80) | 0x7000_8000_0000_0000_0000);
    manager
        .handle(Request::Start {
            connection,
            request_id: next,
            limits: limits(),
        })
        .await
        .unwrap();
    assert_eq!(
        manager
            .handle(Request::Start {
                connection,
                request_id: first.unwrap(),
                limits: limits()
            })
            .await
            .unwrap_err(),
        ErrorCode::RequestExpired
    );
    let Reply::Info(old) = manager
        .handle(Request::Start {
            connection,
            request_id: opaque,
            limits: limits(),
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(old.phase, wire::Phase::Released));
    {
        let inner = manager.inner.lock().unwrap();
        assert_eq!(inner.starts.len(), 64);
        assert_eq!(inner.entries.len(), 64);
        assert!(inner.removed.is_empty());
    }
    assert_eq!(std::fs::read(&blocked).unwrap(), b"keep");
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
#[tokio::test]
async fn canonical_gap_and_failed_connection_flush_are_recorded_without_an_exit_code() {
    let temp = Temp::new();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let store = Store::test_store();
    let manager = Manager::new(store.clone(), config.access()).unwrap();
    let connection = connection(&store);
    let Reply::Info(info) = manager
        .handle(Request::Start {
            connection,
            request_id: Uuid::new_v4(),
            limits: limits(),
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    let id = info.log_id;
    {
        let mut store = store.lock().unwrap();
        store.sessions.append(connection, &[0xd6], 1).unwrap();
        store.sessions.append(connection, &[0xd0], 2).unwrap();
        store.sessions.mark_gap(connection, 13, 3).unwrap();
        store.sessions.append(connection, b"tail\xd6", 4).unwrap();
        store
            .sessions
            .transition(connection, State::Failed)
            .unwrap();
    }
    let done = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let Reply::Info(info) = manager
                .handle(Request::Status {
                    connection,
                    log_id: id,
                })
                .await
                .unwrap()
            else {
                panic!()
            };
            if info.worker_finished {
                break info;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert!(done.durable && done.natural_end && !done.active);
    assert_eq!(done.source_gap_bytes, 13);
    assert_eq!(done.accepted_records, 5);
    assert_eq!(done.written_records, 5);
    assert_eq!(done.encoding, "gbk");
    let directory = temp.0.join("terminal-logs").join(id.to_string());
    let lines = std::fs::read_to_string(directory.join("0000000000000001.text.jsonl")).unwrap();
    let values: Vec<serde_json::Value> = lines
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(values[2]["event"]["text"], "中");
    assert_eq!(values[3]["event"]["gap_bytes"], 13);
    assert_eq!(values[5]["event"]["text"], "�");
    assert_eq!(values[5]["event"]["decode_error"], true);
    assert!(!lines.contains("exit_code"));
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
#[tokio::test]
async fn preexisting_log_directories_bound_new_capture_without_clearing_history() {
    let temp = Temp::new();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let store = Store::test_store();
    let manager = Manager::new(store.clone(), config.access()).unwrap();
    let connection = connection(&store);
    let root = terminal_log::ManagedRoot::open(&temp.0).unwrap();
    for _ in 0..64 {
        std::fs::create_dir(root.path().join(Uuid::new_v4().to_string())).unwrap();
    }
    assert_eq!(
        manager
            .handle(Request::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: limits()
            })
            .await
            .unwrap_err(),
        ErrorCode::CapacityExceeded
    );
    assert_eq!(root.ids().unwrap().len(), 64);
    assert_eq!(
        store
            .lock()
            .unwrap()
            .sessions
            .capture_id(connection)
            .unwrap(),
        None
    );
    drop(root);
    manager.close().await.unwrap();
    config.close().await.unwrap();
}
