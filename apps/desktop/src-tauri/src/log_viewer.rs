//! A native picker or a verified Windows registration sets the per-data-root viewer.
mod registered;
use credential_vault::{Secret, Vault};
use std::{
    fs::{File, OpenOptions},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
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
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

const STORE: &str = "desktop-log-viewer-v1.db";
const VIEWER: Uuid = Uuid::from_u128(0x6fbc6a89_df09_4239_b11f_3fb9ceeb5ce8);
const MAX_PATH_BYTES: usize = 16384;
const STORE_ERROR: &str = "LOG_VIEWER_STORAGE";
const PICKER_ERROR: &str = "LOG_VIEWER_PICKER";
const MISSING: &str = "LOG_VIEWER_MISSING";
const INVALID: &str = "LOG_VIEWER_INVALID";

pub(crate) struct Editor {
    permit: Arc<tokio::sync::Semaphore>,
    registered: Arc<Mutex<Vec<registered::Candidate>>>,
}

impl Editor {
    pub(crate) fn new() -> Self {
        Self {
            permit: Arc::new(tokio::sync::Semaphore::new(1)),
            registered: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct Selection {
    executable: Option<String>,
    available: bool,
}

#[derive(serde::Serialize)]
struct RegisteredViewer {
    id: Uuid,
    name: String,
}

#[derive(serde::Serialize)]
pub(crate) struct RegisteredViewers {
    candidates: Vec<RegisteredViewer>,
    selected_id: Option<Uuid>,
}

fn guard_directory(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| MISSING)?;
    let meta = file.metadata().map_err(|_| MISSING)?;
    if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(INVALID.into());
    }
    Ok(file)
}

fn directory_guards(path: &Path) -> Result<Vec<File>, String> {
    path.ancestors()
        .filter(|part| part.has_root())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(guard_directory)
        .collect()
}

pub(crate) fn with_native_settings<T>(
    root: &Path,
    name: &str,
    create: bool,
    use_store: impl FnOnce(Option<&mut Vault>) -> Result<T, String>,
) -> Result<T, String> {
    let _root = directory_guards(root).map_err(|_| STORE_ERROR)?;
    let path = root.join(name);
    let guard = match OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
    {
        Ok(file) => {
            let meta = file.metadata().map_err(|_| STORE_ERROR)?;
            if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(STORE_ERROR.into());
            }
            Some(file)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => None,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return use_store(None),
        Err(_) => return Err(STORE_ERROR.into()),
    };
    let mut vault = Vault::open(&path).map_err(|_| STORE_ERROR)?;
    let result = use_store(Some(&mut vault));
    drop(vault);
    drop(guard);
    result
}

fn with_store<T>(
    root: &Path,
    create: bool,
    use_store: impl FnOnce(Option<&mut Vault>) -> Result<T, String>,
) -> Result<T, String> {
    with_native_settings(root, STORE, create, use_store)
}

fn saved_path(root: &Path) -> Result<Option<String>, String> {
    with_store(root, false, |vault| {
        match vault.map(|vault| vault.get(VIEWER)) {
            None | Some(Err(credential_vault::Error::NotFound)) => Ok(None),
            Some(Ok(secret)) if secret.expose().len() <= MAX_PATH_BYTES => {
                String::from_utf8(secret.expose().to_vec())
                    .map(Some)
                    .map_err(|_| STORE_ERROR.into())
            }
            _ => Err(STORE_ERROR.into()),
        }
    })
}

fn executable(path: &Path) -> Result<(String, File, Vec<File>), String> {
    let (_, expanded) = crate::config_import::open_local_file(path, "exe").map_err(exe_error)?;
    let path = Path::new(&expanded);
    let guards = directory_guards(path.parent().ok_or(INVALID)?)?;
    // Recheck the selected image while both its directories and the image are pinned.
    let (file, checked) = crate::config_import::open_local_file(path, "exe").map_err(exe_error)?;
    if expanded.len() > MAX_PATH_BYTES || checked != expanded {
        return Err(INVALID.into());
    }
    Ok((expanded, file, guards))
}

fn exe_error(code: String) -> String {
    if code == "IMPORT_FILE_UNAVAILABLE" {
        MISSING
    } else {
        INVALID
    }
    .into()
}

fn selection(root: &Path) -> Result<Selection, String> {
    let executable_path = saved_path(root)?;
    let available = executable_path
        .as_deref()
        .is_none_or(|path| executable(Path::new(path)).is_ok());
    Ok(Selection {
        executable: executable_path,
        available,
    })
}

fn select_path(root: &Path, path: &Path) -> Result<Selection, String> {
    let (path, _image, _guards) = executable(path)?;
    let secret = Secret::new(path.as_bytes().to_vec()).map_err(|_| STORE_ERROR)?;
    with_store(root, true, |vault| {
        vault
            .ok_or(STORE_ERROR)?
            .set(VIEWER, secret)
            .map_err(|_| STORE_ERROR.into())
    })?;
    Ok(Selection {
        executable: Some(path),
        available: true,
    })
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

fn pick(owner: usize) -> Result<Option<PathBuf>, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| PICKER_ERROR)?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| PICKER_ERROR)?;
        let options = dialog.GetOptions().map_err(|_| PICKER_ERROR)?
            | FOS_FORCEFILESYSTEM
            | FOS_FILEMUSTEXIST
            | FOS_PATHMUSTEXIST
            | FOS_NOCHANGEDIR
            | FOS_DONTADDTORECENT;
        dialog
            .SetOptions(options & !FOS_ALLOWMULTISELECT)
            .map_err(|_| PICKER_ERROR)?;
        dialog
            .SetTitle(w!("选择日志打开程序"))
            .map_err(|_| PICKER_ERROR)?;
        dialog
            .SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("Windows 程序 (*.exe)"),
                pszSpec: w!("*.exe"),
            }])
            .map_err(|_| PICKER_ERROR)?;
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(PICKER_ERROR.into());
        }
        let name = dialog
            .GetResult()
            .and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH))
            .map_err(|_| PICKER_ERROR)?;
        let path = name.to_string();
        CoTaskMemFree(Some(name.0.cast()));
        Ok(Some(PathBuf::from(path.map_err(|_| INVALID)?)))
    }
}

fn main_settings(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == crate::session_windows::MAIN)
        .then_some(())
        .ok_or_else(|| "LOG_VIEWER_MAIN_REQUIRED".into())
}

#[tauri::command]
pub(crate) async fn log_viewer_settings(
    window: tauri::WebviewWindow,
    desktop: tauri::State<'_, crate::Desktop>,
) -> Result<Selection, String> {
    main_settings(&window)?;
    let root = desktop.2.clone();
    tokio::task::spawn_blocking(move || selection(&root))
        .await
        .map_err(|_| STORE_ERROR)?
}

#[tauri::command]
pub(crate) async fn registered_log_viewers(
    window: tauri::WebviewWindow,
    desktop: tauri::State<'_, crate::Desktop>,
    editor: tauri::State<'_, Editor>,
) -> Result<RegisteredViewers, String> {
    main_settings(&window)?;
    let permit = editor
        .permit
        .clone()
        .try_acquire_owned()
        .map_err(|_| "LOG_VIEWER_BUSY")?;
    let root = desktop.2.clone();
    let registry = editor.registered.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut remembered = registry.lock().map_err(|_| registered::UNAVAILABLE)?;
        remembered.clear();
        let native = registered::discover()?;
        let selected = saved_path(&root)?;
        let selected_id = selected.and_then(|path| {
            native
                .iter()
                .find(|entry| entry.path.eq_ignore_ascii_case(&path))
                .map(|entry| entry.id)
        });
        let candidates = native
            .iter()
            .map(|entry| RegisteredViewer {
                id: entry.id,
                name: entry.label.clone(),
            })
            .collect();
        *remembered = native;
        Ok(RegisteredViewers {
            candidates,
            selected_id,
        })
    })
    .await
    .map_err(|_| registered::UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn select_registered_log_viewer(
    window: tauri::WebviewWindow,
    desktop: tauri::State<'_, crate::Desktop>,
    editor: tauri::State<'_, Editor>,
    id: Uuid,
) -> Result<Selection, String> {
    main_settings(&window)?;
    let permit = editor
        .permit
        .clone()
        .try_acquire_owned()
        .map_err(|_| "LOG_VIEWER_BUSY")?;
    let path = editor
        .registered
        .lock()
        .map_err(|_| registered::UNAVAILABLE)?
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.path.clone())
        .ok_or("LOG_VIEWER_CANDIDATE_CHANGED")?;
    let root = desktop.2.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // Recheck the current registrations and pinned executable before persisting.
        if !registered::discover()?
            .iter()
            .any(|entry| entry.path.eq_ignore_ascii_case(&path))
        {
            return Err("LOG_VIEWER_CANDIDATE_CHANGED".into());
        }
        select_path(&root, Path::new(&path))
    })
    .await
    .map_err(|_| registered::UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn choose_log_viewer(
    window: tauri::WebviewWindow,
    desktop: tauri::State<'_, crate::Desktop>,
    editor: tauri::State<'_, Editor>,
) -> Result<Option<Selection>, String> {
    main_settings(&window)?;
    let permit = editor
        .permit
        .clone()
        .try_acquire_owned()
        .map_err(|_| "LOG_VIEWER_BUSY")?;
    let owner = window.hwnd().map_err(|_| PICKER_ERROR)?.0 as usize;
    let root = desktop.2.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let Some(path) = pick(owner)? else {
            return Ok(None);
        };
        select_path(&root, &path).map(Some)
    })
    .await
    .map_err(|_| PICKER_ERROR)?
}

#[tauri::command]
pub(crate) async fn reset_log_viewer(
    window: tauri::WebviewWindow,
    desktop: tauri::State<'_, crate::Desktop>,
    editor: tauri::State<'_, Editor>,
) -> Result<Selection, String> {
    main_settings(&window)?;
    let permit = editor
        .permit
        .clone()
        .try_acquire_owned()
        .map_err(|_| "LOG_VIEWER_BUSY")?;
    let root = desktop.2.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        with_store(&root, false, |vault| {
            if let Some(vault) = vault {
                vault.delete(VIEWER).map_err(|_| STORE_ERROR)?;
            }
            Ok(())
        })?;
        Ok(Selection {
            executable: None,
            available: true,
        })
    })
    .await
    .map_err(|_| STORE_ERROR)?
}

pub(crate) fn open(root: &Path, log: &Path) -> Result<(), String> {
    let Some(path) = saved_path(root)? else {
        return crate::export_save::open_with_system_default(log);
    };
    let (application, _image, _guards) = executable(Path::new(&path))?;
    spawn_viewer(Path::new(&application), log).map_err(|_| "LOG_VIEWER_LAUNCH".into())
}

pub(crate) fn open_notepad(log: &Path) -> Result<(), String> {
    let system = std::env::var_os("SystemRoot").ok_or("LOG_VIEWER_SYSTEM_FAILED")?;
    let application = PathBuf::from(system).join("System32").join("notepad.exe");
    spawn_viewer(&application, log).map_err(|_| "LOG_VIEWER_SYSTEM_FAILED".into())
}

fn spawn_viewer(application: &Path, log: &Path) -> std::io::Result<()> {
    Command::new(application)
        .arg(log)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}
