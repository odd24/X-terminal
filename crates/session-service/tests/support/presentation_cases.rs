use super::*;
const TEXT_PAGE: usize = session_core::presentation::MIN_TEXT_PAGE;

#[tokio::test]
async fn derived_views_survive_clients_but_never_cross_scope_revocation_or_generation() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let first = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let hidden = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let token = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![first],
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
    ok(desktop
        .request(Request::AppendFixture {
            connection: first,
            bytes: "共享屏幕\r\n".as_bytes().to_vec(),
        })
        .await
        .unwrap());
    // No desktop process/renderer owns these views; reconnecting the IPC client keeps state.
    drop(desktop);
    match ok(observer
        .request(Request::Screen { connection: first })
        .await
        .unwrap())
    {
        Reply::Screen(screen) => {
            assert_eq!(screen.contents, "共享屏幕");
            assert_eq!(screen.parser, "vt100-0.18.1+local.2");
            assert!(screen.resize_reflow);
        }
        _ => panic!(),
    }
    match ok(observer
        .request(Request::ReadText {
            connection: first,
            cursor: 1,
            max_bytes: TEXT_PAGE,
        })
        .await
        .unwrap())
    {
        Reply::Text(page) => {
            assert_eq!(page.events[0].text, "共享屏幕\r\n");
            assert_eq!(page.events[0].source_seq, Some(1));
        }
        _ => panic!(),
    }
    for request in [
        Request::Screen { connection: hidden },
        Request::ReadText {
            connection: hidden,
            cursor: 1,
            max_bytes: TEXT_PAGE,
        },
    ] {
        assert_eq!(
            error(observer.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let mut desktop = fixture.connect().await;
    let next = reference(ok(desktop
        .request(Request::ReconnectFixture { connection: first })
        .await
        .unwrap()));
    for request in [
        Request::Screen { connection: first },
        Request::ReadText {
            connection: first,
            cursor: 1,
            max_bytes: TEXT_PAGE,
        },
    ] {
        assert_eq!(
            error(desktop.request(request).await.unwrap()),
            ErrorCode::StaleGeneration
        );
    }
    for request in [
        Request::Screen { connection: next },
        Request::ReadText {
            connection: next,
            cursor: 1,
            max_bytes: TEXT_PAGE,
        },
    ] {
        assert_eq!(
            error(observer.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    match ok(desktop
        .request(Request::Screen { connection: next })
        .await
        .unwrap())
    {
        Reply::Screen(screen) => {
            assert!(screen.contents.is_empty());
            assert_eq!(screen.source_cursor, 1);
        }
        _ => panic!(),
    }
    let ticket = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![next],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket {
            token, ticket_id, ..
        } => (token, ticket_id),
        _ => panic!(),
    };
    let (mut next_observer, _) = Client::connect(&fixture.instance, ticket.0.expose(), fixture.pid)
        .await
        .unwrap();
    ok(desktop
        .request(Request::AppendFixture {
            connection: next,
            bytes: vec![0xe4],
        })
        .await
        .unwrap());
    ok(desktop
        .request(Request::CloseFixture { connection: next })
        .await
        .unwrap());
    match ok(next_observer
        .request(Request::ReadText {
            connection: next,
            cursor: 1,
            max_bytes: TEXT_PAGE,
        })
        .await
        .unwrap())
    {
        Reply::Text(page) => {
            assert!(page.completed);
            assert_eq!(page.events.len(), 2);
            assert!(page.events[1].decode_error);
            assert_eq!(page.events[1].text, "�");
            assert_eq!(page.events[1].source_seq, None);
        }
        _ => panic!(),
    }
    ok(desktop
        .request(Request::Revoke {
            ticket_id: ticket.1,
        })
        .await
        .unwrap());
    for request in [
        Request::Screen { connection: next },
        Request::ReadText {
            connection: next,
            cursor: 1,
            max_bytes: TEXT_PAGE,
        },
    ] {
        assert_eq!(
            error(next_observer.request(request).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn ssh_transport_updates_service_screen_size_and_incremental_text_without_gui() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let id = Uuid::new_v4();
    ssh_call(
        &mut client,
        ssh::Request::Resize {
            connection,
            request_id: id,
            cols: 101,
            rows: 31,
        },
    )
    .await;
    input_status(&mut client, connection, id, |r| {
        r.state == session_core::input::InputState::PipelineQueued
    })
    .await;
    remote.push(&[0xe4]).await;
    remote.push(&[0xb8, 0xad]).await;
    timeout(Duration::from_secs(4), async {
        loop {
            if let Reply::Screen(screen) = ok(client
                .request(Request::Screen { connection })
                .await
                .unwrap())
                && screen.contents.contains('中')
            {
                assert_eq!((screen.rows, screen.cols), (31, 101));
                assert_eq!(screen.encoding, "utf-8");
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    match ok(client
        .request(Request::ReadText {
            connection,
            cursor: 1,
            max_bytes: MAX_APPEND,
        })
        .await
        .unwrap())
    {
        Reply::Text(page) => {
            assert!(
                page.events
                    .iter()
                    .map(|e| e.text.as_str())
                    .collect::<String>()
                    .contains('中')
            );
            assert!(page.events.iter().all(|e| !e.decode_error));
        }
        _ => panic!(),
    }
    fixture.stop(&mut client).await;
}

#[tokio::test]
async fn ssh_resize_reflows_physical_screen_over_ipc_without_rewriting_output() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut client = fixture.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    async fn resize(client: &mut Client, connection: ConnectionRef, cols: u32) {
        let id = Uuid::new_v4();
        ssh_call(
            client,
            ssh::Request::Resize {
                connection,
                request_id: id,
                cols,
                rows: 6,
            },
        )
        .await;
        input_status(client, connection, id, |r| {
            r.state == session_core::input::InputState::PipelineQueued
        })
        .await;
    }
    resize(&mut client, connection, 12).await;
    remote.push(b"\x1bc\x1b[3Jabcdefghijklmnop\r\nnext").await;
    timeout(Duration::from_secs(4), async {
        loop {
            if let Reply::Screen(screen) = ok(client
                .request(Request::Screen { connection })
                .await
                .unwrap())
                && screen.contents.ends_with("next")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let raw_before = ok(client
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: MAX_APPEND,
        })
        .await
        .unwrap());
    let text_before = ok(client
        .request(Request::ReadText {
            connection,
            cursor: 1,
            max_bytes: MAX_APPEND,
        })
        .await
        .unwrap());
    resize(&mut client, connection, 6).await;
    match ok(client
        .request(Request::Screen { connection })
        .await
        .unwrap())
    {
        Reply::Screen(screen) => {
            assert_eq!(screen.contents, "abcdef\nghijkl\nmnop\nnext");
            assert_eq!(
                (
                    screen.rows,
                    screen.cols,
                    screen.cursor_row,
                    screen.cursor_col
                ),
                (6, 6, 3, 4)
            );
            assert_eq!(screen.parser, "vt100-0.18.1+local.2");
            assert!(screen.resize_reflow);
            assert_eq!((screen.gap_bytes, screen.decode_error_events), (0, 0));
        }
        _ => panic!(),
    }
    assert_eq!(
        serde_json::to_value(ok(client
            .request(Request::Read {
                connection,
                cursor: 1,
                max_bytes: MAX_APPEND
            })
            .await
            .unwrap()))
        .unwrap(),
        serde_json::to_value(raw_before).unwrap()
    );
    assert_eq!(
        serde_json::to_value(ok(client
            .request(Request::ReadText {
                connection,
                cursor: 1,
                max_bytes: MAX_APPEND
            })
            .await
            .unwrap()))
        .unwrap(),
        serde_json::to_value(text_before).unwrap()
    );
    resize(&mut client, connection, 12).await;
    match ok(client
        .request(Request::Screen { connection })
        .await
        .unwrap())
    {
        Reply::Screen(screen) => assert_eq!(screen.contents, "abcdefghijkl\nmnop\nnext"),
        _ => panic!(),
    }
    remote.push(b"\x1b[?1049habcdefghijklmnop\r\nend").await;
    timeout(Duration::from_secs(4), async {
        loop {
            if let Reply::Screen(screen) = ok(client
                .request(Request::Screen { connection })
                .await
                .unwrap())
                && screen.alternate
                && screen.contents.ends_with("end")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    resize(&mut client, connection, 6).await;
    match ok(client
        .request(Request::Screen { connection })
        .await
        .unwrap())
    {
        Reply::Screen(screen) => {
            assert!(screen.alternate);
            assert_eq!(screen.contents, "abcdef\nmnop\nend");
        }
        _ => panic!(),
    }
    fixture.stop(&mut client).await;
}
