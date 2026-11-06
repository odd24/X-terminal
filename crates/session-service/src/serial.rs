//! Service-owned serial sessions. Native paths and transport handles never cross IPC.
use crate::{
    config::{Access, Internal, Value},
    server::Store,
};
use session_core::{
    access::{Action, Scope, Target},
    input::{Fingerprint, RequestWindow, ordered_timestamp},
    pairing::Identity,
    session::*,
};
use session_protocol::serial::{self, Failure, InputReceipt, InputState, Line, Reply, Request};
use std::{
    collections::HashMap,
    io,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use transport_serial::{
    Config,
    device::{self, Device, Inventory},
    worker::{self, Worker},
};
use uuid::Uuid;
mod entry;
#[cfg(feature = "serial-ui-fixture")]
mod fixture;
mod start;
#[cfg(test)]
mod tests;

trait Factory: Send + Sync {
    fn inventory(&self) -> io::Result<Inventory>;
    fn open(
        &self,
        config: Config,
        device: Device,
        dispatch: Option<worker::DispatchGuard>,
    ) -> io::Result<Worker>;
}
struct Native;
impl Factory for Native {
    fn inventory(&self) -> io::Result<Inventory> {
        device::inventory()
    }
    fn open(
        &self,
        config: Config,
        device: Device,
        dispatch: Option<worker::DispatchGuard>,
    ) -> io::Result<Worker> {
        Worker::spawn_guarded(config, device, dispatch)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Start {
    owner: Option<Uuid>,
    profile_id: Uuid,
    revision: Uuid,
    device_id: Uuid,
}
struct Record {
    owner: Option<Uuid>,
    fingerprint: Fingerprint,
    receipt: InputReceipt,
}
struct Entry {
    hardware_rts: bool,
    encoding: config_store::Encoding,
    device: Device,
    reference: ConnectionRef,
    profile_id: Uuid,
    port: String,
    worker: Option<Worker>,
    joining: Option<mpsc::Receiver<Result<worker::Status, Failure>>>,
    joined: bool,
    closing: bool,
    status: worker::Status,
    failure: Option<Failure>,
    inputs: HashMap<Uuid, Record>,
    tickets: HashMap<Uuid, worker::Ticket>,
    window: RequestWindow,
}
#[derive(Default)]
struct Inner {
    revision: Uuid,
    devices: HashMap<Uuid, Device>,
    entries: HashMap<ConnectionId, Entry>,
    starts: HashMap<Uuid, (Start, ConnectionInfo)>,
    window: RequestWindow,
}
pub(crate) struct Manager {
    inner: Mutex<Inner>,
    store: Arc<Mutex<Store>>,
    config: Access,
    factory: Arc<dyn Factory>,
}
impl Manager {
    #[cfg(feature = "serial-ui-fixture")]
    pub(crate) fn ui_fixture(mut self) -> Self {
        self.factory = Arc::new(fixture::MemoryFactory);
        self
    }
    pub(crate) fn new(store: Arc<Mutex<Store>>, config: Access) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            store,
            config,
            factory: Arc::new(Native),
        }
    }
    fn duplicate(
        inner: &Inner,
        id: Uuid,
        start: Start,
    ) -> Result<Option<ConnectionInfo>, ErrorCode> {
        match inner.starts.get(&id) {
            Some((old, _)) if old.owner != start.owner => Err(ErrorCode::PermissionDenied),
            Some((old, result)) if *old == start => Ok(Some(result.clone())),
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => {
                inner.window.check(id)?;
                Ok(None)
            }
        }
    }
    pub(crate) async fn handle_authenticated(
        &self,
        identity: &Identity,
        request: Request,
    ) -> Result<Reply, ErrorCode> {
        {
            let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
            let now = store.now();
            store.pairing.require_active(identity, now)?;
            if !store.pairing.is_agent(identity, now)?
                || !matches!(
                    request,
                    Request::Start { .. }
                        | Request::Write { .. }
                        | Request::Send { .. }
                        | Request::Control { .. }
                        | Request::InputStatus { .. }
                )
            {
                store.pairing.require_desktop(identity, now)?;
            }
        }
        self.handle_from(Some(identity), request).await
    }
    #[cfg(test)]
    async fn handle(&self, request: Request) -> Result<Reply, ErrorCode> {
        self.handle_from(None, request).await
    }
    async fn handle_from(
        &self,
        identity: Option<&Identity>,
        request: Request,
    ) -> Result<Reply, ErrorCode> {
        if !request.validate() {
            return Err(ErrorCode::InvalidArgument);
        }
        self.tick();
        match request {
            Request::Inventory {} => {
                let factory = self.factory.clone();
                let inventory = tokio::task::spawn_blocking(move || factory.inventory())
                    .await
                    .map_err(|_| ErrorCode::InvalidState)?
                    .map_err(|_| ErrorCode::InvalidState)?;
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                inner.revision = Uuid::new_v4();
                inner.devices.clear();
                let devices = inventory
                    .devices
                    .into_iter()
                    .map(|device| {
                        let device_id = Uuid::new_v4();
                        let summary = serial::DeviceSummary {
                            device_id,
                            port: device.port_name().into(),
                            instance_id: device.instance_id().into(),
                        };
                        inner.devices.insert(device_id, device);
                        summary
                    })
                    .collect();
                Ok(Reply::Inventory {
                    revision: inner.revision,
                    devices,
                    unidentified_ports: inventory.unidentified_ports,
                    metadata_failures: inventory.metadata_failures,
                })
            }
            Request::Start {
                profile_id,
                request_id,
                revision,
                device_id,
            } => {
                self.start_as(identity, profile_id, request_id, revision, device_id)
                    .await
            }
            Request::Send {
                connection,
                request_id,
                content,
                format,
                ending,
                pace,
            } => {
                let encoding = {
                    let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                    let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    Self::check_action(&store, identity, connection, Action::Write)?;
                    store.sessions.info(connection)?;
                    inner
                        .entries
                        .get(&connection.connection_id)
                        .ok_or(ErrorCode::NotFound)?
                        .encoding
                        .clone()
                };
                let label = match encoding {
                    config_store::Encoding::Utf8 => "utf8",
                    config_store::Encoding::Gbk => "gbk",
                    config_store::Encoding::Gb18030 => "gb18030",
                };
                let bytes =
                    session_core::serial_input::prepare(content.expose(), format, ending, label)
                        .map_err(|_| ErrorCode::InvalidArgument)?;
                if !pace.valid(bytes.len()) {
                    return Err(ErrorCode::InvalidArgument);
                }
                self.enqueue(
                    identity,
                    connection,
                    request_id,
                    Fingerprint::paced_write(&bytes, pace.chunk_bytes, pace.interval_ms),
                    worker::Command::PacedWrite {
                        bytes,
                        chunk_bytes: pace.chunk_bytes,
                        interval: Duration::from_millis(pace.interval_ms),
                    },
                )
            }
            Request::Write {
                connection,
                request_id,
                bytes,
            } => self.enqueue(
                identity,
                connection,
                request_id,
                Fingerprint::write(bytes.expose()),
                worker::Command::Write(bytes.expose().to_vec()),
            ),
            Request::Control {
                connection,
                request_id,
                line,
                asserted,
            } => {
                if line == Line::Rts {
                    let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                    let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                    Self::check_action(&store, identity, connection, Action::Control)?;
                    store.sessions.info(connection)?;
                    if inner
                        .entries
                        .get(&connection.connection_id)
                        .ok_or(ErrorCode::NotFound)?
                        .hardware_rts
                    {
                        return Err(ErrorCode::InvalidArgument);
                    }
                }
                let (code, command) = match line {
                    Line::Dtr => (0, worker::Command::Dtr(asserted)),
                    Line::Rts => (1, worker::Command::Rts(asserted)),
                    Line::Break => (2, worker::Command::Break(asserted)),
                };
                self.enqueue(
                    identity,
                    connection,
                    request_id,
                    Fingerprint::control(code, asserted),
                    command,
                )
            }
            request => {
                let connection = match &request {
                    Request::Status { connection }
                    | Request::InputStatus { connection, .. }
                    | Request::Close { connection }
                    | Request::Forget { connection } => *connection,
                    _ => unreachable!(),
                };
                let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
                let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
                let owner = Self::owner(&store, identity)?;
                if let (Some(owner), Request::InputStatus { request_id, .. }) = (owner, &request)
                    && !inner
                        .entries
                        .get(&connection.connection_id)
                        .filter(|entry| entry.reference == connection)
                        .and_then(|entry| entry.inputs.get(request_id))
                        .is_some_and(|record| record.owner == Some(owner))
                {
                    return Err(ErrorCode::PermissionDenied);
                }
                let info = store.sessions.info(connection)?;
                let entry = inner
                    .entries
                    .get_mut(&connection.connection_id)
                    .ok_or(ErrorCode::NotFound)?;
                match request {
                    Request::Status { .. } => {
                        let cleanup_pending = info.state == State::Closing && !entry.joined;
                        Ok(Reply::Status(serial::Status {
                            hardware_rts: entry.hardware_rts,
                            encoding: entry.encoding.clone(),
                            connection: info,
                            profile_id: entry.profile_id,
                            port: entry.port.clone(),
                            cleanup_pending,
                            failure: entry.failure,
                            read_bytes: entry.status.read_bytes,
                            dropped_bytes: entry.status.dropped_bytes,
                            break_cleanup_failure: entry.status.break_cleanup_error.map(failure),
                        }))
                    }
                    Request::InputStatus { request_id, .. } => {
                        if let Some(record) = entry.inputs.get(&request_id) {
                            if owner.is_some() && record.owner != owner {
                                return Err(ErrorCode::PermissionDenied);
                            }
                            return Ok(Reply::Input(record.receipt.clone()));
                        }
                        entry.window.check(request_id)?;
                        Err(ErrorCode::NotFound)
                    }
                    Request::Close { .. } => {
                        let now = store.now();
                        store.pairing.retire_connection(connection, now);
                        entry.closing = true;
                        if let Some(worker) = &entry.worker {
                            worker.cancel();
                        }
                        if !matches!(
                            info.state,
                            State::Closing | State::Disconnected | State::Failed
                        ) {
                            store.sessions.transition(connection, State::Closing)?;
                        }
                        Ok(Reply::Accepted)
                    }
                    Request::Forget { .. } => {
                        if !entry.joined
                            || !entry.tickets.is_empty()
                            || !matches!(info.state, State::Disconnected | State::Failed)
                        {
                            return Err(ErrorCode::InvalidState);
                        }
                        let now = store.now();
                        store.pairing.retire_connection(connection, now);
                        store.sessions.remove(connection)?;
                        inner.entries.remove(&connection.connection_id);
                        Ok(Reply::Accepted)
                    }
                    _ => unreachable!(),
                }
            }
        }
    }
    fn enqueue(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        fingerprint: Fingerprint,
        command: worker::Command,
    ) -> Result<Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = Self::owner(&store, identity)?;
        let action = if matches!(
            command,
            worker::Command::Write(_) | worker::Command::PacedWrite { .. }
        ) {
            Action::Write
        } else {
            Action::Control
        };
        // Authorization precedes connection/encoding disclosure; final admission
        // and Desktop takeover share the same store lock as worker dispatch.
        Self::check_action(&store, identity, connection, action)?;
        let info = store.sessions.info(connection)?;
        if owner.is_some() && info.protocol != Protocol::Serial {
            return Err(ErrorCode::PermissionDenied);
        }
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if let Some(record) = entry.inputs.get(&id) {
            if record.owner != owner {
                return Err(ErrorCode::PermissionDenied);
            }
            return if record.fingerprint == fingerprint {
                Ok(Reply::Input(record.receipt.clone()))
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        entry.window.check(id)?;
        let now = store.now();
        let dispatch = if owner.is_some() {
            let identity = identity.unwrap().clone();
            let permit = store.pairing.admit_input(
                &identity,
                Scope {
                    target: Target::Connection { connection },
                    action,
                },
                id,
                now,
            )?;
            let shared = self.store.clone();
            Some(Arc::new(move || {
                let Ok(mut store) = shared.lock() else {
                    return false;
                };
                let now = store.now();
                store
                    .sessions
                    .info(connection)
                    .is_ok_and(|i| i.state == State::Connected)
                    && store
                        .pairing
                        .dispatch_input(&identity, &permit, now)
                        .is_ok()
            }) as worker::DispatchGuard)
        } else {
            // Actual user input, including paced Send and control-line buttons.
            // No connection cancellation: queued Agent guards invalidate in place.
            if let Some(identity) = identity {
                store.pairing.takeover(identity, connection, now)?;
            }
            None
        };
        if info.state != State::Connected || entry.closing {
            return Err(ErrorCode::NotConnected);
        }
        if entry.tickets.len() > worker::QUEUED_COMMANDS {
            return Err(ErrorCode::CapacityExceeded);
        }
        if entry.inputs.len() >= 1024 {
            let (old, stamp) = entry
                .inputs
                .iter()
                .filter(|(_, record)| record.receipt.state != InputState::Pending)
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            entry.window.retire(stamp);
            entry.inputs.remove(&old);
            entry.window.check(id)?;
        }
        let ticket = entry
            .worker
            .as_ref()
            .ok_or(ErrorCode::NotConnected)?
            .submit_guarded(command, dispatch)
            .map_err(|error| match error {
                worker::SubmitError::Full => ErrorCode::CapacityExceeded,
                worker::SubmitError::InvalidInput => ErrorCode::InvalidArgument,
                _ => ErrorCode::NotConnected,
            })?;
        let receipt = InputReceipt {
            request_id: id,
            state: InputState::Pending,
            driver_accepted: None,
            failure: None,
        };
        entry.inputs.insert(
            id,
            Record {
                owner,
                fingerprint,
                receipt: receipt.clone(),
            },
        );
        entry.tickets.insert(id, ticket);
        Ok(Reply::Input(receipt))
    }
    fn owner(store: &Store, identity: Option<&Identity>) -> Result<Option<Uuid>, ErrorCode> {
        let Some(identity) = identity else {
            return Ok(None);
        };
        if store.pairing.is_agent(identity, store.now())? {
            Ok(Some(identity.ticket_id()))
        } else {
            store.pairing.require_desktop(identity, store.now())?;
            Ok(None)
        }
    }
    fn check_action(
        store: &Store,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        action: Action,
    ) -> Result<(), ErrorCode> {
        if Self::owner(store, identity)?.is_some() {
            store.pairing.check_action(
                identity.unwrap(),
                Scope {
                    target: Target::Connection { connection },
                    action,
                },
                store.now(),
            )?;
        }
        Ok(())
    }
    pub(crate) fn tick(&self) {
        let mut inner = self.inner.lock().unwrap();
        let mut store = self.store.lock().unwrap();
        for entry in inner.entries.values_mut() {
            entry.poll(&mut store);
        }
    }
    pub(crate) async fn close(self) -> io::Result<()> {
        {
            let mut inner = self.inner.lock().unwrap();
            for entry in inner.entries.values_mut() {
                entry.closing = true;
                if let Some(worker) = &entry.worker {
                    worker.cancel();
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            self.tick();
            if self
                .inner
                .lock()
                .unwrap()
                .entries
                .values()
                .all(|entry| entry.joined)
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "serial handles did not finish cleanup; service must exit",
                ));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
fn parameters(settings: &config_store::Settings) -> Result<Config, ErrorCode> {
    use config_store::{Flow, Parity, Settings};
    use serialport::{DataBits, FlowControl, StopBits};
    let Settings::Serial {
        port,
        baud_rate,
        data_bits,
        stop_bits,
        parity,
        flow,
        dtr_on_open,
        rts_on_open,
        ..
    } = settings
    else {
        return Err(ErrorCode::Unsupported);
    };
    let config = Config {
        port: port.clone(),
        baud_rate: *baud_rate,
        data_bits: match data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => return Err(ErrorCode::InvalidArgument),
        },
        stop_bits: match stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => return Err(ErrorCode::InvalidArgument),
        },
        parity: match parity {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        },
        flow_control: match flow {
            Flow::None => FlowControl::None,
            Flow::Software => FlowControl::Software,
            Flow::Hardware => FlowControl::Hardware,
        },
        dtr_on_open: *dtr_on_open,
        rts_on_open: *rts_on_open,
    };
    config.validate().map_err(|_| ErrorCode::InvalidArgument)?;
    Ok(config)
}
fn failure(kind: io::ErrorKind) -> Failure {
    match kind {
        io::ErrorKind::NotFound => Failure::DeviceUnavailable,
        io::ErrorKind::PermissionDenied => Failure::AccessOrBusy,
        io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported => Failure::InvalidParameters,
        _ => Failure::Io,
    }
}
fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
