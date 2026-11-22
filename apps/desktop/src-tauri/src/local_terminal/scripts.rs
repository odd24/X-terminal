use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{State, WebviewWindow};
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FOS_ALLOWMULTISELECT, FOS_DONTADDTORECENT,
            FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
            FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH,
        },
    },
    core::w,
};

pub struct Picker(pub Arc<tokio::sync::Semaphore>);

pub fn valid_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 7
        && bytes.len() <= 2048
        && bytes[0].is_ascii_alphabetic()
        && &bytes[1..3] == b":\\"
        && !text[3..].contains([':', '/', '"'])
        && !text.chars().any(char::is_control)
        && Path::new(text)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("cmd"))
}

pub fn readable(text: &str) -> Result<(std::fs::File, PathBuf), String> {
    if !valid_path(text) {
        return Err("请选择本机 .bat 或 .cmd 脚本".into());
    }
    let path = Path::new(text);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap();
    crate::config_import::open_local_file(path, extension)
        .map(|(file, path)| (file, PathBuf::from(path)))
        .map_err(|_| "脚本不可用，请从管理菜单重新定位".into())
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Serialize)]
pub struct Selection {
    pub path: String,
    pub name: String,
}

fn pick(owner: usize, multiple: bool) -> Result<Vec<Selection>, String> {
    unsafe {
        let unavailable = |_| "无法打开本地脚本选择器".to_string();
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(unavailable)?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(unavailable)?;
        let mut options = dialog.GetOptions().map_err(unavailable)?
            | FOS_FORCEFILESYSTEM
            | FOS_FILEMUSTEXIST
            | FOS_PATHMUSTEXIST
            | FOS_NOCHANGEDIR
            | FOS_DONTADDTORECENT;
        if multiple {
            options |= FOS_ALLOWMULTISELECT;
        } else {
            options &= !FOS_ALLOWMULTISELECT;
        }
        dialog.SetOptions(options).map_err(unavailable)?;
        dialog.SetTitle(w!("选择本地脚本")).map_err(unavailable)?;
        dialog
            .SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("批处理脚本 (*.bat; *.cmd)"),
                pszSpec: w!("*.bat;*.cmd"),
            }])
            .map_err(unavailable)?;
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(Vec::new());
            }
            return Err(unavailable(error));
        }
        let items = dialog.GetResults().map_err(unavailable)?;
        let count = items.GetCount().map_err(unavailable)?;
        if count > 32 || (!multiple && count > 1) {
            return Err("本次选择的脚本过多".into());
        }
        (0..count)
            .map(|index| {
                let raw = items
                    .GetItemAt(index)
                    .and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH))
                    .map_err(unavailable)?;
                let path = raw.to_string();
                CoTaskMemFree(Some(raw.0.cast()));
                let (_, path) = readable(&path.map_err(|_| "脚本路径编码无效")?)?;
                let name = path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .chars()
                    .take(64)
                    .collect();
                Ok(Selection {
                    path: path.to_string_lossy().into_owned(),
                    name,
                })
            })
            .collect()
    }
}

#[tauri::command]
pub async fn pick_local_scripts(
    window: WebviewWindow,
    picker: State<'_, Picker>,
    multiple: bool,
) -> Result<Vec<Selection>, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("本地脚本仅在主窗口可用".into());
    }
    let permit = picker
        .0
        .clone()
        .try_acquire_owned()
        .map_err(|_| "脚本选择器已打开")?;
    let owner = window.hwnd().map_err(|_| "窗口不可用")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        pick(owner, multiple)
    })
    .await
    .map_err(|_| "脚本选择器已关闭")?
}
