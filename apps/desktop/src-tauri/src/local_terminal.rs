mod adb;
mod conpty;

use conpty::Process;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State, WebviewWindow};
use uuid::Uuid;

const MAX_SESSIONS: usize = 16;
const MAX_LINE: usize = 8192;
const MAX_INPUT: usize = 16384;

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<Uuid, Session>>);

struct Session {
    cwd: PathBuf,
    drives: HashMap<String, PathBuf>,
    active: Option<Process>,
    last_request: Option<Uuid>,
    message: Option<String>,
    interrupted: bool,
    pending_adb: Option<(Uuid, Option<adb::Prepared>)>,
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
struct View {
    cwd: String,
    task: Option<Uuid>,
    running: bool,
    bytes: Vec<u8>,
    overflow: bool,
    message: Option<String>,
    command: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Open {
        id: Uuid,
        inherit: Option<Uuid>,
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
    Resize {
        id: Uuid,
        cols: u16,
        rows: u16,
    },
    Close {
        id: Uuid,
    },
    CloseAll,
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
                self.active = Some(
                    Process::start(&executable, argv, &self.cwd, self.cols, self.rows)
                        .map_err(|error| format!("{program} 启动失败：{error}"))?,
                );
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
                let mut output = process.output.lock().unwrap();
                std::mem::take(&mut *output)
            })
            .unwrap_or_default();
        if let Some(code) = output.exit.take() {
            self.active.take();
            self.message = Some(match (self.interrupted, code) {
                (true, 0xc000013a | 130) => "已中断（Ctrl+C）".into(),
                (true, code) => format!("前台进程退出（{code}，已发送 Ctrl+C）"),
                (false, code) => format!("前台进程退出（{code}）"),
            });
        }
        View {
            cwd: self.cwd.display().to_string(),
            task: self.last_request,
            running: self.active.is_some(),
            bytes: output.bytes,
            overflow: output.overflow,
            message: self.message.take(),
            command: None,
        }
    }
}

impl Terminals {
    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.0.lock().unwrap());
        drop(sessions);
    }
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
    let mut sessions = state.0.lock().unwrap();
    let view = match action {
        Action::Open { id, inherit } => {
            if sessions.contains_key(&id) || sessions.len() == MAX_SESSIONS {
                return Err("本地标签已存在或达到上限".into());
            }
            let cwd = if let Some(source) = inherit {
                sessions.get(&source).ok_or("发起标签已关闭")?.cwd.clone()
            } else {
                env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
                    .ok_or("无法定位当前用户的主目录")?
            };
            let mut session = Session {
                cwd,
                drives: HashMap::new(),
                active: None,
                last_request: None,
                message: None,
                interrupted: false,
                pending_adb: None,
                cols: 80,
                rows: 24,
            };
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
                let (image, args, command) = plan.unwrap().bind(target.as_deref())?;
                session.last_request = Some(request);
                session.interrupted = false;
                match Process::start(&image, &args, &session.cwd, session.cols, session.rows) {
                    Ok(process) => session.active = Some(process),
                    Err(error) => session.message = Some(format!("ADB 启动失败：{error}")),
                }
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
            if let Some(process) = &session.active {
                process.resize(cols, rows);
            }
            return Ok(serde_json::Value::Null);
        }
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
    tauri::async_runtime::spawn_blocking(move || match settings {
        Some(settings) => adb::save(&root, settings),
        None => adb::read(&root),
    })
    .await
    .map_err(|_| "ADB 设置任务已结束")?
}

#[derive(Serialize)]
pub struct AdbChoice {
    devices: Vec<adb::Device>,
    select: bool,
    inherited_target: Option<String>,
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
            adb::prepare(&shortcut.command, &cwd, settings.executable.as_deref())
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
        let prepared = prepared?;
        let choice = AdbChoice {
            devices: prepared.devices.clone(),
            select: prepared.select,
            inherited_target: prepared.inherited_target.clone(),
        };
        session.pending_adb = Some((request, Some(prepared)));
        Ok(choice)
    })
    .await
    .map_err(|_| "ADB 枚举任务已结束")?
}
