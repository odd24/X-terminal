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
}
pub struct UserLogFile {
    _directory: UserLogDirectory,
    _file: File,
    path: PathBuf,
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
    /// Filename comes only from the authenticated service capture receipt.
    /// The logger retains its creator handle; reads cannot substitute a writer.
    pub fn open(
        data: &Path,
        filename: &str,
        connection: ConnectionRef,
        log_id: Uuid,
    ) -> io::Result<Self> {
        if filename.len() > 1024
            || filename.encode_utf16().count() > 255
            || !filename.ends_with(".log")
            || filename.contains(['/', '\\', ':', '\0'])
            || Path::new(filename).components().count() != 1
            || filename.starts_with('.')
            || log_id.is_nil()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid readable source",
            ));
        }
        let directory = UserLogDirectory::open(data)?;
        let path = directory.path.join(filename);
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(3).custom_flags(0x00200000);
        }
        let mut file = options.open(&path)?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() > crate::live_text::MAX_LIVE_BYTES {
            return Err(io::Error::other("invalid readable file"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
            };
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if meta.file_attributes() & 0x400 != 0
                || unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
                || info.nNumberOfLinks != 1
            {
                return Err(io::Error::other("readable file changed"));
            }
        }
        #[cfg(not(windows))]
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(io::Error::other("readable symlink"));
        }
        let header = format!(
            "# 终端通信日志 UTF-8\r\n# 日志 {log_id}；连接 {} / {}\r\n",
            connection.connection_id.0, connection.generation
        );
        let mut bytes = vec![0; header.len()];
        file.read_exact(&mut bytes)?;
        if bytes != header.as_bytes() {
            return Err(io::Error::other("readable identity mismatch"));
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
    pub bytes: u64,
    pub flushed_records: u64,
    pub synced_records: u64,
    pub flushed_at_ms: u64,
    pub source_gap_bytes: u64,
    pub rejected_records: u64,
    pub active: bool,
    pub failed: bool,
}
