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
    let preferences: DesktopPreferences = if metadata(connection)?.1 == 3 {
        // Versioned legacy shape keeps duplicate, unknown and missing field rejection.
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct LegacyPreferences {
            theme: crate::ThemeChoice,
            terminal_font: crate::TerminalFont,
            font_size: u8,
            ctrl_c_copy: bool,
            ctrl_v_paste: bool,
            right_click_paste: bool,
        }
        let old: LegacyPreferences = serde_json::from_str(&value).map_err(|_| Error::Corrupt)?;
        DesktopPreferences {
            theme: old.theme,
            terminal_font: old.terminal_font,
            terminal_palette: crate::TerminalPalette::FollowTheme,
            font_size: old.font_size,
            ctrl_c_copy: old.ctrl_c_copy,
            ctrl_v_paste: old.ctrl_v_paste,
            right_click_paste: old.right_click_paste,
        }
    } else {
        serde_json::from_str(&value).map_err(|_| Error::Corrupt)?
    };
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
