use super::*;
use crate::{CleanupPreview, ExportStore};
use std::{fs, path::PathBuf};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "shared-terminal-export-copy-中文-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("shared-terminal-export-copy-中文-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn fingerprint(bytes: &[u8]) -> ExportFingerprint {
    ExportFingerprint {
        bytes: bytes.len() as u64,
        sha256: Sha256::digest(bytes).into(),
    }
}
fn fixture(temp: &Temp, bytes: &[u8]) -> (ExportStore, Uuid, PathBuf, ExportFingerprint) {
    let store = ExportStore::open(&temp.0).unwrap();
    let id = Uuid::new_v4();
    let path = store.path().join(id.to_string());
    fs::create_dir(&path).unwrap();
    let file = path.join("export.jsonl");
    fs::write(&file, bytes).unwrap();
    (store, id, file, fingerprint(bytes))
}
#[test]
fn exact_artifact_is_pinned_while_copying_and_does_not_take_the_export_owner_lock() {
    let temp = Temp::new();
    let bytes = vec![0x71; 150000];
    let (_owner, id, path, expected) = fixture(&temp, &bytes);
    let mut source = VerifiedExport::open(&temp.0, id, expected, || false).unwrap();
    assert!(fs::write(&path, b"changed").is_err());
    assert!(CleanupPreview::export(&temp.0, id).is_err());
    assert!(fs::rename(path.parent().unwrap(), temp.0.join("renamed")).is_err());
    let mut output = Vec::new();
    assert_eq!(source.copy_to(&mut output, || false).unwrap(), expected);
    assert_eq!(output, bytes);
    drop(source);
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert!(
        CleanupPreview::export(&temp.0, id)
            .unwrap()
            .apply()
            .directory_removed
    );
}
#[test]
fn changed_size_hash_or_partial_only_artifacts_never_open_as_verified_sources() {
    let temp = Temp::new();
    let (_, id, path, expected) = fixture(&temp, b"abc");
    assert_eq!(
        expected
            .sha256
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    for receipt in [
        ExportFingerprint {
            bytes: 2,
            ..expected
        },
        ExportFingerprint {
            bytes: 4,
            ..expected
        },
        ExportFingerprint {
            sha256: [0; 32],
            ..expected
        },
        ExportFingerprint {
            bytes: 0,
            ..expected
        },
        ExportFingerprint {
            bytes: MAX_EXPORT_BYTES + 1,
            ..expected
        },
    ] {
        assert!(VerifiedExport::open(&temp.0, id, receipt, || false).is_err());
    }
    fs::write(&path, b"abd").unwrap();
    assert!(VerifiedExport::open(&temp.0, id, expected, || false).is_err());
    fs::rename(&path, path.with_file_name("export.partial")).unwrap();
    assert!(VerifiedExport::open(&temp.0, id, expected, || false).is_err());
    assert_eq!(
        fs::read(path.with_file_name("export.partial")).unwrap(),
        b"abd"
    );
    assert!(VerifiedExport::open(&temp.0, Uuid::nil(), expected, || false).is_err());
}
#[test]
fn absent_roots_and_cancellation_do_not_create_files_and_cancelled_copy_is_only_a_prefix() {
    let temp = Temp::new();
    let expected = fingerprint(b"abc");
    assert!(VerifiedExport::open(&temp.0, Uuid::new_v4(), expected, || false).is_err());
    assert!(fs::read_dir(&temp.0).unwrap().next().is_none());
    assert!(VerifiedExport::open(&temp.0, Uuid::new_v4(), expected, || true).is_err());
    assert!(fs::read_dir(&temp.0).unwrap().next().is_none());
    let (_, id, _, expected) = fixture(&temp, &vec![3; 150000]);
    let mut source = VerifiedExport::open(&temp.0, id, expected, || false).unwrap();
    let mut calls = 0;
    let mut output = Vec::new();
    assert_eq!(
        source
            .copy_to(&mut output, || {
                calls += 1;
                calls >= 2
            })
            .unwrap_err()
            .kind(),
        io::ErrorKind::Interrupted
    );
    assert_eq!(output.len(), 65536);
    let mut complete = Vec::new();
    assert_eq!(source.copy_to(&mut complete, || false).unwrap(), expected);
    assert_eq!(complete.len(), 150000);
}
#[test]
fn copy_propagates_short_writes_and_flush_failures_without_claiming_publication() {
    struct Sink {
        bytes: Vec<u8>,
        budget: usize,
        flush_fails: bool,
    }
    impl Write for Sink {
        fn write(&mut self, value: &[u8]) -> io::Result<usize> {
            if self.budget == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "synthetic copy failure",
                ));
            }
            let n = value.len().min(self.budget);
            self.bytes.extend_from_slice(&value[..n]);
            self.budget -= n;
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.flush_fails {
                Err(io::Error::other("synthetic flush failure"))
            } else {
                Ok(())
            }
        }
    }
    let temp = Temp::new();
    let (_, id, _, expected) = fixture(&temp, b"synthetic export payload");
    let mut source = VerifiedExport::open(&temp.0, id, expected, || false).unwrap();
    for (budget, flush_fails) in [(3, false), (usize::MAX, true)] {
        let mut sink = Sink {
            bytes: vec![],
            budget,
            flush_fails,
        };
        assert!(source.copy_to(&mut sink, || false).is_err());
        assert_eq!(sink.bytes.len(), budget.min(expected.bytes as usize));
    }
}
#[test]
fn reparse_export_directories_and_fixed_file_names_are_rejected_without_following_targets() {
    let temp = Temp::new();
    let store = ExportStore::open(&temp.0).unwrap();
    let target = temp.0.join("合成目标");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("sentinel"), b"keep").unwrap();
    let id = Uuid::new_v4();
    let path = store.path().join(id.to_string());
    let junction = |link: &Path| {
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(&target)
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    junction(&path);
    assert!(VerifiedExport::open(&temp.0, id, fingerprint(b"abc"), || false).is_err());
    fs::remove_dir(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let file = path.join("export.jsonl");
    junction(&file);
    assert!(VerifiedExport::open(&temp.0, id, fingerprint(b"abc"), || false).is_err());
    fs::remove_dir(file).unwrap();
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"keep");
}
