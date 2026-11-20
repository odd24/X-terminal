use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use uuid::{Uuid, Variant};
use windows_sys::Win32::{
    Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW},
    System::WindowsProgramming::DRIVE_FIXED,
};

pub(crate) const D_PARENT: &str = r"D:\tmp";
pub(crate) const C_PARENT: &str = r"C:\Users\Administrator\AppData\Local\Temp";
pub(crate) const PREFIX: &str = "P22-throughput-中文-";

pub(crate) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "candidate root rejected")
}

pub(crate) fn candidate_id_at(parent: &Path, path: &Path) -> io::Result<Uuid> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid)?;
    let suffix = name.strip_prefix(PREFIX).ok_or_else(invalid)?;
    let id = Uuid::parse_str(suffix).map_err(|_| invalid())?;
    if id.to_string() != suffix
        || id.get_version_num() != 4
        || id.get_variant() != Variant::RFC4122
        || path.as_os_str() != parent.join(name).as_os_str()
    {
        return Err(invalid());
    }
    Ok(id)
}

fn pin(path: &Path) -> io::Result<File> {
    // Open the directory itself, denying delete sharing while the measurement owns it.
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .custom_flags(0x02000000 | 0x00200000)
        .open(path)?;
    let meta = handle.metadata()?;
    if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
        return Err(invalid());
    }
    Ok(handle)
}

fn fixed_ntfs(volume: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let drive: Vec<_> = volume.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut filesystem = [0u16; 16];
    if unsafe { GetDriveTypeW(drive.as_ptr()) } != DRIVE_FIXED
        || unsafe {
            GetVolumeInformationW(
                drive.as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        } == 0
        || !filesystem.starts_with(&[78, 84, 70, 83, 0])
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) struct Parent {
    path: PathBuf,
    _guards: Vec<File>,
}

impl Parent {
    pub(crate) fn open_at(path: &Path) -> io::Result<Self> {
        let volume = if path == Path::new(D_PARENT) {
            Path::new(r"D:\")
        } else if path == Path::new(C_PARENT) {
            Path::new(r"C:\")
        } else {
            return Err(invalid());
        };
        fixed_ntfs(volume)?;
        let mut ancestors: Vec<_> = path.ancestors().collect();
        ancestors.reverse();
        let guards = ancestors
            .into_iter()
            .map(pin)
            .collect::<io::Result<Vec<_>>>()?;
        if fs::canonicalize(path)?.as_os_str() != format!(r"\\?\{}", path.display()).as_str() {
            return Err(invalid());
        }
        Ok(Self {
            path: path.to_path_buf(),
            _guards: guards,
        })
    }

    pub(crate) fn pin_empty(&self, requested: &Path) -> io::Result<(File, std::path::PathBuf)> {
        candidate_id_at(&self.path, requested)?;
        let root = pin(requested)?;
        let path = fs::canonicalize(requested)?;
        if path.as_os_str() != format!(r"\\?\{}", requested.display()).as_str()
            || fs::read_dir(&path)?.next().is_some()
        {
            return Err(invalid());
        }
        Ok((root, path))
    }
}
