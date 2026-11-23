use super::{MAX_LINE, adb, arguments, executable};
use std::{
    env,
    path::{Path, PathBuf},
};

mod process;
pub(super) use process::Process;

struct Stage {
    image: PathBuf,
    args: Vec<String>,
    device: bool,
    root: bool,
}

impl Stage {
    fn bound_args(&self, serial: Option<&str>) -> std::io::Result<Vec<String>> {
        let mut args = Vec::new();
        if self.device {
            let serial = serial.ok_or(std::io::Error::other("missing fixed ADB device"))?;
            args.extend(["-s".into(), serial.into()]);
        }
        args.extend(self.args.iter().cloned());
        Ok(args)
    }
}

pub(super) struct Prepared {
    steps: Vec<Vec<Stage>>,
    pub devices: Vec<adb::Device>,
    pub fixed: Option<String>,
}

pub(super) struct Plan {
    steps: Vec<Vec<Stage>>,
    serial: Option<String>,
}

pub(super) fn parse(text: &str) -> Result<Vec<Vec<Vec<String>>>, String> {
    if text.len() > MAX_LINE {
        return Err("本地命令超过 8192 字节".into());
    }
    let mut steps = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let (mut quoted, mut slashes, mut start) = (false, 0, 0);
        let mut stages = Vec::new();
        for (index, character) in line.char_indices() {
            if character == '"' && slashes % 2 == 0 {
                quoted = !quoted;
            }
            if character == '|' && !quoted {
                stages.push(arguments(&line[start..index])?);
                start = index + 1;
            }
            slashes = if character == '\\' { slashes + 1 } else { 0 };
        }
        stages.push(arguments(&line[start..])?);
        if stages.len() > 4 || stages.iter().any(Vec::is_empty) {
            return Err("每步需要一至四个非空程序，请检查管道符".into());
        }
        steps.push(stages);
    }
    if !(1..=16).contains(&steps.len()) {
        return Err("请输入一至十六个非空步骤".into());
    }
    Ok(steps)
}

fn powershell() -> Result<PathBuf, String> {
    Ok(
        PathBuf::from(env::var_os("SystemRoot").ok_or("找不到 Windows 系统目录")?)
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
    )
}

pub(super) fn prepare(
    text: &str,
    cwd: &Path,
    configured: Option<&str>,
    diagnostic: &mut adb::Diagnostic,
) -> Result<Prepared, String> {
    let mut steps = Vec::new();
    let mut adb_image: Option<PathBuf> = None;
    let mut selected: Option<String> = None;
    let mut needs_device = false;
    for parts in parse(text)? {
        let mut step = Vec::new();
        let stages = parts.len();
        for mut args in parts {
            let program = args.remove(0);
            let mut device = false;
            let mut root = false;
            let image = if adb::adb_name(&program) {
                let path = if Path::new(&program).components().count() == 1 {
                    configured.unwrap_or(&program)
                } else {
                    &program
                };
                let image = executable(path, cwd)?;
                if adb_image
                    .as_ref()
                    .is_some_and(|previous| previous != &image)
                {
                    return Err("整组 ADB 步骤须使用同一个 adb.exe".into());
                }
                adb_image = Some(image.clone());
                if args.first().is_some_and(|arg| arg == "-s") {
                    if args.len() < 3
                        || args[1].is_empty()
                        || args[1].starts_with('-')
                        || selected.as_ref().is_some_and(|serial| serial != &args[1])
                    {
                        return Err("整组 ADB 步骤须指定同一个有效设备".into());
                    }
                    selected = Some(args[1].clone());
                    args.drain(..2);
                }
                match args.first().map(String::as_str) {
                    Some("devices" | "version") => {}
                    Some("root" | "shell" | "logcat" | "pull" | "push" | "reboot" | "get-state") => device = true,
                    _ => return Err("组命令中的 ADB 仅支持 devices、version、root、shell、logcat、pull、push、reboot、get-state 与一致的 -s".into()),
                }
                needs_device |= device;
                root = args[0] == "root";
                if root && (stages != 1 || args.len() != 1) {
                    return Err("adb root 必须为独立步骤".into());
                }
                image
            } else if program.eq_ignore_ascii_case("select-string") {
                let pattern = match args.as_slice() {
                    [pattern] if !pattern.starts_with('-') => pattern,
                    [option, pattern] if option.eq_ignore_ascii_case("-simplematch") => pattern,
                    _ => return Err("Select-String 只接受一个字面模式，可加 -SimpleMatch".into()),
                };
                let escaped = pattern.replace('\'', "''");
                args = vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    format!(
                        "$ErrorActionPreference='Stop'; $input | Select-String -SimpleMatch -Pattern '{escaped}'"
                    ),
                ];
                powershell()?
            } else {
                executable(&program, cwd).map_err(|error| {
                    if program.eq_ignore_ascii_case("grep")
                        || program.eq_ignore_ascii_case("grep.exe")
                    {
                        format!(
                            "{error}。grep 需要安装在 Windows 本机；也可用 | Select-String power"
                        )
                    } else {
                        error
                    }
                })?
            };
            step.push(Stage {
                image,
                args,
                device,
                root,
            });
        }
        steps.push(step);
    }
    let mut devices = Vec::new();
    if let Some(image) = adb_image {
        diagnostic.image = Some(image.display().to_string());
        if needs_device {
            let inherited = env::var("ANDROID_SERIAL")
                .ok()
                .filter(|serial| !serial.is_empty());
            if selected.is_none() {
                selected = inherited;
            }
            devices = adb::inventory(&image, cwd, &[], diagnostic)?;
            if !devices.iter().any(|device| {
                device.state == "device"
                    && selected
                        .as_ref()
                        .is_none_or(|serial| &device.serial == serial)
            }) {
                return Err("组命令找不到原指定的可用 ADB 设备".into());
            }
        } else {
            selected = None;
        }
    }
    Ok(Prepared {
        steps,
        devices,
        fixed: selected,
    })
}

impl Prepared {
    pub fn bind(self, target: Option<&str>) -> Result<Plan, String> {
        if self.devices.is_empty() {
            return Ok(Plan {
                steps: self.steps,
                serial: None,
            });
        }
        let serial = self
            .fixed
            .as_deref()
            .or(target)
            .filter(|serial| {
                self.devices
                    .iter()
                    .any(|device| device.serial == *serial && device.state == "device")
            })
            .ok_or("请选择本次枚举的可用设备")?
            .to_owned();
        Ok(Plan {
            steps: self.steps,
            serial: Some(serial),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn keeps_quoted_pipe_remote_and_splits_only_unquoted_pipe() {
        let steps = parse("adb root\r\nadb shell \"dmesg -w | cat\"|grep power").unwrap();
        assert_eq!(steps[0][0], ["adb", "root"]);
        assert_eq!(steps[1][0], ["adb", "shell", "dmesg -w | cat"]);
        assert_eq!(steps[1][1], ["grep", "power"]);
        assert!(parse("adb devices || grep device").is_err());
        assert!(parse("adb devices > out").is_err());
        assert!(parse("adb shell \"unterminated").is_err());
    }
}
