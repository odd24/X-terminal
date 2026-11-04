use super::*;
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let p =
            std::env::temp_dir().join(format!("shared-terminal-log-service-{}", Uuid::new_v4()));
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
