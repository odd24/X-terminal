use super::{MAX_LINE, arguments, conpty::quote, executable};
use credential_vault::{Error, Secret, Vault};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env,
    fs::OpenOptions,
    io::Read,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use windows_sys::Win32::{
    Storage::FileSystem::{FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT},
    System::Threading::CREATE_NO_WINDOW,
};

const STORE: &str = "desktop-local-adb-v1.db";
const ENTRY: Uuid = Uuid::from_u128(0x2a329f3b_a966_49f4_ac7e_24372a4d2670);
const SHORTCUTS_ENTRY: Uuid = Uuid::from_u128(0x2099a5f3_5274_48f3_b80c_7290d5004e88);
const MANAGED_ENTRY: Uuid = Uuid::from_u128(0x95667a60_818d_47c2_a5ff_284e49ae4e62);
const INVENTORY_LIMIT: usize = 64 * 1024;
const STORAGE: &str = "ADB 快捷设置读取或写入失败";
const MAX_SHORTCUTS: usize = 32;

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub revision: Option<Uuid>,
    pub executable: Option<String>,
    pub shortcuts: Vec<Shortcut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Layout>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    columns: u8,
    expanded: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Shortcut {
    pub id: Uuid,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_path: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}

fn adb_name(name: &str) -> bool {
    Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("adb") || name.eq_ignore_ascii_case("adb.exe")
        })
}

fn validate(settings: &Settings) -> Result<(), String> {
    if settings.shortcuts.len() > MAX_SHORTCUTS {
        return Err("最多保存 32 条快捷指令".into());
    }
    if settings
        .layout
        .as_ref()
        .is_some_and(|layout| !matches!(layout.columns, 1 | 2))
    {
        return Err("请选择单列或双列".into());
    }
    if let Some(path) = &settings.executable
        && (path.len() > 2048
            || !Path::new(path).is_absolute()
            || !adb_name(path)
            || !Path::new(path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe")))
    {
        return Err("请填写现有 adb.exe 的绝对路径，或留空使用 PATH".into());
    }
    let mut ids = HashSet::new();
    for button in &settings.shortcuts {
        if button.id.is_nil()
            || !ids.insert(button.id)
            || button.name.trim().is_empty()
            || button.name.chars().any(char::is_control)
            || button.name.chars().count() > 64
            || button.command.len() > MAX_LINE
        {
            return Err("请检查按钮名称、命令长度及编号".into());
        }
        if let Some(path) = &button.script_path {
            if !button.command.is_empty() || !super::scripts::valid_path(path) {
                return Err("请选择本机 .bat 或 .cmd 脚本".into());
            }
            continue;
        }
        let args = arguments(&button.command)?;
        if args.len() < 2 || !adb_name(&args[0]) {
            return Err("按钮需要一条完整的 adb 命令".into());
        }
    }
    Ok(())
}

fn read_store(vault: Option<&mut Vault>) -> Result<Settings, String> {
    let Some(vault) = vault else {
        return Ok(Settings::default());
    };
    let mut item = vault.get(MANAGED_ENTRY);
    for entry in [SHORTCUTS_ENTRY, ENTRY] {
        if !matches!(item, Err(Error::NotFound)) {
            break;
        }
        item = vault.get(entry);
    }
    match item {
        Ok(value) => serde_json::from_slice(value.expose()).map_err(|_| STORAGE.into()),
        Err(Error::NotFound) => Ok(Settings::default()),
        Err(_) => Err(STORAGE.into()),
    }
}

pub fn read(root: &Path) -> Result<Settings, String> {
    crate::log_viewer::with_native_settings(root, STORE, false, read_store)
        .map_err(|_| STORAGE.into())
}

pub fn save(root: &Path, mut settings: Settings) -> Result<Settings, String> {
    validate(&settings)?;
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root.join("desktop-local-adb-v1.lock"))
        .map_err(|_| STORAGE)?;
    let meta = lock.metadata().map_err(|_| STORAGE)?;
    if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(STORAGE.into());
    }
    crate::log_viewer::with_native_settings(root, STORE, true, |vault| {
        let vault = vault.ok_or(STORAGE)?;
        let current = read_store(Some(vault))?;
        if current.revision != settings.revision {
            return Err("ADB 快捷设置已更新，请重新读取后保存".into());
        }
        if settings.executable != current.executable
            && settings
                .executable
                .as_ref()
                .is_some_and(|path| !Path::new(path).is_file())
        {
            return Err("请填写现有 adb.exe 的绝对路径，或留空使用 PATH".into());
        }
        settings.shortcuts.sort_by_key(|shortcut| !shortcut.pinned);
        settings.revision = Some(Uuid::new_v4());
        let bytes = serde_json::to_vec(&settings).map_err(|_| STORAGE)?;
        let secret = Secret::new(bytes).map_err(|_| "ADB 快捷设置超过 64 KiB")?;
        vault.set(MANAGED_ENTRY, secret).map_err(|_| STORAGE)?;
        Ok(settings)
    })
}

pub fn resolve(program: &str, cwd: &Path, root: &Path) -> Result<PathBuf, String> {
    if adb_name(program) && Path::new(program).components().count() == 1 {
        let settings = read(root)?;
        return executable(settings.executable.as_deref().unwrap_or(program), cwd);
    }
    executable(program, cwd)
}

#[derive(Clone, Serialize)]
pub struct Device {
    pub serial: String,
    pub state: String,
}

#[derive(Default, Serialize)]
pub struct Diagnostic {
    pub image: Option<String>,
    pub enumeration: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub environment: Vec<(String, String)>,
    pub error: Option<String>,
}

pub struct Prepared {
    pub image: PathBuf,
    args: Vec<String>,
    insert: usize,
    pub devices: Vec<Device>,
    pub select: bool,
    pub inherited_target: Option<String>,
}

impl Prepared {
    pub fn bind(self, target: Option<&str>) -> Result<(PathBuf, Vec<String>, String), String> {
        let mut args = self.args;
        if self.select {
            let target = target
                .filter(|serial| {
                    self.devices
                        .iter()
                        .any(|device| device.serial == *serial && device.state == "device")
                })
                .ok_or("请选择本次枚举的可用设备")?;
            args.splice(self.insert..self.insert, ["-s".into(), target.into()]);
        }
        let display = std::iter::once(quote(&self.image.to_string_lossy()))
            .chain(args.iter().map(|arg| quote(arg)))
            .collect::<Vec<_>>()
            .join(" ");
        Ok((self.image, args, display))
    }
}

fn device_command(args: &[String]) -> Option<usize> {
    let mut i = 0;
    while let Some(option) = args.get(i) {
        match option.as_str() {
            "-H" | "-P" | "-L" => {
                args.get(i + 1)?;
                i += 2;
            }
            "shell" | "pull" | "push" | "logcat" => return Some(i),
            _ => return None,
        }
    }
    None
}

fn capture(mut stream: impl Read) -> Vec<u8> {
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(count @ 1..) = stream.read(&mut buffer) {
        if retained.len() <= INVENTORY_LIMIT {
            retained.extend_from_slice(&buffer[..count]);
        }
    }
    retained
}

fn observed(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut preview: String = text.chars().take(8192).collect();
    if preview.len() < text.len() {
        preview.push_str("\n…");
    }
    preview
}

fn inventory(
    image: &Path,
    cwd: &Path,
    global: &[String],
    diagnostic: &mut Diagnostic,
) -> Result<Vec<Device>, String> {
    diagnostic.enumeration = Some(
        global
            .iter()
            .map(|arg| quote(arg))
            .chain(["devices".into(), "-l".into()])
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut child = Command::new(image)
        .args(global)
        .args(["devices", "-l"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("ADB 枚举启动失败：{error}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = out_tx.send(capture(stdout));
    });
    thread::spawn(move || {
        let _ = err_tx.send(capture(stderr));
    });
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("ADB 枚举超时或读取失败");
            }
        }
    };
    let bytes = out_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    let errors = err_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    if let Ok(bytes) = &bytes {
        diagnostic.stdout = observed(bytes);
    }
    if let Ok(errors) = &errors {
        diagnostic.stderr = observed(errors);
    }
    let status = status?;
    if !status.success() {
        return Err(format!("ADB 枚举失败（{status}）"));
    }
    let bytes = bytes.map_err(|_| "ADB 枚举输出未结束")?;
    if bytes.len() > INVENTORY_LIMIT {
        return Err("ADB 设备列表超过读取上限".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "ADB 设备列表编码无效")?;
    parse_inventory(text)
}

fn parse_inventory(text: &str) -> Result<Vec<Device>, String> {
    let mut started = false;
    let mut devices = Vec::new();
    let mut serials = HashSet::new();
    for line in text.lines() {
        if line.trim() == "List of devices attached" {
            started = true;
            continue;
        }
        if !started || line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split_ascii_whitespace();
        let (Some(serial), Some(state)) = (fields.next(), fields.next()) else {
            return Err("ADB 设备列表行缺少设备或状态".into());
        };
        if serial.len() > 256
            || serial.chars().any(char::is_control)
            || state.len() > 32
            || state.chars().any(char::is_control)
            || !serials.insert(serial)
        {
            return Err("ADB 设备列表含无效或重复的设备标识".into());
        }
        devices.push(Device {
            serial: serial.into(),
            state: state.into(),
        });
    }
    if !started || devices.len() > 128 {
        return Err("ADB 设备列表格式无效或设备过多".into());
    }
    Ok(devices)
}

pub fn prepare(
    line: &str,
    cwd: &Path,
    preferred_image: Option<&str>,
    diagnostic: &mut Diagnostic,
) -> Result<Prepared, String> {
    let mut args = arguments(line)?;
    if args.len() < 2 || !adb_name(&args[0]) {
        return Err("按钮需要一条完整的 adb 命令".into());
    }
    let program = args.remove(0);
    let chosen_image = if Path::new(&program).components().count() == 1 {
        preferred_image.unwrap_or(&program)
    } else {
        &program
    };
    diagnostic.image = Some(chosen_image.into());
    diagnostic.environment = [
        "ANDROID_SERIAL",
        "ADB_SERVER_SOCKET",
        "ANDROID_ADB_SERVER_ADDRESS",
        "ANDROID_ADB_SERVER_PORT",
    ]
    .into_iter()
    .filter_map(|key| {
        env::var(key)
            .ok()
            .map(|value| (key.into(), observed(value.as_bytes())))
    })
    .collect();
    let image = executable(chosen_image, cwd)?;
    diagnostic.image = Some(image.display().to_string());
    let insert = device_command(&args);
    let inherited_target = insert
        .and_then(|_| env::var("ANDROID_SERIAL").ok())
        .filter(|value| !value.is_empty());
    let select = insert.is_some() && inherited_target.is_none();
    let insert = insert.unwrap_or(0);
    let devices = if select {
        inventory(&image, cwd, &args[..insert], diagnostic)?
    } else {
        Vec::new()
    };
    if select && !devices.iter().any(|device| device.state == "device") {
        let states = devices
            .iter()
            .map(|device| format!("{} ({})", device.serial, device.state))
            .collect::<Vec<_>>()
            .join("、");
        return Err(if states.is_empty() {
            "ADB 未发现设备".into()
        } else {
            format!("ADB 无可用设备：{states}")
        });
    }
    Ok(Prepared {
        image,
        args,
        insert,
        devices,
        select,
        inherited_target,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_inventory;

    #[test]
    fn inventory_accepts_spaces_tabs_and_the_empty_header() {
        let devices = parse_inventory(
            "List of devices attached\r\nfirst       device product:fixture\r\nsecond\toffline\r\n",
        )
        .unwrap();
        assert_eq!(
            (devices[0].serial.as_str(), devices[0].state.as_str()),
            ("first", "device")
        );
        assert_eq!(
            (devices[1].serial.as_str(), devices[1].state.as_str()),
            ("second", "offline")
        );
        assert!(
            parse_inventory("List of devices attached\r\n\r\n")
                .unwrap()
                .is_empty()
        );
        assert!(parse_inventory("error: unknown server\r\n").is_err());
        assert!(parse_inventory("List of devices attached\r\nbroken\r\n").is_err());
        assert!(
            parse_inventory("List of devices attached\r\nfirst\tdevice\nfirst device").is_err()
        );
    }
}
