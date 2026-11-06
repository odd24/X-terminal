use super::*;
#[path = "tests_disconnect.rs"]
mod disconnect_tests;
use session_protocol::{
    SensitiveBytes,
    config::{ConfigRequest, CredentialEdit},
};
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Default)]
struct Wire {
    accepted: Mutex<Vec<u8>>,
    output: Mutex<VecDeque<Vec<u8>>>,
    controls: Mutex<Vec<(u8, bool)>>,
    pause: AtomicBool,
    disconnect: AtomicBool,
    partial: AtomicBool,
    writes: AtomicUsize,
    opens: AtomicUsize,
    driver_opens: AtomicUsize,
    open_pause: AtomicBool,
    open_waiting: AtomicBool,
    read_waiting: AtomicBool,
    burst: AtomicUsize,
}
struct Memory(Arc<Wire>);
impl worker::Port for Memory {
    fn bytes_to_read(&self) -> io::Result<u32> {
        Ok(self
            .0
            .output
            .lock()
            .unwrap()
            .iter()
            .map(Vec::len)
            .sum::<usize>() as u32)
    }
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<transport_serial::ReadOutcome> {
        self.0.read_waiting.store(true, Ordering::Release);
        while self.0.pause.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
        if self.0.disconnect.load(Ordering::Acquire) {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        if self
            .0
            .burst
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_sub(1)
            })
            .is_ok()
        {
            buffer.fill(0xa5);
            return Ok(transport_serial::ReadOutcome::Data(buffer.len()));
        }
        if let Some(bytes) = self.0.output.lock().unwrap().pop_front() {
            buffer[..bytes.len()].copy_from_slice(&bytes);
            return Ok(transport_serial::ReadOutcome::Data(bytes.len()));
        }
        std::thread::sleep(Duration::from_millis(1));
        Ok(transport_serial::ReadOutcome::Idle)
    }
    fn write_once(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let calls = self.0.writes.fetch_add(1, Ordering::AcqRel);
        if self.0.partial.load(Ordering::Acquire) && calls > 0 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let size = if self.0.partial.load(Ordering::Acquire) {
            2.min(bytes.len())
        } else {
            bytes.len()
        };
        self.0
            .accepted
            .lock()
            .unwrap()
            .extend_from_slice(&bytes[..size]);
        self.0
            .output
            .lock()
            .unwrap()
            .push_back(bytes[..size].to_vec());
        Ok(size)
    }
    fn control(&mut self, command: &worker::Command) -> io::Result<()> {
        let control = match command {
            worker::Command::Dtr(v) => (0, *v),
            worker::Command::Rts(v) => (1, *v),
            worker::Command::Break(v) => (2, *v),
            _ => panic!(),
        };
        self.0.controls.lock().unwrap().push(control);
        Ok(())
    }
}
impl Factory for Wire {
    fn inventory(&self) -> io::Result<Inventory> {
        Ok(Inventory {
            devices: vec![Device::synthetic()],
            unidentified_ports: vec!["COM99".into()],
            metadata_failures: 1,
        })
    }
    fn open(
        &self,
        _: Config,
        _: Device,
        dispatch: Option<worker::DispatchGuard>,
    ) -> io::Result<Worker> {
        let _ = dispatch;
        unreachable!("factory uses an Arc wrapper")
    }
}
struct MemoryFactory(Arc<Wire>);
impl Factory for MemoryFactory {
    fn inventory(&self) -> io::Result<Inventory> {
        self.0.inventory()
    }
    fn open(
        &self,
        _: Config,
        _: Device,
        dispatch: Option<worker::DispatchGuard>,
    ) -> io::Result<Worker> {
        self.0.opens.fetch_add(1, Ordering::AcqRel);
        let wire = self.0.clone();
        let gate = self.0.clone();
        let dispatch: worker::DispatchGuard = Arc::new(move || {
            gate.open_waiting.store(true, Ordering::Release);
            while gate.open_pause.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            dispatch.as_ref().is_none_or(|allow| allow())
        });
        Worker::test_backend_guarded(
            move || {
                wire.driver_opens.fetch_add(1, Ordering::AcqRel);
                Ok(Memory(wire))
            },
            Some(dispatch),
        )
    }
}
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-serial-service-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-serial-service-")
        );
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
async fn setup() -> (Temp, crate::config::ConfigWorker, Manager, Arc<Wire>, Uuid) {
    setup_encoding(config_store::Encoding::Utf8).await
}
async fn setup_encoding(
    encoding: config_store::Encoding,
) -> (Temp, crate::config::ConfigWorker, Manager, Arc<Wire>, Uuid) {
    let temp = Temp::new();
    let config = crate::config::ConfigWorker::start(Some(temp.0.clone())).unwrap();
    let id = Uuid::new_v4();
    config
        .request(ConfigRequest::SaveProfile {
            profile: config_store::PortableProfile {
                id,
                folder_id: None,
                name: "synthetic serial".into(),
                settings: config_store::Settings::Serial {
                    port: "COM7".into(),
                    baud_rate: 115200,
                    data_bits: 8,
                    stop_bits: 1,
                    parity: config_store::Parity::None,
                    flow: config_store::Flow::None,
                    dtr_on_open: false,
                    rts_on_open: Some(false),
                    encoding,
                },
            },
            credential: CredentialEdit::Keep {},
        })
        .await
        .unwrap();
    let wire = Arc::new(Wire::default());
    let mut manager = Manager::new(Store::test_store(), config.access());
    manager.factory = Arc::new(MemoryFactory(wire.clone()));
    (temp, config, manager, wire, id)
}
async fn selection(manager: &Manager) -> (Uuid, Uuid) {
    let Reply::Inventory {
        revision,
        devices,
        unidentified_ports,
        metadata_failures,
    } = manager.handle(Request::Inventory {}).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(unidentified_ports, ["COM99"]);
    assert_eq!(metadata_failures, 1);
    (revision, devices[0].device_id)
}
async fn start(
    manager: &Manager,
    profile_id: Uuid,
    request_id: Uuid,
    revision: Uuid,
    device_id: Uuid,
) -> ConnectionRef {
    let Reply::Started { connection } = manager
        .handle(Request::Start {
            profile_id,
            request_id,
            revision,
            device_id,
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    connection.reference()
}
async fn status(manager: &Manager, connection: ConnectionRef, state: State) -> serial::Status {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let Reply::Status(status) = manager
            .handle(Request::Status { connection })
            .await
            .unwrap()
        else {
            panic!()
        };
        if status.connection.state == state {
            return status;
        }
        assert!(Instant::now() < deadline, "serial state did not settle");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
fn write(connection: ConnectionRef, request_id: Uuid, bytes: &[u8]) -> Request {
    Request::Write {
        connection,
        request_id,
        bytes: SensitiveBytes::new(bytes.to_vec()),
    }
}
async fn receipt(manager: &Manager, connection: ConnectionRef, request_id: Uuid) -> InputReceipt {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let Reply::Input(receipt) = manager
            .handle(Request::InputStatus {
                connection,
                request_id,
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        if receipt.state != InputState::Pending {
            return receipt;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
fn ordered(stamp: u64) -> Uuid {
    Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0001)
}

#[tokio::test]
async fn shared_serial_output_deduplicates_inputs_controls_and_retires_without_replay() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    let start_id = Uuid::new_v4();
    let connection = start(&manager, profile, start_id, revision, device).await;
    status(&manager, connection, State::Connected).await;
    assert_eq!(
        start(&manager, profile, start_id, revision, device).await,
        connection
    );
    let opaque = Uuid::new_v4();
    let raw = [0, 255, 13, 10, 0xd6, 0xd0];
    manager
        .handle(write(connection, opaque, &raw))
        .await
        .unwrap();
    assert_eq!(
        receipt(&manager, connection, opaque).await.state,
        InputState::DriverAccepted
    );
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        manager.tick();
        if !manager
            .store
            .lock()
            .unwrap()
            .sessions
            .read(connection, 1, 4096)
            .unwrap()
            .events
            .is_empty()
        {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    {
        let store = manager.store.lock().unwrap();
        let a = store.sessions.read(connection, 1, 4096).unwrap();
        let b = store.sessions.read(connection, 1, 4096).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.events[0].bytes, raw);
    }
    let control_id = Uuid::new_v4();
    manager
        .handle(Request::Control {
            connection,
            request_id: control_id,
            line: Line::Dtr,
            asserted: true,
        })
        .await
        .unwrap();
    assert_eq!(
        receipt(&manager, connection, control_id).await.state,
        InputState::ControlApplied
    );
    manager
        .handle(Request::Control {
            connection,
            request_id: control_id,
            line: Line::Dtr,
            asserted: true,
        })
        .await
        .unwrap();
    assert!(matches!(
        manager
            .handle(write(connection, control_id, b"conflict"))
            .await,
        Err(ErrorCode::InvalidArgument)
    ));
    let mut expected = raw.to_vec();
    for stamp in 1..=1100 {
        let bytes = [(stamp % 256) as u8];
        expected.extend_from_slice(&bytes);
        manager
            .handle(write(connection, ordered(stamp), &bytes))
            .await
            .unwrap();
        receipt(&manager, connection, ordered(stamp)).await;
    }
    assert!(matches!(
        manager.handle(write(connection, ordered(1), b"old")).await,
        Err(ErrorCode::RequestExpired)
    ));
    assert!(matches!(
        manager
            .handle(Request::Control {
                connection,
                request_id: ordered(1),
                line: Line::Rts,
                asserted: true
            })
            .await,
        Err(ErrorCode::RequestExpired)
    ));
    manager
        .handle(write(connection, opaque, &raw))
        .await
        .unwrap();
    assert_eq!(*wire.accepted.lock().unwrap(), expected);
    assert_eq!(*wire.controls.lock().unwrap(), [(0, true)]);
    assert!(matches!(
        manager
            .handle(Request::Status {
                connection: ConnectionRef {
                    generation: connection.generation + 1,
                    ..connection
                }
            })
            .await,
        Err(ErrorCode::StaleGeneration)
    ));
    manager.handle(Request::Close { connection }).await.unwrap();
    status(&manager, connection, State::Disconnected).await;
    manager
        .handle(Request::Forget { connection })
        .await
        .unwrap();
    assert_eq!(
        start(&manager, profile, start_id, revision, device).await,
        connection
    );
    assert_eq!(wire.opens.load(Ordering::Acquire), 1);
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn closing_waits_for_actual_thread_exit_and_invalid_inventory_never_opens() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (old_revision, old_device) = selection(&manager).await;
    let (revision, device) = selection(&manager).await;
    assert!(matches!(
        manager
            .handle(Request::Start {
                profile_id: profile,
                request_id: Uuid::new_v4(),
                revision: old_revision,
                device_id: old_device
            })
            .await,
        Err(ErrorCode::InvalidState)
    ));
    assert_eq!(wire.opens.load(Ordering::Acquire), 0);
    wire.pause.store(true, Ordering::Release);
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    let input_id = Uuid::new_v4();
    manager
        .handle(write(connection, input_id, b"unsent"))
        .await
        .unwrap();
    manager.handle(Request::Close { connection }).await.unwrap();
    let closing = status(&manager, connection, State::Closing).await;
    assert!(closing.cleanup_pending);
    assert!(matches!(
        manager.handle(Request::Forget { connection }).await,
        Err(ErrorCode::InvalidState)
    ));
    assert!(matches!(
        manager
            .handle(Request::Start {
                profile_id: profile,
                request_id: Uuid::new_v4(),
                revision,
                device_id: device
            })
            .await,
        Err(ErrorCode::InvalidState)
    ));
    wire.pause.store(false, Ordering::Release);
    status(&manager, connection, State::Disconnected).await;
    assert_eq!(
        receipt(&manager, connection, input_id).await.state,
        InputState::CancelledBeforeDispatch
    );
    assert!(wire.accepted.lock().unwrap().is_empty());
    manager
        .handle(Request::Forget { connection })
        .await
        .unwrap();
    let new = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    assert_ne!(new.connection_id, connection.connection_id);
    status(&manager, new, State::Connected).await;
    assert!(matches!(
        manager.handle(write(connection, input_id, b"unsent")).await,
        Err(ErrorCode::NotFound)
    ));
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn partial_driver_write_is_unknown_and_transport_tail_gaps_reach_shared_readers() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    wire.burst.store(40, Ordering::Release);
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    let deadline = Instant::now() + Duration::from_secs(4);
    while manager.inner.lock().unwrap().entries[&connection.connection_id]
        .worker
        .as_ref()
        .unwrap()
        .status()
        .read_bytes
        < 40 * 4096
    {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    status(&manager, connection, State::Connected).await;
    manager.tick();
    {
        let store = manager.store.lock().unwrap();
        let page = store.sessions.read(connection, 1, 65536).unwrap();
        let lost: u64 = page.events.iter().filter_map(|event| event.gap_bytes).sum();
        assert!(lost > 0);
        let mut cursor = 1;
        let mut text_lost = 0;
        loop {
            let text = store.sessions.read_text(connection, cursor, 65536).unwrap();
            assert!(!text.truncated);
            if text.events.is_empty() {
                break;
            }
            text_lost += text.events.iter().filter_map(|e| e.gap_bytes).sum::<u64>();
            cursor = text.next_cursor;
        }
        assert_eq!(text_lost, lost);
        assert_eq!(store.sessions.screen(connection).unwrap().gap_bytes, lost);
        assert_eq!(
            lost,
            manager.inner.lock().unwrap().entries[&connection.connection_id]
                .status
                .dropped_bytes
        );
    }
    wire.partial.store(true, Ordering::Release);
    let id = Uuid::new_v4();
    manager
        .handle(write(connection, id, b"abcd"))
        .await
        .unwrap();
    let result = receipt(&manager, connection, id).await;
    assert_eq!(result.state, InputState::Unknown);
    assert_eq!(result.driver_accepted, Some(2));
    assert_eq!(result.failure, Some(Failure::Io));
    let failed = status(&manager, connection, State::Failed).await;
    assert!(!failed.cleanup_pending);
    assert_eq!(*wire.accepted.lock().unwrap(), b"ab");
    manager
        .handle(write(connection, id, b"abcd"))
        .await
        .unwrap();
    assert_eq!(*wire.accepted.lock().unwrap(), b"ab");
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn serial_output_uses_profile_encoding_in_headless_views_and_flushes_only_after_drain() {
    for (encoding, raw, expected) in [
        (
            config_store::Encoding::Gbk,
            vec![0xd6, 0xd0, 0xce, 0xc4],
            "中文",
        ),
        (
            config_store::Encoding::Gb18030,
            vec![0xd6, 0xd0, 0x90, 0x30, 0x81, 0x30],
            "中\u{10000}",
        ),
    ] {
        let label = crate::encoding_label(&encoding);
        let (_temp, config, manager, wire, profile) = setup_encoding(encoding).await;
        let (revision, device) = selection(&manager).await;
        let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
        status(&manager, connection, State::Connected).await;
        wire.output.lock().unwrap().push_back(vec![raw[0]]);
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            manager.tick();
            if manager
                .store
                .lock()
                .unwrap()
                .sessions
                .screen(connection)
                .unwrap()
                .source_cursor
                > 1
            {
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(
            manager
                .store
                .lock()
                .unwrap()
                .sessions
                .screen(connection)
                .unwrap()
                .contents
                .is_empty()
        );
        wire.output
            .lock()
            .unwrap()
            .extend(raw[1..].iter().map(|b| vec![*b]));
        loop {
            manager.tick();
            if manager
                .store
                .lock()
                .unwrap()
                .sessions
                .screen(connection)
                .unwrap()
                .contents
                == expected
            {
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        {
            let store = manager.store.lock().unwrap();
            let text = store.sessions.read_text(connection, 1, 65536).unwrap();
            assert_eq!(text.encoding, label);
            assert_eq!(
                text.events
                    .iter()
                    .map(|e| e.text.as_str())
                    .collect::<String>(),
                expected
            );
            assert!(text.events.iter().all(|e| !e.decode_error));
            assert_eq!(
                store
                    .sessions
                    .read(connection, 1, 65536)
                    .unwrap()
                    .events
                    .iter()
                    .flat_map(|e| e.bytes.clone())
                    .collect::<Vec<_>>(),
                raw
            );
        }
        manager.handle(Request::Close { connection }).await.unwrap();
        status(&manager, connection, State::Disconnected).await;
        assert!(
            manager
                .store
                .lock()
                .unwrap()
                .sessions
                .screen(connection)
                .unwrap()
                .completed
        );
        manager.close().await.unwrap();
        config.close().await.unwrap();
    }
}

#[tokio::test]
async fn creation_receipt_capacity_retires_ordered_history_but_keeps_opaque_duplicates() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device_id) = selection(&manager).await;
    let opaque = Uuid::new_v4();
    let old = start(&manager, profile, opaque, revision, device_id).await;
    status(&manager, old, State::Connected).await;
    manager
        .handle(Request::Close { connection: old })
        .await
        .unwrap();
    status(&manager, old, State::Disconnected).await;
    {
        let mut inner = manager.inner.lock().unwrap();
        let spec = Start {
            owner: None,
            profile_id: profile,
            revision,
            device_id,
        };
        for stamp in 2..=1024 {
            inner.starts.insert(
                ordered(stamp),
                (
                    spec,
                    ConnectionInfo {
                        connection_id: ConnectionId(Uuid::new_v4()),
                        generation: 2,
                        protocol: Protocol::Serial,
                        state: State::Connecting,
                    },
                ),
            );
        }
    }
    let new = start(&manager, profile, ordered(1025), revision, device_id).await;
    status(&manager, new, State::Connected).await;
    assert!(matches!(
        manager
            .handle(Request::Start {
                profile_id: profile,
                request_id: ordered(2),
                revision,
                device_id
            })
            .await,
        Err(ErrorCode::RequestExpired)
    ));
    assert_eq!(
        start(&manager, profile, opaque, revision, device_id).await,
        old
    );
    assert_eq!(wire.opens.load(Ordering::Acquire), 2);
    assert_eq!(manager.inner.lock().unwrap().starts.len(), 1024);
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn service_caps_unsettled_tickets_even_if_worker_finishes_before_polling() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    for stamp in 1..=17 {
        manager
            .enqueue(
                None,
                connection,
                ordered(stamp),
                Fingerprint::write(&[1]),
                worker::Command::Write(vec![1]),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while wire.accepted.lock().unwrap().len() < stamp as usize {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
    assert_eq!(
        manager.inner.lock().unwrap().entries[&connection.connection_id]
            .tickets
            .len(),
        17
    );
    assert!(matches!(
        manager.enqueue(
            None,
            connection,
            ordered(18),
            Fingerprint::write(&[1]),
            worker::Command::Write(vec![1])
        ),
        Err(ErrorCode::CapacityExceeded)
    ));
    manager.tick();
    manager
        .enqueue(
            None,
            connection,
            ordered(18),
            Fingerprint::write(&[1]),
            worker::Command::Write(vec![1]),
        )
        .unwrap();
    assert_eq!(
        receipt(&manager, connection, ordered(18)).await.state,
        InputState::DriverAccepted
    );
    assert_eq!(wire.accepted.lock().unwrap().len(), 18);
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

#[tokio::test]
async fn prepared_send_is_encoded_deduplicated_and_cancelled_without_stopping_receive() {
    use session_protocol::{
        Sensitive,
        serial::{Ending, Format, Pace},
    };
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    let send = |id, content: &str, format, ending, pace| Request::Send {
        connection,
        request_id: id,
        content: Sensitive::new(content.into()),
        format,
        ending,
        pace,
    };
    let id = Uuid::new_v4();
    manager
        .handle(send(
            id,
            "00 ff",
            Format::Hex,
            Ending::CrLf,
            Pace::default(),
        ))
        .await
        .unwrap();
    assert_eq!(
        receipt(&manager, connection, id).await.driver_accepted,
        Some(4)
    );
    manager
        .handle(send(
            id,
            "00 ff",
            Format::Hex,
            Ending::CrLf,
            Pace::default(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        manager
            .handle(send(
                id,
                "00 ff",
                Format::Hex,
                Ending::CrLf,
                Pace {
                    chunk_bytes: 1,
                    interval_ms: 0
                }
            ))
            .await,
        Err(ErrorCode::InvalidArgument)
    ));
    assert!(matches!(
        manager
            .handle(send(
                Uuid::new_v4(),
                "GG",
                Format::Hex,
                Ending::None,
                Pace::default()
            ))
            .await,
        Err(ErrorCode::InvalidArgument)
    ));
    assert_eq!(*wire.accepted.lock().unwrap(), [0, 255, 13, 10]);
    let paced_id = Uuid::new_v4();
    manager
        .handle(send(
            paced_id,
            &"x".repeat(61),
            Format::Text,
            Ending::None,
            Pace {
                chunk_bytes: 1,
                interval_ms: 1000,
            },
        ))
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        manager.tick();
        let read = manager.inner.lock().unwrap().entries[&connection.connection_id]
            .status
            .read_bytes;
        if read > 4 {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let tail = Uuid::new_v4();
    manager
        .handle(write(connection, tail, b"never-send"))
        .await
        .unwrap();
    manager.handle(Request::Close { connection }).await.unwrap();
    status(&manager, connection, State::Disconnected).await;
    let result = receipt(&manager, connection, paced_id).await;
    assert_eq!(result.state, InputState::Unknown);
    assert!(result.driver_accepted.unwrap() > 0 && result.driver_accepted.unwrap() < 61);
    assert_eq!(
        receipt(&manager, connection, tail).await.state,
        InputState::CancelledBeforeDispatch
    );
    assert!(
        !wire
            .accepted
            .lock()
            .unwrap()
            .windows(10)
            .any(|bytes| bytes == b"never-send")
    );
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

fn identities(manager: &Manager, connection: ConnectionRef, lifetime: u64) -> (Identity, Identity) {
    use session_core::pairing::{Pairing, SecretToken};
    let token = SecretToken::generate();
    let mut store = manager.store.lock().unwrap();
    store.pairing = Pairing::new(&token);
    let now = store.now();
    let desktop = store.pairing.authenticate(&token, now).unwrap();
    let scopes = [Action::Write, Action::Control]
        .map(|action| Scope {
            target: Target::Connection { connection },
            action,
        })
        .to_vec();
    let (agent, _, _) = store
        .pairing
        .issue_agent(&desktop, scopes, lifetime, now)
        .unwrap();
    (desktop, agent)
}

#[tokio::test]
async fn serial_agent_guards_recheck_real_policy_after_waits_and_keep_user_connection() {
    for cause in [
        "release",
        "lease-expiry",
        "grant-expiry",
        "revoke",
        "takeover",
        "user",
        "user-control",
    ] {
        let (_temp, config, manager, wire, profile) = setup().await;
        let (revision, device) = selection(&manager).await;
        let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
        status(&manager, connection, State::Connected).await;
        let (desktop, agent) = identities(
            &manager,
            connection,
            if cause == "grant-expiry" { 200 } else { 10000 },
        );
        let lease = {
            let mut store = manager.store.lock().unwrap();
            let now = store.now();
            store
                .pairing
                .acquire_lease(
                    &agent,
                    connection,
                    if cause == "grant-expiry" {
                        100
                    } else if cause == "lease-expiry" {
                        200
                    } else {
                        3000
                    },
                    now,
                )
                .unwrap()
        };
        let id = Uuid::new_v4();
        manager
            .handle_authenticated(
                &agent,
                Request::Send {
                    connection,
                    request_id: id,
                    content: session_protocol::Sensitive::new("abc".into()),
                    format: serial::Format::Text,
                    ending: serial::Ending::None,
                    pace: serial::Pace {
                        chunk_bytes: 1,
                        interval_ms: 500,
                    },
                },
            )
            .await
            .unwrap();
        let tail = Uuid::new_v4();
        manager
            .handle_authenticated(&agent, write(connection, tail, b"never"))
            .await
            .unwrap();
        let control = Uuid::new_v4();
        manager
            .handle_authenticated(
                &agent,
                Request::Control {
                    connection,
                    request_id: control,
                    line: Line::Break,
                    asserted: true,
                },
            )
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while wire.writes.load(Ordering::Acquire) == 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        match cause {
            "release" => {
                let mut store = manager.store.lock().unwrap();
                let now = store.now();
                store
                    .pairing
                    .release_lease(&agent, connection, lease.lease_id, now)
                    .unwrap();
                store
                    .pairing
                    .acquire_lease(&agent, connection, 2000, now)
                    .unwrap();
            }
            "lease-expiry" | "grant-expiry" => tokio::time::sleep(Duration::from_millis(250)).await,
            "revoke" => {
                let mut store = manager.store.lock().unwrap();
                let now = store.now();
                store
                    .pairing
                    .revoke(&desktop, agent.ticket_id(), now)
                    .unwrap();
            }
            "takeover" => {
                let mut store = manager.store.lock().unwrap();
                let now = store.now();
                store.pairing.takeover(&desktop, connection, now).unwrap();
            }
            "user" => {
                manager
                    .handle_authenticated(&desktop, write(connection, Uuid::new_v4(), b"user"))
                    .await
                    .unwrap();
            }
            "user-control" => {
                manager
                    .handle_authenticated(
                        &desktop,
                        Request::Control {
                            connection,
                            request_id: Uuid::new_v4(),
                            line: Line::Dtr,
                            asserted: true,
                        },
                    )
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let result = receipt(&manager, connection, id).await;
        assert_eq!(result.driver_accepted, Some(1), "{cause}");
        assert_eq!(result.state, InputState::Unknown, "{cause}");
        assert_eq!(result.failure, Some(Failure::Cancelled));
        assert_eq!(
            receipt(&manager, connection, tail).await.state,
            InputState::CancelledBeforeDispatch
        );
        assert_eq!(
            receipt(&manager, connection, control).await.state,
            InputState::CancelledBeforeDispatch
        );
        // FIFO fence: successful user input proves cancelled tail/control were consumed.
        let fence = Uuid::new_v4();
        manager
            .handle_authenticated(&desktop, write(connection, fence, b"fence"))
            .await
            .unwrap();
        assert_eq!(
            receipt(&manager, connection, fence).await.state,
            InputState::DriverAccepted
        );
        assert_eq!(
            *wire.accepted.lock().unwrap(),
            if cause == "user" {
                b"auserfence".as_slice()
            } else {
                b"afence".as_slice()
            }
        );
        assert_eq!(
            *wire.controls.lock().unwrap(),
            if cause == "user-control" {
                vec![(0, true)]
            } else {
                vec![]
            }
        );
        status(&manager, connection, State::Connected).await;
        manager.close().await.unwrap();
        config.close().await.unwrap();
    }
}

#[tokio::test]
async fn serial_authenticated_receipts_keep_owners_and_independent_write_control_scopes() {
    let (_temp, config, manager, wire, profile) = setup().await;
    let (revision, device) = selection(&manager).await;
    let connection = start(&manager, profile, Uuid::new_v4(), revision, device).await;
    status(&manager, connection, State::Connected).await;
    let (desktop, agent) = identities(&manager, connection, 10000);
    let other = {
        let mut store = manager.store.lock().unwrap();
        let now = store.now();
        store
            .pairing
            .acquire_lease(&agent, connection, 2000, now)
            .unwrap();
        store
            .pairing
            .issue_agent(
                &desktop,
                vec![Scope {
                    target: Target::Connection { connection },
                    action: Action::Write,
                }],
                10000,
                now,
            )
            .unwrap()
            .0
    };
    let id = Uuid::new_v4();
    manager
        .handle_authenticated(&agent, write(connection, id, b"abc"))
        .await
        .unwrap();
    assert_eq!(
        receipt(&manager, connection, id).await.driver_accepted,
        Some(3)
    );
    manager
        .handle_authenticated(&agent, write(connection, id, b"abc"))
        .await
        .unwrap();
    assert!(matches!(
        manager
            .handle_authenticated(&desktop, write(connection, id, b"abc"))
            .await,
        Err(ErrorCode::PermissionDenied)
    ));
    {
        let mut store = manager.store.lock().unwrap();
        let now = store.now();
        let lease = store
            .pairing
            .lease(&agent, connection, now)
            .unwrap()
            .unwrap();
        store
            .pairing
            .release_lease(&agent, connection, lease.lease_id, now)
            .unwrap();
        store
            .pairing
            .acquire_lease(&other, connection, 2000, now)
            .unwrap();
    }
    for bytes in [b"abc".as_slice(), b"other"] {
        assert!(matches!(
            manager
                .handle_authenticated(&other, write(connection, id, bytes))
                .await,
            Err(ErrorCode::PermissionDenied)
        ));
    }
    assert!(matches!(
        manager
            .handle_authenticated(
                &other,
                Request::InputStatus {
                    connection,
                    request_id: id
                }
            )
            .await,
        Err(ErrorCode::PermissionDenied)
    ));
    assert!(matches!(
        manager
            .handle_authenticated(
                &other,
                Request::Control {
                    connection,
                    request_id: Uuid::new_v4(),
                    line: Line::Dtr,
                    asserted: true
                }
            )
            .await,
        Err(ErrorCode::PermissionDenied)
    ));
    assert!(matches!(
        manager
            .handle_authenticated(
                &agent,
                Request::InputStatus {
                    connection,
                    request_id: id
                }
            )
            .await,
        Ok(Reply::Input(_))
    ));
    assert_eq!(*wire.accepted.lock().unwrap(), b"abc");
    manager.close().await.unwrap();
    config.close().await.unwrap();
}

fn connect_identities(manager: &Manager, profile_id: Uuid, lifetime: u64) -> (Identity, Identity) {
    use session_core::pairing::{Pairing, SecretToken};
    let token = SecretToken::generate();
    let mut store = manager.store.lock().unwrap();
    store.pairing = Pairing::new(&token);
    let now = store.now();
    let desktop = store.pairing.authenticate(&token, now).unwrap();
    let (agent, _, _) = store
        .pairing
        .issue_agent(
            &desktop,
            vec![Scope {
                target: Target::Profile { profile_id },
                action: Action::Connect,
            }],
            lifetime,
            now,
        )
        .unwrap();
    (desktop, agent)
}
#[tokio::test]
async fn serial_connect_rechecks_revocation_and_expiry_after_confirmed_profile_wait() {
    for expire in [false, true] {
        let (_temp, config_worker, mut manager, wire, profile_id) = setup().await;
        let (revision, device_id) = selection(&manager).await;
        let profile = manager
            .config
            .request(Internal::Profile(profile_id))
            .await
            .unwrap();
        let (desktop, agent) =
            connect_identities(&manager, profile_id, if expire { 100 } else { 30000 });
        let ticket = agent.ticket_id();
        let (config, query) = Access::held_profile();
        manager.config = config;
        let manager = Arc::new(manager);
        let cloned = manager.clone();
        let pending = tokio::spawn(async move {
            cloned
                .handle_authenticated(
                    &agent,
                    Request::Start {
                        profile_id,
                        request_id: Uuid::new_v4(),
                        revision,
                        device_id,
                    },
                )
                .await
        });
        let response = query.await;
        if expire {
            tokio::time::sleep(Duration::from_millis(150)).await;
        } else {
            let mut s = manager.store.lock().unwrap();
            let now = s.now();
            s.pairing.revoke(&desktop, ticket, now).unwrap();
        }
        response.send(Ok(profile)).ok().unwrap();
        assert!(matches!(
            pending.await.unwrap(),
            Err(ErrorCode::PermissionDenied)
        ));
        assert!(manager.inner.lock().unwrap().entries.is_empty());
        assert!(manager.inner.lock().unwrap().starts.is_empty());
        assert_eq!(wire.opens.load(Ordering::Acquire), 0);
        assert_eq!(wire.driver_opens.load(Ordering::Acquire), 0);
        Arc::try_unwrap(manager)
            .ok()
            .unwrap()
            .close()
            .await
            .unwrap();
        config_worker.close().await.unwrap();
    }
}
#[tokio::test]
async fn serial_worker_connect_checks_before_actual_open_and_close_during_guard_cannot_reopen() {
    for mode in ["revoke", "expire", "close"] {
        let (_temp, config, manager, wire, profile_id) = setup().await;
        let (revision, device_id) = selection(&manager).await;
        let (desktop, agent) = connect_identities(
            &manager,
            profile_id,
            if mode == "expire" { 300 } else { 30000 },
        );
        wire.open_pause.store(true, Ordering::Release);
        let Reply::Started { connection } = manager
            .handle_authenticated(
                &agent,
                Request::Start {
                    profile_id,
                    request_id: Uuid::new_v4(),
                    revision,
                    device_id,
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while !wire.open_waiting.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(wire.driver_opens.load(Ordering::Acquire), 0);
        match mode {
            "expire" => tokio::time::sleep(Duration::from_millis(350)).await,
            "close" => {
                manager
                    .handle_authenticated(
                        &desktop,
                        Request::Close {
                            connection: connection.reference(),
                        },
                    )
                    .await
                    .unwrap();
            }
            _ => {
                let mut s = manager.store.lock().unwrap();
                let now = s.now();
                s.pairing.revoke(&desktop, agent.ticket_id(), now).unwrap();
            }
        }
        wire.open_pause.store(false, Ordering::Release);
        let status = status(
            &manager,
            connection.reference(),
            if mode == "close" {
                State::Disconnected
            } else {
                State::Failed
            },
        )
        .await;
        if mode != "close" {
            assert_eq!(status.failure, Some(Failure::Cancelled));
        }
        assert_eq!(wire.driver_opens.load(Ordering::Acquire), 0);
        assert!(wire.accepted.lock().unwrap().is_empty());
        assert!(wire.controls.lock().unwrap().is_empty());
        manager.close().await.unwrap();
        config.close().await.unwrap();
    }
}
