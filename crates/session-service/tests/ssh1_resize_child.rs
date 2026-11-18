//! Local process and dispatch prototype. No network transport.
#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
#[path = "ssh1_resize_child/challenges.rs"]
mod challenges;

#[cfg(windows)]
mod probe {
    use super::challenges;
    use serde::{Deserialize, Serialize};
    use session_core::session::{ConnectionId, ConnectionRef};
    use session_protocol::{read_frame, write_frame};
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::Stdio,
        time::Duration,
    };
    use tokio::{
        io::AsyncReadExt,
        process::{Child, Command},
        sync::{mpsc, oneshot},
        time::timeout,
    };
    use uuid::Uuid;
    use windows_sys::Win32::System::JobObjects::*;

    const LIMIT: Duration = Duration::from_secs(5);
    pub(super) const CONNECTION: ConnectionRef = ConnectionRef {
        connection_id: ConnectionId(Uuid::from_u128(1)),
        generation: 1,
    };

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Resize {
        connection: ConnectionRef,
        request_id: Uuid,
        cols: u16,
        rows: u16,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    enum Status {
        Applied,
        StaleConnection,
        InvalidSize,
        ConflictingRequest,
        Capacity,
    }

    #[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Ack {
        request_id: Uuid,
        status: Status,
        callbacks: u32,
        size: Option<(u16, u16)>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    pub(super) enum Request {
        Resize(Resize),
        Challenges,
        Answer(challenges::Answer),
        Application,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    pub(super) enum Reply {
        Resize(Ack),
        Challenges(challenges::Issued),
        Answer(challenges::Ack),
        Application(Vec<u8>),
    }

    fn backend(mut requests: mpsc::Receiver<(Request, oneshot::Sender<Reply>)>) {
        let mut first = None;
        let mut size = None;
        let mut callbacks = 0;
        let mut challenges = challenges::Backend::new();
        while let Some((request, reply)) = requests.blocking_recv() {
            let request = match request {
                Request::Resize(request) => request,
                Request::Challenges => {
                    let _ = reply.send(Reply::Challenges(challenges.issued()));
                    continue;
                }
                Request::Answer(answer) => {
                    let _ = reply.send(Reply::Answer(challenges.answer(answer)));
                    continue;
                }
                Request::Application => {
                    let _ = reply.send(Reply::Application(b"synthetic terminal output".to_vec()));
                    continue;
                }
            };
            let status = if request.connection != CONNECTION {
                Status::StaleConnection
            } else if !(2..=500).contains(&request.cols) || !(1..=200).contains(&request.rows) {
                Status::InvalidSize
            } else if let Some(prior) = first {
                if request == prior {
                    Status::Applied
                } else if request.request_id == prior.request_id {
                    Status::ConflictingRequest
                } else {
                    Status::Capacity
                }
            } else {
                // This callback and its state are owned by this thread alone.
                callbacks += 1;
                size = Some((request.cols, request.rows));
                first = Some(request);
                Status::Applied
            };
            let _ = reply.send(Reply::Resize(Ack {
                request_id: request.request_id,
                status,
                callbacks,
                size,
            }));
        }
    }

    async fn child() -> io::Result<()> {
        let (sender, receiver) = mpsc::channel(1);
        let owner = std::thread::Builder::new()
            .name("resize-test-backend".into())
            .spawn(move || backend(receiver))?;
        let result = timeout(LIMIT, async {
            let mut input = tokio::io::stdin();
            let mut output = tokio::io::stdout();
            while let Some(request) = read_frame(&mut input).await? {
                let (reply, ack) = oneshot::channel();
                sender
                    .send((request, reply))
                    .await
                    .map_err(io::Error::other)?;
                write_frame(&mut output, &ack.await.map_err(io::Error::other)?).await?;
            }
            Ok::<(), io::Error>(())
        })
        .await;
        drop(sender);
        owner
            .join()
            .map_err(|_| io::Error::other("backend owner panicked"))?;
        result?
    }

    fn managed(child: &Child) -> io::Result<OwnedHandle> {
        // Match the Desktop service ownership pattern before sending any work.
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
            || unsafe {
                AssignProcessToJobObject(
                    job.as_raw_handle(),
                    child
                        .raw_handle()
                        .ok_or_else(|| io::Error::other("missing child process handle"))?,
                )
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    async fn exercise(child: &mut Child) -> io::Result<()> {
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let valid = Resize {
            connection: CONNECTION,
            request_id: Uuid::new_v4(),
            cols: 137,
            rows: 41,
        };
        let stale = Resize {
            connection: ConnectionRef {
                generation: 2,
                ..CONNECTION
            },
            request_id: Uuid::new_v4(),
            ..valid
        };
        let invalid_cols = Resize {
            cols: 501,
            request_id: Uuid::new_v4(),
            ..valid
        };
        let invalid_rows = Resize {
            rows: 0,
            request_id: Uuid::new_v4(),
            ..valid
        };
        let conflict = Resize { rows: 42, ..valid };
        for (request, status, callbacks) in [
            (stale, Status::StaleConnection, 0),
            (invalid_cols, Status::InvalidSize, 0),
            (invalid_rows, Status::InvalidSize, 0),
            (valid, Status::Applied, 1),
            (valid, Status::Applied, 1),
            (conflict, Status::ConflictingRequest, 1),
        ] {
            write_frame(&mut input, &Request::Resize(request)).await?;
            let Some(Reply::Resize(ack)) = read_frame(&mut output).await? else {
                return Err(io::Error::other("expected resize reply"));
            };
            if ack
                != (Ack {
                    request_id: request.request_id,
                    status,
                    callbacks,
                    size: (callbacks != 0).then_some((137, 41)),
                })
            {
                return Err(io::Error::other(format!(
                    "unexpected reply for {status:?}: {ack:?}"
                )));
            }
        }
        challenges::exercise(&mut input, &mut output).await?;
        drop(input);
        if output.read(&mut [0]).await? != 0 || !child.wait().await?.success() {
            return Err(io::Error::other("child did not close cleanly"));
        }
        Ok(())
    }

    async fn parent() -> io::Result<()> {
        let mut child = Command::new(std::env::current_exe()?)
            .arg("--resize-test-child")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()?;
        let result = match managed(&child) {
            Ok(job) => {
                let result = timeout(LIMIT * 2, exercise(&mut child)).await;
                drop(job);
                result.map_err(io::Error::from).and_then(|result| result)
            }
            Err(error) => Err(error),
        };
        if result.is_err() && child.try_wait()?.is_none() {
            let _ = child.start_kill();
            timeout(LIMIT, child.wait()).await??;
        }
        result?;
        assert!(child.try_wait()?.is_some(), "child must be reaped");
        println!(
            "PASS P04 local resize and challenge dispatch: one resize callback, bound one-shot answers, isolated application data, child exit 0"
        );
        Ok(())
    }

    pub fn run() {
        let child_mode = std::env::args().nth(1).as_deref() == Some("--resize-test-child");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        if child_mode {
            // Tokio stdin uses a blocking read. Bound runtime teardown if a peer stalls.
            let result = runtime.block_on(child());
            runtime.shutdown_timeout(Duration::from_secs(1));
            result.unwrap();
        } else {
            runtime.block_on(parent()).unwrap();
        }
    }
}

#[cfg(windows)]
fn main() {
    probe::run();
}
