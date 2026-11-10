use super::*;
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const ROOT_ENV: &str = "SHARED_TERMINAL_P24_TEST_ROOT";
const CASE_ENV: &str = "SHARED_TERMINAL_P24_TEST_CASE";
const PREFIX: &str = "shared-terminal-selected-save-中文-";
const CONTENT: &[u8] = b"synthetic new export\r\n";
const ORIGINAL: &[u8] = b"original user file\r\n";
const FOREIGN: &[u8] = b"external replacement at original name\r\n";
const NEIGHBOR: &[u8] = b"unrelated neighbor\r\n";
const SOURCE: Uuid = Uuid::from_u128(1);

struct Fixture {
    root: PathBuf,
    id: Uuid,
}
impl Fixture {
    fn open(root: &Path) -> Self {
        let root = root.canonicalize().unwrap();
        assert_eq!(
            root.parent(),
            Some(fs::canonicalize(std::env::temp_dir()).unwrap().as_path())
        );
        let id = root
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix(PREFIX)
            .unwrap();
        let id = Uuid::parse_str(id).unwrap();
        Self { root, id }
    }
    fn data(&self) -> PathBuf {
        self.root.join("应用数据")
    }
    fn target(&self) -> PathBuf {
        self.root.join("手动另存.txt")
    }
    fn source(&self) -> PathBuf {
        self.data()
            .join("terminal-log-exports")
            .join(SOURCE.to_string())
            .join("export.jsonl")
    }
    fn sidecar(&self, suffix: &str) -> PathBuf {
        self.root
            .join(format!(".terminal-export-{}.{suffix}", self.id))
    }
    fn ready(&self) -> PathBuf {
        self.root.join("test-phase-reached")
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            target: observe(&self.target()),
            staging: observe(&self.sidecar("partial")),
            backup: observe(&self.sidecar("backup")),
            source: observe(&self.source()).unwrap(),
            neighbor: observe(&self.root.join("邻居.txt")).unwrap(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Observation {
    id: (u32, u32, u32),
    bytes: Vec<u8>,
}
fn observe(path: &Path) -> Option<Observation> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => panic!("file observation failed: {error}"),
    };
    let id = identity(&file).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    Some(Observation { id, bytes })
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Snapshot {
    target: Option<Observation>,
    staging: Option<Observation>,
    backup: Option<Observation>,
    source: Observation,
    neighbor: Observation,
}

// The Rust test binary is also the disposable save/restart process. Without
// explicit fixture parameters this helper is a no-op in ordinary test runs.
#[test]
fn crash_child() {
    let Some(root) = std::env::var_os(ROOT_ENV) else {
        return;
    };
    let f = Fixture::open(Path::new(&root));
    let mode = std::env::var(CASE_ENV).unwrap();
    if mode == "observe-restart" {
        let before = f.snapshot();
        let error = SaveTarget::prepare(&f.target(), &f.data(), f.id)
            .err()
            .expect("old attempt name must remain occupied");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(before, f.snapshot());
        println!("P24_SNAPSHOT {}", serde_json::to_string(&before).unwrap());
        return;
    }
    assert!(matches!(
        mode.as_str(),
        "staged" | "backed-up" | "published"
    ));
    let mut source = VerifiedExport::open(
        &f.data(),
        SOURCE,
        ExportFingerprint::for_bytes(CONTENT),
        || false,
    )
    .unwrap();
    let save = SaveTarget::prepare(&f.target(), &f.data(), f.id).unwrap();
    assert_eq!(save.existing_bytes().unwrap(), Some(ORIGINAL.len() as u64));
    let park = || {
        File::create_new(f.ready()).unwrap();
        thread::park_timeout(Duration::from_secs(20));
        panic!("parent did not terminate the isolated child");
    };
    let report = save.run(&mut source, &mut || false, |after_backup, _| {
        if (!after_backup && mode == "staged") || (after_backup && mode == "backed-up") {
            park();
        }
    });
    assert_eq!(mode, "published");
    assert_eq!(report.phase, "COMPLETED");
    // The library has published, but this process has not sent a save reply.
    park();
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn spawn_child(f: &Fixture, mode: &str) -> OwnedChild {
    let test = module_path!().split_once("::").unwrap().1;
    OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("{test}::crash_child"), "--nocapture"])
            .env(ROOT_ENV, &f.root)
            .env(CASE_ENV, mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}
fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !ready() {
        assert!(Instant::now() < deadline, "isolated child deadline");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn hard_exit_preserves_exact_objects_before_and_after_publication() {
    for mode in ["staged", "backed-up", "published"] {
        let root = Temp::new();
        let f = Fixture::open(&root.0);
        fs::create_dir(f.data()).unwrap();
        let exports = ExportStore::open(&f.data()).unwrap();
        fs::create_dir(f.source().parent().unwrap()).unwrap();
        fs::write(f.source(), CONTENT).unwrap();
        drop(exports);
        fs::write(f.target(), ORIGINAL).unwrap();
        fs::write(f.root.join("邻居.txt"), NEIGHBOR).unwrap();
        let initial = f.snapshot();
        let mut crashed = spawn_child(&f, mode);
        wait_until(|| {
            assert!(
                crashed.0.try_wait().unwrap().is_none(),
                "save child exited before injected termination"
            );
            f.ready().is_file()
        });
        crashed.0.kill().unwrap();
        assert!(!crashed.0.wait().unwrap().success());
        let after = f.snapshot();
        assert_eq!(after.source, initial.source);
        assert_eq!(after.neighbor, initial.neighbor);
        match mode {
            "staged" => {
                assert_eq!(after.target, initial.target);
                assert!(after.backup.is_none());
                assert_eq!(after.staging.as_ref().unwrap().bytes, CONTENT);
            }
            "backed-up" => {
                assert!(after.target.is_none());
                assert_eq!(after.backup, initial.target);
                assert_eq!(after.staging.as_ref().unwrap().bytes, CONTENT);
                // Simulate another actor using the vacant original name before restart.
                use std::io::Write;
                File::create_new(f.target())
                    .unwrap()
                    .write_all(FOREIGN)
                    .unwrap();
            }
            "published" => {
                let target = after.target.as_ref().unwrap();
                assert_eq!(target.bytes, CONTENT);
                assert_ne!(target.id, initial.target.as_ref().unwrap().id);
                assert_ne!(target.id, initial.source.id);
                assert_eq!(after.backup, initial.target);
                assert!(after.staging.is_none());
            }
            _ => unreachable!(),
        }
        let expected = f.snapshot();
        if mode == "backed-up" {
            assert_eq!(expected.target.as_ref().unwrap().bytes, FOREIGN);
            assert_eq!(expected.backup, after.backup);
            assert_eq!(expected.staging, after.staging);
        } else {
            assert_eq!(expected, after);
        }
        let mut restarted = spawn_child(&f, "observe-restart");
        wait_until(|| restarted.0.try_wait().unwrap().is_some());
        assert!(restarted.0.wait().unwrap().success());
        let mut output = String::new();
        restarted
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        let snapshot = output
            .lines()
            .find_map(|line| line.strip_prefix("P24_SNAPSHOT "))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Snapshot>(snapshot).unwrap(),
            expected
        );
        assert_eq!(f.snapshot(), expected);
        println!(
            "P24 {mode}: save_pid={} restart_pid={} initial={} crash={} restart={}",
            crashed.0.id(),
            restarted.0.id(),
            serde_json::to_string(&initial).unwrap(),
            serde_json::to_string(&after).unwrap(),
            snapshot
        );
    }
}
