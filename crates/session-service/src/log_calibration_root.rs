use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use uuid::{Uuid, Variant};
use windows_sys::Win32::{
    Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW},
    System::WindowsProgramming::DRIVE_FIXED,
};

const PARENT: &str = r"D:\tmp";
const CANONICAL_PARENT: &str = r"\\?\D:\tmp";
pub(crate) const PREFIX: &str = "P22-throughput-中文-";

pub(crate) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "candidate root rejected")
}

pub(crate) fn candidate_id(path: &Path) -> io::Result<Uuid> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid)?;
    let suffix = name.strip_prefix(PREFIX).ok_or_else(invalid)?;
    let id = Uuid::parse_str(suffix).map_err(|_| invalid())?;
    if id.to_string() != suffix
        || id.get_version_num() != 4
        || id.get_variant() != Variant::RFC4122
        || path.as_os_str() != format!(r"{PARENT}\{name}").as_str()
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

fn fixed_ntfs() -> io::Result<()> {
    let drive = [b'D' as u16, b':' as u16, b'\\' as u16, 0];
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
    _parent: File,
    _volume: File,
}

impl Parent {
    pub(crate) fn open() -> io::Result<Self> {
        fixed_ntfs()?;
        let volume = pin(Path::new(r"D:\"))?;
        let parent = pin(Path::new(PARENT))?;
        if fs::canonicalize(PARENT)? != Path::new(CANONICAL_PARENT) {
            return Err(invalid());
        }
        Ok(Self {
            _parent: parent,
            _volume: volume,
        })
    }

    pub(crate) fn pin_empty(&self, requested: &Path) -> io::Result<(File, std::path::PathBuf)> {
        candidate_id(requested)?;
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
