use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// Controlled child of an existing service-owned data directory. Never accepts
/// names from IPC and never clears unrecognized or historical content.
pub struct ManagedRoot {
    _guards: Vec<File>,
    path: PathBuf,
}
impl ManagedRoot {
    pub fn open(data_directory: &Path) -> io::Result<Self> {
        let mut guards = crate::storage::guards(data_directory)?;
        let path = data_directory.join("terminal-logs");
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        guards.push(crate::storage::pin(&path)?);
        Ok(Self {
            _guards: guards,
            path,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    #[cfg(windows)]
    pub fn preview_cleanup(&self, id: Uuid) -> io::Result<crate::CleanupPreview> {
        crate::CleanupPreview::open(&self.path, crate::CleanupKind::Log, id)
    }
    pub fn ids(&self) -> io::Result<Vec<Uuid>> {
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.path)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| io::Error::other("invalid log entry"))?;
            let id = Uuid::parse_str(&name)
                .ok()
                .filter(|id| !id.is_nil() && id.to_string() == name)
                .ok_or_else(|| io::Error::other("unrecognized log entry"))?;
            let _guard = crate::storage::pin(&entry.path())?;
            result.push(id);
            if result.len() > 64 {
                return Err(io::Error::other("log catalogue exceeds limit"));
            }
        }
        result.sort_unstable();
        Ok(result)
    }
}
