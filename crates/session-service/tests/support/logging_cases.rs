use super::*;
use session_protocol::logging::{self as log, Request as L};
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
