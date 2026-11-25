use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::{Component, Path, Prefix},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::ClientOptions,
};
use uuid::Uuid;
use windows_sys::Win32::System::Memory::{
    FILE_MAP_READ, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile,
};

const MAX_PATHS: usize = 128;
const MAX_BYTES: usize = 8192;
const FRAME_LIMIT: usize = 16384;
const TIMEOUT: Duration = Duration::from_millis(1800);

pub fn bootstrap(task: Uuid, isolated: bool) -> String {
    let script = include_str!("file_drop.ps1")
        .replace("__TASK__", &task.simple().to_string())
        .replace("__ISOLATED__", if isolated { "$true" } else { "$false" });
    STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}

pub fn epoch(task: Uuid) -> Option<u32> {
    let name: Vec<_> = format!("Local\\SharedTerminalDrop.{}", task.simple())
        .encode_utf16()
        .chain([0])
        .collect();
    let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let view = unsafe { MapViewOfFile(handle.as_raw_handle(), FILE_MAP_READ, 0, 0, 4) };
    if view.Value.is_null() {
        return None;
    }
    // One aligned four-byte cell written by the shell at ReadLine boundaries.
    let generation = unsafe { view.Value.cast::<u32>().read_volatile() };
    unsafe { UnmapViewOfFile(view) };
    (generation != 0).then_some(generation)
}

fn valid_path(path: &str) -> bool {
    let path_kind = Path::new(path).components().next();
    let prefix = matches!(
        path_kind,
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(..)
                | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..))
    );
    prefix
        && Path::new(path).is_absolute()
        && !path
            .strip_prefix(r"\\?\")
            .unwrap_or(path)
            .contains(['?', '*', '"', '<', '>', '|'])
        && !path.chars().any(char::is_control)
}

#[derive(Serialize)]
struct Request {
    generation: u32,
    expiry: u128,
    paths: Vec<String>,
}

pub async fn insert(task: Uuid, generation: u32, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty()
        || paths.len() > MAX_PATHS
        || paths.iter().map(|path| path.len() + 1).sum::<usize>() > MAX_BYTES
        || !paths.iter().all(|path| valid_path(path))
    {
        return Err("拖入路径无效或超过上限".into());
    }
    if epoch(task) != Some(generation) {
        return Err("PowerShell 编辑目标已变化".into());
    }
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "无法核对拖入有效时间")?
        .as_millis()
        + TIMEOUT.as_millis();
    let mut frame = serde_json::to_vec(&Request {
        generation,
        expiry,
        paths,
    })
    .map_err(|_| "无法编码拖入路径")?;
    frame.push(b'\n');
    if frame.len() > FRAME_LIMIT {
        return Err("拖入路径超过上限".into());
    }
    let mut client = ClientOptions::new()
        .open(format!(r"\\.\pipe\SharedTerminalDrop.{}", task.simple()))
        .map_err(|_| "PowerShell 编辑目标已变化")?;
    let result = tokio::time::timeout(TIMEOUT, async {
        client.write_all(&frame).await?;
        client.read_u8().await
    })
    .await;
    match result {
        Ok(Ok(1)) => Ok(()),
        Ok(Ok(0)) => Err("当前 PowerShell 光标位置无法插入独立路径参数".into()),
        _ => Err("PowerShell 编辑目标已变化或回执不可用".into()),
    }
}
