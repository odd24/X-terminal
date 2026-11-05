use super::*;
use crate::{ExportFingerprint, ExportStore};
use sha2::{Digest, Sha256};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-selected-save-中文-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-selected-save-中文-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn source(temp: &Temp) -> (PathBuf, VerifiedExport) {
    let data = temp.0.join("应用目录");
    fs::create_dir(&data).unwrap();
    let store = ExportStore::open(&data).unwrap();
    let id = Uuid::new_v4();
    let path = store.path().join(id.to_string());
    fs::create_dir(&path).unwrap();
    fs::write(path.join("export.jsonl"), b"synthetic bytes\n").unwrap();
    let source = VerifiedExport::open(
        &data,
        id,
        ExportFingerprint {
            bytes: 16,
            sha256: Sha256::digest(b"synthetic bytes\n").into(),
        },
        || false,
    )
    .unwrap();
    (data, source)
}
#[test]
fn new_target_is_synced_and_published_without_modifying_the_managed_source() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("自选新文件.jsonl");
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    assert_eq!(target.existing_bytes().unwrap(), None);
    let result = target.save(&mut source, || false);
    assert_eq!(result.phase, "COMPLETED");
    assert!(result.backup.is_none());
    assert_eq!(fs::read(path).unwrap(), b"synthetic bytes\n");
}
#[test]
fn existing_target_is_pinned_and_preserved_as_exact_backup_before_replacement() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("替换.jsonl");
    fs::write(&path, b"original bytes").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    assert_eq!(target.existing_bytes().unwrap(), Some(14));
    assert!(fs::write(&path, b"unexpected edit").is_err());
    assert!(fs::rename(&path, temp.0.join("moved")).is_err());
    let result = target.save(&mut source, || false);
    assert_eq!(result.phase, "COMPLETED");
    assert_eq!(fs::read(result.backup.unwrap()).unwrap(), b"original bytes");
    assert_eq!(fs::read(path).unwrap(), b"synthetic bytes\n");
}
#[test]
fn cancelled_save_keeps_original_and_removes_only_its_private_staging() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("取消.jsonl");
    fs::write(&path, b"keep").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let result = target.save(&mut source, || true);
    assert_eq!(result.phase, "CANCELLED");
    assert_eq!(fs::read(path).unwrap(), b"keep");
    assert!(result.backup.is_none());
    assert!(result.staging.is_none());
}
#[test]
fn new_namespace_collision_is_not_overwritten_and_failed_restore_reports_backup() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("新建冲突.jsonl");
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let result = target.run(&mut source, &mut || false, |after, path| {
        if !after {
            fs::write(path, b"new unrelated file").unwrap();
        }
    });
    assert_eq!(result.phase, "FAILED");
    assert_eq!(fs::read(&path).unwrap(), b"new unrelated file");
    let path = temp.0.join("替换冲突.jsonl");
    fs::write(&path, b"original").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let result = target.run(&mut source, &mut || false, |after, path| {
        if after {
            fs::write(path, b"new unrelated file").unwrap();
        }
    });
    assert_eq!(result.phase, "RECOVERY_REQUIRED");
    assert_eq!(fs::read(&path).unwrap(), b"new unrelated file");
    assert_eq!(fs::read(result.backup.unwrap()).unwrap(), b"original");
}
#[test]
fn application_data_unknown_attempts_and_nonplain_targets_are_rejected() {
    let temp = Temp::new();
    let (data, _source) = source(&temp);
    assert!(SaveTarget::prepare(&data.join("forbidden.jsonl"), &data, Uuid::new_v4()).is_err());
    let folder = temp.0.join("目录.jsonl");
    fs::create_dir(&folder).unwrap();
    assert!(SaveTarget::prepare(&folder, &data, Uuid::new_v4()).is_err());
    let id = Uuid::new_v4();
    fs::write(
        temp.0.join(format!(".terminal-export-{id}.partial")),
        b"sentinel",
    )
    .unwrap();
    assert!(SaveTarget::prepare(&temp.0.join("new.jsonl"), &data, id).is_err());
}
