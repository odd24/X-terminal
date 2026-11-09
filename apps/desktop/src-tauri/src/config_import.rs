use serde::Deserialize;
use std::{
    fs::OpenOptions,
    io::Read,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
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
    core::w,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, GetDriveTypeW, GetFinalPathNameByHandleW,
    GetLongPathNameW,
};

use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};
#[derive(Default)]
pub(crate) struct Manager {
    busy: Arc<AtomicBool>,
    seen: Mutex<Vec<(Uuid, Instant)>>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_import_read_is_local_regular_frozen_and_bounded() {
        let directory = std::env::temp_dir().join(format!(
            "shared-terminal-native-import-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        {
            let path = directory.join("合成.json");
            std::fs::write(&path, b"{}").unwrap();
            assert_eq!(
                read_selected(&path).unwrap_or_else(|e| panic!(
                    "{e}; self-created path={path:?}; canonical={:?}; attrs={:?}",
                    std::fs::canonicalize(&path),
                    path.ancestors()
                        .map(|p| (p, std::fs::symlink_metadata(p).map(|m| m.file_attributes())))
                        .collect::<Vec<_>>()
                )),
                "{}"
            );
            let writer = OpenOptions::new().write(true).open(&path).unwrap();
            assert!(read_selected(&path).is_err());
            drop(writer);
            std::fs::write(&path, vec![b' '; 65537]).unwrap();
            assert_eq!(read_selected(&path).unwrap_err(), "IMPORT_CAPACITY");
            std::fs::write(&path, [0xff]).unwrap();
            assert_eq!(read_selected(&path).unwrap_err(), "IMPORT_ENCODING");
            std::fs::write(&path, b"{}").unwrap();
            use std::os::windows::process::CommandExt;
            let real = directory.join("real");
            std::fs::create_dir(&real).unwrap();
            std::fs::write(real.join("nested.json"), b"{}").unwrap();
            for (name, suffix) in [("alias", Some("nested.json")), ("link.json", None)] {
                let link = directory.join(name);
                assert!(link.starts_with(&directory) && real.starts_with(&directory));
                let result = std::process::Command::new("cmd.exe")
                    .creation_flags(0x08000000)
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(&real)
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "self-owned junction fixture must be created"
                );
                let selected = suffix.map_or(link.clone(), |name| link.join(name));
                assert_eq!(
                    read_selected(&selected).unwrap_err(),
                    "IMPORT_PATH_REJECTED"
                );
            }
            for path in [
                "relative.json",
                "\\\\server\\share\\a.json",
                "C:\\CON.json",
                "C:\\a.json:stream",
                "C:\\a\\..\\b.json",
            ] {
                assert_eq!(
                    read_selected(Path::new(path)).unwrap_err(),
                    "IMPORT_PATH_REJECTED"
                );
            }
        }
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
struct Busy(Arc<AtomicBool>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Choose {
        id: Uuid,
        service_id: Uuid,
        revision: Uuid,
        policy: config_model::ImportPolicy,
    },
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
fn choose(owner: usize) -> Result<Option<PathBuf>, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?;
        dialog
            .SetOptions(
                (dialog
                    .GetOptions()
                    .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?
                    | FOS_FORCEFILESYSTEM
                    | FOS_FILEMUSTEXIST
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT)
                    & !FOS_ALLOWMULTISELECT,
            )
            .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?;
        dialog
            .SetTitle(w!("选择原生连接配置 JSON"))
            .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?;
        dialog
            .SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("连接配置 JSON (*.json)"),
                pszSpec: w!("*.json"),
            }])
            .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?;
        if let Err(e) = dialog.Show(Some(HWND(owner as *mut _))) {
            if e.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err("IMPORT_PICKER_UNAVAILABLE".into());
        }
        let name = dialog
            .GetResult()
            .and_then(|f| f.GetDisplayName(SIGDN_FILESYSPATH))
            .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")?;
        let value = name.to_string();
        CoTaskMemFree(Some(name.0.cast()));
        Ok(Some(PathBuf::from(
            value.map_err(|_| "IMPORT_PATH_REJECTED")?,
        )))
    }
}
fn expanded_name(path: &str) -> Result<String, String> {
    let input: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 32768];
    let len = unsafe { GetLongPathNameW(input.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) }
        as usize;
    if len == 0 || len >= buffer.len() {
        return Err("IMPORT_PATH_REJECTED".into());
    }
    String::from_utf16(&buffer[..len]).map_err(|_| "IMPORT_PATH_REJECTED".into())
}
fn final_matches(file: &std::fs::File, path: &str) -> bool {
    let mut buffer = vec![0u16; 32768];
    let len = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    len > 0
        && len < buffer.len()
        && String::from_utf16(&buffer[..len]).is_ok_and(|final_path| {
            final_path
                .strip_prefix("\\\\?\\")
                .is_some_and(|final_path| final_path.eq_ignore_ascii_case(path))
        })
}
fn read_selected(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("IMPORT_PATH_REJECTED")?;
    let b = text.as_bytes();
    if b.len() < 4
        || !b[0].is_ascii_alphabetic()
        || b[1] != b':'
        || b[2] != b'\\'
        || text[2..].contains(':')
        || text.contains('/')
        || text.chars().any(char::is_control)
        || !path
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("json"))
    {
        return Err("IMPORT_PATH_REJECTED".into());
    }
    let root: Vec<u16> = format!("{}:\\", b[0] as char)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    if !matches!(
        unsafe { GetDriveTypeW(root.as_ptr()) },
        DRIVE_FIXED | DRIVE_REMOVABLE
    ) {
        return Err("IMPORT_PATH_REJECTED".into());
    }
    for component in text[3..].split('\\') {
        let stem = component
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if component.is_empty()
            || component.ends_with(['.', ' '])
            || component.contains(['*', '?', '<', '>', '|', '"'])
            || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && (stem[3..].parse::<u8>().is_ok_and(|n| (1..=9).contains(&n))
                    || ["¹", "²", "³"].contains(&&stem[3..])))
        {
            return Err("IMPORT_PATH_REJECTED".into());
        }
    }
    for ancestor in path.ancestors() {
        let metadata =
            std::fs::symlink_metadata(ancestor).map_err(|_| "IMPORT_FILE_UNAVAILABLE")?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("IMPORT_PATH_REJECTED".into());
        }
    }
    let expected = expanded_name(text)?;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "IMPORT_FILE_UNAVAILABLE")?;
    let metadata = file.metadata().map_err(|_| "IMPORT_FILE_UNAVAILABLE")?;
    if !metadata.is_file()
        || metadata.file_attributes() & 0x400 != 0
        || !final_matches(&file, &expected)
    {
        return Err("IMPORT_PATH_REJECTED".into());
    }
    if metadata.len() > 65536 {
        return Err("IMPORT_CAPACITY".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "IMPORT_FILE_UNAVAILABLE")?;
    if bytes.len() > 65536 {
        return Err("IMPORT_CAPACITY".into());
    }
    if bytes.len() as u64 != metadata.len() || !final_matches(&file, &expected) {
        return Err("IMPORT_FILE_CHANGED".into());
    }
    String::from_utf8(bytes).map_err(|_| "IMPORT_ENCODING".into())
}
async fn same_service(state: &crate::Desktop, id: Uuid) -> Result<(), String> {
    let mut service = state.0.lock().await;
    let service = service.as_mut().map_err(|e| e.clone())?;
    if service.status().await?.service_id != id {
        return Err("IMPORT_SERVICE_CHANGED".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn select_config_import(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::Desktop>,
    manager: tauri::State<'_, Manager>,
    request: Request,
) -> Result<Option<session_protocol::config::ImportReceipt>, String> {
    let Request::Choose {
        id,
        service_id,
        revision,
        policy,
    } = request;
    if id.is_nil() || service_id.is_nil() || revision.is_nil() {
        return Err("IMPORT_INVALID_REQUEST".into());
    }
    same_service(state.inner(), service_id).await?;
    if manager.busy.swap(true, Ordering::AcqRel) {
        return Err("IMPORT_PICKER_BUSY".into());
    }
    let busy = Busy(manager.busy.clone());
    {
        let mut seen = manager.seen.lock().map_err(|_| "IMPORT_INVALID_REQUEST")?;
        seen.retain(|(_, created)| created.elapsed() < Duration::from_secs(600));
        if seen.iter().any(|(old, _)| *old == id) {
            return Err("IMPORT_QUERY_ORIGINAL".into());
        }
        if seen.len() >= 64 {
            return Err("IMPORT_CAPACITY".into());
        }
        seen.push((id, Instant::now()));
    }
    let owner = window.hwnd().map_err(|_| "WINDOW_UNAVAILABLE")?.0 as usize;
    let document = tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        choose(owner)?.map(|path| read_selected(&path)).transpose()
    })
    .await
    .map_err(|_| "IMPORT_PICKER_UNAVAILABLE")??;
    let Some(document) = document else {
        return Ok(None);
    };
    same_service(state.inner(), service_id).await?;
    use session_protocol::config::{ConfigReply as C, ConfigRequest as Q};
    match crate::forward_config(
        state.inner(),
        Q::PreviewImport {
            id,
            revision,
            policy,
            document: session_protocol::Sensitive::new(document),
        },
    )
    .await?
    {
        C::Import { receipt } => Ok(Some(receipt)),
        C::Error { code } => Err(format!("IMPORT_CONFIG_{code:?}")),
        _ => Err("IMPORT_INVALID_REPLY".into()),
    }
}
