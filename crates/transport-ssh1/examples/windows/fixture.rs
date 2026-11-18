use session_protocol::SensitiveBytes;
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
    process::{Child, Command},
    time::timeout,
};
use windows_sys::Win32::System::JobObjects::*;
use zeroize::Zeroizing;

const WSL: &[&str] = &["-d", "Ubuntu-24.04"];
const DEADLINE: Duration = Duration::from_secs(12);
const NO_WINDOW: u32 = 0x08000000;

fn ensure(condition: bool, stage: &'static str) -> io::Result<()> {
    condition
        .then_some(())
        .ok_or_else(|| io::Error::other(stage))
}

pub(crate) async fn bridge(listener: TcpListener, root: &str) -> io::Result<i32> {
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

pub(crate) fn password(source: &Path) -> io::Result<SensitiveBytes> {
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

pub(crate) fn job(child: &Child) -> io::Result<OwnedHandle> {
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
