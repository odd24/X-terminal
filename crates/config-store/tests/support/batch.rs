use super::*;
fn patch() -> BatchPatch {
    BatchPatch {
        folder: BatchFolder::Keep {},
        encoding: Some(Encoding::Gbk),
        ssh_port: Some(2200),
        serial_baud: None,
    }
}
#[test]
fn batch_exact_selection_private_refs_and_external_conflict() {
    let temp = Temp::new();
    let path = temp.path("batch.sqlite");
    let mut store = Store::open(&path).unwrap();
    let profiles: Vec<_> = (0..3).map(|_| profile()).collect();
    for item in &profiles {
        store.put_profile(item.clone()).unwrap();
    }
    let ids = vec![profiles[1].id, profiles[0].id];
    let before = store.image().unwrap().digest().unwrap();
    let plan = store.preview_batch(&ids, &patch()).unwrap();
    assert_eq!(store.image().unwrap().digest().unwrap(), before);
    assert_eq!(
        plan.rows()
            .iter()
            .map(|row| row.before.id)
            .collect::<Vec<_>>(),
        ids
    );
    assert!(
        !serde_json::to_string(plan.rows())
            .unwrap()
            .contains("credential_ref")
    );
    store.apply_batch(&plan).unwrap();
    for item in &profiles[..2] {
        assert_eq!(
            store.profile(item.id).unwrap().unwrap(),
            patch().apply(item).unwrap()
        );
    }
    assert_eq!(store.profile(profiles[2].id).unwrap().unwrap(), profiles[2]);
    assert!(matches!(store.apply_batch(&plan), Err(Error::Conflict)));
    let plan = store.preview_batch(&ids, &patch()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE profiles SET name='external' WHERE id=?1",
            [profiles[2].id.to_string()],
        )
        .unwrap();
    assert!(matches!(store.apply_batch(&plan), Err(Error::Conflict)));
    assert!(store.preview_batch(&[ids[0], ids[0]], &patch()).is_err());
    assert!(
        store
            .preview_batch(&[ids[0], Uuid::new_v4()], &patch())
            .is_err()
    );
    let wrong = BatchPatch {
        serial_baud: Some(115200),
        ssh_port: None,
        ..patch()
    };
    assert!(store.preview_batch(&ids, &wrong).is_err());
}
#[test]
fn batch_mid_transaction_abort_ignore_rewrite_and_schema_roll_back() {
    for action in [
        "SELECT RAISE(ABORT,'synthetic');",
        "SELECT RAISE(IGNORE);",
        "UPDATE profiles SET name='rewrite' WHERE id=NEW.id;",
    ] {
        let temp = Temp::new();
        let path = temp.path("batch.sqlite");
        let mut store = Store::open(&path).unwrap();
        let first = profile();
        let second = profile();
        let other = profile();
        for item in [&first, &second, &other] {
            store.put_profile(item.clone()).unwrap();
        }
        let before = store.image().unwrap().digest().unwrap();
        let plan = store
            .preview_batch(&[first.id, second.id], &patch())
            .unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER fault {} UPDATE ON profiles WHEN NEW.id='{}' BEGIN {action} END;",
                if action.contains("UPDATE profiles") {
                    "AFTER"
                } else {
                    "BEFORE"
                },
                second.id
            ))
            .unwrap();
        assert!(store.apply_batch(&plan).is_err());
        assert_eq!(store.image().unwrap().digest().unwrap(), before);
        connection
            .execute_batch("DROP TRIGGER fault; PRAGMA user_version=8;")
            .unwrap();
        assert!(matches!(store.apply_batch(&plan), Err(Error::Schema)));
        connection.execute_batch("PRAGMA user_version=7;").unwrap();
        assert_eq!(store.image().unwrap().digest().unwrap(), before);
    }
}
