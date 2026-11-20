use config_store::*;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use uuid::Uuid;
#[path = "support/quick_commands.rs"]
mod quick_command_tests;
#[path = "support/workspaces.rs"]
mod workspace_tests;

#[path = "support/batch.rs"]
mod batch_tests;

#[path = "support/import.rs"]
mod import_tests;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-config-test-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        // Only this explicitly created test directory is removed.
        assert!(self.0.parent() == Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn profile() -> Profile {
    Profile {
        id: Uuid::new_v4(),
        folder_id: None,
        name: "测试 SSH2".into(),
        credential_ref: Some(Uuid::new_v4()),
        settings: Settings::Ssh2 {
            host: "example.invalid".into(),
            port: 22,
            username: "synthetic-user".into(),
            auth: Auth::Password,
            encoding: Encoding::Utf8,
        },
    }
}
fn v1(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE folders(id TEXT PRIMARY KEY NOT NULL,parent_id TEXT REFERENCES folders(id),name TEXT NOT NULL); CREATE TABLE profiles(id TEXT PRIMARY KEY NOT NULL,folder_id TEXT REFERENCES folders(id),name TEXT NOT NULL,credential_ref TEXT,settings TEXT NOT NULL); PRAGMA application_id=1398035533; PRAGMA user_version=1;").unwrap();
}

#[test]
fn restart_crud_and_portable_export_exclude_credential_reference() {
    let temp = Temp::new();
    let path = temp.path("config.sqlite");
    let mut store = Store::open(&path).unwrap();
    let root = Folder {
        id: Uuid::new_v4(),
        parent_id: None,
        name: "设备组".into(),
    };
    store.put_folder(root.clone()).unwrap();
    let mut p = profile();
    p.folder_id = Some(root.id);
    store.put_profile(p.clone()).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.profiles().unwrap(), vec![p.clone()]);
    assert_eq!(store.folders().unwrap(), vec![root.clone()]);
    p.name = "renamed".into();
    store.put_profile(p.clone()).unwrap();
    assert_eq!(store.profiles().unwrap()[0].name, "renamed");
    let exported = serde_json::to_string(&store.export().unwrap()).unwrap();
    assert!(!exported.contains("credential_ref"));
    assert!(!exported.contains(&p.credential_ref.unwrap().to_string()));
    assert_eq!(
        serde_json::from_str::<Snapshot>(&exported)
            .unwrap()
            .profiles
            .len(),
        1
    );
    assert!(
        store.delete_folder(root.id).is_err(),
        "referenced folders cannot be silently deleted"
    );
    store.delete_profile(p.id).unwrap();
    store.delete_folder(root.id).unwrap();
    assert!(matches!(store.delete_profile(p.id), Err(Error::NotFound)));
}

#[test]
fn hierarchy_cycles_missing_parents_and_invalid_profiles_leave_state_unchanged() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.path("config.sqlite")).unwrap();
    let root = Folder {
        id: Uuid::new_v4(),
        parent_id: None,
        name: "root".into(),
    };
    let child = Folder {
        id: Uuid::new_v4(),
        parent_id: Some(root.id),
        name: "child".into(),
    };
    store.put_folder(root.clone()).unwrap();
    store.put_folder(child.clone()).unwrap();
    let before = store.folders().unwrap();
    assert!(
        store
            .put_folder(Folder {
                parent_id: Some(child.id),
                ..root.clone()
            })
            .is_err()
    );
    assert!(
        store
            .put_folder(Folder {
                parent_id: Some(child.id),
                ..child.clone()
            })
            .is_err()
    );
    assert!(
        store
            .put_folder(Folder {
                parent_id: Some(Uuid::new_v4()),
                ..child
            })
            .is_err()
    );
    assert_eq!(store.folders().unwrap(), before);
    let mut p = profile();
    p.folder_id = Some(Uuid::new_v4());
    assert!(store.put_profile(p).is_err());
    let mut p = profile();
    p.settings = Settings::Ssh1 {
        host: "example.invalid".into(),
        port: 22,
        username: "test".into(),
        explicitly_enabled: false,
        encoding: Encoding::Gbk,
    };
    assert!(store.put_profile(p).is_err());
    assert!(store.profiles().unwrap().is_empty());
}

#[test]
fn all_protocols_validate_without_opening_any_device() {
    let mut p = profile();
    p.credential_ref = None;
    p.settings = Settings::Serial {
        port: "COM89".into(),
        baud_rate: 115200,
        data_bits: 8,
        stop_bits: 1,
        parity: Parity::None,
        flow: Flow::None,
        dtr_on_open: false,
        rts_on_open: Some(false),
        encoding: Encoding::Gb18030,
    };
    p.validate().unwrap();
    if let Settings::Serial { flow, .. } = &mut p.settings {
        *flow = Flow::Hardware;
    }
    assert!(p.validate().is_err());
    if let Settings::Serial { rts_on_open, .. } = &mut p.settings {
        *rts_on_open = None;
    }
    p.validate().unwrap();
    for port_name in [
        "",
        "C",
        "COM0",
        "COM65536",
        "COM1x",
        "\\\\.\\COM89",
        "COM-1",
    ] {
        if let Settings::Serial { port, .. } = &mut p.settings {
            *port = port_name.into();
        }
        assert!(p.validate().is_err());
    }
    p.settings = Settings::Ssh1 {
        host: "example.invalid".into(),
        port: 22,
        username: "test".into(),
        explicitly_enabled: true,
        encoding: Encoding::Gbk,
    };
    p.validate().unwrap();
    let mut value = serde_json::to_value(&p).unwrap();
    value["password"] = serde_json::json!("synthetic");
    assert!(serde_json::from_value::<Profile>(value).is_err());
    let mut value = serde_json::to_value(&p).unwrap();
    value["settings"]["password"] = serde_json::json!("synthetic");
    assert!(serde_json::from_value::<Profile>(value).is_err());
}

#[test]
fn migration_backups_are_pre_migration_and_failure_rolls_back_ddl() {
    let temp = Temp::new();
    let path = temp.path("v1.sqlite");
    v1(&path);
    let store = Store::open(&path).unwrap();
    let backup = store.migration_backup.as_ref().unwrap();
    let conn = Connection::open(backup).unwrap();
    assert_eq!(
        conn.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        1
    );
    drop(conn);
    drop(store);
    assert!(Store::open(&path).unwrap().migration_backup.is_none());
    let fail = temp.path("fail.sqlite");
    v1(&fail);
    let conn = Connection::open(&fail).unwrap();
    conn.execute_batch("CREATE TABLE schema_migrations(incompatible TEXT)")
        .unwrap();
    drop(conn);
    assert!(Store::open(&fail).is_err());
    let conn = Connection::open(&fail).unwrap();
    assert_eq!(
        conn.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        1
    );
    let host_keys: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='host_keys'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        host_keys, 0,
        "first migration DDL must roll back after later DDL failure"
    );
    assert!(
        std::fs::read_dir(&temp.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e
                .file_name()
                .to_string_lossy()
                .starts_with("config-before-v1"))
            .count()
            >= 2
    );
}

#[test]
fn unknown_corrupt_and_semantically_invalid_files_are_not_overwritten() {
    let temp = Temp::new();
    for (name, sql) in [
        ("newer", "PRAGMA user_version=999"),
        ("foreign", "PRAGMA application_id=1"),
        (
            "bad-profile",
            "INSERT INTO profiles VALUES('not-a-uuid',NULL,'bad',NULL,'{}')",
        ),
    ] {
        let path = temp.path(name);
        v1(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(sql).unwrap();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
    let path = temp.path("corrupt");
    std::fs::write(&path, b"not a SQLite file; synthetic").unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(std::fs::read(path).unwrap(), before);
    let path = temp.path("empty");
    std::fs::write(&path, []).unwrap();
    assert!(matches!(Store::open(&path), Err(Error::Schema)));
    assert!(std::fs::read(path).unwrap().is_empty());
}

#[test]
fn backup_restore_is_consistent_and_refuses_overwrite() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.path("config")).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let backup = temp.path("backup");
    store.backup(&backup).unwrap();
    let bytes = std::fs::read(&backup).unwrap();
    assert!(store.backup(&backup).is_err());
    assert_eq!(std::fs::read(&backup).unwrap(), bytes);
    store.delete_profile(p.id).unwrap();
    let target = temp.path("restored");
    let restored = Store::restore_to_new(&backup, &target).unwrap();
    assert_eq!(restored.profiles().unwrap(), vec![p]);
    assert!(Store::restore_to_new(&backup, &target).is_err());
    assert_eq!(std::fs::read(&backup).unwrap(), bytes);
}

#[test]
fn host_key_assessment_is_persistent_scoped_and_requires_current_approval_revision() {
    let temp = Temp::new();
    let path = temp.path("config");
    let mut store = Store::open(&path).unwrap();
    let endpoint = HostEndpoint {
        protocol: HostProtocol::Ssh2,
        host: "Example.INVALID".into(),
        port: 22,
    };
    let first = HostKey {
        endpoint: endpoint.clone(),
        algorithm: "ssh-ed25519".into(),
        key: b"abc".to_vec(),
    };
    let review = store.review_host_key(&first).unwrap();
    assert_eq!(review.status, HostKeyStatus::Unknown);
    assert_eq!(
        review.candidate.fingerprint,
        "SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0"
    );
    assert!(
        store.host_keys().unwrap().is_empty(),
        "review must not silently trust a key"
    );
    assert!(matches!(
        store.approve_host_key(first.clone(), "stale"),
        Err(Error::Conflict)
    ));
    assert!(store.host_keys().unwrap().is_empty());
    assert!(
        store
            .approve_host_key(first.clone(), &review.revision)
            .unwrap()
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let known = store.review_host_key(&first).unwrap();
    assert_eq!(known.status, HostKeyStatus::Known);
    assert!(
        !store
            .approve_host_key(first.clone(), &known.revision)
            .unwrap()
    );
    let changed = HostKey {
        key: b"different-key".to_vec(),
        ..first.clone()
    };
    let pending = store.review_host_key(&changed).unwrap();
    assert_eq!(pending.status, HostKeyStatus::Changed);
    assert_eq!(
        store.review_host_key(&first).unwrap().status,
        HostKeyStatus::Known,
        "change assessment cannot replace trust"
    );
    let extra = HostKey {
        algorithm: "ssh-rsa".into(),
        key: b"other-algorithm".to_vec(),
        ..first.clone()
    };
    let other = store.review_host_key(&extra).unwrap();
    assert_eq!(other.status, HostKeyStatus::Changed);
    store.approve_host_key(extra, &other.revision).unwrap();
    assert!(
        matches!(
            store.approve_host_key(changed.clone(), &pending.revision),
            Err(Error::Conflict)
        ),
        "another approved algorithm invalidates previous confirmation"
    );
    let fresh = store.review_host_key(&changed).unwrap();
    store
        .approve_host_key(changed.clone(), &fresh.revision)
        .unwrap();
    assert_eq!(
        store.review_host_key(&first).unwrap().status,
        HostKeyStatus::Changed
    );
    assert!(
        matches!(
            store.forget_host_key(&endpoint, "ssh-ed25519", &known.candidate.fingerprint),
            Err(Error::Conflict)
        ),
        "stale UI delete cannot remove changed key"
    );
    let current = store.review_host_key(&changed).unwrap();
    store
        .forget_host_key(&endpoint, "ssh-ed25519", &current.candidate.fingerprint)
        .unwrap();
    assert_eq!(store.host_keys().unwrap().len(), 1);
    let mut other_scope = first.clone();
    other_scope.endpoint.port = 2222;
    assert_eq!(
        store.review_host_key(&other_scope).unwrap().status,
        HostKeyStatus::Unknown
    );
    other_scope.endpoint.port = 22;
    other_scope.endpoint.protocol = HostProtocol::Ssh1;
    assert_eq!(
        store.review_host_key(&other_scope).unwrap().status,
        HostKeyStatus::Unknown
    );
}

#[test]
fn malformed_and_oversized_host_keys_are_rejected_without_config_writes() {
    let temp = Temp::new();
    let path = temp.path("config");
    let mut store = Store::open(&path).unwrap();
    for (host, algorithm, key) in [
        ("example.invalid", "ssh-ed25519", vec![]),
        ("bad host", "ssh-ed25519", vec![1]),
        ("example.invalid", "ssh\nkey", vec![1]),
        ("example.invalid", "ssh-ed25519", vec![1; 16385]),
    ] {
        let candidate = HostKey {
            endpoint: HostEndpoint {
                protocol: HostProtocol::Ssh2,
                host: host.into(),
                port: 22,
            },
            algorithm: algorithm.into(),
            key,
        };
        assert!(store.review_host_key(&candidate).is_err());
        assert!(store.approve_host_key(candidate, "any").is_err());
    }
    assert!(store.host_keys().unwrap().is_empty());
    drop(store);
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO host_keys VALUES('ssh2','example.invalid',22,'ssh-ed25519',zeroblob(16385))",
        [],
    )
    .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(Store::open(&path), Err(Error::Corrupt)));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn concurrent_host_key_approvals_cannot_both_use_the_same_confirmation() {
    let temp = Temp::new();
    let path = temp.path("config");
    drop(Store::open(&path).unwrap());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut workers = Vec::new();
    for marker in [1u8, 2u8] {
        let path = path.clone();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            let mut store = Store::open(&path).unwrap();
            let candidate = HostKey {
                endpoint: HostEndpoint {
                    protocol: HostProtocol::Ssh2,
                    host: "race.invalid".into(),
                    port: 22,
                },
                algorithm: "ssh-ed25519".into(),
                key: vec![marker],
            };
            let review = store.review_host_key(&candidate).unwrap();
            assert_eq!(review.status, HostKeyStatus::Unknown);
            barrier.wait();
            store.approve_host_key(candidate, &review.revision)
        }));
    }
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|value| matches!(value, Ok(true)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|value| matches!(value, Err(Error::Conflict)))
            .count(),
        1
    );
    assert_eq!(Store::open(&path).unwrap().host_keys().unwrap().len(), 1);
}

#[test]
fn checked_image_restore_preserves_a_safety_copy_and_restores_refs_and_trust() {
    let temp = Temp::new();
    let path = temp.path("config");
    let mut store = Store::open(&path).unwrap();
    let root = Folder {
        id: Uuid::new_v4(),
        parent_id: None,
        name: "Z parent".into(),
    };
    let child = Folder {
        id: Uuid::new_v4(),
        parent_id: Some(root.id),
        name: "A child".into(),
    };
    store.put_folder(root.clone()).unwrap();
    store.put_folder(child.clone()).unwrap();
    let mut p = profile();
    p.folder_id = Some(child.id);
    store.put_profile(p.clone()).unwrap();
    let key = HostKey {
        endpoint: HostEndpoint {
            protocol: HostProtocol::Ssh2,
            host: "backup.invalid".into(),
            port: 22,
        },
        algorithm: "ssh-ed25519".into(),
        key: b"backup public key".to_vec(),
    };
    let review = store.review_host_key(&key).unwrap();
    store
        .approve_host_key(key.clone(), &review.revision)
        .unwrap();
    let backup = temp.path("backup");
    store.backup(&backup).unwrap();
    let image = Store::read_backup(&backup).unwrap();
    let digest = image.digest().unwrap();
    p.name = "current after backup".into();
    store.put_profile(p.clone()).unwrap();
    let current_digest = store.image().unwrap().digest().unwrap();
    assert!(matches!(
        store.restore_image(&image, "stale", &temp.path("not-created")),
        Err(Error::Conflict)
    ));
    assert!(!temp.path("not-created").exists());
    assert_eq!(store.image().unwrap().digest().unwrap(), current_digest);
    let safety = temp.path("safety");
    store.restore_image(&image, &digest, &safety).unwrap();
    assert_eq!(
        Store::read_backup(&safety).unwrap().digest().unwrap(),
        current_digest
    );
    assert_eq!(store.image().unwrap().digest().unwrap(), digest);
    assert_eq!(
        store.profiles().unwrap()[0].credential_ref,
        p.credential_ref
    );
    assert_eq!(store.host_keys().unwrap().len(), 1);
    assert!(
        store.restore_image(&image, &digest, &safety).is_err(),
        "safety copies must never overwrite"
    );
    assert_eq!(store.image().unwrap().digest().unwrap(), digest);
    let source_before = std::fs::read(&backup).unwrap();
    drop(store);
    assert_eq!(
        Store::open(&path)
            .unwrap()
            .image()
            .unwrap()
            .digest()
            .unwrap(),
        digest
    );
    assert_eq!(std::fs::read(&backup).unwrap(), source_before);
}

#[test]
fn image_restore_rolls_back_after_mid_transaction_failure_and_rejects_bad_sources() {
    let temp = Temp::new();
    let path = temp.path("config");
    let mut store = Store::open(&path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let current = store.image().unwrap();
    let before = current.digest().unwrap();
    let mut replacement = current.clone();
    replacement.profiles[0].name = "force failure".into();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_new_profile BEFORE INSERT ON profiles BEGIN SELECT RAISE(ABORT,'synthetic injected failure'); END;").unwrap();
    drop(conn);
    let safety = temp.path("safety");
    assert!(
        store
            .restore_image(&replacement, &replacement.digest().unwrap(), &safety)
            .is_err()
    );
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    assert_eq!(
        Store::read_backup(&safety).unwrap().digest().unwrap(),
        before
    );
    let newer = temp.path("newer");
    store.backup(&newer).unwrap();
    let conn = Connection::open(&newer).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    let newer_before = std::fs::read(&newer).unwrap();
    assert!(matches!(Store::read_backup(&newer), Err(Error::Schema)));
    assert_eq!(std::fs::read(&newer).unwrap(), newer_before);
    let bad = temp.path("bad");
    std::fs::write(&bad, b"synthetic corrupt backup").unwrap();
    assert!(Store::read_backup(&bad).is_err());
    assert_eq!(std::fs::read(&bad).unwrap(), b"synthetic corrupt backup");
    let mut invalid = current;
    invalid.profiles[0].folder_id = Some(Uuid::new_v4());
    assert!(
        store
            .restore_image(
                &invalid,
                &invalid.digest().unwrap(),
                &temp.path("not-created")
            )
            .is_err()
    );
    assert!(!temp.path("not-created").exists());
}

#[test]
fn changed_backup_preview_and_live_newer_schema_cannot_be_restored_over() {
    let temp = Temp::new();
    let path = temp.path("config");
    let mut store = Store::open(&path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let backup = temp.path("backup");
    store.backup(&backup).unwrap();
    let approved = Store::read_backup(&backup).unwrap();
    let expected = approved.digest().unwrap();
    let mut changed = Store::open(&backup).unwrap();
    let mut replacement = p;
    replacement.name = "changed since preview".into();
    changed.put_profile(replacement).unwrap();
    drop(changed);
    let fresh = Store::read_backup(&backup).unwrap();
    assert_ne!(fresh.digest().unwrap(), expected);
    assert!(matches!(
        store.restore_image(&fresh, &expected, &temp.path("not-created")),
        Err(Error::Conflict)
    ));
    assert!(!temp.path("not-created").exists());
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        store.restore_image(&approved, &expected, &temp.path("also-not-created")),
        Err(Error::Schema)
    ));
    assert!(!temp.path("also-not-created").exists());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn open_store_refuses_mutations_after_external_schema_or_application_change() {
    let temp = Temp::new();
    let path = temp.path("live-version.sqlite");
    let mut store = Store::open(&path).unwrap();
    let folder = Folder {
        id: Uuid::new_v4(),
        parent_id: None,
        name: "existing folder".into(),
    };
    store.put_folder(folder.clone()).unwrap();
    let saved = profile();
    store.put_profile(saved.clone()).unwrap();
    let key = HostKey {
        endpoint: HostEndpoint {
            protocol: HostProtocol::Ssh2,
            host: "example.invalid".into(),
            port: 22,
        },
        algorithm: "ssh-ed25519".into(),
        key: b"synthetic approved public key".to_vec(),
    };
    let review = store.review_host_key(&key).unwrap();
    store
        .approve_host_key(key.clone(), &review.revision)
        .unwrap();
    let fingerprint = store.host_keys().unwrap()[0].fingerprint.clone();
    for pragma in [
        "PRAGMA user_version=99",
        "PRAGMA user_version=1",
        "PRAGMA user_version=2;PRAGMA application_id=7",
    ] {
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(pragma).unwrap();
        drop(connection);
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            matches!(
                store.put_folder(Folder {
                    name: "must not write".into(),
                    ..folder.clone()
                }),
                Err(Error::Schema)
            ),
            "{pragma}: put_folder"
        );
        assert!(
            matches!(
                store.put_profile(Profile {
                    name: "must not write".into(),
                    ..saved.clone()
                }),
                Err(Error::Schema)
            ),
            "{pragma}: put_profile"
        );
        assert!(
            matches!(store.delete_profile(saved.id), Err(Error::Schema)),
            "{pragma}: delete_profile"
        );
        assert!(
            matches!(store.delete_folder(folder.id), Err(Error::Schema)),
            "{pragma}: delete_folder"
        );
        assert!(
            matches!(
                store.approve_host_key(key.clone(), &review.revision),
                Err(Error::Schema)
            ),
            "{pragma}: approve_host_key"
        );
        assert!(
            matches!(
                store.forget_host_key(&key.endpoint, &key.algorithm, &fingerprint),
                Err(Error::Schema)
            ),
            "{pragma}: forget_host_key"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "{pragma}: original bytes changed"
        );
    }
}

fn make_v2(path: &Path) {
    let mut store = Store::open(path).unwrap();
    store.put_profile(profile()).unwrap();
    drop(store);
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("DROP TABLE quick_commands; DROP TABLE workspaces; DROP TABLE desktop_preferences; DELETE FROM schema_migrations WHERE version>=3; PRAGMA user_version=2").unwrap();
}
#[test]
fn preferences_v2_migration_and_readonly_old_backup_preserve_original() {
    let temp = Temp::new();
    let path = temp.path("旧版.sqlite");
    make_v2(&path);
    let before = std::fs::read(&path).unwrap();
    let image = Store::read_backup(&path).unwrap();
    assert_eq!(image.preferences, DesktopPreferences::default());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let store = Store::open(&path).unwrap();
    let backup = store.migration_backup.as_ref().unwrap();
    assert_eq!(
        Store::read_backup(backup).unwrap().digest().unwrap(),
        image.digest().unwrap()
    );
    let backup_conn = Connection::open(backup).unwrap();
    assert_eq!(
        backup_conn
            .pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        2
    );
    assert_eq!(
        backup_conn
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM sqlite_master WHERE name='desktop_preferences'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
    drop(backup_conn);
    assert_eq!(store.preferences().unwrap(), DesktopPreferences::default());
    assert_eq!(
        Connection::open(&path)
            .unwrap()
            .pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    drop(store);
    assert!(Store::open(&path).unwrap().migration_backup.is_none());
    let fail = temp.path("迁移失败.sqlite");
    make_v2(&fail);
    Connection::open(&fail)
        .unwrap()
        .execute_batch("CREATE TABLE desktop_preferences(incompatible TEXT)")
        .unwrap();
    let before = std::fs::read(&fail).unwrap();
    assert!(Store::open(&fail).is_err());
    assert_eq!(std::fs::read(&fail).unwrap(), before);
}
#[test]
fn preferences_restart_directory_isolation_backup_digest_and_transactional_restore() {
    let temp = Temp::new();
    let path = temp.path("first.sqlite");
    let mut store = Store::open(&path).unwrap();
    let original = store.image().unwrap();
    let expected_fresh = DesktopPreferences {
        theme: ThemeChoice::Light,
        terminal_palette: TerminalPalette::BlackWhite,
        ..DesktopPreferences::default()
    };
    assert_eq!(original.preferences, expected_fresh);
    let changed = DesktopPreferences {
        theme: ThemeChoice::Light,
        terminal_font: TerminalFont::Cascadia,
        terminal_palette: config_model::TerminalPalette::BlackGreen,
        font_size: 28,
        ctrl_c_copy: false,
        ctrl_v_paste: true,
        right_click_paste: true,
    };
    store.put_preferences(&changed).unwrap();
    assert_ne!(
        store.image().unwrap().digest().unwrap(),
        original.digest().unwrap()
    );
    assert_eq!(
        Store::open(&temp.path("second.sqlite"))
            .unwrap()
            .preferences()
            .unwrap(),
        expected_fresh
    );
    // Portable connection exchange excludes desktop preferences.
    assert!(
        !serde_json::to_string(&store.export().unwrap())
            .unwrap()
            .contains("preferences")
    );
    let backup = temp.path("backup.sqlite");
    store.backup(&backup).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.preferences().unwrap(), changed);
    let backed = Store::read_backup(&backup).unwrap();
    assert_eq!(backed.preferences, changed);
    store
        .restore_image(
            &original,
            &original.digest().unwrap(),
            &temp.path("安全.sqlite"),
        )
        .unwrap();
    assert_eq!(store.preferences().unwrap(), expected_fresh);
    assert_eq!(
        Store::read_backup(&temp.path("安全.sqlite"))
            .unwrap()
            .preferences,
        changed
    );
    let mut altered = backed.clone();
    altered.preferences.font_size = 27;
    assert!(matches!(
        store.restore_image(
            &altered,
            &backed.digest().unwrap(),
            &temp.path("未创建.sqlite")
        ),
        Err(Error::Conflict)
    ));
    assert!(!temp.path("未创建.sqlite").exists());
    assert_eq!(store.preferences().unwrap(), expected_fresh);
}
#[test]
fn invalid_corrupt_missing_and_external_newer_preferences_do_not_silently_reset() {
    let temp = Temp::new();
    let path = temp.path("config.sqlite");
    let mut store = Store::open(&path).unwrap();
    let original = store.preferences().unwrap();
    for size in [0, 9, 29, 255] {
        assert!(
            store
                .put_preferences(&DesktopPreferences {
                    font_size: size,
                    ..Default::default()
                })
                .is_err()
        );
        assert_eq!(store.preferences().unwrap(), original);
    }
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("PRAGMA user_version=99").unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        store.put_preferences(&Default::default()),
        Err(Error::Schema)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    sql.pragma_update(None, "user_version", SCHEMA_VERSION)
        .unwrap();
    drop(store);
    let valid = serde_json::to_value(DesktopPreferences::default()).unwrap();
    for value in [
        serde_json::json!({}),
        {
            let mut v = valid.clone();
            v["font_size"] = 29.into();
            v
        },
        {
            let mut v = valid.clone();
            v["theme"] = "unknown".into();
            v
        },
        {
            let mut v = valid.clone();
            v["text"] = "must not persist".into();
            v
        },
    ] {
        sql.execute(
            "UPDATE desktop_preferences SET value=?1",
            [value.to_string()],
        )
        .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    sql.execute_batch("DELETE FROM desktop_preferences")
        .unwrap();
    assert!(Store::open(&path).is_err());
}

#[test]
fn preference_restore_failure_rolls_back_other_configuration_tables() {
    let temp = Temp::new();
    let path = temp.path("事务.sqlite");
    let mut store = Store::open(&path).unwrap();
    let original = store.image().unwrap();
    let current = profile();
    store.put_profile(current.clone()).unwrap();
    store
        .put_preferences(&DesktopPreferences {
            font_size: 20,
            ..Default::default()
        })
        .unwrap();
    let before = store.image().unwrap().digest().unwrap();
    Connection::open(&path).unwrap().execute_batch("CREATE TRIGGER fail_preference_restore BEFORE UPDATE ON desktop_preferences BEGIN SELECT RAISE(ABORT,'synthetic restore failure'); END").unwrap();
    assert!(
        store
            .restore_image(
                &original,
                &original.digest().unwrap(),
                &temp.path("安全.sqlite")
            )
            .is_err()
    );
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    assert_eq!(store.profiles().unwrap(), vec![current.clone()]);
    assert_eq!(
        Store::read_backup(&temp.path("安全.sqlite"))
            .unwrap()
            .digest()
            .unwrap(),
        before
    );

    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TRIGGER fail_preference_restore; DELETE FROM desktop_preferences")
        .unwrap();
    assert!(matches!(
        store.restore_image(
            &original,
            &original.digest().unwrap(),
            &temp.path("缺行安全.sqlite")
        ),
        Err(Error::Corrupt)
    ));
    assert_eq!(store.profiles().unwrap(), vec![current]);
}

// Build an actual pre-palette database, including its original strict JSON shape.
fn make_v3(path: &Path) -> DesktopPreferences {
    let mut store = Store::open(path).unwrap();
    let preferences = DesktopPreferences {
        theme: ThemeChoice::Light,
        font_size: 24,
        ctrl_v_paste: true,
        ..Default::default()
    };
    store.put_profile(profile()).unwrap();
    store.put_preferences(&preferences).unwrap();
    drop(store);
    let mut value = serde_json::to_value(&preferences).unwrap();
    value.as_object_mut().unwrap().remove("terminal_palette");
    let sql = Connection::open(path).unwrap();
    sql.execute(
        "UPDATE desktop_preferences SET value=?1",
        [value.to_string()],
    )
    .unwrap();
    sql.execute_batch("DROP TABLE quick_commands; DROP TABLE workspaces; DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3")
        .unwrap();
    preferences
}
#[test]
fn palette_migrates_v3_and_old_backup_is_read_only_with_existing_preferences() {
    let temp = Temp::new();
    let path = temp.path("旧配色.sqlite");
    let expected = make_v3(&path);
    let before = std::fs::read(&path).unwrap();
    let image = Store::read_backup(&path).unwrap();
    assert_eq!(image.preferences, expected);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.preferences().unwrap(), expected);
    let backup = store.migration_backup.as_ref().unwrap().clone();
    assert_eq!(
        Store::read_backup(&backup).unwrap().digest().unwrap(),
        image.digest().unwrap()
    );
    let old = Connection::open(&backup).unwrap();
    assert_eq!(
        old.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        3
    );
    let old_json: String = old
        .query_row("SELECT value FROM desktop_preferences", [], |r| r.get(0))
        .unwrap();
    assert!(!old_json.contains("terminal_palette"));
    drop(old);
    let mut changed = expected.clone();
    changed.terminal_palette = TerminalPalette::BlackGreen;
    store.put_preferences(&changed).unwrap();
    assert_ne!(
        store.image().unwrap().digest().unwrap(),
        image.digest().unwrap()
    );
    store
        .restore_image(
            &image,
            &image.digest().unwrap(),
            &temp.path("安全副本.sqlite"),
        )
        .unwrap();
    assert_eq!(store.preferences().unwrap(), expected);
    assert_eq!(
        Store::read_backup(&temp.path("安全副本.sqlite"))
            .unwrap()
            .preferences,
        changed
    );
    drop(store);
    assert!(Store::open(&path).unwrap().migration_backup.is_none());
    assert_eq!(Store::read_backup(&backup).unwrap().preferences, expected);
}
#[test]
fn palette_migration_failure_preserves_v3_and_current_missing_field_is_corrupt() {
    let temp = Temp::new();
    let path = temp.path("失败.sqlite");
    make_v3(&path);
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_palette_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=4 BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END").unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        3
    );
    let json: String = sql
        .query_row("SELECT value FROM desktop_preferences", [], |r| r.get(0))
        .unwrap();
    assert!(!json.contains("terminal_palette"));
    sql.execute_batch("DROP TRIGGER fail_palette_migration; PRAGMA user_version=4")
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn duplicate_preference_fields_are_rejected_for_both_legacy_and_current_versions() {
    let temp = Temp::new();
    for version in [3, SCHEMA_VERSION] {
        let path = temp.path(&format!("重复字段-{version}.sqlite"));
        if version == 3 {
            make_v3(&path);
        } else {
            drop(Store::open(&path).unwrap());
        }
        let sql = Connection::open(&path).unwrap();
        let json: String = sql
            .query_row("SELECT value FROM desktop_preferences", [], |r| r.get(0))
            .unwrap();
        let duplicate = json.replacen('{', "{\"theme\":\"dark\",", 1);
        sql.execute("UPDATE desktop_preferences SET value=?1", [duplicate])
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err());
        assert!(Store::read_backup(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn ignored_palette_update_cannot_commit_a_new_version_with_old_json() {
    let temp = Temp::new();
    let path = temp.path("忽略更新.sqlite");
    make_v3(&path);
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER ignore_palette BEFORE UPDATE ON desktop_preferences BEGIN SELECT RAISE(IGNORE); END").unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(Store::open(&path), Err(Error::Corrupt)));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        3
    );
    assert_eq!(
        sql.query_row::<i64, _, _>(
            "SELECT count(*) FROM schema_migrations WHERE version=4",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
}
