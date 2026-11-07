use super::*;
use session_core::input::{RequestWindow, ordered_timestamp};
use session_core::task_output::Buffer;
use ssh::{ExecEnd, ExecSummary, TaskPhase, TaskStatus};
#[derive(Default)]
pub(super) struct Tasks {
    requests: HashMap<Uuid, (Fingerprint, Uuid)>,
    items: HashMap<Uuid, Task>,
    window: RequestWindow,
}
struct Task {
    owner: Option<Uuid>,
    status: TaskStatus,
    output: Buffer,
    cancel: Cancellation,
    stdout: usize,
    stderr: usize,
    dequeued: bool,
}
pub(super) struct Queued {
    pub(super) task_id: Uuid,
    pub(super) command: Sensitive,
    pub(super) encoded: session_protocol::SensitiveBytes,
    pub(super) options: transport::ExecOptions,
}
impl Queued {
    pub(super) fn fingerprint(&self) -> Fingerprint {
        Fingerprint::exec(
            self.command.expose(),
            self.options.timeout.as_millis() as u64,
            self.options.max_output_bytes,
        )
    }
}
fn task_owner(identity: Option<&Identity>, store: &Store) -> Result<Option<Uuid>, ErrorCode> {
    match identity {
        Some(identity) if store.pairing.is_agent(identity, store.now())? => {
            Ok(Some(identity.ticket_id()))
        }
        Some(identity) => {
            store.pairing.require_desktop(identity, store.now())?;
            Ok(None)
        }
        None => Ok(None),
    }
}
fn status_reply(
    identity: Option<&Identity>,
    store: &Store,
    status: &TaskStatus,
) -> Result<ssh::Reply, ErrorCode> {
    let mut status = status.clone();
    if let Some(identity) = identity
        && let Some(policy) = store.pairing.output_protection(identity, store.now())?
        && let Some(summary) = status.summary.as_mut()
        && let Some(signal) = summary.exit_signal.as_mut()
    {
        let projected = policy
            .rules
            .project(&[signal], session_core::redaction::Boundaries::default())?;
        *signal = projected.fragments.into_iter().next().unwrap();
    }
    Ok(ssh::Reply::Exec(status))
}
impl Manager {
    pub(super) fn start_exec(
        &self,
        connection: ConnectionRef,
        request_id: Uuid,
        command: Sensitive,
        timeout_ms: u64,
        max_output_bytes: usize,
    ) -> Result<ssh::Reply, ErrorCode> {
        self.start_exec_as(
            None,
            connection,
            request_id,
            command,
            timeout_ms,
            max_output_bytes,
        )
    }
    pub(super) fn start_exec_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        request_id: Uuid,
        command: Sensitive,
        timeout_ms: u64,
        max_output_bytes: usize,
    ) -> Result<ssh::Reply, ErrorCode> {
        let fingerprint = Fingerprint::exec(command.expose(), timeout_ms, max_output_bytes);
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = task_owner(identity, &store)?;
        // A retained same-owner retry only recovers a receipt; it does not dispatch again
        // or require renewing a released lease. Unknown/new requests still require Exec.
        if let Some(entry) = inner
            .entries
            .get(&connection.connection_id)
            .filter(|entry| entry.reference == connection)
            && let Some((old, id)) = entry.exec.requests.get(&request_id)
        {
            if entry.exec.items[id].owner != owner {
                return Err(ErrorCode::PermissionDenied);
            }
            store.sessions.info(connection)?;
            return if *old == fingerprint {
                status_reply(identity, &store, &entry.exec.items[id].status)
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        let now = store.now();
        let authority = if let Some(identity) = identity.filter(|_| owner.is_some()) {
            Some((
                identity.clone(),
                store.pairing.admit_input(
                    identity,
                    Scope {
                        target: Target::Connection { connection },
                        action: Action::Exec,
                    },
                    request_id,
                    now,
                )?,
            ))
        } else {
            None
        };
        let info = store.sessions.info(connection)?;
        let total = inner
            .entries
            .values()
            .map(|entry| entry.exec.items.len())
            .sum::<usize>();
        let active = inner
            .entries
            .values()
            .flat_map(|entry| entry.exec.items.values())
            .filter(|task| task.status.phase != TaskPhase::Finished)
            .count();
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if let Some((old, id)) = entry.exec.requests.get(&request_id) {
            if entry.exec.items[id].owner != owner {
                return Err(ErrorCode::PermissionDenied);
            }
            return if *old == fingerprint {
                status_reply(identity, &store, &entry.exec.items[id].status)
            } else {
                Err(ErrorCode::InvalidArgument)
            };
        }
        let encoded = encode_text(&entry.encoding, command.expose())?;
        entry.receipts.check_available(request_id)?;
        if info.state != State::Connected {
            return Err(ErrorCode::NotConnected);
        }
        if entry.cancel.is_cancelled() || entry.challenge.is_some() || !*entry.writable.borrow() {
            return Err(ErrorCode::InvalidState);
        }
        entry.exec.window.check(request_id)?;
        if active >= 16
            || entry
                .exec
                .items
                .values()
                .filter(|task| task.status.phase != TaskPhase::Finished)
                .count()
                >= 4
        {
            return Err(ErrorCode::CapacityExceeded);
        }
        if let Some(desktop) = identity.filter(|_| owner.is_none()) {
            store.pairing.takeover(desktop, connection, now)?;
            entry.receipts.cancel_agent_pending();
            entry.exec.cancel_agent_pending();
        }
        let sender = entry
            .commands
            .as_ref()
            .ok_or(ErrorCode::NotConnected)?
            .clone();
        let permit = sender
            .try_reserve()
            .map_err(|_| ErrorCode::CapacityExceeded)?;
        // Reserve queue space before reclaiming results. Only terminal, dequeued ordered
        // tasks are eligible; cancelling queued work must still be consumed by its actor.
        if entry.exec.items.len() >= 16 {
            let (old_id, stamp) = entry.exec.oldest().ok_or(ErrorCode::CapacityExceeded)?;
            entry.exec.retire(old_id, stamp);
        }
        entry.exec.window.check(request_id)?;
        if total >= 64 {
            // A local retirement above already made a slot. Otherwise reclaim a terminal
            // task from another connection, retaining that connection's replay watermark.
            let now_total: usize = inner
                .entries
                .values()
                .map(|entry| entry.exec.items.len())
                .sum();
            if now_total >= 64 {
                let (owner, old_id, stamp) = inner
                    .entries
                    .iter()
                    .filter_map(|(owner, entry)| {
                        entry.exec.oldest().map(|(id, stamp)| (*owner, id, stamp))
                    })
                    .min_by_key(|(_, _, stamp)| *stamp)
                    .ok_or(ErrorCode::CapacityExceeded)?;
                inner
                    .entries
                    .get_mut(&owner)
                    .unwrap()
                    .exec
                    .retire(old_id, stamp);
            }
        }
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        entry.exec.window.check(request_id)?;
        let task_id = if ordered_timestamp(request_id).is_some() {
            request_id
        } else {
            Uuid::new_v4()
        };
        let status = TaskStatus {
            task_id,
            connection,
            phase: TaskPhase::Queued,
            encoding: entry.encoding.clone(),
            summary: None,
        };
        entry
            .exec
            .requests
            .insert(request_id, (fingerprint, task_id));
        entry.exec.items.insert(
            task_id,
            Task {
                owner,
                status: status.clone(),
                output: Buffer::default(),
                cancel: Cancellation::default(),
                stdout: 0,
                stderr: 0,
                dequeued: false,
            },
        );
        permit.send(QueuedInput {
            authority,
            id: request_id,
            input: Input::Exec(Queued {
                task_id,
                command,
                encoded: session_protocol::SensitiveBytes::new(encoded),
                options: transport::ExecOptions {
                    timeout: Duration::from_millis(timeout_ms),
                    max_output_bytes,
                },
            }),
        });
        status_reply(identity, &store, &status)
    }
    pub(super) fn exec_status(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        cancel: bool,
    ) -> Result<ssh::Reply, ErrorCode> {
        self.exec_status_as(None, connection, id, cancel)
    }
    pub(super) fn exec_status_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        cancel: bool,
    ) -> Result<ssh::Reply, ErrorCode> {
        let mut inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = task_owner(identity, &store)?;
        store.sessions.info(connection)?;
        let entry = inner
            .entries
            .get_mut(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if !entry.exec.items.contains_key(&id) {
            entry.exec.window.check(id)?;
        }
        let task = entry.exec.items.get_mut(&id).ok_or(ErrorCode::NotFound)?;
        if owner.is_some() && task.owner != owner {
            return Err(ErrorCode::PermissionDenied);
        }
        if cancel && task.status.phase != TaskPhase::Finished {
            task.cancel.cancel();
            if task.status.phase == TaskPhase::Queued {
                task.finish(ExecEnd::CancelledBeforeDispatch);
            } else {
                task.status.phase = TaskPhase::Cancelling;
            }
        }
        status_reply(identity, &store, &task.status)
    }
    pub(super) fn exec_read(
        &self,
        connection: ConnectionRef,
        id: Uuid,
        cursor: u64,
        max_bytes: usize,
    ) -> Result<ssh::Reply, ErrorCode> {
        self.exec_read_as(None, connection, id, cursor, max_bytes)
    }
    pub(super) fn exec_read_as(
        &self,
        identity: Option<&Identity>,
        connection: ConnectionRef,
        id: Uuid,
        cursor: u64,
        max_bytes: usize,
    ) -> Result<ssh::Reply, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = task_owner(identity, &store)?;
        if let Some(identity) = identity {
            store
                .pairing
                .require_unfiltered_output(identity, store.now())?;
        }
        store.sessions.info(connection)?;
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if !entry.exec.items.contains_key(&id) {
            entry.exec.window.check(id)?;
        }
        let task = entry.exec.items.get(&id).ok_or(ErrorCode::NotFound)?;
        if owner.is_some() && task.owner != owner {
            return Err(ErrorCode::PermissionDenied);
        }
        Ok(ssh::Reply::ExecOutput {
            connection,
            task_id: id,
            output: task.output.read(
                cursor,
                max_bytes,
                task.status.phase == TaskPhase::Finished,
            )?,
        })
    }
    pub(super) fn exec_read_protected(
        &self,
        identity: &Identity,
        connection: ConnectionRef,
        id: Uuid,
        view: session_core::protected_task::View,
    ) -> Result<ssh::Reply, ErrorCode> {
        let inner = self.inner.lock().map_err(|_| ErrorCode::InvalidState)?;
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let owner = task_owner(Some(identity), &store)?;
        let policy = store
            .pairing
            .output_protection(identity, store.now())?
            .ok_or(ErrorCode::PermissionDenied)?;
        store.sessions.info(connection)?;
        let entry = inner
            .entries
            .get(&connection.connection_id)
            .ok_or(ErrorCode::NotFound)?;
        if !entry.exec.items.contains_key(&id) {
            entry.exec.window.check(id)?;
        }
        let task = entry.exec.items.get(&id).ok_or(ErrorCode::NotFound)?;
        if task.owner != owner {
            return Err(ErrorCode::PermissionDenied);
        }
        let encoding = match task.status.encoding {
            config_store::Encoding::Utf8 => "utf-8",
            config_store::Encoding::Gbk => "gbk",
            config_store::Encoding::Gb18030 => "gb18030",
        };
        Ok(ssh::Reply::ExecProtectedOutput {
            connection,
            task_id: id,
            output: Box::new(task.output.protected_read(
                task.status.phase == TaskPhase::Finished,
                encoding,
                view,
                &policy,
            )?),
        })
    }
}
impl Task {
    fn finish(&mut self, end: ExecEnd) {
        self.status.phase = TaskPhase::Finished;
        self.status.summary = Some(ExecSummary {
            end,
            exit_status: None,
            exit_signal: None,
            request_accepted: None,
            output_truncated: false,
            stdout_bytes: self.stdout,
            stderr_bytes: self.stderr,
        });
    }
}
impl Tasks {
    pub(super) fn cancel_pending(&mut self, id: Uuid, dequeued: bool) {
        if let Some(task) = self.items.get_mut(&id) {
            if dequeued {
                task.dequeued = true;
            }
            if task.status.phase == TaskPhase::Queued {
                task.finish(ExecEnd::CancelledBeforeDispatch);
            }
        }
    }
    pub(super) fn cancel_agent_pending(&mut self) {
        for task in self.items.values_mut() {
            if task.owner.is_some() && task.status.phase == TaskPhase::Queued {
                task.finish(ExecEnd::CancelledBeforeDispatch);
            }
        }
    }

    fn oldest(&self) -> Option<(Uuid, u64)> {
        self.requests
            .iter()
            .filter_map(|(request, (_, id))| {
                let task = self.items.get(id)?;
                if task.status.phase != TaskPhase::Finished || !task.dequeued {
                    return None;
                }
                ordered_timestamp(*request).map(|stamp| (*request, stamp))
            })
            .min_by_key(|(_, stamp)| *stamp)
    }
    fn retire(&mut self, request: Uuid, stamp: u64) {
        self.window.retire(stamp);
        if let Some((_, id)) = self.requests.remove(&request) {
            self.items.remove(&id);
        }
    }
    pub(super) fn check_available(&self, id: Uuid) -> Result<(), ErrorCode> {
        if self.contains(id) {
            return Err(ErrorCode::InvalidArgument);
        }
        self.window.check(id)
    }
    pub(super) fn contains(&self, id: Uuid) -> bool {
        self.requests.contains_key(&id)
    }
    pub(super) fn finish_all(&mut self, cancelled: bool) {
        for task in self
            .items
            .values_mut()
            .filter(|task| task.status.phase != TaskPhase::Finished)
        {
            task.cancel.cancel();
            let end = if task.status.phase == TaskPhase::Queued {
                ExecEnd::CancelledBeforeDispatch
            } else if cancelled {
                ExecEnd::Cancelled
            } else {
                ExecEnd::TransportLost
            };
            task.finish(end);
        }
    }
}
pub(super) fn launch(
    jobs: &mut tokio::task::JoinSet<()>,
    queued: Queued,
    inner: Arc<Mutex<Inner>>,
    reference: ConnectionRef,
    session: Arc<Ssh2Session>,
    store: Arc<Mutex<Store>>,
    authority: Option<(Identity, Permit)>,
) -> Result<(), Failure> {
    let cancel = {
        let mut all = inner.lock().map_err(|_| Failure::Transport)?;
        let task = all
            .entries
            .get_mut(&reference.connection_id)
            .filter(|entry| entry.reference == reference)
            .and_then(|entry| entry.exec.items.get_mut(&queued.task_id))
            .ok_or(Failure::Transport)?;
        task.dequeued = true;
        if task.status.phase == TaskPhase::Finished {
            return Ok(());
        }
        task.cancel.clone()
    };
    jobs.spawn(async move {
        {
            let mut all = inner.lock().unwrap();
            let mut store = store.lock().unwrap();
            let Some(task) = all
                .entries
                .get_mut(&reference.connection_id)
                .filter(|entry| entry.reference == reference)
                .and_then(|entry| entry.exec.items.get_mut(&queued.task_id))
            else {
                return;
            };
            if task.status.phase == TaskPhase::Finished {
                return;
            }
            let now = store.now();
            if let Some((identity, permit)) = &authority
                && store.pairing.dispatch_input(identity, permit, now).is_err()
            {
                task.finish(ExecEnd::CancelledBeforeDispatch);
                return;
            }
            task.status.phase = TaskPhase::Running;
        }
        let (output, mut receiver) = mpsc::channel(8);
        let work = session.exec_streaming(queued.encoded.expose(), queued.options, &cancel, output);
        let drain = async {
            while let Some(chunk) = receiver.recv().await {
                let mut all = inner.lock().unwrap();
                if let Some(task) = all
                    .entries
                    .get_mut(&reference.connection_id)
                    .filter(|entry| entry.reference == reference)
                    .and_then(|entry| entry.exec.items.get_mut(&queued.task_id))
                    && task.status.phase != TaskPhase::Finished
                {
                    if chunk.stderr {
                        task.stderr += chunk.bytes.len();
                    } else {
                        task.stdout += chunk.bytes.len();
                    }
                    task.output.append(chunk.stderr, &chunk.bytes);
                }
            }
        };
        let (result, ()) = tokio::join!(work, drain);
        let mut all = inner.lock().unwrap();
        if let Some(task) = all
            .entries
            .get_mut(&reference.connection_id)
            .filter(|entry| entry.reference == reference)
            .and_then(|entry| entry.exec.items.get_mut(&queued.task_id))
            && task.status.phase != TaskPhase::Finished
        {
            // Cancellation can interrupt a backpressured chunk send after the transport captured it.
            // Reconcile the bounded per-stream tails before publishing completion.
            if let Ok(result) = &result {
                if task.stdout < result.stdout.len() {
                    task.output.append(false, &result.stdout[task.stdout..]);
                    task.stdout = result.stdout.len();
                }
                if task.stderr < result.stderr.len() {
                    task.output.append(true, &result.stderr[task.stderr..]);
                    task.stderr = result.stderr.len();
                }
            }
            task.status.phase = TaskPhase::Finished;
            task.status.summary = Some(match result {
                Ok(result) => ExecSummary {
                    end: match result.end {
                        transport::ExecEnd::Completed => ExecEnd::Completed,
                        transport::ExecEnd::RemoteSignal => ExecEnd::RemoteSignal,
                        transport::ExecEnd::MissingExitStatus => ExecEnd::MissingExitStatus,
                        transport::ExecEnd::TransportLost => ExecEnd::TransportLost,
                        transport::ExecEnd::Rejected => ExecEnd::Rejected,
                        transport::ExecEnd::Timeout => ExecEnd::Timeout,
                        transport::ExecEnd::Cancelled => ExecEnd::Cancelled,
                        transport::ExecEnd::OutputLimit => ExecEnd::OutputLimit,
                        transport::ExecEnd::ProtocolFailure => ExecEnd::ProtocolFailure,
                    },
                    exit_status: result.exit_status,
                    exit_signal: result.exit_signal.map(|signal| signal.name),
                    request_accepted: Some(result.request_accepted),
                    output_truncated: result.output_truncated,
                    stdout_bytes: result.stdout.len(),
                    stderr_bytes: result.stderr.len(),
                },
                Err(error) => ExecSummary {
                    end: match error {
                        transport::Error::Cancelled => ExecEnd::Cancelled,
                        transport::Error::Timeout => ExecEnd::Timeout,
                        _ => ExecEnd::TransportLost,
                    },
                    exit_status: None,
                    exit_signal: None,
                    request_accepted: None,
                    output_truncated: false,
                    stdout_bytes: task.stdout,
                    stderr_bytes: task.stderr,
                },
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    #[test]
    fn queued_cancellation_is_not_reclaimable_until_dequeued_and_opaque_ids_are_pinned() {
        let connection = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        let ordered = Uuid::from_u128((10u128 << 80) | 0x7000_8000_0000_0000_0001);
        let opaque = Uuid::new_v4();
        let mut tasks = Tasks::default();
        for id in [ordered, opaque] {
            tasks
                .requests
                .insert(id, (Fingerprint::exec("synthetic", 1000, 4096), id));
            tasks.items.insert(
                id,
                Task {
                    owner: (id == ordered).then(Uuid::new_v4),
                    status: TaskStatus {
                        task_id: id,
                        connection,
                        phase: TaskPhase::Queued,
                        encoding: config_store::Encoding::Utf8,
                        summary: None,
                    },
                    output: Buffer::default(),
                    cancel: Cancellation::default(),
                    stdout: 0,
                    stderr: 0,
                    dequeued: false,
                },
            );
        }
        tasks.cancel_agent_pending();
        assert_eq!(
            tasks.items[&ordered].status.summary.as_ref().unwrap().end,
            ExecEnd::CancelledBeforeDispatch
        );
        assert!(!tasks.items[&ordered].dequeued);
        tasks
            .items
            .get_mut(&opaque)
            .unwrap()
            .finish(ExecEnd::Completed);
        tasks.items.get_mut(&opaque).unwrap().dequeued = true;
        assert!(tasks.oldest().is_none());
        tasks.items.get_mut(&ordered).unwrap().dequeued = true;
        assert_eq!(tasks.oldest(), Some((ordered, 10)));
        tasks.retire(ordered, 10);
        assert!(tasks.items.contains_key(&opaque));
        assert!(tasks.oldest().is_none());
        assert_eq!(
            tasks.check_available(ordered),
            Err(ErrorCode::RequestExpired)
        );
        assert_eq!(
            tasks.check_available(opaque),
            Err(ErrorCode::InvalidArgument)
        );
    }
}
