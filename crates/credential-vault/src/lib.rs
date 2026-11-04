//! Windows current-user DPAPI vault. This crate has no renderer/IPC/export API.
#![cfg(windows)]
mod dpapi;
mod envelope;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use std::{fmt, path::Path, time::Duration};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_SECRET: usize = 64 * 1024;
const MAX_BLOB: usize = 128 * 1024;
const APP_ID: i64 = 0x5354564c;
const MAGIC: &[u8] = b"SharedTerminalCredentialV1\0";
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid credential or reference")]
    Invalid,
    #[error("credential not found")]
    NotFound,
    #[error("credential capacity exceeded")]
    Capacity,
    #[error("unsupported credential vault schema")]
    Schema,
    #[error("credential vault integrity failure")]
    Corrupt,
    #[error("Windows secure random source unavailable")]
    Entropy,
    #[error("Windows credential protection failed ({0})")]
    Protection(u32),
    #[error("credential vault database failed")]
    Sql(#[from] rusqlite::Error),
    #[error("credential vault file failed")]
    Io(#[from] std::io::Error),
}
pub struct Secret(Zeroizing<Vec<u8>>);
impl Secret {
    pub fn new(bytes: Vec<u8>) -> Result<Self> {
        let bytes = Zeroizing::new(bytes);
        // Empty passwords are legitimate SSH credentials; they are not missing values.
        if bytes.len() > MAX_SECRET {
            return Err(Error::Invalid);
        }
        Ok(Self(bytes))
    }
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}
pub struct Vault {
    connection: Connection,
    namespace: Uuid,
}

fn metadata(connection: &Connection) -> Result<Uuid> {
    let app: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if app != APP_ID || version != 1 {
        return Err(Error::Schema);
    }
    let status: String = connection.pragma_query_value(None, "quick_check", |r| r.get(0))?;
    if status != "ok" {
        return Err(Error::Corrupt);
    }
    let value: String =
        connection.query_row("SELECT namespace FROM metadata WHERE id=1", [], |r| {
            r.get(0)
        })?;
    let namespace = Uuid::parse_str(&value)
        .ok()
        .filter(|v| !v.is_nil())
        .ok_or(Error::Corrupt)?;
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM credentials WHERE length(protected)>?1 OR length(protected)<59 OR typeof(protected)!='blob'",
        [MAX_BLOB as i64],
        |r| r.get(0),
    )?;
    let count: i64 = connection.query_row("SELECT count(*) FROM credentials", [], |r| r.get(0))?;
    if invalid != 0 || count > 10000 {
        return Err(Error::Corrupt);
    }
    let mut ids = connection.prepare("SELECT id FROM credentials LIMIT 10001")?;
    for id in ids.query_map([], |row| row.get::<_, String>(0))? {
        let id = id?;
        if !Uuid::parse_str(&id).is_ok_and(|value| !value.is_nil() && value.to_string() == id) {
            return Err(Error::Corrupt);
        }
    }
    Ok(namespace)
}
impl Vault {
    pub fn open(path: &Path) -> Result<Self> {
        let new = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(file) => {
                drop(file);
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(e.into()),
        };
        if !new {
            metadata(&Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?)?;
        }
        let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::from_secs(2))?;
        if new {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),namespace TEXT NOT NULL); CREATE TABLE credentials(id TEXT PRIMARY KEY NOT NULL,protected BLOB NOT NULL); PRAGMA application_id=1398036044; PRAGMA user_version=1;")?;
            tx.execute(
                "INSERT INTO metadata VALUES(1,?1)",
                [Uuid::new_v4().to_string()],
            )?;
            tx.commit()?;
        }
        let namespace = metadata(&connection)?;
        Ok(Self {
            connection,
            namespace,
        })
    }
    fn entropy(&self, id: Uuid) -> Result<Vec<u8>> {
        if id.is_nil() {
            return Err(Error::Invalid);
        }
        Ok([MAGIC, self.namespace.as_bytes(), id.as_bytes()].concat())
    }
    pub fn set(&mut self, id: Uuid, secret: Secret) -> Result<()> {
        let entropy = self.entropy(id)?;
        let protected = envelope::seal(secret.expose(), &entropy)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM credentials WHERE id=?1)",
            [id.to_string()],
            |r| r.get(0),
        )?;
        let count: i64 = tx.query_row("SELECT count(*) FROM credentials", [], |r| r.get(0))?;
        if !exists && count >= 10000 {
            return Err(Error::Capacity);
        }
        tx.execute("INSERT INTO credentials VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET protected=excluded.protected",params![id.to_string(),protected.as_slice()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn get(&self, id: Uuid) -> Result<Secret> {
        let entropy = self.entropy(id)?;
        let tx = self.connection.unchecked_transaction()?;
        let length: Option<i64> = tx
            .query_row(
                "SELECT length(protected) FROM credentials WHERE id=?1",
                [id.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        if !matches!(length, Some(1..=131072)) {
            return Err(if length.is_none() {
                Error::NotFound
            } else {
                Error::Corrupt
            });
        }
        let blob: Vec<u8> = tx.query_row(
            "SELECT protected FROM credentials WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(Secret(envelope::open(&blob, &entropy)?))
    }
    pub fn delete(&mut self, id: Uuid) -> Result<()> {
        self.entropy(id)?;
        if self
            .connection
            .execute("DELETE FROM credentials WHERE id=?1", [id.to_string()])?
            == 0
        {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    /// Presence is not proof that Windows can decrypt the record for this user.
    pub fn contains(&self, id: Uuid) -> Result<bool> {
        self.entropy(id)?;
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM credentials WHERE id=?1)",
            [id.to_string()],
            |row| row.get(0),
        )?)
    }
    /// Metadata only: never decrypt or return protected payloads for inventory.
    pub fn ids(&self) -> Result<Vec<Uuid>> {
        let mut query = self
            .connection
            .prepare("SELECT id FROM credentials ORDER BY id LIMIT 10001")?;
        let mut ids = Vec::new();
        for value in query.query_map([], |row| row.get::<_, String>(0))? {
            let value = value?;
            let id = Uuid::parse_str(&value)
                .ok()
                .filter(|id| !id.is_nil() && id.to_string() == value)
                .ok_or(Error::Corrupt)?;
            ids.push(id);
        }
        if ids.len() > 10000 {
            return Err(Error::Capacity);
        }
        Ok(ids)
    }
}
