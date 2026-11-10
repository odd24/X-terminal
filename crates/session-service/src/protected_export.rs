use crate::server::Store;
use session_core::{
    access::Permit,
    pairing::{Identity, protection::ProtectedPolicy},
    session::{EndedOutput, EndedOutputSnapshot, ErrorCode},
};
use session_protocol::{export::*, operation::Operation};
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};
use terminal_log::{CleanupPreview, ExportFingerprint, ExportStore};
use uuid::Uuid;

const MAX_RECEIPTS: usize = 64;
const ARTIFACT_TTL_MS: u64 = 120_000;
type Key = (Uuid, Query);

struct Entry {
    owner: Identity,
    source: EndedOutput,
    permit: Permit,
    receipt: Receipt,
    artifact_id: Uuid,
    on_disk: bool,
    fingerprint: Option<ExportFingerprint>,
    save_committed: bool,
    cleanup_failed: bool,
    until: u64,
}
impl Entry {
    fn allowed(&self, store: &Store) -> Result<(), ErrorCode> {
        let now = store.now();
        store.pairing.check_input(&self.owner, &self.permit, now)?;
        if now >= self.until {
            return Err(ErrorCode::RequestExpired);
        }
        if store.sessions.ended_output(self.source.connection)? != self.source {
            return Err(ErrorCode::InvalidState);
        }
        Ok(())
    }
}

struct Job {
    key: Key,
    artifact_id: Uuid,
    snapshot: EndedOutputSnapshot,
    policy: Arc<ProtectedPolicy>,
    directory: PathBuf,
}

type Ledger = Arc<Mutex<HashMap<Key, Entry>>>;

pub(crate) struct Manager {
    store: Arc<Mutex<Store>>,
    ledger: Ledger,
    sender: mpsc::SyncSender<Job>,
    worker: thread::JoinHandle<io::Result<()>>,
}

impl Manager {
    pub(crate) fn new(store: Arc<Mutex<Store>>, directory: Option<PathBuf>) -> io::Result<Self> {
        let ledger = Ledger::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker_store = store.clone();
        let worker_ledger = ledger.clone();
        let worker = thread::Builder::new()
            .name("protected-output-export".into())
            .spawn(move || run(receiver, worker_store, worker_ledger, directory))?;
        Ok(Self {
            store,
            ledger,
            sender,
            worker,
        })
    }

    pub(crate) fn start(
        &self,
        owner: &Identity,
        target: Start,
        directory: PathBuf,
    ) -> Result<Receipt, ErrorCode> {
        let operation = Operation::Export(target.clone()).key()?;
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let now = store.now();
        let source = target.retained_ended_output;
        let query = Query {
            connection: source.connection,
            request_id: target.request_id,
        };
        let permit = store
            .pairing
            .admit_export(owner, query.connection, operation, now)?;
        let policy = store
            .pairing
            .output_protection(owner, now)?
            .ok_or(ErrorCode::PermissionDenied)?;
        let mut ledger = self.ledger.lock().map_err(|_| ErrorCode::InvalidState)?;
        let key = (owner.ticket_id(), query);
        if let Some(entry) = ledger.get(&key) {
            entry.allowed(&store)?;
            return Ok(entry.receipt);
        }
        if ledger.len() >= MAX_RECEIPTS {
            return Err(ErrorCode::CapacityExceeded);
        }
        let snapshot = store.sessions.snapshot_ended_output(&source)?;
        let artifact_id = Uuid::new_v4();
        let receipt = Receipt {
            query,
            state: Phase::Preparing,
        };
        let job = Job {
            key,
            artifact_id,
            snapshot,
            policy,
            directory,
        };
        self.sender.try_send(job).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
            mpsc::TrySendError::Disconnected(_) => ErrorCode::InvalidState,
        })?;
        ledger.insert(
            key,
            Entry {
                owner: owner.clone(),
                source,
                permit,
                receipt,
                artifact_id,
                on_disk: false,
                fingerprint: None,
                save_committed: false,
                cleanup_failed: false,
                until: now.saturating_add(ARTIFACT_TTL_MS),
            },
        );
        Ok(receipt)
    }

    pub(crate) fn status(
        &self,
        owner: &Identity,
        query: Query,
        cancel: bool,
    ) -> Result<Receipt, ErrorCode> {
        let store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        store.pairing.require_agent(owner, store.now())?;
        let mut ledger = self.ledger.lock().map_err(|_| ErrorCode::InvalidState)?;
        let entry = ledger
            .get_mut(&(owner.ticket_id(), query))
            .ok_or(ErrorCode::NotFound)?;
        entry.allowed(&store)?;
        if cancel && entry.receipt.state == Phase::Preparing {
            entry.receipt.state = Phase::Cancelled;
        }
        Ok(entry.receipt)
    }

    pub(crate) fn save(
        &self,
        desktop: &Identity,
        scope: ArtifactScope,
        save_id: Option<Uuid>,
    ) -> Result<Reply, ErrorCode> {
        let mut store = self.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let now = store.now();
        store.pairing.require_desktop(desktop, now)?;
        let mut ledger = self.ledger.lock().map_err(|_| ErrorCode::InvalidState)?;
        let entry = ledger
            .values_mut()
            .find(|entry| {
                entry.artifact_id == scope.artifact_id && entry.receipt.query == scope.query
            })
            .ok_or(ErrorCode::NotFound)?;
        entry.allowed(&store)?;
        if entry.receipt.state
            != (Phase::Completed {
                artifact_id: scope.artifact_id,
            })
            || entry.save_committed
        {
            return Err(ErrorCode::InvalidState);
        }
        if let Some(save_id) = save_id {
            store
                .pairing
                .dispatch_input(&entry.owner, &entry.permit, now)?;
            entry.save_committed = true;
            Ok(Reply::SaveCommitted { scope, save_id })
        } else {
            let fingerprint = entry.fingerprint.ok_or(ErrorCode::InvalidState)?;
            Ok(Reply::SaveSource {
                scope,
                bytes: fingerprint.bytes,
                sha256: fingerprint.sha256,
            })
        }
    }

    pub(crate) async fn close(self) -> io::Result<()> {
        drop(self.sender);
        tokio::task::spawn_blocking(move || self.worker.join())
            .await
            .map_err(|_| io::Error::other("protected export join failed"))?
            .map_err(|_| io::Error::other("protected export worker failed"))?
    }
}

fn run(
    receiver: mpsc::Receiver<Job>,
    store: Arc<Mutex<Store>>,
    ledger: Ledger,
    directory: Option<PathBuf>,
) -> io::Result<()> {
    let mut storage = None;
    if let Some(directory) = directory {
        match std::fs::symlink_metadata(directory.join(MANAGED_DIRECTORY)) {
            Ok(_) => match open(&directory) {
                Ok(exports) => storage = Some((directory, exports)),
                Err(_) => eprintln!("protected export startup cleanup incomplete"),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => eprintln!("protected export startup cleanup unavailable"),
        }
    }
    loop {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(job) => process(job, &store, &ledger, &mut storage),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Some((_, exports)) = storage.as_mut() {
            let _ = reap(&store, &ledger, exports, false);
        }
    }
    if let Some((_, exports)) = storage.as_mut() {
        reap(&store, &ledger, exports, true)?;
    }
    Ok(())
}

fn open(directory: &Path) -> io::Result<ExportStore> {
    let root = directory.join(MANAGED_DIRECTORY);
    match std::fs::create_dir(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let mut exports = ExportStore::open(&root)?;
    for id in CleanupPreview::export_ids(&root)? {
        cleanup(&mut exports, id)?;
    }
    Ok(exports)
}

fn cleanup(exports: &mut ExportStore, artifact_id: Uuid) -> io::Result<()> {
    match exports.preview_cleanup(artifact_id) {
        Ok(preview) => {
            if preview.apply().directory_removed {
                Ok(())
            } else {
                Err(io::Error::other("protected export cleanup incomplete"))
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn pending(store: &Mutex<Store>, ledger: &Ledger, key: Key) -> bool {
    let Ok(store) = store.lock() else {
        return false;
    };
    let Ok(ledger) = ledger.lock() else {
        return false;
    };
    ledger.get(&key).is_some_and(|entry| {
        entry.receipt.state == Phase::Preparing && entry.allowed(&store).is_ok()
    })
}

fn process(
    job: Job,
    store: &Mutex<Store>,
    ledger: &Ledger,
    storage: &mut Option<(PathBuf, ExportStore)>,
) {
    let Job {
        key,
        artifact_id,
        snapshot,
        policy,
        directory,
    } = job;
    let mut on_disk = false;
    let result = (|| {
        if !pending(store, ledger, key) {
            return Err(ErrorCode::PermissionDenied);
        }
        let text = snapshot.protected_utf8(&policy)?;
        if storage.is_none() {
            let exports = open(&directory).map_err(|_| ErrorCode::InvalidState)?;
            *storage = Some((directory.clone(), exports));
        }
        let (root, exports) = storage.as_mut().ok_or(ErrorCode::InvalidState)?;
        if root != &directory {
            return Err(ErrorCode::InvalidState);
        }
        exports
            .create_display_tracked(
                &text,
                artifact_id,
                || !pending(store, ledger, key),
                || on_disk = true,
            )
            .map_err(|_| ErrorCode::InvalidState)
    })();
    let Ok(mut store) = store.lock() else { return };
    let Ok(mut ledger) = ledger.lock() else {
        return;
    };
    let Some(entry) = ledger.get_mut(&key) else {
        return;
    };
    entry.on_disk = on_disk;
    if entry.receipt.state != Phase::Preparing {
        return;
    }
    let now = store.now();
    entry.receipt.state = match result.and_then(|artifact| {
        entry.allowed(&store)?;
        store
            .pairing
            .dispatch_input(&entry.owner, &entry.permit, now)?;
        Ok(artifact)
    }) {
        Ok(artifact) => {
            entry.fingerprint = Some(ExportFingerprint {
                bytes: artifact.bytes,
                sha256: artifact.sha256,
            });
            Phase::Completed { artifact_id }
        }
        Err(code) => Phase::Failed { code },
    };
}

fn reap(
    store: &Mutex<Store>,
    ledger: &Ledger,
    exports: &mut ExportStore,
    shutdown: bool,
) -> io::Result<()> {
    let mut work = Vec::new();
    {
        let store = store
            .lock()
            .map_err(|_| io::Error::other("export state unavailable"))?;
        let mut ledger = ledger
            .lock()
            .map_err(|_| io::Error::other("export receipts unavailable"))?;
        ledger.retain(|key, entry| {
            let allowed = entry.allowed(&store);
            let failed = matches!(entry.receipt.state, Phase::Cancelled | Phase::Failed { .. });
            if let Err(code) = allowed
                && matches!(entry.receipt.state, Phase::Completed { .. })
            {
                entry.receipt.state = Phase::Failed { code };
            }
            if entry.on_disk && (shutdown || allowed.is_err() || failed || entry.save_committed) {
                work.push((*key, entry.artifact_id));
            }
            entry.on_disk
                || entry.receipt.state == Phase::Preparing
                || store
                    .pairing
                    .require_active(&entry.owner, store.now())
                    .is_ok()
        });
    }
    let mut cleanup_failed = false;
    for (key, id) in work {
        let result = cleanup(exports, id);
        let mut ledger = ledger
            .lock()
            .map_err(|_| io::Error::other("export receipts unavailable"))?;
        if let Some(entry) = ledger.get_mut(&key) {
            if result.is_ok() {
                entry.on_disk = false;
            } else {
                cleanup_failed = true;
                if !entry.cleanup_failed {
                    entry.cleanup_failed = true;
                    eprintln!("protected export cleanup incomplete");
                }
            }
        }
    }
    if cleanup_failed {
        return Err(io::Error::other("protected export cleanup incomplete"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::{
        access::{Action, Scope, Target},
        authorization::Form,
        pairing::{Pairing, SecretToken, protection::Definition},
        redaction,
        session::{Protocol, State},
    };

    #[tokio::test]
    async fn protected_export_keeps_raw_off_disk_and_rejects_cross_owner_and_retired_source() {
        let directory =
            std::env::temp_dir().join(format!("protected-export-中文-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let store = Store::test_store();
        let bootstrap = SecretToken::generate();
        let (owner, other, target) = {
            let mut state = store.lock().unwrap();
            state.pairing = Pairing::new(&bootstrap);
            let desktop = state.pairing.authenticate(&bootstrap, 0).unwrap();
            let connection = state.sessions.create(Protocol::Serial).unwrap().reference();
            let connection = state
                .sessions
                .begin_connect(connection)
                .unwrap()
                .reference();
            state
                .sessions
                .transition(connection, State::Connected)
                .unwrap();
            state
                .sessions
                .append(connection, b"prefix private-", 1)
                .unwrap();
            state
                .sessions
                .append(connection, b"marker suffix\n", 2)
                .unwrap();
            assert!(state.sessions.ended_output(connection).is_err());
            state
                .sessions
                .transition(connection, State::Closing)
                .unwrap();
            state
                .sessions
                .transition(connection, State::Disconnected)
                .unwrap();
            let target = Start {
                service_id: Uuid::new_v4(),
                request_id: Uuid::from_u128(0x0195_0203_0405_7000_8000_0000_0000_0001),
                retained_ended_output: state.sessions.ended_output(connection).unwrap(),
                format: Format::ProtectedUtf8,
            };
            let operation = Operation::Export(target.clone()).key().unwrap();
            let definition = Definition {
                scopes: vec![Scope {
                    target: Target::Connection { connection },
                    action: Action::Export,
                }],
                form: Form::SingleOperation { operation },
                redaction: Some(Arc::new(
                    redaction::Policy::new(vec!["private-marker".into()], false).unwrap(),
                )),
            };
            let (owner, _, _) = state
                .pairing
                .issue_agent_definition(&desktop, definition.clone(), 10_000, 0)
                .unwrap();
            let (other, _, _) = state
                .pairing
                .issue_agent_definition(&desktop, definition, 10_000, 0)
                .unwrap();
            (owner, other, target)
        };
        let manager = Manager::new(store.clone(), None).unwrap();
        let pending = manager
            .start(&owner, target.clone(), directory.clone())
            .unwrap();
        assert_eq!(pending.state, Phase::Preparing);
        assert!(matches!(
            manager.status(&other, pending.query, true),
            Err(ErrorCode::NotFound)
        ));
        let mut changed = target;
        changed.retained_ended_output.from_cursor += 1;
        assert!(manager.start(&owner, changed, directory.clone()).is_err());
        let artifact_id = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match manager.status(&owner, pending.query, false).unwrap().state {
                    Phase::Preparing => tokio::time::sleep(Duration::from_millis(10)).await,
                    Phase::Completed { artifact_id } => break artifact_id,
                    state => panic!("unexpected export phase {state:?}"),
                }
            }
        })
        .await
        .unwrap();
        let text = std::fs::read_to_string(
            directory
                .join(MANAGED_DIRECTORY)
                .join("terminal-log-exports")
                .join(artifact_id.to_string())
                .join("export.jsonl"),
        )
        .unwrap();
        assert!(text.starts_with("prefix ") && text.ends_with(" suffix\n"));
        assert!(!text.contains("private-marker"));
        store
            .lock()
            .unwrap()
            .pairing
            .retire_connection(pending.query.connection, 5);
        assert!(matches!(
            manager.status(&owner, pending.query, false),
            Err(ErrorCode::PermissionDenied)
        ));
        manager.close().await.unwrap();
        assert!(
            CleanupPreview::export_ids(&directory.join(MANAGED_DIRECTORY))
                .unwrap()
                .is_empty()
        );
        let exports = directory
            .join(MANAGED_DIRECTORY)
            .join("terminal-log-exports");
        std::fs::remove_file(exports.join("exports.lock")).unwrap();
        std::fs::remove_dir(exports).unwrap();
        std::fs::remove_dir(directory.join(MANAGED_DIRECTORY)).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
