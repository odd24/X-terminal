use crate::log_calibration_root::{Parent, candidate_id_at, invalid};
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
    pub fn create(parent: &Path, requested: &Path) -> io::Result<Self> {
        let id = candidate_id_at(parent, requested)?;
        let parent = Parent::open_at(parent)?;
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
    use crate::log_calibration_root::{C_PARENT, D_PARENT, PREFIX};

    #[test]
    fn accepts_only_exact_direct_candidate_paths() {
        let name = format!("{PREFIX}{}", Uuid::new_v4());
        let d = Path::new(D_PARENT);
        let c = Path::new(C_PARENT);
        assert!(candidate_id_at(d, &d.join(&name)).is_ok());
        assert!(candidate_id_at(c, &c.join(&name)).is_ok());
        assert!(candidate_id_at(d, &c.join(&name)).is_err());
        assert!(candidate_id_at(c, &d.join(&name)).is_err());
        assert!(candidate_id_at(c, &c.join("child").join(&name)).is_err());
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
            assert!(candidate_id_at(d, Path::new(&path)).is_err(), "{path}");
        }
    }
}
