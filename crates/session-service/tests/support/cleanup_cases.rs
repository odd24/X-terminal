use super::*;
use session_protocol::logging::{self as log, Request as L};
const KIND: log::CleanupKind = log::CleanupKind::Log;
fn cleanup_temp() -> ConfigTemp {
    let path = std::env::temp_dir().join(format!(
        "shared-terminal-cleanup-ipc-中文-{}",
        Uuid::new_v4()
    ));
    assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
    assert!(
        path.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("shared-terminal-cleanup-ipc-中文-")
    );
    std::fs::create_dir(&path).unwrap();
    ConfigTemp(path)
}
#[tokio::test]
async fn capture_inventory_survives_connection_reconnect_and_removal_but_not_service_restart() {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let captured = capture(&mut client, connection, Uuid::new_v4()).await;
    let next = reference(ok(client
        .request(Request::ReconnectFixture { connection })
        .await
        .unwrap()));
    ok(client
        .request(Request::CloseFixture { connection: next })
        .await
        .unwrap());
    ok(client
        .request(Request::RemoveFixture { connection: next })
        .await
        .unwrap());
    let log::Reply::List { logs } = call(&mut client, L::CaptureList {}).await else {
        panic!()
    };
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].log_id, captured.log_id);
    assert_eq!(logs[0].connection, connection);
    assert!(!logs[0].active);
    let expected = std::fs::read(
        temp.0
            .join("terminal-logs")
            .join(captured.log_id.to_string())
            .join("completion.json"),
    )
    .unwrap();
    fixture.stop(&mut client).await;
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let log::Reply::List { logs } = call(&mut client, L::CaptureList {}).await else {
        panic!()
    };
    assert!(logs.is_empty());
    assert_eq!(
        std::fs::read(
            temp.0
                .join("terminal-logs")
                .join(captured.log_id.to_string())
                .join("completion.json")
        )
        .unwrap(),
        expected
    );
    fixture.stop(&mut client).await;
}
#[tokio::test]
async fn release_failed_is_desktop_scoped_metadata_only_and_does_not_detach_a_new_capture() {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let request_id = Uuid::new_v4();
    let started = loginfo(
        call(
            &mut client,
            L::Start {
                connection,
                request_id,
                limits: limits(),
            },
        )
        .await,
    );
    let release = || L::ReleaseFailed {
        connection,
        log_id: started.log_id,
    };
    assert_eq!(
        error(
            client
                .request(Request::Logging { request: release() })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    let Reply::ReadTicket { token, .. } = ok(client
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 60000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let mut observer = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap()
        .0;
    assert_eq!(
        error(
            observer
                .request(Request::Logging {
                    request: L::CaptureList {}
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            observer
                .request(Request::Logging { request: release() })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let directory = temp
        .0
        .join("terminal-logs")
        .join(started.log_id.to_string());
    timeout(Duration::from_secs(5), async {
        while !directory.join("0000000000000001.rawlog").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    std::fs::write(
        directory.join("0000000000000002.rawlog"),
        b"synthetic rotation collision",
    )
    .unwrap();
    for _ in 0..24 {
        ok(client
            .request(Request::AppendFixture {
                connection,
                bytes: vec![b'x'; 4096],
            })
            .await
            .unwrap());
    }
    let failed = timeout(Duration::from_secs(5), async {
        loop {
            let info = loginfo(
                call(
                    &mut client,
                    L::Status {
                        connection,
                        log_id: started.log_id,
                    },
                )
                .await,
            );
            if info.worker_finished {
                break info;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(failed.phase, log::Phase::Failed));
    assert!(failed.active);
    let files = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (path.clone(), std::fs::read(path).unwrap())
        })
        .collect::<Vec<_>>();
    let wrong = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::ReleaseFailed {
                        connection: wrong,
                        log_id: started.log_id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    let released = loginfo(call(&mut client, release()).await);
    assert!(matches!(released.phase, log::Phase::Released));
    assert!(!released.active && !released.durable);
    assert_eq!(released.written_records, failed.written_records);
    assert_eq!(released.written_raw_bytes, failed.written_raw_bytes);
    assert!(released.failure.is_some());
    assert!(matches!(
        loginfo(
            call(
                &mut client,
                L::Start {
                    connection,
                    request_id,
                    limits: limits()
                }
            )
            .await
        )
        .phase,
        log::Phase::Released
    ));
    for (path, bytes) in &files {
        assert_eq!(std::fs::read(path).unwrap(), *bytes);
    }
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), files.len());
    let live = loginfo(
        call(
            &mut client,
            L::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: limits(),
            },
        )
        .await,
    );
    call(&mut client, release()).await;
    assert!(
        loginfo(
            call(
                &mut client,
                L::Status {
                    connection,
                    log_id: live.log_id
                }
            )
            .await
        )
        .active
    );
    // File cleanup remains separately authorized and can supersede RELEASED.
    let snapshot = preview(&mut client, KIND, started.log_id).await;
    assert!(
        commit(&mut client, &snapshot)
            .await
            .report
            .unwrap()
            .directory_removed
    );
    assert!(matches!(
        loginfo(call(&mut client, release()).await).phase,
        log::Phase::Removed
    ));
    assert!(
        loginfo(
            call(
                &mut client,
                L::Status {
                    connection,
                    log_id: live.log_id
                }
            )
            .await
        )
        .active
    );
    fixture.stop(&mut client).await;
}
#[tokio::test]
async fn cleanup_detaches_only_a_finished_failed_capture_and_allows_recording_again() {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let started = loginfo(
        call(
            &mut client,
            L::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: limits(),
            },
        )
        .await,
    );
    let directory = temp
        .0
        .join("terminal-logs")
        .join(started.log_id.to_string());
    timeout(Duration::from_secs(5), async {
        while !directory.join("0000000000000001.rawlog").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    std::fs::write(
        directory.join("0000000000000002.rawlog"),
        b"synthetic rotation collision",
    )
    .unwrap();
    for _ in 0..24 {
        ok(client
            .request(Request::AppendFixture {
                connection,
                bytes: vec![b'x'; 4096],
            })
            .await
            .unwrap());
    }
    let failed = timeout(Duration::from_secs(5), async {
        loop {
            let info = loginfo(
                call(
                    &mut client,
                    L::Status {
                        connection,
                        log_id: started.log_id,
                    },
                )
                .await,
            );
            if info.worker_finished {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(failed.phase, log::Phase::Failed));
    assert!(failed.active);
    let p = preview(&mut client, KIND, started.log_id).await;
    assert!(
        commit(&mut client, &p)
            .await
            .report
            .unwrap()
            .directory_removed
    );
    let next = capture(&mut client, connection, Uuid::new_v4()).await;
    assert_ne!(next.log_id, started.log_id);
    // Cleaning an older stopped log must not detach a different live capture.
    let live = loginfo(
        call(
            &mut client,
            L::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: limits(),
            },
        )
        .await,
    );
    let old = preview(&mut client, KIND, next.log_id).await;
    commit(&mut client, &old).await;
    assert!(
        loginfo(
            call(
                &mut client,
                L::Status {
                    connection,
                    log_id: live.log_id
                }
            )
            .await
        )
        .active
    );
    call(
        &mut client,
        L::Stop {
            connection,
            log_id: live.log_id,
        },
    )
    .await;
    fixture.stop(&mut client).await;
}
fn limits() -> log::Limits {
    log::Limits {
        segment_bytes: 131072,
        segments: 2,
    }
}
async fn call(client: &mut Client, request: L) -> log::Reply {
    let Reply::Logging(reply) = ok(client.request(Request::Logging { request }).await.unwrap())
    else {
        panic!()
    };
    reply
}
fn cleanup(reply: log::Reply) -> log::CleanupInfo {
    let log::Reply::Cleanup(info) = reply else {
        panic!()
    };
    *info
}
fn loginfo(reply: log::Reply) -> log::Info {
    let log::Reply::Info(info) = reply else {
        panic!()
    };
    *info
}
fn exportinfo(reply: log::Reply) -> log::ExportInfo {
    let log::Reply::Export(info) = reply else {
        panic!()
    };
    *info
}
async fn capture(client: &mut Client, connection: ConnectionRef, request_id: Uuid) -> log::Info {
    let first = loginfo(
        call(
            client,
            L::Start {
                connection,
                request_id,
                limits: limits(),
            },
        )
        .await,
    );
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"synthetic\0\xff\r\n".to_vec(),
        })
        .await
        .unwrap());
    call(
        client,
        L::Stop {
            connection,
            log_id: first.log_id,
        },
    )
    .await;
    timeout(Duration::from_secs(5), async {
        loop {
            let info = loginfo(
                call(
                    client,
                    L::Status {
                        connection,
                        log_id: first.log_id,
                    },
                )
                .await,
            );
            if info.worker_finished {
                assert!(info.durable);
                return info;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
async fn preview(client: &mut Client, kind: log::CleanupKind, id: Uuid) -> log::CleanupInfo {
    cleanup(
        call(
            client,
            L::CleanupPreview {
                kind,
                id,
                preview_id: Uuid::new_v4(),
            },
        )
        .await,
    )
}
async fn commit(client: &mut Client, info: &log::CleanupInfo) -> log::CleanupInfo {
    cleanup(
        call(
            client,
            L::CleanupCommit {
                kind: info.kind,
                id: info.id,
                preview_id: info.preview_id,
                confirmation: info.confirmation.unwrap(),
            },
        )
        .await,
    )
}
async fn export_done(
    client: &mut Client,
    connection: ConnectionRef,
    log_id: Uuid,
    request_id: Uuid,
) -> log::ExportInfo {
    call(
        client,
        L::ExportStart {
            connection,
            log_id,
            request_id,
        },
    )
    .await;
    timeout(Duration::from_secs(5), async {
        loop {
            let info = exportinfo(
                call(
                    client,
                    L::ExportStatus {
                        connection,
                        log_id,
                        request_id,
                    },
                )
                .await,
            );
            if info.phase == log::ExportPhase::Completed {
                return info;
            }
            assert!(!matches!(
                info.phase,
                log::ExportPhase::Failed | log::ExportPhase::Cancelled
            ));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
fn ordered(stamp: u64) -> Uuid {
    Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | 1)
}

#[tokio::test]
async fn cleanup_is_desktop_only_and_exact_preview_commit_invalidates_without_replaying_captures() {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let start = Uuid::new_v4();
    let captured = capture(&mut client, connection, start).await;
    let id = captured.log_id;
    let Reply::ReadTicket { token, .. } = ok(client
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 60000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let mut observer = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap()
        .0;
    let pid = Uuid::new_v4();
    for request in [
        L::CleanupList { kind: KIND },
        L::CleanupPreview {
            kind: KIND,
            id,
            preview_id: pid,
        },
        L::CleanupStatus {
            kind: KIND,
            id,
            preview_id: pid,
        },
        L::CleanupCancel {
            kind: KIND,
            id,
            preview_id: pid,
        },
        L::CleanupCommit {
            kind: KIND,
            id,
            preview_id: pid,
            confirmation: Uuid::new_v4(),
        },
    ] {
        assert_eq!(
            error(
                observer
                    .request(Request::Logging { request })
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    let read_id = Uuid::new_v4();
    call(
        &mut client,
        L::HistoryOpen {
            connection,
            log_id: id,
            read_id,
        },
    )
    .await;
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::CleanupPreview {
                        kind: KIND,
                        id,
                        preview_id: pid
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    call(
        &mut client,
        L::HistoryClose {
            connection,
            log_id: id,
            read_id,
        },
    )
    .await;
    let frozen = cleanup(
        call(
            &mut client,
            L::CleanupPreview {
                kind: KIND,
                id,
                preview_id: pid,
            },
        )
        .await,
    );
    assert_eq!(frozen.phase, log::CleanupPhase::Preview);
    assert_eq!(frozen.files.len(), 3);
    let mut nonowner = temp.start().await;
    let mut nonowner_client = nonowner.connect().await;
    for request in [
        L::CleanupList {
            kind: log::CleanupKind::Export,
        },
        L::CleanupPreview {
            kind: log::CleanupKind::Export,
            id: Uuid::new_v4(),
            preview_id: Uuid::new_v4(),
        },
    ] {
        assert_eq!(
            error(
                nonowner_client
                    .request(Request::Logging { request })
                    .await
                    .unwrap()
            ),
            ErrorCode::InvalidState
        );
    }
    nonowner.stop(&mut nonowner_client).await;
    assert_eq!(
        cleanup(
            call(
                &mut client,
                L::CleanupPreview {
                    kind: KIND,
                    id,
                    preview_id: pid
                }
            )
            .await
        )
        .confirmation,
        frozen.confirmation
    );
    for request in [
        L::Start {
            connection,
            request_id: Uuid::new_v4(),
            limits: limits(),
        },
        L::ExportStart {
            connection,
            log_id: id,
            request_id: Uuid::new_v4(),
        },
        L::CleanupCommit {
            kind: KIND,
            id,
            preview_id: pid,
            confirmation: Uuid::new_v4(),
        },
    ] {
        let expected = if matches!(request, L::CleanupCommit { .. }) {
            ErrorCode::InvalidArgument
        } else {
            ErrorCode::InvalidState
        };
        assert_eq!(
            error(client.request(Request::Logging { request }).await.unwrap()),
            expected
        );
    }
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"input-still-live".to_vec(),
        })
        .await
        .unwrap());
    let result = commit(&mut client, &frozen).await;
    let report = result.report.unwrap();
    assert!(report.directory_removed && report.failure.is_none());
    assert_eq!(report.removed_files, 3);
    let removed = loginfo(
        call(
            &mut client,
            L::Status {
                connection,
                log_id: id,
            },
        )
        .await,
    );
    assert!(matches!(removed.phase, log::Phase::Removed));
    assert!(!removed.durable && !removed.active);
    let original = loginfo(
        call(
            &mut client,
            L::Start {
                connection,
                request_id: start,
                limits: limits(),
            },
        )
        .await,
    );
    assert_eq!(original.log_id, id);
    assert!(matches!(original.phase, log::Phase::Removed));
    let path = temp.0.join("terminal-logs").join(id.to_string());
    assert!(!path.exists());
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("completion.partial"), b"new-sentinel").unwrap();
    assert!(
        commit(&mut client, &frozen)
            .await
            .report
            .unwrap()
            .directory_removed
    );
    assert_eq!(
        std::fs::read(path.join("completion.partial")).unwrap(),
        b"new-sentinel"
    );
    fixture.stop(&mut client).await;
}

#[tokio::test]
async fn cleanup_export_preserves_source_and_marks_receipts_removed_without_recreating_artifacts() {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let captured = capture(&mut client, connection, Uuid::new_v4()).await;
    let request_id = Uuid::new_v4();
    export_done(&mut client, connection, captured.log_id, request_id).await;
    let source = temp
        .0
        .join("terminal-logs")
        .join(captured.log_id.to_string())
        .join("completion.json");
    let bytes = std::fs::read(&source).unwrap();
    let p = preview(&mut client, log::CleanupKind::Export, request_id).await;
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.files[0].name, "export.jsonl");
    assert!(
        commit(&mut client, &p)
            .await
            .report
            .unwrap()
            .directory_removed
    );
    let result = exportinfo(
        call(
            &mut client,
            L::ExportStatus {
                connection,
                log_id: captured.log_id,
                request_id,
            },
        )
        .await,
    );
    assert_eq!(result.phase, log::ExportPhase::Removed);
    assert!(result.bytes.is_none());
    assert_eq!(
        exportinfo(
            call(
                &mut client,
                L::ExportStart {
                    connection,
                    log_id: captured.log_id,
                    request_id
                }
            )
            .await
        )
        .phase,
        log::ExportPhase::Removed
    );
    assert!(
        !temp
            .0
            .join("terminal-log-exports")
            .join(request_id.to_string())
            .exists()
    );
    assert_eq!(std::fs::read(source).unwrap(), bytes);
    export_done(&mut client, connection, captured.log_id, Uuid::new_v4()).await;
    fixture.stop(&mut client).await;
}

#[tokio::test]
async fn cleanup_expiry_and_service_exit_release_handles_without_deleting_or_accepting_stale_confirmation()
 {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let captured = capture(&mut client, connection, Uuid::new_v4()).await;
    let p = preview(&mut client, KIND, captured.log_id).await;
    let file = temp
        .0
        .join("terminal-logs")
        .join(captured.log_id.to_string())
        .join("completion.json");
    assert!(std::fs::read(&file).is_err());
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_secs(10)).await;
        ok(client.request(Request::Ping {}).await.unwrap());
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let expired = cleanup(
        call(
            &mut client,
            L::CleanupStatus {
                kind: KIND,
                id: p.id,
                preview_id: p.preview_id,
            },
        )
        .await,
    );
    assert_eq!(expired.phase, log::CleanupPhase::Expired);
    assert!(expired.confirmation.is_none());
    assert!(std::fs::read(&file).is_ok());
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::CleanupCommit {
                        kind: KIND,
                        id: p.id,
                        preview_id: p.preview_id,
                        confirmation: p.confirmation.unwrap()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::RequestExpired
    );
    preview(&mut client, KIND, captured.log_id).await;
    fixture.stop(&mut client).await;
    assert!(std::fs::read(&file).is_ok());
}

#[tokio::test]
async fn cleaned_capture_receipts_retire_ordered_windows_but_keep_opaque_ids_without_replay() {
    let temp = cleanup_temp();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let opaque = Uuid::new_v4();
    let first = capture(&mut client, connection, opaque).await;
    let p = preview(&mut client, KIND, first.log_id).await;
    commit(&mut client, &p).await;
    for stamp in 1..=68 {
        let captured = capture(&mut client, connection, ordered(stamp)).await;
        let p = preview(&mut client, KIND, captured.log_id).await;
        assert!(
            commit(&mut client, &p)
                .await
                .report
                .unwrap()
                .directory_removed
        );
    }
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::Start {
                        connection,
                        request_id: ordered(1),
                        limits: limits()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::RequestExpired
    );
    assert!(matches!(
        loginfo(
            call(
                &mut client,
                L::Start {
                    connection,
                    request_id: opaque,
                    limits: limits()
                }
            )
            .await
        )
        .phase,
        log::Phase::Removed
    ));
    assert_eq!(
        std::fs::read_dir(temp.0.join("terminal-logs"))
            .unwrap()
            .count(),
        0
    );
    fixture.stop(&mut client).await;
}
