use super::*;

fn connected(sessions: &mut Sessions, encoding: &str, rows: u16, cols: u16) -> ConnectionRef {
    let initial = sessions.create(Protocol::Serial).unwrap();
    let reference = sessions
        .begin_connect(initial.reference())
        .unwrap()
        .reference();
    sessions
        .configure_output(reference, encoding, rows, cols)
        .unwrap();
    sessions.transition(reference, State::Connected).unwrap();
    reference
}

#[test]
fn every_encoding_partition_has_source_identity_and_independent_raw_bytes() {
    for (encoding, bytes, expected) in [
        (
            "utf-8",
            "\x1b[31m中文😀\x1b[0m\r\n".as_bytes(),
            "\x1b[31m中文😀\x1b[0m\r\n",
        ),
        ("gbk", &b"\xd6\xd0\xce\xc4\r\n"[..], "中文\r\n"),
        (
            "gb18030",
            &b"\xd6\xd0\x90\x30\x81\x30\r\n"[..],
            "中\u{10000}\r\n",
        ),
    ] {
        for boundary in 0..=bytes.len() {
            let mut sessions = Sessions::default();
            let reference = connected(&mut sessions, encoding, 24, 80);
            sessions.append(reference, &bytes[..boundary], 100).unwrap();
            sessions.append(reference, &bytes[boundary..], 101).unwrap();
            let text = sessions.read_text(reference, 1, MIN_TEXT_PAGE).unwrap();
            assert_eq!(
                text.events
                    .iter()
                    .map(|e| e.text.as_str())
                    .collect::<String>(),
                expected
            );
            assert!(!text.completed && !text.truncated);
            assert!(
                text.events
                    .iter()
                    .all(|e| !e.decode_error && e.gap_bytes.is_none())
            );
            let raw = sessions.read(reference, 1, EVENT_BYTES).unwrap();
            assert_eq!(
                raw.events
                    .iter()
                    .flat_map(|e| e.bytes.clone())
                    .collect::<Vec<_>>(),
                bytes
            );
            assert_eq!(text.source_cursor, raw.next_cursor);
            for (decoded, raw) in text.events.iter().zip(&raw.events) {
                assert_eq!(decoded.source_seq, Some(raw.seq));
                assert_eq!(decoded.timestamp_ms, raw.timestamp_ms);
            }
            let screen = sessions.screen(reference).unwrap();
            assert_eq!(screen.encoding, encoding);
            assert!(screen.contents.contains('中'));
            assert!(!screen.contents.contains('\x1b'));
        }
    }
}

#[test]
fn text_byte_and_event_caps_do_not_discard_raw_or_live_screen() {
    let mut sessions = Sessions::default();
    let reference = connected(&mut sessions, "utf-8", 24, 80);
    for index in 0..64 {
        sessions
            .append(reference, &[255; EVENT_BYTES], index)
            .unwrap();
    }
    let raw = sessions.read(reference, 1, MAX_APPEND).unwrap();
    assert!(!raw.truncated);
    let page = sessions.read_text(reference, 1, MIN_TEXT_PAGE).unwrap();
    assert!(page.truncated && page.available_from > raw.available_from);
    assert!(page.events.iter().all(|event| event.decode_error));
    let mut cursor = page.available_from;
    let mut bytes = 0;
    loop {
        let page = sessions
            .read_text(reference, cursor, MIN_TEXT_PAGE)
            .unwrap();
        if page.events.is_empty() {
            break;
        }
        assert!(page.next_cursor > cursor);
        bytes += page.events.iter().map(|e| e.text.len()).sum::<usize>();
        cursor = page.next_cursor;
    }
    assert!(bytes <= TEXT_BYTES);
    let screen = sessions.screen(reference).unwrap();
    assert_eq!(screen.decode_error_events, 64);
    assert_eq!(screen.source_cursor, 65);
    for index in 0..256 {
        sessions.append(reference, b"Z", index).unwrap();
    }
    let page = sessions.read_text(reference, 1, MAX_APPEND).unwrap();
    assert_eq!(page.events.len(), TEXT_EVENTS);
    assert!(page.truncated);
    assert_eq!(
        page,
        sessions.read_text(reference, 1, MAX_APPEND).unwrap(),
        "readers have independent cursors"
    );
    assert!(sessions.screen(reference).unwrap().contents.contains('Z'));
}

#[test]
fn gap_abandons_lead_bytes_and_osc_then_final_flush_consumes_no_raw_sequence() {
    let mut sessions = Sessions::default();
    let reference = connected(&mut sessions, "utf-8", 24, 80);
    sessions
        .append(reference, b"before\x1b]0;\xe4", 10)
        .unwrap();
    sessions.mark_gap(reference, 7, 11).unwrap();
    sessions.append(reference, b"SAFE\xe4", 12).unwrap();
    sessions.transition(reference, State::Closing).unwrap();
    // Closing may still capture bytes from the transport; do not finalize early.
    sessions.append_draining(reference, b"\xb8", 13).unwrap();
    assert!(!sessions.screen(reference).unwrap().completed);
    sessions.transition(reference, State::Disconnected).unwrap();
    let page = sessions.read_text(reference, 1, MAX_APPEND).unwrap();
    assert!(page.completed);
    assert_eq!(page.events[1].gap_bytes, Some(7));
    let last = page.events.last().unwrap();
    assert_eq!(last.source_seq, None);
    assert!(last.decode_error);
    assert_eq!(last.timestamp_ms, 13);
    assert_eq!(last.text, "�");
    let snapshot = sessions.screen(reference).unwrap();
    assert_eq!(snapshot.contents, "SAFE�");
    assert_eq!(snapshot.gap_bytes, 7);
    assert_eq!(snapshot.decode_error_events, 1);
    assert_eq!(
        snapshot.source_cursor,
        sessions.read(reference, 1, MAX_APPEND).unwrap().next_cursor
    );
    sessions.transition(reference, State::Failed).unwrap();
    assert_eq!(
        page,
        sessions.read_text(reference, 1, MAX_APPEND).unwrap(),
        "finalize only once"
    );
}

#[test]
fn connection_generation_configuration_and_alternate_screen_are_isolated() {
    let mut sessions = Sessions::default();
    let a = connected(&mut sessions, "gbk", 8, 40);
    let b = connected(&mut sessions, "utf-8", 24, 80);
    sessions.append(a, b"\xd6", 1).unwrap();
    sessions.append(b, b"other", 2).unwrap();
    assert_eq!(sessions.screen(b).unwrap().contents, "other");
    assert!(sessions.screen(a).unwrap().contents.is_empty());
    assert_eq!(
        sessions.configure_output(a, "utf-8", 24, 80),
        Err(ErrorCode::InvalidState)
    );
    sessions.transition(a, State::Failed).unwrap();
    let next = sessions.begin_connect(a).unwrap().reference();
    assert_eq!(sessions.screen(a), Err(ErrorCode::StaleGeneration));
    assert_eq!(
        sessions.read_text(a, 1, MAX_APPEND),
        Err(ErrorCode::StaleGeneration)
    );
    assert_eq!(
        sessions.configure_output(next, "auto", 24, 80),
        Err(ErrorCode::InvalidArgument)
    );
    sessions.configure_output(next, "gb18030", 8, 40).unwrap();
    sessions.transition(next, State::Connected).unwrap();
    sessions
        .append(next, b"main\x1b[?1049h\x1b[2J\x1b[Halt", 3)
        .unwrap();
    let alt = sessions.screen(next).unwrap();
    assert!(alt.alternate);
    assert_eq!(alt.contents, "alt");
    assert_eq!(alt.gap_bytes, 0);
    assert_eq!(alt.decode_error_events, 0);
    sessions.append(next, b"\x1b[?1049l", 4).unwrap();
    assert_eq!(sessions.screen(next).unwrap().contents, "main");
    assert!(!sessions.screen(next).unwrap().alternate);
}

#[test]
fn read_bounds_resize_limits_and_snapshot_frame_budget_are_explicit() {
    let mut sessions = Sessions::default();
    let reference = connected(&mut sessions, "utf-8", 200, 500);
    assert_eq!(
        sessions.read_text(reference, 0, MIN_TEXT_PAGE),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        sessions.read_text(reference, 2, MIN_TEXT_PAGE),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        sessions.read_text(reference, 1, MIN_TEXT_PAGE - 1),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        sessions.read_text(reference, 1, MAX_APPEND + 1),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        sessions.resize_screen(reference, 0, 40),
        Err(ErrorCode::InvalidArgument)
    );
    for _ in 0..2 {
        sessions.append(reference, &[b'x'; 50_000], 1).unwrap();
    }
    let snapshot = sessions.screen(reference).unwrap();
    assert!(snapshot.contents_truncated);
    assert_eq!(snapshot.contents.len(), SCREEN_BYTES);
    assert_eq!(snapshot.parser, "vt100-0.18.1+local.2");
    assert!(snapshot.resize_reflow);
    sessions.resize_screen(reference, 8, 40).unwrap();
    let snapshot = sessions.screen(reference).unwrap();
    assert_eq!((snapshot.rows, snapshot.cols), (8, 40));
    assert!(snapshot.cursor_row < 8 && snapshot.cursor_col < 40);
    sessions.transition(reference, State::Failed).unwrap();
    assert_eq!(
        sessions.resize_screen(reference, 8, 40),
        Err(ErrorCode::NotConnected)
    );
}

#[test]
fn text_counter_reserves_eof_and_rejected_input_does_not_mutate_view() {
    let mut view = Presentation::new("utf-8", 24, 80).unwrap();
    view.next_seq = u64::MAX - 1;
    assert_eq!(view.reserve(1), Err(ErrorCode::CapacityExceeded));
    let _ = view.finish();
    assert!(view.completed);
    assert_eq!(view.next_seq, u64::MAX);
    let mut sessions = Sessions::default();
    let reference = connected(&mut sessions, "utf-8", 24, 80);
    let before = sessions.screen(reference).unwrap();
    assert_eq!(
        sessions.append(reference, &vec![0; MAX_APPEND + 1], 0),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        sessions.mark_gap(reference, 0, 0),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(sessions.screen(reference).unwrap(), before);
}

#[test]
fn screen_reflow_changes_only_layout_not_raw_text_source_or_generation() {
    let mut sessions = Sessions::default();
    let reference = connected(&mut sessions, "utf-8", 6, 12);
    let bytes = b"abcdefghijklmnop\r\nnext";
    sessions.append(reference, bytes, 123).unwrap();
    let before = sessions.screen(reference).unwrap();
    let raw = sessions.read(reference, 1, MAX_APPEND).unwrap();
    let text = sessions.read_text(reference, 1, MAX_APPEND).unwrap();
    sessions.resize_screen(reference, 6, 6).unwrap();
    let after = sessions.screen(reference).unwrap();
    assert_eq!(after.contents, "abcdef\nghijkl\nmnop\nnext");
    assert_eq!((after.cursor_row, after.cursor_col), (3, 4));
    assert_eq!(after.connection, reference);
    assert_eq!(after.source_cursor, before.source_cursor);
    assert_eq!((after.gap_bytes, after.decode_error_events), (0, 0));
    assert_eq!(sessions.read(reference, 1, MAX_APPEND).unwrap(), raw);
    assert_eq!(sessions.read_text(reference, 1, MAX_APPEND).unwrap(), text);
    sessions.resize_screen(reference, 6, 12).unwrap();
    assert_eq!(
        sessions.screen(reference).unwrap().contents,
        before.contents
    );
}
