//! Single-owner managed export staging. Never accepts a caller-provided name.
use crate::{
    ExportSummary, ManagedRoot, RecoverySummary, export_jsonl, export_recovery_jsonl, storage,
};
use session_core::session::ConnectionRef;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_EXPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXPORTS: usize = 8;

#[derive(Debug, Clone)]
pub struct ExportArtifact<S = ExportSummary> {
    pub export_id: Uuid,
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub summary: S,
}
pub type RecoveryArtifact = ExportArtifact<RecoverySummary>;
pub struct ExportStore {
    _guards: Vec<File>,
    _lock: File,
    path: PathBuf,
}
struct Limited<W> {
    inner: W,
    bytes: u64,
    hash: Sha256,
}
impl<W: Write> Write for Limited<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = MAX_EXPORT_BYTES - self.bytes;
        if bytes.len() as u64 > remaining {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "export size limit",
            ));
        }
        let count = self.inner.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes += count as u64;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl ExportStore {
    /// Entire fixed flushed ranges, including active files; never stops capture.
    /// Trusted service watermarks are required, not renderer paths or lengths.
    pub fn create_live_bundle(
        &mut self,
        data: &Path,
        sources: &[crate::ReadableSnapshot],
        connection: ConnectionRef,
        export_id: Uuid,
        mut cancel: impl FnMut() -> bool,
    ) -> io::Result<ExportArtifact> {
        if export_id.is_nil()
            || sources.is_empty()
            || sources.len() > 64
            || sources
                .iter()
                .any(|s| s.connection != connection || s.log_id.is_nil())
            || sources
                .iter()
                .map(|s| s.log_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != sources.len()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid live bundle",
            ));
        }
        self.create_inner(export_id,&mut cancel,|output,cancelled|{
            writeln!(output,"# 当前代次全部已记录日志：固定已刷新保留范围快照（{}份）",sources.len())?;
            writeln!(output,"# 每份读取至下列已刷新水位；起录前未记录，源缺口/拒绝内容不在文件；活跃录制继续追加，不包含快照后的新输出。")?;
            let mut total=ExportSummary{retained_records:0,retained_raw_bytes:0,retained_gap_bytes:0,next_cursor:1};
            for source in sources {
                if cancelled(){return Err(io::ErrorKind::Interrupted.into());}
                writeln!(output,"\r\n# 快照范围 {}",serde_json::to_string(source)?)?;
                let mut file=crate::UserLogFile::open(data,&source.filename,connection,source.log_id)?;
                file.copy_prefix(source.bytes,output,&mut *cancelled)?;
                total.retained_records=total.retained_records.checked_add(source.flushed_records).ok_or_else(||io::Error::other("snapshot count exhausted"))?;
                total.retained_gap_bytes=total.retained_gap_bytes.checked_add(source.source_gap_bytes).ok_or_else(||io::Error::other("snapshot gap exhausted"))?;
            }
            output.flush()?;Ok(total)
        })
    }
    /// A complete sequence of stopped, verified retained logs for one generation.
    /// The caller supplies service-approved IDs; no renderer output paths exist.
    pub fn create_text_bundle(
        &mut self,
        source: &ManagedRoot,
        log_ids: &[Uuid],
        connection: ConnectionRef,
        export_id: Uuid,
        mut cancel: impl FnMut() -> bool,
    ) -> io::Result<ExportArtifact> {
        if export_id.is_nil()
            || log_ids.is_empty()
            || log_ids.len() > 64
            || log_ids.iter().any(|id| id.is_nil())
            || log_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != log_ids.len()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid bundle scope",
            ));
        }
        for id in log_ids {
            drop(crate::ArchiveReader::open(source, *id, connection)?);
        }
        self.create_inner(export_id, &mut cancel, |output, cancelled| {
            writeln!(
                output,
                "# 全部已记录日志的保留范围：{} 份；起录前/退休/源缺失内容不在本文件。",
                log_ids.len()
            )?;
            let mut total = ExportSummary {
                retained_records: 0,
                retained_raw_bytes: 0,
                retained_gap_bytes: 0,
                next_cursor: 1,
            };
            for id in log_ids {
                let part =
                    crate::export::export_text(source, *id, connection, output, &mut *cancelled)?;
                for (sum, value) in [
                    (&mut total.retained_records, part.retained_records),
                    (&mut total.retained_raw_bytes, part.retained_raw_bytes),
                    (&mut total.retained_gap_bytes, part.retained_gap_bytes),
                ] {
                    *sum = sum
                        .checked_add(value)
                        .ok_or_else(|| io::Error::other("bundle counter exhausted"))?;
                }
                total.next_cursor = part.next_cursor;
            }
            Ok(total)
        })
    }
    /// Frozen rendered text, distinctly a display snapshot, not communication history.
    pub fn create_display(
        &mut self,
        text: &str,
        export_id: Uuid,
        cancel: impl FnMut() -> bool,
    ) -> io::Result<ExportArtifact> {
        self.create_display_tracked(text, export_id, cancel, || {})
    }

    /// Reports a successfully reserved directory even when later stages fail.
    pub fn create_display_tracked(
        &mut self,
        text: &str,
        export_id: Uuid,
        mut cancel: impl FnMut() -> bool,
        created: impl FnOnce(),
    ) -> io::Result<ExportArtifact> {
        if export_id.is_nil()
            || text.is_empty()
            || text.len() > 4 * 1024 * 1024
            || text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid display snapshot",
            ));
        }
        self.create_inner_tracked(export_id, &mut cancel, created, |output, cancelled| {
            if cancelled() {
                return Err(io::ErrorKind::Interrupted.into());
            }
            output.write_all(text.as_bytes())?;
            output.flush()?;
            Ok(ExportSummary {
                retained_records: 0,
                retained_raw_bytes: 0,
                retained_gap_bytes: 0,
                next_cursor: 1,
            })
        })
    }
    /// Trusted service data directory only, never an IPC/user-supplied output
    /// path. On Windows the exclusive lock prevents multiple export owners.
    pub fn open(data_directory: &Path) -> io::Result<Self> {
        let mut guards = storage::guards(data_directory)?;
        let path = data_directory.join("terminal-log-exports");
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        guards.push(storage::pin(&path)?);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0).custom_flags(0x00200000);
        }
        let lock = options.open(path.join("exports.lock"))?;
        let metadata = lock.metadata()?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "export lock reparse point",
                ));
            }
        }
        if !metadata.is_file() || metadata.len() != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid export lock",
            ));
        }
        Ok(Self {
            _guards: guards,
            _lock: lock,
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    #[cfg(windows)]
    pub fn preview_cleanup(&mut self, id: Uuid) -> io::Result<crate::CleanupPreview> {
        crate::CleanupPreview::open(&self.path, crate::CleanupKind::Export, id)
    }

    /// At most eight fresh UUID directories (including failed attempts), each
    /// with at most 256MiB. No overwrite, automatic pruning, source modification
    /// or implicit retry. Only Ok identifies a published `export.jsonl`.
    /// Errors preserve `.partial` evidence; explicit cleanup is a separate action.
    /// Run on the bounded file worker. Cancellation cannot interrupt sync/rename.
    pub fn create(
        &mut self,
        source: &ManagedRoot,
        log_id: Uuid,
        connection: ConnectionRef,
        export_id: Uuid,
        mut is_cancelled: impl FnMut() -> bool,
    ) -> io::Result<ExportArtifact> {
        if export_id.is_nil() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid export id",
            ));
        }
        // Reject a bad source identity before reserving output disk capacity.
        // This is only header inspection; full validation still happens below.
        let checked = crate::ArchiveReader::open(source, log_id, connection)?;
        drop(checked);
        self.create_inner(export_id, &mut is_cancelled, |output, cancelled| {
            export_jsonl(source, log_id, connection, output, cancelled)
        })
    }

    /// Explicit recovery mode, sharing the same eight attempts / 256MiB budget,
    /// fingerprinting, private staging and no-overwrite publication as create.
    /// Ok means the incomplete artifact was synced/published, never that its
    /// source completed. The distinct summary preserves the exact stop report.
    pub fn create_recovery(
        &mut self,
        source: &ManagedRoot,
        log_id: Uuid,
        connection: ConnectionRef,
        export_id: Uuid,
        mut is_cancelled: impl FnMut() -> bool,
    ) -> io::Result<RecoveryArtifact> {
        if export_id.is_nil() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid export id",
            ));
        }
        let checked = crate::RecoveryReader::open(source, log_id, connection)?;
        drop(checked);
        self.create_inner(export_id, &mut is_cancelled, |output, cancelled| {
            export_recovery_jsonl(source, log_id, connection, output, cancelled)
        })
    }

    pub fn create_text(
        &mut self,
        source: &ManagedRoot,
        log_id: Uuid,
        connection: ConnectionRef,
        export_id: Uuid,
        mut is_cancelled: impl FnMut() -> bool,
    ) -> io::Result<ExportArtifact> {
        if export_id.is_nil() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid text export id",
            ));
        }
        drop(crate::ArchiveReader::open(source, log_id, connection)?);
        self.create_inner(export_id, &mut is_cancelled, |output, cancelled| {
            crate::export::export_text(source, log_id, connection, output, cancelled)
        })
    }

    fn create_inner<S>(
        &mut self,
        export_id: Uuid,
        is_cancelled: impl FnMut() -> bool,
        stream: impl FnOnce(&mut Limited<BufWriter<File>>, &mut dyn FnMut() -> bool) -> io::Result<S>,
    ) -> io::Result<ExportArtifact<S>> {
        self.create_inner_tracked(export_id, is_cancelled, || {}, stream)
    }

    fn create_inner_tracked<S>(
        &mut self,
        export_id: Uuid,
        mut is_cancelled: impl FnMut() -> bool,
        created: impl FnOnce(),
        stream: impl FnOnce(&mut Limited<BufWriter<File>>, &mut dyn FnMut() -> bool) -> io::Result<S>,
    ) -> io::Result<ExportArtifact<S>> {
        if is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "export cancelled",
            ));
        }
        let mut count = 0;
        for entry in fs::read_dir(&self.path)? {
            let entry = entry?;
            if entry.file_name() == "exports.lock" {
                continue;
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| io::Error::other("invalid export entry"))?;
            let id = Uuid::parse_str(&name)
                .ok()
                .filter(|id| !id.is_nil() && id.to_string() == name)
                .ok_or_else(|| io::Error::other("unrecognized export entry"))?;
            let _guard = storage::pin(&self.path.join(id.to_string()))?;
            count += 1;
            if count >= MAX_EXPORTS {
                return Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "export catalogue full",
                ));
            }
        }
        let directory = self.path.join(export_id.to_string());
        fs::create_dir(&directory)?;
        created();
        let _guard = storage::pin(&directory)?;
        let partial = directory.join("export.partial");
        let file = storage::file(&partial)?;
        let mut output = Limited {
            inner: BufWriter::with_capacity(32 * 1024, file),
            bytes: 0,
            hash: Sha256::new(),
        };
        let summary = stream(&mut output, &mut is_cancelled)?;
        output.inner.get_ref().sync_all()?;
        if is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "export cancelled",
            ));
        }
        let bytes = output.bytes;
        let sha256 = output.hash.clone().finalize().into();
        drop(output);
        storage::publish(&partial, &directory.join("export.jsonl"))?;
        Ok(ExportArtifact {
            export_id,
            bytes,
            sha256,
            summary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fingerprint_counts_only_bytes_accepted_by_short_writes() {
        struct Short(Vec<u8>);
        impl Write for Short {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let n = bytes.len().min(2);
                self.0.extend_from_slice(&bytes[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut output = Limited {
            inner: Short(vec![]),
            bytes: 0,
            hash: Sha256::new(),
        };
        output.write_all(b"abc").unwrap();
        assert_eq!(output.bytes, 3);
        assert_eq!(output.inner.0, b"abc");
        assert_eq!(
            output
                .hash
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
    #[test]
    fn byte_limit_rejects_before_forwarding_to_sink() {
        let mut limited = Limited {
            inner: Vec::new(),
            bytes: MAX_EXPORT_BYTES - 2,
            hash: Sha256::new(),
        };
        limited.write_all(&[1, 2]).unwrap();
        assert_eq!(
            limited.write(&[3]).unwrap_err().kind(),
            io::ErrorKind::FileTooLarge
        );
        assert_eq!(limited.inner, [1, 2]);
        assert_eq!(limited.bytes, MAX_EXPORT_BYTES);
    }
}
