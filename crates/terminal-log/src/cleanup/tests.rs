use super::*;
use crate::{ArchiveReader, ExportStore, Limits, Logger, ManagedRoot, Metadata};
use session_core::session::{ConnectionId, ConnectionRef, Protocol};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-cleanup-中文-{}", Uuid::new_v4()));
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
                .starts_with("shared-terminal-cleanup-中文-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn sample(root: &ManagedRoot) -> (Uuid, PathBuf) {
    let id = Uuid::new_v4();
    let path = root.path().join(id.to_string());
    fs::create_dir(&path).unwrap();
    for (name, bytes) in [
        ("completion.partial", b"partial".as_slice()),
        ("0000000000000001.rawlog", b"raw"),
        ("0000000000000001.text.jsonl", b"text"),
    ] {
        fs::write(path.join(name), bytes).unwrap();
    }
    (id, path)
}
fn metadata() -> Metadata {
    Metadata {
        connection: ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 3,
        },
        protocol: Protocol::Serial,
        encoding: "utf-8".into(),
        started_at_ms: 1,
        source_cursor: 1,
        text_cursor: 1,
    }
}

#[test]
fn preview_pins_exact_scope_cancel_releases_without_deleting_and_apply_removes_only_that_scope() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let (id, path) = sample(&root);
    let (other, other_path) = sample(&root);
    let preview = root.preview_cleanup(id).unwrap();
    assert_eq!(preview.info().id, id);
    assert_eq!(preview.info().kind, CleanupKind::Log);
    assert_eq!(preview.info().files.len(), 3);
    assert_eq!(preview.info().logical_bytes, 14);
    assert!(root.preview_cleanup(id).is_err());
    assert!(fs::write(path.join("completion.partial"), b"replacement").is_err());
    assert!(fs::rename(&path, root.path().join("renamed")).is_err());
    assert!(storage::pin(&path).is_err());
    drop(preview);
    assert_eq!(
        fs::read(path.join("completion.partial")).unwrap(),
        b"partial"
    );
    let report = root.preview_cleanup(id).unwrap().apply();
    assert_eq!(
        (
            report.removed_files,
            report.removed_logical_bytes,
            report.directory_removed
        ),
        (3, 14, true)
    );
    assert!(report.failure.is_none());
    assert!(!path.exists());
    assert_eq!(root.ids().unwrap(), [other]);
    assert_eq!(
        fs::read(other_path.join("completion.partial")).unwrap(),
        b"partial"
    );
    assert!(root.preview_cleanup(id).is_err());
    assert!(root.preview_cleanup(Uuid::nil()).is_err());
}

#[test]
fn active_writer_and_immutable_reader_block_cleanup_until_all_scope_handles_close() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger =
        Logger::start(root.path().to_path_buf(), meta.clone(), Limits::default()).unwrap();
    let id = logger.status().log_id;
    crate::tests::wait(|| logger.status().phase == crate::Phase::Recording);
    assert!(root.preview_cleanup(id).is_err());
    assert!(logger.join().durable);
    let reader = ArchiveReader::open(&root, id, meta.connection).unwrap();
    assert!(root.preview_cleanup(id).is_err());
    drop(reader);
    let preview = root.preview_cleanup(id).unwrap();
    assert!(ArchiveReader::open(&root, id, meta.connection).is_err());
    assert!(preview.apply().directory_removed);
}

#[test]
fn cleanup_reclaims_full_export_and_log_catalogues_without_replaying_or_touching_source() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let meta = metadata();
    let mut logger =
        Logger::start(root.path().to_path_buf(), meta.clone(), Limits::default()).unwrap();
    let source = logger.join();
    assert!(source.durable);
    let mut store = ExportStore::open(&temp.0).unwrap();
    let mut ids = Vec::new();
    for _ in 0..8 {
        let id = Uuid::new_v4();
        store
            .create(&root, source.log_id, meta.connection, id, || false)
            .unwrap();
        ids.push(id);
    }
    assert_eq!(
        store
            .create(
                &root,
                source.log_id,
                meta.connection,
                Uuid::new_v4(),
                || false
            )
            .unwrap_err()
            .kind(),
        io::ErrorKind::StorageFull
    );
    let preview = store.preview_cleanup(ids[0]).unwrap();
    assert_eq!(preview.info().kind, CleanupKind::Export);
    assert_eq!(preview.info().files.len(), 1);
    assert_eq!(preview.info().files[0].name, "export.jsonl");
    assert!(preview.apply().directory_removed);
    let fresh = Uuid::new_v4();
    store
        .create(&root, source.log_id, meta.connection, fresh, || false)
        .unwrap();
    assert!(
        root.path()
            .join(source.log_id.to_string())
            .join("completion.json")
            .exists()
    );
    for _ in 1..64 {
        fs::create_dir(root.path().join(Uuid::new_v4().to_string())).unwrap();
    }
    let all = root.ids().unwrap();
    assert_eq!(all.len(), 64);
    let empty = *all.iter().find(|id| **id != source.log_id).unwrap();
    let preview = root.preview_cleanup(empty).unwrap();
    assert!(preview.info().files.is_empty());
    assert!(preview.apply().directory_removed);
    assert_eq!(root.ids().unwrap().len(), 63);
}

#[test]
fn unrecognized_subdirectory_readonly_and_overfull_entries_fail_before_any_deletion() {
    for case in 0..4 {
        let temp = Temp::new();
        let root = ManagedRoot::open(&temp.0).unwrap();
        let (id, path) = sample(&root);
        let partial = path.join("completion.partial");
        let original_permissions = fs::metadata(&partial).unwrap().permissions();
        match case {
            0 => fs::write(path.join("unknown"), b"preserve").unwrap(),
            1 => {
                fs::remove_file(&partial).unwrap();
                fs::create_dir(&partial).unwrap();
            }
            2 => {
                let mut permissions = fs::metadata(&partial).unwrap().permissions();
                permissions.set_readonly(true);
                fs::set_permissions(&partial, permissions).unwrap();
            }
            3 => {
                for seq in 2..=18 {
                    fs::write(path.join(format!("{seq:016}.rawlog")), b"raw").unwrap();
                    fs::write(path.join(format!("{seq:016}.text.jsonl")), b"text").unwrap();
                }
            }
            _ => unreachable!(),
        }
        assert!(root.preview_cleanup(id).is_err());
        assert_eq!(
            fs::read(path.join("0000000000000001.rawlog")).unwrap(),
            b"raw"
        );
        if case == 2 {
            fs::set_permissions(&partial, original_permissions).unwrap();
        }
    }
}

#[test]
fn known_malformed_oversized_marker_can_be_explicitly_cleaned_without_reading_contents() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let (id, path) = sample(&root);
    fs::write(path.join("completion.partial"), vec![b'x'; 4096]).unwrap();
    let preview = root.preview_cleanup(id).unwrap();
    assert_eq!(preview.info().logical_bytes, 4103);
    // The completed-reader header/size policy is deliberately not a cleanup
    // eligibility rule; corruption must not force recursive manual deletion.
    let report = preview.apply();
    assert!(report.directory_removed && report.failure.is_none());
    assert_eq!(report.removed_logical_bytes, 4103);
}

#[test]
fn removing_a_previewed_hardlink_does_not_delete_another_name_outside_the_target() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let (id, path) = sample(&root);
    let outside = temp.0.join("outside-target-hardlink");
    fs::hard_link(path.join("0000000000000001.rawlog"), &outside).unwrap();
    let report = root.preview_cleanup(id).unwrap().apply();
    assert!(report.directory_removed && report.failure.is_none());
    assert_eq!(report.removed_logical_bytes, 14);
    assert_eq!(fs::read(outside).unwrap(), b"raw");
}

#[test]
fn changed_namespace_aborts_before_commit_and_partial_storage_failure_reports_exact_prefix() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let (id, path) = sample(&root);
    let preview = root.preview_cleanup(id).unwrap();
    fs::write(path.join("unexpected"), b"preserve").unwrap();
    let changed = preview.apply();
    assert_eq!(changed.failure, Some(CleanupFailure::Changed));
    assert_eq!(changed.removed_files, 0);
    assert_eq!(
        fs::read(path.join("completion.partial")).unwrap(),
        b"partial"
    );
    fs::remove_file(path.join("unexpected")).unwrap();
    let preview = root.preview_cleanup(id).unwrap();
    let first = preview.info().files[0].clone();
    let mut calls = 0;
    let partial = preview.apply_with(|file| {
        calls += 1;
        if calls == 2 {
            Err(io::Error::from_raw_os_error(112))
        } else {
            discard(file)
        }
    });
    assert_eq!(partial.failure, Some(CleanupFailure::Storage));
    assert_eq!(partial.os_code, Some(112));
    assert_eq!(
        (
            partial.removed_files,
            partial.removed_logical_bytes,
            partial.directory_removed
        ),
        (1, first.bytes, false)
    );
    assert!(!path.join(first.name).exists());
    assert_eq!(fs::read_dir(&path).unwrap().count(), 2);
    let remaining = root.preview_cleanup(id).unwrap();
    assert_eq!(remaining.info().files.len(), 2);
    assert!(remaining.apply().directory_removed);
}

#[test]
fn concurrent_extra_name_is_preserved_and_directory_failure_is_not_reported_as_success() {
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let (id, path) = sample(&root);
    let preview = root.preview_cleanup(id).unwrap();
    let total = preview.info().files.len();
    let mut calls = 0;
    let report = preview.apply_with(|file| {
        calls += 1;
        if calls == total {
            fs::write(path.join("external-sentinel"), b"preserve").unwrap();
        }
        discard(file)
    });
    assert_eq!(report.removed_files, total as u32);
    assert!(!report.directory_removed);
    assert_eq!(report.failure, Some(CleanupFailure::Storage));
    assert_eq!(report.os_code, Some(145));
    assert_eq!(
        fs::read(path.join("external-sentinel")).unwrap(),
        b"preserve"
    );
    assert!(root.preview_cleanup(id).is_err());
}

#[test]
fn directory_and_file_junctions_are_rejected_without_following_or_touching_targets() {
    fn junction(temp: &Temp, link: &Path, target: &Path) {
        assert!(link.starts_with(&temp.0) && target.starts_with(&temp.0));
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "isolated junction fixture must be created"
        );
    }
    let temp = Temp::new();
    let root = ManagedRoot::open(&temp.0).unwrap();
    let target = temp.0.join("isolated-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("sentinel"), b"preserve").unwrap();
    let id = Uuid::new_v4();
    let link = root.path().join(id.to_string());
    junction(&temp, &link, &target);
    assert!(root.preview_cleanup(id).is_err());
    fs::remove_dir(&link).unwrap();
    let (id, path) = sample(&root);
    let file = path.join("completion.partial");
    fs::remove_file(&file).unwrap();
    junction(&temp, &file, &target);
    assert!(root.preview_cleanup(id).is_err());
    fs::remove_dir(file).unwrap();
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"preserve");
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
}
