//! Explicit test build only. Accepts one owned root and one fixed checkpoint.
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};
use terminal_log::SaveCheckpoint;

static CONFIG: OnceLock<(PathBuf, String)> = OnceLock::new();

pub fn configure(root: &Path, mode: &str, fixture: bool) -> io::Result<()> {
    let root = root.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    let parent = root
        .parent()
        .ok_or_else(|| io::Error::other("missing test parent"))?;
    if !fixture
        || parent.parent() != Some(temp.as_path())
        || !parent
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("shared-terminal-save-ui-中文-recovery-")
        || root.file_name().is_none_or(|name| name != "应用数据")
        || !matches!(mode, "intent" | "backup" | "published" | "terminal-failure")
    {
        return Err(io::Error::other("SAVE_RECOVERY_TEST_REJECTED"));
    }
    CONFIG
        .set((root, mode.into()))
        .map_err(|_| io::Error::other("SAVE_RECOVERY_TEST_ALREADY_CONFIGURED"))
}

pub fn checkpoint(root: &Path, point: SaveCheckpoint) {
    let Some((configured, mode)) = CONFIG.get() else {
        return;
    };
    if root.canonicalize().ok().as_ref() != Some(configured) {
        return;
    }
    let hit = match point {
        SaveCheckpoint::IntentSynced => mode == "intent",
        SaveCheckpoint::BackupMoved => mode == "backup",
        SaveCheckpoint::Published => matches!(mode.as_str(), "published" | "terminal-failure"),
    };
    if !hit {
        return;
    }
    File::create_new(configured.join("save-test-reached")).expect("test checkpoint marker");
    let limit = Instant::now() + Duration::from_secs(30);
    while Instant::now() < limit {
        if mode == "terminal-failure" && configured.join("save-test-release").is_file() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("isolated save test checkpoint timed out");
}
