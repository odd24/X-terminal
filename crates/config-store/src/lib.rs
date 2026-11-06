//! Structured configuration only. Credential material has no column or model field.
mod host_keys;
mod preferences;
mod snapshot;
pub use snapshot::ConfigImage;
mod model;
pub use model::*;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const APP_ID: i64 = 0x5354544d;
pub const SCHEMA_VERSION: i64 = 4;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("configuration changed before confirmation")]
    Conflict,
    #[error(transparent)]
    Validation(#[from] config_model::ValidationError),
    #[error("configuration database operation failed")]
    Sql(#[from] rusqlite::Error),
    #[error("configuration file operation failed")]
    Io(#[from] std::io::Error),
    #[error("invalid configuration: {0}")]
    Invalid(&'static str),
    #[error("unsupported configuration schema")]
    Schema,
    #[error("configuration database integrity check failed")]
    Corrupt,
    #[error("configuration record not found")]
    NotFound,
    #[error("configuration encoding failed")]
    Json(#[from] serde_json::Error),
}
pub struct Store {
    connection: Connection,
    path: PathBuf,
    pub migration_backup: Option<PathBuf>,
}
fn open_database(path: &Path, flags: OpenFlags) -> Result<Connection> {
    let connection = Connection::open_with_flags(path, flags)?;
    connection.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 65536)?;
    connection.busy_timeout(Duration::from_secs(2))?;
    Ok(connection)
}

fn metadata(connection: &Connection) -> Result<(i64, i64)> {
    Ok((
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?,
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?,
    ))
}
/// Called after acquiring the write transaction so external version changes cannot race a mutation.
fn require_current(connection: &Connection) -> Result<()> {
    if metadata(connection)? != (APP_ID, SCHEMA_VERSION) {
        return Err(Error::Schema);
    }
    Ok(())
}
fn check(connection: &Connection) -> Result<()> {
    let (app, version) = metadata(connection)?;
    if app != APP_ID || !(1..=SCHEMA_VERSION).contains(&version) {
        return Err(Error::Schema);
    }
    let integrity: String = connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Err(Error::Corrupt);
    }
    let mut stmt = connection.prepare("PRAGMA foreign_key_check")?;
    if stmt.query([])?.next()?.is_some() {
        return Err(Error::Corrupt);
    }
    Ok(())
}
const V1: &str = "CREATE TABLE folders(id TEXT PRIMARY KEY NOT NULL,parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,name TEXT NOT NULL); CREATE TABLE profiles(id TEXT PRIMARY KEY NOT NULL,folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,name TEXT NOT NULL,credential_ref TEXT,settings TEXT NOT NULL); PRAGMA application_id=1398035533; PRAGMA user_version=1;";
const V2: &str = "CREATE TABLE host_keys(protocol TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,algorithm TEXT NOT NULL,key BLOB NOT NULL,PRIMARY KEY(protocol,host,port,algorithm)); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL); INSERT INTO schema_migrations VALUES(1),(2); PRAGMA user_version=2;";

const V3: &str = "CREATE TABLE desktop_preferences(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); INSERT INTO desktop_preferences VALUES(1,'{\"theme\":\"dark\",\"terminal_font\":\"consolas\",\"font_size\":15,\"ctrl_c_copy\":true,\"ctrl_v_paste\":false,\"right_click_paste\":false}'); INSERT INTO schema_migrations VALUES(3); PRAGMA user_version=3;";

impl Store {
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
        // Existing unknown/corrupt files are inspected read-only before any write.
        if !new {
            let source = open_database(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            check(&source)?;
            Self {
                connection: source,
                path: path.to_owned(),
                migration_backup: None,
            }
            .validate_content()?;
        }
        let mut connection = open_database(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut migration_backup = None;
        if new {
            tx.execute_batch(V1)?;
        } else {
            check(&tx)?;
        }
        let (_, version) = metadata(&tx)?;
        if version < SCHEMA_VERSION {
            if !new {
                let backup = path.with_file_name(format!(
                    "config-before-v{version}-{}.sqlite",
                    Uuid::new_v4()
                ));
                let source = open_database(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                drop(
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&backup)?,
                );
                source.backup(
                    rusqlite::MAIN_DB,
                    &backup,
                    None::<fn(rusqlite::backup::Progress)>,
                )?;
                migration_backup = Some(backup);
            }
            if version < 2 {
                tx.execute_batch(V2)?;
            }
            if version < 3 {
                tx.execute_batch(V3)?;
            }
            let preferences = preferences::read(&tx)?;
            if tx.execute(
                "UPDATE desktop_preferences SET value=?1 WHERE id=1",
                params![serde_json::to_string(&preferences)?],
            )? != 1
            {
                return Err(Error::Corrupt);
            }
            tx.execute_batch("INSERT INTO schema_migrations VALUES(4); PRAGMA user_version=4;")?;
        }
        tx.commit()?;
        check(&connection)?;
        let store = Self {
            connection,
            path: path.to_owned(),
            migration_backup,
        };
        store.validate_content()?;
        Ok(store)
    }

    pub fn folders(&self) -> Result<Vec<Folder>> {
        let mut stmt = self
            .connection
            .prepare("SELECT id,parent_id,name FROM folders ORDER BY name,id LIMIT 1025")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (id, parent, name) = row?;
            result.push(Folder {
                id: parse_id(&id)?,
                parent_id: parent.map(|id| parse_id(&id)).transpose()?,
                name,
            });
        }
        if result.len() > 1024 {
            return Err(Error::Invalid("folder limit"));
        }
        Ok(result)
    }
    pub fn profiles(&self) -> Result<Vec<Profile>> {
        let mut stmt = self.connection.prepare("SELECT id,folder_id,name,credential_ref,settings FROM profiles ORDER BY name,id LIMIT 10001")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (id, folder, name, credential, settings) = row?;
            let profile = Profile {
                id: parse_id(&id)?,
                folder_id: folder.map(|v| parse_id(&v)).transpose()?,
                name,
                credential_ref: credential.map(|v| parse_id(&v)).transpose()?,
                settings: serde_json::from_str(&settings)?,
            };
            profile.validate().map_err(|_| Error::Corrupt)?;
            result.push(profile);
        }
        if result.len() > 10000 {
            return Err(Error::Invalid("profile limit"));
        }
        Ok(result)
    }
    fn validate_content(&self) -> Result<()> {
        let folders = self.folders()?;
        for folder in &folders {
            validate_folder(folder, &folders)?;
        }
        for profile in self.profiles()? {
            profile.validate()?;
        }
        if metadata(&self.connection)?.1 >= 2 {
            self.host_keys()?;
        }
        self.preferences()?;
        Ok(())
    }
    pub fn put_folder(&mut self, folder: Folder) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Read under this transaction so concurrent writers cannot bypass limits/cycles.
        require_current(&tx)?;
        let mut folders = read_folders(&tx)?;
        folders.retain(|f| f.id != folder.id);
        folders.push(folder.clone());
        if folders.len() > 1024 {
            return Err(Error::Invalid("folder limit"));
        }
        validate_folder(&folder, &folders)?;
        tx.execute("INSERT INTO folders(id,parent_id,name) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name",params![folder.id.to_string(),folder.parent_id.map(|v|v.to_string()),folder.name])?;
        tx.commit()?;
        Ok(())
    }
    pub fn put_profile(&mut self, profile: Profile) -> Result<()> {
        profile.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE id=?1)",
            [profile.id.to_string()],
            |r| r.get(0),
        )?;
        let count: i64 = tx.query_row("SELECT count(*) FROM profiles", [], |r| r.get(0))?;
        if !exists && count >= 10000 {
            return Err(Error::Invalid("profile limit"));
        }
        tx.execute("INSERT INTO profiles(id,folder_id,name,credential_ref,settings) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,name=excluded.name,credential_ref=excluded.credential_ref,settings=excluded.settings",params![profile.id.to_string(),profile.folder_id.map(|v|v.to_string()),profile.name,profile.credential_ref.map(|v|v.to_string()),serde_json::to_string(&profile.settings)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn delete_profile(&mut self, id: Uuid) -> Result<()> {
        delete(&self.connection, "DELETE FROM profiles WHERE id=?1", id)
    }
    pub fn profile(&self, id: Uuid) -> Result<Option<Profile>> {
        use rusqlite::OptionalExtension;
        let row = self
            .connection
            .query_row(
                "SELECT folder_id,name,credential_ref,settings FROM profiles WHERE id=?1",
                [id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(folder, name, credential, settings)| {
            Ok(Profile {
                id,
                folder_id: folder.map(|v| parse_id(&v)).transpose()?,
                name,
                credential_ref: credential.map(|v| parse_id(&v)).transpose()?,
                settings: serde_json::from_str(&settings)?,
            })
        })
        .transpose()
    }
    pub fn delete_folder(&mut self, id: Uuid) -> Result<()> {
        delete(&self.connection, "DELETE FROM folders WHERE id=?1", id)
    }
    pub fn export(&self) -> Result<Snapshot> {
        let tx = self.connection.unchecked_transaction()?;
        check(&tx)?;
        if metadata(&tx)?.1 != SCHEMA_VERSION {
            return Err(Error::Schema);
        }
        let snapshot = Snapshot {
            format_version: 1,
            folders: self.folders()?,
            profiles: self
                .profiles()?
                .into_iter()
                .map(|p| PortableProfile {
                    id: p.id,
                    folder_id: p.folder_id,
                    name: p.name,
                    settings: p.settings,
                })
                .collect(),
        };
        tx.commit()?;
        Ok(snapshot)
    }
    /// Creates a new backup only; never overwrites an existing target.
    pub fn backup(&self, target: &Path) -> Result<()> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        drop(file);
        self.connection.backup(
            rusqlite::MAIN_DB,
            target,
            None::<fn(rusqlite::backup::Progress)>,
        )?;
        Ok(())
    }
    /// Restore into a new path only. The source is validated read-only and unchanged.
    pub fn restore_to_new(source: &Path, target: &Path) -> Result<Self> {
        let connection = open_database(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let source_store = Self {
            connection,
            path: source.to_owned(),
            migration_backup: None,
        };
        let tx = source_store.connection.unchecked_transaction()?;
        check(&tx)?;
        source_store.validate_content()?;
        source_store.backup(target)?;
        tx.commit()?;
        Self::open(target)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
fn parse_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value)
        .ok()
        .filter(|v| !v.is_nil())
        .ok_or(Error::Invalid("stored UUID"))
}
fn read_folders(connection: &Connection) -> Result<Vec<Folder>> {
    let mut stmt = connection.prepare("SELECT id,parent_id,name FROM folders LIMIT 1025")?;
    let mut rows = stmt.query([])?;
    let mut folders = Vec::new();
    while let Some(row) = rows.next()? {
        let parent: Option<String> = row.get(1)?;
        folders.push(Folder {
            id: parse_id(&row.get::<_, String>(0)?)?,
            parent_id: parent.map(|v| parse_id(&v)).transpose()?,
            name: row.get(2)?,
        });
    }
    Ok(folders)
}
fn validate_folder(folder: &Folder, folders: &[Folder]) -> Result<()> {
    if folder.id.is_nil() || !model::text(&folder.name, 256) {
        return Err(Error::Invalid("folder identity/name"));
    }
    let mut seen = std::collections::HashSet::new();
    seen.insert(folder.id);
    let mut parent = folder.parent_id;
    while let Some(id) = parent {
        if !seen.insert(id) {
            return Err(Error::Invalid("folder cycle"));
        }
        parent = folders
            .iter()
            .find(|f| f.id == id)
            .ok_or(Error::Invalid("folder parent"))?
            .parent_id;
    }
    Ok(())
}
fn delete(connection: &Connection, sql: &str, id: Uuid) -> Result<()> {
    let tx = rusqlite::Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    require_current(&tx)?;
    if tx.execute(sql, [id.to_string()])? == 0 {
        return Err(Error::NotFound);
    }
    tx.commit()?;
    Ok(())
}
