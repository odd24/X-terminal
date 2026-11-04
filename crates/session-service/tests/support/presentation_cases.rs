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
            assert_eq!(screen.parser, "vt100-0.18.1+local.1");
            assert!(!screen.resize_reflow);
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
