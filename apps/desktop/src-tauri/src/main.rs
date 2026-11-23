// Development previews are launched directly too; they must not allocate a console.
#![windows_subsystem = "windows"]

mod agent_management;
mod audit_history;
mod bridge_manager;
#[cfg(feature = "close-receipt-fixture")]
mod close_fixture;
mod close_receipt;
mod config_import;
mod export_save;
#[cfg(feature = "load-observer-test")]
mod load_observer_test;
mod local_terminal;
mod log_directory;
mod log_viewer;
#[cfg(feature = "save-recovery-fixture")]
mod save_recovery_fixture;
#[cfg(feature = "serial-mcp-fixture")]
mod serial_fixture;
mod service;
mod session_windows;
mod terminal_clipboard;
mod terminal_logs;
mod trigger_match;
use session_core::session::{ConnectionInfo, ConnectionRef, OutputPage};
use session_protocol::{Reply, Request};
use std::{sync::Arc, time::Duration};
use tauri::{Manager, State};
use tokio::sync::Mutex;

struct Desktop(
    Arc<Mutex<Result<service::Service, String>>>,
    Arc<Mutex<Option<session_service::client::Client>>>,
    std::path::PathBuf,
);

#[derive(Clone, serde::Serialize)]
struct SaveRecoverySnapshot {
    availability: Option<terminal_log::close_store::Unavailable>,
    items: Vec<terminal_log::save_recovery::Item>,
}
impl SaveRecoverySnapshot {
    fn load(directory: &std::path::Path) -> Self {
        match terminal_log::save_recovery::read(directory) {
            Ok(items) => Self {
                availability: None,
                items,
            },
            Err(error) => Self {
                availability: Some(error),
                items: Vec::new(),
            },
        }
    }
}

#[tauri::command]
fn save_recovery_status(state: State<'_, SaveRecoverySnapshot>) -> SaveRecoverySnapshot {
    state.inner().clone()
}

#[tauri::command]
async fn export_save_request(
    window: tauri::WebviewWindow,
    state: State<'_, Desktop>,
    manager: State<'_, export_save::Manager>,
    menu: State<'_, terminal_logs::Manager>,
    request: export_save::Request,
) -> Result<export_save::Info, String> {
    use export_save::Request as R;
    let info = match request {
        R::Status { scope, save_id } => manager.status(&scope, save_id),
        R::Cancel { scope, save_id } => manager.cancel(&scope, save_id),
        R::Confirm {
            scope,
            save_id,
            confirmation,
        } => manager.confirm(&scope, save_id, confirmation),
        R::OpenDirectory { scope, save_id } => {
            if scope.mode == export_save::SourceMode::Protected {
                return Err("UNSUPPORTED".into());
            }
            manager
                .open(
                    &scope,
                    save_id,
                    window.hwnd().map_err(|_| "WINDOW_UNAVAILABLE")?.0 as usize,
                )
                .await
        }
        R::Start { scope, save_id } => {
            if let Some(info) = manager.duplicate(&scope, save_id)? {
                return Ok(info);
            }
            let fingerprint = if scope.mode == export_save::SourceMode::Menu {
                menu.fingerprint(&scope)?
            } else {
                let reply =
                    forward_logging(state, scope.source_status().ok_or("INVALID_SOURCE")?).await?;
                scope.fingerprint(reply)?
            };
            manager.start(
                scope,
                save_id,
                window.hwnd().map_err(|_| "WINDOW_UNAVAILABLE")?.0 as usize,
                fingerprint,
            )
        }
    }?;
    if info.scope.mode == export_save::SourceMode::Menu
        && matches!(info.phase.as_str(), "COMPLETED" | "CANCELLED")
    {
        // Housekeeping only for our own verified staging artifact. Never changes
        // the durable user save receipt or deletes the saved destination.
        let _ = menu.release_scope(&info.scope);
    }
    Ok(info)
}

#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum ProtectedExportDesktopRequest {
    Prepare {
        service_id: uuid::Uuid,
        connection: ConnectionRef,
    },
    Save {
        scope: session_protocol::export::ArtifactScope,
        save_id: uuid::Uuid,
    },
}

#[derive(serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
enum ProtectedExportDesktopReply {
    Prepared(session_core::session::EndedOutput),
    Save(export_save::Info),
}

#[tauri::command]
async fn protected_export_desktop_request(
    window: tauri::WebviewWindow,
    state: State<'_, Desktop>,
    manager: State<'_, export_save::Manager>,
    request: ProtectedExportDesktopRequest,
) -> Result<ProtectedExportDesktopReply, String> {
    use session_protocol::export::{Reply as R, Request as E};
    let (service_id, wire) = match request {
        ProtectedExportDesktopRequest::Prepare {
            service_id,
            connection,
        } => (service_id, E::Prepare { connection }),
        ProtectedExportDesktopRequest::Save { scope, .. } => {
            (scope.service_id, E::InspectSave { scope })
        }
    };
    let reply = {
        let mut shared = state.0.lock().await;
        let service = shared.as_mut().map_err(|e| e.clone())?;
        if service.endpoint()?.2 != service_id {
            return Err("STALE_SERVICE".into());
        }
        service
            .request(Request::ProtectedExport { request: wire })
            .await?
    };
    match (request, reply) {
        (
            ProtectedExportDesktopRequest::Prepare { connection, .. },
            Reply::ProtectedExport(R::Prepared {
                service_id: actual,
                source,
            }),
        ) if actual == service_id && source.connection == connection => {
            Ok(ProtectedExportDesktopReply::Prepared(source))
        }
        (
            ProtectedExportDesktopRequest::Save { scope, save_id },
            Reply::ProtectedExport(R::SaveSource {
                scope: actual,
                bytes,
                sha256,
            }),
        ) if scope == actual && (1..=4 * 1024 * 1024).contains(&bytes) => {
            let owner = window.hwnd().map_err(|_| "WINDOW_UNAVAILABLE")?.0 as usize;
            let shared = state.0.clone();
            let commit = Box::new(move || {
                tauri::async_runtime::block_on(async move {
                    let Ok(mut shared) =
                        tokio::time::timeout(Duration::from_secs(2), shared.lock()).await
                    else {
                        return false;
                    };
                    let Ok(service) = shared.as_mut() else {
                        return false;
                    };
                    if !matches!(service.endpoint(), Ok((_, _, id)) if id == scope.service_id) {
                        return false;
                    }
                    matches!(service.request(Request::ProtectedExport {
                        request: E::CommitSave { scope, save_id },
                    }).await, Ok(Reply::ProtectedExport(R::SaveCommitted {
                        scope: actual, save_id: accepted,
                    })) if actual == scope && accepted == save_id)
                })
            });
            manager
                .start_checked(
                    export_save::Scope {
                        mode: export_save::SourceMode::Protected,
                        connection: scope.query.connection,
                        log_id: scope.artifact_id,
                        request_id: scope.query.request_id,
                    },
                    save_id,
                    owner,
                    terminal_log::ExportFingerprint { bytes, sha256 },
                    Some(commit),
                )
                .map(ProtectedExportDesktopReply::Save)
        }
        _ => Err("INVALID_EXPORT_REPLY".into()),
    }
}

#[tauri::command]
async fn open_managed_log_directory(
    state: State<'_, Desktop>,
    manager: State<'_, terminal_logs::Manager>,
) -> Result<(), String> {
    let directory = log_directory::current(state.clone()).await?;
    manager.open_directory(state.2.clone(), directory).await
}

#[tauri::command]
async fn terminal_log_request(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    manager: State<'_, terminal_logs::Manager>,
    saves: State<'_, export_save::Manager>,
    request: terminal_logs::Request,
) -> Result<terminal_logs::Info, String> {
    use terminal_logs::{Request as R, Source};
    if !request.valid() {
        return Err("INVALID_REQUEST".into());
    }
    let (target, id) = request.scope();
    match &request {
        R::Status { .. } => return manager.status(target, id, false),
        R::Cancel { .. } => {
            let info = manager.status(target, id, true)?;
            return if info.phase == "COMPLETED" && !saves.source_active(target.connection, id)? {
                manager.release(target, id)
            } else {
                Ok(info)
            };
        }
        R::Release { save_id, .. } => {
            let scope = export_save::Scope {
                mode: export_save::SourceMode::Menu,
                connection: target.connection,
                log_id: id,
                request_id: id,
            };
            let saved = saves.status(&scope, *save_id)?;
            if !matches!(saved.phase.as_str(), "COMPLETED" | "CANCELLED") {
                return Err("SAVE_NOT_FINISHED".into());
            }
            return manager.release(target, id);
        }
        _ => {}
    }
    if let Some(info) = manager.duplicate(&request)? {
        return Ok(info);
    }
    {
        let mut shared = state.0.lock().await;
        windows.permits(window.label(), Some(&target.connection))?;
        let service = shared.as_mut().map_err(|e| e.clone())?;
        if service.endpoint()?.2 != target.service_id {
            return Err("STALE_SERVICE".into());
        }
        let Reply::Sessions(sessions) = service.request(Request::List {}).await? else {
            return Err("INVALID_REPLY".into());
        };
        if !sessions
            .iter()
            .any(|c| c.reference() == target.connection && c.protocol == target.protocol)
        {
            return Err("STALE_TARGET".into());
        }
    }
    let mut open_source = None;
    let mut snapshots = Vec::new();
    match &request {
        R::OpenDirectory { .. } => {
            let directory = log_directory::current(state.clone()).await?;
            open_source = Some(terminal_logs::OpenSource::Directory(directory));
        }
        R::OpenFile { log_id, .. } => {
            open_source = Some(terminal_logs::OpenSource::File(
                log_directory::original(state.clone(), target.connection, *log_id, target.protocol)
                    .await?,
            ));
        }
        R::Prepare {
            source: Source::Recorded { log_ids },
            ..
        } => {
            let session_protocol::logging::Reply::List { logs } = forward_logging(
                state.clone(),
                session_protocol::logging::Request::List {
                    connection: target.connection,
                },
            )
            .await?
            else {
                return Err("INVALID_SOURCE".into());
            };
            let available = logs
                .iter()
                .filter(|l| {
                    l.readable.is_some()
                        || !matches!(
                            l.phase,
                            session_protocol::logging::Phase::Removed
                                | session_protocol::logging::Phase::Released
                        )
                })
                .map(|l| l.log_id)
                .collect::<std::collections::HashSet<_>>();
            if available != log_ids.iter().copied().collect() {
                return Err("RECORDING_SET_CHANGED".into());
            }
            for log_id in log_ids {
                let initial = logs
                    .iter()
                    .find(|l| l.log_id == *log_id)
                    .ok_or("INVALID_SOURCE")?;
                let through = initial.accepted_records;
                let mut info = initial.clone();
                let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                // Freeze each capture after its pre-existing accepted records have
                // reached the periodic flush watermark. Never stops recording.
                loop {
                    if info
                        .readable
                        .as_ref()
                        .is_some_and(|r| r.flushed_records >= through)
                    {
                        break;
                    }
                    if info.worker_finished || tokio::time::Instant::now() >= deadline {
                        return Err("SOURCE_NOT_FLUSHED".into());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    let session_protocol::logging::Reply::Info(next) = forward_logging(
                        state.clone(),
                        session_protocol::logging::Request::Status {
                            connection: target.connection,
                            log_id: *log_id,
                        },
                    )
                    .await?
                    else {
                        return Err("INVALID_SOURCE".into());
                    };
                    info = *next;
                }
                if info.connection != target.connection
                    || info.protocol != target.protocol
                    || info.log_id != *log_id
                {
                    return Err("INVALID_SOURCE".into());
                }
                let live = info.readable.ok_or("SOURCE_NOT_READY")?;
                snapshots.push(terminal_log::ReadableSnapshot {
                    log_id: *log_id,
                    connection: target.connection,
                    directory: live.directory,
                    filename: live.filename,
                    file_identity: live.file_identity.ok_or("INVALID_SOURCE")?,
                    writer_may_be_open: !info.worker_finished,
                    bytes: live.flushed_bytes,
                    flushed_records: live.flushed_records,
                    synced_records: live.synced_records,
                    flushed_at_ms: live.flushed_at_ms,
                    source_gap_bytes: live.flushed_gap_bytes,
                    rejected_records: info.rejected_records,
                    active: info.active,
                    failed: info.failure.is_some(),
                });
            }
        }
        _ => {}
    }
    manager.submit(request, open_source, snapshots)
}

#[tauri::command]
async fn config_request(
    state: State<'_, Desktop>,
    request: session_protocol::config::ConfigRequest,
) -> Result<session_protocol::config::ConfigReply, String> {
    if !request.validate() {
        return Err("INVALID_CONFIGURATION".into());
    }
    if matches!(
        request,
        session_protocol::config::ConfigRequest::PreviewImport { .. }
    ) {
        return Err("INVALID_CONFIGURATION".into());
    }
    // The renderer supplies a key path, never raw private-key material.
    if matches!(&request,session_protocol::config::ConfigRequest::SaveProfile {credential:session_protocol::config::CredentialEdit::Replace {value},..} if value.private_key.is_some())
    {
        return Err("INVALID_CONFIGURATION".into());
    }
    forward_config(state.inner(), request).await
}
async fn forward_config(
    state: &Desktop,
    request: session_protocol::config::ConfigRequest,
) -> Result<session_protocol::config::ConfigReply, String> {
    let mut channel = state.1.lock().await;
    configured_request(&mut channel, request).await
}

async fn configured_request(
    channel: &mut Option<session_service::client::Client>,
    request: session_protocol::config::ConfigRequest,
) -> Result<session_protocol::config::ConfigReply, String> {
    let client = channel.as_mut().ok_or("CONFIG_CHANNEL_UNAVAILABLE")?;
    match client.request(Request::Config { request }).await {
        Ok(session_protocol::Response::Ok {
            reply: Reply::Config(reply),
            ..
        }) => Ok(reply),
        Ok(session_protocol::Response::Error { code, .. }) => Err(code.to_string()),
        _ => {
            *channel = None;
            Err("CONFIG_CHANNEL_UNAVAILABLE".into())
        }
    }
}

#[derive(serde::Serialize)]
struct SavedFontSize {
    previous_revision: uuid::Uuid,
    revision: uuid::Uuid,
    font_size: u8,
}

#[tauri::command]
async fn save_terminal_font_size(
    state: State<'_, Desktop>,
    font_size: u8,
) -> Result<SavedFontSize, String> {
    use session_protocol::config::{ConfigReply as R, ConfigRequest as Q};
    if !(10..=28).contains(&font_size) {
        return Err("INVALID_CONFIGURATION".into());
    }
    // Read and patch the current stored preferences under the same config channel.
    // The renderer's other appearance edits never enter this request.
    let mut channel = state.1.lock().await;
    let (mut preferences, previous_revision) =
        match configured_request(&mut channel, Q::Preferences {}).await? {
            R::Preferences {
                preferences,
                revision,
            } => (preferences, revision),
            R::Error { code } => return Err(format!("{code:?}")),
            _ => return Err("INVALID_CONFIGURATION_REPLY".into()),
        };
    let revision = if preferences.font_size == font_size {
        previous_revision
    } else {
        preferences.font_size = font_size;
        match configured_request(
            &mut channel,
            Q::SavePreferences {
                revision: previous_revision,
                preferences,
            },
        )
        .await?
        {
            R::Preferences {
                preferences,
                revision,
            } if preferences.font_size == font_size => revision,
            R::Error { code } => return Err(format!("{code:?}")),
            _ => return Err("INVALID_CONFIGURATION_REPLY".into()),
        }
    };
    Ok(SavedFontSize {
        previous_revision,
        revision,
        font_size,
    })
}
#[tauri::command]
fn config_directory(state: State<'_, Desktop>) -> String {
    state.2.to_string_lossy().into_owned()
}

#[tauri::command]
async fn ssh_request(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    request: session_protocol::ssh::Request,
) -> Result<session_protocol::ssh::Reply, String> {
    if !request.validate() {
        return Err("INVALID_SSH_REQUEST".into());
    }
    use session_protocol::ssh::Request as S;
    let target = match &request {
        S::AuthenticateKey { connection, .. }
        | S::ExecReadProtected { connection, .. }
        | S::ForgetStart { connection, .. }
        | S::ForgetStatus { connection, .. }
        | S::Disconnect { connection, .. }
        | S::DisconnectStatus { connection, .. }
        | S::Reconnect { connection, .. }
        | S::ReconnectStatus { connection, .. }
        | S::ReconnectFixed { connection, .. }
        | S::ReconnectFixedStatus { connection, .. }
        | S::Exec { connection, .. }
        | S::ExecStatus { connection, .. }
        | S::ExecRead { connection, .. }
        | S::ExecCancel { connection, .. }
        | S::WriteText { connection, .. }
        | S::Write { connection, .. }
        | S::Resize { connection, .. }
        | S::InputStatus { connection, .. }
        | S::Status { connection }
        | S::AnswerHost { connection, .. }
        | S::Authenticate { connection, .. }
        | S::AnswerInteractive { connection, .. }
        | S::Close { connection }
        | S::Forget { connection } => Some(connection),
        S::Start { .. }
        | S::StartFixed { .. }
        | S::QuickStart { .. }
        | S::StartStatus { .. }
        | S::ConnectStatus { .. } => None,
    };
    let mut shared = state.0.lock().await;
    windows.permits(window.label(), target)?;
    match shared
        .as_mut()
        .map_err(|error| error.clone())?
        .request(Request::Ssh { request })
        .await?
    {
        Reply::Ssh(reply) => Ok(reply),
        _ => Err("INVALID_REPLY".into()),
    }
}

#[tauri::command]
async fn logging_request(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    request: session_protocol::logging::Request,
) -> Result<session_protocol::logging::Reply, String> {
    use session_protocol::logging::Request as L;
    match &request {
        L::DirectorySetting {} | L::SetDirectory { .. } | L::ReadableLocation { .. } => {
            return Err("INVALID_LOG_REQUEST".into());
        }
        L::Start { connection, .. }
        | L::Stop { connection, .. }
        | L::ReleaseFailed { connection, .. } => {
            windows.permits(window.label(), Some(connection))?
        }
        L::List { connection }
        | L::Status { connection, .. }
        | L::StartStatus { connection, .. }
            if window.label() != session_windows::MAIN =>
        {
            windows.permits(window.label(), Some(connection))?
        }
        _ => {}
    }
    let mut reply = forward_logging(state, request).await?;
    let logs = match &mut reply {
        session_protocol::logging::Reply::DirectoryUnavailable {} => {
            return Err("LOG_DIRECTORY_UNAVAILABLE".into());
        }
        session_protocol::logging::Reply::Info(info) => std::slice::from_mut(info.as_mut()),
        session_protocol::logging::Reply::List { logs } => logs.as_mut_slice(),
        _ => &mut [],
    };
    for info in logs {
        if let Some(readable) = &mut info.readable {
            readable.file_identity = None;
            readable.directory = None;
        }
    }
    Ok(reply)
}

async fn forward_logging(
    state: State<'_, Desktop>,
    request: session_protocol::logging::Request,
) -> Result<session_protocol::logging::Reply, String> {
    if !request.validate() {
        return Err("INVALID_LOG_REQUEST".into());
    }
    // File setup never holds the terminal/input client's channel.
    let mut channel = state.1.lock().await;
    let client = channel.as_mut().ok_or("LOG_CHANNEL_UNAVAILABLE")?;
    match client.request(Request::Logging { request }).await {
        Ok(session_protocol::Response::Ok {
            reply: Reply::Logging(reply),
            ..
        }) => Ok(reply),
        Ok(session_protocol::Response::Error { code, .. }) => Err(code.to_string()),
        _ => {
            *channel = None;
            Err("LOG_CHANNEL_UNAVAILABLE".into())
        }
    }
}

#[tauri::command]
async fn agent_management_request(
    state: State<'_, Desktop>,
    request: agent_management::Request,
) -> Result<agent_management::Reply, String> {
    let request = request.into_protocol()?;
    // Management can await Profile lookups. Keep it off the terminal/input pipe.
    let mut channel = state.1.lock().await;
    let client = channel.as_mut().ok_or("AGENT_CHANNEL_UNAVAILABLE")?;
    match client.request(Request::Agent { request }).await {
        Ok(session_protocol::Response::Ok {
            reply: Reply::Agent(reply),
            ..
        }) => Ok(reply.into()),
        Ok(session_protocol::Response::Error { code, .. }) => Err(code.to_string()),
        _ => {
            *channel = None;
            Err("AGENT_CHANNEL_UNAVAILABLE".into())
        }
    }
}

#[tauri::command]
async fn audit_history_request(
    state: State<'_, Desktop>,
    request: audit_history::Request,
) -> Result<audit_history::Reply, String> {
    let view = request.into_protocol()?;
    let mut channel = state.1.lock().await;
    let client = channel.as_mut().ok_or("AUDIT_CHANNEL_UNAVAILABLE")?;
    match client.request(Request::RpcAudit { view }).await {
        Ok(session_protocol::Response::Ok {
            reply: Reply::RpcAudit(reply),
            ..
        }) => audit_history::Reply::project(reply),
        Ok(session_protocol::Response::Error { code, .. }) => Err(code.to_string()),
        _ => {
            *channel = None;
            Err("AUDIT_CHANNEL_UNAVAILABLE".into())
        }
    }
}

#[tauri::command]
async fn bridge_management_request(
    state: State<'_, Desktop>,
    broker: State<'_, bridge_manager::Manager>,
    request: bridge_manager::Management,
) -> Result<serde_json::Value, String> {
    let value = match request {
        bridge_manager::Management::Info {} => serde_json::to_value(broker.info()?),
        bridge_manager::Management::Preview {
            pending_id,
            grant_request_id,
        } => serde_json::to_value(
            broker
                .prepare(&state.1, pending_id, grant_request_id)
                .await?,
        ),
        bridge_manager::Management::Approve { preview_id } => {
            let endpoint = {
                let service = state.0.lock().await;
                service
                    .as_ref()
                    .map_err(|_| "SERVICE_UNAVAILABLE")?
                    .endpoint()?
            };
            serde_json::to_value(broker.approve(&state.1, endpoint, preview_id).await?)
        }
    };
    value.map_err(|_| "INVALID_BRIDGE_REPLY".into())
}

#[tauri::command]
async fn shortcut_bridge_management(
    window: tauri::WebviewWindow,
    broker: State<'_, bridge_manager::Manager>,
    request: bridge_manager::shortcuts::Management,
) -> Result<serde_json::Value, String> {
    if window.label() != session_windows::MAIN {
        return Err("MAIN_WINDOW_REQUIRED".into());
    }
    use bridge_manager::shortcuts::Management;
    match request {
        Management::Status {} => serde_json::to_value(broker.shortcut_status()?),
        Management::Preview {
            pending_id,
            scope,
            seconds,
        } => serde_json::to_value(broker.preview_shortcuts(pending_id, scope, seconds)?),
        Management::Approve { preview_id } => {
            serde_json::to_value(broker.approve_shortcuts(preview_id)?)
        }
        Management::Revoke { pending_id, scope } => {
            serde_json::to_value(broker.revoke_shortcuts(pending_id, scope)?)
        }
    }
    .map_err(|_| "INVALID_BRIDGE_REPLY".into())
}

#[tauri::command]
async fn serial_request(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    request: session_protocol::serial::Request,
) -> Result<session_protocol::serial::Reply, String> {
    if !request.validate() {
        return Err("INVALID_SERIAL_REQUEST".into());
    }
    use session_protocol::serial::Request as S;
    let target = match &request {
        S::ForgetStart { connection, .. }
        | S::ForgetStatus { connection, .. }
        | S::Send { connection, .. }
        | S::Status { connection }
        | S::Write { connection, .. }
        | S::Control { connection, .. }
        | S::InputStatus { connection, .. }
        | S::Close { connection }
        | S::Disconnect { connection, .. }
        | S::DisconnectStatus { connection, .. }
        | S::Forget { connection } => Some(connection),
        S::Start { .. }
        | S::StartFixed { .. }
        | S::QuickStart { .. }
        | S::StartStatus { .. }
        | S::ConnectStatus { .. }
        | S::Inventory {} => None,
    };
    let mut shared = state.0.lock().await;
    windows.permits(window.label(), target)?;
    match shared
        .as_mut()
        .map_err(|error| error.clone())?
        .request(Request::Serial { request })
        .await?
    {
        Reply::Serial(reply) => Ok(reply),
        _ => Err("INVALID_REPLY".into()),
    }
}

#[tauri::command]
async fn service_status(state: State<'_, Desktop>) -> Result<service::Status, String> {
    state
        .0
        .lock()
        .await
        .as_mut()
        .map_err(|e| e.clone())?
        .status()
        .await
}
#[tauri::command]
async fn service_list(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
) -> Result<Vec<ConnectionInfo>, String> {
    let mut shared = state.0.lock().await;
    let service = shared.as_mut().map_err(|e| e.clone())?;
    let sessions = session_windows::list(service).await?;
    windows.filter(window.label(), sessions)
}

#[derive(serde::Serialize)]
struct DesktopSessionSnapshot {
    service: service::Status,
    sessions: Vec<ConnectionInfo>,
}

#[tauri::command]
async fn desktop_session_snapshot(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
) -> Result<DesktopSessionSnapshot, String> {
    let mut shared = state.0.lock().await;
    let service = shared.as_mut().map_err(|e| e.clone())?;
    let status = service.status().await?;
    let sessions = session_windows::list(service).await?;
    Ok(DesktopSessionSnapshot {
        service: status,
        sessions: windows.filter(window.label(), sessions)?,
    })
}
#[tauri::command]
async fn service_read(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    connection: ConnectionRef,
    cursor: u64,
) -> Result<OutputPage, String> {
    let mut shared = state.0.lock().await;
    windows.permits(window.label(), Some(&connection))?;
    match shared
        .as_mut()
        .map_err(|e| e.clone())?
        .request(Request::Read {
            connection,
            cursor,
            max_bytes: 65536,
        })
        .await?
    {
        Reply::Output(page) => Ok(page),
        _ => Err("INVALID_REPLY".into()),
    }
}

#[tauri::command]
async fn service_read_text(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    connection: ConnectionRef,
    cursor: u64,
) -> Result<session_core::presentation::TextPage, String> {
    let mut shared = state.0.lock().await;
    windows.permits(window.label(), Some(&connection))?;
    match shared
        .as_mut()
        .map_err(|e| e.clone())?
        .request(Request::ReadText {
            connection,
            cursor,
            max_bytes: 65536,
        })
        .await?
    {
        Reply::Text(page) => Ok(page),
        _ => Err("INVALID_REPLY".into()),
    }
}

#[tauri::command]
async fn service_screen(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
    connection: ConnectionRef,
) -> Result<session_core::presentation::ScreenSnapshot, String> {
    let mut shared = state.0.lock().await;
    windows.permits(window.label(), Some(&connection))?;
    match shared
        .as_mut()
        .map_err(|e| e.clone())?
        .request(Request::Screen { connection })
        .await?
    {
        Reply::Screen(screen) => Ok(screen),
        _ => Err("INVALID_REPLY".into()),
    }
}
#[tauri::command]
async fn fixture_create(state: State<'_, Desktop>) -> Result<ConnectionInfo, String> {
    let mut state = state.0.lock().await;
    let service = state.as_mut().map_err(|e| e.clone())?;
    if !service.fixture {
        return Err("FIXTURE_DISABLED".into());
    }
    match service.request(Request::CreateFixture {}).await? {
        Reply::Connection(connection) => Ok(connection),
        _ => Err("INVALID_REPLY".into()),
    }
}
#[tauri::command]
async fn fixture_append(
    state: State<'_, Desktop>,
    connection: ConnectionRef,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let mut state = state.0.lock().await;
    let service = state.as_mut().map_err(|e| e.clone())?;
    if !service.fixture {
        return Err("FIXTURE_DISABLED".into());
    }
    service
        .request(Request::AppendFixture { connection, bytes })
        .await?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum FixtureAction {
    Reconnect,
    Close,
    Remove,
}
#[tauri::command]
async fn fixture_lifecycle(
    state: State<'_, Desktop>,
    connection: ConnectionRef,
    action: FixtureAction,
) -> Result<Option<ConnectionInfo>, String> {
    let mut state = state.0.lock().await;
    let service = state.as_mut().map_err(|e| e.clone())?;
    if !service.fixture {
        return Err("FIXTURE_DISABLED".into());
    }
    let request = match action {
        FixtureAction::Reconnect => Request::ReconnectFixture { connection },
        FixtureAction::Close => Request::CloseFixture { connection },
        FixtureAction::Remove => Request::RemoveFixture { connection },
    };
    match service.request(request).await? {
        Reply::Connection(connection) => Ok(Some(connection)),
        Reply::Ok => Ok(None),
        _ => Err("INVALID_REPLY".into()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fixture = args.iter().any(|arg| arg == "--test-fixture");
    let serial_mcp_fixture = args.iter().any(|s| s == "--serial-mcp-fixture");
    assert!(
        !serial_mcp_fixture || cfg!(feature = "serial-mcp-fixture"),
        "SERIAL_MCP_FIXTURE_DISABLED"
    );
    let close_fixture_index = args.iter().position(|arg| arg == "--close-receipt-fixture");
    assert!(
        close_fixture_index.is_none() || cfg!(feature = "close-receipt-fixture"),
        "CLOSE_RECEIPT_FIXTURE_DISABLED"
    );
    let load_observer = args.iter().any(|arg| arg == "--load-observer-test");
    let log_disk_full_fixture = args.iter().any(|arg| arg == "--log-disk-full-fixture");
    assert!(
        !log_disk_full_fixture || cfg!(feature = "log-disk-full-fixture"),
        "LOG_DISK_FULL_FIXTURE_DISABLED"
    );
    let save_recovery_fixture = args.iter().position(|arg| arg == "--save-recovery-fixture");
    assert!(
        save_recovery_fixture.is_none() || cfg!(feature = "save-recovery-fixture"),
        "SAVE_RECOVERY_FIXTURE_DISABLED"
    );
    assert!(
        !load_observer || cfg!(feature = "load-observer-test"),
        "LOAD_OBSERVER_TEST_DISABLED"
    );
    let directory = args
        .iter()
        .position(|arg| arg == "--data-dir")
        .map(|index| {
            let path =
                std::path::PathBuf::from(args.get(index + 1).expect("missing data directory"));
            assert!(path.is_absolute(), "data directory must be absolute");
            path
        });
    #[cfg(feature = "log-disk-full-fixture")]
    if log_disk_full_fixture {
        assert!(!fixture, "LOG_DISK_FULL_TEST_REQUIRES_ORDINARY_SESSION");
        service::configure_log_disk_full_fixture(
            directory
                .as_deref()
                .expect("LOG_DISK_FULL_TEST_ROOT_REQUIRED"),
        )
        .expect("LOG_DISK_FULL_TEST_ROOT_REJECTED");
    }
    #[cfg(feature = "close-receipt-fixture")]
    if let Some(index) = close_fixture_index {
        close_fixture::configure(
            directory.as_deref().expect("missing own test root"),
            args.get(index + 1).expect("missing close test mode"),
            fixture,
        )
        .expect("CLOSE_RECEIPT_TEST_REJECTED");
    }
    #[cfg(feature = "save-recovery-fixture")]
    if let Some(index) = save_recovery_fixture {
        save_recovery_fixture::configure(
            directory.as_deref().expect("missing own test root"),
            args.get(index + 1).expect("missing save test mode"),
            fixture,
        )
        .expect("SAVE_RECOVERY_TEST_REJECTED");
    }
    #[cfg(feature = "serial-mcp-fixture")]
    if serial_mcp_fixture {
        serial_fixture::configure(
            directory.as_deref().expect("missing own test root"),
            fixture,
        )
        .expect("SERIAL_MCP_ROOT_REJECTED");
    }
    let app = tauri::Builder::default()
        .setup(move |app| {
            app.manage(session_windows::SessionWindows::default());
            let directory = match &directory {
                Some(path) => path.clone(),
                None => app.path().app_local_data_dir()?,
            };
            let mut service =
                tauri::async_runtime::block_on(service::Service::start(fixture, directory.clone()))
                    .map_err(|_| "SERVICE_START_FAILED".to_string());
            let configuration = Arc::new(Mutex::new(
                service
                    .as_mut()
                    .ok()
                    .and_then(|service| service.config_client.take()),
            ));
            let weak_config = Arc::downgrade(&configuration);
            if let Ok(service) = &service {
                let (_, _, service_id) = service.endpoint().map_err(|_| "SERVICE_UNAVAILABLE")?;
                app.manage(tauri::async_runtime::block_on(async {
                    bridge_manager::Manager::start(
                        service_id,
                        directory.clone(),
                        app.handle().clone(),
                    )
                })?);
            }
            let shared = Arc::new(Mutex::new(service));
            #[cfg(feature = "load-observer-test")]
            if load_observer {
                assert!(!fixture, "observer requires ordinary service");
                load_observer_test::start(shared.clone(), directory.clone())?;
            }
            let weak = Arc::downgrade(&shared);
            app.manage(export_save::Manager::new(directory.clone())?);
            app.manage(SaveRecoverySnapshot::load(&directory));
            app.manage(terminal_logs::Manager::new(directory.clone())?);
            app.manage(log_viewer::Editor::new());
            app.manage(trigger_match::Manager::default());
            app.manage(local_terminal::Terminals::default());
            app.manage(log_directory::Selection::default());
            app.manage(local_terminal::scripts::Picker(Arc::new(
                tokio::sync::Semaphore::new(1),
            )));
            app.manage(config_import::Manager::default());
            app.manage(Desktop(shared, configuration, directory));
            // Renderer reload/suspension must not expire the native IPC client.
            // A failed heartbeat latches failure, never restarts or retries input.
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    let Some(shared) = weak.upgrade() else { break };
                    let mut state = shared.lock().await;
                    let Ok(service) = state.as_mut() else { break };
                    if service.request(Request::Ping {}).await.is_err() {
                        break;
                    }
                    drop(state);
                    if let Some(configuration) = weak_config.upgrade() {
                        let mut channel = configuration.lock().await;
                        if let Some(client) = channel.as_mut()
                            && client.request(Request::Ping {}).await.is_err()
                        {
                            *channel = None;
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal_clipboard::terminal_clipboard_read,
            local_terminal::local_terminal,
            local_terminal::poll_local_output,
            local_terminal::local_adb_settings,
            local_terminal::local_shortcut_text,
            local_terminal::directory::local_directory_settings,
            local_terminal::directory::local_right_click,
            local_terminal::prepare_local_adb,
            local_terminal::scripts::pick_local_scripts,
            local_terminal::scripts::preview_local_script,
            local_terminal::scripts::reveal_local_script,
            service_status,
            session_windows::desktop_live_sessions,
            session_windows::detach_session,
            session_windows::request_detached_copy,
            session_windows::take_detached_copy,
            session_windows::preview_session_dock,
            session_windows::dock_session,
            trigger_match::trigger_match_request,
            service_list,
            desktop_session_snapshot,
            service_read,
            service_read_text,
            service_screen,
            ssh_request,
            serial_request,
            fixture_create,
            fixture_append,
            fixture_lifecycle,
            config_request,
            save_terminal_font_size,
            config_import::select_config_import,
            logging_request,
            agent_management_request,
            audit_history_request,
            bridge_management_request,
            shortcut_bridge_management,
            export_save_request,
            save_recovery_status,
            protected_export_desktop_request,
            terminal_log_request,
            open_managed_log_directory,
            log_directory::log_directory_settings,
            log_directory::open_original_log,
            log_viewer::log_viewer_settings,
            log_viewer::registered_log_viewers,
            log_viewer::select_registered_log_viewer,
            log_viewer::choose_log_viewer,
            log_viewer::reset_log_viewer,
            config_directory
        ])
        .build(tauri::generate_context!())
        .expect("desktop application failed");
    app.run(|handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            if label == session_windows::MAIN {
                handle.exit(0);
            } else {
                handle
                    .state::<session_windows::SessionWindows>()
                    .release(label);
                if let Some(main) = handle.get_webview_window(session_windows::MAIN) {
                    let _ = main.set_focus();
                }
            }
        }
        if let tauri::RunEvent::Exit = event {
            handle.state::<local_terminal::Terminals>().close_all();
            handle.state::<export_save::Manager>().cancel_all();
            let state = handle.state::<Desktop>();
            tauri::async_runtime::block_on(async {
                if let Some(broker) = handle.try_state::<bridge_manager::Manager>() {
                    broker.close().await;
                }
                if let Ok(service) = state.0.lock().await.as_mut() {
                    let outcome = service.stop().await;
                    close_receipt::report(&outcome);
                }
            });
        }
    });
}
