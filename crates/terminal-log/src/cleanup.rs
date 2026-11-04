//! Windows-only, explicit cleanup of a frozen, bounded allowlist. Opening and
//! dropping a preview never deletes. No recursive deletion or caller file names.
use crate::storage;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CleanupKind {
    Log,
    Export,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupFile {
    pub name: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupInfo {
    pub kind: CleanupKind,
    pub id: Uuid,
    pub files: Vec<CleanupFile>,
    /// Logical sizes of names in this preview, never a promise of freed disk
    /// allocation (e.g. hard links, compression, filesystem deferred deletion).
    pub logical_bytes: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CleanupFailure {
    Changed,
    Storage,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupReport {
    pub kind: CleanupKind,
    pub id: Uuid,
    pub removed_files: u32,
    pub removed_logical_bytes: u64,
    pub directory_removed: bool,
    pub failure: Option<CleanupFailure>,
    pub os_code: Option<i32>,
}
pub struct CleanupPreview {
    _guards: Vec<File>,
    directory: File,
    path: PathBuf,
    files: Vec<File>,
    info: CleanupInfo,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "unrecognized cleanup content")
}
fn allowed(kind: CleanupKind, name: &str) -> bool {
    match kind {
        CleanupKind::Export => matches!(name, "export.jsonl" | "export.partial"),
        CleanupKind::Log => {
            if matches!(name, "completion.json" | "completion.partial") {
                return true;
            }
            for suffix in [".rawlog", ".text.jsonl"] {
                if let Some(number) = name
                    .strip_suffix(suffix)
                    .and_then(|s| s.parse::<u64>().ok())
                    && number > 0
                    && format!("{number:016}{suffix}") == name
                {
                    return true;
                }
            }
            false
        }
    }
}
fn names(path: &Path, kind: CleanupKind) -> io::Result<Vec<String>> {
    let limit = match kind {
        CleanupKind::Log => 34,
        CleanupKind::Export => 2,
    };
    let mut result = Vec::new();
    for entry in fs::read_dir(path)? {
        let name = entry?.file_name().into_string().map_err(|_| invalid())?;
        if !allowed(kind, &name) || result.len() >= limit {
            return Err(invalid());
        }
        result.push(name);
    }
    result.sort_unstable();
    Ok(result)
}
fn exclusive(path: &Path, directory: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    // DELETE access with no delete-sharing rejects any existing journal/reader
    // pin. It also prevents later normal pins while this preview is alive.
    options.access_mode(
        DELETE | FILE_READ_ATTRIBUTES | if directory { FILE_LIST_DIRECTORY } else { 0 },
    );
    options.share_mode(if directory {
        FILE_SHARE_READ | FILE_SHARE_WRITE
    } else {
        0
    });
    options.custom_flags(
        FILE_FLAG_OPEN_REPARSE_POINT
            | if directory {
                FILE_FLAG_BACKUP_SEMANTICS
            } else {
                0
            },
    );
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || if directory {
            !meta.is_dir()
        } else {
            !meta.is_file()
        }
    {
        return Err(invalid());
    }
    if !directory && meta.file_attributes() & FILE_ATTRIBUTE_READONLY != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "read-only cleanup file",
        ));
    }
    Ok(file)
}
fn discard(file: &File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // Mark the exact opened object, never re-resolve a potentially changed path.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of_val(&disposition) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
impl CleanupPreview {
    pub(crate) fn open(root: &Path, kind: CleanupKind, id: Uuid) -> io::Result<Self> {
        if id.is_nil() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid cleanup id",
            ));
        }
        let guards = storage::guards(root)?;
        let path = root.join(id.to_string());
        if path.parent() != Some(root) {
            return Err(invalid());
        }
        let directory = exclusive(&path, true)?;
        let listed = names(&path, kind)?;
        let mut files = Vec::new();
        let mut info = CleanupInfo {
            kind,
            id,
            files: Vec::new(),
            logical_bytes: 0,
        };
        for name in listed {
            let file = exclusive(&path.join(&name), false)?;
            let bytes = file.metadata()?.len();
            // Cleanup previews metadata, not journal contents. Known file names
            // can be malformed/oversized and still need explicit cleanup; never
            // allocate or read their contents, nor call them valid logs.
            info.logical_bytes = info.logical_bytes.checked_add(bytes).ok_or_else(invalid)?;
            info.files.push(CleanupFile { name, bytes });
            files.push(file);
        }
        Ok(Self {
            _guards: guards,
            directory,
            path,
            files,
            info,
        })
    }
    pub fn info(&self) -> &CleanupInfo {
        &self.info
    }

    /// Consumes this preview exactly once. Dropping/expiring a preview does not
    /// delete. Call only after a trusted, explicit confirmation of its full info.
    /// A partial failure is irreversible: report counts and require a new preview
    /// rather than pretending atomic rollback or retrying the original request.
    pub fn apply(self) -> CleanupReport {
        self.apply_with(discard)
    }
    fn apply_with(self, mut remove: impl FnMut(&File) -> io::Result<()>) -> CleanupReport {
        let mut report = CleanupReport {
            kind: self.info.kind,
            id: self.info.id,
            removed_files: 0,
            removed_logical_bytes: 0,
            directory_removed: false,
            failure: None,
            os_code: None,
        };
        let expected: Vec<_> = self.info.files.iter().map(|f| f.name.clone()).collect();
        // External same-user processes can still add names. Never touch extras;
        // catch pre-commit changes before deleting any of the approved files.
        match names(&self.path, self.info.kind) {
            Ok(actual) if actual == expected => {}
            result => {
                report.failure = Some(CleanupFailure::Changed);
                report.os_code = result.err().and_then(|e| e.raw_os_error());
                return report;
            }
        }
        for (file, entry) in self.files.into_iter().zip(self.info.files) {
            if let Err(error) = remove(&file) {
                report.failure = Some(CleanupFailure::Storage);
                report.os_code = error.raw_os_error();
                return report;
            }
            drop(file);
            report.removed_files += 1;
            report.removed_logical_bytes += entry.bytes;
        }
        // A name added during commit keeps the directory nonempty: fail visibly
        // without recursive deletion, broadening the allowlist or removing it.
        if let Err(error) = remove(&self.directory) {
            report.failure = Some(CleanupFailure::Storage);
            report.os_code = error.raw_os_error();
            return report;
        }
        drop(self.directory);
        report.directory_removed = true;
        report
    }
}

#[cfg(test)]
mod tests;
