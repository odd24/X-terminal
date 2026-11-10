//! Fixed application metadata namespace. Never exposed as a renderer path API.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::*;
#[path = "save_recovery.rs"]
pub mod save_recovery;
pub const DIRECTORY: &str = "desktop-close-receipts-v1";
pub const MAX_BYTES: usize = 8192;
pub const MAX_RECORDS: usize = 32;
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Unavailable {
    Missing,
    Busy,
    Untrusted,
    Unsupported,
    Capacity,
    Io,
    Conflict,
}
type Result<T> = std::result::Result<T, Unavailable>;
pub struct Entry {
    pub service_id: Uuid,
    pub bytes: Vec<u8>,
}
struct Held {
    id: Uuid,
    file: File,
    bytes: Vec<u8>,
    time: u64,
}
struct Store {
    _guards: Vec<File>,
    _lock: File,
    path: PathBuf,
}
fn io(e: std::io::Error) -> Unavailable {
    if e.raw_os_error() == Some(32) {
        Unavailable::Busy
    } else {
        Unavailable::Io
    }
}
fn leaf(path: &Path, new: bool) -> Result<File> {
    let mut o = OpenOptions::new();
    o.read(true)
        .write(true)
        .create_new(new)
        .share_mode(0)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = o.open(path).map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if !meta.is_file()
        || meta.file_attributes() & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_READONLY) != 0
        || unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.nNumberOfLinks != 1
    {
        return Err(Unavailable::Untrusted);
    }
    Ok(file)
}
impl Store {
    fn open(root: &Path, directory: &str, create: bool) -> Result<Self> {
        let mut guards = crate::storage::guards(root).map_err(|_| Unavailable::Untrusted)?;
        let path = root.join(directory);
        let mut fresh = false;
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                match fs::create_dir(&path) {
                    Ok(()) => fresh = true,
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(io(e)),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Unavailable::Missing),
            Err(e) => return Err(io(e)),
        }
        guards.push(crate::storage::pin(&path).map_err(|_| Unavailable::Untrusted)?);
        let lock = leaf(&path.join("store.lock"), fresh)?;
        if lock.metadata().map_err(io)?.len() != 0 {
            return Err(Unavailable::Untrusted);
        }
        Ok(Self {
            _guards: guards,
            _lock: lock,
            path,
        })
    }
    fn scan(
        &self,
        limit: usize,
        validate: &impl Fn(&[u8], Uuid) -> Result<u64>,
    ) -> Result<Vec<Held>> {
        let mut result = vec![];
        for entry in fs::read_dir(&self.path).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or(Unavailable::Untrusted)?;
            if name == "store.lock" {
                continue;
            }
            if result.len() >= limit {
                return Err(Unavailable::Capacity);
            }
            let id = Uuid::parse_str(name.strip_suffix(".json").ok_or(Unavailable::Untrusted)?)
                .map_err(|_| Unavailable::Untrusted)?;
            if id.is_nil() || name != format!("{id}.json") {
                return Err(Unavailable::Untrusted);
            }
            let (file, bytes) = read_leaf(&entry.path(), MAX_BYTES)?;
            let time = validate(&bytes, id)?;
            result.push(Held {
                id,
                file,
                bytes,
                time,
            });
        }
        Ok(result)
    }
}
fn read_leaf(path: &Path, limit: usize) -> Result<(File, Vec<u8>)> {
    let mut file = leaf(path, false)?;
    let size = file.metadata().map_err(io)?.len();
    if size == 0 || size > limit as u64 {
        return Err(Unavailable::Untrusted);
    }
    let mut bytes = vec![];
    std::io::Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err(Unavailable::Untrusted);
    }
    Ok((file, bytes))
}
/// Validator is trusted Rust code, returning only safe format classification/time.
pub fn read(root: &Path, validate: impl Fn(&[u8], Uuid) -> Result<u64>) -> Result<Vec<Entry>> {
    let store = Store::open(root, DIRECTORY, false)?;
    Ok(store
        .scan(MAX_RECORDS, &validate)?
        .into_iter()
        .map(|v| Entry {
            service_id: v.id,
            bytes: v.bytes,
        })
        .collect())
}
/// Immutable service-ID publication. No replacement of any existing target.
pub fn publish(
    root: &Path,
    id: Uuid,
    bytes: &[u8],
    validate: impl Fn(&[u8], Uuid) -> Result<u64>,
) -> Result<()> {
    publish_inner(root, id, bytes, validate, |_| {})
}
fn publish_inner(
    root: &Path,
    id: Uuid,
    bytes: &[u8],
    validate: impl Fn(&[u8], Uuid) -> Result<u64>,
    before_rename: impl FnOnce(&Path),
) -> Result<()> {
    if id.is_nil() || bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(Unavailable::Untrusted);
    }
    validate(bytes, id)?;
    let store = Store::open(root, DIRECTORY, true)?;
    let mut entries = store.scan(MAX_RECORDS, &validate)?;
    if let Some(old) = entries.iter().find(|v| v.id == id) {
        return if old.bytes == bytes {
            Ok(())
        } else {
            Err(Unavailable::Conflict)
        };
    }
    if entries.len() == MAX_RECORDS {
        entries.sort_by_key(|e| (e.time, e.id));
        crate::selected_save::remove_owned(&entries[0].file).map_err(io)?;
        entries.remove(0);
    }
    publish_file(&store, id, bytes, before_rename)
}

fn publish_file(
    store: &Store,
    id: Uuid,
    bytes: &[u8],
    before_rename: impl FnOnce(&Path),
) -> Result<()> {
    publish_leaf(
        store,
        &format!("{id}.pending"),
        &format!("{id}.json"),
        bytes,
        before_rename,
    )
}

fn publish_leaf(
    store: &Store,
    pending: &str,
    target: &str,
    bytes: &[u8],
    before_rename: impl FnOnce(&Path),
) -> Result<()> {
    let mut file = leaf(&store.path.join(pending), true)?;
    let result = (|| {
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        let target = store.path.join(target);
        before_rename(&target);
        crate::selected_save::rename(&file, &target).map_err(io)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = crate::selected_save::remove_owned(&file);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "shared-terminal-close-store-中文-{}",
                Uuid::new_v4()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(
                self.0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("shared-terminal-close-store-中文-")
            );
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Record {
        v: u8,
        id: Uuid,
        time: u64,
    }
    fn data(id: Uuid, time: u64) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"v":1,"id":id,"time":time})).unwrap()
    }
    fn valid(bytes: &[u8], id: Uuid) -> Result<u64> {
        let r: Record = serde_json::from_slice(bytes).map_err(|_| Unavailable::Untrusted)?;
        if r.v != 1 {
            return Err(Unavailable::Unsupported);
        }
        if r.id != id || r.time == 0 {
            return Err(Unavailable::Untrusted);
        }
        Ok(r.time)
    }
    #[test]
    fn immutable_binding_idempotence_and_full_retention_keep_only_verified_metadata() {
        let root = Temp::new();
        assert!(matches!(read(&root.0, valid), Err(Unavailable::Missing)));
        let first = Uuid::new_v4();
        publish(&root.0, first, &data(first, 1), valid).unwrap();
        publish(&root.0, first, &data(first, 1), valid).unwrap();
        assert_eq!(
            publish(&root.0, first, &data(first, 2), valid),
            Err(Unavailable::Conflict)
        );
        for time in 2..=MAX_RECORDS as u64 + 1 {
            let id = Uuid::new_v4();
            publish(&root.0, id, &data(id, time), valid).unwrap();
        }
        let entries = read(&root.0, valid).unwrap();
        assert_eq!(entries.len(), MAX_RECORDS);
        assert!(!entries.iter().any(|e| e.service_id == first));
        assert!(
            entries
                .iter()
                .all(|e| valid(&e.bytes, e.service_id).is_ok())
        );
    }
    #[test]
    fn bad_future_oversize_and_unknown_entries_preserved_without_repair() {
        for kind in 0..4 {
            let root = Temp::new();
            let id = Uuid::new_v4();
            publish(&root.0, id, &data(id, 1), valid).unwrap();
            let path = root.0.join(DIRECTORY).join(if kind == 3 {
                "user.txt".into()
            } else {
                format!("{id}.json")
            });
            let bytes = match kind {
                0 => b"{bad JSON".to_vec(),
                1 => serde_json::to_vec(&serde_json::json!({"v":2,"id":id,"time":1})).unwrap(),
                2 => vec![b'x'; MAX_BYTES + 1],
                _ => b"preserve unknown user content".to_vec(),
            };
            fs::write(&path, &bytes).unwrap();
            assert!(read(&root.0, valid).is_err());
            let next = Uuid::new_v4();
            assert!(publish(&root.0, next, &data(next, 2), valid).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(!root.0.join(DIRECTORY).join(format!("{next}.json")).exists());
        }
    }
    #[test]
    fn busy_multinstance_and_destination_race_never_overwrite_other_identity() {
        let root = Temp::new();
        let seed = Uuid::new_v4();
        publish(&root.0, seed, &data(seed, 1), valid).unwrap();
        let lock = leaf(&root.0.join(DIRECTORY).join("store.lock"), false).unwrap();
        assert!(matches!(read(&root.0, valid), Err(Unavailable::Busy)));
        drop(lock);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers = (0..2)
            .map(|_| {
                let root = root.0.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    let id = Uuid::new_v4();
                    b.wait();
                    (id, publish(&root, id, &data(id, 2), valid))
                })
            })
            .collect::<Vec<_>>();
        let results = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        assert!(results.iter().any(|(_, r)| r.is_ok()));
        let entries = read(&root.0, valid).unwrap();
        for (id, result) in results {
            assert!(result.is_ok() || result == Err(Unavailable::Busy));
            assert_eq!(entries.iter().any(|e| e.service_id == id), result.is_ok());
        }
        let id = Uuid::new_v4();
        let result = publish_inner(&root.0, id, &data(id, 3), valid, |path| {
            fs::write(path, b"do not replace this raced target").unwrap()
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read(root.0.join(DIRECTORY).join(format!("{id}.json"))).unwrap(),
            b"do not replace this raced target"
        );
        assert!(
            !root
                .0
                .join(DIRECTORY)
                .join(format!("{id}.pending"))
                .exists()
        );
    }
    #[test]
    fn junction_namespace_and_ancestor_are_rejected_without_touching_target() {
        use std::os::windows::process::CommandExt;
        let root = Temp::new();
        let outside = Temp::new();
        fs::write(outside.0.join("sentinel"), b"foreign-preserved").unwrap();
        for leaf_name in [DIRECTORY, "ancestor"] {
            let alias = root.0.join(leaf_name);
            let output = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&alias)
                .arg(&outside.0)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(output.status.success());
            let selected = if leaf_name == DIRECTORY {
                root.0.clone()
            } else {
                alias.join("missing")
            };
            let id = Uuid::new_v4();
            assert!(matches!(
                publish(&selected, id, &data(id, 1), valid),
                Err(Unavailable::Untrusted)
            ));
            assert_eq!(
                fs::read(outside.0.join("sentinel")).unwrap(),
                b"foreign-preserved"
            );
            assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
            fs::remove_dir(alias).unwrap();
        }
    }
    #[test]
    fn hard_links_and_incomplete_new_files_are_untrusted_and_preserved() {
        let root = Temp::new();
        let id = Uuid::new_v4();
        publish(&root.0, id, &data(id, 1), valid).unwrap();
        let path = root.0.join(DIRECTORY).join(format!("{id}.json"));
        let link = root.0.join("held-link");
        fs::hard_link(&path, &link).unwrap();
        assert!(matches!(read(&root.0, valid), Err(Unavailable::Untrusted)));
        assert_eq!(fs::read(&link).unwrap(), data(id, 1));
        fs::remove_file(link).unwrap();
        let pending = root
            .0
            .join(DIRECTORY)
            .join(format!("{}.pending", Uuid::new_v4()));
        fs::write(&pending, b"partial").unwrap();
        assert!(matches!(read(&root.0, valid), Err(Unavailable::Untrusted)));
        assert_eq!(fs::read(pending).unwrap(), b"partial");
    }
}
