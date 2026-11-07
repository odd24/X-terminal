use super::*;

fn setup(encoding: &str) -> (Sessions, ConnectionRef) {
    let mut sessions = Sessions::default();
    let first = sessions.create(Protocol::Fixture).unwrap();
    let c = sessions
        .begin_connect(first.reference())
        .unwrap()
        .reference();
    sessions.configure_output(c, encoding, 8, 40).unwrap();
    sessions.transition(c, State::Connected).unwrap();
    (sessions, c)
}
fn window() -> TimeWindow {
    TimeWindow {
        from_ms: 20,
        until_ms: 40,
    }
}
fn text(s: &Sessions, c: ConnectionRef, through: u64) -> (Metadata, TextPage) {
    let Reply::Text { context, page } = s
        .context(
            c,
            window(),
            View::Text {
                through_cursor: through,
                cursor: 1,
                max_bytes: MAX_APPEND,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    (*context, page)
}
fn screen(s: &Sessions, c: ConnectionRef, through: u64) -> (Metadata, ScreenSnapshot) {
    let Reply::Screen { context, screen } = s
        .context(
            c,
            window(),
            View::Screen {
                through_cursor: through,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    (*context, screen)
}

#[test]
fn half_open_window_filters_raw_before_decoding_or_screen_and_never_copies_outside_state() {
    let (mut s, c) = setup("utf-8");
    s.append(c, b"PRIVATE\x1b[31m", 19).unwrap();
    s.append(c, b"allowed", 20).unwrap();
    s.append(c, b"\r\nlast", 39).unwrap();
    s.append(c, b"SECRET-AFTER", 40).unwrap();
    let Reply::Raw { context, page } = s
        .context(
            c,
            window(),
            View::Raw {
                through_cursor: 5,
                cursor: 1,
                max_bytes: MAX_APPEND,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        page.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        [2, 3]
    );
    assert_eq!(page.next_cursor, 5);
    assert!(!context.source_completed);
    assert!(matches!(context.mode, Mode::TimeWindowReplay));
    let (_, page) = text(&s, c, 5);
    assert_eq!(
        page.events
            .iter()
            .map(|e| e.text.as_str())
            .collect::<String>(),
        "allowed\r\nlast"
    );
    assert_eq!(page.events[0].seq, 2);
    assert!(
        page.completed,
        "fixed-watermark replay is finite even for a live source"
    );
    let (meta, screen) = screen(&s, c, 5);
    assert_eq!(screen.contents, "allowed\nlast");
    assert_eq!(
        meta.context_resets, 0,
        "excluded tail must not erase the selected screen"
    );
    assert_eq!(screen.source_cursor, 5);
    assert!(s.screen(c).unwrap().contents.contains("PRIVATE"));
}

#[test]
fn window_decoder_uses_only_authorized_fragments_and_flushes_fixed_cutoff_for_utf8_and_gbk() {
    for (encoding, bytes) in [("utf-8", vec![0xe4, 0xb8, 0xad]), ("gbk", vec![0xd6, 0xd0])] {
        let (mut s, c) = setup(encoding);
        s.append(c, &bytes[..1], 10).unwrap();
        s.append(c, &bytes[1..], 25).unwrap();
        let (_, p) = text(&s, c, 3);
        let joined = p.events.iter().map(|e| e.text.as_str()).collect::<String>();
        assert!(!joined.contains('中'));
        assert!(p.events.iter().any(|e| e.decode_error));
        assert_eq!(s.screen(c).unwrap().contents, "中");
        let (mut s, c) = setup(encoding);
        s.append(c, &bytes[..1], 25).unwrap();
        let (_, before) = text(&s, c, 2);
        assert!(before.events[0].decode_error);
        assert_eq!(before.events[0].text, "�");
        s.append(c, &bytes[1..], 26).unwrap();
        let (_, fixed) = text(&s, c, 2);
        assert_eq!(
            fixed, before,
            "new output must not alter an already chosen watermark"
        );
        let (_, current) = text(&s, c, 3);
        assert_eq!(
            current
                .events
                .iter()
                .map(|e| e.text.as_str())
                .collect::<String>(),
            "中"
        );
    }
}

#[test]
fn excluded_clock_rollback_segments_and_raw_gaps_reset_decoder_and_screen() {
    let (mut s, c) = setup("utf-8");
    s.append(c, b"first\x1b]0;", 25).unwrap();
    s.append(c, b"excluded", 45).unwrap();
    s.append(c, b"last\x07", 30).unwrap();
    let (meta, page) = text(&s, c, 4);
    assert_eq!(meta.context_resets, 1);
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events[1].seq, 3);
    let (_, snapshot) = screen(&s, c, 4);
    assert_eq!(snapshot.contents, "last");
    s.mark_gap(c, 19, 31).unwrap();
    s.append(c, b"after-gap", 32).unwrap();
    let (meta, snapshot) = screen(&s, c, 6);
    assert_eq!(meta.context_resets, 2);
    assert_eq!(snapshot.contents, "after-gap");
    assert_eq!(snapshot.gap_bytes, 19);
}

#[test]
fn window_pages_use_raw_cursors_fixed_watermarks_and_report_eviction_without_future_or_stale_reads()
{
    let (mut s, c) = setup("utf-8");
    s.append(c, &vec![b'a'; EVENT_BYTES], 25).unwrap();
    s.append(c, b"outside", 50).unwrap();
    s.append(c, &vec![b'b'; EVENT_BYTES], 25).unwrap();
    let Reply::Raw { page: first, .. } = s
        .context(
            c,
            window(),
            View::Raw {
                through_cursor: 4,
                cursor: 1,
                max_bytes: EVENT_BYTES,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(first.next_cursor, 3);
    assert_eq!(first.events.len(), 1);
    let Reply::Raw { page: second, .. } = s
        .context(
            c,
            window(),
            View::Raw {
                through_cursor: 4,
                cursor: first.next_cursor,
                max_bytes: EVENT_BYTES,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(second.events[0].seq, 3);
    assert_eq!(second.next_cursor, 4);
    for view in [
        View::Screen { through_cursor: 5 },
        View::Raw {
            through_cursor: 4,
            cursor: 5,
            max_bytes: EVENT_BYTES,
        },
        View::Text {
            through_cursor: 4,
            cursor: 1,
            max_bytes: 1,
        },
    ] {
        assert!(matches!(
            s.context(c, window(), view),
            Err(ErrorCode::InvalidArgument)
        ));
    }
    for _ in 0..130 {
        s.append(c, b"new", 30).unwrap();
    }
    let Reply::Raw { context, page } = s
        .context(
            c,
            window(),
            View::Raw {
                through_cursor: 4,
                cursor: 1,
                max_bytes: EVENT_BYTES,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    assert!(context.source_truncated && page.truncated);
    assert_eq!(page.next_cursor, 4);
    assert!(page.events.is_empty());
    assert!(matches!(
        s.context(
            ConnectionRef {
                generation: c.generation + 1,
                ..c
            },
            window(),
            View::Info
        ),
        Err(ErrorCode::StaleGeneration)
    ));
}

#[test]
fn policy_windows_do_not_union_or_grant_full_read_lease_or_new_generation_and_retire_exactly() {
    use crate::{
        access::{Action, Scope, Target},
        pairing::{Pairing, SecretToken},
    };
    let (_, c) = setup("utf-8");
    let bootstrap = SecretToken::generate();
    let mut p = Pairing::new(&bootstrap);
    let desktop = p.authenticate(&bootstrap, 0).unwrap();
    let scope = |window| Scope {
        target: Target::OutputWindow {
            connection: c,
            window,
        },
        action: Action::Read,
    };
    let (agent, _, _) = p
        .issue_agent(
            &desktop,
            vec![
                scope(window()),
                scope(TimeWindow {
                    from_ms: 40,
                    until_ms: 50,
                }),
            ],
            100,
            0,
        )
        .unwrap();
    assert!(p.can_observe(&agent, c, 1).is_ok());
    assert!(
        p.can_read_context(
            &agent,
            c,
            TimeWindow {
                from_ms: 21,
                until_ms: 39
            },
            1
        )
        .is_ok()
    );
    assert!(
        p.can_read_context(
            &agent,
            c,
            TimeWindow {
                from_ms: 20,
                until_ms: 50
            },
            1
        )
        .is_err()
    );
    assert!(p.can_read(&agent, c, 1).is_err());
    assert!(p.acquire_lease(&agent, c, 20, 1).is_err());
    assert!(
        p.can_read_context(&agent, ConnectionRef { generation: 2, ..c }, window(), 1)
            .is_err()
    );
    p.takeover(&desktop, c, 2).unwrap();
    assert!(p.can_read_context(&agent, c, window(), 3).is_ok());
    assert!(p.can_read_context(&agent, c, window(), 100).is_err());
    p.retire_connection(c, 4);
    assert!(p.can_read_context(&agent, c, window(), 5).is_err());
    for invalid in [
        TimeWindow {
            from_ms: 2,
            until_ms: 1,
        },
        TimeWindow {
            from_ms: 1,
            until_ms: 1,
        },
        TimeWindow {
            from_ms: 0,
            until_ms: u64::MAX,
        },
    ] {
        assert!(
            p.issue_agent(&desktop, vec![scope(invalid)], 20, 5)
                .is_err()
        );
    }
    assert!(
        p.issue_agent(
            &desktop,
            vec![Scope {
                action: Action::Write,
                ..scope(window())
            }],
            20,
            5
        )
        .is_err()
    );
}

#[test]
fn expanded_text_pages_remain_bounded_and_use_original_source_cursor_without_duplicates() {
    let (mut s, c) = setup("utf-8");
    s.append(c, &vec![0xff; EVENT_BYTES * 3], 25).unwrap();
    let mut cursor = 1;
    let mut seen = Vec::new();
    while cursor < 4 {
        let Reply::Text { page, .. } = s
            .context(
                c,
                window(),
                View::Text {
                    through_cursor: 4,
                    cursor,
                    max_bytes: MIN_TEXT_PAGE,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].text.len(), EVENT_BYTES * 3);
        assert!(page.events[0].decode_error);
        assert_eq!(page.events[0].source_seq, Some(page.events[0].seq));
        assert!(page.next_cursor > cursor);
        seen.push(page.events[0].seq);
        cursor = page.next_cursor;
    }
    assert_eq!(seen, [1, 2, 3]);
}
