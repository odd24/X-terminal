use config_store::*;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use uuid::Uuid;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-config-test-{}", Uuid::new_v4()));
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
