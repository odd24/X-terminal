use super::*;
fn layout(profile_id: Uuid) -> Workspace {
    let group = Uuid::new_v4();
    let first = Uuid::new_v4();
    Workspace {
        id: Uuid::new_v4(),
        name: "日常工作".into(),
        groups: vec![WorkspaceGroup {
            id: group,
            name: "服务器".into(),
        }],
        tabs: vec![
            WorkspaceTab {
                id: first,
                profile_id,
                group_id: Some(group),
            },
            WorkspaceTab {
                id: Uuid::new_v4(),
                profile_id,
                group_id: None,
            },
        ],
        selected_tab: Some(first),
        navigation_open: true,
        split: None,
    }
}
#[test]
fn layouts_are_bounded_metadata_and_transactional_backup_images_include_them() {
    let temp = Temp::new();
    let path = temp.path("布局.sqlite");
    let mut store = Store::open(&path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let w = layout(p.id);
    store.put_workspace(&w).unwrap();
    let image = store.image().unwrap();
    let digest = image.digest().unwrap();
    let mut changed = w.clone();
    changed.groups[0].name = "设备".into();
    store.put_workspace(&changed).unwrap();
    assert_ne!(store.image().unwrap().digest().unwrap(), digest);
    store
        .restore_image(&image, &digest, &temp.path("安全副本.sqlite"))
        .unwrap();
    assert_eq!(store.workspaces().unwrap(), vec![w.clone()]);
    assert_eq!(
        Store::read_backup(&temp.path("安全副本.sqlite"))
            .unwrap()
            .workspaces,
        vec![changed]
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.workspaces().unwrap(), vec![w.clone()]);
    for _ in 1..8 {
        store.put_workspace(&layout(p.id)).unwrap();
    }
    assert!(store.put_workspace(&layout(p.id)).is_err());
    store.put_workspace(&w).unwrap();
    let before = store.image().unwrap().digest().unwrap();
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch(
        "CREATE TRIGGER ignore_layout BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(IGNORE); END",
    )
    .unwrap();
    let mut wrong = w.clone();
    wrong.name = "ignored".into();
    assert!(store.put_workspace(&wrong).is_err());
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    sql.execute_batch("DROP TRIGGER ignore_layout").unwrap();
    store.delete_workspace(w.id).unwrap();
    assert_eq!(store.workspaces().unwrap().len(), 7);
    // Deleting a saved profile leaves an explicit dangling layout reference, never recreates it.
    store.delete_profile(p.id).unwrap();
    assert!(store.profile(p.id).unwrap().is_none());
    assert_eq!(store.workspaces().unwrap().len(), 7);
    assert!(store.put_workspace(&layout(p.id)).is_err());
}
fn v4(path: &Path) {
    drop(Store::open(path).unwrap());
    let sql = Connection::open(path).unwrap();
    sql.execute_batch(
        "DROP TABLE workspaces;DELETE FROM schema_migrations WHERE version>=5;PRAGMA user_version=4",
    )
    .unwrap();
}
#[test]
fn ignored_workspace_restore_rolls_back_all_metadata_and_keeps_the_safety_copy() {
    let temp = Temp::new();
    let path = temp.path("忽略恢复.sqlite");
    let mut store = Store::open(&path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let original = layout(p.id);
    store.put_workspace(&original).unwrap();
    let image = store.image().unwrap();
    let mut changed = original.clone();
    changed.name = "当前布局".into();
    store.put_workspace(&changed).unwrap();
    let before = store.image().unwrap().digest().unwrap();
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch(
        "CREATE TRIGGER ignore_restore BEFORE INSERT ON workspaces BEGIN SELECT RAISE(IGNORE);END",
    )
    .unwrap();
    let safety = temp.path("保留副本.sqlite");
    assert!(
        store
            .restore_image(&image, &image.digest().unwrap(), &safety)
            .is_err()
    );
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    assert_eq!(
        Store::read_backup(&safety).unwrap().workspaces,
        vec![changed]
    );
}
#[test]
fn schema4_backup_is_read_only_and_migration_is_backed_up_or_rolled_back() {
    let temp = Temp::new();
    let path = temp.path("v4.sqlite");
    v4(&path);
    let before = std::fs::read(&path).unwrap();
    let old = Store::read_backup(&path).unwrap();
    assert!(old.workspaces.is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let store = Store::open(&path).unwrap();
    assert!(store.workspaces().unwrap().is_empty());
    let backup = store.migration_backup.as_ref().unwrap();
    let sql = Connection::open(backup).unwrap();
    assert_eq!(
        sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        4
    );
    assert_eq!(
        Store::read_backup(backup).unwrap().digest().unwrap(),
        old.digest().unwrap()
    );
    drop(store);
    let fail = temp.path("回滚.sqlite");
    v4(&fail);
    let sql = Connection::open(&fail).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_workspace BEFORE INSERT ON schema_migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'synthetic');END").unwrap();
    let before = std::fs::read(&fail).unwrap();
    assert!(Store::open(&fail).is_err());
    assert_eq!(std::fs::read(&fail).unwrap(), before);
    assert_eq!(
        sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        4
    );
}
#[test]
fn current_bad_workspace_records_and_capability_fields_are_never_defaulted_or_loaded() {
    let temp = Temp::new();
    let path = temp.path("坏布局.sqlite");
    let mut store = Store::open(&path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let w = layout(p.id);
    store.put_workspace(&w).unwrap();
    drop(store);
    let sql = Connection::open(&path).unwrap();
    let mut value = serde_json::to_value(&w).unwrap();
    value["tabs"][0]["connection_id"] = serde_json::json!(Uuid::new_v4());
    sql.execute("UPDATE workspaces SET value=?1", [value.to_string()])
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert!(Store::read_backup(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    for key in [
        "service_id",
        "request_id",
        "password",
        "token",
        "text",
        "generation",
    ] {
        let mut bad = serde_json::to_value(&w).unwrap();
        bad[key] = serde_json::json!("not allowed");
        assert!(serde_json::from_value::<Workspace>(bad).is_err());
    }
    let mut bad = w.clone();
    bad.tabs[1].id = bad.tabs[0].id;
    assert!(bad.validate().is_err());
    bad = w.clone();
    bad.selected_tab = Some(Uuid::new_v4());
    assert!(bad.validate().is_err());
    for name in ["\u{061c}", "\u{200e}", "\u{200f}", "\u{202e}", "\n"] {
        bad = w.clone();
        bad.name = name.into();
        assert!(bad.validate().is_err());
    }
}

fn v5(path: &Path) -> Workspace {
    let mut store = Store::open(path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let w = layout(p.id);
    store.put_workspace(&w).unwrap();
    drop(store);
    let sql = Connection::open(path).unwrap();
    let mut value = serde_json::to_value(&w).unwrap();
    value.as_object_mut().unwrap().remove("split");
    sql.execute("UPDATE workspaces SET value=?1", [value.to_string()])
        .unwrap();
    sql.execute_batch("DELETE FROM schema_migrations WHERE version>=6;PRAGMA user_version=5")
        .unwrap();
    w
}
#[test]
fn schema5_is_strict_read_only_and_split_migration_is_backed_up_transactional_and_verified() {
    let temp = Temp::new();
    let path = temp.path("旧分屏库.sqlite");
    let w = v5(&path);
    let before = std::fs::read(&path).unwrap();
    let old = Store::read_backup(&path).unwrap();
    assert_eq!(old.workspaces, vec![w.clone()]);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.workspaces().unwrap(), vec![w]);
    let backup = store.migration_backup.as_ref().unwrap();
    assert_eq!(
        Store::read_backup(backup).unwrap().digest().unwrap(),
        old.digest().unwrap()
    );
    let sql = Connection::open(backup).unwrap();
    assert_eq!(
        sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        5
    );
    let text: String = sql
        .query_row("SELECT value FROM workspaces", [], |r| r.get(0))
        .unwrap();
    assert!(!text.contains("split"));
    assert_eq!(
        store.image().unwrap().digest().unwrap(),
        old.digest().unwrap()
    );
    drop(store);
    for fault in ["abort", "ignore", "rewrite"] {
        let path = temp.path(&format!("分屏迁移回滚-{fault}.sqlite"));
        v5(&path);
        let sql = Connection::open(&path).unwrap();
        let trigger = match fault {
            "abort" => {
                "CREATE TRIGGER reject_v6 BEFORE INSERT ON schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'synthetic');END"
            }
            "ignore" => {
                "CREATE TRIGGER ignore_row BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(IGNORE);END"
            }
            _ => {
                "CREATE TRIGGER rewrite_row AFTER UPDATE ON workspaces BEGIN UPDATE workspaces SET value=replace(NEW.value,'日常工作','异常变更') WHERE id=NEW.id;END"
            }
        };
        sql.execute_batch(trigger).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            5
        );
    }
}
#[test]
fn split_metadata_requires_known_distinct_slots_selected_member_and_no_capabilities() {
    let temp = Temp::new();
    let path = temp.path("分屏元数据.sqlite");
    let mut store = Store::open(&path).unwrap();
    let p = profile();
    store.put_profile(p.clone()).unwrap();
    let mut w = layout(p.id);
    let ids = [w.tabs[0].id, w.tabs[1].id];
    w.split = Some(WorkspaceSplit {
        direction: WorkspaceSplitDirection::Horizontal,
        tabs: ids,
    });
    store.put_workspace(&w).unwrap();
    let image = store.image().unwrap();
    let digest = image.digest().unwrap();
    w.split.as_mut().unwrap().direction = WorkspaceSplitDirection::Vertical;
    store.put_workspace(&w).unwrap();
    assert_ne!(store.image().unwrap().digest().unwrap(), digest);
    store
        .restore_image(&image, &digest, &temp.path("恢复前.sqlite"))
        .unwrap();
    assert_eq!(store.workspaces().unwrap(), image.workspaces);
    assert_eq!(
        Store::read_backup(&temp.path("恢复前.sqlite"))
            .unwrap()
            .workspaces,
        vec![w.clone()]
    );
    for refs in [[ids[0], ids[0]], [ids[0], Uuid::new_v4()]] {
        let mut bad = w.clone();
        bad.split.as_mut().unwrap().tabs = refs;
        assert!(bad.validate().is_err());
        assert!(store.put_workspace(&bad).is_err());
    }
    let mut bad = w.clone();
    bad.selected_tab = None;
    assert!(bad.validate().is_err());
    let value = serde_json::to_value(&w).unwrap();
    let mut missing = value.clone();
    missing.as_object_mut().unwrap().remove("split");
    assert!(serde_json::from_value::<Workspace>(missing).is_err());
    for field in [
        "connection_id",
        "generation",
        "service_id",
        "request_id",
        "token",
        "profile_id",
        "text",
    ] {
        let mut bad = value.clone();
        bad["split"][field] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<Workspace>(bad).is_err());
    }
    for shape in [
        serde_json::json!({"direction":"single","tabs":ids}),
        serde_json::json!({"direction":"horizontal","tabs":[ids[0]]}),
        serde_json::json!({"direction":"vertical","tabs":[ids[0],ids[1],Uuid::new_v4()]}),
    ] {
        let mut bad = value.clone();
        bad["split"] = shape;
        assert!(serde_json::from_value::<Workspace>(bad).is_err());
    }
    drop(store);
    let sql = Connection::open(&path).unwrap();
    let mut missing = value;
    missing.as_object_mut().unwrap().remove("split");
    sql.execute("UPDATE workspaces SET value=?1", [missing.to_string()])
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert!(Store::read_backup(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
#[test]
fn legacy_schema5_rejects_new_fields_duplicates_and_capability_shapes_without_mutating() {
    let temp = Temp::new();
    for fault in ["new_field", "duplicate", "capability"] {
        let path = temp.path(&format!("坏旧布局-{fault}.sqlite"));
        let w = v5(&path);
        let sql = Connection::open(&path).unwrap();
        let text = if fault == "new_field" {
            serde_json::to_string(&w).unwrap()
        } else {
            let mut value = serde_json::to_value(&w).unwrap();
            value.as_object_mut().unwrap().remove("split");
            if fault == "capability" {
                value["tabs"][0]["connection_id"] = serde_json::json!(Uuid::new_v4());
                value.to_string()
            } else {
                value
                    .to_string()
                    .replacen('{', "{\"name\":\"duplicate\",", 1)
            }
        };
        sql.execute("UPDATE workspaces SET value=?1", [text])
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(Store::read_backup(&path).is_err());
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
