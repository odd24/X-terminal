use crate::{Desktop, forward_logging, local_terminal, session_windows, terminal_logs};
use serde::{Deserialize, Serialize};
use session_core::session::{ConnectionRef, Protocol};
use session_protocol::logging::{Reply, Request};
use tauri::{State, WebviewWindow};
use uuid::Uuid;

#[derive(Default)]
pub struct Selection(tokio::sync::Mutex<Option<(Uuid, String)>>);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Read,
    Choose,
    Save { revision: Uuid, selection_id: Uuid },
    Restore { revision: Uuid },
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Settings {
    Current {
        revision: Uuid,
        directory: Option<String>,
        effective: String,
    },
    Selected {
        selection_id: Uuid,
        path: String,
    },
    Cancelled {},
}

async fn setting(desktop: State<'_, Desktop>, request: Request) -> Result<Settings, String> {
    let reread = matches!(&request, Request::DirectorySetting {});
    let reply = match forward_logging(desktop.clone(), request).await {
        Err(error) if reread && error == "LOG_CHANNEL_UNAVAILABLE" => {
            let mut shared = desktop.0.lock().await;
            let service = shared.as_mut().map_err(|error| error.clone())?;
            match service
                .request(session_protocol::Request::Logging {
                    request: Request::DirectorySetting {},
                })
                .await?
            {
                session_protocol::Reply::Logging(reply) => reply,
                _ => return Err("INVALID_LOG_REPLY".into()),
            }
        }
        result => result?,
    };
    let Reply::Directory {
        revision,
        directory,
        effective,
    } = reply
    else {
        return Err("INVALID_LOG_REPLY".into());
    };
    Ok(Settings::Current {
        revision,
        directory,
        effective,
    })
}

pub(crate) async fn current(desktop: State<'_, Desktop>) -> Result<Option<String>, String> {
    match setting(desktop, Request::DirectorySetting {}).await? {
        Settings::Current { directory, .. } => Ok(directory),
        _ => Err("INVALID_LOG_REPLY".into()),
    }
}

#[tauri::command]
pub async fn log_directory_settings(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    picker: State<'_, local_terminal::scripts::Picker>,
    selection: State<'_, Selection>,
    action: Action,
) -> Result<Settings, String> {
    if window.label() != session_windows::MAIN {
        return Err("LOG_SETTINGS_MAIN_ONLY".into());
    }
    let mut selected = selection.0.lock().await;
    match action {
        Action::Read => setting(desktop, Request::DirectorySetting {}).await,
        Action::Choose => {
            let permit = picker.0.clone().try_acquire_owned().map_err(|_| "BUSY")?;
            let owner = window.hwnd().map_err(|_| "WINDOW_UNAVAILABLE")?.0 as usize;
            *selected = None;
            let path = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                local_terminal::directory::pick_folder(owner, windows::core::w!("选择日志保存目录"))
            })
            .await
            .map_err(|_| "WORKER_FAILED")??;
            let Some(path) = path else {
                return Ok(Settings::Cancelled {});
            };
            let selection_id = Uuid::new_v4();
            *selected = Some((selection_id, path.clone()));
            Ok(Settings::Selected { selection_id, path })
        }
        Action::Save {
            revision,
            selection_id,
        } => {
            if selected.as_ref().is_none_or(|(id, _)| *id != selection_id) {
                return Err("LOG_SELECTION_EXPIRED".into());
            }
            let (_, directory) = selected.take().ok_or("LOG_SELECTION_EXPIRED")?;
            setting(
                desktop,
                Request::SetDirectory {
                    revision,
                    directory: Some(directory),
                },
            )
            .await
        }
        Action::Restore { revision } => {
            *selected = None;
            setting(
                desktop,
                Request::SetDirectory {
                    revision,
                    directory: None,
                },
            )
            .await
        }
    }
}

pub(crate) async fn original(
    desktop: State<'_, Desktop>,
    connection: ConnectionRef,
    log_id: Uuid,
    protocol: Protocol,
) -> Result<terminal_logs::ReadableSource, String> {
    let Reply::ReadableLocation {
        directory,
        filename,
        file_identity,
        writer_may_be_open,
    } = forward_logging(
        desktop,
        Request::ReadableLocation {
            connection,
            log_id,
            protocol,
        },
    )
    .await?
    else {
        return Err("SOURCE_MISSING".into());
    };
    Ok(terminal_logs::ReadableSource {
        directory,
        log_id,
        filename,
        file_identity,
        writer_may_be_open,
    })
}

#[tauri::command]
pub async fn open_original_log(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    manager: State<'_, terminal_logs::Manager>,
    connection: ConnectionRef,
    log_id: Uuid,
    protocol: Protocol,
) -> Result<(), String> {
    if window.label() != session_windows::MAIN {
        return Err("LOG_HISTORY_MAIN_ONLY".into());
    }
    let source = original(desktop.clone(), connection, log_id, protocol).await?;
    manager
        .open_original(desktop.2.clone(), connection, source)
        .await
}
