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
        mut is_cancelled: impl FnMut() -> bool,
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
