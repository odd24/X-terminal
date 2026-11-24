use crate::{Desktop, session_windows};
use session_protocol::{Reply, Request};
use tauri::State;

#[tauri::command]
pub(crate) async fn ssh_request(
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
