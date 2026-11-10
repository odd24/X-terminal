//! User-selected local targets. Never expose these paths through generic IPC.
use crate::{VerifiedExport, close_store::Unavailable, save_recovery, storage};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        ACL,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        FILE_DISPOSITION_INFO, FILE_RENAME_INFO, FileDispositionInfo, FileRenameInfo,
        SetFileInformationByHandle,
    },
};

#[derive(Debug, Clone, Serialize)]
pub struct SaveReport {
    pub phase: &'static str,
    pub path: PathBuf,
    pub backup: Option<PathBuf>,
    pub staging: Option<PathBuf>,
    pub failure: Option<&'static str>,
    pub os_code: Option<i32>,
    pub diagnostic_issue: Option<Unavailable>,
}
pub struct SaveTarget {
    _guards: Vec<File>,
    id: Uuid,
    path: PathBuf,
    staging: PathBuf,
    backup: PathBuf,
    original: Option<File>,
}
#[derive(Clone, Copy)]
pub enum SaveCheckpoint {
    IntentSynced,
    BackupMoved,
    Published,
}
struct Tracking<'a> {
    root: &'a Path,
    observe: &'a mut dyn FnMut(SaveCheckpoint),
}
fn identity(file: &File) -> io::Result<(u32, u32, u32)> {
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
pub(crate) fn rename(file: &File, path: &Path) -> io::Result<()> {
    let name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.len() > 32760 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target path too long",
        ));
    }
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let length = (offset + (name.len() + 1) * 2).max(std::mem::size_of::<FILE_RENAME_INFO>());
    let mut buffer = vec![0u64; length.div_ceil(8)];
    unsafe {
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        if SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfo,
            info.cast(),
            length as u32,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
pub(crate) fn remove_owned(file: &File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of_val(&disposition) as u32,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn copy_dacl(from: &File, to: &File) -> io::Result<()> {
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let code = unsafe {
        GetSecurityInfo(
            from.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    struct Descriptor(*mut std::ffi::c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let _guard = Descriptor(descriptor);
    let code = unsafe {
        SetSecurityInfo(
            to.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    if code != 0 {
        Err(io::Error::from_raw_os_error(code as i32))
    } else {
        Ok(())
    }
}
impl SaveTarget {
    /// `selected` must come from a trusted native picker. Existing targets are
    /// pinned until a separate explicit confirmation or lease cancellation.
    pub fn prepare(selected: &Path, forbidden_root: &Path, id: Uuid) -> io::Result<Self> {
        if id.is_nil() || !selected.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid selected target",
            ));
        }
        let name = selected
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;
        if name.is_empty()
            || name.ends_with(['.', ' '])
            || name.chars().any(|v| v < ' ' || "<>:\"/\\|?*".contains(v))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid file name",
            ));
        }
        let parent = fs::canonicalize(selected.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing target parent")
        })?)?;
        let guards = storage::guards(&parent)?;
        let protected = identity(&storage::pin(&fs::canonicalize(forbidden_root)?)?)?;
        for guard in &guards {
            if identity(guard)? == protected {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "cannot save inside application data",
                ));
            }
        }
        let path = parent.join(name);
        let original = match fs::symlink_metadata(&path) {
            Ok(meta) => {
                // Preserve special-file semantics by refusing an ordinary-file
                // replacement; selecting a fresh name remains available.
                if !meta.is_file()
                    || meta.file_attributes()
                        & (0x1 | 0x4 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x4000)
                        != 0
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "target is not a plain writable local file",
                    ));
                }
                let file = OpenOptions::new()
                    .access_mode(0x80000000 | 0x10000)
                    .share_mode(1)
                    .custom_flags(0x00200000)
                    .open(&path)?;
                let pinned = file.metadata()?;
                if !pinned.is_file()
                    || pinned.file_attributes()
                        & (0x1 | 0x4 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x4000)
                        != 0
                {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "target changed"));
                }
                Some(file)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let staging = parent.join(format!(".terminal-export-{id}.partial"));
        let backup = parent.join(format!(".terminal-export-{id}.backup"));
        if path == staging || path == backup {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "reserved save name",
            ));
        }
        if fs::symlink_metadata(&staging).is_ok() || fs::symlink_metadata(&backup).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "save attempt already exists",
            ));
        }
        Ok(Self {
            _guards: guards,
            id,
            path,
            staging,
            backup,
            original,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn existing_bytes(&self) -> io::Result<Option<u64>> {
        self.original
            .as_ref()
            .map(|f| f.metadata().map(|m| m.len()))
            .transpose()
    }
    pub fn save(self, source: &mut VerifiedExport, cancelled: impl FnMut() -> bool) -> SaveReport {
        self.save_checked(source, cancelled, || true)
    }
    /// Called after staging and verification, before the first destination change.
    pub fn save_checked(
        self,
        source: &mut VerifiedExport,
        mut cancelled: impl FnMut() -> bool,
        authorize_commit: impl FnOnce() -> bool,
    ) -> SaveReport {
        self.run_checked(source, &mut cancelled, |_, _| {}, authorize_commit, None)
    }
    pub fn save_tracked(
        self,
        source: &mut VerifiedExport,
        mut cancelled: impl FnMut() -> bool,
        authorize_commit: impl FnOnce() -> bool,
        root: &Path,
        mut observe: impl FnMut(SaveCheckpoint),
    ) -> SaveReport {
        self.run_checked(
            source,
            &mut cancelled,
            |_, _| {},
            authorize_commit,
            Some(Tracking {
                root,
                observe: &mut observe,
            }),
        )
    }
    #[cfg(test)]
    fn run(
        self,
        source: &mut VerifiedExport,
        cancelled: &mut impl FnMut() -> bool,
        hook: impl FnMut(bool, &Path),
    ) -> SaveReport {
        self.run_checked(source, cancelled, hook, || true, None)
    }
    fn run_checked(
        self,
        source: &mut VerifiedExport,
        cancelled: &mut impl FnMut() -> bool,
        mut hook: impl FnMut(bool, &Path),
        authorize_commit: impl FnOnce() -> bool,
        mut tracking: Option<Tracking<'_>>,
    ) -> SaveReport {
        let mut report = SaveReport {
            phase: "FAILED",
            path: self.path.clone(),
            backup: None,
            staging: None,
            failure: None,
            os_code: None,
            diagnostic_issue: None,
        };
        let mut stage = None;
        let mut moved = false;
        let mut intent = None;
        let result = (|| -> Result<(), (&'static str, io::Error)> {
            if cancelled() {
                return Err((
                    "CANCELLED",
                    io::Error::new(io::ErrorKind::Interrupted, "cancelled"),
                ));
            }
            let file = stage.insert(
                OpenOptions::new()
                    .create_new(true)
                    .read(true)
                    .write(true)
                    .access_mode(0xc0000000 | 0x10000 | 0x40000)
                    .share_mode(0)
                    .custom_flags(0x00200000)
                    .open(&self.staging)
                    .map_err(|e| ("STAGING", e))?,
            );
            source
                .copy_to(&mut *file, &mut *cancelled)
                .map_err(|e| ("COPY", e))?;
            file.sync_all().map_err(|e| ("SYNC", e))?;
            if let Some(original) = &self.original {
                copy_dacl(original, file).map_err(|e| ("PERMISSIONS", e))?;
                file.sync_all().map_err(|e| ("SYNC", e))?;
            }
            hook(false, &self.path);
            if cancelled() {
                return Err((
                    "CANCELLED",
                    io::Error::new(io::ErrorKind::Interrupted, "cancelled"),
                ));
            }
            if let (Some(original), Some(tracking)) = (&self.original, tracking.as_mut()) {
                let recorded = (|| {
                    let parent = self._guards.last().ok_or(Unavailable::Untrusted)?;
                    save_recovery::begin(
                        tracking.root,
                        self.id,
                        self.path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .ok_or(Unavailable::Untrusted)?,
                        identity(parent).map_err(|_| Unavailable::Io)?,
                        identity(original).map_err(|_| Unavailable::Io)?,
                        identity(file).map_err(|_| Unavailable::Io)?,
                    )
                })();
                match recorded {
                    Ok(value) => intent = Some(value),
                    Err(issue) => {
                        report.diagnostic_issue = Some(issue);
                        return Err((
                            "RECOVERY_RECORD",
                            io::Error::other("save recovery intent unavailable"),
                        ));
                    }
                }
                (tracking.observe)(SaveCheckpoint::IntentSynced);
                if cancelled() {
                    return Err((
                        "CANCELLED",
                        io::Error::new(io::ErrorKind::Interrupted, "cancelled"),
                    ));
                }
            }
            if !authorize_commit() {
                return Err((
                    "AUTHORIZATION",
                    io::Error::other("save authorization unavailable"),
                ));
            }
            if let Some(original) = &self.original {
                rename(original, &self.backup).map_err(|e| ("BACKUP", e))?;
                moved = true;
                report.backup = Some(self.backup.clone());
                if let Some(tracking) = tracking.as_mut() {
                    (tracking.observe)(SaveCheckpoint::BackupMoved);
                }
            }
            hook(true, &self.path);
            rename(file, &self.path).map_err(|e| ("PUBLISH", e))?;
            if intent.is_some()
                && let Some(tracking) = tracking.as_mut()
            {
                (tracking.observe)(SaveCheckpoint::Published);
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                report.phase = "COMPLETED";
            }
            Err((step, error)) => {
                report.failure = Some(step);
                report.os_code = error.raw_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    report.phase = "CANCELLED";
                }
                if moved {
                    if rename(self.original.as_ref().unwrap(), &self.path).is_ok() {
                        report.backup = None;
                    } else {
                        report.phase = "RECOVERY_REQUIRED";
                    }
                }
                if let Some(file) = &stage
                    && remove_owned(file).is_err()
                {
                    report.staging = Some(self.staging.clone());
                }
            }
        }
        if let (Some(intent), Some(tracking)) = (intent, tracking) {
            let phase = if report.phase == "COMPLETED" {
                save_recovery::Phase::Published
            } else if report.backup.is_some() || report.staging.is_some() {
                save_recovery::Phase::Preserve
            } else {
                save_recovery::Phase::NotPublished
            };
            if let Err(issue) = save_recovery::finish(tracking.root, &intent, phase) {
                report.diagnostic_issue = Some(issue);
            }
        }
        report
    }
}

#[cfg(test)]
mod tests;
