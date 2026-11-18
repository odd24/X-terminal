use session_protocol::{SensitiveBytes, read_frame, write_frame};
use std::{
    cell::RefCell,
    ffi::{CString, c_char, c_void},
    io,
    net::IpAddr,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    pin::Pin,
    process::ExitCode,
    ptr, slice, str,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
    task::{Context, Poll},
    thread,
    time::Duration,
};
use tokio::io::{AsyncRead, ReadBuf};
use transport_ssh1::{
    Challenge, ChallengeKind, EndReason, Endpoint, Event, MAX_DATA, MAX_PASSWORD, Protocol,
    Request, Session, VERSION,
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{ERROR_BROKEN_PIPE, HANDLE},
    Storage::FileSystem::ReadFile,
    System::{
        Console::{GetStdHandle, STD_INPUT_HANDLE},
        Threading::{CreateEventW, SetEvent},
    },
};

unsafe extern "C" {
    fn p13_pipes() -> bool;
    fn p13_managed() -> bool;
    fn p13_owner(
        context: *const c_void,
        wake: *mut c_void,
        host: *const c_char,
        port: u16,
        username: *const c_char,
        cols: u16,
        rows: u16,
        status: *mut i32,
    ) -> i32;
    fn p13_host(native: *mut c_void, approve: bool) -> bool;
    fn p13_password(native: *mut c_void, data: *const u8, len: usize) -> bool;
    fn p13_input(native: *mut c_void, data: *const u8, len: usize) -> bool;
    fn p13_resize(native: *mut c_void, cols: u16, rows: u16) -> bool;
}

type Control = io::Result<Option<Request>>;

struct Pending {
    target: Challenge,
    fingerprint: Option<String>,
}

struct Owner {
    session: Session,
    endpoint: Endpoint,
    pending: RefCell<Option<Pending>>,
    incoming: Receiver<Control>,
    outgoing: SyncSender<Event>,
    writer_failed: Arc<AtomicBool>,
}

fn valid_host(host: &str) -> bool {
    if host.len() > 253 {
        return false;
    }
    host.parse::<IpAddr>().is_ok()
        || host.trim_end_matches('.').split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

fn valid_size(cols: u16, rows: u16) -> bool {
    (2..=500).contains(&cols) && (1..=200).contains(&rows)
}

fn valid_fingerprint(fingerprint: &str) -> bool {
    let Some((bits, hex)) = fingerprint.split_once(' ') else {
        return false;
    };
    (1..=5).contains(&bits.len())
        && bits.bytes().all(|byte| byte.is_ascii_digit())
        && hex.len() == 47
        && hex.bytes().enumerate().all(|(index, byte)| {
            if index % 3 == 2 {
                byte == b':'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

impl Owner {
    fn challenge(&self, kind: ChallengeKind, host: Option<(String, String)>) -> bool {
        if self.pending.borrow().is_some() {
            return false;
        }
        let target = Challenge {
            session: self.session,
            id: Uuid::new_v4(),
            kind,
        };
        let fingerprint = host.as_ref().map(|(value, _)| value.clone());
        let event = match host {
            Some((fingerprint, key)) => Event::HostChallenge {
                challenge: target,
                endpoint: self.endpoint.clone(),
                algorithm: "rsa1".into(),
                fingerprint,
                key,
            },
            None => Event::PasswordChallenge { challenge: target },
        };
        if self.outgoing.try_send(event).is_err() {
            return false;
        }
        self.pending.replace(Some(Pending {
            target,
            fingerprint,
        }));
        true
    }

    fn matches(&self, target: Challenge, fingerprint: Option<&str>) -> bool {
        self.pending.borrow().as_ref().is_some_and(|pending| {
            pending.target == target && pending.fingerprint.as_deref() == fingerprint
        })
    }
}

// PuTTY only calls these entry points on its owner thread and never retains data pointers.
#[unsafe(no_mangle)]
unsafe extern "C" fn p13_emit_host(
    context: *const c_void,
    fingerprint: *const u8,
    fingerprint_len: usize,
    key: *const u8,
    key_len: usize,
) -> bool {
    if fingerprint.is_null() || key.is_null() || fingerprint_len > 64 || key_len > MAX_DATA {
        return false;
    }
    let fingerprint =
        str::from_utf8(unsafe { slice::from_raw_parts(fingerprint, fingerprint_len) });
    let key = str::from_utf8(unsafe { slice::from_raw_parts(key, key_len) });
    let (Ok(fingerprint), Ok(key)) = (fingerprint, key) else {
        return false;
    };
    let owner = unsafe { &*context.cast::<Owner>() };
    valid_fingerprint(fingerprint)
        && transport_ssh1::valid_rsa1_key(key)
        && owner.challenge(
            ChallengeKind::HostTrust,
            Some((fingerprint.into(), key.into())),
        )
}

#[unsafe(no_mangle)]
unsafe extern "C" fn p13_emit(
    context: *const c_void,
    event: i32,
    data: *const u8,
    len: usize,
    stderr: bool,
) -> bool {
    let owner = unsafe { &*context.cast::<Owner>() };
    match event {
        2 => owner.challenge(ChallengeKind::Password, None),
        3 => owner
            .outgoing
            .try_send(Event::Ready {
                session: owner.session,
            })
            .is_ok(),
        4 if !data.is_null() => {
            let bytes = unsafe { slice::from_raw_parts(data, len) };
            bytes.chunks(MAX_DATA).all(|part| {
                owner
                    .outgoing
                    .try_send(Event::Output {
                        session: owner.session,
                        stderr,
                        bytes: SensitiveBytes::new(part.to_vec()),
                    })
                    .is_ok()
            })
        }
        _ => false,
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn p13_dispatch(context: *const c_void, native: *mut c_void) -> i32 {
    let owner = unsafe { &*context.cast::<Owner>() };
    if owner.writer_failed.load(Ordering::Acquire) {
        return 2;
    }
    let request = match owner.incoming.try_recv() {
        Ok(Ok(Some(request))) => request,
        Err(TryRecvError::Empty) => return 0,
        Ok(Err(_)) => return 3,
        Ok(Ok(None)) | Err(TryRecvError::Disconnected) => return 2,
    };
    let accepted = match request {
        Request::HostAnswer {
            challenge,
            fingerprint,
            approve,
        } if owner.matches(challenge, Some(&fingerprint)) => {
            owner.pending.take();
            unsafe { p13_host(native, approve) }
        }
        Request::PasswordAnswer { challenge, value } if owner.matches(challenge, None) => {
            let bytes = value.expose();
            if bytes.len() > MAX_PASSWORD || bytes.contains(&0) {
                return 3;
            }
            owner.pending.take();
            unsafe { p13_password(native, bytes.as_ptr(), bytes.len()) }
        }
        Request::Input {
            session,
            request_id,
            bytes,
        } if session == owner.session => {
            let bytes = bytes.expose();
            if request_id.is_nil()
                || bytes.is_empty()
                || bytes.len() > MAX_DATA
                || !unsafe { p13_input(native, bytes.as_ptr(), bytes.len()) }
            {
                return 3;
            }
            return if owner
                .outgoing
                .try_send(Event::InputAccepted {
                    session,
                    request_id,
                    bytes: bytes.len(),
                })
                .is_ok()
            {
                0
            } else {
                2
            };
        }
        Request::Resize {
            session,
            cols,
            rows,
        } if session == owner.session => {
            valid_size(cols, rows) && unsafe { p13_resize(native, cols, rows) }
        }
        Request::Close { session } if session == owner.session => return 1,
        _ => false,
    };
    if accepted { 0 } else { 3 }
}

struct InheritedInput(HANDLE);

impl AsyncRead for InheritedInput {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let data = buffer.initialize_unfilled();
        let mut received = 0;
        // The reader thread owns blocking input, directly into the frame codec's buffer.
        if unsafe {
            ReadFile(
                self.0,
                data.as_mut_ptr(),
                data.len() as u32,
                &mut received,
                ptr::null_mut(),
            )
        } != 0
        {
            buffer.advance(received as usize);
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_BROKEN_PIPE as i32) {
                return Poll::Ready(Err(error));
            }
        }
        Poll::Ready(Ok(()))
    }
}

fn reader(wake: Arc<OwnedHandle>, sender: SyncSender<Control>) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread().build() else {
        return;
    };
    rt.block_on(async {
        let mut input = InheritedInput(unsafe { GetStdHandle(STD_INPUT_HANDLE) });
        loop {
            let frame = read_frame(&mut input).await;
            let finished = !matches!(&frame, Ok(Some(_)));
            if sender.send(frame).is_err() {
                break;
            }
            unsafe { SetEvent(wake.as_raw_handle()) };
            if finished {
                break;
            }
        }
    });
}

fn writer(receiver: Receiver<Event>) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread().build()?;
    rt.block_on(async {
        let mut output = tokio::io::stdout();
        for event in receiver {
            write_frame(&mut output, &event).await?;
        }
        Ok(())
    })
}

fn run_inner() -> Option<ExitCode> {
    if std::env::args_os().len() != 1 || !unsafe { p13_pipes() } {
        return None;
    }
    let wake = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
    if wake.is_null() {
        return None;
    }
    let wake = Arc::new(unsafe { OwnedHandle::from_raw_handle(wake) });
    let (send, incoming) = mpsc::sync_channel(1);
    let reader_wake = wake.clone();
    thread::Builder::new()
        .spawn(move || reader(reader_wake, send))
        .ok()?;
    let Request::Start {
        version,
        protocol: Protocol::Ssh1,
        session,
        endpoint,
        username,
        cols,
        rows,
    } = incoming.recv_timeout(Duration::from_secs(5)).ok()?.ok()??
    else {
        return None;
    };
    // The parent assigns the Job before releasing Start through the inherited pipes.
    if !unsafe { p13_managed() }
        || version != VERSION
        || session.start_id.is_nil()
        || session.connection.connection_id.0.is_nil()
        || session.connection.generation == 0
        || !valid_host(&endpoint.host)
        || endpoint.port == 0
        || username.is_empty()
        || username.len() > 128
        || username.chars().any(char::is_control)
        || !valid_size(cols, rows)
    {
        return None;
    }
    let host = CString::new(endpoint.host.as_str()).ok()?;
    let username = CString::new(username).ok()?;
    let (outgoing, output) = mpsc::sync_channel(16);
    let writer_failed = Arc::new(AtomicBool::new(false));
    let error_wake = wake.clone();
    let error_flag = writer_failed.clone();
    let writer = thread::Builder::new()
        .spawn(move || {
            let result = writer(output);
            if result.is_err() {
                error_flag.store(true, Ordering::Release);
                unsafe { SetEvent(error_wake.as_raw_handle()) };
            }
            result
        })
        .ok()?;
    let owner = Owner {
        session,
        endpoint,
        pending: RefCell::new(None),
        incoming,
        outgoing,
        writer_failed,
    };
    let mut status = -1;
    let result = unsafe {
        p13_owner(
            (&owner as *const Owner).cast(),
            wake.as_raw_handle(),
            host.as_ptr(),
            owner.endpoint.port,
            username.as_ptr(),
            cols,
            rows,
            &mut status,
        )
    };
    let reason = match result {
        1 => EndReason::Closed,
        2 => EndReason::ControlLost,
        3 => EndReason::InvalidControl,
        4 => EndReason::HostDeclined,
        5 => EndReason::AuthFailed,
        6 => EndReason::Timeout,
        7 => EndReason::PeerClosed,
        8 => EndReason::BackendExit,
        _ => EndReason::Backend,
    };
    let sent = owner
        .outgoing
        .send(Event::Ended {
            session,
            reason,
            backend_status: (reason == EndReason::BackendExit).then_some(status),
        })
        .is_ok();
    drop(owner);
    (sent && writer.join().ok()?.is_ok()).then_some(ExitCode::SUCCESS)
}

pub fn run() -> ExitCode {
    run_inner().unwrap_or(ExitCode::from(2))
}
