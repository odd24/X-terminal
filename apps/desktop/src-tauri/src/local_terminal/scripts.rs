use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{State, WebviewWindow};
use uuid::Uuid;
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
    core::{HSTRING, w},
};
use windows_sys::Win32::Globalization::{GetACP, MB_ERR_INVALID_CHARS, MultiByteToWideChar};

pub struct Picker(pub Arc<tokio::sync::Semaphore>);
const PREVIEW_LIMIT: usize = 32 * 1024;
static PREVIEW_READER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const PREVIEW_ENCODING: &str = "无法识别脚本编码";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredScriptRequest {
    id: Uuid,
    revision: Uuid,
}

#[derive(Serialize)]
pub struct Preview {
    filename: String,
    text: String,
    encoding: String,
    truncated: bool,
}

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

fn decode_ansi(bytes: &[u8], code_page: u32) -> Option<String> {
    let len = i32::try_from(bytes.len()).ok()?;
    let size = unsafe {
        MultiByteToWideChar(
            code_page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            len,
            std::ptr::null_mut(),
            0,
        )
    };
    if size == 0 {
        return None;
    }
    let mut units = vec![0u16; size as usize];
    let decoded = unsafe {
        MultiByteToWideChar(
            code_page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            len,
            units.as_mut_ptr(),
            size,
        )
    };
    (decoded == size)
        .then(|| String::from_utf16(&units).ok())
        .flatten()
}

fn decode_preview(bytes: &[u8], truncated: bool) -> Result<(String, String), String> {
    if bytes.starts_with(&[0xff, 0xfe, 0, 0]) || bytes.starts_with(&[0, 0, 0xfe, 0xff]) {
        return Err(PREVIEW_ENCODING.into());
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let utf16 = &bytes[2..];
        if !truncated && utf16.len() % 2 != 0 {
            return Err(PREVIEW_ENCODING.into());
        }
        let little = bytes[0] == 0xff;
        let mut units: Vec<u16> = utf16
            .chunks_exact(2)
            .map(|chunk| {
                let pair = [chunk[0], chunk[1]];
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            })
            .collect();
        if truncated && matches!(units.last(), Some(0xd800..=0xdbff)) {
            units.pop();
        }
        let text = String::from_utf16(&units).map_err(|_| PREVIEW_ENCODING)?;
        return Ok((text, if little { "UTF-16 LE" } else { "UTF-16 BE" }.into()));
    }
    let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]);
    let utf8 = payload.unwrap_or(bytes);
    match std::str::from_utf8(utf8) {
        Ok(text) => return Ok((text.into(), "UTF-8".into())),
        Err(error) if truncated && error.error_len().is_none() => {
            let text =
                std::str::from_utf8(&utf8[..error.valid_up_to()]).map_err(|_| PREVIEW_ENCODING)?;
            return Ok((text.into(), "UTF-8".into()));
        }
        Err(_) if payload.is_some() => return Err(PREVIEW_ENCODING.into()),
        Err(_) => {}
    }
    let code_page = unsafe { GetACP() };
    let available = if truncated { bytes.len().min(3) } else { 0 };
    (0..=available)
        .find_map(|discard| decode_ansi(&bytes[..bytes.len() - discard], code_page))
        .map(|text| (text, format!("Windows CP{code_page}")))
        .ok_or_else(|| PREVIEW_ENCODING.into())
}

fn registered_script(root: &Path, request: &RegisteredScriptRequest) -> Result<String, String> {
    let settings = super::adb::read(root)?;
    if settings.revision != Some(request.revision) {
        return Err("快捷指令已更新，请重新选择".into());
    }
    settings
        .shortcuts
        .into_iter()
        .find(|item| item.id == request.id)
        .and_then(|item| item.script_path)
        .ok_or_else(|| "此入口不是已登记的本地脚本".into())
}

fn read_preview(root: &Path, request: &RegisteredScriptRequest) -> Result<Preview, String> {
    let path = registered_script(root, request)?;
    let (file, opened) = readable(&path)?;
    let mut bytes = Vec::with_capacity(PREVIEW_LIMIT + 1);
    file.take((PREVIEW_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取脚本预览")?;
    let truncated = bytes.len() > PREVIEW_LIMIT;
    bytes.truncate(PREVIEW_LIMIT);
    let (text, encoding) = decode_preview(&bytes, truncated)?;
    if text.contains('\0') {
        return Err(PREVIEW_ENCODING.into());
    }
    if registered_script(root, request)? != path {
        return Err("快捷指令已更新，请重新选择".into());
    }
    let filename = opened
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("脚本文件名不可用")?;
    Ok(Preview {
        filename: filename.into(),
        text,
        encoding,
        truncated,
    })
}

#[tauri::command]
pub async fn preview_local_script(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    request: RegisteredScriptRequest,
) -> Result<Preview, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("本地脚本仅在主窗口可预览".into());
    }
    let permit = PREVIEW_READER
        .try_acquire()
        .map_err(|_| "另一项脚本预览仍在读取")?;
    let root = desktop.2.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        read_preview(&root, &request)
    })
    .await
    .map_err(|_| "脚本预览已结束")?
}

fn select_in_explorer(path: &Path) -> windows::core::Result<()> {
    use windows::Win32::UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName};
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _apartment = Apartment;
        let mut item = std::ptr::null_mut();
        SHParseDisplayName(&HSTRING::from(path.as_os_str()), None, &mut item, 0, None)?;
        let result = SHOpenFolderAndSelectItems(item, None, 0);
        CoTaskMemFree(Some(item.cast()));
        result
    }
}

#[tauri::command]
pub async fn reveal_local_script(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    request: RegisteredScriptRequest,
) -> Result<(), String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("本地脚本位置仅在主窗口可打开".into());
    }
    let owner = window.hwnd().map_err(|_| "窗口不可用")?.0 as usize;
    let root = desktop.2.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let saved = registered_script(&root, &request)?;
        let (_file, opened) = readable(&saved)?;
        if registered_script(&root, &request)? != saved {
            return Err("快捷指令已更新，请重新选择".into());
        }
        if select_in_explorer(&opened).is_ok() {
            return Ok(());
        }
        let parent = opened.parent().ok_or("无法定位脚本所在目录")?;
        crate::export_save::open_directory(parent, owner)
            .map_err(|_| "无法打开脚本所在目录，请检查文件后重新定位".into())
    })
    .await
    .map_err(|_| "打开脚本位置的任务已结束")?
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
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
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
