use super::*;
fn command(name: &str) -> QuickCommand {
    QuickCommand {
        id: Uuid::new_v4(),
        name: name.into(),
        group: "常用".into(),
        template: "printf {{word}}; ${HOME} `literal`\r\n".into(),
        ending: CommandEnding::Lf,
    }
}
#[test]
fn quick_command_shapes_variables_and_debug_never_default_or_expose_body() {
    let c = command("打印");
    c.validate().unwrap();
    assert_eq!(
        command_variables("{{x}} {{x}} {{bad space}} {{outer{{inner}} ${HOME} {{_ok9}}"),
        vec!["x", "inner", "_ok9"]
    );
    let mut bad = c.clone();
    bad.name = " 前空格".into();
    assert!(bad.validate().is_err());
    bad = c.clone();
    bad.group = "\u{202e}".into();
    assert!(bad.validate().is_err());
    bad = c.clone();
    bad.template = "中".repeat(8193);
    assert!(bad.validate().is_err());
    bad = c.clone();
    bad.template = (0..17).map(|i| format!("{{{{x{i}}}}}")).collect::<String>();
    assert!(bad.validate().is_err());
    let text = format!("{c:?}");
    for secret in [&c.name, &c.group, &c.template] {
        assert!(!text.contains(secret));
    }
    let value = serde_json::to_value(c).unwrap();
    for key in ["template", "group", "ending"] {
        let mut bad = value.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<QuickCommand>(bad).is_err());
    }
    for key in ["connection_id", "profile_id", "token", "values", "history"] {
        let mut bad = value.clone();
        bad[key] = "forbidden".into();
        assert!(serde_json::from_value::<QuickCommand>(bad).is_err());
    }
}
#[test]
fn quick_commands_have_bounded_unique_groups_and_verified_mutations() {
    let temp = Temp::new();
    let path = temp.path("命令.sqlite");
    let mut store = Store::open(&path).unwrap();
    let c = command("one");
    store.put_quick_command(&c).unwrap();
    let before = store.image().unwrap().digest().unwrap();
    let mut duplicate = command("one");
    assert!(store.put_quick_command(&duplicate).is_err());
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER ignore_command BEFORE UPDATE ON quick_commands BEGIN SELECT RAISE(IGNORE);END").unwrap();
    duplicate = c.clone();
    duplicate.template = "change".into();
    assert!(store.put_quick_command(&duplicate).is_err());
    assert_eq!(store.quick_commands().unwrap(), vec![c.clone()]);
    sql.execute_batch("DROP TRIGGER ignore_command").unwrap();
    for i in 1..64 {
        store
            .put_quick_command(&command(&format!("name{i}")))
            .unwrap();
    }
    assert!(store.put_quick_command(&command("65")).is_err());
    store.delete_quick_command(c.id).unwrap();
    assert_eq!(store.quick_commands().unwrap().len(), 63);
    let mut groups = Store::open(&temp.path("组上限.sqlite")).unwrap();
    for i in 0..16 {
        let mut c = command("name");
        c.group = format!("g{i}");
        groups.put_quick_command(&c).unwrap();
    }
    let mut c = command("name");
    c.group = "g16".into();
    assert!(groups.put_quick_command(&c).is_err());
    let mut budget = Store::open(&temp.path("预算.sqlite")).unwrap();
    let mut accepted = 0;
    for i in 0..64 {
        let mut c = command(&format!("q{i}"));
        c.template = "中".repeat(8192);
        let before = budget.image().unwrap().digest().unwrap();
        if budget.put_quick_command(&c).is_err() {
            assert_eq!(budget.image().unwrap().digest().unwrap(), before);
            break;
        }
        accepted += 1;
    }
    assert!((1..64).contains(&accepted));
    assert!(
        serde_json::to_vec(&budget.quick_commands().unwrap())
            .unwrap()
            .len()
            <= 256 * 1024
    );
}
fn v6(path: &Path) {
    drop(Store::open(path).unwrap());
    let sql = Connection::open(path).unwrap();
    sql.execute_batch("DROP TABLE quick_commands;DELETE FROM schema_migrations WHERE version>=7;PRAGMA user_version=6").unwrap();
}
#[test]
fn schema6_commands_are_empty_readonly_and_upgrade_is_backed_up_or_rolled_back() {
    let temp = Temp::new();
    let path = temp.path("v6.sqlite");
    v6(&path);
    let before = std::fs::read(&path).unwrap();
    let old = Store::read_backup(&path).unwrap();
    assert!(old.quick_commands.is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let store = Store::open(&path).unwrap();
    let backup = store.migration_backup.as_ref().unwrap();
    assert_eq!(
        Store::read_backup(backup).unwrap().digest().unwrap(),
        old.digest().unwrap()
    );
    assert_eq!(
        Connection::open(backup)
            .unwrap()
            .pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        6
    );
    drop(store);
    for action in ["ABORT", "IGNORE"] {
        let path = temp.path(&format!("升级-{action}.sqlite"));
        v6(&path);
        let sql = Connection::open(&path).unwrap();
        let trigger = if action == "ABORT" {
            "CREATE TRIGGER reject_command BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'synthetic');END"
        } else {
            "CREATE TRIGGER reject_command BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(IGNORE);END"
        };
        sql.execute_batch(trigger).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            sql.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            6
        );
    }
}
#[test]
fn commands_are_in_backup_digest_restore_and_safety_copy_but_not_portable_profiles() {
    let temp = Temp::new();
    let path = temp.path("备份命令.sqlite");
    let mut store = Store::open(&path).unwrap();
    let c = command("原始");
    store.put_quick_command(&c).unwrap();
    let image = store.image().unwrap();
    let digest = image.digest().unwrap();
    let mut changed = c.clone();
    changed.template = "changed".into();
    store.put_quick_command(&changed).unwrap();
    assert_ne!(store.image().unwrap().digest().unwrap(), digest);
    assert!(
        !serde_json::to_string(&store.export().unwrap())
            .unwrap()
            .contains(&c.template)
    );
    store
        .restore_image(&image, &digest, &temp.path("安全副本.sqlite"))
        .unwrap();
    assert_eq!(store.quick_commands().unwrap(), vec![c]);
    assert_eq!(
        Store::read_backup(&temp.path("安全副本.sqlite"))
            .unwrap()
            .quick_commands,
        vec![changed]
    );
    let before = store.image().unwrap().digest().unwrap();
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER ignore_restore BEFORE INSERT ON quick_commands BEGIN SELECT RAISE(IGNORE);END").unwrap();
    assert!(
        store
            .restore_image(&image, &digest, &temp.path("失败前.sqlite"))
            .is_err()
    );
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    sql.execute_batch("DROP TRIGGER ignore_restore;DROP TABLE quick_commands")
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open(&path).is_err());
    assert!(Store::read_backup(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
