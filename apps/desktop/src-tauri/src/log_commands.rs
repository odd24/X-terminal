use crate::{Desktop, export_save, log_directory, session_windows, terminal_logs};
use session_core::session::ConnectionRef;
use session_protocol::{Reply, Request};
use std::time::Duration;
use tauri::State;

#[tauri::command]
pub(crate) async fn export_save_request(
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
pub(crate) enum ProtectedExportDesktopRequest {
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
pub(crate) enum ProtectedExportDesktopReply {
    Prepared(session_core::session::EndedOutput),
    Save(export_save::Info),
}

#[tauri::command]
pub(crate) async fn protected_export_desktop_request(
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
pub(crate) async fn open_managed_log_directory(
    state: State<'_, Desktop>,
    manager: State<'_, terminal_logs::Manager>,
) -> Result<(), String> {
    let directory = log_directory::current(state.clone()).await?;
    manager.open_directory(state.2.clone(), directory).await
}

#[tauri::command]
pub(crate) async fn terminal_log_request(
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
pub(crate) async fn logging_request(
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

pub(crate) async fn forward_logging(
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
