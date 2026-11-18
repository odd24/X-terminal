use session_core::session::{ConnectionId, ConnectionRef};
use session_protocol::{SensitiveBytes, read_frame, write_frame};
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    process::Stdio,
    ptr,
    time::Duration,
};
use tokio::{
    io::{self as aio, AsyncWriteExt},
    net::TcpListener,
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};
use transport_ssh1::{
    ChallengeKind, EndReason, Endpoint, Event, Protocol, Request, Session, VERSION,
};
use uuid::Uuid;
use windows_sys::Win32::System::JobObjects::*;
use zeroize::Zeroizing;

const DEADLINE: Duration = Duration::from_secs(12);
const NO_WINDOW: u32 = 0x08000000;
const START_COMMAND: &[u8] = b"test -t 0 && test -t 1 && printf '\\nP13_DATA_OK\\n'; exit\n";
const OUTPUT_MARKER: &[u8] = b"\r\nP13_DATA_OK\r\n";
const WSL: &[&str] = &["-d", "Ubuntu-24.04"];

#[derive(Clone, Copy, Debug)]
enum Case {
    Login,
    RejectHost,
    WrongKind,
    Close,
}

fn ensure(condition: bool, stage: &'static str) -> io::Result<()> {
    condition
        .then_some(())
        .ok_or_else(|| io::Error::other(stage))
}

fn job(child: &Child) -> io::Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let process = child
        .raw_handle()
        .ok_or_else(|| io::Error::other("missing helper handle"))?;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job.as_raw_handle(), process) == 0
    } {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

async fn bridge(listener: TcpListener, root: &str) -> io::Result<i32> {
    let (socket, remote) = timeout(DEADLINE, listener.accept()).await??;
    ensure(
        remote.ip().is_loopback() && socket.local_addr()?.ip().is_loopback(),
        "non-loopback fixture endpoint",
    )?;
    drop(listener);
    let mut server = Command::new("wsl.exe")
        .args(WSL)
        .args([
            "--cd",
            root,
            "--exec",
            "/usr/bin/timeout",
            "--kill-after=1s",
            "8s",
            "/usr/bin/unshare",
            "--user",
            "--map-current-user",
            "--net",
            "/usr/bin/env",
            "-i",
        ])
        .arg(format!("HOME={root}/home"))
        .arg(format!("XDG_CONFIG_HOME={root}/home"))
        .args([
            "PATH=/usr/bin:/bin",
            "SHELL=/bin/sh",
            "./out/uppity",
            "--hostkey",
            "fixture.rsa1",
            "--sessiondir",
            root,
            "--allow-auth",
            "password",
        ])
        .args(
            ["none", "publickey", "kbdint", "tis", "cryptocard"]
                .into_iter()
                .flat_map(|method| ["--deny-auth", method]),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(NO_WINDOW)
        .kill_on_drop(true)
        .spawn()?;
    let mut server_input = server.stdin.take().unwrap();
    let mut server_output = server.stdout.take().unwrap();
    let (mut receive, mut send) = socket.into_split();
    let relay_input = async {
        let _ = aio::copy(&mut receive, &mut server_input).await;
        let _ = server_input.shutdown().await;
    };
    let relay_output = async {
        let _ = aio::copy(&mut server_output, &mut send).await;
        let _ = send.shutdown().await;
    };
    let (status, (), ()) = timeout(DEADLINE, async {
        tokio::join!(server.wait(), relay_input, relay_output)
    })
    .await?;
    let status = status?
        .code()
        .ok_or_else(|| io::Error::other("fixture exit unavailable"))?;
    ensure(matches!(status, 0 | 124), "fixture process exit")?;
    Ok(status)
}

fn password(source: &Path) -> io::Result<SensitiveBytes> {
    let bytes = Zeroizing::new(std::fs::read(source)?);
    let declaration = b"const char *PHONY_GOOD_PASSWORD = \"";
    let mut occurrences = bytes
        .windows(declaration.len())
        .enumerate()
        .filter(|(_, entry)| *entry == declaration);
    let (start, _) = occurrences
        .next()
        .ok_or_else(|| io::Error::other("missing fixture declaration"))?;
    ensure(
        occurrences.next().is_none(),
        "ambiguous fixture declaration",
    )?;
    let suffix = &bytes[start + declaration.len()..];
    let end = suffix
        .iter()
        .position(|&byte| byte == b'"')
        .ok_or_else(|| io::Error::other("invalid fixture declaration"))?;
    let value = &suffix[..end];
    ensure(
        (1..=63).contains(&value.len()) && value.iter().all(u8::is_ascii_lowercase),
        "invalid fixture value",
    )?;
    Ok(SensitiveBytes::new(value.to_vec()))
}

async fn next(output: &mut ChildStdout) -> io::Result<Event> {
    read_frame(output)
        .await?
        .ok_or_else(|| io::Error::other("helper protocol EOF"))
}

async fn expect_end(
    output: &mut ChildStdout,
    expected: Session,
    wanted: EndReason,
) -> io::Result<()> {
    let Event::Ended {
        session,
        reason,
        backend_status,
    } = next(output).await?
    else {
        return Err(io::Error::other("unexpected frame before helper end"));
    };
    ensure(
        session == expected && reason == wanted && backend_status.is_none(),
        "unexpected control termination",
    )
}

async fn exercise(
    input: &mut ChildStdin,
    output: &mut ChildStdout,
    case: Case,
    endpoint: Endpoint,
    fingerprint: &str,
    source: &Path,
) -> io::Result<()> {
    let session = Session {
        connection: ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 3,
        },
        start_id: Uuid::new_v4(),
    };
    write_frame(
        input,
        &Request::Start {
            version: VERSION,
            protocol: Protocol::Ssh1,
            session,
            endpoint: endpoint.clone(),
            username: "p13-fixture".into(),
            cols: 80,
            rows: 24,
        },
    )
    .await?;
    let Event::HostChallenge {
        challenge: host,
        endpoint: returned_endpoint,
        algorithm,
        fingerprint: returned,
    } = next(output).await?
    else {
        return Err(io::Error::other("missing real SSH1 host challenge"));
    };
    ensure(
        host.session == session
            && host.kind == ChallengeKind::HostTrust
            && host.id.get_version_num() == 4
            && returned_endpoint == endpoint
            && algorithm == "rsa1"
            && returned == fingerprint,
        "host challenge binding",
    )?;
    if matches!(case, Case::Close) {
        write_frame(input, &Request::Close { session }).await?;
        return expect_end(output, session, EndReason::Closed).await;
    }
    write_frame(
        input,
        &Request::HostAnswer {
            challenge: host,
            fingerprint: returned,
            approve: !matches!(case, Case::RejectHost),
        },
    )
    .await?;
    if matches!(case, Case::RejectHost) {
        return expect_end(output, session, EndReason::HostDeclined).await;
    }
    let Event::PasswordChallenge { mut challenge } = next(output).await? else {
        return Err(io::Error::other("missing real SSH1 password challenge"));
    };
    ensure(
        challenge.session == session
            && challenge.kind == ChallengeKind::Password
            && challenge.id.get_version_num() == 4
            && challenge.id != host.id,
        "password challenge binding",
    )?;
    if matches!(case, Case::WrongKind) {
        challenge.kind = ChallengeKind::HostTrust;
        write_frame(
            input,
            &Request::PasswordAnswer {
                challenge,
                value: SensitiveBytes::new(b"fixture-decoy".to_vec()),
            },
        )
        .await?;
        return expect_end(output, session, EndReason::InvalidControl).await;
    }
    write_frame(
        input,
        &Request::PasswordAnswer {
            challenge,
            value: password(source)?,
        },
    )
    .await?;
    ensure(
        matches!(next(output).await?, Event::Ready { session: actual } if actual == session),
        "SSH1 input readiness",
    )?;
    write_frame(
        input,
        &Request::Resize {
            session,
            cols: 137,
            rows: 41,
        },
    )
    .await?;
    write_frame(
        input,
        &Request::Input {
            session,
            bytes: SensitiveBytes::new(START_COMMAND.to_vec()),
        },
    )
    .await?;
    let mut printed = Vec::new();
    loop {
        match next(output).await? {
            Event::Output {
                session: actual,
                stderr,
                bytes,
            } => {
                ensure(
                    actual == session && printed.len() + bytes.expose().len() <= 8192,
                    "invalid helper application frame",
                )?;
                if !stderr {
                    printed.extend_from_slice(bytes.expose());
                }
            }
            Event::Ended {
                session: actual,
                reason,
                backend_status,
            } => {
                ensure(
                    actual == session
                        && reason == EndReason::BackendExit
                        && backend_status == Some(0),
                    "SSH1 remote exit status",
                )?;
                break;
            }
            _ => return Err(io::Error::other("unexpected frame after SSH1 input")),
        }
    }
    ensure(
        printed
            .windows(OUTPUT_MARKER.len())
            .any(|bytes| bytes == OUTPUT_MARKER),
        "fixed PTY output missing",
    )
}

async fn trial(
    helper: &Path,
    root: &str,
    fingerprint: &str,
    source: &Path,
    case: Case,
) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let endpoint = Endpoint {
        host: "127.0.0.1".into(),
        port: listener.local_addr()?.port(),
    };
    let mut child = Command::new(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(NO_WINDOW)
        .kill_on_drop(true)
        .spawn()?;
    let job = job(&child)?;
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut diagnostic = child.stderr.take().unwrap();
    let bridge = bridge(listener, root);
    let session = async {
        exercise(&mut input, &mut output, case, endpoint, fingerprint, source).await?;
        drop(input);
        ensure(
            read_frame::<_, Event>(&mut output).await?.is_none(),
            "extra helper frame",
        )?;
        ensure(
            aio::copy(&mut diagnostic, &mut aio::sink()).await? == 0,
            "unexpected stderr",
        )?;
        ensure(child.wait().await?.success(), "invalid helper process exit")
    };
    let (session, fixture) = tokio::join!(timeout(DEADLINE, session), bridge);
    drop(job);
    session??;
    println!("{case:?}: helper exit 0; fixture exit {}", fixture?);
    Ok(())
}

pub async fn run() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure(
        args.len() == 3,
        "expected helper executable, private WSL root, locked uppity.c",
    )?;
    let helper = Path::new(&args[0]);
    let root = args[1]
        .to_str()
        .and_then(|value| {
            value
                .strip_prefix("/tmp/P04-ssh1.")
                .map(|suffix| (value, suffix))
        })
        .filter(|(_, suffix)| {
            suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .map(|(value, _)| value)
        .ok_or_else(|| io::Error::other("not an owned P04 fixture root"))?;
    let source = Path::new(&args[2]);
    let public_key = timeout(
        DEADLINE,
        Command::new("wsl.exe")
            .args(WSL)
            .args(["--cd", root, "--exec", "/bin/cat", "fingerprint.txt"])
            .stderr(Stdio::null())
            .creation_flags(NO_WINDOW)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure(
        public_key.status.success() && public_key.stdout.len() <= 65,
        "missing public fixture fingerprint",
    )?;
    let fingerprint = std::str::from_utf8(&public_key.stdout)
        .map_err(io::Error::other)?
        .trim();
    for case in [Case::Login, Case::RejectHost, Case::WrongKind, Case::Close] {
        trial(helper, root, fingerprint, source, case).await?;
    }
    Ok(())
}
