#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_management;
mod export_save;
mod service;
mod terminal_clipboard;
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
    request: export_save::Request,
) -> Result<export_save::Info, String> {
    use export_save::Request as R;
    match request {
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
            let reply = logging_request(state, scope.source_status()).await?;
            let fingerprint = scope.fingerprint(reply)?;
            manager.start(
                scope,
                save_id,
                window.hwnd().map_err(|_| "WINDOW_UNAVAILABLE")?.0 as usize,
                fingerprint,
            )
        }
    }
}

#[tauri::command]
async fn config_request(
    state: State<'_, Desktop>,
    request: session_protocol::config::ConfigRequest,
) -> Result<session_protocol::config::ConfigReply, String> {
    if !request.validate() {
        return Err("INVALID_CONFIGURATION".into());
    }
    // The renderer supplies a key path, never raw private-key material.
    if matches!(&request,session_protocol::config::ConfigRequest::SaveProfile {credential:session_protocol::config::CredentialEdit::Replace {value},..} if value.private_key.is_some())
    {
        return Err("INVALID_CONFIGURATION".into());
    }
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
            let shared = Arc::new(Mutex::new(service));
            let weak = Arc::downgrade(&shared);
            app.manage(export_save::Manager::new(directory.clone())?);
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
            logging_request,
            agent_management_request,
            export_save_request,
            config_directory
        ])
        .build(tauri::generate_context!())
        .expect("desktop application failed");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<export_save::Manager>().cancel_all();
            let state = handle.state::<Desktop>();
            tauri::async_runtime::block_on(async {
                if let Ok(service) = state.0.lock().await.as_mut() {
                    service.stop().await;
                }
            });
        }
    });
}
