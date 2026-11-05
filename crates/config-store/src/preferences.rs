use crate::{DesktopPreferences, Error, Result, Store, metadata, require_current};
use rusqlite::{Connection, TransactionBehavior, params};

pub(super) fn read(connection: &Connection) -> Result<DesktopPreferences> {
    // Compatibility is read-only. Old backups are never migrated in place.
    if metadata(connection)?.1 < 3 {
        return Ok(DesktopPreferences::default());
    }
    let value: String = connection.query_row(
        "SELECT value FROM desktop_preferences WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let count: i64 =
        connection.query_row("SELECT count(*) FROM desktop_preferences", [], |row| {
            row.get(0)
        })?;
    if count != 1 {
        return Err(Error::Corrupt);
    }
    let preferences: DesktopPreferences =
        serde_json::from_str(&value).map_err(|_| Error::Corrupt)?;
    preferences.validate().map_err(|_| Error::Corrupt)?;
    Ok(preferences)
}
impl Store {
    pub fn preferences(&self) -> Result<DesktopPreferences> {
        read(&self.connection)
    }
    pub fn put_preferences(&mut self, preferences: &DesktopPreferences) -> Result<()> {
        preferences.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        // Do not silently repair malformed or absent existing records.
        read(&tx)?;
        tx.execute(
            "UPDATE desktop_preferences SET value=?1 WHERE id=1",
            params![serde_json::to_string(preferences)?],
        )?;
        tx.commit()?;
        Ok(())
    }
}
