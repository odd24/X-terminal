//! Portable, streaming evidence export. File selection/publication belongs to
//! the caller; an error leaves an incomplete sink, never a successful export.
use crate::{ArchiveReader, ManagedRoot};
use serde::Serialize;
use session_core::session::ConnectionRef;
use std::io::{self, Write};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportSummary {
    pub retained_records: u64,
    pub retained_raw_bytes: u64,
    pub retained_gap_bytes: u64,
    pub next_cursor: u64,
}

fn line(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(io::Error::from)?;
    writer.write_all(b"\n")
}
fn cancelled(check: &mut impl FnMut() -> bool) -> io::Result<()> {
    if check() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "export cancelled",
        ))
    } else {
        Ok(())
    }
}

/// Export the entire *retained* range from a fresh immutable reader. JSONL v1
/// keeps raw byte arrays and decoded text events distinct, preserving timestamps,
/// source gaps and final flush. It never executes or reinterprets terminal data.
/// Memory is bounded by a 32KiB logical page plus one bounded serialized record.
/// `source_completion` is a declaration; only the final `verified` line means
/// retained content passed validation. This is not authentication or a claim that
/// retired/capture-before bytes exist. Missing legacy gap totals stay unknown.
///
/// Call on a blocking file worker, outside session/input locks. The caller must
/// authorize the exact scope, provide a fresh private staging sink, sync it and
/// publish without overwrite only after Ok. Err (including flush/cancellation)
/// means do not publish, even if the sink contains a final line. No filesystem
/// durability or cancellation of a stuck writer is promised by this function.
pub fn export_jsonl(
    root: &ManagedRoot,
    log_id: Uuid,
    connection: ConnectionRef,
    writer: &mut impl Write,
    mut is_cancelled: impl FnMut() -> bool,
) -> io::Result<ExportSummary> {
    cancelled(&mut is_cancelled)?;
    let mut reader = ArchiveReader::open(root, log_id, connection)?;
    let info = reader.info();
    line(
        writer,
        &serde_json::json!({
            "type": "header", "format": "shared-terminal-export", "format_version": 1,
            "metadata": info.metadata, "source_completion": info.completion,
            "limits": info.limits, "available_from": info.available_from,
            "source_available_from": info.source_available_from,
        }),
    )?;
    let mut summary = ExportSummary {
        retained_records: 0,
        retained_raw_bytes: 0,
        retained_gap_bytes: 0,
        next_cursor: info.available_from,
    };
    loop {
        cancelled(&mut is_cancelled)?;
        let page = reader.read_page(128, 32 * 1024)?;
        for record in page.records {
            cancelled(&mut is_cancelled)?;
            // ArchiveReader already checks these counters against bounded source
            // counters; checked arithmetic here keeps the export independently safe.
            let add = |a: u64, b: u64| {
                a.checked_add(b)
                    .ok_or_else(|| io::Error::other("export counter exhausted"))
            };
            summary.retained_records = add(summary.retained_records, 1)?;
            if let Some(raw) = &record.raw {
                summary.retained_raw_bytes =
                    add(summary.retained_raw_bytes, raw.bytes.len() as u64)?;
                summary.retained_gap_bytes =
                    add(summary.retained_gap_bytes, raw.gap_bytes.unwrap_or(0))?;
            }
            line(
                writer,
                &serde_json::json!({
                    "type": "record", "raw": record.raw, "text": record.text,
                }),
            )?;
        }
        summary.next_cursor = page.next_cursor;
        if page.finished {
            break;
        }
    }
    cancelled(&mut is_cancelled)?;
    line(
        writer,
        &serde_json::json!({"type": "verified", "retained": summary}),
    )?;
    writer.flush()?;
    cancelled(&mut is_cancelled)?;
    Ok(summary)
}
