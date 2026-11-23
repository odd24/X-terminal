use super::{Plan, Stage};
use crate::local_terminal::conpty::{Attributes, OUTPUT_LIMIT, Output, quote, wide};
use std::{
    ffi::OsStr,
    io::{self, Read, Write},
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    ptr::{null, null_mut},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CreateProcessW, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetExitCodeProcess, InitializeProcThreadAttributeList, PROCESS_INFORMATION,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

const HANDLE_LIST: usize = 0x0002_0002;
const JOB_LIST: usize = 0x0002_000d;
const COMMAND_TIME: Duration = Duration::from_mins(30);
const WAIT_DEVICE: Duration = Duration::from_secs(12);

#[derive(Default)]
struct Control {
    stopped: AtomicBool,
    input: Mutex<Option<mpsc::SyncSender<Vec<u8>>>>,
}

#[derive(Default)]
struct Stream {
    output: Arc<Mutex<Output>>,
    ready: Arc<tokio::sync::Notify>,
}

impl Stream {
    fn append(&self, bytes: &[u8]) {
        let mut out = self.output.lock().unwrap();
        let count = bytes
            .len()
            .min(OUTPUT_LIMIT.saturating_sub(out.bytes.len()));
        out.bytes.extend_from_slice(&bytes[..count]);
        out.overflow |= count != bytes.len();
        self.ready.notify_one();
    }
    fn line(&self, line: &str) {
        self.append(format!("\r\n{line}\r\n").as_bytes());
    }
}

pub(in crate::local_terminal) struct Process {
    control: Arc<Control>,
    worker: Option<JoinHandle<()>>,
    pub output: Arc<Mutex<Output>>,
    pub output_ready: Arc<tokio::sync::Notify>,
    pub output_reader: Arc<tokio::sync::Semaphore>,
}

impl Process {
    pub fn start(plan: Plan, cwd: &Path) -> io::Result<Self> {
        let control = Arc::new(Control::default());
        let stream = Arc::new(Stream::default());
        let cwd = cwd.to_path_buf();
        let ctl = control.clone();
        let sink = stream.clone();
        let worker = thread::Builder::new().spawn(move || {
            let result = run(plan, &cwd, &ctl, &sink);
            let code = match result {
                Ok(()) => 0,
                Err(error) => {
                    sink.line(&error);
                    1
                }
            };
            sink.output.lock().unwrap().exit = Some(code);
            sink.ready.notify_one();
        })?;
        Ok(Self {
            control,
            worker: Some(worker),
            output: stream.output.clone(),
            output_ready: stream.ready.clone(),
            output_reader: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    pub fn input(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes == [3] {
            self.control.stopped.store(true, Ordering::Release);
            return Ok(());
        }
        let bytes = if bytes == [b'\r'] {
            b"\r\n".to_vec()
        } else {
            bytes
        };
        self.control
            .input
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("本步骤暂无可用的标准输入")?
            .try_send(bytes)
            .map_err(|_| "本地命令输入队列已满或本步骤已退出".into())
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.control.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn job() -> io::Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn inherit(handle: HANDLE) -> io::Result<OwnedHandle> {
    let current = unsafe { GetCurrentProcess() };
    let mut duplicate = null_mut();
    if unsafe {
        DuplicateHandle(
            current,
            handle,
            current,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicate) })
}

fn spawn(
    stage: &Stage,
    cwd: &Path,
    serial: Option<&str>,
    job: &OwnedHandle,
    handles: [HANDLE; 3],
) -> io::Result<OwnedHandle> {
    let handles = [
        inherit(handles[0])?,
        inherit(handles[1])?,
        inherit(handles[2])?,
    ];
    let mut handles_raw = handles.each_ref().map(|handle| handle.as_raw_handle());
    let mut job_raw = job.as_raw_handle();
    let mut bytes = 0;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
    let mut memory = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let attributes = memory.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(attributes, 2, 0, &mut bytes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _attributes = Attributes(memory);
    for (key, value, size) in [
        (
            HANDLE_LIST,
            handles_raw.as_mut_ptr().cast(),
            size_of_val(&handles_raw),
        ),
        (
            JOB_LIST,
            (&mut job_raw as *mut HANDLE).cast(),
            size_of::<HANDLE>(),
        ),
    ] {
        if unsafe {
            UpdateProcThreadAttribute(attributes, 0, key, value, size, null_mut(), null_mut())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    let prefix = if stage.device {
        vec![
            "-s",
            serial.ok_or(io::Error::other("missing fixed ADB device"))?,
        ]
    } else {
        Vec::new()
    };
    let command = std::iter::once(quote(&stage.image.to_string_lossy()))
        .chain(prefix.iter().map(|value| quote(value)))
        .chain(stage.args.iter().map(|arg| quote(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = wide(OsStr::new(&command));
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles_raw[0];
    startup.StartupInfo.hStdOutput = handles_raw[1];
    startup.StartupInfo.hStdError = handles_raw[2];
    startup.lpAttributeList = attributes;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessW(
            wide(stage.image.as_os_str()).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            wide(cwd.as_os_str()).as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    drop(unsafe { OwnedHandle::from_raw_handle(process.hThread) });
    Ok(unsafe { OwnedHandle::from_raw_handle(process.hProcess) })
}

fn drain(mut reader: impl Read, sink: &Stream, root_capture: Option<&Mutex<Vec<u8>>>) {
    let mut buffer = [0u8; 4096];
    let mut prior_cr = false;
    while let Ok(count @ 1..) = reader.read(&mut buffer) {
        if let Some(capture) = root_capture {
            let mut data = capture.lock().unwrap();
            let limit = count.min(65536usize.saturating_sub(data.len()));
            data.extend_from_slice(&buffer[..limit]);
        }
        let mut terminal = Vec::with_capacity(count * 2);
        for &byte in &buffer[..count] {
            if byte == b'\n' && !prior_cr {
                terminal.push(b'\r');
            }
            terminal.push(byte);
            prior_cr = byte == b'\r';
        }
        sink.append(&terminal);
    }
}

fn execute(
    stages: &[Stage],
    serial: Option<&str>,
    cwd: &Path,
    deadline: Instant,
    control: &Control,
    sink: &Arc<Stream>,
) -> Result<Vec<u8>, String> {
    let job = job().map_err(|err| format!("本机进程隔离启动失败：{err}"))?;
    let (mut source, mut input) = io::pipe().map_err(|err| err.to_string())?;
    let mut children = Vec::new();
    let mut errors = Vec::new();
    let mut end = None;
    for (index, stage) in stages.iter().enumerate() {
        if control.stopped.load(Ordering::Acquire) {
            return Err("已中断整组命令（Ctrl+C）".into());
        }
        let (next, output) = io::pipe().map_err(|err| err.to_string())?;
        let (error_reader, error) = io::pipe().map_err(|err| err.to_string())?;
        let child = spawn(
            stage,
            cwd,
            serial,
            &job,
            [
                source.as_raw_handle(),
                output.as_raw_handle(),
                error.as_raw_handle(),
            ],
        )
        .map_err(|err| format!("第 {} 段启动失败：{err}", index + 1))?;
        children.push((index + 1, child));
        errors.push(error_reader);
        drop(output);
        drop(error);
        if index + 1 == stages.len() {
            end = Some(next);
            break;
        }
        source = next;
    }
    drop(source);
    let capture = stages
        .first()
        .filter(|stage| stage.root)
        .map(|_| Arc::new(Mutex::new(Vec::new())));
    errors.push(end.ok_or("缺少步骤输出")?);
    let readers: Vec<_> = errors
        .into_iter()
        .map(|pipe| {
            let sink = sink.clone();
            let capture = capture.clone();
            thread::spawn(move || drain(pipe, &sink, capture.as_deref()))
        })
        .collect();
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(32);
    *control.input.lock().unwrap() = Some(tx);
    let writer = thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if input.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    let result = (|| {
        while !children.is_empty() {
            if control.stopped.load(Ordering::Acquire) {
                return Err("已中断整组命令（Ctrl+C）".into());
            }
            if Instant::now() >= deadline {
                return Err("本步骤超时，已停止后续步骤".into());
            }
            let mut index = 0;
            while index < children.len() {
                let (part, child) = &children[index];
                match unsafe { WaitForSingleObject(child.as_raw_handle(), 0) } {
                    WAIT_OBJECT_0 => {
                        let mut code = 0;
                        if unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut code) } == 0 {
                            return Err("无法核对本机进程退出状态".into());
                        }
                        if code != 0 {
                            return Err(format!("第 {part} 段退出码 {code}，已停止后续步骤"));
                        }
                        children.swap_remove(index);
                    }
                    WAIT_TIMEOUT => index += 1,
                    _ => return Err("等待本机进程失败".into()),
                }
            }
            if !children.is_empty() {
                thread::sleep(Duration::from_millis(15));
            }
        }
        Ok(())
    })();
    control.input.lock().unwrap().take();
    drop(job);
    let _ = writer.join();
    for reader in readers {
        let _ = reader.join();
    }
    result?;
    Ok(capture.map_or_else(Vec::new, |data| std::mem::take(&mut *data.lock().unwrap())))
}

fn run(plan: Plan, cwd: &Path, control: &Control, sink: &Arc<Stream>) -> Result<(), String> {
    let deadline = Instant::now() + COMMAND_TIME;
    let total = plan.steps.len();
    sink.line("在 Windows 本机执行");
    if let Some(serial) = &plan.serial {
        sink.line(&format!("固定 ADB 设备 {serial}"));
    }
    for (index, step) in plan.steps.into_iter().enumerate() {
        if control.stopped.load(Ordering::Acquire) {
            return Err("已中断整组命令（Ctrl+C）".into());
        }
        sink.line(&format!("[{}/{}] 开始", index + 1, total));
        let captured = execute(&step, plan.serial.as_deref(), cwd, deadline, control, sink)?;
        if step[0].root {
            let root = String::from_utf8_lossy(&captured).to_ascii_lowercase();
            if [
                "cannot",
                "error",
                "denied",
                "not allowed",
                "not permitted",
                "failed",
                "unauthorized",
            ]
            .iter()
            .any(|pattern| root.contains(pattern))
                || !["restarting adbd as root", "adbd is already running as root"]
                    .iter()
                    .any(|pattern| root.contains(pattern))
            {
                return Err("ADB root 被拒绝或未确认成功，已停止后续步骤".into());
            }
            sink.line("等待原 ADB 设备重新就绪");
            let wait = Stage {
                image: step[0].image.clone(),
                args: vec!["wait-for-device".into()],
                device: true,
                root: false,
            };
            execute(
                &[wait],
                plan.serial.as_deref(),
                cwd,
                deadline.min(Instant::now() + WAIT_DEVICE),
                control,
                sink,
            )?;
        }
        sink.line(&format!("[{}/{}] 完成", index + 1, total));
    }
    Ok(())
}
