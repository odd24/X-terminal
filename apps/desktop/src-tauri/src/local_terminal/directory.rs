use credential_vault::{Error, Secret};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{State, WebviewWindow};
use uuid::Uuid;
use windows::{
    Win32::{
        Foundation::{E_INVALIDARG, HWND},
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::Shell::{
            FOLDERID_Desktop, FOLDERID_Profile, FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM,
            FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog,
            KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath, SIGDN_FILESYSPATH,
        },
    },
    core::{GUID, PWSTR, w},
};

use super::scripts::Picker;

const STORE: &str = "local-directory.db";
const ENTRY: Uuid = Uuid::from_u128(0xad08f4ef_e858_4bbe_a1fe_71b57848a10a);
const RIGHT_CLICK: Uuid = Uuid::from_u128(0xbe1c3dba_dbbc_46ef_b2d6_b32ab25bbf48);
const STORAGE: &str = "无法读取或保存本地终端目录设置";
const UNAVAILABLE: &str = "所选目录不存在或无法访问";

#[derive(Serialize)]
pub struct Settings {
    saved_path: Option<String>,
    desktop_path: Option<PathBuf>,
    effective_path: Option<PathBuf>,
    warning: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Read,
    Choose,
    Restore,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RightClick {
    #[default]
    Smart,
    Menu,
}

#[tauri::command]
pub async fn local_right_click(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    mode: Option<RightClick>,
) -> Result<RightClick, String> {
    const ERROR: &str = "无法读取或保存本地终端右键设置";
    if window.label() != crate::session_windows::MAIN {
        return Err(ERROR.into());
    }
    let root = desktop.2.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::log_viewer::with_native_settings(&root, STORE, mode.is_some(), |vault| {
            let current = match vault.as_ref().map(|vault| vault.get(RIGHT_CLICK)) {
                None | Some(Err(Error::NotFound)) => RightClick::default(),
                Some(Ok(secret)) => serde_json::from_slice(secret.expose()).map_err(|_| ERROR)?,
                Some(Err(_)) => return Err(ERROR.into()),
            };
            if let Some(mode) = mode {
                let data = serde_json::to_vec(&mode).map_err(|_| ERROR)?;
                let secret = Secret::new(data).map_err(|_| ERROR)?;
                vault
                    .ok_or(ERROR)?
                    .set(RIGHT_CLICK, secret)
                    .map_err(|_| ERROR)?;
                Ok(mode)
            } else {
                Ok(current)
            }
        })
        .map_err(|_| ERROR.into())
    })
    .await
    .map_err(|_| ERROR.to_string())?
}

fn read(root: &Path) -> Result<Option<String>, String> {
    crate::log_viewer::with_native_settings(root, STORE, false, |vault| {
        match vault.map(|vault| vault.get(ENTRY)) {
            None | Some(Err(Error::NotFound)) => Ok(None),
            Some(Ok(secret)) => serde_json::from_slice(secret.expose()).map_err(|_| STORAGE.into()),
            Some(Err(_)) => Err(STORAGE.into()),
        }
    })
    .map_err(|_| STORAGE.into())
}

fn save(root: &Path, path: Option<&str>) -> Result<(), String> {
    let value = serde_json::to_vec(&path).map_err(|_| STORAGE)?;
    let secret = Secret::new(value).map_err(|_| STORAGE)?;
    crate::log_viewer::with_native_settings(root, STORE, true, |vault| {
        vault
            .ok_or(STORAGE)?
            .set(ENTRY, secret)
            .map_err(|_| STORAGE.into())
    })
    .map_err(|_| STORAGE.into())
}

fn read_shell_path(raw: PWSTR) -> windows::core::Result<String> {
    unsafe {
        let value = raw.to_string();
        CoTaskMemFree(Some(raw.0.cast()));
        value.map_err(|_| windows::core::Error::from_hresult(E_INVALIDARG))
    }
}

fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe { SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, None) }
        .and_then(read_shell_path)
        .ok()
        .map(PathBuf::from)
}

fn accessible(path: &Path) -> bool {
    path.is_absolute() && std::fs::read_dir(path).is_ok()
}

fn resolve(saved: Result<Option<String>, String>) -> Settings {
    let (saved_path, mut warning) = match saved {
        Ok(path) => (path, None),
        Err(error) => (None, Some(error)),
    };
    let desktop_path = known_folder(&FOLDERID_Desktop);
    let mut effective_path = saved_path
        .as_deref()
        .map(Path::new)
        .filter(|path| accessible(path))
        .map(Path::to_path_buf);
    if effective_path.is_none() {
        if saved_path.is_some() {
            warning = Some("已保存的默认目录不存在或无法访问".into());
        }
        effective_path = desktop_path.clone().filter(|path| accessible(path));
        if effective_path.is_some() {
            if let Some(message) = &mut warning {
                message.push_str("，已使用桌面");
            }
        } else {
            effective_path = known_folder(&FOLDERID_Profile).filter(|path| accessible(path));
            let message = warning.get_or_insert_with(String::new);
            if !message.is_empty() {
                message.push('，');
            }
            message.push_str(if effective_path.is_some() {
                "桌面不可访问，已使用当前用户的主目录"
            } else {
                "桌面和当前用户的主目录均不可访问"
            });
        }
    }
    Settings {
        saved_path,
        desktop_path,
        effective_path,
        warning,
    }
}

pub(super) fn startup(root: &Path) -> Result<(PathBuf, Option<String>), String> {
    let Settings {
        effective_path,
        warning,
        ..
    } = resolve(read(root));
    let cwd = effective_path.ok_or_else(|| {
        warning
            .clone()
            .unwrap_or_else(|| "无法打开本地终端默认目录".into())
    })?;
    Ok((cwd, warning))
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn choose(owner: usize) -> Result<Option<String>, String> {
    unsafe {
        let unavailable = |_| "无法打开默认目录选择器".to_string();
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(unavailable)?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(unavailable)?;
        dialog
            .SetOptions(
                dialog.GetOptions().map_err(unavailable)?
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )
            .map_err(unavailable)?;
        dialog
            .SetTitle(w!("选择本地终端默认目录"))
            .map_err(unavailable)?;
        dialog
            .SetOkButtonLabel(w!("选择文件夹"))
            .map_err(unavailable)?;
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(unavailable(error));
        }
        let path = dialog
            .GetResult()
            .and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH))
            .and_then(read_shell_path)
            .map_err(unavailable)?;
        if !accessible(Path::new(&path)) {
            return Err(UNAVAILABLE.into());
        }
        Ok(Some(path))
    }
}

#[tauri::command]
pub async fn local_directory_settings(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    picker: State<'_, Picker>,
    action: Action,
) -> Result<Option<Settings>, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("本地终端设置仅在主窗口可用".into());
    }
    let root = desktop.2.clone();
    let owner = window.hwnd().map_err(|_| "窗口不可用")?.0 as usize;
    let permit = if matches!(action, Action::Read) {
        None
    } else {
        Some(
            picker
                .0
                .clone()
                .try_acquire_owned()
                .map_err(|_| "文件夹或文件选择器已打开")?,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        match action {
            Action::Read => {}
            Action::Choose => {
                let Some(path) = choose(owner)? else {
                    return Ok(None);
                };
                save(&root, Some(&path))?;
            }
            Action::Restore => save(&root, None)?,
        }
        Ok(Some(resolve(read(&root))))
    })
    .await
    .map_err(|_| "本地终端设置任务已结束")?
}
