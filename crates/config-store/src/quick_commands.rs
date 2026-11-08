use crate::{Error, QuickCommand, Result, Store, metadata, require_current};
use rusqlite::{Connection, TransactionBehavior, params};
use std::collections::HashSet;
use uuid::Uuid;
pub(super) fn validate_list(commands: &[QuickCommand]) -> Result<()> {
    if commands.len() > 64 || serde_json::to_vec(commands)?.len() > 256 * 1024 {
        return Err(Error::Invalid("quick command library limit"));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut groups = HashSet::new();
    for c in commands {
        c.validate()?;
        if !ids.insert(c.id) || !names.insert((&c.group, &c.name)) {
            return Err(Error::Corrupt);
        }
        groups.insert(&c.group);
    }
    if groups.len() > 16 {
        return Err(Error::Invalid("quick command group limit"));
    }
    Ok(())
}
pub(super) fn read(connection: &Connection) -> Result<Vec<QuickCommand>> {
    if metadata(connection)?.1 < 7 {
        return Ok(Vec::new());
    }
    let mut statement =
        connection.prepare("SELECT id,value FROM quick_commands ORDER BY id LIMIT 65")?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut commands = Vec::new();
    for row in rows {
        let (id, text) = row?;
        let c: QuickCommand = serde_json::from_str(&text).map_err(|_| Error::Corrupt)?;
        if id != c.id.to_string() {
            return Err(Error::Corrupt);
        }
        commands.push(c);
    }
    validate_list(&commands)?;
    Ok(commands)
}
impl Store {
    pub fn quick_commands(&self) -> Result<Vec<QuickCommand>> {
        read(&self.connection)
    }
    pub fn put_quick_command(&mut self, command: &QuickCommand) -> Result<()> {
        command.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        let mut expected = read(&tx)?;
        expected.retain(|c| c.id != command.id);
        expected.push(command.clone());
        expected.sort_by_key(|c| c.id);
        validate_list(&expected)?;
        if tx.execute("INSERT INTO quick_commands(id,value) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![command.id.to_string(),serde_json::to_string(command)?])?!=1||read(&tx)?!=expected{return Err(Error::Corrupt);}
        tx.commit()?;
        Ok(())
    }
    pub fn delete_quick_command(&mut self, id: Uuid) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        let mut expected = read(&tx)?;
        expected.retain(|c| c.id != id);
        if tx.execute("DELETE FROM quick_commands WHERE id=?1", [id.to_string()])? != 1 {
            return Err(Error::NotFound);
        }
        if read(&tx)? != expected {
            return Err(Error::Corrupt);
        }
        tx.commit()?;
        Ok(())
    }
}
