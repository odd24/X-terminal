use super::{
    adb::{self, Settings, Shortcut},
    scripts,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, State, WebviewWindow};
use uuid::Uuid;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const MANIFEST: &str = "manifest.json";
const MAX_ZIP: usize = 34 * 1024 * 1024;
const MAX_FILES: usize = 128;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_MANIFEST: usize = 512 * 1024;
const INVALID: &str = "快捷指令 ZIP 无效、已损坏或超过限制";
const CHANGED: &str = "快捷指令已变化或预览已失效，请重新预览";
const IO_ERROR: &str = "无法读写快捷指令包或资源文件";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    item: Shortcut,
    script: Option<String>,
    files: BTreeMap<String, String>,
}

struct Package {
    manifest: Manifest,
    payloads: BTreeMap<String, Vec<u8>>,
}

fn digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    Sha256::digest(bytes)
        .iter()
        .flat_map(|byte| {
            [
                char::from(HEX[usize::from(byte >> 4)]),
                char::from(HEX[usize::from(byte & 15)]),
            ]
        })
        .collect()
}

fn safe_name(name: &str) -> bool {
    name.len() <= 512
        && name.split('/').all(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end()
                .to_uppercase();
            let numbered = stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"));
            !part.is_empty()
                && part.encode_utf16().count() <= 100
                && !part.starts_with(' ')
                && !part.ends_with([' ', '.'])
                && !part.contains(['\\', ':', '*', '?', '<', '>', '|', '"', '~'])
                && !part.chars().any(char::is_control)
                && !matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
                )
                && !numbered.is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
        })
}

fn no_case_collision(names: impl Iterator<Item = String>) -> bool {
    let mut paths = HashMap::<String, (String, bool)>::new();
    for name in names {
        for (index, _) in name
            .match_indices('/')
            .chain(std::iter::once((name.len(), "")))
        {
            let part = &name[..index];
            let file = index == name.len();
            let prior = paths
                .entry(part.to_uppercase())
                .or_insert_with(|| (part.into(), file));
            if prior.0 != part || prior.1 != file {
                return false;
            }
        }
    }
    true
}

fn asset(id: Uuid, name: &str) -> String {
    format!("assets/{id}/{name}")
}

fn read_file(path: &Path, limit: usize) -> Result<(PathBuf, Vec<u8>), String> {
    let (file, canonical) =
        crate::config_import::open_local_regular(path, None).map_err(|_| IO_ERROR)?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IO_ERROR)?;
    if bytes.len() > limit {
        return Err(INVALID.into());
    }
    Ok((PathBuf::from(canonical), bytes))
}

fn relative(base: &Path, file: &Path) -> Result<String, String> {
    let name = file
        .strip_prefix(base)
        .ok()
        .and_then(Path::to_str)
        .ok_or("配套文件与脚本必须在同一磁盘")?
        .replace('\\', "/");
    if !safe_name(&name) {
        return Err("文件名或相对目录不适合打包".into());
    }
    Ok(name)
}

fn make_package(
    settings: &Settings,
    ids: Vec<Uuid>,
    include_scripts: bool,
    mut attachments: HashMap<Uuid, Vec<String>>,
) -> Result<Package, String> {
    let selected: HashSet<_> = ids.iter().copied().collect();
    if ids.is_empty() || selected.len() != ids.len() || ids.len() > 32 {
        return Err("请选择要导出的快捷指令".into());
    }
    let mut manifest = Manifest {
        version: 1,
        entries: Vec::new(),
    };
    let mut payloads = BTreeMap::new();
    let mut total = 0;
    for item in settings
        .shortcuts
        .iter()
        .filter(|item| selected.contains(&item.id))
    {
        let mut entry = Entry {
            item: item.clone(),
            script: None,
            files: BTreeMap::new(),
        };
        let extras = attachments.remove(&item.id).unwrap_or_default();
        if let Some(original) = entry.item.script_path.take() {
            entry.script = Some(relative(
                Path::new(&original).parent().ok_or(INVALID)?,
                Path::new(&original),
            )?);
            if include_scripts {
                match scripts::readable(&original) {
                    Ok((file, source)) => {
                        let mut script = Vec::new();
                        file.take(MAX_FILE as u64 + 1)
                            .read_to_end(&mut script)
                            .map_err(|_| IO_ERROR)?;
                        if script.len() > MAX_FILE || payloads.len() + extras.len() + 1 > MAX_FILES
                        {
                            return Err(INVALID.into());
                        }
                        let mut inputs = BTreeMap::from([(source.clone(), script)]);
                        let mut group_total = inputs[&source].len();
                        for extra in extras {
                            let (path, bytes) = read_file(
                                Path::new(&extra),
                                MAX_FILE.min(MAX_BYTES.saturating_sub(total + group_total)),
                            )?;
                            if !inputs.contains_key(&path) {
                                group_total += bytes.len();
                            }
                            inputs.entry(path).or_insert(bytes);
                        }
                        total += group_total;
                        if total > MAX_BYTES {
                            return Err(INVALID.into());
                        }
                        let base = source
                            .ancestors()
                            .skip(1)
                            .find(|base| inputs.keys().all(|file| file.starts_with(base)))
                            .ok_or("配套文件与脚本必须在同一磁盘")?;
                        entry.script = Some(relative(base, &source)?);
                        for (file, bytes) in inputs {
                            let name = relative(base, &file)?;
                            entry.files.insert(name.clone(), digest(&bytes));
                            payloads.insert(asset(item.id, &name), bytes);
                        }
                        if !no_case_collision(entry.files.keys().cloned()) {
                            return Err(INVALID.into());
                        }
                    }
                    Err(_) if extras.is_empty() => {}
                    Err(_) => return Err("脚本不可用，请重新定位后再打包附件".into()),
                }
            } else if !extras.is_empty() {
                return Err(INVALID.into());
            }
        } else if !extras.is_empty() {
            return Err(INVALID.into());
        }
        manifest.entries.push(entry);
    }
    if manifest.entries.len() != ids.len() || !attachments.is_empty() {
        return Err(CHANGED.into());
    }
    Ok(Package { manifest, payloads })
}

fn encode(package: &Package) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let manifest = serde_json::to_vec_pretty(&package.manifest).map_err(|_| INVALID)?;
    if manifest.len() > MAX_MANIFEST {
        return Err(INVALID.into());
    }
    zip.start_file(MANIFEST, options).map_err(|_| IO_ERROR)?;
    zip.write_all(&manifest).map_err(|_| IO_ERROR)?;
    for (name, bytes) in &package.payloads {
        zip.start_file(name, options).map_err(|_| IO_ERROR)?;
        zip.write_all(bytes).map_err(|_| IO_ERROR)?;
    }
    Ok(zip.finish().map_err(|_| IO_ERROR)?.into_inner())
}

fn decode(bytes: &[u8]) -> Result<Package, String> {
    // The bounded format uses a single disk, non-ZIP64 records, and no archive comment.
    let end = bytes
        .get(bytes.len().saturating_sub(22)..)
        .filter(|end| end.len() == 22)
        .ok_or(INVALID)?;
    let word = |at| u16::from_le_bytes([end[at], end[at + 1]]) as usize;
    let count = word(10);
    if &end[..4] != b"PK\x05\x06"
        || word(4) != 0
        || word(6) != 0
        || word(8) != count
        || word(20) != 0
        || count == 0
        || count > MAX_FILES + 1
    {
        return Err(INVALID.into());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| INVALID)?;
    if archive.len() != count {
        return Err(INVALID.into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|_| INVALID)?;
        let name = file.name().to_owned();
        let limit = if name == MANIFEST {
            MAX_MANIFEST
        } else {
            MAX_FILE.min(MAX_BYTES - total)
        };
        if !file.is_file()
            || file.encrypted()
            || !safe_name(&name)
            || file.size() > limit as u64
            || file
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000))
        {
            return Err(INVALID.into());
        }
        let mut data = Vec::new();
        (&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| INVALID)?;
        if data.len() as u64 != file.size() || data.len() > limit {
            return Err(INVALID.into());
        }
        if name != MANIFEST {
            total += data.len();
        }
        if files.insert(name, data).is_some() {
            return Err(INVALID.into());
        }
    }
    let manifest: Manifest =
        serde_json::from_slice(&files.remove(MANIFEST).ok_or(INVALID)?).map_err(|_| INVALID)?;
    if manifest.version != 1 || manifest.entries.is_empty() || manifest.entries.len() > 32 {
        return Err(INVALID.into());
    }
    let mut ids = HashSet::new();
    let mut expected = HashSet::new();
    for entry in &manifest.entries {
        if entry.item.script_path.is_some()
            || !ids.insert(entry.item.id)
            || !no_case_collision(entry.files.keys().cloned())
        {
            return Err(INVALID.into());
        }
        let mut item = entry.item.clone();
        if let Some(script) = &entry.script {
            if !safe_name(script) || (!entry.files.is_empty() && !entry.files.contains_key(script))
            {
                return Err(INVALID.into());
            }
            item.script_path = Some(format!("C:\\Package\\{}", script.replace('/', "\\")));
        } else if !entry.files.is_empty() {
            return Err(INVALID.into());
        }
        let mut settings = Settings {
            shortcuts: vec![item],
            ..Settings::default()
        };
        let original = settings.shortcuts[0].description.clone();
        adb::normalize_descriptions(&mut settings).map_err(|_| INVALID)?;
        if original != settings.shortcuts[0].description {
            return Err(INVALID.into());
        }
        adb::validate(&settings).map_err(|_| INVALID)?;
        for (name, hash) in &entry.files {
            if !safe_name(name) {
                return Err(INVALID.into());
            }
            let key = asset(entry.item.id, name);
            if files.get(&key).is_none_or(|bytes| digest(bytes) != *hash) {
                return Err(INVALID.into());
            }
            expected.insert(key);
        }
    }
    if expected.len() != files.len() {
        return Err(INVALID.into());
    }
    Ok(Package {
        manifest,
        payloads: files,
    })
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    New,
    Same,
    Conflict,
    Missing,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Decision {
    Skip,
    Keep,
    Replace,
}

#[derive(Serialize)]
struct Row {
    item: Shortcut,
    script: Option<String>,
    files: Vec<String>,
    status: Status,
    existing: Vec<Shortcut>,
}

#[derive(Serialize)]
struct Preview {
    token: Uuid,
    rows: Vec<Row>,
}

#[derive(Default, Serialize)]
struct Counts {
    added: usize,
    replaced: usize,
    same: usize,
    skipped: usize,
    missing: usize,
}

#[derive(Default)]
pub(crate) struct Transfers(Mutex<Slots>);
#[derive(Default)]
struct Slots {
    import: Option<Pending>,
    export: Option<Pending>,
}
struct Pending {
    token: Uuid,
    revision: Option<Uuid>,
    package: Package,
}

fn folder(root: &Path, entry: &Entry) -> Result<PathBuf, String> {
    let bytes = serde_json::to_vec(&entry.files).map_err(|_| INVALID)?;
    Ok(root.join("shortcut-assets").join(digest(&bytes)))
}

fn mapped(root: &Path, entry: &Entry) -> Result<Shortcut, String> {
    let mut item = entry.item.clone();
    if let Some(script) = &entry.script {
        item.script_path = Some(
            folder(root, entry)?
                .join(script.replace('/', "\\"))
                .to_str()
                .ok_or(INVALID)?
                .into(),
        );
    }
    Ok(item)
}

fn same(left: &Shortcut, right: &Shortcut) -> bool {
    let mut left = left.clone();
    left.id = right.id;
    left == *right
}

fn verify_resources(target: &Path, entry: &Entry) -> Result<(), String> {
    checked_dir(target)?;
    for (name, hash) in &entry.files {
        let (_, bytes) = read_file(&target.join(name.replace('/', "\\")), MAX_FILE)?;
        if digest(&bytes) != *hash {
            return Err("现有受管资源已变化，导入未保存".into());
        }
    }
    Ok(())
}

fn rows(root: &Path, package: &Package, current: Option<&Settings>) -> Result<Vec<Row>, String> {
    package
        .manifest
        .entries
        .iter()
        .map(|entry| {
            let missing = entry.script.is_some() && entry.files.is_empty();
            let item = mapped(root, entry)?;
            let mut status = if missing {
                Status::Missing
            } else {
                Status::New
            };
            let mut existing = Vec::new();
            if let Some(current) = current.filter(|_| !missing) {
                if current.shortcuts.iter().any(|old| same(old, &item))
                    && (entry.script.is_none()
                        || verify_resources(&folder(root, entry)?, entry).is_ok())
                {
                    status = Status::Same;
                } else {
                    if let Some(old) = current.shortcuts.iter().find(|old| old.id == item.id) {
                        existing.push(old.clone());
                    } else {
                        existing.extend(
                            current
                                .shortcuts
                                .iter()
                                .filter(|old| old.name.eq_ignore_ascii_case(&item.name))
                                .cloned(),
                        );
                    }
                    if !existing.is_empty() {
                        status = Status::Conflict;
                    }
                }
            }
            Ok(Row {
                item: entry.item.clone(),
                script: entry.script.clone(),
                files: entry.files.keys().cloned().collect(),
                status,
                existing,
            })
        })
        .collect()
}

fn checked_dir(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| IO_ERROR)?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err(IO_ERROR.into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct NewFiles {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    committed: bool,
}
impl NewFiles {
    fn directory(&mut self, path: &Path) -> Result<(), String> {
        checked_dir(path.parent().ok_or(IO_ERROR)?)?;
        match fs::create_dir(path) {
            Ok(()) => self.directories.push(path.into()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(IO_ERROR.into()),
        }
        checked_dir(path)
    }

    fn file(&mut self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(|_| IO_ERROR)?;
        self.files.push(path.into());
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| IO_ERROR.into())
    }

    fn install(&mut self, root: &Path, entry: &Entry, package: &Package) -> Result<(), String> {
        checked_dir(root)?;
        let target = folder(root, entry)?;
        let base = target.parent().ok_or(IO_ERROR)?;
        self.directory(base)?;
        match fs::symlink_metadata(&target) {
            Ok(_) => verify_resources(&target, entry)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let stage = base.join(format!(".incoming-{}", Uuid::new_v4()));
                fs::create_dir(&stage).map_err(|_| IO_ERROR)?;
                let mut group = NewFiles::default();
                group.directories.push(stage.clone());
                checked_dir(&stage)?;
                for name in entry.files.keys() {
                    let relative = PathBuf::from(name.replace('/', "\\"));
                    let mut parent = stage.clone();
                    for part in relative.parent().ok_or(INVALID)?.components() {
                        parent.push(part);
                        group.directory(&parent)?;
                    }
                    group.file(
                        &stage.join(relative),
                        package
                            .payloads
                            .get(&asset(entry.item.id, name))
                            .ok_or(INVALID)?,
                    )?;
                }
                let relocate = |paths: &[PathBuf]| {
                    paths
                        .iter()
                        .map(|path| {
                            path.strip_prefix(&stage)
                                .map(|suffix| {
                                    if suffix.as_os_str().is_empty() {
                                        target.clone()
                                    } else {
                                        target.join(suffix)
                                    }
                                })
                                .map_err(|_| IO_ERROR)
                        })
                        .collect::<Result<Vec<_>, _>>()
                };
                let files = relocate(&group.files)?;
                let directories = relocate(&group.directories)?;
                if !move_new(&stage, &target) {
                    return Err(IO_ERROR.into());
                }
                group.committed = true;
                self.files.extend(files);
                self.directories.extend(directories);
            }
            Err(_) => return Err(IO_ERROR.into()),
        }
        Ok(())
    }
}
impl Drop for NewFiles {
    fn drop(&mut self) {
        if !self.committed {
            for file in self.files.iter().rev() {
                let _ = fs::remove_file(file);
            }
            for dir in self.directories.iter().rev() {
                let _ = fs::remove_dir(dir);
            }
        }
    }
}

fn apply(
    root: &Path,
    pending: Pending,
    decisions: HashMap<Uuid, Decision>,
) -> Result<Counts, String> {
    let mut current = adb::read(root)?;
    if current.revision != pending.revision {
        return Err(CHANGED.into());
    }
    let classifications = rows(root, &pending.package, Some(&current))?;
    if decisions.keys().any(|id| {
        !classifications
            .iter()
            .any(|row| row.status == Status::Conflict && row.item.id == *id)
    }) {
        return Err(CHANGED.into());
    }
    let mut replaced = HashSet::new();
    let mut counts = Counts::default();
    let mut resources = Vec::new();
    for (entry, row) in pending.package.manifest.entries.iter().zip(classifications) {
        let mut item = mapped(root, entry)?;
        if row.status == Status::New && current.shortcuts.iter().any(|old| same(old, &item)) {
            counts.same += 1;
            continue;
        }
        match row.status {
            Status::New => {
                current.shortcuts.push(item);
                counts.added += 1;
            }
            Status::Same => {
                counts.same += 1;
                continue;
            }
            Status::Missing => {
                counts.missing += 1;
                continue;
            }
            Status::Conflict => match decisions
                .get(&entry.item.id)
                .copied()
                .unwrap_or(Decision::Skip)
            {
                Decision::Skip => {
                    counts.skipped += 1;
                    continue;
                }
                Decision::Keep => {
                    item.id = Uuid::new_v4();
                    current.shortcuts.push(item);
                    counts.added += 1;
                }
                Decision::Replace => {
                    let [old] = row.existing.as_slice() else {
                        return Err("存在多个同名指令，请跳过或保留两份".into());
                    };
                    if !replaced.insert(old.id) {
                        return Err("本次不能重复替换同一条指令".into());
                    }
                    let index = current
                        .shortcuts
                        .iter()
                        .position(|item| item.id == old.id)
                        .ok_or(CHANGED)?;
                    item.id = old.id;
                    if item.pinned == old.pinned {
                        current.shortcuts[index] = item;
                    } else {
                        current.shortcuts.remove(index);
                        current.shortcuts.push(item);
                    }
                    counts.replaced += 1;
                }
            },
        }
        if entry.script.is_some() {
            resources.push(entry);
        }
    }
    if counts.added + counts.replaced != 0 {
        let mut transaction = NewFiles::default();
        adb::validate(&current)?;
        for entry in resources {
            transaction.install(root, entry, &pending.package)?;
        }
        adb::save(root, current)?;
        transaction.committed = true;
    }
    Ok(counts)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Action {
    PreviewExport {
        revision: Option<Uuid>,
        ids: Vec<Uuid>,
        include_scripts: bool,
        attachments: HashMap<Uuid, Vec<String>>,
    },
    WriteExport {
        token: Uuid,
        path: String,
    },
    PreviewImport {
        path: String,
    },
    ApplyImport {
        token: Uuid,
        decisions: HashMap<Uuid, Decision>,
    },
    Cancel {
        token: Uuid,
    },
}

fn save_archive(path: &Path, data: &[u8]) -> Result<(), String> {
    if crate::config_import::validate_local_path(path, Some("zip")).is_err()
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !safe_name(name))
    {
        return Err("请选择有效的本机 ZIP 路径".into());
    }
    let parent = path.parent().ok_or(IO_ERROR)?;
    checked_dir(parent)?;
    let temp = parent.join(format!(".shortcut-{}.tmp", Uuid::new_v4()));
    let mut transaction = NewFiles::default();
    transaction.file(&temp, data)?;
    if !move_new(&temp, path) {
        return Err("无法保存 ZIP，请选择一个尚不存在的文件名".into());
    }
    Ok(())
}

fn move_new(source: &Path, target: &Path) -> bool {
    let wide = |path: &Path| {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            wide(source).as_ptr(),
            wide(target).as_ptr(),
            0,
        ) != 0
    }
}

#[tauri::command]
pub(crate) async fn shortcut_transfer(
    window: WebviewWindow,
    desktop: State<'_, crate::Desktop>,
    action: Action,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    if window.label() != crate::session_windows::MAIN {
        return Err("请在主窗口管理快捷指令".into());
    }
    let app = window.app_handle().clone();
    let root = desktop.2.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Transfers>();
        let mut slots = state.0.lock().map_err(|_| IO_ERROR)?;
        let value = match action {
            Action::PreviewExport {
                revision,
                ids,
                include_scripts,
                attachments,
            } => {
                slots.export = None;
                let settings = adb::read(&root)?;
                if settings.revision != revision {
                    return Err(CHANGED.into());
                }
                let package = make_package(&settings, ids, include_scripts, attachments)?;
                let token = Uuid::new_v4();
                let preview = Preview {
                    token,
                    rows: rows(&root, &package, None)?,
                };
                slots.export = Some(Pending {
                    token,
                    revision,
                    package,
                });
                serde_json::to_value(preview)
            }
            Action::WriteExport { token, path } => {
                let export = slots
                    .export
                    .as_ref()
                    .filter(|p| p.token == token)
                    .ok_or(CHANGED)?;
                if adb::read(&root)?.revision != export.revision {
                    return Err(CHANGED.into());
                }
                save_archive(Path::new(&path), &encode(&export.package)?)?;
                slots.export = None;
                Ok(serde_json::Value::Null)
            }
            Action::PreviewImport { path } => {
                slots.import = None;
                if Path::new(&path)
                    .extension()
                    .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip"))
                {
                    return Err(INVALID.into());
                }
                let (_, bytes) = read_file(Path::new(&path), MAX_ZIP)?;
                let package = decode(&bytes)?;
                let settings = adb::read(&root)?;
                let token = Uuid::new_v4();
                let preview = Preview {
                    token,
                    rows: rows(&root, &package, Some(&settings))?,
                };
                slots.import = Some(Pending {
                    token,
                    revision: settings.revision,
                    package,
                });
                serde_json::to_value(preview)
            }
            Action::ApplyImport { token, decisions } => {
                if slots.import.as_ref().is_none_or(|p| p.token != token) {
                    return Err(CHANGED.into());
                }
                let counts = apply(&root, slots.import.take().ok_or(CHANGED)?, decisions)?;
                if counts.added + counts.replaced != 0 {
                    let revision = adb::read(&root).ok().and_then(|settings| settings.revision);
                    let _ = window.emit("local-shortcuts-changed", revision);
                }
                serde_json::to_value(counts)
            }
            Action::Cancel { token } => {
                if slots.export.as_ref().is_some_and(|p| p.token == token) {
                    slots.export = None;
                }
                if slots.import.as_ref().is_some_and(|p| p.token == token) {
                    slots.import = None;
                }
                Ok(serde_json::Value::Null)
            }
        };
        value.map_err(|_| IO_ERROR.into())
    })
    .await
    .map_err(|_| IO_ERROR)?;
    result
}
