use std::{
    env,
    ffi::{OsStr, OsString, c_void},
    fs::File,
    io::{self, Read, Write},
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0},
    System::{
        Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole},
        Pipes::CreatePipe,
        Threading::{
            CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
            EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
            InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
            UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

const OUTPUT_LIMIT: usize = 512 * 1024;
const INPUT_QUEUE: usize = 32;
const STARTUP_CLEAR: &[u8] = b"\x1b[?25l\x1b[2J\x1b[m\x1b[H";

#[derive(Default)]
pub struct Output {
    pub bytes: Vec<u8>,
    pub overflow: bool,
    pub exit: Option<u32>,
}

impl Output {
    pub fn ready(&self) -> bool {
        !self.bytes.is_empty() || self.overflow || self.exit.is_some()
    }
}

struct Console(HPCON);
impl Drop for Console {
    fn drop(&mut self) {
        unsafe { ClosePseudoConsole(self.0) };
    }
}

struct Attributes(Vec<usize>);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
    }
}

pub struct Process {
    process: Arc<OwnedHandle>,
    console: Arc<Mutex<Option<Console>>>,
    input: Option<mpsc::SyncSender<Vec<u8>>>,
    finished: Option<JoinHandle<()>>,
    pub output: Arc<Mutex<Output>>,
    pub output_ready: Arc<tokio::sync::Notify>,
    pub output_reader: Arc<tokio::sync::Semaphore>,
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write): (HANDLE, HANDLE) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read),
            OwnedHandle::from_raw_handle(write),
        )
    })
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

// The Windows CRT treats backslashes specially only before a quote.
pub fn quote(argument: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            slashes * if character == '"' { 2 } else { 1 },
        ));
        if character == '"' {
            result.push('\\');
        }
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

fn dimensions(cols: u16, rows: u16) -> COORD {
    COORD {
        X: cols.clamp(2, 500) as i16,
        Y: rows.clamp(1, 200) as i16,
    }
}

fn spawn(
    console: HPCON,
    executable: &Path,
    argv: &[String],
    cwd: &Path,
    environment: Option<&[u16]>,
    raw_tail: Option<&str>,
) -> io::Result<OwnedHandle> {
    let mut bytes = 0;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
    let mut memory = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let pointer = memory.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _attributes = Attributes(memory);
    if unsafe {
        UpdateProcThreadAttribute(
            pointer,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            console as *const c_void,
            size_of::<HPCON>(),
            null_mut(),
            null(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // Null standard handles let ConPTY attach its own streams even when the
    // desktop process was launched with redirected standard handles.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = pointer;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let exe = wide(executable.as_os_str());
    let cwd = wide(cwd.as_os_str());
    let mut command = std::iter::once(quote(&executable.to_string_lossy()))
        .chain(argv.iter().map(|arg| quote(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(tail) = raw_tail {
        command.push_str(tail);
    }
    let mut command = wide(OsStr::new(&command));
    if unsafe {
        CreateProcessW(
            exe.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment.map_or(null(), |values| values.as_ptr().cast()),
            cwd.as_ptr(),
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

fn child_environment(key: &str, value: Option<&OsStr>) -> Vec<u16> {
    let mut values: Vec<_> = env::vars_os()
        .filter(|(name, _)| !name.eq_ignore_ascii_case(key))
        .collect();
    if let Some(value) = value {
        values.push((OsString::from(key), value.to_os_string()));
    }
    values.sort_by_cached_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (mut name, value) in values {
        name.push("=");
        name.push(value);
        block.extend(wide(&name));
    }
    block.push(0);
    block
}

impl Process {
    pub fn start(
        executable: &Path,
        argv: &[String],
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> io::Result<Self> {
        Self::start_configured(executable, argv, cwd, cols, rows, None, None)
    }

    pub fn start_windows_powershell(
        executable: &Path,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> io::Result<Self> {
        // Windows PowerShell builds its own module search path. An intermediate
        // host can otherwise pass along PowerShell 7's incompatible modules.
        let block = child_environment("PSModulePath", None);
        Self::start_configured(
            executable,
            &["-NoLogo".into()],
            cwd,
            cols,
            rows,
            Some(&block),
            None,
        )
    }

    pub fn start_script(
        executable: &Path,
        path: &Path,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> io::Result<Self> {
        // Carry the path as data. cmd expands the fixed variable once, with
        // delayed expansion and AutoRun disabled, inside the quoted command.
        let block = child_environment("SHARED_TERMINAL_SCRIPT", Some(path.as_os_str()));
        Self::start_configured(
            executable,
            &[],
            cwd,
            cols,
            rows,
            Some(&block),
            Some(r#" /D /V:OFF /S /C ""%SHARED_TERMINAL_SCRIPT%"""#),
        )
    }

    fn start_configured(
        executable: &Path,
        argv: &[String],
        cwd: &Path,
        cols: u16,
        rows: u16,
        environment: Option<&[u16]>,
        raw_tail: Option<&str>,
    ) -> io::Result<Self> {
        let (input_read, input_write) = pipe()?;
        let (output_read, output_write) = pipe()?;
        let mut console = 0;
        let result = unsafe {
            CreatePseudoConsole(
                dimensions(cols, rows),
                input_read.as_raw_handle(),
                output_write.as_raw_handle(),
                0,
                &mut console,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        let console = Console(console);
        let output = Arc::new(Mutex::new(Output::default()));
        let output_ready = Arc::new(tokio::sync::Notify::new());
        let collected = output.clone();
        let reader_ready = output_ready.clone();
        let reader = thread::spawn(move || {
            let mut file = File::from(output_read);
            let mut chunk = [0; 8192];
            let mut intro = Some(Vec::with_capacity(STARTUP_CLEAR.len()));
            while let Ok(count @ 1..) = file.read(&mut chunk) {
                let initial;
                let bytes = if let Some(prefix) = intro.as_mut() {
                    prefix.extend_from_slice(&chunk[..count]);
                    if prefix.len() < STARTUP_CLEAR.len() && STARTUP_CLEAR.starts_with(prefix) {
                        continue;
                    }
                    initial = intro.take().unwrap();
                    initial.strip_prefix(STARTUP_CLEAR).unwrap_or(&initial)
                } else {
                    &chunk[..count]
                };
                if bytes.is_empty() {
                    continue;
                }
                let mut output = collected.lock().unwrap();
                let wake = !output.ready();
                if output.bytes.len() + bytes.len() > OUTPUT_LIMIT {
                    output.bytes.clear();
                    output.overflow = true;
                }
                output.bytes.extend_from_slice(bytes);
                drop(output);
                if wake {
                    reader_ready.notify_one();
                }
            }
            if let Some(prefix) = intro {
                collected.lock().unwrap().bytes.extend_from_slice(&prefix);
            }
        });
        let spawned = spawn(console.0, executable, argv, cwd, environment, raw_tail);
        drop(input_read);
        drop(output_write);
        let process = match spawned {
            Ok(process) => Arc::new(process),
            Err(error) => {
                drop(console);
                let _ = reader.join();
                return Err(error);
            }
        };
        let (input, receiver) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE);
        let writer = thread::spawn(move || {
            let mut file = File::from(input_write);
            while let Ok(bytes) = receiver.recv() {
                if file.write_all(&bytes).is_err() {
                    break;
                }
            }
        });
        let console = Arc::new(Mutex::new(Some(console)));
        let waiting_console = console.clone();
        let waiting_process = process.clone();
        let waiting_output = output.clone();
        let finished_ready = output_ready.clone();
        let finished = thread::spawn(move || {
            let mut code = u32::MAX;
            unsafe {
                if WaitForSingleObject(waiting_process.as_raw_handle(), INFINITE) == WAIT_OBJECT_0 {
                    GetExitCodeProcess(waiting_process.as_raw_handle(), &mut code);
                }
            }
            let console = waiting_console.lock().unwrap().take();
            drop(console);
            let _ = reader.join();
            waiting_output.lock().unwrap().exit = Some(code);
            finished_ready.notify_one();
            let _ = writer.join();
        });
        Ok(Self {
            process,
            console,
            input: Some(input),
            finished: Some(finished),
            output,
            output_ready,
            output_reader: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    pub fn input(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.input
            .as_ref()
            .unwrap()
            .try_send(bytes)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => "前台输入队列已满，本次输入未送达".into(),
                mpsc::TrySendError::Disconnected(_) => "前台进程已退出".into(),
            })
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(console) = self.console.lock().unwrap().as_ref() {
            unsafe {
                ResizePseudoConsole(console.0, dimensions(cols, rows));
            }
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.input.take();
        unsafe {
            TerminateProcess(self.process.as_raw_handle(), 0xc000013a);
        }
        if let Some(thread) = self.finished.take() {
            let _ = thread.join();
        }
    }
}
