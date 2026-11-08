use crate::{Error, Result, Store, Workspace, metadata, require_current};
use rusqlite::{Connection, TransactionBehavior, params};
use uuid::Uuid;
pub(super) fn read(connection: &Connection) -> Result<Vec<Workspace>> {
    if metadata(connection)?.1 < 5 {
        return Ok(Vec::new());
    }
    let mut statement =
        connection.prepare("SELECT id,value FROM workspaces ORDER BY id LIMIT 9")?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut result = Vec::new();
    for row in rows {
        let (id, text) = row?;
        let value: Workspace = serde_json::from_str(&text).map_err(|_| Error::Corrupt)?;
        value.validate().map_err(|_| Error::Corrupt)?;
        if id != value.id.to_string() {
            return Err(Error::Corrupt);
        }
        result.push(value);
    }
    if result.len() > 8 {
        return Err(Error::Invalid("workspace limit"));
    }
    Ok(result)
}
impl Store {
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        read(&self.connection)
    }
    pub fn put_workspace(&mut self, workspace: &Workspace) -> Result<()> {
        workspace.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        let current = read(&tx)?;
        if current.len() >= 8 && !current.iter().any(|w| w.id == workspace.id) {
            return Err(Error::Invalid("workspace limit"));
        }
        for tab in &workspace.tabs {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE id=?1)",
                [tab.profile_id.to_string()],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::NotFound);
            }
        }
        let mut expected = current;
        expected.retain(|w| w.id != workspace.id);
        expected.push(workspace.clone());
        expected.sort_by_key(|w| w.id);
        if tx.execute("INSERT INTO workspaces(id,value) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![workspace.id.to_string(),serde_json::to_string(workspace)?])?!=1||read(&tx)?!=expected{return Err(Error::Corrupt);}
        tx.commit()?;
        Ok(())
    }
    pub fn delete_workspace(&mut self, id: Uuid) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        let mut expected = read(&tx)?;
        expected.retain(|w| w.id != id);
        if tx.execute("DELETE FROM workspaces WHERE id=?1", [id.to_string()])? != 1 {
            return Err(Error::NotFound);
        }
        if read(&tx)? != expected {
            return Err(Error::Corrupt);
        }
        tx.commit()?;
        Ok(())
    }
}
