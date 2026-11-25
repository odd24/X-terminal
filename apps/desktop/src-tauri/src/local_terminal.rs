pub(crate) mod adb;
mod batch;
mod conpty;
pub(crate) mod directory;
mod file_drop;
mod psreadline;
pub(crate) mod scripts;

use conpty::{Output, Process};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

const MAX_SESSIONS: usize = 16;
const MAX_LINE: usize = 8192;
const MAX_INPUT: usize = 16384;

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<Uuid, Session>>);

struct Session {
    cwd: PathBuf,
    startup_warning: Option<String>,
    script: Option<String>,
    script_directory: Option<PathBuf>,
    drives: HashMap<String, PathBuf>,
    active: Option<Foreground>,
    powershell: bool,
    last_request: Option<Uuid>,
    message: Option<String>,
    interrupted: bool,
    pending_adb: Option<(Uuid, Option<PreparedShortcut>)>,
    close_on_success: bool,
    cols: u16,
    rows: u16,
}

enum Foreground {
    Console(Process),
    Batch(batch::Process),
}

impl Foreground {
    fn output(&self) -> &Arc<Mutex<Output>> {
        match self {
            Self::Console(p) => &p.output,
            Self::Batch(p) => &p.output,
        }
    }
    fn signals(&self) -> (&Arc<tokio::sync::Notify>, &Arc<tokio::sync::Semaphore>) {
        match self {
            Self::Console(p) => (&p.output_ready, &p.output_reader),
            Self::Batch(p) => (&p.output_ready, &p.output_reader),
        }
    }
    fn input(&self, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Console(p) => p.input(bytes),
            Self::Batch(p) => p.input(bytes),
        }
    }
}

enum ShortcutPlan {
    Adb(adb::Prepared),
    Batch(batch::Prepared),
}

struct PreparedShortcut {
    plan: ShortcutPlan,
    revision: Uuid,
    close_on_success: bool,
}

#[derive(Serialize)]
struct View {
    cwd: String,
    startup_warning: Option<String>,
    task: Option<Uuid>,
    running: bool,
    bytes: Vec<u8>,
    overflow: bool,
    message: Option<String>,
    command: Option<String>,
    exit_code: Option<u32>,
    script: Option<String>,
    script_directory: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    close_after_result: bool,
}

#[derive(Deserialize)]
pub struct ScriptRequest {
    button: Uuid,
    revision: Uuid,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Open {
        id: Uuid,
        inherit: Option<Uuid>,
        #[serde(default)]
        powershell: bool,
        script: Option<ScriptRequest>,
    },
    Poll {
        id: Uuid,
    },
    Run {
        id: Uuid,
        request: Uuid,
        line: String,
    },
    RunAdb {
        id: Uuid,
        request: Uuid,
        target: Option<String>,
    },
    CancelAdb {
        id: Uuid,
        request: Uuid,
    },
    Input {
        id: Uuid,
        request: Uuid,
        text: String,
    },
    FileDropEpoch {
        id: Uuid,
        request: Uuid,
    },
    FileDrop {
        id: Uuid,
        request: Uuid,
        generation: u32,
        paths: Vec<String>,
    },
    Resize {
        id: Uuid,
        cols: u16,
        rows: u16,
    },
    Close {
        id: Uuid,
    },
    CloseAll,
    OpenScriptDirectory {
        id: Uuid,
    },
}

fn arguments(line: &str) -> Result<Vec<String>, String> {
    if line.len() > MAX_LINE || line.chars().any(char::is_control) {
        return Err("请输入一条不超过 8192 字节的命令".into());
    }
    let mut quoted = false;
    let mut started = false;
    let mut slashes = 0;
    let mut current = String::new();
    let mut args = Vec::new();
    for character in line.chars() {
        if character == '\\' {
            slashes += 1;
            started = true;
            continue;
        }
        if character == '"' {
            current.extend(std::iter::repeat_n('\\', slashes / 2));
            if slashes % 2 == 0 {
                quoted = !quoted;
            } else {
                current.push('"');
            }
            started = true;
        } else {
            current.extend(std::iter::repeat_n('\\', slashes));
            if !quoted && "|&<>^;()".contains(character) {
                return Err("本地入口只运行单条命令。请将作为参数的操作符放在双引号内".into());
            }
            if character == ' ' && !quoted {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            } else {
                current.push(character);
                started = true;
            }
        }
        slashes = 0;
    }
    if quoted {
        return Err("双引号未闭合".into());
    }
    current.extend(std::iter::repeat_n('\\', slashes));
    if started {
        args.push(current);
    }
    Ok(args)
}

fn absolute(path: &str, cwd: &Path) -> PathBuf {
    cwd.join(path)
}

fn executable(program: &str, cwd: &Path) -> Result<PathBuf, String> {
    if program.is_empty() {
        return Err("缺少程序名称".into());
    }
    let mut name = PathBuf::from(program);
    match name.extension().and_then(|ext| ext.to_str()) {
        None => {
            name.set_extension("exe");
        }
        Some(ext) if ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com") => {}
        _ => return Err("请指定 .exe 或 .com 可执行程序。此入口不解析脚本".into()),
    }
    if name.components().count() > 1 {
        let path = absolute(name.to_str().unwrap(), cwd);
        return path
            .is_file()
            .then_some(path)
            .ok_or_else(|| format!("指定程序不存在：{program}"));
    }
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(&name))
        .find(|path| path.is_file())
        .ok_or_else(|| format!("PATH 中找不到 {program}。可输入完整的程序路径"))
}

fn drive(path: &Path) -> Option<String> {
    let prefix = path.to_str()?.get(..2)?;
    (prefix.as_bytes()[0].is_ascii_alphabetic() && prefix.ends_with(':'))
        .then(|| prefix.to_ascii_uppercase())
}

fn list(path: &Path) -> Result<String, String> {
    let mut rows = Vec::new();
    for entry in fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .take(1001)
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            "[目录] "
        } else {
            ""
        };
        rows.push(format!("{kind}{}", entry.file_name().to_string_lossy()));
    }
    let truncated = rows.len() > 1000;
    rows.truncate(1000);
    rows.sort();
    if truncated {
        rows.push("目录列表仅显示前 1000 项".into());
    }
    Ok(rows.join("\n"))
}

impl Session {
    fn change_directory(&mut self, path: PathBuf) -> Result<Option<String>, String> {
        if !path.is_dir() {
            return Err(format!("目录不可用：{}", path.display()));
        }
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        let display = canonical.to_string_lossy();
        self.cwd = if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else if let Some(dos) = display.strip_prefix(r"\\?\") {
            PathBuf::from(dos)
        } else {
            canonical
        };
        if let Some(drive) = drive(&self.cwd) {
            self.drives.insert(drive, self.cwd.clone());
        }
        Ok(None)
    }

    fn run(&mut self, line: &str, root: &Path) -> Result<Option<String>, String> {
        let args = arguments(line)?;
        let Some((program, argv)) = args.split_first() else {
            return Ok(None);
        };
        match (program.to_ascii_lowercase().as_str(), argv) {
            ("pwd" | "cd", []) => Ok(Some(self.cwd.display().to_string())),
            ("cd", [path]) => self.change_directory(absolute(path, &self.cwd)),
            ("dir" | "ls", []) => list(&self.cwd).map(Some),
            ("dir" | "ls", [path]) => list(&absolute(path, &self.cwd)).map(Some),
            ("pwd" | "cd" | "dir" | "ls", _) => Err("此内建命令只接受一个目录参数".into()),
            (name, []) if name.len() == 2 && drive(Path::new(name)).is_some() => {
                let name = name.to_ascii_uppercase();
                self.change_directory(
                    self.drives
                        .get(&name)
                        .cloned()
                        .unwrap_or_else(|| PathBuf::from(format!("{name}\\"))),
                )
            }
            _ => {
                let executable = adb::resolve(program, &self.cwd, root)?;
                self.active = Some(Foreground::Console(
                    Process::start(&executable, argv, &self.cwd, self.cols, self.rows)
                        .map_err(|error| format!("{program} 启动失败：{error}"))?,
                ));
                self.interrupted = false;
                Ok(None)
            }
        }
    }

    fn view(&mut self) -> View {
        let mut output = self
            .active
            .as_ref()
            .map(|process| {
                let mut output = process.output().lock().unwrap();
                std::mem::take(&mut *output)
            })
            .unwrap_or_default();
        let exit_code = output.exit.take();
        let close_after_result =
            exit_code == Some(0) && !self.interrupted && self.close_on_success && !output.overflow;
        if let Some(code) = exit_code {
            self.close_on_success = false;
            self.active.take();
            self.message = Some(match (self.interrupted, code) {
                (true, 0xc000013a | 130) => "已中断（Ctrl+C）".into(),
                (true, code) => format!("前台进程退出（{code}，已发送 Ctrl+C）"),
                (false, code) => format!("前台进程退出（{code}）"),
            });
        }
        View {
            cwd: self.cwd.display().to_string(),
            startup_warning: self.startup_warning.take(),
            task: self.last_request,
            running: self.active.is_some(),
            bytes: output.bytes,
            overflow: output.overflow,
            message: self.message.take(),
            command: None,
            exit_code,
            script: self.script.clone(),
            close_after_result,
            script_directory: self
                .script_directory
                .as_ref()
                .map(|path| path.display().to_string()),
        }
    }
}

impl Terminals {
    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.0.lock().unwrap());
        drop(sessions);
    }

    fn ready_output(&self, id: Uuid, task: Uuid) -> Result<Option<View>, String> {
        let mut sessions = self.0.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("本地标签已关闭")?;
        if session.last_request != Some(task) {
            return Err("本地前台任务已变化".into());
        }
        let ready = session
            .active
            .as_ref()
            .is_some_and(|process| process.output().lock().unwrap().ready());
        Ok(ready.then(|| session.view()))
    }
}

#[tauri::command]
pub async fn poll_local_output(
    window: WebviewWindow,
    state: State<'_, Terminals>,
    id: Uuid,
    task: Uuid,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("本地命令行仅在主窗口可用".into());
    }
    let (ready, _reader) = {
        let sessions = state.0.lock().unwrap();
        let session = sessions.get(&id).ok_or("本地标签已关闭")?;
        if session.last_request != Some(task) {
            return Err("本地前台任务已变化".into());
        }
        let Some(process) = &session.active else {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        };
        let (ready, reader) = process.signals();
        let permit = reader
            .clone()
            .try_acquire_owned()
            .map_err(|_| "本地输出已在读取")?;
        (ready.clone(), permit)
    };
    let view = tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            let notified = ready.notified();
            if let Some(view) = state.ready_output(id, task)? {
                return Ok::<_, String>(view);
            }
            notified.await;
        }
    })
    .await;
    let Ok(view) = view else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    let mut view = view?;
    let mut bytes = std::mem::take(&mut view.bytes);
    let metadata = serde_json::to_vec(&view).map_err(|error| error.to_string())?;
    let mut frame = Vec::with_capacity(4 + metadata.len() + bytes.len());
    frame.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    frame.extend_from_slice(&metadata);
    frame.append(&mut bytes);
    Ok(tauri::ipc::Response::new(frame))
}

#[tauri::command]
pub async fn local_terminal(
    window: WebviewWindow,
    state: State<'_, Terminals>,
    desktop: State<'_, crate::Desktop>,
    action: Action,
) -> Result<serde_json::Value, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("本地命令行仅在主窗口可用".into());
    }
    let live_shell = |id, request| {
        state.0.lock().unwrap().get(&id).is_some_and(|session| {
            session.powershell && session.active.is_some() && session.last_request == Some(request)
        })
    };
    let action = match action {
        Action::FileDropEpoch { id, request } => {
            let epoch = live_shell(id, request)
                .then(|| file_drop::epoch(request))
                .flatten();
            return Ok(serde_json::json!(epoch));
        }
        Action::FileDrop {
            id,
            request,
            generation,
            paths,
        } => {
            if !live_shell(id, request) {
                return Err("PowerShell 编辑目标已关闭或变化".into());
            }
            file_drop::insert(request, generation, paths).await?;
            return Ok(serde_json::Value::Null);
        }
        other => other,
    };
    let startup = if matches!(
        &action,
        Action::Open {
            inherit: None,
            script: None,
            ..
        }
    ) {
        let root = desktop.2.clone();
        Some(
            tauri::async_runtime::spawn_blocking(move || directory::startup(&root))
                .await
                .map_err(|_| "无法读取本地终端默认目录")??,
        )
    } else {
        None
    };
    let prepared_shell = if matches!(
        &action,
        Action::Open {
            powershell: true,
            script: None,
            ..
        }
    ) {
        let request = Uuid::new_v4();
        let image = env::var_os("SystemRoot")
            .map(PathBuf::from)
            .ok_or("找不到 Windows 系统目录")?
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let module = psreadline::CompatibilityModule::prepare(&image, &desktop.2, request).await;
        Some((request, image, module))
    } else {
        None
    };
    let mut sessions = state.0.lock().unwrap();
    let view = match action {
        Action::Open {
            id,
            inherit,
            powershell,
            script,
        } => {
            if sessions.contains_key(&id) || sessions.len() == MAX_SESSIONS {
                return Err("本地标签已存在或达到上限".into());
            }
            let script = if let Some(request) = script {
                let settings = adb::read(&desktop.2)?;
                if settings.revision != Some(request.revision) {
                    return Err("快捷指令已更新，请重新选择".into());
                }
                let item = settings
                    .shortcuts
                    .iter()
                    .find(|item| item.id == request.button)
                    .ok_or("脚本入口已移除")?;
                let (file, path) =
                    scripts::readable(item.script_path.as_deref().ok_or("此入口不是本地脚本")?)?;
                Some((item.name.clone(), file, path, item.close_on_success))
            } else {
                None
            };
            let (cwd, startup_warning) = if let Some((_, _, path, _)) = &script {
                (
                    path.parent().ok_or("找不到脚本工作目录")?.to_path_buf(),
                    None,
                )
            } else if let Some(source) = inherit {
                (
                    sessions.get(&source).ok_or("发起标签已关闭")?.cwd.clone(),
                    None,
                )
            } else {
                startup.ok_or("无法定位本地终端默认目录")?
            };
            let mut session = Session {
                cwd,
                startup_warning,
                script: None,
                script_directory: None,
                drives: HashMap::new(),
                active: None,
                powershell: false,
                last_request: None,
                message: None,
                interrupted: false,
                pending_adb: None,
                close_on_success: false,
                cols: 80,
                rows: 24,
            };
            if let Some((name, _file, path, close_on_success)) = script {
                // cmd falls back to another directory for UNC working directories.
                let image = env::var_os("SystemRoot")
                    .map(PathBuf::from)
                    .ok_or("找不到 Windows 系统目录")?
                    .join(r"System32\cmd.exe");
                session.active = Some(Foreground::Console(
                    Process::start_script(&image, &path, &session.cwd, session.cols, session.rows)
                        .map_err(|error| format!("脚本启动失败：{error}"))?,
                ));
                session.close_on_success = close_on_success;
                session.script_directory = Some(session.cwd.clone());
                session.script = Some(name);
                session.last_request = Some(Uuid::new_v4());
                session.message = None;
            } else if powershell {
                let (request, image, module) =
                    prepared_shell.ok_or("无法准备 Windows PowerShell")?;
                session.active = Some(Foreground::Console(
                    Process::start_windows_powershell(
                        &image,
                        &session.cwd,
                        session.cols,
                        session.rows,
                        request,
                        module,
                    )
                    .map_err(|error| format!("Windows PowerShell 启动失败：{error}"))?,
                ));
                session.last_request = Some(request);
                session.powershell = true;
            }
            let view = session.view();
            sessions.insert(id, session);
            view
        }
        Action::Close { id } => {
            let closed = sessions.remove(&id);
            drop(sessions);
            drop(closed);
            return Ok(serde_json::Value::Null);
        }
        Action::CloseAll => {
            drop(sessions);
            state.close_all();
            return Ok(serde_json::Value::Null);
        }
        Action::OpenScriptDirectory { id } => {
            let directory = sessions
                .get(&id)
                .and_then(|session| session.script_directory.clone())
                .ok_or("脚本工作目录不可用")?;
            drop(sessions);
            crate::export_save::open_directory(
                &directory,
                window.hwnd().map_err(|_| "窗口不可用")?.0 as usize,
            )?;
            return Ok(serde_json::Value::Null);
        }
        Action::Poll { id } => sessions.get_mut(&id).ok_or("本地标签已关闭")?.view(),
        Action::Run { id, request, line } => {
            let session = sessions.get_mut(&id).ok_or("本地标签已关闭")?;
            if session.last_request != Some(request) {
                if session.active.is_some() || session.pending_adb.is_some() {
                    return Err("前台进程仍在运行".into());
                }
                session.last_request = Some(request);
                session.message = match session.run(&line, &desktop.2) {
                    Ok(message) => message,
                    Err(error) => Some(error),
                };
            }
            session.view()
        }
        Action::CancelAdb { id, request } => {
            if let Some(session) = sessions.get_mut(&id)
                && session
                    .pending_adb
                    .as_ref()
                    .is_some_and(|(pending, _)| *pending == request)
            {
                session.pending_adb = None;
            }
            return Ok(serde_json::Value::Null);
        }
        Action::RunAdb {
            id,
            request,
            target,
        } => {
            let session = sessions.get_mut(&id).ok_or("本地标签已关闭")?;
            if session.last_request == Some(request) {
                session.view()
            } else {
                if session.active.is_some()
                    || !session
                        .pending_adb
                        .as_ref()
                        .is_some_and(|(pending, plan)| *pending == request && plan.is_some())
                {
                    return Err("本次 ADB 启动已失效".into());
                }
                let (_, plan) = session.pending_adb.take().unwrap();
                let plan = plan.unwrap();
                if adb::read(&desktop.2)?.revision != Some(plan.revision) {
                    return Err("快捷指令已更新，本次任务未开始".into());
                }
                let (process, command) = match plan.plan {
                    ShortcutPlan::Adb(plan) => {
                        let (image, args, command) = plan.bind(target.as_deref())?;
                        (
                            Process::start(&image, &args, &session.cwd, session.cols, session.rows)
                                .map(Foreground::Console),
                            command,
                        )
                    }
                    ShortcutPlan::Batch(plan) => {
                        let plan = plan.bind(target.as_deref())?;
                        (
                            batch::Process::start(plan, &session.cwd, session.cols, session.rows)
                                .map(Foreground::Batch),
                            "本地命令组".into(),
                        )
                    }
                };
                session.last_request = Some(request);
                session.interrupted = false;
                session.close_on_success = plan.close_on_success;
                match process {
                    Ok(process) => session.active = Some(process),
                    Err(error) => {
                        session.close_on_success = false;
                        session.message = Some(format!("本地快捷指令启动失败：{error}"));
                    }
                };
                let mut view = session.view();
                view.command = Some(command);
                view
            }
        }
        Action::Input { id, request, text } => {
            let session = sessions.get_mut(&id).ok_or("本地标签已关闭")?;
            if session.last_request != Some(request) || text.len() > MAX_INPUT {
                return Err("本次输入的前台任务已变化或超过输入上限".into());
            }
            session
                .active
                .as_ref()
                .ok_or("前台进程已退出")?
                .input(text.as_bytes().to_vec())?;
            session.interrupted |= text == "\u{3}";
            return Ok(serde_json::Value::Null);
        }
        Action::Resize { id, cols, rows } => {
            let session = sessions.get_mut(&id).ok_or("本地标签已关闭")?;
            session.cols = cols;
            session.rows = rows;
            match &session.active {
                Some(Foreground::Console(process)) => process.resize(cols, rows),
                Some(Foreground::Batch(process)) => process.resize(cols, rows),
                None => {}
            }
            return Ok(serde_json::Value::Null);
        }
        Action::FileDropEpoch { .. } | Action::FileDrop { .. } => unreachable!(),
    };
    serde_json::to_value(view).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn local_adb_settings(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    settings: Option<adb::Settings>,
) -> Result<adb::Settings, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("ADB 设置仅在主窗口可用".into());
    }
    let root = desktop.2.clone();
    let changed = settings.is_some();
    let result = tauri::async_runtime::spawn_blocking(move || match settings {
        Some(settings) => adb::save(&root, settings),
        None => adb::read(&root),
    })
    .await
    .map_err(|_| "ADB 设置任务已结束")??;
    if changed {
        let _ = window.emit("local-shortcuts-changed", result.revision);
    }
    Ok(result)
}

#[derive(Serialize)]
pub struct ShortcutText {
    text: String,
    append_enter: bool,
}

#[tauri::command]
pub async fn local_shortcut_text(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    request: ScriptRequest,
) -> Result<ShortcutText, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("发送快捷指令仅在主窗口可用".into());
    }
    let root = desktop.2.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = adb::read(&root)?;
        if settings.revision != Some(request.revision) {
            return Err("快捷指令已更新，请重新选择".into());
        }
        let item = settings
            .shortcuts
            .into_iter()
            .find(|item| {
                item.id == request.button && item.desktop_kind == Some(adb::DesktopKind::Send)
            })
            .ok_or("此入口不是会话发送指令")?;
        Ok(ShortcutText {
            text: item.command,
            append_enter: item.append_enter,
        })
    })
    .await
    .map_err(|_| "快捷指令读取已结束")?
}

#[derive(Serialize)]
pub struct AdbChoice {
    devices: Vec<adb::Device>,
    select: bool,
    inherited_target: Option<String>,
    diagnostic: adb::Diagnostic,
}

#[tauri::command]
pub async fn prepare_local_adb(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    id: Uuid,
    request: Uuid,
    button: Uuid,
    revision: Uuid,
) -> Result<AdbChoice, String> {
    if window.label() != crate::session_windows::MAIN {
        return Err("ADB 按钮仅在主窗口可用".into());
    }
    let app = window.app_handle().clone();
    let root = desktop.2.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Terminals>();
        let cwd = {
            let mut sessions = state.0.lock().unwrap();
            let session = sessions.get_mut(&id).ok_or("结果标签已关闭")?;
            if session.active.is_some()
                || session.pending_adb.is_some()
                || session.last_request == Some(request)
            {
                return Err("此标签已有前台任务".into());
            }
            session.pending_adb = Some((request, None));
            session.cwd.clone()
        };
        let mut diagnostic = adb::Diagnostic::default();
        let prepared = (|| {
            let settings = adb::read(&root)?;
            if settings.revision != Some(revision) {
                return Err("按钮配置已更新，请重新读取按钮后再次点击".into());
            }
            let shortcut = settings
                .shortcuts
                .iter()
                .find(|item| item.id == button)
                .ok_or("按钮已移除")?;
            let executable = settings.executable.as_deref();
            let plan = match shortcut.desktop_kind {
                Some(adb::DesktopKind::Local) => ShortcutPlan::Batch(batch::prepare(
                    &shortcut.command,
                    &cwd,
                    executable,
                    &mut diagnostic,
                )?),
                None if shortcut.script_path.is_none() => ShortcutPlan::Adb(adb::prepare(
                    &shortcut.command,
                    &cwd,
                    executable,
                    &mut diagnostic,
                )?),
                _ => return Err("此入口不执行本地命令".into()),
            };
            Ok(PreparedShortcut {
                plan,
                revision,
                close_on_success: shortcut.close_on_success,
            })
        })();
        let mut sessions = state.0.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("结果标签已关闭")?;
        if !session
            .pending_adb
            .as_ref()
            .is_some_and(|(pending, _)| *pending == request)
        {
            return Err("本次 ADB 操作已取消".into());
        }
        session.pending_adb = None;
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                diagnostic.error = Some(error);
                return Ok(AdbChoice {
                    devices: Vec::new(),
                    select: false,
                    inherited_target: None,
                    diagnostic,
                });
            }
        };
        let (devices, select, inherited_target) = match &prepared.plan {
            ShortcutPlan::Adb(plan) => (
                plan.devices.clone(),
                plan.select,
                plan.inherited_target.clone(),
            ),
            ShortcutPlan::Batch(plan) => (
                plan.devices.clone(),
                plan.fixed.is_none() && !plan.devices.is_empty(),
                plan.fixed.clone(),
            ),
        };
        let choice = AdbChoice {
            devices,
            select,
            inherited_target,
            diagnostic,
        };
        session.pending_adb = Some((request, Some(prepared)));
        Ok(choice)
    })
    .await
    .map_err(|_| "ADB 枚举任务已结束")?
}
