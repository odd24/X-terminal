#![windows_subsystem = "windows"]
use std::{fs::OpenOptions, io::Write, path::PathBuf};

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let [image, supplied] = args.as_slice() else {
        return;
    };
    let log = PathBuf::from(supplied);
    if !log.is_absolute() || log.extension().is_none_or(|ext| ext != "log") || !log.is_file() {
        return;
    }
    let Some(logs) = log.parent() else { return };
    let Some(root) = logs.parent() else { return };
    let legacy = logs.file_name().is_some_and(|name| name == "logs")
        && root.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .starts_with("shared-terminal-log-viewer-ui-中文-")
        });
    let location = logs
        .file_name()
        .is_some_and(|name| name == "目录 A" || name == "目录 B")
        && root.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .starts_with("shared-terminal-log-location-中文-")
        });
    if (!legacy && !location)
        || root.parent().and_then(|path| path.canonicalize().ok())
            != std::env::temp_dir().canonicalize().ok()
    {
        return;
    }
    let image = PathBuf::from(image);
    let mut out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("program-trace.tsv"))
        .expect("owned trace");
    writeln!(
        out,
        "1\t{}\t{}",
        image.file_name().unwrap().to_string_lossy(),
        log.display()
    )
    .unwrap();
}
