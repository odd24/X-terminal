//! Explicit fixture CLI only. No renderer entry point.
use std::{
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
};
static ROOT: OnceLock<PathBuf> = OnceLock::new();
pub fn configure(root: &Path, fixture: bool) -> io::Result<()> {
    let root = root.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    if !fixture
        || root.parent() != Some(temp.as_path())
        || !root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("shared-terminal-mcp-serial-control-中文-")
    {
        return Err(io::Error::other("SERIAL_MCP_ROOT_REJECTED"));
    }
    ROOT.set(root)
        .map_err(|_| io::Error::other("SERIAL_MCP_ALREADY_CONFIGURED"))
}
pub fn enabled(root: &Path) -> bool {
    ROOT.get()
        .is_some_and(|expected| root.canonicalize().ok().as_ref() == Some(expected))
}

#[cfg(test)]
pub(crate) fn wait_gap_binary(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../target/serial-mcp-wait-gap-fixture")
        .join(name)
}
