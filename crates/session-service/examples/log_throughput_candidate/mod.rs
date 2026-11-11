use crate::log_calibration_root::{Parent, candidate_id, invalid};
use std::{
    fs::{self, File},
    io,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;
pub struct Candidate {
    pub path: PathBuf,
    pub id: Uuid,
    root: File,
    _parent: Parent,
}

impl Candidate {
    pub fn create(requested: &Path) -> io::Result<Self> {
        let id = candidate_id(requested)?;
        let parent = Parent::open()?;
        // An existing path is rejected before any read of its contents.
        fs::create_dir(requested)?;
        let (root, path) = parent.pin_empty(requested)?;
        Ok(Self {
            path,
            id,
            root,
            _parent: parent,
        })
    }

    pub fn remove_owned(self) -> io::Result<()> {
        for entry in fs::read_dir(&self.path)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_attributes() & 0x400 != 0
                || fs::canonicalize(&path)? != path
                || path.parent() != Some(self.path.as_path())
            {
                return Err(invalid());
            }
            if meta.is_dir() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
        }
        drop(self.root);
        fs::remove_dir(&self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_calibration_root::PREFIX;

    #[test]
    fn accepts_only_exact_direct_candidate_paths() {
        let name = format!("{PREFIX}{}", Uuid::new_v4());
        assert!(candidate_id(Path::new(&format!(r"D:\tmp\{name}"))).is_ok());
        for path in [
            format!(r"Z:\{name}"),
            format!(r"\\server\share\{name}"),
            format!(r"\\?\D:\tmp\{name}"),
            format!(r"D:\tmp\child\{name}"),
            format!(r"D:\tmp\.\{name}"),
            format!(r"D:\tmp\{name}\"),
            format!(r"D:\tmp\{name}:stream"),
            format!(r"D:tmp\{name}"),
            format!(r"D:\tmp\{PREFIX}bad"),
        ] {
            assert!(candidate_id(Path::new(&path)).is_err(), "{path}");
        }
    }
}
