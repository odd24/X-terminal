//! Portable evidence of an explicitly recovered prefix, never a completed log.
use crate::{ManagedRoot, RecoveryReader, RecoveryStop};
use serde::Serialize;
use session_core::session::ConnectionRef;
use std::io::{self, Write};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecoverySummary {
    pub recovered_records: u64,
    pub recovered_raw_bytes: u64,
    pub recovered_gap_bytes: u64,
    pub next_cursor: u64,
    pub stop: RecoveryStop,
}
fn cancelled(check: &mut impl FnMut() -> bool) -> io::Result<()> {
    if check() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "recovery export cancelled",
        ))
    } else {
        Ok(())
    }
}
fn line(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(io::Error::from)?;
    writer.write_all(b"\n")
}
fn add(value: u64, amount: u64) -> io::Result<u64> {
    value
        .checked_add(amount)
        .ok_or_else(|| io::Error::other("recovery export counter exhausted"))
}
/// Explicit salvage only. Reopens the exact source from its earliest observed
/// paired header and streams 32KiB pages, ignoring no damaged records. A source
/// failure becomes a stable `recovery_stopped` report after the valid prefix.
/// Even END_OF_AVAILABLE is incomplete; no `verified`/completion line is emitted.
///
/// The caller authorizes scope and supplies a fresh private staging sink on a
/// bounded blocking worker. Ok proves that the prefix and stop report were
/// written/flushed, not source completeness, sync, publication or save approval.
/// Err may leave partial or all bytes including the final line: do not publish.
/// Cancellation cannot interrupt a stuck writer. No source files are modified.
pub fn export_recovery_jsonl(
    root: &ManagedRoot,
    log_id: Uuid,
    connection: ConnectionRef,
    writer: &mut impl Write,
    mut is_cancelled: impl FnMut() -> bool,
) -> io::Result<RecoverySummary> {
    cancelled(&mut is_cancelled)?;
    let mut reader = RecoveryReader::open(root, log_id, connection)?;
    cancelled(&mut is_cancelled)?;
    line(
        writer,
        &serde_json::json!({
            "type": "recovery_header", "format": "shared-terminal-recovery-export",
            "format_version": 1, "incomplete": true, "source": reader.info(),
        }),
    )?;
    let mut records = 0;
    let mut raw_bytes = 0;
    let mut gap_bytes = 0;
    loop {
        cancelled(&mut is_cancelled)?;
        let page = reader.read_page(128, 32 * 1024)?;
        for record in page.records {
            cancelled(&mut is_cancelled)?;
            records = add(records, 1)?;
            if let Some(raw) = &record.raw {
                raw_bytes = add(raw_bytes, raw.bytes.len() as u64)?;
                gap_bytes = add(gap_bytes, raw.gap_bytes.unwrap_or(0))?;
            }
            line(
                writer,
                &serde_json::json!({"type": "record", "raw": record.raw, "text": record.text}),
            )?;
        }
        if let Some(stop) = page.stop {
            let summary = RecoverySummary {
                recovered_records: records,
                recovered_raw_bytes: raw_bytes,
                recovered_gap_bytes: gap_bytes,
                next_cursor: page.next_cursor,
                stop,
            };
            cancelled(&mut is_cancelled)?;
            line(
                writer,
                &serde_json::json!({"type": "recovery_stopped", "incomplete": true, "recovered": summary}),
            )?;
            writer.flush()?;
            cancelled(&mut is_cancelled)?;
            return Ok(summary);
        }
    }
}
