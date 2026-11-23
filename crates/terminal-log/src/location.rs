//! Service-owned settings and exact identity receipts for user-visible text logs.
use crate::{UserLogDirectory, storage};
use serde::{Deserialize, Serialize};
use session_core::session::{ConnectionRef, Protocol};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const NAME: &str = "readable-log-locations-v1.json";
const MAX: usize = 64;
const MAX_FILE: u64 = 1024 * 1024;
static GATE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub directory: Option<String>,
    pub filename: String,
    pub file_identity: [u8; 32],
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalogue {
    revision: Uuid,
    directory: Option<String>,
    entries: Vec<Location>,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid readable location catalogue",
    )
}
fn read(root: &Path) -> io::Result<Catalogue> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let path = root.join(NAME);
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Catalogue::default()),
        Err(error) => return Err(error),
    };
    let _ = crate::user_file::identity(&file)?;
    #[cfg(not(windows))]
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(invalid());
    }
    let result: Catalogue = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if result.entries.len() > MAX
        || result
            .entries
            .iter()
            .any(|entry| !crate::user_file::valid_filename(&entry.filename))
    {
        return Err(invalid());
    }
    Ok(result)
}

fn save(root: &Path, state: &Catalogue) -> io::Result<()> {
    let staged = root.join(format!(".readable-locations-{}.tmp", Uuid::new_v4()));
    let path = root.join(NAME);
    let mut file = storage::file(&staged)?;
    let result = (|| {
        serde_json::to_writer(&mut file, state).map_err(io::Error::other)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            };
            let wide = |p: &Path| {
                p.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            };
            if unsafe {
                MoveFileExW(
                    wide(&staged).as_ptr(),
                    wide(&path).as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            fs::rename(&staged, path)?;
            fs::File::open(root)?.sync_all()
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

pub fn setting(root: &Path) -> io::Result<(Uuid, Option<String>)> {
    let _guard = GATE.lock().map_err(|_| invalid())?;
    let _pins = storage::guards(root)?;
    let state = read(root)?;
    Ok((state.revision, state.directory))
}

pub fn set(
    root: &Path,
    revision: Uuid,
    directory: Option<String>,
) -> io::Result<Option<(Uuid, Option<String>)>> {
    let _guard = GATE.lock().map_err(|_| invalid())?;
    let _pins = storage::guards(root)?;
    let mut state = read(root)?;
    if state.revision != revision {
        return Ok(None);
    }
    let target = UserLogDirectory::resolve(root, directory.as_deref(), true)?;
    let probe = target
        .path()
        .join(format!(".terminal-write-check-{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options
            .share_mode(0)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&probe)?;
    let sync = file.sync_all();
    drop(file);
    #[cfg(not(windows))]
    fs::remove_file(probe)?;
    sync?;
    state.revision = Uuid::new_v4();
    state.directory = directory;
    save(root, &state)?;
    Ok(Some((state.revision, state.directory)))
}

pub fn lookup(
    root: &Path,
    log_id: Uuid,
    connection: ConnectionRef,
    protocol: Protocol,
) -> io::Result<Option<Location>> {
    let _guard = GATE.lock().map_err(|_| invalid())?;
    let _pins = storage::guards(root)?;
    Ok(read(root)?.entries.into_iter().find(|entry| {
        entry.log_id == log_id && entry.connection == connection && entry.protocol == protocol
    }))
}

pub(crate) fn register(root: &Path, location: Location) -> io::Result<()> {
    let _guard = GATE.lock().map_err(|_| invalid())?;
    let _pins = storage::guards(root)?;
    let mut state = read(root)?;
    prune(root, &mut state);
    if state.entries.len() >= MAX {
        return Err(full());
    }
    state.entries.push(location);
    save(root, &state)
}

fn full() -> io::Error {
    io::Error::new(io::ErrorKind::FileTooLarge, "readable catalogue full")
}
pub(crate) fn reserve(root: &Path) -> io::Result<()> {
    let _guard = GATE.lock().map_err(|_| invalid())?;
    let _pins = storage::guards(root)?;
    let mut state = read(root)?;
    prune(root, &mut state);
    if state.entries.len() >= MAX {
        return Err(full());
    }
    Ok(())
}

fn prune(root: &Path, state: &mut Catalogue) {
    if state.entries.len() >= MAX {
        // Inspect only registered paths. An inaccessible drive remains reserved.
        state.entries.retain(|entry| {
            let Ok(directory)=UserLogDirectory::resolve(root,entry.directory.as_deref(),false) else{return true;};
            !matches!(fs::symlink_metadata(directory.path().join(&entry.filename)),Err(err) if err.kind()==io::ErrorKind::NotFound)
        });
    }
}

pub fn effective(root: &Path, directory: Option<&str>) -> PathBuf {
    directory.map_or_else(|| root.join("logs"), PathBuf::from)
}
