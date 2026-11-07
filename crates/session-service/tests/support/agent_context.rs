use super::*;
use session_core::context::{Reply as C, TimeWindow, View};

fn request(connection: ConnectionRef, window: TimeWindow, view: View) -> Request {
    Request::Context {
        connection,
        window,
        view,
    }
}
async fn source(desktop: &mut Client) -> (ConnectionRef, TimeWindow, u64) {
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    for bytes in [
        b"PRIVATE-before\x1b[31m".as_slice(),
        b"allowed",
        b"SECRET-after",
    ] {
        ok(desktop
            .request(Request::AppendFixture {
                connection: c,
                bytes: bytes.to_vec(),
            })
            .await
            .unwrap());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let Reply::Output(page) = ok(desktop
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
    assert_eq!(page.events.len(), 3);
    assert!(
        page.events[0].timestamp_ms < page.events[1].timestamp_ms
            && page.events[1].timestamp_ms < page.events[2].timestamp_ms
    );
    (
        c,
        TimeWindow {
            from_ms: page.events[1].timestamp_ms,
            until_ms: page.events[1].timestamp_ms + 1,
        },
        page.next_cursor,
    )
}
fn scoped(connection: ConnectionRef, window: TimeWindow) -> Scope {
    Scope {
        target: Target::OutputWindow { connection, window },
        action: Action::Read,
    }
}

#[tokio::test]
async fn agent_context_uses_the_same_actual_ssh_output_without_a_second_shell() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let c = ssh_connected_fixture(&mut desktop, &remote).await;
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
    let last = source.events.last().unwrap();
    let window = TimeWindow {
        from_ms: last.timestamp_ms,
        until_ms: last.timestamp_ms + 1,
    };
    let (_, token) = issue(&mut desktop, vec![scoped(c, window)], 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let Reply::Context(C::Raw { page, .. }) = ok(client
        .request(request(
            c,
            window,
            View::Raw {
                through_cursor: source.next_cursor,
                cursor: 1,
                max_bytes: 65536,
            },
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    let expected = source
        .events
        .iter()
        .filter(|e| e.timestamp_ms == last.timestamp_ms)
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(page.events, expected);
    assert!(
        matches!(ok(client.request(request(c, window, View::Text { through_cursor: source.next_cursor, cursor: 1, max_bytes: 65536 })).await.unwrap()), Reply::Context(C::Text { page, .. }) if !page.events.is_empty())
    );
    assert!(
        matches!(ok(client.request(request(c, window, View::Screen { through_cursor: source.next_cursor })).await.unwrap()), Reply::Context(C::Screen { screen, .. }) if screen.connection == c)
    );
    assert_eq!(
        error(
            client
                .request(Request::Screen { connection: c })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_context_real_pipe_filters_all_views_and_denies_full_read_scope_expansion_and_lease()
{
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let (c, window, through) = source(&mut desktop).await;
    let (_, token) = issue(&mut desktop, vec![scoped(c, window)], 30000).await;
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    assert!(
        matches!(ok(client.request(Request::List {}).await.unwrap()), Reply::Sessions(v) if v.len() == 1 && v[0].reference() == c)
    );
    for r in [
        Request::Read {
            connection: c,
            cursor: 1,
            max_bytes: 65536,
        },
        Request::ReadText {
            connection: c,
            cursor: 1,
            max_bytes: 65536,
        },
        Request::Screen { connection: c },
        agent(A::Acquire {
            connection: c,
            lifetime_ms: 100,
        }),
    ] {
        assert_eq!(
            error(client.request(r).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    assert!(
        matches!(ok(client.request(request(c, window, View::Info)).await.unwrap()), Reply::Context(C::Info { context }) if context.through_cursor == through && !context.source_completed)
    );
    let Reply::Context(C::Raw { context, page }) = ok(client
        .request(request(
            c,
            window,
            View::Raw {
                through_cursor: through,
                cursor: 1,
                max_bytes: 65536,
            },
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(context.window, window);
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].seq, 2);
    assert_eq!(page.events[0].bytes, b"allowed");
    let Reply::Context(C::Text { page, .. }) = ok(client
        .request(request(
            c,
            window,
            View::Text {
                through_cursor: through,
                cursor: 1,
                max_bytes: 65536,
            },
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].text, "allowed");
    let Reply::Context(C::Screen { screen, .. }) = ok(client
        .request(request(
            c,
            window,
            View::Screen {
                through_cursor: through,
            },
        ))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(screen.contents, "allowed");
    assert_eq!(screen.source_cursor, through);
    for (target, range) in [
        (
            c,
            TimeWindow {
                from_ms: window.from_ms - 1,
                ..window
            },
        ),
        (
            c,
            TimeWindow {
                until_ms: window.until_ms + 1,
                ..window
            },
        ),
        (
            ConnectionRef {
                generation: c.generation + 1,
                ..c
            },
            window,
        ),
        (
            ConnectionRef {
                connection_id: ConnectionId(Uuid::new_v4()),
                ..c
            },
            window,
        ),
    ] {
        assert_eq!(
            error(
                client
                    .request(request(target, range, View::Info))
                    .await
                    .unwrap()
            ),
            ErrorCode::PermissionDenied
        );
    }
    assert_eq!(
        error(
            client
                .request(request(
                    c,
                    window,
                    View::Screen {
                        through_cursor: through + 1
                    }
                ))
                .await
                .unwrap()
        ),
        ErrorCode::InvalidArgument
    );
    ok(desktop
        .request(agent(A::Takeover { connection: c }))
        .await
        .unwrap());
    assert!(matches!(
        ok(client
            .request(request(c, window, View::Info))
            .await
            .unwrap()),
        Reply::Context(C::Info { .. })
    ));
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn agent_context_retirement_receipt_replay_revocation_and_expiry_never_restore_window() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let (c, window, _) = source(&mut desktop).await;
    let id = Uuid::new_v4();
    let scopes = vec![scoped(c, window)];
    let Reply::Agent(AR::Grant {
        receipt,
        token: Some(token),
    }) = ok(desktop
        .request(agent(A::Grant {
            request_id: id,
            scopes: scopes.clone(),
            lifetime_ms: 30000,
        }))
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut client, _) = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap();
    let next = reference(ok(desktop
        .request(Request::ReconnectFixture { connection: c })
        .await
        .unwrap()));
    assert_eq!(
        error(
            client
                .request(request(c, window, View::Info))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let (revoked_ticket, active_token) =
        issue(&mut desktop, vec![scoped(next, window)], 30000).await;
    let (mut active, _) = Client::connect(&service.instance, active_token.expose(), service.pid)
        .await
        .unwrap();
    assert!(matches!(
        ok(active
            .request(request(next, window, View::Info))
            .await
            .unwrap()),
        Reply::Context(C::Info { .. })
    ));
    ok(desktop
        .request(Request::Revoke {
            ticket_id: revoked_ticket,
        })
        .await
        .unwrap());
    assert_eq!(
        error(
            active
                .request(request(next, window, View::Info))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            client
                .request(request(next, window, View::Info))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let Reply::Agent(AR::Grant {
        receipt: replay,
        token: Some(restored),
    }) = ok(desktop
        .request(agent(A::Grant {
            request_id: id,
            scopes,
            lifetime_ms: 30000,
        }))
        .await
        .unwrap())
    else {
        panic!()
    };
    assert_eq!(replay.summary.ticket_id, receipt.summary.ticket_id);
    assert_eq!(replay.summary.expires_at_ms, receipt.summary.expires_at_ms);
    assert!(replay.effective_scopes.is_empty());
    assert_eq!(token.expose(), restored.expose());
    ok(desktop
        .request(Request::Revoke {
            ticket_id: receipt.summary.ticket_id,
        })
        .await
        .unwrap());
    assert_eq!(
        error(
            client
                .request(request(c, window, View::Info))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let (_, short) = issue(&mut desktop, vec![scoped(next, window)], 300).await;
    let (mut expiring, _) = Client::connect(&service.instance, short.expose(), service.pid)
        .await
        .unwrap();
    assert!(matches!(
        ok(expiring
            .request(request(next, window, View::Info))
            .await
            .unwrap()),
        Reply::Context(C::Info { .. })
    ));
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(
        error(
            expiring
                .request(request(next, window, View::Info))
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    service.stop(&mut desktop).await;
}
