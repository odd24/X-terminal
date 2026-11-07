use super::*;
use crate::redaction::Policy;
use std::sync::Arc;
use uuid::Uuid;

fn setup() -> (Sessions, ConnectionRef) {
    let mut s = Sessions::default();
    let first = s.create(Protocol::Fixture).unwrap();
    let c = s.begin_connect(first.reference()).unwrap().reference();
    s.configure_output(c, "utf-8", 8, 20).unwrap();
    s.transition(c, State::Connected).unwrap();
    (s, c)
}
pub(crate) fn policy(fields: bool) -> ProtectedPolicy {
    ProtectedPolicy {
        info: Info {
            policy_id: Uuid::new_v4(),
            sensitive_fields: fields,
            literal_count: 1,
        },
        rules: Arc::new(Policy::new(vec!["synthetic-secret".into()], fields).unwrap()),
    }
}
fn text(
    s: &Sessions,
    c: ConnectionRef,
    window: Option<TimeWindow>,
    through: u64,
    cursor: u64,
    p: &ProtectedPolicy,
) -> (Metadata, TextPage) {
    let Reply::Text { context, page } = s
        .protected_context(
            c,
            window,
            View::Text {
                through_cursor: through,
                cursor,
                max_bytes: 16384,
            },
            p,
        )
        .unwrap()
    else {
        panic!()
    };
    (*context, page)
}
fn joined(page: &TextPage) -> String {
    page.events.iter().map(|e| e.text.as_str()).collect()
}

#[test]
fn late_page_still_masks_a_literal_split_before_its_cursor_and_leaves_source_unchanged() {
    let (mut s, c) = setup();
    s.append(c, b"safe synthetic-", 10).unwrap();
    s.append(c, b"secret\r\npublic\r\n", 11).unwrap();
    s.append(c, b"frozen-tail", 12).unwrap();
    s.transition(c, State::Closing).unwrap();
    s.transition(c, State::Disconnected).unwrap();
    let p = policy(false);
    let (_, all) = text(&s, c, None, 4, 1, &p);
    assert_eq!(
        joined(&all),
        "safe ****************\r\npublic\r\nfrozen-tail"
    );
    let (_, late) = text(&s, c, None, 4, 2, &p);
    assert_eq!(joined(&late), "******\r\npublic\r\nfrozen-tail");
    let original = s.read(c, 1, 65536).unwrap();
    assert_eq!(
        original
            .events
            .iter()
            .flat_map(|e| e.bytes.iter().copied())
            .collect::<Vec<_>>(),
        b"safe synthetic-secret\r\npublic\r\nfrozen-tail"
    );
    assert!(
        s.screen(c)
            .unwrap()
            .contents
            .replace('\n', "")
            .contains("synthetic-secret")
    );
    let (m, cut) = text(&s, c, None, 2, 1, &p);
    assert!(m.report.boundary_guard);
    assert!(!joined(&cut).contains("synthetic-"));
    assert_eq!(cut.source_cursor, 2);
    assert!(cut.completed);
}

#[test]
fn window_exclusion_resets_decoder_and_field_context_is_fail_closed() {
    let (mut s, c) = setup();
    s.append(c, b"password=PRIVATE\n", 1).unwrap();
    s.append(c, b"orphan-secret\r\n", 20).unwrap();
    s.append(c, b"OUTSIDE", 40).unwrap();
    let w = Some(TimeWindow {
        from_ms: 20,
        until_ms: 40,
    });
    let p = policy(true);
    let (m, page) = text(&s, c, w, 4, 1, &p);
    assert!(m.report.boundary_guard);
    assert_eq!(page.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2]);
    assert!(!joined(&page).contains("orphan"));
    assert!(!joined(&page).contains("OUTSIDE"));
    let Reply::Screen { context, screen } = s
        .protected_context(c, w, View::Screen { through_cursor: 4 }, &p)
        .unwrap()
    else {
        panic!()
    };
    assert!(context.report.screen_withheld);
    assert!(screen.contents.chars().all(|c| c == '\n'));
    assert_eq!(screen.source_cursor, 4);
}

#[test]
fn screens_hide_rows_without_mutating_cursor_dimensions_or_unrelated_glyphs() {
    let (mut s, c) = setup();
    s.append(
        c,
        "public中文\r\nsynthetic-secret\r\nvisible\r\ntrailing-padding-row\r\n".as_bytes(),
        10,
    )
    .unwrap();
    s.transition(c, State::Closing).unwrap();
    s.transition(c, State::Disconnected).unwrap();
    let p = policy(false);
    let original = s.screen(c).unwrap();
    let Reply::Screen { context, screen } = s
        .protected_context(c, None, View::Screen { through_cursor: 2 }, &p)
        .unwrap()
    else {
        panic!()
    };
    assert!(!screen.contents.contains("synthetic"));
    assert!(screen.contents.contains("visible"));
    assert!(context.report.screen_rows_hidden > 0);
    assert_eq!(screen.rows, original.rows);
    assert_eq!(screen.cols, original.cols);
    assert_eq!(screen.cursor_row, original.cursor_row);
    assert_eq!(screen.cursor_col, original.cursor_col);
    assert_eq!(
        screen.contents.matches('\n').count(),
        original.contents.matches('\n').count()
    );
    assert_eq!(s.screen(c).unwrap().contents, original.contents);
}

#[test]
fn paginated_projection_and_fixed_watermark_do_not_duplicate_or_include_future_events() {
    let (mut s, c) = setup();
    for _ in 0..8 {
        s.append(c, &vec![b'x'; 4096], 10).unwrap();
    }
    let p = policy(false);
    let (_, first) = text(&s, c, None, 9, 1, &p);
    assert_eq!(first.events.len(), 4);
    assert_eq!(first.next_cursor, 5);
    s.append(c, b"future", 11).unwrap();
    let (_, second) = text(&s, c, None, 9, first.next_cursor, &p);
    assert_eq!(
        second.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        [5, 6, 7, 8]
    );
    assert_eq!(second.next_cursor, 9);
    assert!(!joined(&second).contains("future"));
}

#[test]
fn real_gaps_and_retention_loss_reset_projection_and_preserve_loss_metadata() {
    let (mut s, c) = setup();
    s.append(c, b"password=first", 10).unwrap();
    s.mark_gap(c, 17, 11).unwrap();
    s.append(c, b"orphan\r\nsecret-tail\r\n", 12).unwrap();
    let p = policy(true);
    let (m, page) = text(&s, c, None, 4, 1, &p);
    assert!(m.report.boundary_guard);
    assert_eq!(m.context_resets, 1);
    assert!(page.events.iter().any(|e| e.gap_bytes == Some(17)));
    assert!(!joined(&page).contains("orphan"));
    assert!(!joined(&page).contains("secret-tail"));
    for _ in 0..130 {
        s.append(c, b"retained-sensitive\n", 20).unwrap();
    }
    let (m, page) = text(&s, c, None, 134, 1, &p);
    assert!(m.source_truncated);
    assert!(page.truncated);
    assert!(m.report.boundary_guard);
    assert!(m.source_available_from > 1);
    assert!(!joined(&page).contains("retained"));
    assert_eq!(page.source_cursor, 134);
}

#[test]
fn protected_views_have_no_raw_or_caller_policy_override_and_info_is_strict() {
    for input in [
        serde_json::json!({"kind":"info","policy_id":Uuid::new_v4()}),
        serde_json::json!({"kind":"raw","cursor":1,"through_cursor":2,"max_bytes":16384}),
        serde_json::json!({"kind":"text","cursor":1,"through_cursor":2,"max_bytes":16384,"encoding":"utf-8"}),
    ] {
        assert!(serde_json::from_value::<View>(input).is_err());
    }
    assert!(
        serde_json::from_value::<crate::protected_task::View>(
            serde_json::json!({"kind":"info","literals":["override"]})
        )
        .is_err()
    );
}
