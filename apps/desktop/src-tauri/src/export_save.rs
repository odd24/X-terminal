use serde::{Deserialize, Serialize};
use session_core::{
    input::{RequestWindow, ordered_timestamp},
    session::ConnectionRef,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use terminal_log::{ExportFingerprint, SaveTarget, VerifiedExport};
use uuid::Uuid;
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::{
            Shell::{
                Common::COMDLG_FILTERSPEC, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR,
                FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, FileSaveDialog, IFileSaveDialog,
                SIGDN_FILESYSPATH, ShellExecuteW,
            },
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
    core::{HSTRING, PCWSTR, w},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SourceMode {
    Text,
    Normal,
    Recovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub mode: SourceMode,
    pub connection: ConnectionRef,
    pub log_id: Uuid,
    pub request_id: Uuid,
}
impl Scope {
    pub fn source_status(&self) -> session_protocol::logging::Request {
        use session_protocol::logging::Request;
        match self.mode {
            SourceMode::Text => Request::TextExportStatus {
                connection: self.connection,
                log_id: self.log_id,
                request_id: self.request_id,
            },
            SourceMode::Normal => Request::ExportStatus {
                connection: self.connection,
                log_id: self.log_id,
                request_id: self.request_id,
            },
            SourceMode::Recovery => Request::RecoveryExportStatus {
                connection: self.connection,
                log_id: self.log_id,
                request_id: self.request_id,
            },
        }
    }
    // Only the mode-specific trusted service reply may authorize the copy.
    pub fn fingerprint(
        &self,
        reply: session_protocol::logging::Reply,
    ) -> Result<ExportFingerprint, String> {
        use session_protocol::logging::{ExportPhase, Reply};
        let (connection, log_id, request_id, phase, bytes, hash) = match (self.mode, reply) {
            (SourceMode::Text, Reply::TextExport(info))
            | (SourceMode::Normal, Reply::Export(info)) => (
                info.connection,
                info.log_id,
                info.request_id,
                info.phase,
                info.bytes,
                info.sha256,
            ),
            (SourceMode::Recovery, Reply::RecoveryExport(info))
                if info.incomplete && info.recovered.is_some() =>
            {
                (
                    info.connection,
                    info.log_id,
                    info.request_id,
                    info.phase,
                    info.bytes,
                    info.sha256,
                )
            }
            _ => return Err("INVALID_SOURCE".into()),
        };
        if connection != self.connection
            || log_id != self.log_id
            || request_id != self.request_id
            || phase != ExportPhase::Completed
        {
            return Err("SOURCE_NOT_READY".into());
        }
        let bytes = bytes
            .filter(|v| *v > 0 && *v <= terminal_log::MAX_EXPORT_BYTES)
            .ok_or("INVALID_SOURCE")?;
        let hash = hash
            .filter(|v| {
                v.len() == 64
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or("INVALID_SOURCE")?;
        let mut sha256 = [0u8; 32];
        for (i, value) in sha256.iter_mut().enumerate() {
            *value =
                u8::from_str_radix(&hash[i * 2..i * 2 + 2], 16).map_err(|_| "INVALID_SOURCE")?;
        }
        Ok(ExportFingerprint { bytes, sha256 })
    }
    pub fn valid(&self) -> bool {
        self.connection.generation > 0
            && !self.connection.connection_id.0.is_nil()
            && !self.log_id.is_nil()
            && !self.request_id.is_nil()
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Start {
        scope: Scope,
        save_id: Uuid,
    },
    Status {
        scope: Scope,
        save_id: Uuid,
    },
    Cancel {
        scope: Scope,
        save_id: Uuid,
    },
    Confirm {
        scope: Scope,
        save_id: Uuid,
        confirmation: Uuid,
    },
    OpenDirectory {
        scope: Scope,
        save_id: Uuid,
    },
}
#[derive(Debug, Clone, Serialize)]
pub struct Info {
    pub scope: Scope,
    pub save_id: Uuid,
    pub phase: String,
    pub cancel_requested: bool,
    pub path: Option<String>,
    pub existing_bytes: Option<String>,
    pub confirmation: Option<Uuid>,
    pub expires_at_ms: Option<u64>,
    pub backup: Option<String>,
    pub staging: Option<String>,
    pub failure: Option<String>,
    pub os_code: Option<i32>,
}
fn active(info: &Info) -> bool {
    matches!(
        info.phase.as_str(),
        "CHOOSING" | "AWAITING_CONFIRMATION" | "COPYING"
    )
}
struct Entry {
    info: Info,
    cancel: Arc<AtomicBool>,
    nonce: Uuid,
}
#[derive(Default)]
struct Registry {
    entries: HashMap<Uuid, Entry>,
    window: RequestWindow,
}
enum Message {
    Start {
        id: Uuid,
        owner: usize,
        fingerprint: ExportFingerprint,
    },
    Confirm {
        id: Uuid,
        nonce: Uuid,
    },
    Open {
        path: PathBuf,
        owner: usize,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
}
pub struct Manager {
    registry: Arc<Mutex<Registry>>,
    sender: mpsc::SyncSender<Message>,
    stopping: AtomicBool,
}
fn display(path: &Path) -> String {
    let value = path.to_string_lossy();
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
}
struct Apartment;
impl Apartment {
    fn enter() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
fn choose(owner: usize, id: Uuid, mode: SourceMode) -> windows::core::Result<Option<PathBuf>> {
    let _apartment = Apartment::enter()?;
    unsafe {
        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            (dialog.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR)
                & !FOS_OVERWRITEPROMPT,
        )?;
        dialog.SetTitle(w!("另存终端导出"))?;
        dialog.SetOkButtonLabel(w!("选择保存位置"))?;
        if mode == SourceMode::Text {
            dialog.SetTitle(w!("保存文本日志"))?;
            dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("文本日志 (*.log)"),
                pszSpec: w!("*.log"),
            }])?;
            dialog.SetDefaultExtension(w!("log"))?;
            dialog.SetFileName(&HSTRING::from(format!("terminal-{id}.log")))?;
        } else {
            dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("JSONL 日志 (*.jsonl)"),
                pszSpec: w!("*.jsonl"),
            }])?;
            dialog.SetDefaultExtension(w!("jsonl"))?;
            dialog.SetFileName(&HSTRING::from(format!("terminal-export-{id}.jsonl")))?;
        }
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(error);
        }
        let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let value = name.to_string();
        CoTaskMemFree(Some(name.0.cast()));
        Ok(Some(PathBuf::from(value?)))
    }
}
fn open_directory(path: &Path, owner: usize) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    let _apartment = Apartment::enter().map_err(|_| "SHELL_UNAVAILABLE")?;
    let meta = std::fs::symlink_metadata(path).map_err(|_| "DIRECTORY_UNAVAILABLE")?;
    if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
        return Err("DIRECTORY_CHANGED".into());
    }
    let path = HSTRING::from(display(path));
    let result = unsafe {
        ShellExecuteW(
            Some(HWND(owner as *mut _)),
            w!("open"),
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        Err("SHELL_UNAVAILABLE".into())
    } else {
        Ok(())
    }
}
impl Manager {
    pub fn new(directory: PathBuf) -> std::io::Result<Self> {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let shared = registry.clone();
        let (sender, receiver) = mpsc::sync_channel(8);
        std::thread::Builder::new()
            .name("native-export-save".into())
            .spawn(move || {
                let mut prepared: Option<(Uuid, SaveTarget, ExportFingerprint, Instant)> = None;
                loop {
                    if let Some((id, _, _, deadline)) = &prepared {
                        let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
                        let entry = state.entries.get_mut(id).unwrap();
                        if entry.cancel.load(Ordering::Acquire) || Instant::now() >= *deadline {
                            let phase = if entry.cancel.load(Ordering::Acquire) {
                                "CANCELLED"
                            } else {
                                "EXPIRED"
                            };
                            let id = *id;
                            drop(state);
                            prepared.take();
                            set_phase(&shared, id, phase, None, None);
                        }
                    }
                    let message = match receiver.recv_timeout(Duration::from_millis(200)) {
                        Ok(m) => m,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    match message {
                        Message::Open { path, owner, reply } => {
                            let _ = reply.send(open_directory(&path, owner));
                        }
                        Message::Start {
                            id,
                            owner,
                            fingerprint,
                        } => {
                            let mode = shared.lock().unwrap_or_else(|e| e.into_inner()).entries
                                [&id]
                                .info
                                .scope
                                .mode;
                            let selected = choose(owner, id, mode);
                            let cancel = shared.lock().unwrap_or_else(|e| e.into_inner()).entries
                                [&id]
                                .cancel
                                .clone();
                            if cancel.load(Ordering::Acquire) || matches!(selected, Ok(None)) {
                                set_phase(&shared, id, "CANCELLED", None, None);
                                continue;
                            }
                            let path = match selected {
                                Ok(Some(path)) => path,
                                Err(e) => {
                                    set_phase(
                                        &shared,
                                        id,
                                        "FAILED",
                                        Some("DIALOG"),
                                        Some(e.code().0),
                                    );
                                    continue;
                                }
                                _ => unreachable!(),
                            };
                            let target = match SaveTarget::prepare(&path, &directory, id) {
                                Ok(t) => t,
                                Err(e) => {
                                    set_phase(
                                        &shared,
                                        id,
                                        "FAILED",
                                        Some("TARGET"),
                                        e.raw_os_error(),
                                    );
                                    continue;
                                }
                            };
                            let existing = match target.existing_bytes() {
                                Ok(v) => v,
                                Err(e) => {
                                    drop(target);
                                    set_phase(
                                        &shared,
                                        id,
                                        "FAILED",
                                        Some("TARGET"),
                                        e.raw_os_error(),
                                    );
                                    continue;
                                }
                            };
                            {
                                let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
                                let entry = state.entries.get_mut(&id).unwrap();
                                entry.info.path = Some(display(target.path()));
                                entry.info.existing_bytes = existing.map(|n| n.to_string());
                            }
                            if existing.is_some() {
                                let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
                                let entry = state.entries.get_mut(&id).unwrap();
                                entry.info.phase = "AWAITING_CONFIRMATION".into();
                                entry.info.confirmation = Some(entry.nonce);
                                entry.info.expires_at_ms = Some(
                                    SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as u64
                                        + 60000,
                                );
                                prepared = Some((
                                    id,
                                    target,
                                    fingerprint,
                                    Instant::now() + Duration::from_secs(60),
                                ));
                            } else {
                                copy(&shared, &directory, id, target, fingerprint);
                            }
                        }
                        Message::Confirm { id, nonce } => {
                            if prepared.as_ref().is_some_and(|(target, _, _, deadline)| {
                                *target == id && Instant::now() < *deadline
                            }) && shared.lock().unwrap_or_else(|e| e.into_inner()).entries[&id]
                                .nonce
                                == nonce
                            {
                                let (_, target, fingerprint, _) = prepared.take().unwrap();
                                copy(&shared, &directory, id, target, fingerprint);
                            }
                        }
                    }
                }
            })?;
        Ok(Self {
            registry,
            sender,
            stopping: AtomicBool::new(false),
        })
    }
    pub fn duplicate(&self, scope: &Scope, id: Uuid) -> Result<Option<Info>, String> {
        if !scope.valid() || id.is_nil() {
            return Err("INVALID_ARGUMENT".into());
        }
        let state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        if let Some(entry) = state.entries.get(&id) {
            if entry.info.scope != *scope {
                return Err("INVALID_ARGUMENT".into());
            }
            return Ok(Some(entry.info.clone()));
        }
        state.window.check(id).map_err(|_| "REQUEST_EXPIRED")?;
        Ok(None)
    }
    pub fn status(&self, scope: &Scope, id: Uuid) -> Result<Info, String> {
        self.duplicate(scope, id)?.ok_or("NOT_FOUND".into())
    }
    pub fn start(
        &self,
        scope: Scope,
        id: Uuid,
        owner: usize,
        fingerprint: ExportFingerprint,
    ) -> Result<Info, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("SAVE_STOPPING".into());
        }
        if let Some(info) = self.duplicate(&scope, id)? {
            return Ok(info);
        }
        let mut state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("SAVE_STOPPING".into());
        }
        if let Some(entry) = state.entries.get(&id) {
            return if entry.info.scope == scope {
                Ok(entry.info.clone())
            } else {
                Err("INVALID_ARGUMENT".into())
            };
        }
        state.window.check(id).map_err(|_| "REQUEST_EXPIRED")?;
        if state.entries.values().any(|entry| active(&entry.info)) {
            return Err("SAVE_BUSY".into());
        }
        if state.entries.len() >= 32 {
            let (old, stamp) = state
                .entries
                .iter()
                .filter(|(_, e)| !active(&e.info))
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|t| (*id, t)))
                .min_by_key(|(_, t)| *t)
                .ok_or("CAPACITY")?;
            state.entries.remove(&old);
            state.window.retire(stamp);
            state.window.check(id).map_err(|_| "REQUEST_EXPIRED")?;
        }
        let info = Info {
            scope,
            save_id: id,
            phase: "CHOOSING".into(),
            cancel_requested: false,
            path: None,
            existing_bytes: None,
            confirmation: None,
            expires_at_ms: None,
            backup: None,
            staging: None,
            failure: None,
            os_code: None,
        };
        state.entries.insert(
            id,
            Entry {
                info: info.clone(),
                nonce: Uuid::new_v4(),
                cancel: Arc::new(AtomicBool::new(false)),
            },
        );
        if self
            .sender
            .try_send(Message::Start {
                id,
                owner,
                fingerprint,
            })
            .is_err()
        {
            state.entries.remove(&id);
            return Err("CAPACITY".into());
        }
        Ok(info)
    }
    pub fn cancel(&self, scope: &Scope, id: Uuid) -> Result<Info, String> {
        self.status(scope, id)?;
        let mut state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        let entry = state.entries.get_mut(&id).ok_or("NOT_FOUND")?;
        if active(&entry.info) {
            entry.cancel.store(true, Ordering::Release);
            entry.info.cancel_requested = true;
        }
        Ok(entry.info.clone())
    }
    pub fn confirm(&self, scope: &Scope, id: Uuid, nonce: Uuid) -> Result<Info, String> {
        if !scope.valid() || id.is_nil() {
            return Err("INVALID_ARGUMENT".into());
        }
        let mut state = self.registry.lock().map_err(|_| "INVALID_STATE")?;
        let entry = state.entries.get_mut(&id).ok_or("NOT_FOUND")?;
        let info = entry.info.clone();
        if nonce.is_nil() || entry.nonce != nonce || info.scope != *scope {
            return Err("INVALID_ARGUMENT".into());
        }
        if info.phase == "AWAITING_CONFIRMATION" {
            self.sender
                .try_send(Message::Confirm { id, nonce })
                .map_err(|_| "CAPACITY")?;
            entry.info.phase = "COPYING".into();
            entry.info.confirmation = None;
            entry.info.expires_at_ms = None;
        }
        Ok(entry.info.clone())
    }
    pub fn cancel_all(&self) {
        self.stopping.store(true, Ordering::Release);
        let mut state = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        for entry in state.entries.values_mut().filter(|e| active(&e.info)) {
            entry.cancel.store(true, Ordering::Release);
            entry.info.cancel_requested = true;
        }
    }
    pub async fn open(&self, scope: &Scope, id: Uuid, owner: usize) -> Result<Info, String> {
        let info = self.status(scope, id)?;
        let path = info
            .path
            .as_ref()
            .and_then(|p| Path::new(p).parent())
            .ok_or("DIRECTORY_UNAVAILABLE")?
            .to_owned();
        let (reply, response) = tokio::sync::oneshot::channel();
        self.sender
            .try_send(Message::Open { path, owner, reply })
            .map_err(|_| "CAPACITY")?;
        response.await.map_err(|_| "INVALID_STATE")??;
        Ok(info)
    }
}
fn set_phase(
    shared: &Arc<Mutex<Registry>>,
    id: Uuid,
    phase: &str,
    failure: Option<&str>,
    code: Option<i32>,
) {
    let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
    let info = &mut state.entries.get_mut(&id).unwrap().info;
    info.phase = phase.into();
    info.failure = failure.map(str::to_owned);
    info.os_code = code;
    info.confirmation = None;
    info.expires_at_ms = None;
}
fn copy(
    shared: &Arc<Mutex<Registry>>,
    directory: &Path,
    id: Uuid,
    target: SaveTarget,
    fingerprint: ExportFingerprint,
) {
    set_phase(shared, id, "COPYING", None, None);
    let (cancel, export_id) = {
        let state = shared.lock().unwrap_or_else(|e| e.into_inner());
        let e = &state.entries[&id];
        (e.cancel.clone(), e.info.scope.request_id)
    };
    let mut source = match VerifiedExport::open(directory, export_id, fingerprint, || {
        cancel.load(Ordering::Acquire)
    }) {
        Ok(s) => s,
        Err(e) => {
            drop(target);
            set_phase(
                shared,
                id,
                if e.kind() == std::io::ErrorKind::Interrupted {
                    "CANCELLED"
                } else {
                    "FAILED"
                },
                Some("SOURCE"),
                e.raw_os_error(),
            );
            return;
        }
    };
    let report = target.save(&mut source, || cancel.load(Ordering::Acquire));
    let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
    let info = &mut state.entries.get_mut(&id).unwrap().info;
    info.phase = report.phase.into();
    info.failure = report.failure.map(str::to_owned);
    info.os_code = report.os_code;
    info.confirmation = None;
    info.expires_at_ms = None;
    info.path = Some(display(&report.path));
    info.backup = report.backup.as_deref().map(display);
    info.staging = report.staging.as_deref().map(display);
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_core::session::ConnectionId;
    fn scope() -> Scope {
        Scope {
            mode: SourceMode::Normal,
            connection: ConnectionRef {
                connection_id: ConnectionId(Uuid::new_v4()),
                generation: 3,
            },
            log_id: Uuid::new_v4(),
            request_id: Uuid::new_v4(),
        }
    }
    fn manager() -> (Manager, mpsc::Receiver<Message>) {
        let (sender, receiver) = mpsc::sync_channel(8);
        (
            Manager {
                registry: Arc::default(),
                sender,
                stopping: AtomicBool::new(false),
            },
            receiver,
        )
    }
    fn ordered(n: u64) -> Uuid {
        Uuid::from_u128(((n as u128) << 80) | 0x7000_8000_0000_0000_0000 | 1)
    }
    fn entry(scope: Scope, id: Uuid, phase: &str) -> Entry {
        let nonce = Uuid::new_v4();
        Entry {
            info: Info {
                scope,
                save_id: id,
                phase: phase.into(),
                cancel_requested: false,
                path: Some("C:\\synthetic\\file.jsonl".into()),
                existing_bytes: Some("4".into()),
                confirmation: Some(nonce),
                expires_at_ms: Some(1000),
                backup: None,
                staging: None,
                failure: None,
                os_code: None,
            },
            nonce,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
    #[test]
    fn native_request_rejects_paths_roles_and_foreign_scope_and_never_queues_a_duplicate_picker() {
        let scope = scope();
        let id = ordered(10);
        for op in ["start", "status", "cancel", "confirm", "open_directory"] {
            let mut value = serde_json::json!({"op":op,"scope":scope,"save_id":id});
            if op == "confirm" {
                value["confirmation"] = Uuid::new_v4().to_string().into();
            }
            assert!(serde_json::from_value::<Request>(value.clone()).is_ok());
            for key in ["path", "target", "role", "fingerprint"] {
                let mut bad = value.clone();
                bad[key] = true.into();
                assert!(serde_json::from_value::<Request>(bad).is_err());
            }
        }
        let (manager, receiver) = manager();
        let fingerprint = ExportFingerprint {
            bytes: 1,
            sha256: [0; 32],
        };
        assert_eq!(
            manager
                .start(scope.clone(), id, 0, fingerprint)
                .unwrap()
                .phase,
            "CHOOSING"
        );
        assert!(
            matches!(receiver.try_recv().unwrap(), Message::Start { id: queued, .. } if queued == id)
        );
        manager.start(scope.clone(), id, 0, fingerprint).unwrap();
        assert!(receiver.try_recv().is_err());
        let mut foreign = scope.clone();
        foreign.connection.generation += 1;
        assert!(manager.status(&foreign, id).is_err());
        assert!(manager.cancel(&scope, id).unwrap().cancel_requested);
        manager.cancel_all();
        assert_eq!(
            manager
                .start(scope, ordered(11), 0, fingerprint)
                .unwrap_err(),
            "SAVE_STOPPING"
        );
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn modes_are_fixed_for_all_operations_and_share_one_picker_slot() {
        let normal = scope();
        let mut recovery = normal.clone();
        recovery.mode = SourceMode::Recovery;
        let (manager, receiver) = manager();
        let id = ordered(12);
        let fingerprint = ExportFingerprint {
            bytes: 10,
            sha256: [1; 32],
        };
        manager.start(recovery.clone(), id, 0, fingerprint).unwrap();
        assert!(matches!(
            receiver.try_recv().unwrap(),
            Message::Start { .. }
        ));
        assert!(manager.start(normal.clone(), id, 0, fingerprint).is_err());
        assert!(manager.status(&normal, id).is_err());
        assert!(manager.cancel(&normal, id).is_err());
        assert!(manager.confirm(&normal, id, Uuid::new_v4()).is_err());
        assert_eq!(
            manager
                .start(normal, ordered(13), 0, fingerprint)
                .unwrap_err(),
            "SAVE_BUSY"
        );
        assert!(!manager.status(&recovery, id).unwrap().cancel_requested);
        manager.start(recovery.clone(), id, 0, fingerprint).unwrap();
        assert!(receiver.try_recv().is_err());
        manager.cancel(&recovery, id).unwrap();
    }
    #[test]
    fn trusted_fingerprints_require_matching_mode_scope_completion_and_explicit_incomplete() {
        use session_protocol::logging::{Reply, Request};
        let normal = scope();
        let mut recovery = normal.clone();
        recovery.mode = SourceMode::Recovery;
        assert!(matches!(
            normal.source_status(),
            Request::ExportStatus { .. }
        ));
        assert!(matches!(
            recovery.source_status(),
            Request::RecoveryExportStatus { .. }
        ));
        let value = serde_json::json!({"result":"recovery_export", "connection":normal.connection,"log_id":normal.log_id,"request_id":normal.request_id,"phase":"COMPLETED","failure":null,"incomplete":true,"bytes":123,"sha256":"ab".repeat(32),"recovered":{"recovered_records":2,"recovered_raw_bytes":10,"recovered_gap_bytes":0,"next_cursor":3,"stop":{"kind":"TRUNCATED_RECORD","segment":1,"next_cursor":3}}});
        let decode = |v| serde_json::from_value::<Reply>(v).unwrap();
        assert_eq!(
            recovery.fingerprint(decode(value.clone())).unwrap().sha256,
            [0xab; 32]
        );
        assert!(normal.fingerprint(decode(value.clone())).is_err());
        for (key, bad) in [
            ("incomplete", serde_json::json!(false)),
            ("recovered", serde_json::Value::Null),
            ("phase", serde_json::json!("REMOVED")),
            ("sha256", serde_json::json!("AB".repeat(32))),
            ("bytes", serde_json::json!(0)),
            ("request_id", serde_json::json!(Uuid::new_v4())),
        ] {
            let mut changed = value.clone();
            changed[key] = bad;
            assert!(recovery.fingerprint(decode(changed)).is_err(), "{key}");
        }
        let mut ordinary = value;
        let obj = ordinary.as_object_mut().unwrap();
        obj.remove("incomplete");
        obj.remove("recovered");
        obj.insert("result".into(), serde_json::json!("export"));
        for key in [
            "retained_records",
            "retained_raw_bytes",
            "retained_gap_bytes",
            "next_cursor",
        ] {
            obj.insert(key.into(), serde_json::Value::Null);
        }
        assert_eq!(
            normal.fingerprint(decode(ordinary.clone())).unwrap().bytes,
            123
        );
        assert!(recovery.fingerprint(decode(ordinary)).is_err());
        let mut text = normal.clone();
        text.mode = SourceMode::Text;
        assert!(matches!(
            text.source_status(),
            Request::TextExportStatus { .. }
        ));
        let plain = serde_json::json!({"result":"text_export","connection":text.connection,"log_id":text.log_id,"request_id":text.request_id,"phase":"COMPLETED","failure":null,"bytes":321,"sha256":"cd".repeat(32),"retained_records":1,"retained_raw_bytes":10,"retained_gap_bytes":0,"next_cursor":2});
        assert_eq!(text.fingerprint(decode(plain.clone())).unwrap().bytes, 321);
        assert!(normal.fingerprint(decode(plain.clone())).is_err());
        assert!(recovery.fingerprint(decode(plain.clone())).is_err());
        let mut wrong = plain;
        wrong["result"] = serde_json::json!("export");
        assert!(text.fingerprint(decode(wrong)).is_err());
        for mode in [serde_json::Value::Null, serde_json::json!("OTHER")] {
            let mut v = serde_json::to_value(&normal).unwrap();
            v["mode"] = mode;
            assert!(serde_json::from_value::<Scope>(v).is_err());
        }
        let mut v = serde_json::to_value(&normal).unwrap();
        v.as_object_mut().unwrap().remove("mode");
        assert!(serde_json::from_value::<Scope>(v).is_err());
    }
    #[test]
    fn native_receipts_retire_closed_ordered_ids_and_never_reopen_them_or_remove_opaque_ids() {
        let scope = scope();
        let (manager, receiver) = manager();
        let opaque = Uuid::new_v4();
        {
            let mut state = manager.registry.lock().unwrap();
            for id in (1..32).map(ordered).chain([opaque]) {
                state
                    .entries
                    .insert(id, entry(scope.clone(), id, "COMPLETED"));
            }
        }
        manager
            .start(
                scope.clone(),
                ordered(100),
                0,
                ExportFingerprint {
                    bytes: 1,
                    sha256: [0; 32],
                },
            )
            .unwrap();
        assert!(matches!(
            receiver.try_recv().unwrap(),
            Message::Start { .. }
        ));
        assert_eq!(
            manager.duplicate(&scope, ordered(1)).unwrap_err(),
            "REQUEST_EXPIRED"
        );
        assert_eq!(manager.status(&scope, opaque).unwrap().phase, "COMPLETED");
        assert_eq!(manager.registry.lock().unwrap().entries.len(), 32);
    }
    #[test]
    fn confirmation_is_bound_to_nonce_and_consumed_once_before_the_file_worker_runs() {
        let scope = scope();
        let (manager, receiver) = manager();
        let id = ordered(10);
        let value = entry(scope.clone(), id, "AWAITING_CONFIRMATION");
        let nonce = value.nonce;
        manager.registry.lock().unwrap().entries.insert(id, value);
        assert!(manager.confirm(&scope, id, Uuid::new_v4()).is_err());
        assert!(receiver.try_recv().is_err());
        assert_eq!(manager.confirm(&scope, id, nonce).unwrap().phase, "COPYING");
        assert!(matches!(
            receiver.try_recv().unwrap(),
            Message::Confirm { .. }
        ));
        assert!(manager.status(&scope, id).unwrap().confirmation.is_none());
        manager.confirm(&scope, id, nonce).unwrap();
        assert!(receiver.try_recv().is_err());
    }
}
