//! The renderer never receives the bootstrap capability or a generic root RPC.
use serde::Serialize;
use session_core::{PROTOCOL_VERSION, pairing::SecretToken};
use session_protocol::{Hello, Reply, Request, Response, Sensitive, write_frame};
use session_service::client::Client;
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::Stdio,
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;
use windows_sys::Win32::System::JobObjects::*;

#[cfg(feature = "log-disk-full-fixture")]
static LOG_DISK_FULL_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[cfg(feature = "log-disk-full-fixture")]
pub(crate) fn configure_log_disk_full_fixture(root: &std::path::Path) -> io::Result<()> {
    LOG_DISK_FULL_ROOT
        .set(terminal_log::disk_full_fixture::validated_root(root)?)
        .map_err(|_| io::Error::other("disk-full test already configured"))
}

pub struct Service {
    instance: String,
    pub config_client: Option<Client>,
    child: Child,
    _job: OwnedHandle,
    client: Client,
    pub fixture: bool,
    service_id: Uuid,
    failed: bool,
    owned_pid: u32,
    directory: std::path::PathBuf,
    started_at_ms: u64,
    reader: crate::close_receipt::Collector,
    previous_close: crate::close_receipt::Previous,
    shutdown_once: bool,
    shutdown_ack: crate::close_receipt::Ack,
    shutdown_error: Option<crate::close_receipt::RequestError>,
    stop_outcome: Option<crate::close_receipt::StopOutcome>,
    stop_wait_error: Option<crate::close_receipt::WaitError>,
    kill_requested: bool,
    kill_request_ok: Option<bool>,
}

#[derive(Serialize)]
pub struct Status {
    pub(crate) service_id: Uuid,
    pid: u32,
    fixture: bool,
    exit_policy: &'static str,
    previous_close: crate::close_receipt::Previous,
}

impl Service {
    pub async fn start(fixture: bool, directory: std::path::PathBuf) -> io::Result<Self> {
        // An unnamed, non-inherited Job kills the child if the desktop crashes.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let instance = format!("desktop-{}", Uuid::new_v4().simple());
        let executable = std::env::current_exe()?.with_file_name("session-service.exe");
        #[cfg(all(test, feature = "close-receipt-fixture"))]
        let executable = {
            let _ = executable;
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../target/desktop-close-receipt-fixture/session-service.exe")
        };
        let mut command = Command::new(executable);
        command.args(["--instance", &instance]);
        if fixture {
            command.arg("--test-fixture");
        }
        #[cfg(feature = "serial-mcp-fixture")]
        if crate::serial_fixture::enabled(&directory) {
            command.arg("--serial-mcp-fixture");
        }
        #[cfg(feature = "close-receipt-fixture")]
        if let Some(mode) = crate::close_fixture::mode(&directory) {
            command.args(["--audit-diagnostic-fixture", mode]);
        }
        #[cfg(feature = "log-disk-full-fixture")]
        if let Some(root) = LOG_DISK_FULL_ROOT.get() {
            if fixture || directory.canonicalize()? != *root {
                return Err(io::Error::other("disk-full test owner mismatch"));
            }
            command.arg("--log-disk-full-fixture");
        }
        command.arg("--data-dir").arg(&directory);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()?;
        let owned_pid = child
            .id()
            .ok_or_else(|| io::Error::other("missing own PID"))?;
        let reader = crate::close_receipt::Collector::start(
            child
                .stderr
                .take()
                .ok_or_else(|| io::Error::other("missing private stderr"))?,
        );
        // Child cannot serve before receiving bootstrap. Assignment failure is fatal.
        if unsafe {
            AssignProcessToJobObject(
                job.as_raw_handle(),
                child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("child handle unavailable"))?,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let token = SecretToken::generate();
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing bootstrap channel"))?;
        timeout(
            Duration::from_secs(5),
            write_frame(
                &mut stdin,
                &Hello {
                    protocol_version: PROTOCOL_VERSION,
                    client_name: "desktop-bootstrap".into(),
                    token: Sensitive::new(token.expose().to_owned()),
                },
            ),
        )
        .await
        .map_err(|_| io::Error::other("bootstrap timeout"))??;
        drop(stdin);
        let (client, response) = Client::connect(
            &instance,
            token.expose(),
            child.id().ok_or_else(|| io::Error::other("child exited"))?,
        )
        .await?;
        let Response::Ok {
            reply: Reply::Welcome(welcome),
            ..
        } = response
        else {
            return Err(io::Error::other("invalid service welcome"));
        };
        let config_client = Client::connect(
            &instance,
            token.expose(),
            child.id().ok_or_else(|| io::Error::other("child exited"))?,
        )
        .await?
        .0;
        let started_at_ms = crate::close_receipt::clock();
        let previous_close =
            crate::close_receipt::load(directory.clone(), welcome.service_id, started_at_ms).await;
        Ok(Self {
            instance,
            config_client: Some(config_client),
            child,
            _job: job,
            client,
            fixture,
            service_id: welcome.service_id,
            failed: false,
            owned_pid,
            directory,
            started_at_ms,
            reader,
            previous_close,
            shutdown_once: false,
            shutdown_ack: crate::close_receipt::Ack::NotAttempted,
            shutdown_error: None,
            stop_outcome: None,
            stop_wait_error: None,
            kill_requested: false,
            kill_request_ok: None,
        })
    }

    pub async fn request(&mut self, request: Request) -> Result<Reply, String> {
        if self.failed
            || self
                .child
                .try_wait()
                .map_err(|_| "SERVICE_UNAVAILABLE")?
                .is_some()
        {
            self.failed = true;
            return Err("SERVICE_UNAVAILABLE".into());
        }
        match self.client.request(request).await {
            Ok(Response::Ok { reply, .. }) => Ok(reply),
            Ok(Response::Error { code, .. }) => Err(code.to_string()),
            Err(_) => {
                self.failed = true;
                Err("SERVICE_UNAVAILABLE".into())
            }
        }
    }
    pub fn endpoint(&self) -> Result<(String, u32, Uuid), String> {
        if self.failed {
            return Err("SERVICE_UNAVAILABLE".into());
        }
        Ok((
            self.instance.clone(),
            self.child.id().ok_or("SERVICE_UNAVAILABLE")?,
            self.service_id,
        ))
    }

    pub async fn status(&mut self) -> Result<Status, String> {
        self.request(Request::Ping {}).await?;
        Ok(Status {
            service_id: self.service_id,
            pid: self.child.id().ok_or("SERVICE_UNAVAILABLE")?,
            fixture: self.fixture,
            exit_policy: "stop_on_desktop_exit",
            previous_close: self.previous_close.clone(),
        })
    }

    pub async fn stop(&mut self) -> crate::close_receipt::StopOutcome {
        use crate::close_receipt::{Ack, Format, Receipt, RequestError, StopOutcome, WaitError};
        if let Some(outcome) = &self.stop_outcome {
            return outcome.clone();
        }
        if !self.shutdown_once {
            self.shutdown_once = true;
            if self.failed {
                self.shutdown_error = Some(RequestError::Unavailable);
            } else {
                // Persist intent in memory before await: cancellation never replays it.
                self.shutdown_ack = Ack::Unknown;
                self.shutdown_error = Some(RequestError::UnknownDelivery);
                match self.request(Request::Shutdown {}).await {
                    Ok(Reply::Ok) => {
                        self.shutdown_ack = Ack::Acknowledged;
                        self.shutdown_error = None;
                    }
                    Ok(_) => self.shutdown_error = Some(RequestError::InvalidReply),
                    Err(_) => self.shutdown_error = Some(RequestError::Unavailable),
                }
            }
        }
        let waited = timeout(Duration::from_secs(2), self.child.wait()).await;
        let exit = match waited {
            Ok(Ok(s)) => Some(s),
            other => {
                self.stop_wait_error.get_or_insert(if other.is_err() {
                    WaitError::Timeout
                } else {
                    WaitError::Io
                });
                if !self.kill_requested {
                    self.kill_requested = true;
                    self.kill_request_ok = Some(self.child.start_kill().is_ok());
                }
                timeout(Duration::from_secs(2), self.child.wait())
                    .await
                    .ok()
                    .and_then(|r| r.ok())
            }
        };
        let reader = self.reader.finish().await;
        let receipt = Receipt {
            version: 1,
            format: Format::V1,
            service_id: self.service_id,
            owned_pid: self.owned_pid,
            started_at_ms: self.started_at_ms,
            recorded_at_ms: crate::close_receipt::clock(),
            shutdown_attempted: self.shutdown_ack != Ack::NotAttempted,
            shutdown_ack: self.shutdown_ack,
            request_error: self.shutdown_error,
            exited: exit.is_some(),
            exit_code: exit.and_then(|s| s.code()),
            wait_error: self.stop_wait_error,
            kill_requested: self.kill_requested,
            kill_request_ok: self.kill_request_ok,
            reader,
        };
        self.stop_outcome = Some(StopOutcome {
            receipt: receipt.clone(),
            publication: crate::close_receipt::Publication::Unknown,
        });
        let publication =
            crate::close_receipt::publish(self.directory.clone(), receipt.clone()).await;
        let outcome = StopOutcome {
            receipt,
            publication,
        };
        self.stop_outcome = Some(outcome.clone());
        outcome
    }
}

#[cfg(all(test, feature = "close-receipt-fixture"))]
mod stop_tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_shutdown_wait_keeps_ack_and_never_replays_dispatch() {
        let root = std::env::temp_dir().join(format!(
            "shared-terminal-audit-diagnostic-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        crate::close_fixture::configure(&root, "inflight", true).unwrap();
        std::fs::write(root.join("audit-diagnostic-arm"), b"arm").unwrap();
        let mut service = Service::start(true, root.clone()).await.unwrap();
        for _ in 0..200 {
            if root.join("audit-diagnostic-entered").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(root.join("audit-diagnostic-entered").exists());
        assert!(
            timeout(Duration::from_millis(100), service.stop())
                .await
                .is_err()
        );
        assert!(service.shutdown_once);
        assert_eq!(
            service.shutdown_ack,
            crate::close_receipt::Ack::Acknowledged
        );
        assert!(root.join("audit-diagnostic-closing").exists());
        std::fs::write(root.join("audit-diagnostic-release"), b"release").unwrap();
        let first = service.stop().await;
        assert_eq!(first.receipt.exit_code, Some(0));
        assert!(!first.receipt.kill_requested);
        assert!(matches!(
            first.publication,
            crate::close_receipt::Publication::Published
        ));
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&service.stop().await).unwrap()
        );
        let mut received = 0;
        for entry in std::fs::read_dir(root.join("terminal-audit")).unwrap() {
            let file = entry.unwrap().path();
            if file.extension().is_some_and(|s| s == "jsonl") {
                for line in std::fs::read_to_string(file).unwrap().lines() {
                    let v: serde_json::Value = serde_json::from_str(line).unwrap();
                    let e = &v["payload"]["event"];
                    if e["attempt"]["request"]["area"] == "SESSION"
                        && e["attempt"]["request"]["verb"] == "MAINTAIN"
                        && e["phase"]["kind"] == "received"
                    {
                        received += 1;
                    }
                }
            }
        }
        assert_eq!(
            received, 1,
            "one real Shutdown dispatch despite cancellation"
        );
        drop(service);
        // Positive force-request evidence is separate from the normal/cancel case.
        for name in [
            "audit-diagnostic-entered",
            "audit-diagnostic-closing",
            "audit-diagnostic-release",
        ] {
            std::fs::remove_file(root.join(name)).unwrap();
        }
        let mut blocked = Service::start(true, root.clone()).await.unwrap();
        for _ in 0..200 {
            if root.join("audit-diagnostic-entered").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(root.join("audit-diagnostic-entered").exists());
        let forced = blocked.stop().await;
        assert!(forced.receipt.kill_requested);
        assert_eq!(forced.receipt.kill_request_ok, Some(true));
        assert!(forced.receipt.exited);
        assert!(forced.receipt.reader.diagnostic.is_none());
        assert!(forced.receipt.attention());
        assert_eq!(
            serde_json::to_vec(&forced).unwrap(),
            serde_json::to_vec(&blocked.stop().await).unwrap()
        );
        drop(blocked);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
