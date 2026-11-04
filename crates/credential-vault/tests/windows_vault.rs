#![cfg(windows)]
use credential_vault::{Error, MAX_SECRET, Secret, Vault};
use rusqlite::{Connection, params};
use std::{path::PathBuf, process::Command};
use uuid::Uuid;

const SYNTHETIC: &[u8] = b"synthetic-only--not-a-real-password--P08.2";
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-vault-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn db(&self) -> PathBuf {
        self.0.join("vault.sqlite")
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn native_dpapi_roundtrip_reopen_update_delete_and_missing_are_explicit() {
    let temp = Temp::new();
    let id = Uuid::new_v4();
    let mut vault = Vault::open(&temp.db()).unwrap();
    assert!(vault.ids().unwrap().is_empty());
    assert!(!vault.contains(id).unwrap());
    vault
        .set(id, Secret::new(SYNTHETIC.to_vec()).unwrap())
        .unwrap();
    let secret = vault.get(id).unwrap();
    assert_eq!(vault.ids().unwrap(), vec![id]);
    assert!(vault.contains(id).unwrap());
    assert!(secret.expose() == SYNTHETIC);
    assert_eq!(format!("{secret:?}"), "[REDACTED]");
    drop(vault);
    let mut vault = Vault::open(&temp.db()).unwrap();
    assert!(vault.get(id).unwrap().expose() == SYNTHETIC);
    vault
        .set(id, Secret::new(b"synthetic replacement".to_vec()).unwrap())
        .unwrap();
    assert!(vault.get(id).unwrap().expose() == b"synthetic replacement");
    vault.delete(id).unwrap();
    assert!(vault.ids().unwrap().is_empty());
    assert!(!vault.contains(id).unwrap());
    assert!(matches!(vault.get(id), Err(Error::NotFound)));
    assert!(matches!(vault.delete(id), Err(Error::NotFound)));
    assert!(matches!(vault.get(Uuid::nil()), Err(Error::Invalid)));
}

#[test]
fn windows_empty_binary_and_large_credentials_are_supported_without_plaintext_files() {
    let temp = Temp::new();
    let mut vault = Vault::open(&temp.db()).unwrap();
    let id = Uuid::new_v4();
    vault.set(id, Secret::new(Vec::new()).unwrap()).unwrap();
    assert!(vault.get(id).unwrap().expose().is_empty());
    let binary = (0..MAX_SECRET).map(|i| (i % 256) as u8).collect::<Vec<_>>();
    vault.set(id, Secret::new(binary.clone()).unwrap()).unwrap();
    assert!(vault.get(id).unwrap().expose() == binary);
    assert!(matches!(
        Secret::new(vec![0; MAX_SECRET + 1]),
        Err(Error::Invalid)
    ));
    vault
        .set(id, Secret::new(SYNTHETIC.to_vec()).unwrap())
        .unwrap();
    // Check the live persisted files as well as after closing the database.
    for file in std::fs::read_dir(&temp.0).unwrap() {
        let bytes = std::fs::read(file.unwrap().path()).unwrap();
        assert!(
            !bytes
                .windows(SYNTHETIC.len())
                .any(|window| window == SYNTHETIC)
        );
    }
    drop(vault);
    assert!(
        !std::fs::read(temp.db())
            .unwrap()
            .windows(SYNTHETIC.len())
            .any(|w| w == SYNTHETIC)
    );
}

#[test]
fn corrupt_ciphertext_swapped_ids_and_wrong_namespace_are_rejected() {
    let temp = Temp::new();
    let mut vault = Vault::open(&temp.db()).unwrap();
    let id = Uuid::new_v4();
    let other = Uuid::new_v4();
    vault
        .set(id, Secret::new(SYNTHETIC.to_vec()).unwrap())
        .unwrap();
    vault
        .set(other, Secret::new(b"other synthetic".to_vec()).unwrap())
        .unwrap();
    let conn = Connection::open(temp.db()).unwrap();
    let blob: Vec<u8> = conn
        .query_row(
            "SELECT protected FROM credentials WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    for position in 0..blob.len() {
        let mut corrupt = blob.clone();
        corrupt[position] ^= 0x80;
        conn.execute(
            "UPDATE credentials SET protected=?1 WHERE id=?2",
            params![corrupt, id.to_string()],
        )
        .unwrap();
        assert!(
            vault.get(id).is_err(),
            "mutation at {position} must fail closed"
        );
    }
    for length in [0, 1, 16, blob.len() - 1] {
        conn.execute(
            "UPDATE credentials SET protected=?1 WHERE id=?2",
            params![&blob[..length], id.to_string()],
        )
        .unwrap();
        assert!(vault.get(id).is_err(), "truncation must fail closed");
    }
    conn.execute(
        "UPDATE credentials SET protected=?1 WHERE id=?2",
        params![&blob, id.to_string()],
    )
    .unwrap();
    assert!(vault.get(id).unwrap().expose() == SYNTHETIC);
    conn.execute(
        "UPDATE credentials SET protected=?1 WHERE id=?2",
        params![&blob, other.to_string()],
    )
    .unwrap();
    assert!(vault.get(other).is_err());
    conn.execute(
        "UPDATE metadata SET namespace=?1",
        [Uuid::new_v4().to_string()],
    )
    .unwrap();
    drop(vault);
    let vault = Vault::open(&temp.db()).unwrap();
    assert!(vault.get(id).is_err());
}

#[test]
fn unknown_corrupt_or_empty_vault_is_not_overwritten() {
    let temp = Temp::new();
    drop(Vault::open(&temp.db()).unwrap());
    let conn = Connection::open(temp.db()).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    let before = std::fs::read(temp.db()).unwrap();
    assert!(matches!(Vault::open(&temp.db()), Err(Error::Schema)));
    assert_eq!(std::fs::read(temp.db()).unwrap(), before);
    let bad = temp.0.join("bad");
    std::fs::write(&bad, b"synthetic corrupted vault").unwrap();
    let before = std::fs::read(&bad).unwrap();
    assert!(Vault::open(&bad).is_err());
    assert_eq!(std::fs::read(bad).unwrap(), before);
    let empty = temp.0.join("empty");
    std::fs::write(&empty, []).unwrap();
    assert!(matches!(Vault::open(&empty), Err(Error::Schema)));
    assert!(std::fs::read(empty).unwrap().is_empty());
}

#[test]
fn separate_process_can_read_the_current_users_protected_record() {
    let temp = Temp::new();
    let id = Uuid::new_v4();
    let mut vault = Vault::open(&temp.db()).unwrap();
    vault
        .set(id, Secret::new(SYNTHETIC.to_vec()).unwrap())
        .unwrap();
    drop(vault);
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "child_read"])
        .env("SHARED_TERMINAL_TEST_VAULT", temp.db())
        .env("SHARED_TERMINAL_TEST_CREDENTIAL", id.to_string())
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "child must read synthetic record successfully"
    );
    assert!(
        !child
            .stdout
            .windows(SYNTHETIC.len())
            .any(|w| w == SYNTHETIC)
    );
    assert!(
        !child
            .stderr
            .windows(SYNTHETIC.len())
            .any(|w| w == SYNTHETIC)
    );
}

#[test]
fn malformed_stored_reference_and_blob_limit_are_rejected_without_changes() {
    let temp = Temp::new();
    let mut vault = Vault::open(&temp.db()).unwrap();
    let id = Uuid::new_v4();
    vault
        .set(id, Secret::new(SYNTHETIC.to_vec()).unwrap())
        .unwrap();
    drop(vault);
    let conn = Connection::open(temp.db()).unwrap();
    conn.execute("UPDATE credentials SET id='invalid'", [])
        .unwrap();
    drop(conn);
    let before = std::fs::read(temp.db()).unwrap();
    assert!(matches!(Vault::open(&temp.db()), Err(Error::Corrupt)));
    assert_eq!(std::fs::read(temp.db()).unwrap(), before);
    let conn = Connection::open(temp.db()).unwrap();
    conn.execute(
        "UPDATE credentials SET id=?1,protected=zeroblob(131073)",
        [id.to_string()],
    )
    .unwrap();
    drop(conn);
    let before = std::fs::read(temp.db()).unwrap();
    assert!(matches!(Vault::open(&temp.db()), Err(Error::Corrupt)));
    assert_eq!(std::fs::read(temp.db()).unwrap(), before);
}

#[test]
#[ignore = "only invoked by the parent integration test with isolated test paths"]
fn child_read() {
    let path = PathBuf::from(std::env::var_os("SHARED_TERMINAL_TEST_VAULT").unwrap());
    let id = Uuid::parse_str(&std::env::var("SHARED_TERMINAL_TEST_CREDENTIAL").unwrap()).unwrap();
    let vault = Vault::open(&path).unwrap();
    assert!(vault.get(id).unwrap().expose() == SYNTHETIC);
}
