//! Read-only native shell sources; never accept a renderer path or URI.
use crate::storage;
use session_core::session::ConnectionRef;
use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};
use uuid::Uuid;
pub struct UserLogDirectory {
    _guards: Vec<File>,
    path: PathBuf,
}
impl UserLogDirectory {
    pub fn ensure(data: &Path) -> io::Result<Self> {
        let _guards = storage::guards(data)?;
        match std::fs::create_dir(data.join("logs")) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        Self::open(data)
    }

    pub fn open(data: &Path) -> io::Result<Self> {
        let mut guards = storage::guards(data)?;
        let path = data.join("logs");
        guards.push(storage::pin(&path)?);
        Ok(Self {
            _guards: guards,
            path,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn resolve(data: &Path, custom: Option<&str>, create_default: bool) -> io::Result<Self> {
        let Some(custom) = custom else {
            return if create_default {
                Self::ensure(data)
            } else {
                Self::open(data)
            };
        };
        let path = PathBuf::from(custom);
        let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "invalid log directory");
        if custom.is_empty()
            || custom.len() > 8192
            || custom.chars().any(char::is_control)
            || !path.is_absolute()
        {
            return Err(invalid());
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
            use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};
            let raw = custom.as_bytes();
            if raw.len()<3||!raw[0].is_ascii_alphabetic()||&raw[1..3]!=b":\\"||
              custom[3..].contains([':', '/', '<', '>', '|', '*', '?','"'])||path.components().skip(2).any(|p|!matches!(p,std::path::Component::Normal(x) if !x.to_string_lossy().ends_with(['.',' ']))){
                return Err(invalid());
            }
            let drive: Vec<_> = custom[..3].encode_utf16().chain(Some(0)).collect();
            if !matches!(
                unsafe { GetDriveTypeW(drive.as_ptr()) },
                DRIVE_FIXED | DRIVE_REMOVABLE
            ) {
                return Err(invalid());
            }
        }
        let guards = storage::guards(&path)?;
        let normalized = std::fs::canonicalize(&path)?;
        let data_normalized = std::fs::canonicalize(data)?;
        let canon = |p: &Path| {
            if cfg!(windows) {
                p.to_string_lossy().to_lowercase()
            } else {
                p.to_string_lossy().into_owned()
            }
        };
        if Path::new(&canon(&normalized)).starts_with(canon(&data_normalized))
            && canon(&normalized) != canon(&data_normalized.join("logs"))
        {
            return Err(invalid());
        }
        Ok(Self {
            _guards: guards,
            path,
        })
    }
}
pub struct UserLogFile {
    _directory: UserLogDirectory,
    _file: File,
    path: PathBuf,
}
pub(crate) fn valid_filename(filename: &str) -> bool {
    filename.len() <= 1024
        && filename.encode_utf16().count() <= 255
        && filename.ends_with(".log")
        && !filename.contains(['/', '\\', ':', '\0'])
        && Path::new(filename).components().count() == 1
        && !filename.starts_with('.')
        && !filename.chars().any(char::is_control)
}

pub(crate) fn identity(file: &File) -> io::Result<[u8; 32]> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("readable target is not a regular file"));
    }
    let mut identity = [0; 32];
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO, FileIdInfo,
            GetFileInformationByHandle, GetFileInformationByHandleEx,
        };
        let handle = file.as_raw_handle();
        let mut legacy = BY_HANDLE_FILE_INFORMATION::default();
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || unsafe { GetFileInformationByHandle(handle, &mut legacy) } == 0
            || legacy.nNumberOfLinks != 1
        {
            return Err(io::Error::other("invalid readable file"));
        }
        let mut full = FILE_ID_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut full as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0
        {
            identity[..8].copy_from_slice(&full.VolumeSerialNumber.to_le_bytes());
            identity[8..24].copy_from_slice(&full.FileId.Identifier);
        } else {
            identity[..8].copy_from_slice(&u64::from(legacy.dwVolumeSerialNumber).to_le_bytes());
            let index = (u64::from(legacy.nFileIndexHigh) << 32) | u64::from(legacy.nFileIndexLow);
            identity[8..16].copy_from_slice(&index.to_le_bytes());
        }
        if identity[8..24].iter().all(|byte| *byte == 0) {
            return Err(io::Error::other("unavailable readable file identity"));
        }
        identity[24..].copy_from_slice(&meta.creation_time().to_le_bytes());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(io::Error::other("invalid readable file"));
        }
        identity[..8].copy_from_slice(&meta.dev().to_le_bytes());
        identity[8..16].copy_from_slice(&meta.ino().to_le_bytes());
    }
    Ok(identity)
}

impl UserLogFile {
    /// Copy a fixed, whole-record flushed prefix while a live writer may append.
    pub fn copy_prefix(
        &mut self,
        bytes: u64,
        output: &mut impl std::io::Write,
        mut cancel: impl FnMut() -> bool,
    ) -> io::Result<()> {
        use std::io::Seek;
        if bytes == 0
            || bytes > crate::live_text::MAX_LIVE_BYTES
            || bytes > self._file.metadata()?.len()
        {
            return Err(io::Error::other("unavailable readable prefix"));
        }
        self._file.rewind()?;
        let mut left = bytes;
        let mut buffer = [0; 32 * 1024];
        while left > 0 {
            if cancel() {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let length = (left as usize).min(buffer.len());
            let count = self._file.read(&mut buffer[..length])?;
            if count == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            output.write_all(&buffer[..count])?;
            left -= count as u64;
        }
        Ok(())
    }
    /// Reacquire the original file under short-lived path and file pins.
    /// Both the filename and creator identity come from the service capture receipt.
    pub fn open(
        data: &Path,
        filename: &str,
        connection: ConnectionRef,
        log_id: Uuid,
        file_identity: [u8; 32],
        writer_may_be_open: bool,
    ) -> io::Result<Self> {
        Self::open_at(
            data,
            None,
            filename,
            connection,
            log_id,
            file_identity,
            writer_may_be_open,
        )
    }
    pub fn open_at(
        data: &Path,
        custom: Option<&str>,
        filename: &str,
        connection: ConnectionRef,
        log_id: Uuid,
        file_identity: [u8; 32],
        writer_may_be_open: bool,
    ) -> io::Result<Self> {
        if !valid_filename(filename) || log_id.is_nil() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid readable source",
            ));
        }
        let directory = UserLogDirectory::resolve(data, custom, false)?;
        let path = directory.path.join(filename);
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
            };
            let share = FILE_SHARE_READ
                | if writer_may_be_open {
                    FILE_SHARE_WRITE
                } else {
                    0
                };
            options
                .share_mode(share)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        #[cfg(not(windows))]
        let _ = writer_may_be_open;
        let mut file = options.open(&path)?;
        if file.metadata()?.len() > crate::live_text::MAX_LIVE_BYTES {
            return Err(io::Error::other("invalid readable file"));
        }
        #[cfg(not(windows))]
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(io::Error::other("readable symlink"));
        }
        if identity(&file)? != file_identity {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "readable file changed",
            ));
        }
        let header = format!(
            "# 终端通信日志 UTF-8\r\n# 日志 {log_id}；连接 {} / {}\r\n",
            connection.connection_id.0, connection.generation
        );
        let mut bytes = vec![0; header.len()];
        file.read_exact(&mut bytes)?;
        if bytes != header.as_bytes() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "readable header mismatch",
            ));
        }
        Ok(Self {
            _directory: directory,
            _file: file,
            path,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Clone, serde::Serialize)]
pub struct ReadableSnapshot {
    pub log_id: Uuid,
    pub connection: ConnectionRef,
    pub filename: String,
    #[serde(skip_serializing)]
    pub directory: Option<String>,
    #[serde(skip_serializing)]
    pub file_identity: [u8; 32],
    #[serde(skip_serializing)]
    pub writer_may_be_open: bool,
    pub bytes: u64,
    pub flushed_records: u64,
    pub synced_records: u64,
    pub flushed_at_ms: u64,
    pub source_gap_bytes: u64,
    pub rejected_records: u64,
    pub active: bool,
    pub failed: bool,
}
