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

pub struct Service {
    instance: String,
    pub config_client: Option<Client>,
    child: Child,
    _job: OwnedHandle,
    client: Client,
    pub fixture: bool,
    service_id: Uuid,
    failed: bool,
}

#[derive(Serialize)]
pub struct Status {
    pub(crate) service_id: Uuid,
    pid: u32,
    fixture: bool,
    exit_policy: &'static str,
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
        let mut command = Command::new(executable);
        command.args(["--instance", &instance]);
        if fixture {
            command.arg("--test-fixture");
        }
        command.arg("--data-dir").arg(directory);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()?;
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
        Ok(Self {
            instance,
            config_client: Some(config_client),
            child,
            _job: job,
            client,
            fixture,
            service_id: welcome.service_id,
            failed: false,
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
        })
    }

    pub async fn stop(&mut self) {
        let _ = self.request(Request::Shutdown {}).await;
        if timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}
