use super::*;
#[tokio::test]
async fn queued_preview_intent_survives_caller_abort_until_the_message_is_released() {
    let (sender, receiver) = mpsc::sync_channel::<Message>(1);
    let gate = Arc::new(std::sync::Barrier::new(2));
    let child_gate = gate.clone();
    let worker = Arc::new(Worker {
        sender,
        thread: std::thread::spawn(move || {
            child_gate.wait();
            drop(receiver);
        }),
        reserved: Arc::new(AtomicBool::new(false)),
        pending: Arc::new(AtomicUsize::new(0)),
    });
    let caller = worker.clone();
    let task = tokio::spawn(async move {
        caller
            .request(
                None,
                Request::CleanupPreview {
                    kind: K::Log,
                    id: Uuid::new_v4(),
                    preview_id: Uuid::new_v4(),
                },
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while worker.pending.load(Ordering::Acquire) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(worker.reserved());
    task.abort();
    let _ = task.await;
    assert!(
        worker.reserved(),
        "the accepted queued message still reserves control operations"
    );
    gate.wait();
    tokio::time::timeout(Duration::from_secs(5), async {
        while worker.pending.load(Ordering::Acquire) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!worker.reserved());
    Arc::try_unwrap(worker)
        .unwrap_or_else(|_| panic!("caller still owns cleanup worker"))
        .close()
        .await
        .unwrap();
}
#[tokio::test]
async fn accepted_commit_with_dropped_response_still_updates_registry_and_releases_snapshot() {
    let temp = Temp::new();
    let exports = export::Worker::start().unwrap();
    let inner = Arc::new(Mutex::new(Inner::default()));
    let root = ManagedRoot::open(&temp.0).unwrap();
    let metadata = terminal_log::Metadata {
        connection: ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        },
        protocol: Protocol::Serial,
        encoding: "utf-8".into(),
        started_at_ms: 1,
        source_cursor: 1,
        text_cursor: 1,
    };
    let limits = wire::Limits {
        segment_bytes: 131072,
        segments: 2,
    };
    let mut logger = Logger::start(
        root.path().to_path_buf(),
        metadata.clone(),
        terminal_log::Limits {
            segment_bytes: limits.segment_bytes,
            segments: limits.segments,
        },
    )
    .unwrap();
    let status = logger.join();
    assert!(status.durable);
    let id = status.log_id;
    inner.lock().unwrap().entries.insert(
        id,
        super::super::Entry {
            logger: Arc::new(logger),
            metadata,
            limits,
        },
    );
    let worker = Worker::start(inner.clone(), exports.access(), Store::test_store()).unwrap();
    let p = info(
        worker
            .request(
                Some(temp.0.clone()),
                Request::CleanupPreview {
                    kind: K::Log,
                    id,
                    preview_id: Uuid::new_v4(),
                },
            )
            .await
            .unwrap(),
    );
    let (reply, receiver) = oneshot::channel();
    drop(receiver);
    worker
        .sender
        .try_send(Message {
            directory: None,
            request: Request::CleanupCommit {
                kind: K::Log,
                id,
                preview_id: p.preview_id,
                confirmation: p.confirmation.unwrap(),
            },
            reply,
            _pending: None,
        })
        .unwrap_or_else(|_| panic!("cleanup commit queue unavailable"));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !root.path().join(id.to_string()).exists()
                && inner.lock().unwrap().removed.contains(&id)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    worker.close().await.unwrap();
    exports.close().await.unwrap();
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-cleanup-service-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn log(&self) -> Uuid {
        let root = ManagedRoot::open(&self.0).unwrap();
        let id = Uuid::new_v4();
        std::fs::create_dir(root.path().join(id.to_string())).unwrap();
        std::fs::write(
            root.path().join(id.to_string()).join("completion.partial"),
            b"synthetic",
        )
        .unwrap();
        id
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
                .starts_with("shared-terminal-cleanup-service-中文-")
        );
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn info(reply: Reply) -> wire::CleanupInfo {
    let Reply::Cleanup(info) = reply else {
        panic!()
    };
    *info
}
fn ordered(stamp: u64) -> Uuid {
    Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | 1)
}
fn state(exports: &export::Worker) -> State {
    State {
        entries: HashMap::new(),
        window: RequestWindow::default(),
        reserved: Arc::new(AtomicBool::new(false)),
        inner: Arc::new(Mutex::new(Inner::default())),
        exports: exports.access(),
        store: Store::test_store(),
    }
}
fn preview(
    state: &mut State,
    temp: &Temp,
    id: Uuid,
    preview_id: Uuid,
    now: Instant,
) -> wire::CleanupInfo {
    info(
        state
            .handle(
                Some(temp.0.clone()),
                Request::CleanupPreview {
                    kind: K::Log,
                    id,
                    preview_id,
                },
                now,
            )
            .unwrap(),
    )
}

#[tokio::test]
async fn confirmation_scope_expiry_cancel_and_duplicate_commit_never_reopen_or_redelete() {
    let temp = Temp::new();
    let exports = export::Worker::start().unwrap();
    let mut state = state(&exports);
    let now = Instant::now();
    let id = temp.log();
    let preview_id = Uuid::new_v4();
    let original = preview(&mut state, &temp, id, preview_id, now);
    let token = original.confirmation.unwrap();
    assert!(state.reserved.load(Ordering::Acquire));
    assert_eq!(original.files.len(), 1);
    assert_eq!(
        preview(
            &mut state,
            &temp,
            id,
            preview_id,
            now + Duration::from_secs(1)
        )
        .confirmation,
        Some(token)
    );
    for request in [
        Request::CleanupCommit {
            kind: K::Log,
            id,
            preview_id,
            confirmation: Uuid::new_v4(),
        },
        Request::CleanupCancel {
            kind: K::Export,
            id,
            preview_id,
        },
        Request::CleanupStatus {
            kind: K::Log,
            id: Uuid::new_v4(),
            preview_id,
        },
    ] {
        assert_eq!(
            state.handle(None, request, now).unwrap_err(),
            ErrorCode::InvalidArgument
        );
    }
    let cancelled = info(
        state
            .handle(
                None,
                Request::CleanupCancel {
                    kind: K::Log,
                    id,
                    preview_id,
                },
                now,
            )
            .unwrap(),
    );
    assert_eq!(cancelled.phase, P::Cancelled);
    assert!(!state.reserved.load(Ordering::Acquire));
    assert_eq!(
        state
            .handle(
                None,
                Request::CleanupCommit {
                    kind: K::Log,
                    id,
                    preview_id,
                    confirmation: token
                },
                now
            )
            .unwrap_err(),
        ErrorCode::RequestExpired
    );
    assert_eq!(
        preview(&mut state, &temp, id, preview_id, now).phase,
        P::Cancelled
    );
    let expired = preview(&mut state, &temp, id, Uuid::new_v4(), now);
    state.reap(now + TTL);
    assert!(!state.reserved.load(Ordering::Acquire));
    assert_eq!(
        state
            .handle(
                None,
                Request::CleanupCommit {
                    kind: K::Log,
                    id,
                    preview_id: expired.preview_id,
                    confirmation: expired.confirmation.unwrap()
                },
                now + TTL
            )
            .unwrap_err(),
        ErrorCode::RequestExpired
    );
    let live = preview(&mut state, &temp, id, Uuid::new_v4(), now + TTL);
    let commit = || Request::CleanupCommit {
        kind: K::Log,
        id,
        preview_id: live.preview_id,
        confirmation: live.confirmation.unwrap(),
    };
    let applied = info(state.handle(None, commit(), now + TTL).unwrap());
    assert!(applied.report.unwrap().directory_removed);
    let path = temp.0.join("terminal-logs").join(id.to_string());
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("completion.partial"), b"new-sentinel").unwrap();
    assert_eq!(
        info(state.handle(None, commit(), now + TTL).unwrap()).phase,
        P::Applied
    );
    assert_eq!(
        std::fs::read(path.join("completion.partial")).unwrap(),
        b"new-sentinel"
    );
    drop(state);
    exports.close().await.unwrap();
}

#[tokio::test]
async fn four_snapshots_and_bounded_receipts_preserve_opaque_ids_and_retire_ordered_closed_ids() {
    let temp = Temp::new();
    let exports = export::Worker::start().unwrap();
    let mut state = state(&exports);
    let now = Instant::now();
    let mut scopes = Vec::new();
    for _ in 0..PREVIEWS {
        let id = temp.log();
        let pid = Uuid::new_v4();
        preview(&mut state, &temp, id, pid, now);
        scopes.push((id, pid));
    }
    assert_eq!(
        state
            .handle(
                Some(temp.0.clone()),
                Request::CleanupPreview {
                    kind: K::Log,
                    id: temp.log(),
                    preview_id: Uuid::new_v4()
                },
                now
            )
            .unwrap_err(),
        ErrorCode::CapacityExceeded
    );
    state.reap(now + TTL);
    assert!(!state.reserved.load(Ordering::Acquire));
    let id = scopes[0].0;
    for stamp in 1..=(RECEIPTS - PREVIEWS) as u64 {
        let pid = ordered(stamp);
        preview(&mut state, &temp, id, pid, now + TTL);
        state
            .handle(
                None,
                Request::CleanupCancel {
                    kind: K::Log,
                    id,
                    preview_id: pid,
                },
                now + TTL,
            )
            .unwrap();
    }
    assert_eq!(state.entries.len(), RECEIPTS);
    let newer = ordered(200);
    preview(&mut state, &temp, id, newer, now + TTL);
    assert_eq!(
        state
            .handle(
                None,
                Request::CleanupStatus {
                    kind: K::Log,
                    id,
                    preview_id: ordered(1)
                },
                now + TTL
            )
            .unwrap_err(),
        ErrorCode::RequestExpired
    );
    assert_eq!(
        info(
            state
                .handle(
                    None,
                    Request::CleanupStatus {
                        kind: K::Log,
                        id: scopes[0].0,
                        preview_id: scopes[0].1
                    },
                    now + TTL
                )
                .unwrap()
        )
        .phase,
        P::Expired
    );
    drop(state);
    exports.close().await.unwrap();
}
