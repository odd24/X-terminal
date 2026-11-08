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

/// A single readable UTF-8 log, projected from the same verified retained archive.
/// Controls are escaped, except CR/LF/tab. No input/authentication capture is added.
pub fn export_text(
    root: &ManagedRoot,
    log_id: Uuid,
    connection: ConnectionRef,
    writer: &mut impl Write,
    mut is_cancelled: impl FnMut() -> bool,
) -> io::Result<ExportSummary> {
    cancelled(&mut is_cancelled)?;
    let mut reader = ArchiveReader::open(root, log_id, connection)?;
    let info = reader.info();
    write!(
        writer,
        "# 终端通信日志 UTF-8\r\n# 连接 {} / 代次 {}\r\n# 范围：记录开始后的接收输出及终端回显，不含认证表单；未独立记录发送方向。\r\n# 保留起点 {}；源起点 {}。起录前、退休或源缺失内容不在本文件中。\r\n\r\n",
        connection.connection_id.0,
        connection.generation,
        info.available_from,
        info.source_available_from
    )?;
    write!(
        writer,
        "# 起录时间（Unix毫秒） {}；源编码 {}\r\n",
        info.metadata.started_at_ms, info.metadata.encoding
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
            let add = |a: u64, b: u64| {
                a.checked_add(b)
                    .ok_or_else(|| io::Error::other("text export counter exhausted"))
            };
            summary.retained_records = add(summary.retained_records, 1)?;
            if let Some(raw) = &record.raw {
                summary.retained_raw_bytes =
                    add(summary.retained_raw_bytes, raw.bytes.len() as u64)?;
                summary.retained_gap_bytes =
                    add(summary.retained_gap_bytes, raw.gap_bytes.unwrap_or(0))?;
            }
            if record.text.gap_bytes.is_some_and(|n| n > 0) {
                write!(
                    writer,
                    "\r\n[接收缺口：{} 字节]\r\n",
                    record.text.gap_bytes.unwrap_or(0)
                )?;
            }
            for ch in record.text.text.chars() {
                if (ch.is_control() && !matches!(ch, '\r' | '\n' | '\t'))
                    || matches!(ch,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{200e}'|'\u{200f}')
                {
                    write!(writer, "\\u{{{:04x}}}", ch as u32)?;
                } else {
                    write!(writer, "{ch}")?;
                }
            }
            if record.text.decode_error {
                write!(writer, "\r\n[此处有解码错误]\r\n")?;
            }
        }
        summary.next_cursor = page.next_cursor;
        if page.finished {
            break;
        }
    }
    cancelled(&mut is_cancelled)?;
    write!(
        writer,
        "\r\n\r\n# 日志结束：上述保留范围已校验，记录 {} 条，保留源缺口 {} 字节。\r\n",
        summary.retained_records, summary.retained_gap_bytes
    )?;
    writer.flush()?;
    cancelled(&mut is_cancelled)?;
    Ok(summary)
}
