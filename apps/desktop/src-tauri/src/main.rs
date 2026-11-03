#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod service;
use session_core::session::{ConnectionInfo, ConnectionRef, OutputPage};
use session_protocol::{Reply, Request};
use std::{sync::Arc, time::Duration};
use tauri::{Manager, State};
use tokio::sync::Mutex;

struct Desktop(Arc<Mutex<Result<service::Service, String>>>);

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

fn main() {
    let fixture = std::env::args().any(|arg| arg == "--test-fixture");
    let app = tauri::Builder::default()
        .setup(move |app| {
            let service = tauri::async_runtime::block_on(service::Service::start(fixture))
                .map_err(|_| "SERVICE_START_FAILED".to_string());
            let shared = Arc::new(Mutex::new(service));
            let weak = Arc::downgrade(&shared);
            app.manage(Desktop(shared));
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
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            service_status,
            service_list,
            service_read,
            fixture_create,
            fixture_append
        ])
        .build(tauri::generate_context!())
        .expect("desktop application failed");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<Desktop>();
            tauri::async_runtime::block_on(async {
                if let Ok(service) = state.0.lock().await.as_mut() {
                    service.stop().await;
                }
            });
        }
    });
}
