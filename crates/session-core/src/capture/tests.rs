use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;
#[derive(Default)]
struct Sink {
    events: Mutex<Vec<(Option<OutputEvent>, TextEvent)>>,
    stops: AtomicUsize,
}
impl OutputCapture for Sink {
    fn record(&self, raw: Option<&OutputEvent>, text: &TextEvent) {
        self.events
            .lock()
            .unwrap()
            .push((raw.cloned(), text.clone()));
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
}
#[test]
fn capture_is_opt_in_precisely_ordered_and_never_inherits_a_generation() {
    let mut sessions = Sessions::default();
    let initial = sessions.create(Protocol::Serial).unwrap();
    let reference = sessions
        .begin_connect(initial.reference())
        .unwrap()
        .reference();
    sessions.configure_output(reference, "gbk", 24, 80).unwrap();
    assert_eq!(
        sessions.output_position(reference).unwrap_err(),
        ErrorCode::NotConnected
    );
    sessions.transition(reference, State::Connected).unwrap();
    sessions.append(reference, b"earlier", 1).unwrap();
    let start = sessions.output_position(reference).unwrap();
    assert_eq!((start.source_cursor, start.text_cursor), (2, 2));
    assert_eq!(start.encoding, "gbk");
    let sink = Arc::new(Sink::default());
    let id = Uuid::new_v4();
    sessions
        .attach_capture(reference, id, sink.clone())
        .unwrap();
    assert_eq!(
        sessions.attach_capture(reference, Uuid::new_v4(), sink.clone()),
        Err(ErrorCode::InvalidState)
    );
    sessions.append(reference, &[0xd6], 2).unwrap();
    sessions.append(reference, &[0xd0], 3).unwrap();
    sessions.mark_gap(reference, 13, 4).unwrap();
    assert_eq!(
        sessions.detach_capture(reference, Uuid::new_v4()),
        Err(ErrorCode::InvalidArgument)
    );
    sessions.transition(reference, State::Closing).unwrap();
    sessions.append_draining(reference, b"tail\xd6", 5).unwrap();
    sessions.transition(reference, State::Disconnected).unwrap();
    sessions.transition(reference, State::Failed).unwrap();
    assert_eq!(sessions.capture_id(reference).unwrap(), None);
    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 5);
    assert!(events[0].1.text.is_empty());
    assert_eq!(events[1].1.text, "中");
    assert_eq!(events[2].0.as_ref().unwrap().gap_bytes, Some(13));
    assert_eq!(events[2].1.gap_bytes, Some(13));
    assert_eq!(events[3].1.text, "tail");
    assert!(events[4].0.is_none());
    assert_eq!(events[4].1.text, "�");
    assert!(events[4].1.decode_error);
    for (index, (raw, text)) in events.iter().enumerate() {
        assert_eq!(text.seq, index as u64 + 2);
        if let Some(raw) = raw {
            assert_eq!(text.source_seq, Some(raw.seq));
            assert_eq!(text.timestamp_ms, raw.timestamp_ms);
        }
    }
    drop(events);
    assert_eq!(sink.stops.load(Ordering::SeqCst), 1);
    let next = sessions.begin_connect(reference).unwrap().reference();
    sessions.transition(next, State::Connected).unwrap();
    sessions.append(next, b"new", 6).unwrap();
    assert_eq!(sink.events.lock().unwrap().len(), 5);
    assert_eq!(sessions.capture_id(next).unwrap(), None);
    assert_eq!(
        sessions.attach_capture(reference, Uuid::new_v4(), sink.clone()),
        Err(ErrorCode::StaleGeneration)
    );
}

#[test]
fn manual_detach_does_not_finalize_output_or_stop_later_captures() {
    let mut sessions = Sessions::default();
    let initial = sessions.create(Protocol::Fixture).unwrap();
    let reference = sessions
        .begin_connect(initial.reference())
        .unwrap()
        .reference();
    sessions.transition(reference, State::Connected).unwrap();
    let first = Arc::new(Sink::default());
    let first_id = Uuid::new_v4();
    sessions
        .attach_capture(reference, first_id, first.clone())
        .unwrap();
    sessions.append(reference, b"first", 1).unwrap();
    sessions.detach_capture(reference, first_id).unwrap();
    sessions.append(reference, b"outside", 2).unwrap();
    assert!(!sessions.screen(reference).unwrap().completed);
    let second = Arc::new(Sink::default());
    let second_id = Uuid::new_v4();
    sessions
        .attach_capture(reference, second_id, second.clone())
        .unwrap();
    assert_eq!(
        sessions.detach_capture(reference, first_id),
        Err(ErrorCode::InvalidArgument)
    );
    sessions.append(reference, b"second", 3).unwrap();
    assert_eq!(first.events.lock().unwrap().len(), 1);
    assert_eq!(second.events.lock().unwrap()[0].1.text, "second");
    drop(sessions);
    assert_eq!(second.stops.load(Ordering::SeqCst), 1);
    assert_eq!(first.stops.load(Ordering::SeqCst), 1);
}
