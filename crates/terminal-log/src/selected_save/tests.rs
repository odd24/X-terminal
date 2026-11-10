use super::*;
use crate::{ExportFingerprint, ExportStore};
use sha2::{Digest, Sha256};
mod crash;
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
fn denied_commit_keeps_original_and_removes_verified_staging() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("受保护.txt");
    fs::write(&path, b"original").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let staging = target.staging.clone();
    let result = target.save_checked(
        &mut source,
        || false,
        || {
            assert!(staging.is_file());
            assert!(path.is_file());
            false
        },
    );
    assert_eq!(result.phase, "FAILED");
    assert_eq!(result.failure, Some("AUTHORIZATION"));
    assert_eq!(fs::read(path).unwrap(), b"original");
    assert!(!staging.exists());
    assert!(result.backup.is_none() && result.staging.is_none());
}
#[test]
fn new_namespace_collision_is_not_overwritten_and_failed_restore_reports_backup() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("新建冲突.jsonl");
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let staging = target.staging.clone();
    let result = target.run(&mut source, &mut || false, |after, path| {
        if !after {
            fs::write(path, b"new unrelated file").unwrap();
        }
    });
    assert_eq!(result.phase, "FAILED");
    assert_eq!(result.failure, Some("PUBLISH"));
    assert!(result.os_code.is_some());
    assert!(result.backup.is_none() && result.staging.is_none());
    assert!(!staging.exists());
    assert_eq!(fs::read(&path).unwrap(), b"new unrelated file");
    let path = temp.0.join("替换冲突.jsonl");
    fs::write(&path, b"original").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let backup = target.backup.clone();
    let staging = target.staging.clone();
    let result = target.run(&mut source, &mut || false, |after, path| {
        if after {
            fs::write(path, b"new unrelated file").unwrap();
        }
    });
    assert_eq!(result.phase, "RECOVERY_REQUIRED");
    assert_eq!(result.failure, Some("PUBLISH"));
    assert!(result.os_code.is_some());
    assert_eq!(result.backup.as_ref(), Some(&backup));
    assert!(result.staging.is_none());
    assert!(!staging.exists());
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

fn entries(path: &Path) -> Vec<std::ffi::OsString> {
    let mut names: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    names
}

#[test]
fn readonly_and_directory_targets_are_rejected_with_contents_and_attributes_intact() {
    let temp = Temp::new();
    let (data, _source) = source(&temp);
    let folder = temp.0.join("目标目录");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("保留"), b"directory sentinel").unwrap();
    let file = temp.0.join("只读.jsonl");
    fs::write(&file, b"readonly sentinel").unwrap();
    let original_permissions = fs::metadata(&file).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&file, permissions.clone()).unwrap();
    let before = entries(&temp.0);
    let folder_result = SaveTarget::prepare(&folder, &data, Uuid::new_v4());
    let file_result = SaveTarget::prepare(&file, &data, Uuid::new_v4());
    let preserved = fs::read(&file).unwrap();
    let readonly = fs::metadata(&file).unwrap().permissions().readonly();
    // Restore only the attribute this fixture set, before any assertion can panic.
    fs::set_permissions(&file, original_permissions).unwrap();
    assert_eq!(
        folder_result.err().unwrap().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        file_result.err().unwrap().kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(readonly);
    assert_eq!(preserved, b"readonly sentinel");
    assert_eq!(
        fs::read(folder.join("保留")).unwrap(),
        b"directory sentinel"
    );
    assert_eq!(entries(&temp.0), before);
}

#[test]
fn invalid_names_are_rejected_without_normalization_or_extra_files() {
    let temp = Temp::new();
    let (data, _source) = source(&temp);
    fs::write(temp.0.join("保留.jsonl"), b"keep").unwrap();
    let before = entries(&temp.0);
    for name in [
        "保留.jsonl:stream",
        "保留.jsonl.",
        "保留.jsonl ",
        "bad\u{1}name",
        "bad?name",
        "bad|name",
        "bad<name",
        "bad\"name",
    ] {
        assert_eq!(
            SaveTarget::prepare(&temp.0.join(name), &data, Uuid::new_v4())
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput,
            "{name:?}"
        );
        assert_eq!(entries(&temp.0), before);
        assert_eq!(fs::read(temp.0.join("保留.jsonl")).unwrap(), b"keep");
    }
}

#[test]
fn application_root_and_descendants_reject_saves_and_preserve_all_source_objects() {
    let temp = Temp::new();
    let (data, _source) = source(&temp);
    fs::write(data.join("config.sqlite"), b"synthetic database").unwrap();
    let logs = data.join("terminal-logs");
    fs::create_dir(&logs).unwrap();
    fs::write(logs.join("合成.rawlog"), b"synthetic raw log").unwrap();
    let exports = data.join("terminal-log-exports");
    let export = fs::read_dir(&exports)
        .unwrap()
        .map(|entry| entry.unwrap().path().join("export.jsonl"))
        .find(|path| path.is_file())
        .unwrap();
    for parent in [&data, &logs, export.parent().unwrap()] {
        for name in ["新文件.jsonl", "config.sqlite", "export.jsonl"] {
            assert_eq!(
                SaveTarget::prepare(&parent.join(name), &data, Uuid::new_v4())
                    .err()
                    .unwrap()
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }
    assert_eq!(
        fs::read(data.join("config.sqlite")).unwrap(),
        b"synthetic database"
    );
    assert_eq!(
        fs::read(logs.join("合成.rawlog")).unwrap(),
        b"synthetic raw log"
    );
    assert_eq!(fs::read(export).unwrap(), b"synthetic bytes\n");
    assert_eq!(entries(&logs).len(), 1);
}

struct Junction(PathBuf);
impl Junction {
    fn new(temp: &Temp, name: &str, target: &Path) -> Self {
        assert!(target.starts_with(&temp.0));
        let link = temp.0.join(name);
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(target)
                .output()
                .unwrap()
                .status
                .success(),
            "isolated junction fixture must be created"
        );
        Self(link)
    }
}
impl Drop for Junction {
    fn drop(&mut self) {
        // Unlink this fixture only; never recursively traverse a junction.
        fs::remove_dir(&self.0).unwrap();
    }
}

#[test]
fn target_junction_and_resolved_application_alias_are_rejected_without_touching_referents() {
    let temp = Temp::new();
    let (data, _source) = source(&temp);
    let outside = temp.0.join("本次独立目标");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("保留"), b"keep junction referent").unwrap();
    let target = Junction::new(&temp, "目标链接.jsonl", &outside);
    assert_eq!(
        SaveTarget::prepare(&target.0, &data, Uuid::new_v4())
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    let alias = Junction::new(&temp, "应用别名", &data);
    assert_eq!(
        SaveTarget::prepare(&alias.0.join("拒绝.jsonl"), &data, Uuid::new_v4())
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        fs::read(outside.join("保留")).unwrap(),
        b"keep junction referent"
    );
    assert_eq!(entries(&outside).len(), 1);
    assert!(!data.join("拒绝.jsonl").exists());
}

#[test]
fn resolved_local_parent_is_pinned_and_report_uses_actual_directory() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let actual = temp.0.join("实际父目录");
    fs::create_dir(&actual).unwrap();
    let alias = Junction::new(&temp, "父目录别名", &actual);
    let target = SaveTarget::prepare(&alias.0.join("新建.jsonl"), &data, Uuid::new_v4()).unwrap();
    assert_eq!(
        target.path(),
        fs::canonicalize(&actual).unwrap().join("新建.jsonl")
    );
    assert!(fs::rename(&actual, temp.0.join("被替换父目录")).is_err());
    let report = target.save(&mut source, || false);
    assert_eq!(report.phase, "COMPLETED");
    assert_eq!(fs::read(&report.path).unwrap(), b"synthetic bytes\n");
    assert_eq!(entries(&actual).len(), 1);
}

#[test]
fn private_attempt_names_refuse_existing_entries_and_late_staging_collision() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("原对象.jsonl");
    fs::write(&path, b"original").unwrap();
    for suffix in ["partial", "backup"] {
        let id = Uuid::new_v4();
        let collision = temp.0.join(format!(".terminal-export-{id}.{suffix}"));
        assert_eq!(
            SaveTarget::prepare(&collision, &data, id)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(!collision.exists());
        fs::write(&collision, b"unrelated private name").unwrap();
        assert_eq!(
            SaveTarget::prepare(&path, &data, id).err().unwrap().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&collision).unwrap(), b"unrelated private name");
        assert_eq!(fs::read(&path).unwrap(), b"original");
    }
    let id = Uuid::new_v4();
    let target = SaveTarget::prepare(&path, &data, id).unwrap();
    let staging = target.staging.clone();
    let backup = target.backup.clone();
    fs::write(&staging, b"late staging occupant").unwrap();
    let report = target.save(&mut source, || false);
    assert_eq!(report.phase, "FAILED");
    assert_eq!(report.failure, Some("STAGING"));
    assert!(report.backup.is_none() && report.staging.is_none());
    assert_eq!(fs::read(staging).unwrap(), b"late staging occupant");
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert!(!backup.exists());
}

#[test]
fn late_backup_collision_keeps_original_and_cleans_only_owned_staging() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("备份冲突.jsonl");
    fs::write(&path, b"original").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let backup = target.backup.clone();
    let staging = target.staging.clone();
    let report = target.run(&mut source, &mut || false, |after, _| {
        if !after {
            fs::write(&backup, b"late backup occupant").unwrap();
        }
    });
    assert_eq!(report.phase, "FAILED");
    assert_eq!(report.failure, Some("BACKUP"));
    assert!(report.backup.is_none() && report.staging.is_none());
    assert_eq!(fs::read(path).unwrap(), b"original");
    assert_eq!(fs::read(backup).unwrap(), b"late backup occupant");
    assert!(!staging.exists());
}

#[test]
fn system_and_offline_targets_are_rejected_without_changing_their_attributes_or_bytes() {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_SYSTEM, SetFileAttributesW,
    };
    let temp = Temp::new();
    let (data, _source) = source(&temp);
    for attribute in [FILE_ATTRIBUTE_SYSTEM, FILE_ATTRIBUTE_OFFLINE] {
        let path = temp.0.join(format!("特殊属性-{attribute}.jsonl"));
        fs::write(&path, b"special attribute sentinel").unwrap();
        let original = fs::metadata(&path).unwrap().file_attributes();
        let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        assert_ne!(
            unsafe { SetFileAttributesW(wide.as_ptr(), original | attribute) },
            0
        );
        let observed = fs::metadata(&path).unwrap().file_attributes();
        let before = entries(&temp.0);
        let result = SaveTarget::prepare(&path, &data, Uuid::new_v4());
        let after = fs::metadata(&path).unwrap().file_attributes();
        let bytes = fs::read(&path).unwrap();
        // Restore only this fixture's attributes before assertions/cleanup.
        assert_ne!(unsafe { SetFileAttributesW(wide.as_ptr(), original) }, 0);
        assert_ne!(
            observed & attribute,
            0,
            "OS must really apply the attribute"
        );
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::InvalidInput);
        assert_eq!(after, observed);
        assert_eq!(bytes, b"special attribute sentinel");
        assert_eq!(entries(&temp.0), before);
    }
}

#[test]
fn cancellation_after_copy_and_sync_keeps_original_and_removes_the_owned_staging() {
    let temp = Temp::new();
    let (data, mut source) = source(&temp);
    let path = temp.0.join("复制后取消.jsonl");
    fs::write(&path, b"original before confirmation").unwrap();
    let target = SaveTarget::prepare(&path, &data, Uuid::new_v4()).unwrap();
    let staging = target.staging.clone();
    let backup = target.backup.clone();
    let cancel = std::cell::Cell::new(false);
    let hooks = std::cell::Cell::new(0);
    let report = target.run(&mut source, &mut || cancel.get(), |after, _| {
        assert!(!after, "cancel must stop before the backup rename");
        assert!(staging.is_file(), "copy must have created actual staging");
        assert_eq!(fs::metadata(&staging).unwrap().len(), 16);
        hooks.set(hooks.get() + 1);
        cancel.set(true);
    });
    assert_eq!(hooks.get(), 1);
    assert_eq!(report.phase, "CANCELLED");
    assert_eq!(report.failure, Some("CANCELLED"));
    assert!(report.backup.is_none() && report.staging.is_none());
    assert!(!staging.exists() && !backup.exists());
    assert_eq!(fs::read(&path).unwrap(), b"original before confirmation");
    // The managed source remains usable after cancellation, without reopening it.
    let mut bytes = Vec::new();
    source.copy_to(&mut bytes, || false).unwrap();
    assert_eq!(bytes, b"synthetic bytes\n");
}
