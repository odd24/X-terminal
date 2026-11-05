use super::*;
use session_protocol::logging::{self as log, Request as L};

#[tokio::test]
async fn recovery_ipc_reads_only_verified_prefix_after_restart_with_desktop_scope_and_retry() {
    let path = std::env::temp_dir().join(format!(
        "shared-terminal-service-config-中文-recovery-{}",
        Uuid::new_v4()
    ));
    std::fs::create_dir(&path).unwrap();
    let temp = ConfigTemp(path);
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let (connection, captured) = captured_fixture(&mut client).await;
    service.stop(&mut client).await;
    let log_id = captured.log_id;
    let dir = temp.0.join("terminal-logs").join(log_id.to_string());
    std::fs::remove_file(dir.join("completion.json")).unwrap();
    let text_path = dir.join("0000000000000001.text.jsonl");
    let bytes = std::fs::read(&text_path).unwrap();
    std::fs::write(&text_path, &bytes[..bytes.len() - 1]).unwrap();
    let raw_path = dir.join("0000000000000001.rawlog");
    let before_raw = std::fs::read(&raw_path).unwrap();
    let before_text = std::fs::read(&text_path).unwrap();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let fresh = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let Reply::ReadTicket { token, .. } = ok(client
        .request(Request::IssueRead {
            scopes: vec![fresh],
            lifetime_ms: 60000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    let read_id = Uuid::new_v4();
    for request in [
        L::RecoveryList {},
        L::RecoveryOpen {
            connection,
            log_id,
            read_id,
        },
        L::RecoveryRead {
            connection,
            log_id,
            read_id,
            cursor: 1,
            max_records: 128,
            max_bytes: 32768,
        },
        L::RecoveryClose {
            connection,
            log_id,
            read_id,
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
    let log::Reply::RecoveryList { logs } = call(&mut client, L::RecoveryList {}).await else {
        panic!()
    };
    assert_eq!(logs.len(), 1);
    let meta = logs[0].info.as_ref().unwrap();
    assert_eq!(meta.connection, connection);
    assert!(!meta.completion_present);
    assert_eq!(meta.available_from, 1);
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::HistoryOpen {
                        connection,
                        log_id,
                        read_id: Uuid::new_v4(),
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::RecoveryOpen {
                        connection: ConnectionRef {
                            generation: connection.generation + 1,
                            ..connection
                        },
                        log_id,
                        read_id,
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    for _ in 0..2 {
        assert!(matches!(
            call(
                &mut client,
                L::RecoveryOpen {
                    connection,
                    log_id,
                    read_id
                }
            )
            .await,
            log::Reply::RecoveryOpened { .. }
        ));
    }
    let mut pages = Vec::new();
    for _ in 0..2 {
        let log::Reply::RecoveryPage(page) = call(
            &mut client,
            L::RecoveryRead {
                connection,
                log_id,
                read_id,
                cursor: 1,
                max_records: 128,
                max_bytes: 32768,
            },
        )
        .await
        else {
            panic!()
        };
        assert_eq!(page.records.len(), 2);
        assert_eq!(
            page.records[0].raw.as_ref().unwrap().bytes,
            [0, 255, 13, 10]
        );
        assert_eq!(page.next_cursor, 3);
        let stop = page.stop.as_ref().unwrap();
        assert_eq!(stop.kind, log::RecoveryStopKind::TruncatedRecord);
        assert_eq!((stop.segment, stop.next_cursor), (1, 3));
        pages.push(serde_json::to_value(&page).unwrap());
    }
    assert_eq!(pages[0], pages[1]);
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::CleanupPreview {
                        kind: log::CleanupKind::Log,
                        id: log_id,
                        preview_id: Uuid::new_v4(),
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    assert!(
        std::fs::OpenOptions::new()
            .write(true)
            .open(&raw_path)
            .is_err()
    );
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::RecoveryRead {
                        connection: fresh,
                        log_id,
                        read_id,
                        cursor: 3,
                        max_records: 128,
                        max_bytes: 32768,
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    for _ in 0..2 {
        call(
            &mut client,
            L::RecoveryClose {
                connection,
                log_id,
                read_id,
            },
        )
        .await;
    }
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::RecoveryOpen {
                        connection,
                        log_id,
                        read_id,
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::RequestExpired
    );
    assert!(
        std::fs::OpenOptions::new()
            .write(true)
            .open(&raw_path)
            .is_ok()
    );
    assert_eq!(std::fs::read(&raw_path).unwrap(), before_raw);
    assert_eq!(std::fs::read(&text_path).unwrap(), before_text);
    assert!(!dir.join("completion.json").exists());
    service.stop(&mut client).await;
}

fn export_info(reply: log::Reply) -> log::ExportInfo {
    match reply {
        log::Reply::Export(info) => *info,
        _ => panic!(),
    }
}
async fn export_done(
    client: &mut Client,
    connection: ConnectionRef,
    log_id: Uuid,
    request_id: Uuid,
) -> log::ExportInfo {
    timeout(Duration::from_secs(10), async {
        loop {
            let result = export_info(
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
            if result.phase != log::ExportPhase::Completed {
                assert!(result.sha256.is_none());
            }
            if matches!(
                result.phase,
                log::ExportPhase::Completed
                    | log::ExportPhase::Failed
                    | log::ExportPhase::Cancelled
            ) {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn export_jobs_are_desktop_only_scoped_deduplicated_and_survive_source_restart() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let (connection, captured) = captured_fixture(&mut client).await;
    let log_id = captured.log_id;
    let request_id = Uuid::new_v4();
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
    for request in [
        L::ExportStart {
            connection,
            log_id,
            request_id,
        },
        L::ExportStatus {
            connection,
            log_id,
            request_id,
        },
        L::ExportCancel {
            connection,
            log_id,
            request_id,
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
    for _ in 0..2 {
        let value = export_info(
            call(
                &mut client,
                L::ExportStart {
                    connection,
                    log_id,
                    request_id,
                },
            )
            .await,
        );
        assert_eq!(value.request_id, request_id);
    }
    let done = export_done(&mut client, connection, log_id, request_id).await;
    assert_eq!(done.phase, log::ExportPhase::Completed);
    let hash = done.sha256.as_ref().unwrap();
    assert_eq!(hash.len(), 64);
    assert!(
        hash.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(done.retained_records, Some(3));
    assert_eq!(done.retained_raw_bytes, Some(15));
    assert_eq!(done.retained_gap_bytes, Some(0));
    let ready = temp
        .0
        .join("terminal-log-exports")
        .join(request_id.to_string())
        .join("export.jsonl");
    let original = std::fs::read(&ready).unwrap();
    assert_eq!(done.bytes, Some(original.len() as u64));
    let rows: Vec<serde_json::Value> = std::str::from_utf8(&original)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows[0]["source_completion"]["log_id"], log_id.to_string());
    assert_eq!(rows[1]["raw"]["bytes"], serde_json::json!([0, 255, 13, 10]));
    assert_eq!(rows.last().unwrap()["type"], "verified");
    let wrong = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    for request in [
        L::ExportStart {
            connection: wrong,
            log_id,
            request_id,
        },
        L::ExportStatus {
            connection: wrong,
            log_id,
            request_id,
        },
        L::ExportCancel {
            connection: wrong,
            log_id,
            request_id,
        },
    ] {
        assert_eq!(
            error(client.request(Request::Logging { request }).await.unwrap()),
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(
        export_info(
            call(
                &mut client,
                L::ExportCancel {
                    connection,
                    log_id,
                    request_id
                }
            )
            .await
        )
        .phase,
        log::ExportPhase::Completed
    );
    let mut nonowner = temp.start().await;
    let mut nonowner_client = nonowner.connect().await;
    assert_eq!(
        error(
            nonowner_client
                .request(Request::Logging {
                    request: L::ExportStart {
                        connection,
                        log_id,
                        request_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    nonowner.stop(&mut nonowner_client).await;
    fixture.stop(&mut client).await;
    let mut restarted = temp.start().await;
    let mut client = restarted.connect().await;
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::ExportStatus {
                        connection,
                        log_id,
                        request_id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    // A repeated ID after service restart cannot overwrite a prior artifact.
    call(
        &mut client,
        L::ExportStart {
            connection,
            log_id,
            request_id,
        },
    )
    .await;
    assert_eq!(
        export_done(&mut client, connection, log_id, request_id)
            .await
            .phase,
        log::ExportPhase::Failed
    );
    assert_eq!(std::fs::read(&ready).unwrap(), original);
    let fresh = Uuid::new_v4();
    call(
        &mut client,
        L::ExportStart {
            connection,
            log_id,
            request_id: fresh,
        },
    )
    .await;
    assert_eq!(
        export_done(&mut client, connection, log_id, fresh)
            .await
            .phase,
        log::ExportPhase::Completed
    );
    restarted.stop(&mut client).await;
}

#[tokio::test]
async fn export_jobs_report_corrupt_source_without_publishing_or_blocking_terminal_output() {
    use std::io::Write;
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let (connection, captured) = captured_fixture(&mut client).await;
    let log_id = captured.log_id;
    let path = temp
        .0
        .join("terminal-logs")
        .join(log_id.to_string())
        .join("0000000000000001.text.jsonl");
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"broken-synthetic-tail\n")
        .unwrap();
    let request_id = Uuid::new_v4();
    call(
        &mut client,
        L::ExportStart {
            connection,
            log_id,
            request_id,
        },
    )
    .await;
    let done = export_done(&mut client, connection, log_id, request_id).await;
    assert_eq!(done.phase, log::ExportPhase::Failed);
    assert_eq!(done.failure, Some(log::ExportFailure::InvalidSource));
    assert!(done.bytes.is_none() && done.retained_records.is_none());
    let directory = temp
        .0
        .join("terminal-log-exports")
        .join(request_id.to_string());
    assert!(!directory.join("export.jsonl").exists());
    assert!(directory.join("export.partial").exists());
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"terminal-still-responsive".to_vec(),
        })
        .await
        .unwrap());
    let Reply::Output(page) = ok(client
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(
        page.events
            .iter()
            .flat_map(|event| event.bytes.clone())
            .collect::<Vec<_>>()
            .ends_with(b"terminal-still-responsive")
    );
    // Repeated failed jobs stay failed and cannot create another partial.
    assert_eq!(
        export_info(
            call(
                &mut client,
                L::ExportStart {
                    connection,
                    log_id,
                    request_id
                }
            )
            .await
        )
        .phase,
        log::ExportPhase::Failed
    );
    fixture.stop(&mut client).await;
}
fn limits() -> log::Limits {
    log::Limits {
        segment_bytes: 131072,
        segments: 2,
    }
}
async fn call(client: &mut Client, request: L) -> log::Reply {
    match ok(client.request(Request::Logging { request }).await.unwrap()) {
        Reply::Logging(reply) => reply,
        _ => panic!(),
    }
}
fn info(reply: log::Reply) -> log::Info {
    match reply {
        log::Reply::Info(info) => *info,
        _ => panic!(),
    }
}
async fn settled(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
    predicate: impl Fn(&log::Info) -> bool,
) -> log::Info {
    timeout(Duration::from_secs(5), async {
        loop {
            let value = info(
                call(
                    client,
                    L::Status {
                        connection,
                        log_id: id,
                    },
                )
                .await,
            );
            if predicate(&value) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
fn records(temp: &ConfigTemp, id: Uuid) -> Vec<terminal_log::RawFrame> {
    let file = std::fs::File::open(
        temp.0
            .join("terminal-logs")
            .join(id.to_string())
            .join("0000000000000001.rawlog"),
    )
    .unwrap();
    let mut reader = terminal_log::RawReader::new(file).unwrap();
    let mut result = Vec::new();
    while let Some(record) = reader.next_record().unwrap() {
        result.push(record);
    }
    result
}
#[tokio::test]
async fn logging_is_desktop_only_deduplicated_and_bound_to_exact_output_windows() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let hidden = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"before-capture".to_vec(),
        })
        .await
        .unwrap());
    let request_id = Uuid::new_v4();
    let first = info(
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
    assert_eq!((first.source_cursor, first.text_cursor), (2, 2));
    assert_eq!(
        info(
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
        .log_id,
        first.log_id
    );
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::Start {
                        connection,
                        request_id,
                        limits: log::Limits {
                            segments: 1,
                            ..limits()
                        }
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    let token = match ok(client
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let (mut observer, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    for request in [
        L::List { connection },
        L::HistoryList {},
        L::HistoryOpen {
            connection,
            log_id: first.log_id,
            read_id: Uuid::new_v4(),
        },
        L::HistoryRead {
            connection,
            log_id: first.log_id,
            read_id: Uuid::new_v4(),
            cursor: 1,
            max_records: 1,
            max_bytes: 32768,
        },
        L::HistoryClose {
            connection,
            log_id: first.log_id,
            read_id: Uuid::new_v4(),
        },
        L::Status {
            connection,
            log_id: first.log_id,
        },
        L::Stop {
            connection,
            log_id: first.log_id,
        },
        L::Start {
            connection,
            request_id: Uuid::new_v4(),
            limits: limits(),
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
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::Status {
                        connection: hidden,
                        log_id: first.log_id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: vec![0, 255, 13, 10, 0xe4],
        })
        .await
        .unwrap());
    settled(&mut client, connection, first.log_id, |i| {
        i.written_records == 1
    })
    .await;
    info(
        call(
            &mut client,
            L::Stop {
                connection,
                log_id: first.log_id,
            },
        )
        .await,
    );
    let done = settled(&mut client, connection, first.log_id, |i| i.worker_finished).await;
    assert!(done.durable && !done.natural_end && !done.active);
    assert_eq!(done.written_raw_bytes, 5);
    let raw = records(&temp, first.log_id);
    assert_eq!(raw.len(), 1);
    assert_eq!(raw[0].bytes, vec![0, 255, 13, 10, 0xe4]);
    let second = info(
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
    assert_eq!(second.source_cursor, 3);
    info(
        call(
            &mut client,
            L::Stop {
                connection,
                log_id: first.log_id,
            },
        )
        .await,
    );
    assert!(
        info(
            call(
                &mut client,
                L::Status {
                    connection,
                    log_id: second.log_id
                }
            )
            .await
        )
        .active
    );
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: vec![0xb8, 0xad],
        })
        .await
        .unwrap());
    ok(client
        .request(Request::CloseFixture { connection })
        .await
        .unwrap());
    let end = settled(&mut client, connection, second.log_id, |i| {
        i.worker_finished
    })
    .await;
    assert!(end.durable && end.natural_end && !end.active);
    let next = reference(ok(client
        .request(Request::ReconnectFixture { connection })
        .await
        .unwrap()));
    assert!(
        matches!(call(&mut client,L::List{connection:next}).await,log::Reply::List{logs} if logs.is_empty())
    );
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::Start {
                        connection,
                        request_id: Uuid::new_v4(),
                        limits: limits()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::StaleGeneration
    );
    assert_eq!(
        info(
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
        .log_id,
        first.log_id
    );
    assert_eq!(
        std::fs::read_dir(temp.0.join("terminal-logs"))
            .unwrap()
            .count(),
        2
    );
    fixture.stop(&mut client).await;
}

#[tokio::test]
async fn a_log_file_failure_is_visible_while_the_shared_connection_keeps_working() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let started = info(
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
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"captured".to_vec(),
        })
        .await
        .unwrap());
    settled(&mut client, connection, started.log_id, |i| {
        i.written_records == 1
    })
    .await;
    std::fs::write(
        temp.0
            .join("terminal-logs")
            .join(started.log_id.to_string())
            .join("completion.partial"),
        b"collision-fixture",
    )
    .unwrap();
    call(
        &mut client,
        L::Stop {
            connection,
            log_id: started.log_id,
        },
    )
    .await;
    let failed = settled(&mut client, connection, started.log_id, |i| {
        i.worker_finished
    })
    .await;
    assert!(matches!(failed.phase, log::Phase::Failed));
    assert!(matches!(failed.failure, Some(log::Failure::Storage)));
    assert!(!failed.durable);
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"connection-continues".to_vec(),
        })
        .await
        .unwrap());
    match ok(client
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => assert!(
            page.events
                .iter()
                .flat_map(|e| e.bytes.clone())
                .collect::<Vec<_>>()
                .ends_with(b"connection-continues")
        ),
        _ => panic!(),
    }
    assert!(
        !temp
            .0
            .join("terminal-logs")
            .join(started.log_id.to_string())
            .join("completion.json")
            .exists()
    );
    fixture.stop(&mut client).await;
}

#[tokio::test]
async fn ssh_shell_logging_captures_actual_transport_bytes_and_closes_with_service() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let log = info(
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
    let probe = "SSH-LOG-PROBE 中文\r\n".as_bytes();
    remote.push(probe).await;
    timeout(Duration::from_secs(4), async {
        loop {
            if let Reply::Screen(screen) = ok(client
                .request(Request::Screen { connection })
                .await
                .unwrap())
                && screen.contents.contains("SSH-LOG-PROBE 中文")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    settled(&mut client, connection, log.log_id, |i| {
        i.written_raw_bytes >= probe.len() as u64
    })
    .await;
    fixture.stop(&mut client).await;
    let frames = records(&temp, log.log_id);
    assert!(
        frames
            .iter()
            .flat_map(|r| r.bytes.clone())
            .collect::<Vec<_>>()
            .ends_with(probe)
    );
    assert!(
        temp.0
            .join("terminal-logs")
            .join(log.log_id.to_string())
            .join("completion.json")
            .exists()
    );
}

async fn captured_fixture(client: &mut Client) -> (ConnectionRef, log::Info) {
    let connection = reference(ok(client.request(Request::CreateFixture {}).await.unwrap()));
    let started = info(
        call(
            client,
            L::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: limits(),
            },
        )
        .await,
    );
    for bytes in [vec![0, 255, 13, 10], b"second".to_vec(), b"third".to_vec()] {
        ok(client
            .request(Request::AppendFixture { connection, bytes })
            .await
            .unwrap());
    }
    call(
        client,
        L::Stop {
            connection,
            log_id: started.log_id,
        },
    )
    .await;
    let done = settled(client, connection, started.log_id, |i| i.worker_finished).await;
    assert!(done.durable);
    (connection, done)
}
async fn historical_page(
    client: &mut Client,
    connection: ConnectionRef,
    log_id: Uuid,
    read_id: Uuid,
    cursor: u64,
) -> log::HistoryPage {
    match call(
        client,
        L::HistoryRead {
            connection,
            log_id,
            read_id,
            cursor,
            max_records: 1,
            max_bytes: 32768,
        },
    )
    .await
    {
        log::Reply::HistoryPage(page) => *page,
        _ => panic!(),
    }
}
#[tokio::test]
async fn history_survives_process_restart_and_corrupt_configuration_without_replay() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let (connection, done) = captured_fixture(&mut client).await;
    fixture.stop(&mut client).await;
    let log_id = done.log_id;
    let unfinished = Uuid::new_v4();
    std::fs::create_dir(temp.0.join("terminal-logs").join(unfinished.to_string())).unwrap();
    let invalid = Uuid::new_v4();
    let invalid_dir = temp.0.join("terminal-logs").join(invalid.to_string());
    std::fs::create_dir(&invalid_dir).unwrap();
    std::fs::write(
        invalid_dir.join("completion.json"),
        b"invalid-synthetic-marker",
    )
    .unwrap();
    let mut restarted = temp.start().await;
    let mut desktop = restarted.connect().await;
    match call(&mut desktop, L::HistoryList {}).await {
        log::Reply::HistoryList { logs } => {
            assert_eq!(logs.len(), 3);
            let complete = logs.iter().find(|e| e.log_id == log_id).unwrap();
            assert!(matches!(complete.state, log::CatalogueState::HeaderChecked));
            assert_eq!(complete.info.as_ref().unwrap().connection, connection);
            assert!(matches!(
                logs.iter().find(|e| e.log_id == unfinished).unwrap().state,
                log::CatalogueState::Unfinished
            ));
            assert!(matches!(
                logs.iter().find(|e| e.log_id == invalid).unwrap().state,
                log::CatalogueState::Invalid
            ));
        }
        _ => panic!(),
    }
    let read_id = Uuid::new_v4();
    for _ in 0..2 {
        match call(
            &mut desktop,
            L::HistoryOpen {
                connection,
                log_id,
                read_id,
            },
        )
        .await
        {
            log::Reply::HistoryOpened { info, .. } => {
                assert_eq!(info.available_from, 1);
                assert_eq!(info.written_records, 3);
            }
            _ => panic!(),
        }
    }
    let first = historical_page(&mut desktop, connection, log_id, read_id, 1).await;
    let duplicate = historical_page(&mut desktop, connection, log_id, read_id, 1).await;
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(duplicate).unwrap()
    );
    assert_eq!(
        first.records[0].raw.as_ref().unwrap().bytes,
        [0, 255, 13, 10]
    );
    assert_eq!(first.records[0].text.text, "\0�\r\n");
    assert!(!first.finished);
    for cursor in 2..=3 {
        assert_eq!(
            historical_page(&mut desktop, connection, log_id, read_id, cursor)
                .await
                .records[0]
                .text
                .seq,
            cursor
        );
    }
    let end = historical_page(&mut desktop, connection, log_id, read_id, 4).await;
    assert!(end.finished && end.records.is_empty());
    assert_eq!(end.next_cursor, 4);
    let wrong = ConnectionRef {
        generation: connection.generation + 1,
        ..connection
    };
    assert_eq!(
        error(
            desktop
                .request(Request::Logging {
                    request: L::HistoryClose {
                        connection: wrong,
                        log_id,
                        read_id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        error(
            desktop
                .request(Request::Logging {
                    request: L::HistoryRead {
                        connection,
                        log_id,
                        read_id,
                        cursor: 1,
                        max_records: 1,
                        max_bytes: 32768
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::RequestExpired
    );
    for _ in 0..2 {
        call(
            &mut desktop,
            L::HistoryClose {
                connection,
                log_id,
                read_id,
            },
        )
        .await;
    }
    assert_eq!(
        error(
            desktop
                .request(Request::Logging {
                    request: L::HistoryOpen {
                        connection,
                        log_id,
                        read_id
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::RequestExpired
    );
    restarted.stop(&mut desktop).await;
    let corrupt_path = temp.0.join("config.sqlite");
    std::fs::write(&corrupt_path, b"synthetic-corrupt-config").unwrap();
    let mut recovering = temp.start().await;
    let mut desktop = recovering.connect().await;
    assert!(matches!(
        config_call(
            &mut desktop,
            config::ConfigRequest::Page {
                offset: 0,
                revision: None,
                folders: false
            }
        )
        .await,
        config::ConfigReply::Error {
            code: config::ConfigError::Corrupt
        }
    ));
    assert!(matches!(
        call(&mut desktop, L::HistoryList {}).await,
        log::Reply::HistoryList { .. }
    ));
    let fresh = Uuid::new_v4();
    call(
        &mut desktop,
        L::HistoryOpen {
            connection,
            log_id,
            read_id: fresh,
        },
    )
    .await;
    assert_eq!(
        historical_page(&mut desktop, connection, log_id, fresh, 1)
            .await
            .records[0]
            .raw
            .as_ref()
            .unwrap()
            .bytes,
        [0, 255, 13, 10]
    );
    recovering.stop(&mut desktop).await;
    assert_eq!(
        std::fs::read(corrupt_path).unwrap(),
        b"synthetic-corrupt-config"
    );
}

#[tokio::test]
async fn history_handles_are_bounded_and_released_at_explicit_close_or_service_exit() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let (connection, done) = captured_fixture(&mut client).await;
    let log_id = done.log_id;
    let mut second = temp.start().await;
    let mut other = second.connect().await;
    assert_eq!(
        error(
            other
                .request(Request::Logging {
                    request: L::HistoryList {}
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    assert_eq!(
        error(
            other
                .request(Request::Logging {
                    request: L::HistoryOpen {
                        connection,
                        log_id,
                        read_id: Uuid::new_v4()
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    second.stop(&mut other).await;
    let ids: Vec<_> = (0..9).map(|_| Uuid::new_v4()).collect();
    for key in &ids[..8] {
        call(
            &mut client,
            L::HistoryOpen {
                connection,
                log_id,
                read_id: *key,
            },
        )
        .await;
    }
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::HistoryOpen {
                        connection,
                        log_id,
                        read_id: ids[8]
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::CapacityExceeded
    );
    call(
        &mut client,
        L::HistoryOpen {
            connection,
            log_id,
            read_id: ids[0],
        },
    )
    .await;
    let file = temp
        .0
        .join("terminal-logs")
        .join(log_id.to_string())
        .join("0000000000000001.rawlog");
    assert!(std::fs::OpenOptions::new().write(true).open(&file).is_err());
    call(
        &mut client,
        L::HistoryClose {
            connection,
            log_id,
            read_id: ids[0],
        },
    )
    .await;
    call(
        &mut client,
        L::HistoryOpen {
            connection,
            log_id,
            read_id: ids[8],
        },
    )
    .await;
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"input-and-terminal-continue".to_vec(),
        })
        .await
        .unwrap());
    fixture.stop(&mut client).await;
    assert!(std::fs::OpenOptions::new().write(true).open(file).is_ok());
}

#[tokio::test]
async fn history_header_only_catalogue_does_not_hide_later_record_corruption() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let (connection, done) = captured_fixture(&mut client).await;
    let log_id = done.log_id;
    let text = temp
        .0
        .join("terminal-logs")
        .join(log_id.to_string())
        .join("0000000000000001.text.jsonl");
    let mut bytes = std::fs::read(&text).unwrap();
    bytes.pop();
    std::fs::write(text, bytes).unwrap();
    match call(&mut client, L::HistoryList {}).await {
        log::Reply::HistoryList { logs } => {
            assert!(matches!(logs[0].state, log::CatalogueState::HeaderChecked))
        }
        _ => panic!(),
    }
    let read_id = Uuid::new_v4();
    call(
        &mut client,
        L::HistoryOpen {
            connection,
            log_id,
            read_id,
        },
    )
    .await;
    for cursor in 1..=2 {
        historical_page(&mut client, connection, log_id, read_id, cursor).await;
    }
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::HistoryRead {
                        connection,
                        log_id,
                        read_id,
                        cursor: 3,
                        max_records: 1,
                        max_bytes: 32768
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::InvalidState
    );
    assert_eq!(
        error(
            client
                .request(Request::Logging {
                    request: L::HistoryRead {
                        connection,
                        log_id,
                        read_id,
                        cursor: 3,
                        max_records: 1,
                        max_bytes: 32768
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::RequestExpired
    );
    ok(client
        .request(Request::AppendFixture {
            connection,
            bytes: b"terminal-still-live".to_vec(),
        })
        .await
        .unwrap());
    fixture.stop(&mut client).await;
}
