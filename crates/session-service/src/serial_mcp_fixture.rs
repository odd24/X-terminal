//! Explicit test build/CLI only; real Port-call counters, never input contents.
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    os::windows::fs::OpenOptionsExt,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use transport_serial::worker::{OUTPUT_CHUNKS, READ_BYTES};

pub(crate) const GAP_BURST_READS: usize = OUTPUT_CHUNKS + 1;
pub(crate) const GAP_PREFIX: &[u8] = b"JOIN-";

#[derive(Default)]
struct DrainGate {
    deadline: Option<Instant>,
    released: bool,
}

impl DrainGate {
    fn hold(&mut self, now: Instant, read_bytes: u64) -> io::Result<bool> {
        if self.released {
            return Ok(false);
        }
        let deadline = *self.deadline.get_or_insert(now + Duration::from_secs(2));
        if now >= deadline {
            self.released = true;
            return Err(io::ErrorKind::TimedOut.into());
        }
        if read_bytes >= (GAP_BURST_READS * READ_BYTES) as u64 {
            self.released = true;
        }
        Ok(!self.released)
    }
}

#[derive(Clone)]
pub(crate) struct Trace(Arc<Mutex<Controller>>, Option<Arc<Mutex<DrainGate>>>);
struct Controller {
    file: File,
    state: Snapshot,
    root: std::path::PathBuf,
    gate_used: bool,
    read_fault_used: bool,
}
#[derive(Default, Serialize)]
struct Snapshot {
    version: u8,
    opened: u32,
    write_calls: u32,
    write_bytes: u64,
    control_calls: u32,
    controls: Vec<Control>,
    dtr: bool,
    rts: Option<bool>,
    break_asserted: bool,
}
#[derive(Serialize)]
struct Control {
    line: &'static str,
    asserted: bool,
}
static TRACE: OnceLock<Trace> = OnceLock::new();
pub fn configure(root: &Path) -> io::Result<()> {
    let root = root.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    if root.parent() != Some(temp.as_path())
        || !root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("shared-terminal-mcp-serial-control-中文-")
    {
        return Err(io::Error::other("SERIAL_MCP_ROOT_REJECTED"));
    }
    let wait_gap = match std::fs::symlink_metadata(root.join("serial-mcp-wait-gap")) {
        Ok(marker) if marker.file_type().is_file() && marker.len() == 0 => {
            Some(DrainGate::default())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        _ => return Err(io::Error::other("SERIAL_MCP_WAIT_GAP_MARKER_REJECTED")),
    };
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(1)
        .open(root.join("serial-mcp-controller.json"))?;
    let trace = Trace(
        Arc::new(Mutex::new(Controller {
            file,
            root,
            gate_used: false,
            read_fault_used: false,
            state: Snapshot {
                version: 1,
                ..Snapshot::default()
            },
        })),
        wait_gap.map(|gate| Arc::new(Mutex::new(gate))),
    );
    trace.edit(|_| Ok(()))?;
    TRACE
        .set(trace)
        .map_err(|_| io::Error::other("SERIAL_MCP_ALREADY_CONFIGURED"))
}
impl Trace {
    pub(crate) fn wait_gap_burst(&self) -> usize {
        if self.1.is_some() { GAP_BURST_READS } else { 0 }
    }

    pub(crate) fn fail_read_once(&self) -> io::Result<()> {
        let mut controller = self
            .0
            .lock()
            .map_err(|_| io::Error::other("SERIAL_MCP_COUNTER_FAILED"))?;
        if !controller.read_fault_used && controller.root.join("serial-mcp-fail-read").is_file() {
            controller.read_fault_used = true;
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(())
    }

    pub(crate) fn observe_close(&self) -> io::Result<()> {
        let root = self
            .0
            .lock()
            .map_err(|_| io::Error::other("SERIAL_MCP_COUNTER_FAILED"))?
            .root
            .clone();
        if root.join("serial-mcp-close-hold").exists() {
            Self::wait_for_release(&root, "serial-mcp-closing", "serial-mcp-close-release")?;
            std::fs::write(root.join("serial-mcp-closed"), b"closed")?;
        }
        Ok(())
    }

    pub(crate) fn gate_before_write(&self) -> io::Result<()> {
        let root = {
            let mut c = self
                .0
                .lock()
                .map_err(|_| io::Error::other("SERIAL_MCP_COUNTER_FAILED"))?;
            if c.gate_used || !c.root.join("serial-mcp-hold").exists() {
                return Ok(());
            }
            c.gate_used = true;
            c.root.clone()
        };
        Self::wait_for_release(&root, "serial-mcp-entered", "serial-mcp-release")
    }

    fn wait_for_release(root: &Path, entered: &str, release: &str) -> io::Result<()> {
        std::fs::write(root.join(entered), b"entered")?;
        let start = std::time::Instant::now();
        while !root.join(release).exists() {
            if start.elapsed() > std::time::Duration::from_secs(5) {
                return Err(io::Error::other("SERIAL_MCP_GATE_TIMEOUT"));
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        Ok(())
    }
    fn edit(&self, change: impl FnOnce(&mut Snapshot) -> io::Result<()>) -> io::Result<()> {
        let mut c = self
            .0
            .lock()
            .map_err(|_| io::Error::other("SERIAL_MCP_COUNTER_FAILED"))?;
        change(&mut c.state)?;
        let bytes = serde_json::to_vec(&c.state)
            .map_err(|_| io::Error::other("SERIAL_MCP_COUNTER_FAILED"))?;
        c.file.seek(SeekFrom::Start(0))?;
        c.file.set_len(0)?;
        c.file.write_all(&bytes)?;
        c.file.flush()
    }
    pub(crate) fn wrote(&self, bytes: usize) -> io::Result<()> {
        self.edit(|s| {
            s.write_bytes += bytes as u64;
            Ok(())
        })
    }
    pub(crate) fn begin_write(&self) -> io::Result<()> {
        self.edit(|s| {
            if s.write_calls >= 128 {
                return Err(io::Error::other("SERIAL_MCP_LIMIT"));
            }
            s.write_calls += 1;
            Ok(())
        })
    }
    pub(crate) fn begin_control(&self) -> io::Result<()> {
        self.edit(|s| {
            if s.control_calls >= 128 {
                return Err(io::Error::other("SERIAL_MCP_LIMIT"));
            }
            s.control_calls += 1;
            Ok(())
        })
    }
    pub(crate) fn controlled(&self, line: &'static str, asserted: bool) -> io::Result<()> {
        self.edit(|s| {
            if s.controls.len() >= 64 {
                return Err(io::Error::other("SERIAL_MCP_LIMIT"));
            }
            match line {
                "DTR" => s.dtr = asserted,
                "RTS" => s.rts = Some(asserted),
                "BREAK" => s.break_asserted = asserted,
                _ => return Err(io::Error::other("SERIAL_MCP_COUNTER_FAILED")),
            }
            s.controls.push(Control { line, asserted });
            Ok(())
        })
    }
}
pub(crate) fn opened(dtr: bool, rts: Option<bool>) -> io::Result<Option<Trace>> {
    let Some(trace) = TRACE.get() else {
        return Ok(None);
    };
    let limit = if trace.wait_gap_burst() != 0 { 1 } else { 8 };
    trace.edit(|s| {
        if s.opened >= limit {
            return Err(io::Error::other("SERIAL_MCP_LIMIT"));
        }
        s.opened += 1;
        s.dtr = dtr;
        s.rts = rts;
        s.break_asserted = false;
        Ok(())
    })?;
    Ok(Some(trace.clone()))
}

pub(crate) fn hold_wait_gap_drain(read_bytes: u64) -> io::Result<bool> {
    let Some(gate) = TRACE.get().and_then(|trace| trace.1.as_ref()) else {
        return Ok(false);
    };
    gate.lock()
        .map_err(|_| io::Error::other("SERIAL_MCP_WAIT_GAP_GATE_FAILED"))?
        .hold(Instant::now(), read_bytes)
}

#[cfg(test)]
#[test]
fn wait_gap_drain_releases_at_real_read_watermark_or_deadline() {
    let now = Instant::now();
    let total = (GAP_BURST_READS * READ_BYTES) as u64;
    let mut ready = DrainGate::default();
    assert!(ready.hold(now, total - 1).unwrap());
    assert!(!ready.hold(now, total).unwrap());
    assert!(!ready.hold(now, 0).unwrap());
    let mut stalled = DrainGate::default();
    assert!(stalled.hold(now, 0).unwrap());
    assert_eq!(
        stalled
            .hold(now + Duration::from_secs(2), total - 1)
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert!(!stalled.hold(now, 0).unwrap());
}

pub(crate) fn gate_before_open() -> io::Result<()> {
    let Some(trace) = TRACE.get() else {
        return Ok(());
    };
    let root = trace
        .0
        .lock()
        .map_err(|_| io::Error::other("SERIAL_MCP_COUNTER_FAILED"))?
        .root
        .clone();
    if root.join("serial-mcp-open-hold").exists() {
        Trace::wait_for_release(&root, "serial-mcp-open-entered", "serial-mcp-open-release")?;
    }
    Ok(())
}
