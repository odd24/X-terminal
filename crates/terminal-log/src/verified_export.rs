//! Pinned, fingerprint-checked reads of a published managed artifact.
//! The trusted caller supplies the producer's receipt, never a destination path.
use crate::{MAX_EXPORT_BYTES, storage};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, Write},
    path::Path,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportFingerprint {
    pub bytes: u64,
    pub sha256: [u8; 32],
}
pub struct VerifiedExport {
    _guards: Vec<File>,
    file: File,
    fingerprint: ExportFingerprint,
}
fn cancelled(check: &mut impl FnMut() -> bool) -> io::Result<()> {
    if check() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "artifact copy cancelled",
        ))
    } else {
        Ok(())
    }
}
fn stream(
    file: &mut File,
    expected: ExportFingerprint,
    output: &mut impl Write,
    check: &mut impl FnMut() -> bool,
) -> io::Result<()> {
    file.rewind()?;
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0;
    let mut hash = Sha256::new();
    while bytes < expected.bytes {
        cancelled(check)?;
        let limit = (expected.bytes - bytes).min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..limit])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "artifact shortened",
            ));
        }
        output.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
        bytes += count as u64;
    }
    if file.read(&mut buffer[..1])? != 0 || <[u8; 32]>::from(hash.finalize()) != expected.sha256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "artifact fingerprint changed",
        ));
    }
    cancelled(check)?;
    output.flush()?;
    cancelled(check)
}
impl VerifiedExport {
    /// Windows only. Runs on a bounded blocking file worker. All ancestors and
    /// the exact UUID/file are pinned; no export-owner lock or file is created.
    /// The first pass checks size/hash before giving a caller any bytes.
    pub fn open(
        data_directory: &Path,
        export_id: Uuid,
        fingerprint: ExportFingerprint,
        mut is_cancelled: impl FnMut() -> bool,
    ) -> io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        cancelled(&mut is_cancelled)?;
        if export_id.is_nil() || fingerprint.bytes == 0 || fingerprint.bytes > MAX_EXPORT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid artifact receipt",
            ));
        }
        let mut guards = storage::guards(data_directory)?;
        let root = data_directory.join("terminal-log-exports");
        guards.push(storage::pin(&root)?);
        let directory = root.join(export_id.to_string());
        guards.push(storage::pin(&directory)?);
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(0x00200000)
            .open(directory.join("export.jsonl"))?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.file_attributes() & 0x400 != 0 || meta.len() != fingerprint.bytes
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid published artifact",
            ));
        }
        stream(&mut file, fingerprint, &mut io::sink(), &mut is_cancelled)?;
        Ok(Self {
            _guards: guards,
            file,
            fingerprint,
        })
    }
    /// Writes to a fresh private staging sink, hashes the actual copied bytes
    /// again, and flushes. Err may leave a prefix or even all bytes in that sink;
    /// the caller must discard/retain it as failed evidence, never publish it.
    /// Ok is not a destination sync, publication, overwrite authorization, or
    /// durability guarantee. Cancellation cannot interrupt a blocked OS write.
    pub fn copy_to(
        &mut self,
        output: &mut impl Write,
        mut is_cancelled: impl FnMut() -> bool,
    ) -> io::Result<ExportFingerprint> {
        stream(&mut self.file, self.fingerprint, output, &mut is_cancelled)?;
        Ok(self.fingerprint)
    }
}

#[cfg(test)]
mod tests;
