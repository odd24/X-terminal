//! One-shot Windows fault for an explicitly owned service IPC test root.
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static FIRED: AtomicBool = AtomicBool::new(false);

pub fn validated_root(root: &Path) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("shared-terminal-log-disk-full-中文-"))
        .and_then(|id| Uuid::parse_str(id).ok());
    if root.parent() != Some(temp.as_path()) || id.is_none() {
        return Err(io::Error::other("invalid disk-full test root"));
    }
    Ok(root)
}

pub fn configure(root: &Path) -> io::Result<()> {
    ROOT.set(validated_root(root)?)
        .map_err(|_| io::Error::other("disk-full test already configured"))
}

pub(crate) fn before_raw_write(journal_directory: &Path) -> io::Result<()> {
    if let Some(root) = ROOT.get()
        && !FIRED.load(Ordering::Relaxed)
        && root.join("arm-disk-full").is_file()
        && journal_directory
            .parent()
            .and_then(Path::parent)
            .and_then(|data| data.canonicalize().ok())
            .as_ref()
            == Some(root)
        && !FIRED.swap(true, Ordering::Relaxed)
    {
        return Err(io::Error::from_raw_os_error(
            windows_sys::Win32::Foundation::ERROR_DISK_FULL as i32,
        ));
    }
    Ok(())
}
