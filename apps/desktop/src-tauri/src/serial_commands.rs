use crate::{Desktop, session_windows};
use session_protocol::{Reply, Request};
use tauri::State;

#[tauri::command]
pub(crate) async fn serial_request(
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
