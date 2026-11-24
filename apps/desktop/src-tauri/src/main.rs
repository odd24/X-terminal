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
mod log_commands;
mod log_directory;
mod log_viewer;
#[cfg(feature = "save-recovery-fixture")]
mod save_recovery_fixture;
mod serial_commands;
#[cfg(feature = "serial-mcp-fixture")]
mod serial_fixture;
mod service;
mod session_windows;
mod ssh_commands;
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
    windows.filter(window.label(), sessions, ConnectionInfo::reference)
}

#[derive(serde::Serialize)]
struct DesktopSessionSnapshot {
    service: service::Status,
    sessions: Vec<ConnectionInfo>,
    next_cursors: Vec<u64>,
}

#[tauri::command]
async fn desktop_session_snapshot(
    window: tauri::WebviewWindow,
    windows: State<'_, session_windows::SessionWindows>,
    state: State<'_, Desktop>,
) -> Result<DesktopSessionSnapshot, String> {
    let mut shared = state.0.lock().await;
    let service = shared.as_mut().map_err(|e| e.clone())?;
    let (status, sessions) = service.snapshot().await?;
    let (sessions, next_cursors) = windows
        .filter(window.label(), sessions, |(info, _)| info.reference())?
        .into_iter()
        .unzip();
    Ok(DesktopSessionSnapshot {
        service: status,
        sessions,
        next_cursors,
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
            ssh_commands::ssh_request,
            serial_commands::serial_request,
            fixture_create,
            fixture_append,
            fixture_lifecycle,
            config_request,
            save_terminal_font_size,
            config_import::select_config_import,
            log_commands::logging_request,
            agent_management_request,
            audit_history_request,
            bridge_management_request,
            shortcut_bridge_management,
            log_commands::export_save_request,
            save_recovery_status,
            log_commands::protected_export_desktop_request,
            log_commands::terminal_log_request,
            log_commands::open_managed_log_directory,
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
