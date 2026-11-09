//! Closed Desktop-only log actions. Renderer paths, commands and URIs are absent.
use serde::{Deserialize, Serialize};
use session_core::{
    input::{RequestWindow, ordered_timestamp},
    session::{ConnectionRef, Protocol},
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
use terminal_log::{ExportFingerprint, ExportStore, UserLogDirectory, UserLogFile};
use uuid::Uuid;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub service_id: Uuid,
    pub protocol: Protocol,
    pub connection: ConnectionRef,
}
impl Target {
    pub fn valid(&self) -> bool {
        !self.service_id.is_nil()
            && !self.connection.connection_id.0.is_nil()
            && self.connection.generation > 0
            && matches!(self.protocol, Protocol::Ssh2 | Protocol::Serial)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    Recorded {
        log_ids: Vec<Uuid>,
    },
    Viewport {
        text: String,
        top: u32,
        rows: u32,
        cols: u32,
    },
    Buffer {
        text: String,
        rows: u32,
        cols: u32,
    },
}
impl Source {
    fn valid(&self) -> bool {
        match self {
            Self::Recorded { log_ids } => {
                !log_ids.is_empty()
                    && log_ids.len() <= 64
                    && log_ids.iter().all(|id| !id.is_nil())
                    && log_ids
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == log_ids.len()
            }
            Self::Viewport {
                text, rows, cols, ..
            }
            | Self::Buffer { text, rows, cols } => {
                !text.is_empty()
                    && text.len() <= 4 * 1024 * 1024
                    && (1..=2048).contains(rows)
                    && (1..=2048).contains(cols)
                    && !text
                        .chars()
                        .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
            }
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            Self::Recorded { .. } => "RECORDED",
            Self::Viewport { .. } => "VIEWPORT",
            Self::Buffer { .. } => "BUFFER",
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Prepare {
        target: Target,
        request_id: Uuid,
        source: Source,
    },
    OpenDirectory {
        target: Target,
        request_id: Uuid,
    },
    OpenFile {
        target: Target,
        request_id: Uuid,
        log_id: Uuid,
    },
    Status {
        target: Target,
        request_id: Uuid,
    },
    Cancel {
        target: Target,
        request_id: Uuid,
    },
    Release {
        target: Target,
        request_id: Uuid,
        save_id: Uuid,
    },
}
impl Request {
    pub fn scope(&self) -> (&Target, Uuid) {
        match self {
            Self::Prepare {
                target, request_id, ..
            }
            | Self::OpenDirectory {
                target, request_id, ..
            }
            | Self::OpenFile {
                target, request_id, ..
            }
            | Self::Status { target, request_id }
            | Self::Cancel { target, request_id }
            | Self::Release {
                target, request_id, ..
            } => (target, *request_id),
        }
    }
    pub fn valid(&self) -> bool {
        let (t, id) = self.scope();
        t.valid()
            && !id.is_nil()
            && match self {
                Self::Prepare { source, .. } => source.valid(),
                Self::OpenFile { log_id, .. } => !log_id.is_nil(),
                Self::Release { save_id, .. } => !save_id.is_nil(),
                _ => true,
            }
    }
    fn signature(&self) -> Result<ExportFingerprint, String> {
        Ok(ExportFingerprint::for_bytes(
            &serde_json::to_vec(self).map_err(|_| "INVALID_REQUEST")?,
        ))
    }
}
#[derive(Clone, Serialize)]
pub struct Info {
    pub target: Target,
    pub request_id: Uuid,
    pub kind: String,
    pub phase: String,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub retained_records: Option<u64>,
    pub retained_gap_bytes: Option<u64>,
    pub ranges: Vec<terminal_log::ReadableSnapshot>,
    pub failure: Option<String>,
}
struct Entry {
    info: Info,
    signature: ExportFingerprint,
    fingerprint: Option<ExportFingerprint>,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
struct Registry {
    entries: HashMap<Uuid, Entry>,
    window: RequestWindow,
}
enum Job {
    Prepare {
        target: Target,
        id: Uuid,
        source: Source,
        snapshots: Vec<terminal_log::ReadableSnapshot>,
        cancel: Arc<AtomicBool>,
    },
    Open {
        target: Target,
        id: Uuid,
        log_id: Uuid,
        filename: Option<String>,
        file: bool,
    },
    Release {
        id: Uuid,
    },
}
pub struct Manager {
    registry: Arc<Mutex<Registry>>,
    sender: mpsc::SyncSender<Job>,
}
#[cfg(test)]
mod tests;
fn error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::StorageFull => "CAPACITY",
        std::io::ErrorKind::FileTooLarge => "TOO_LARGE",
        std::io::ErrorKind::NotFound => "SOURCE_MISSING",
        std::io::ErrorKind::Interrupted => "CANCELLED",
        _ => "STORAGE",
    }
    .into()
}
impl Manager {
    pub fn release_scope(&self, scope: &crate::export_save::Scope) -> Result<Info, String> {
        let target = {
            let state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
            state
                .entries
                .get(&scope.request_id)
                .filter(|e| {
                    e.info.target.connection == scope.connection && scope.log_id == scope.request_id
                })
                .ok_or("INVALID_SOURCE")?
                .info
                .target
                .clone()
        };
        self.release(&target, scope.request_id)
    }
    pub fn new(directory: PathBuf) -> std::io::Result<Self> {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let shared = registry.clone();
        let (sender, receiver) = mpsc::sync_channel::<Job>(8);
        std::thread::Builder::new()
            .name("terminal-menu-log-files".into())
            .spawn(move || {
                let mut store: Option<ExportStore> = None;
                let staging = directory.join("terminal-menu");
                while let Ok(job) = receiver.recv() {
                    let id = match &job {
                        Job::Prepare { id, .. } | Job::Open { id, .. } | Job::Release { id } => *id,
                    };
                    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                        || -> Result<(), String> {
                            if !matches!(&job, Job::Release { .. })
                                && shared
                                    .lock()
                                    .map_err(|_| "INVALID_STATE")?
                                    .entries
                                    .get(&id)
                                    .ok_or("NOT_FOUND")?
                                    .cancel
                                    .load(Ordering::Acquire)
                            {
                                return Err("CANCELLED".into());
                            }
                            match job {
                                Job::Prepare {
                                    target,
                                    id,
                                    source,
                                    snapshots,
                                    cancel,
                                } => {
                                    if cancel.load(Ordering::Acquire) {
                                        return Err("CANCELLED".into());
                                    }
                                    shared
                                        .lock()
                                        .map_err(|_| "INVALID_STATE")?
                                        .entries
                                        .get_mut(&id)
                                        .ok_or("NOT_FOUND")?
                                        .info
                                        .phase = "RUNNING".into();
                                    if store.is_none() {
                                        match std::fs::create_dir(&staging) {
                                            Ok(()) => {}
                                            Err(e)
                                                if e.kind()
                                                    == std::io::ErrorKind::AlreadyExists => {}
                                            Err(e) => return Err(error(e)),
                                        }
                                        store = Some(ExportStore::open(&staging).map_err(error)?);
                                    }
                                    let store = store.as_mut().ok_or("INVALID_STATE")?;
                                    let artifact = match source {
                                        Source::Recorded { log_ids } => {
                                            if log_ids
                                                != snapshots
                                                    .iter()
                                                    .map(|s| s.log_id)
                                                    .collect::<Vec<_>>()
                                            {
                                                return Err("INVALID_SOURCE".into());
                                            }
                                            store.create_live_bundle(
                                                &directory,
                                                &snapshots,
                                                target.connection,
                                                id,
                                                || cancel.load(Ordering::Acquire),
                                            )
                                        }
                                        Source::Viewport { text, .. }
                                        | Source::Buffer { text, .. } => {
                                            store.create_display(&text, id, || {
                                                cancel.load(Ordering::Acquire)
                                            })
                                        }
                                    }
                                    .map_err(error)?;
                                    let mut state = shared.lock().map_err(|_| "INVALID_STATE")?;
                                    let e = state.entries.get_mut(&id).ok_or("NOT_FOUND")?;
                                    e.fingerprint = Some(ExportFingerprint {
                                        bytes: artifact.bytes,
                                        sha256: artifact.sha256,
                                    });
                                    e.info.phase = "COMPLETED".into();
                                    e.info.bytes = Some(artifact.bytes);
                                    e.info.sha256 = Some(
                                        artifact
                                            .sha256
                                            .iter()
                                            .map(|b| format!("{b:02x}"))
                                            .collect(),
                                    );
                                    e.info.retained_records =
                                        Some(artifact.summary.retained_records);
                                    e.info.retained_gap_bytes =
                                        Some(artifact.summary.retained_gap_bytes);
                                    Ok(())
                                }
                                Job::Open {
                                    target,
                                    id,
                                    log_id,
                                    filename,
                                    file,
                                } => {
                                    if file {
                                        let source = UserLogFile::open(
                                            &directory,
                                            filename.as_deref().ok_or("SOURCE_MISSING")?,
                                            target.connection,
                                            log_id,
                                        )
                                        .map_err(error)?;
                                        crate::export_save::open_readable(source.path())?;
                                    } else {
                                        let source =
                                            UserLogDirectory::ensure(&directory).map_err(error)?;
                                        crate::export_save::open_directory(source.path(), 0)?;
                                    }
                                    shared
                                        .lock()
                                        .map_err(|_| "INVALID_STATE")?
                                        .entries
                                        .get_mut(&id)
                                        .ok_or("NOT_FOUND")?
                                        .info
                                        .phase = "OPENED".into();
                                    Ok(())
                                }
                                Job::Release { id } => {
                                    let store = store.as_mut().ok_or("SOURCE_MISSING")?;
                                    let preview = store.preview_cleanup(id).map_err(error)?;
                                    let report = preview.apply();
                                    if report.failure.is_some() || !report.directory_removed {
                                        return Err("CLEANUP_INCOMPLETE".into());
                                    }
                                    let mut state = shared.lock().map_err(|_| "INVALID_STATE")?;
                                    let e = state.entries.get_mut(&id).ok_or("NOT_FOUND")?;
                                    e.fingerprint = None;
                                    e.info.phase = "REMOVED".into();
                                    Ok(())
                                }
                            }
                        },
                    ));
                    if !matches!(run, Ok(Ok(()))) {
                        let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(entry) = state.entries.get_mut(&id) {
                            entry.info.phase = "FAILED".into();
                            entry.info.failure = Some(match run {
                                Ok(Err(e)) => e,
                                _ => "WORKER_FAILED".into(),
                            });
                        }
                    }
                }
            })?;
        Ok(Self { registry, sender })
    }
    pub fn duplicate(&self, request: &Request) -> Result<Option<Info>, String> {
        let (target, id) = request.scope();
        let state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        if !state.entries.contains_key(&id) {
            state.window.check(id).map_err(|_| "REQUEST_EXPIRED")?;
        }
        state
            .entries
            .get(&id)
            .map(|e| {
                if &e.info.target != target || e.signature != request.signature()? {
                    Err("INVALID_REQUEST".into())
                } else {
                    Ok(e.info.clone())
                }
            })
            .transpose()
    }
    pub fn status(&self, target: &Target, id: Uuid, cancel: bool) -> Result<Info, String> {
        let state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        let e = state
            .entries
            .get(&id)
            .filter(|e| &e.info.target == target)
            .ok_or("NOT_FOUND")?;
        if cancel {
            e.cancel.store(true, Ordering::Release);
        }
        Ok(e.info.clone())
    }
    pub fn submit(
        &self,
        request: Request,
        filename: Option<String>,
        snapshots: Vec<terminal_log::ReadableSnapshot>,
    ) -> Result<Info, String> {
        if !request.valid() {
            return Err("INVALID_REQUEST".into());
        }
        if let Some(old) = self.duplicate(&request)? {
            return Ok(old);
        }
        let (target, id) = request.scope();
        let target = target.clone();
        let signature = request.signature()?;
        let mut state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        // Recheck while holding the receipt lock; reserve and dispatch are one step.
        if let Some(e) = state.entries.get(&id) {
            return if e.info.target == target && e.signature == signature {
                Ok(e.info.clone())
            } else {
                Err("INVALID_REQUEST".into())
            };
        }
        state.window.check(id).map_err(|_| "REQUEST_EXPIRED")?;
        if state.entries.len() >= 64 {
            let (old, stamp) = state
                .entries
                .iter()
                .filter(|(_, e)| matches!(e.info.phase.as_str(), "REMOVED" | "FAILED" | "OPENED"))
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|s| (*id, s)))
                .min_by_key(|(_, s)| *s)
                .ok_or("CAPACITY")?;
            state.entries.remove(&old);
            state.window.retire(stamp);
            state.window.check(id).map_err(|_| "REQUEST_EXPIRED")?;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let (kind, job) = match request {
            Request::Prepare { source, .. } => (
                source.kind().to_owned(),
                Job::Prepare {
                    target: target.clone(),
                    id,
                    source,
                    snapshots: snapshots.clone(),
                    cancel: cancel.clone(),
                },
            ),
            Request::OpenDirectory { .. } => (
                "DIRECTORY".into(),
                Job::Open {
                    target: target.clone(),
                    id,
                    log_id: Uuid::nil(),
                    filename: None,
                    file: false,
                },
            ),
            Request::OpenFile { log_id, .. } => (
                "FILE".into(),
                Job::Open {
                    target: target.clone(),
                    id,
                    log_id,
                    filename,
                    file: true,
                },
            ),
            _ => return Err("INVALID_REQUEST".into()),
        };
        let info = Info {
            target,
            request_id: id,
            kind,
            phase: "QUEUED".into(),
            bytes: None,
            sha256: None,
            retained_records: None,
            retained_gap_bytes: None,
            ranges: snapshots,
            failure: None,
        };
        self.sender.try_send(job).map_err(|_| "CAPACITY")?;
        state.entries.insert(
            id,
            Entry {
                info: info.clone(),
                signature,
                fingerprint: None,
                cancel,
            },
        );
        Ok(info)
    }
    pub fn fingerprint(
        &self,
        scope: &crate::export_save::Scope,
    ) -> Result<ExportFingerprint, String> {
        let state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        let e = state
            .entries
            .get(&scope.request_id)
            .filter(|e| {
                e.info.target.connection == scope.connection
                    && scope.log_id == scope.request_id
                    && e.info.phase == "COMPLETED"
            })
            .ok_or("SOURCE_NOT_READY")?;
        e.fingerprint.ok_or("SOURCE_NOT_READY".into())
    }
    pub fn release(&self, target: &Target, id: Uuid) -> Result<Info, String> {
        let mut state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        let e = state
            .entries
            .get_mut(&id)
            .filter(|e| &e.info.target == target)
            .ok_or("NOT_FOUND")?;
        if matches!(e.info.phase.as_str(), "REMOVED" | "RELEASING") {
            return Ok(e.info.clone());
        }
        if e.info.phase != "COMPLETED" {
            return Err("SOURCE_NOT_READY".into());
        }
        self.sender
            .try_send(Job::Release { id })
            .map_err(|_| "CAPACITY")?;
        e.info.phase = "RELEASING".into();
        Ok(e.info.clone())
    }
}
