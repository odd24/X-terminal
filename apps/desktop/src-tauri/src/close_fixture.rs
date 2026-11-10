//! Explicit test build only, before child spawn; never exposed to the renderer.
use std::{
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
};
static CONFIG: OnceLock<(PathBuf, String)> = OnceLock::new();
pub fn configure(root: &Path, mode: &str, fixture: bool) -> io::Result<()> {
    let root = root.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    if !fixture
        || root.parent() != Some(temp.as_path())
        || !root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("shared-terminal-audit-diagnostic-中文-")
        || !matches!(mode, "normal" | "close" | "inflight" | "drop-ack")
    {
        return Err(io::Error::other("CLOSE_RECEIPT_TEST_REJECTED"));
    }
    CONFIG
        .set((root, mode.into()))
        .map_err(|_| io::Error::other("CLOSE_RECEIPT_TEST_ALREADY_CONFIGURED"))
}
pub fn mode(root: &Path) -> Option<&'static str> {
    CONFIG
        .get()
        .filter(|(configured, _)| root.canonicalize().ok().as_ref() == Some(configured))
        .map(|(_, mode)| mode.as_str())
}
