use crate::Desktop;
use session_core::session::{ConnectionInfo, ConnectionRef, Protocol, State as ConnectionState};
use session_protocol::{Reply, Request};
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use uuid::Uuid;
use windows::Win32::{
    Foundation::POINT,
    UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, WindowFromPoint},
};

pub const MAIN: &str = "main";

#[derive(Default)]
pub struct SessionWindows(Mutex<HashMap<String, ConnectionRef>>);

impl SessionWindows {
    pub fn permits(&self, label: &str, target: Option<&ConnectionRef>) -> Result<(), String> {
        let windows = self.0.lock().map_err(|_| "WINDOW_STATE_UNAVAILABLE")?;
        let permitted = if label == MAIN {
            target.is_none_or(|target| windows.values().all(|session| session != target))
        } else {
            target.is_some_and(|target| windows.get(label) == Some(target))
        };
        permitted
            .then_some(())
            .ok_or_else(|| "SESSION_IN_OTHER_WINDOW".into())
    }

    pub fn filter(
        &self,
        label: &str,
        sessions: Vec<ConnectionInfo>,
    ) -> Result<Vec<ConnectionInfo>, String> {
        let windows = self.0.lock().map_err(|_| "WINDOW_STATE_UNAVAILABLE")?;
        Ok(sessions
            .into_iter()
            .filter(|session| {
                if label == MAIN {
                    windows
                        .values()
                        .all(|target| *target != session.reference())
                } else {
                    windows.get(label) == Some(&session.reference())
                }
            })
            .collect())
    }

    pub fn release(&self, label: &str) {
        if let Ok(mut windows) = self.0.lock() {
            windows.remove(label);
        }
    }

    fn reserve(&self, label: &str, target: ConnectionRef) -> Result<(), String> {
        let mut windows = self.0.lock().map_err(|_| "WINDOW_STATE_UNAVAILABLE")?;
        if windows.values().any(|session| *session == target) {
            return Err("SESSION_IN_OTHER_WINDOW".into());
        }
        windows.insert(label.into(), target);
        Ok(())
    }
}

pub async fn list(service: &mut crate::service::Service) -> Result<Vec<ConnectionInfo>, String> {
    match service.request(Request::List {}).await? {
        Reply::Sessions(sessions) => Ok(sessions),
        _ => Err("INVALID_REPLY".into()),
    }
}

#[tauri::command]
pub async fn desktop_live_sessions(
    window: WebviewWindow,
    state: State<'_, Desktop>,
) -> Result<bool, String> {
    if window.label() != MAIN {
        return Err("MAIN_WINDOW_REQUIRED".into());
    }
    let mut shared = state.0.lock().await;
    let service = shared.as_mut().map_err(|error| error.clone())?;
    Ok(list(service).await?.iter().any(|session| {
        session.protocol != Protocol::Fixture
            && !matches!(
                session.state,
                ConnectionState::Disconnected | ConnectionState::Failed
            )
    }))
}

fn main_under_cursor(window: &WebviewWindow) -> Option<WebviewWindow> {
    let app = window.app_handle();
    let main = app.get_webview_window(MAIN)?;
    let cursor = app.cursor_position().ok()?;
    let expected = main.hwnd().ok()?.0;
    let point = POINT {
        x: cursor.x as i32,
        y: cursor.y as i32,
    };
    let actual = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) }.0;
    (actual == expected).then_some(main)
}

#[tauri::command]
pub fn preview_session_dock(window: WebviewWindow, active: bool) {
    if window.label() == MAIN {
        return;
    }
    let ready = active && main_under_cursor(&window).is_some();
    let _ = window
        .app_handle()
        .emit_to(MAIN, "session-dock-hover", ready);
}

#[tauri::command]
pub async fn dock_session(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    windows: State<'_, SessionWindows>,
    service_id: Uuid,
    connection: ConnectionRef,
) -> Result<(), String> {
    if window.label() == MAIN || main_under_cursor(&window).is_none() {
        return Err("DROP_OUTSIDE_MAIN_WINDOW".into());
    }
    {
        let mut shared = state.0.lock().await;
        let service = shared.as_mut().map_err(|error| error.clone())?;
        if service.endpoint()?.2 != service_id {
            return Err("STALE_SERVICE".into());
        }
        windows.permits(window.label(), Some(&connection))?;
    }
    let _ = window
        .app_handle()
        .emit_to(MAIN, "session-dock-hover", false);
    // Destroyed releases the original window binding and returns the exact tab.
    window.close().map_err(|_| "WINDOW_CLOSE_FAILED".into())
}

#[tauri::command]
pub async fn detach_session(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    windows: State<'_, SessionWindows>,
    service_id: Uuid,
    connection: ConnectionRef,
) -> Result<(), String> {
    if window.label() != MAIN {
        return Err("MAIN_WINDOW_REQUIRED".into());
    }
    let app = window.app_handle();
    let cursor = app.cursor_position().map_err(|_| "CURSOR_UNAVAILABLE")?;
    let origin = window.outer_position().map_err(|_| "WINDOW_UNAVAILABLE")?;
    let size = window.outer_size().map_err(|_| "WINDOW_UNAVAILABLE")?;
    let x = cursor.x - f64::from(origin.x);
    let y = cursor.y - f64::from(origin.y);
    if x >= 0.0 && x < f64::from(size.width) && y >= 0.0 && y < f64::from(size.height) {
        return Err("DROP_INSIDE_MAIN_WINDOW".into());
    }
    let label = format!("session-{}", Uuid::new_v4());
    {
        // Serialize the handoff with terminal input and PTY resize admission.
        let mut shared = state.0.lock().await;
        let service = shared.as_mut().map_err(|error| error.clone())?;
        if service.endpoint()?.2 != service_id {
            return Err("STALE_SERVICE".into());
        }
        let sessions = list(service).await?;
        if !sessions.iter().any(|session| {
            session.reference() == connection
                && session.state == ConnectionState::Connected
                && matches!(
                    session.protocol,
                    Protocol::Ssh2 | Protocol::Ssh1 | Protocol::Serial
                )
        }) {
            return Err("STALE_TARGET".into());
        }
        windows.reserve(&label, connection)?;
    }

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("共享终端 · 独立会话")
        .focused(true)
        .inner_size(880.0, 580.0)
        .min_inner_size(480.0, 320.0);
    // Anchor the title bar near the pointer on its current monitor.
    if let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let x = (cursor.x - 220.0 * scale).clamp(
            f64::from(work.position.x),
            (f64::from(work.position.x) + f64::from(work.size.width) - 880.0 * scale)
                .max(f64::from(work.position.x)),
        );
        let y = (cursor.y - 16.0 * scale).clamp(
            f64::from(work.position.y),
            (f64::from(work.position.y) + f64::from(work.size.height) - 580.0 * scale)
                .max(f64::from(work.position.y)),
        );
        builder = builder.position(x / scale, y / scale);
    }
    if builder.build().is_err() {
        windows.release(&label);
        return Err("WINDOW_CREATE_FAILED".into());
    }
    Ok(())
}
