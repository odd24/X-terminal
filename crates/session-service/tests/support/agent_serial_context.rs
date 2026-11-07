use super::*;
use session_core::context::{Reply as C, TimeWindow, View};

#[tokio::test]
async fn agent_serial_context_reads_the_shared_worker_echo_only_in_approved_window() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = connected(&mut desktop).await;
    call(&mut desktop, write(c, Uuid::new_v4(), b"scope-readable")).await;
    timeout(Duration::from_secs(3), async {
        while bytes(&mut desktop, c).await != b"scope-readable" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let Reply::Output(source) = ok(desktop
        .request(Request::Read {
            connection: c,
            cursor: 1,
            max_bytes: 65536,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let stamp = source.events.last().unwrap().timestamp_ms;
    let window = TimeWindow {
        from_ms: stamp,
        until_ms: stamp + 1,
    };
    let (_, token) = issue(
        &mut desktop,
        vec![Scope {
            target: Target::OutputWindow {
                connection: c,
                window,
            },
            action: Action::Read,
        }],
        30000,
    )
    .await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    for view in [
        View::Raw {
            through_cursor: source.next_cursor,
            cursor: 1,
            max_bytes: 65536,
        },
        View::Text {
            through_cursor: source.next_cursor,
            cursor: 1,
            max_bytes: 65536,
        },
        View::Screen {
            through_cursor: source.next_cursor,
        },
    ] {
        let Reply::Context(result) = ok(client
            .request(Request::Context {
                connection: c,
                window,
                view,
            })
            .await
            .unwrap())
        else {
            panic!()
        };
        match result {
            C::Raw { page, .. } => {
                let expected = source
                    .events
                    .iter()
                    .filter(|e| e.timestamp_ms == stamp)
                    .cloned()
                    .collect::<Vec<_>>();
                assert_eq!(page.events, expected);
            }
            C::Text { page, .. } => assert!(page.events.iter().any(|e| !e.text.is_empty())),
            C::Screen { screen, .. } => assert!(!screen.contents.is_empty()),
            _ => panic!(),
        }
    }
    assert_eq!(
        error(
            client
                .request(Request::Screen { connection: c })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert!(
        matches!(call(&mut desktop, S::Status { connection: c }).await, SR::Status(s) if s.connection.state == State::Connected)
    );
    service.stop(&mut desktop).await;
}
