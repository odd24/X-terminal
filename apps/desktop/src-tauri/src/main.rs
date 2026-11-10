// Development previews are launched directly too; they must not allocate a console.
#![windows_subsystem = "windows"]

mod agent_management;
mod audit_history;
mod bridge_manager;
mod close_receipt;
mod config_import;
mod export_save;
#[cfg(feature = "load-observer-test")]
mod load_observer_test;
mod service;
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
                let reply = logging_request(state, scope.source_status()).await?;
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

#[tauri::command]
async fn terminal_log_request(
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
    let mut filename = None;
    let mut snapshots = Vec::new();
    match &request {
        R::OpenFile { log_id, .. } => {
            let session_protocol::logging::Reply::Info(info) = logging_request(
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
            if info.connection != target.connection || info.protocol != target.protocol {
                return Err("INVALID_SOURCE".into());
            }
            filename = Some(info.readable.ok_or("SOURCE_NOT_READY")?.filename);
        }
        R::Prepare {
            source: Source::Recorded { log_ids },
            ..
        } => {
            let session_protocol::logging::Reply::List { logs } = logging_request(
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
                    let session_protocol::logging::Reply::Info(next) = logging_request(
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
                if info.connection != target.connection || info.protocol != target.protocol {
                    return Err("INVALID_SOURCE".into());
                }
                let live = info.readable.ok_or("SOURCE_NOT_READY")?;
                snapshots.push(terminal_log::ReadableSnapshot {
                    log_id: *log_id,
                    connection: target.connection,
                    filename: live.filename,
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
    manager.submit(request, filename, snapshots)
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
#[tauri::command]
fn config_directory(state: State<'_, Desktop>) -> String {
    state.2.to_string_lossy().into_owned()
}

#[tauri::command]
async fn ssh_request(
    state: State<'_, Desktop>,
    request: session_protocol::ssh::Request,
) -> Result<session_protocol::ssh::Reply, String> {
    if !request.validate() {
        return Err("INVALID_SSH_REQUEST".into());
    }
    match state
        .0
        .lock()
        .await
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
async fn serial_request(
    state: State<'_, Desktop>,
    request: session_protocol::serial::Request,
) -> Result<session_protocol::serial::Reply, String> {
    if !request.validate() {
        return Err("INVALID_SERIAL_REQUEST".into());
    }
    match state
        .0
        .lock()
        .await
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
async fn service_list(state: State<'_, Desktop>) -> Result<Vec<ConnectionInfo>, String> {
    match state
        .0
        .lock()
        .await
        .as_mut()
        .map_err(|e| e.clone())?
        .request(Request::List {})
        .await?
    {
        Reply::Sessions(sessions) => Ok(sessions),
        _ => Err("INVALID_REPLY".into()),
    }
}
#[tauri::command]
async fn service_read(
    state: State<'_, Desktop>,
    connection: ConnectionRef,
    cursor: u64,
) -> Result<OutputPage, String> {
    match state
        .0
        .lock()
        .await
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
    state: State<'_, Desktop>,
    connection: ConnectionRef,
    cursor: u64,
) -> Result<session_core::presentation::TextPage, String> {
    match state
        .0
        .lock()
        .await
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
    state: State<'_, Desktop>,
    connection: ConnectionRef,
) -> Result<session_core::presentation::ScreenSnapshot, String> {
    match state
        .0
        .lock()
        .await
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
    let load_observer = args.iter().any(|arg| arg == "--load-observer-test");
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
    let app = tauri::Builder::default()
        .setup(move |app| {
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
                    bridge_manager::Manager::start(service_id)
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
            app.manage(terminal_logs::Manager::new(directory.clone())?);
            app.manage(trigger_match::Manager::default());
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
            service_status,
            trigger_match::trigger_match_request,
            service_list,
            service_read,
            service_read_text,
            service_screen,
            ssh_request,
            serial_request,
            fixture_create,
            fixture_append,
            fixture_lifecycle,
            config_request,
            config_import::select_config_import,
            logging_request,
            agent_management_request,
            audit_history_request,
            bridge_management_request,
            export_save_request,
            terminal_log_request,
            config_directory
        ])
        .build(tauri::generate_context!())
        .expect("desktop application failed");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<export_save::Manager>().cancel_all();
            let state = handle.state::<Desktop>();
            tauri::async_runtime::block_on(async {
                if let Some(broker) = handle.try_state::<bridge_manager::Manager>() {
                    broker.close().await;
                }
                if let Ok(service) = state.0.lock().await.as_mut() {
                    service.stop().await;
                }
            });
        }
    });
}
