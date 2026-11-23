use super::{Manager, Shared, failure};
use serde::{Deserialize, Serialize};
use session_protocol::{
    bridge::ResultMessage,
    shortcuts::{Call, Error, Scope},
};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
use uuid::Uuid;

pub(super) struct Store {
    pub directory: PathBuf,
    pub app: tauri::AppHandle,
}

#[derive(Default)]
pub(super) struct Authorization {
    view: Option<Instant>,
    manage: Option<Instant>,
    extended_view: Option<Instant>,
    extended_manage: Option<Instant>,
}
impl Authorization {
    fn expiry(&mut self, scope: Scope) -> &mut Option<Instant> {
        match scope {
            Scope::View => &mut self.view,
            Scope::Manage => &mut self.manage,
            Scope::ExtendedView => &mut self.extended_view,
            Scope::ExtendedManage => &mut self.extended_manage,
        }
    }

    fn until(&self, scope: Scope) -> Option<Instant> {
        match scope {
            Scope::View => self.view,
            Scope::Manage => self.manage,
            Scope::ExtendedView => self.extended_view,
            Scope::ExtendedManage => self.extended_manage,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Preview {
    pub preview_id: Uuid,
    pub pending_id: Uuid,
    pub pid: u32,
    pub scope: Scope,
    pub seconds: u32,
}

pub(super) struct Frozen {
    preview: Preview,
    until: Instant,
}

#[derive(Serialize)]
pub struct Peer {
    pending_id: Uuid,
    pid: u32,
    view_remaining_ms: u64,
    manage_remaining_ms: u64,
    extended_view_remaining_ms: u64,
    extended_manage_remaining_ms: u64,
}

#[derive(Serialize)]
pub struct Status {
    service_id: Uuid,
    peer: Option<Peer>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Management {
    Status {},
    Preview {
        pending_id: Uuid,
        scope: Scope,
        seconds: u32,
    },
    Approve {
        preview_id: Uuid,
    },
    Revoke {
        pending_id: Uuid,
        scope: Scope,
    },
}

impl Manager {
    pub fn shortcut_status(&self) -> Result<Status, String> {
        let inner = self.shared.inner.lock().map_err(|_| failure())?;
        let now = Instant::now();
        let remaining = |expiry: Option<Instant>| {
            expiry.map_or(0, |value| {
                value.saturating_duration_since(now).as_millis() as u64
            })
        };
        Ok(Status {
            service_id: self.shared.service_id,
            peer: inner.entry.as_ref().map(|entry| Peer {
                pending_id: entry.peer.pending_id,
                pid: entry.peer.pid,
                view_remaining_ms: remaining(entry.shortcuts.view),
                manage_remaining_ms: remaining(entry.shortcuts.manage),
                extended_view_remaining_ms: remaining(entry.shortcuts.extended_view),
                extended_manage_remaining_ms: remaining(entry.shortcuts.extended_manage),
            }),
        })
    }

    pub fn preview_shortcuts(
        &self,
        pending_id: Uuid,
        scope: Scope,
        seconds: u32,
    ) -> Result<Preview, String> {
        if !matches!(seconds, 15 | 60 | 300) {
            return Err("INVALID_SHORTCUT_DURATION".into());
        }
        let mut inner = self.shared.inner.lock().map_err(|_| failure())?;
        let entry = inner
            .entry
            .as_ref()
            .filter(|e| e.peer.pending_id == pending_id)
            .ok_or_else(failure)?;
        let preview = Preview {
            preview_id: Uuid::new_v4(),
            pending_id,
            pid: entry.peer.pid,
            scope,
            seconds,
        };
        inner.shortcut_preview = Some(Frozen {
            preview: preview.clone(),
            until: Instant::now() + Duration::from_secs(30),
        });
        Ok(preview)
    }

    pub fn approve_shortcuts(&self, id: Uuid) -> Result<Status, String> {
        {
            let mut inner = self.shared.inner.lock().map_err(|_| failure())?;
            let frozen = inner.shortcut_preview.take().ok_or_else(failure)?;
            let now = Instant::now();
            let preview = frozen.preview;
            if preview.preview_id != id || now >= frozen.until {
                return Err("SHORTCUT_APPROVAL_EXPIRED".into());
            }
            let entry = inner
                .entry
                .as_mut()
                .filter(|e| e.peer.pending_id == preview.pending_id && e.peer.pid == preview.pid)
                .ok_or_else(failure)?;
            *entry.shortcuts.expiry(preview.scope) =
                Some(now + Duration::from_secs(u64::from(preview.seconds)));
        }
        self.shortcut_status()
    }

    pub fn revoke_shortcuts(&self, pending_id: Uuid, scope: Scope) -> Result<Status, String> {
        {
            let mut inner = self.shared.inner.lock().map_err(|_| failure())?;
            let entry = inner
                .entry
                .as_mut()
                .filter(|e| e.peer.pending_id == pending_id)
                .ok_or_else(failure)?;
            *entry.shortcuts.expiry(scope) = None;
            if inner
                .shortcut_preview
                .as_ref()
                .is_some_and(|f| f.preview.scope == scope)
            {
                inner.shortcut_preview = None;
            }
        }
        self.shortcut_status()
    }
}

pub(super) async fn call(
    shared: Arc<Shared>,
    connected: Arc<AtomicBool>,
    id: Uuid,
    request: Call,
) -> ResultMessage {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let store = shared.shortcuts.as_ref().ok_or(Error::PermissionDenied)?;
        // Serialize final authorization with revocation for this exact pipe peer.
        let inner = shared.inner.lock().map_err(|_| Error::PermissionDenied)?;
        let entry = inner
            .entry
            .as_ref()
            .filter(|e| e.peer.pending_id == id)
            .ok_or(Error::PermissionDenied)?;
        let expires = entry
            .shortcuts
            .until(request.scope())
            .ok_or(Error::PermissionDenied)?;
        let out = crate::local_terminal::adb::shortcuts::handle(&store.directory, request, || {
            Instant::now() < expires
                && connected.load(Ordering::Acquire)
                && !shared.closing.load(Ordering::Acquire)
        })?;
        drop(inner);
        if let Some(revision) = out.committed_revision {
            let _ = store.app.emit_to(
                crate::session_windows::MAIN,
                "local-shortcuts-changed",
                revision,
            );
        }
        Ok::<_, Error>(out.reply)
    })
    .await;
    match result {
        Ok(Ok(reply)) => reply,
        Ok(Err(error)) => ResultMessage::ShortcutError(error),
        Err(_) => ResultMessage::ShortcutError(Error::UnknownDelivery),
    }
}
