//! Test compilation only; fixed local markers, no RPC or arbitrary-path API.
use super::FailureStage;
use std::{
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Normal,
    #[cfg(feature = "audit-diagnostics-fixture")]
    DropAck,
    Queue,
    Write,
    Sync,
    #[cfg(test)]
    Flush,
    Close,
    Inflight,
}
impl Mode {
    #[cfg(feature = "audit-diagnostics-fixture")]
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "normal" => Self::Normal,
            "drop-ack" => Self::DropAck,
            "queue" => Self::Queue,
            "write" => Self::Write,
            "sync" => Self::Sync,
            "close" => Self::Close,
            "inflight" => Self::Inflight,
            _ => return None,
        })
    }
}
pub(super) struct Control {
    root: PathBuf,
    mode: Mode,
    used: AtomicBool,
}
impl Control {
    pub(super) fn new(root: PathBuf, mode: Mode) -> Self {
        Self {
            root,
            mode,
            used: AtomicBool::new(false),
        }
    }
    pub(super) fn before(&self, stage: FailureStage) -> io::Result<()> {
        let target = match self.mode {
            Mode::Normal => return Ok(()),
            #[cfg(feature = "audit-diagnostics-fixture")]
            Mode::DropAck => return Ok(()),
            Mode::Queue | Mode::Write | Mode::Inflight => FailureStage::Append,
            Mode::Sync => FailureStage::Checkpoint,
            #[cfg(test)]
            Mode::Flush => FailureStage::FlushBarrier,
            Mode::Close => FailureStage::CloseBarrier,
        };
        if stage != target
            || !self.root.join("audit-diagnostic-arm").exists()
            || self.used.swap(true, Ordering::SeqCst)
        {
            return Ok(());
        }
        if matches!(self.mode, Mode::Queue | Mode::Inflight) {
            std::fs::write(self.root.join("audit-diagnostic-entered"), b"entered")?;
            let began = Instant::now();
            while !self.root.join("audit-diagnostic-release").exists() {
                if began.elapsed() > Duration::from_secs(10) {
                    return Err(io::Error::other("SYNTHETIC_SECRET_PATH_TOKEN_GATE_TIMEOUT"));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            if self
                .root
                .join("audit-diagnostic-fail-after-release")
                .exists()
            {
                return Err(io::Error::other("SYNTHETIC_SECRET_PATH_TOKEN_SECONDARY_IO"));
            }
            Ok(())
        } else {
            Err(io::Error::other("SYNTHETIC_SECRET_PATH_TOKEN_IO_FAILURE"))
        }
    }
}
#[cfg(feature = "audit-diagnostics-fixture")]
static CONFIG: std::sync::OnceLock<(PathBuf, Mode)> = std::sync::OnceLock::new();
/// Requires explicit test CLI setup before service bootstrap, only own Temp root.
#[cfg(feature = "audit-diagnostics-fixture")]
pub fn configure(root: &Path, mode: &str) -> io::Result<()> {
    let root = root.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    if root.parent() != Some(temp.as_path())
        || !root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("shared-terminal-audit-diagnostic-中文-")
    {
        return Err(io::Error::other("AUDIT_TEST_ROOT_REJECTED"));
    }
    let mode = Mode::parse(mode).ok_or_else(|| io::Error::other("AUDIT_TEST_MODE_REJECTED"))?;
    CONFIG
        .set((root, mode))
        .map_err(|_| io::Error::other("AUDIT_TEST_ALREADY_CONFIGURED"))
}
pub(super) fn for_root(root: &Path) -> Option<Control> {
    #[cfg(feature = "audit-diagnostics-fixture")]
    if let Some((configured, mode)) = CONFIG.get()
        && root.canonicalize().ok().as_ref() == Some(configured)
    {
        return Some(Control::new(configured.clone(), *mode));
    }
    let _ = root;
    None
}
#[cfg(feature = "audit-diagnostics-fixture")]
pub(super) fn mark_closing() {
    if let Some((root, _)) = CONFIG.get() {
        let _ = std::fs::write(root.join("audit-diagnostic-closing"), b"closing");
    }
}
#[cfg(feature = "audit-diagnostics-fixture")]
pub fn drop_shutdown_reply() -> bool {
    CONFIG.get().is_some_and(|(_, mode)| *mode == Mode::DropAck)
}
