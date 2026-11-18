use session_protocol::{read_frame, write_frame};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::{self, Read},
    os::windows::{
        ffi::OsStringExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    process::{ExitStatus, Stdio},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{
    process::{Child, ChildStdin, Command},
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};
use transport_ssh1::{Event, Request};
use windows_sys::Win32::{
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    },
    System::{JobObjects::*, SystemInformation::GetSystemWindowsDirectoryW},
};

const FRAME_WRITE: Duration = Duration::from_secs(2);
const EXIT_WAIT: Duration = Duration::from_millis(600);
const MAX_IMAGE: u64 = 16 * 1024 * 1024;

fn system_root() -> io::Result<OsString> {
    let mut path = [0u16; 260];
    let length =
        unsafe { GetSystemWindowsDirectoryW(path.as_mut_ptr(), path.len() as u32) } as usize;
    if length == 0 || length >= path.len() {
        return Err(io::Error::other("Windows root unavailable"));
    }
    Ok(OsString::from_wide(&path[..length]))
}

pub(super) fn image_pin() -> Option<&'static str> {
    if !cfg!(feature = "ssh1-with-helper") {
        return None;
    }
    option_env!("P13_SSH1_HELPER_SHA256")
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub(super) struct Managed {
    job: Option<OwnedHandle>,
    process: Child,
    reader: JoinHandle<()>,
    input: Option<ChildStdin>,
    pub(super) events: mpsc::Receiver<Event>,
}

fn job() -> io::Result<OwnedHandle> {
    let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
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
    Ok(job)
}

impl Managed {
    pub(super) async fn spawn(pin: &str, released: &AtomicBool) -> io::Result<Self> {
        let current = std::env::current_exe()?;
        let directory = current
            .parent()
            .ok_or_else(|| io::Error::other("service location"))?;
        let path = directory.join("ssh1-helper.exe");
        // Deny writes and replacement between hashing the executable and CreateProcess.
        let mut image = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)?;
        let meta = image.metadata()?;
        if !meta.is_file()
            || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || meta.len() == 0
            || meta.len() > MAX_IMAGE
        {
            return Err(io::Error::other("invalid SSH1 image"));
        }
        let mut digest = Sha256::new();
        let mut buffer = [0; 16 * 1024];
        loop {
            let count = image.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let hash = digest.finalize();
        let hex = b"0123456789abcdef";
        let matches_pin = hash
            .iter()
            .zip(pin.as_bytes().chunks_exact(2))
            .all(|(&byte, pair)| {
                hex[usize::from(byte >> 4)] == pair[0].to_ascii_lowercase()
                    && hex[usize::from(byte & 0x0f)] == pair[1].to_ascii_lowercase()
            });
        if !matches_pin {
            return Err(io::Error::other("SSH1 image mismatch"));
        }
        let job = job()?;
        let mut process = Command::new(path)
            .env_clear()
            // Windows networking uses this system value even with no proxy or profile.
            .env("SystemRoot", system_root()?)
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()?;
        released.store(false, Ordering::Release);
        drop(image);
        let assigned = process.raw_handle().is_some_and(|handle| unsafe {
            AssignProcessToJobObject(job.as_raw_handle(), handle) != 0
        });
        if !assigned {
            let error = io::Error::last_os_error();
            let _ = process.start_kill();
            if matches!(timeout(EXIT_WAIT, process.wait()).await, Ok(Ok(_))) {
                released.store(true, Ordering::Release);
            }
            return Err(error);
        }
        let input = process
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing helper input"))?;
        let mut output = process
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing helper output"))?;
        let (send, events) = mpsc::channel(16);
        let reader = tokio::spawn(async move {
            while let Ok(Some(event)) = read_frame(&mut output).await {
                if send.send(event).await.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            job: Some(job),
            process,
            reader,
            input: Some(input),
            events,
        })
    }

    pub(super) async fn send(&mut self, request: &Request) -> io::Result<()> {
        let pipe = self
            .input
            .as_mut()
            .ok_or_else(|| io::Error::other("closed helper input"))?;
        timeout(FRAME_WRITE, write_frame(pipe, request)).await?
    }

    pub(super) async fn reap(&mut self) -> io::Result<ExitStatus> {
        self.input.take();
        let exited = timeout(EXIT_WAIT, async {
            loop {
                tokio::select! {
                    result=self.process.wait()=>return result,
                    event=self.events.recv()=>{
                        if event.is_none() { return self.process.wait().await }
                    }
                }
            }
        })
        .await;
        if let Ok(result) = exited {
            return result;
        }
        self.job.take();
        let _ = self.process.start_kill();
        timeout(EXIT_WAIT, self.process.wait()).await?
    }
}

impl Drop for Managed {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
