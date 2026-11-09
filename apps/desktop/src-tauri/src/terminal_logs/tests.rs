use super::*;
use session_core::session::ConnectionId;
use std::time::{Duration, Instant};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "shared-terminal-menu-native-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
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
                .starts_with("shared-terminal-menu-native-中文-")
        );
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::remove_dir_all(&self.0) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => {
                    assert!(Instant::now() < until);
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}
fn target() -> Target {
    Target {
        service_id: Uuid::new_v4(),
        protocol: Protocol::Serial,
        connection: ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        },
    }
}
fn request(target: &Target, id: Uuid, text: &str) -> Request {
    Request::Prepare {
        target: target.clone(),
        request_id: id,
        source: Source::Viewport {
            text: text.into(),
            top: 17,
            rows: 2,
            cols: 20,
        },
    }
}
fn complete(manager: &Manager, target: &Target, id: Uuid) -> Info {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let info = manager.status(target, id, false).unwrap();
        if !matches!(info.phase.as_str(), "QUEUED" | "RUNNING" | "RELEASING") {
            return info;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn requests_are_closed_scoped_bounded_and_cannot_carry_paths_or_roles() {
    let t = target();
    let value = serde_json::to_value(request(&t, Uuid::new_v4(), "中  \r\n    \r\n")).unwrap();
    assert!(
        serde_json::from_value::<Request>(value.clone())
            .unwrap()
            .valid()
    );
    for key in ["path", "uri", "command", "role", "filename", "sha256"] {
        let mut v = value.clone();
        v[key] = serde_json::json!("untrusted");
        assert!(serde_json::from_value::<Request>(v).is_err());
    }
    assert!(!request(&t, Uuid::new_v4(), "\x1b[31m").valid());
    assert!(!request(&t, Uuid::nil(), "ok").valid());
    assert!(
        !Source::Recorded {
            log_ids: vec![Uuid::nil()]
        }
        .valid()
    );
    let id = Uuid::new_v4();
    assert!(
        !Source::Recorded {
            log_ids: vec![id, id]
        }
        .valid()
    );
}
#[test]
fn native_snapshot_deduplicates_parameters_and_owner_and_cleans_only_verified_staging() {
    let temp = Temp::new();
    let manager = Manager::new(temp.0.clone()).unwrap();
    let t = target();
    let id = Uuid::new_v4();
    let text = "中  \r\n    \r\n";
    let first = manager.submit(request(&t, id, text), None, vec![]).unwrap();
    assert_eq!(first.request_id, id);
    assert_eq!(
        manager
            .submit(request(&t, id, text), None, vec![])
            .unwrap()
            .request_id,
        id
    );
    assert!(
        manager
            .submit(request(&t, id, "changed"), None, vec![])
            .is_err()
    );
    let done = complete(&manager, &t, id);
    assert_eq!(done.phase, "COMPLETED");
    assert_eq!(done.bytes, Some(text.len() as u64));
    assert_eq!(done.kind, "VIEWPORT");
    assert!(!serde_json::to_string(&done).unwrap().contains(text));
    let path = temp
        .0
        .join("terminal-menu/terminal-log-exports")
        .join(id.to_string())
        .join("export.jsonl");
    assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
    let scope = crate::export_save::Scope {
        mode: crate::export_save::SourceMode::Menu,
        connection: t.connection,
        log_id: id,
        request_id: id,
    };
    assert_eq!(
        manager.fingerprint(&scope).unwrap(),
        ExportFingerprint::for_bytes(text.as_bytes())
    );
    let mut wrong = t.clone();
    wrong.connection.generation += 1;
    assert!(manager.status(&wrong, id, false).is_err());
    wrong = t.clone();
    wrong.service_id = Uuid::new_v4();
    assert!(manager.status(&wrong, id, false).is_err());
    let scope_wrong = crate::export_save::Scope {
        connection: wrong.connection,
        request_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(manager.fingerprint(&scope_wrong).is_err());
    manager.release(&t, id).unwrap();
    manager.release(&t, id).unwrap();
    assert_eq!(complete(&manager, &t, id).phase, "REMOVED");
    assert!(!path.exists());
    assert!(manager.fingerprint(&scope).is_err());
    assert_eq!(
        manager
            .submit(request(&t, id, text), None, vec![])
            .unwrap()
            .phase,
        "REMOVED"
    );
    assert!(!path.exists());
    drop(manager);
}
