use super::*;
#[test]
fn import_destination_limits_have_capacity_reports_without_writes() {
    for folders in [true, false] {
        let temp = Temp::new();
        let path = temp.path("capacity.sqlite");
        let store = Store::open(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        if folders {
            for _ in 0..1024 {
                db.execute(
                    "INSERT INTO folders VALUES(?1,NULL,'existing')",
                    [Uuid::new_v4().to_string()],
                )
                .unwrap();
            }
        } else {
            let settings = serde_json::to_string(&profile().settings).unwrap();
            for _ in 0..10000 {
                db.execute(
                    "INSERT INTO profiles VALUES(?1,NULL,'existing',NULL,?2)",
                    rusqlite::params![Uuid::new_v4().to_string(), settings],
                )
                .unwrap();
            }
        }
        db.execute_batch("COMMIT").unwrap();
        let before = store.image().unwrap().digest().unwrap();
        assert!(matches!(
            store
                .preview_import(&source(), ImportPolicy::Reject)
                .unwrap(),
            ImportPreview::Rejected(ImportProblem {
                code: ImportProblemCode::Capacity,
                ..
            })
        ));
        assert_eq!(store.image().unwrap().digest().unwrap(), before);
    }
}
fn source() -> Snapshot {
    let root = Folder {
        id: Uuid::new_v4(),
        parent_id: None,
        name: "Z根".into(),
    };
    let child = Folder {
        id: Uuid::new_v4(),
        parent_id: Some(root.id),
        name: "A子".into(),
    };
    let mut p: PortableProfile = (&profile()).into();
    p.folder_id = Some(child.id);
    Snapshot {
        format_version: 1,
        folders: vec![child, root],
        profiles: vec![p],
    }
}
fn plan(store: &Store, s: &Snapshot, policy: ImportPolicy) -> ImportPlan {
    match store.preview_import(s, policy).unwrap() {
        ImportPreview::Ready(plan) => plan,
        ImportPreview::Rejected(p) => panic!("{p:?}"),
    }
}
#[test]
fn import_parse_rejects_version_fields_duplicates_references_and_budgets_without_echo() {
    use ImportProblemCode as C;
    let s = source();
    let base = serde_json::to_value(&s).unwrap();
    assert!(parse_import(&serde_json::to_vec(&s).unwrap()).is_ok());
    let cases: Vec<(serde_json::Value, C)> = vec![
        (
            {
                let mut v = base.clone();
                v.as_object_mut().unwrap().remove("format_version");
                v
            },
            C::MissingVersion,
        ),
        (
            {
                let mut v = base.clone();
                v["format_version"] = 2.into();
                v
            },
            C::UnsupportedVersion,
        ),
        (
            {
                let mut v = base.clone();
                v["profiles"][0]["credential_ref"] = "synthetic-secret-must-not-echo".into();
                v
            },
            C::UnsupportedField,
        ),
        (
            {
                let mut v = base.clone();
                v["profiles"][0]["id"] = v["folders"][0]["id"].clone();
                v
            },
            C::DuplicateId,
        ),
        (
            {
                let mut v = base.clone();
                v["folders"][1]["parent_id"] = v["folders"][0]["id"].clone();
                v
            },
            C::FolderCycle,
        ),
        (
            {
                let mut v = base.clone();
                v["profiles"][0]["folder_id"] = serde_json::json!(Uuid::new_v4());
                v
            },
            C::FolderReference,
        ),
        (
            {
                let mut v = base.clone();
                v["folders"][0].as_object_mut().unwrap().remove("parent_id");
                v
            },
            C::InvalidShape,
        ),
    ];
    for (v, expected) in cases {
        let issue = parse_import(&serde_json::to_vec(&v).unwrap()).unwrap_err();
        assert_eq!(issue.code, expected);
        assert!(!format!("{issue:?}").contains("secret"));
    }
    let duplicate = serde_json::to_string(&s).unwrap().replacen(
        "\"format_version\":1",
        "\"format_version\":1,\"format_version\":1",
        1,
    );
    assert_eq!(
        parse_import(duplicate.as_bytes()).unwrap_err().code,
        C::DuplicateField
    );
    assert_eq!(
        parse_import(&vec![b' '; 65537]).unwrap_err().code,
        C::Capacity
    );
    assert_eq!(parse_import(&[0xff]).unwrap_err().code, C::Encoding);
    let mut deep = base;
    deep["extra"] = serde_json::Value::Null;
    for _ in 0..35 {
        deep["extra"] = serde_json::json!([deep["extra"].take()]);
    }
    assert_eq!(
        parse_import(&serde_json::to_vec(&deep).unwrap())
            .unwrap_err()
            .code,
        C::Depth
    );
    let duplicate_nested =
        serde_json::to_string(&s)
            .unwrap()
            .replacen("\"port\":22", "\"port\":22,\"port\":23", 1);
    assert_eq!(
        parse_import(duplicate_nested.as_bytes()).unwrap_err().code,
        C::DuplicateField
    );
    let mut wide = source();
    wide.folders = (0..33)
        .map(|_| Folder {
            id: Uuid::new_v4(),
            parent_id: None,
            name: "x".into(),
        })
        .collect();
    assert_eq!(
        parse_import(&serde_json::to_vec(&wide).unwrap())
            .unwrap_err()
            .code,
        C::Capacity
    );
    let mut tree = source();
    tree.folders.clear();
    for i in 0..17 {
        let parent = if i == 0 {
            None
        } else {
            Some(tree.folders[i - 1].id)
        };
        tree.folders.push(Folder {
            id: Uuid::new_v4(),
            parent_id: parent,
            name: "x".into(),
        });
    }
    tree.profiles[0].folder_id = Some(tree.folders[16].id);
    assert_eq!(
        parse_import(&serde_json::to_vec(&tree).unwrap())
            .unwrap_err()
            .code,
        C::Depth
    );
    tree.folders.pop();
    tree.profiles[0].folder_id = Some(tree.folders[15].id);
    assert!(parse_import(&serde_json::to_vec(&tree).unwrap()).is_ok());
    let mut s = source();
    s.profiles = vec![s.profiles[0].clone(); 65];
    assert_eq!(
        parse_import(&serde_json::to_vec(&s).unwrap())
            .unwrap_err()
            .code,
        C::Capacity
    );
}
#[test]
fn import_policies_remap_references_preserve_private_refs_and_refuse_identity_changes() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.path("import.sqlite")).unwrap();
    let s = source();
    let p = plan(&store, &s, ImportPolicy::Reject);
    assert_eq!(store.profiles().unwrap().len(), 0);
    store.apply_import(&p).unwrap();
    let exported = store.export().unwrap();
    assert!(parse_import(&serde_json::to_vec(&exported).unwrap()).is_ok());
    assert!(matches!(
        store.preview_import(&s, ImportPolicy::Reject).unwrap(),
        ImportPreview::Rejected(ImportProblem {
            code: ImportProblemCode::Conflict,
            ..
        })
    ));
    let p = plan(&store, &s, ImportPolicy::NewIds);
    let d = p.diff();
    assert_ne!(d.folders[0].source_id, d.folders[0].after.id);
    assert_eq!(d.profiles[0].after.folder_id, Some(d.folders[0].after.id));
    assert_eq!(d.folders[0].after.parent_id, Some(d.folders[1].after.id));
    assert!(!d.profiles[0].credential_preserved);
    store.apply_import(&p).unwrap();
    assert_eq!(store.profiles().unwrap().len(), 2);
    let id = s.profiles[0].id;
    let mut private = store.profile(id).unwrap().unwrap();
    private.credential_ref = Some(Uuid::new_v4());
    store.put_profile(private.clone()).unwrap();
    let mut replacement = s.clone();
    replacement.profiles[0].name = "renamed".into();
    if let Settings::Ssh2 { encoding, .. } = &mut replacement.profiles[0].settings {
        *encoding = Encoding::Gbk;
    }
    let p = plan(&store, &replacement, ImportPolicy::Replace);
    assert!(p.diff().profiles[0].credential_preserved);
    assert!(
        !serde_json::to_string(p.diff())
            .unwrap()
            .contains("credential_ref")
    );
    store.apply_import(&p).unwrap();
    assert_eq!(
        store.profile(id).unwrap().unwrap().credential_ref,
        private.credential_ref
    );
    for field in ["host", "port", "username", "auth"] {
        let mut bad = serde_json::to_value(&replacement).unwrap();
        bad["profiles"][0]["settings"][field] = match field {
            "port" => 2200.into(),
            "auth" => "public_key".into(),
            _ => "different".into(),
        };
        let bad: Snapshot = serde_json::from_value(bad).unwrap();
        assert!(matches!(
            store.preview_import(&bad, ImportPolicy::Replace).unwrap(),
            ImportPreview::Rejected(ImportProblem {
                code: ImportProblemCode::CredentialEndpoint,
                ..
            })
        ));
    }
    replacement.folders[0].name = "changed shared folder".into();
    assert!(matches!(
        store
            .preview_import(&replacement, ImportPolicy::Replace)
            .unwrap(),
        ImportPreview::Rejected(ImportProblem {
            code: ImportProblemCode::FolderConflict,
            ..
        })
    ));
}
#[test]
fn import_cas_and_mid_insert_abort_ignore_rewrite_rollback_every_table() {
    for action in [
        "SELECT RAISE(ABORT,'synthetic');",
        "SELECT RAISE(IGNORE);",
        "UPDATE profiles SET name='rewrite' WHERE id=NEW.id;",
    ] {
        let temp = Temp::new();
        let path = temp.path("import.sqlite");
        let store = Store::open(&path).unwrap();
        let s = source();
        let before = store.image().unwrap().digest().unwrap();
        let p = plan(&store, &s, ImportPolicy::Reject);
        let db = Connection::open(&path).unwrap();
        db.execute_batch(&format!(
            "CREATE TRIGGER fault {} INSERT ON profiles BEGIN {action} END;",
            if action.contains("UPDATE profiles") {
                "AFTER"
            } else {
                "BEFORE"
            }
        ))
        .unwrap();
        assert!(store.apply_import(&p).is_err());
        assert_eq!(store.image().unwrap().digest().unwrap(), before);
        db.execute_batch("DROP TRIGGER fault; INSERT INTO folders VALUES('11111111-1111-1111-1111-111111111111',NULL,'external');").unwrap();
        assert!(matches!(store.apply_import(&p), Err(Error::Conflict)));
    }
}
