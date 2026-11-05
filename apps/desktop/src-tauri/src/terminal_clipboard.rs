use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::{
    Foundation::HGLOBAL,
    System::{
        DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard},
        Memory::{GlobalLock, GlobalSize, GlobalUnlock},
    },
};

const MAX_UNITS: usize = 196_608;
static READING: AtomicBool = AtomicBool::new(false);
struct Reading;
impl Drop for Reading {
    fn drop(&mut self) {
        READING.store(false, Ordering::Release);
    }
}
struct Clipboard;
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}
struct Locked(HGLOBAL);
impl Drop for Locked {
    fn drop(&mut self) {
        unsafe {
            GlobalUnlock(self.0);
        }
    }
}

fn decode(units: &[u16]) -> Result<String, String> {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or("剪贴板文字过长或缺少结尾；未发送")?;
    if end > MAX_UNITS {
        return Err("剪贴板文字超过上限；未发送".into());
    }
    let text =
        String::from_utf16(&units[..end]).map_err(|_| "剪贴板含不完整Unicode字符；未发送")?;
    if text.len() > MAX_UNITS {
        return Err("剪贴板文字超过上限；未发送".into());
    }
    Ok(text)
}
fn read() -> Result<String, String> {
    // Only copy while the clipboard and its memory are held. Never free its handle.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("系统剪贴板正被占用；未发送，请重试粘贴".into());
        }
        let _clipboard = Clipboard;
        // CF_UNICODETEXT, fixed format; renderer cannot request paths or other formats.
        let handle = GetClipboardData(13);
        if handle.is_null() {
            return Err("剪贴板没有可读取的Unicode文字；未发送".into());
        }
        let bytes = GlobalSize(handle);
        if bytes < 2 || !bytes.is_multiple_of(2) {
            return Err("剪贴板文字格式无效；未发送".into());
        }
        let pointer = GlobalLock(handle).cast::<u16>();
        if pointer.is_null() {
            return Err("系统剪贴板锁定失败；未发送".into());
        }
        let _locked = Locked(handle);
        decode(std::slice::from_raw_parts(
            pointer,
            (bytes / 2).min(MAX_UNITS + 1),
        ))
    }
}
#[tauri::command]
pub async fn terminal_clipboard_read() -> Result<String, String> {
    if READING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("上次剪贴板读取仍在结束；未发送".into());
    }
    // Delayed-rendering clipboard owners must not block the UI or grow a queue.
    let guard = Reading;
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        read()
    });
    match tokio::time::timeout(std::time::Duration::from_secs(3), worker).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("系统剪贴板读取失败；未发送".into()),
        Err(_) => Err("系统剪贴板读取超时；未发送，请稍后重试".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_utf16_preserves_text_and_rejects_damage() {
        let units: Vec<_> = "中文𐀀\r\n下一行\n\0ignored".encode_utf16().collect();
        assert_eq!(decode(&units).unwrap(), "中文𐀀\r\n下一行\n");
        assert_eq!(decode(&[0]).unwrap(), "");
        assert!(decode(&[0xd800, 0]).is_err());
        assert!(decode(&[65]).is_err());
        assert!(decode(&[0xd800, 65, 0]).is_err());
        assert!(decode(&vec![65; MAX_UNITS + 1]).is_err());
        let mut maximum = vec![65; MAX_UNITS];
        maximum.push(0);
        assert_eq!(decode(&maximum).unwrap().len(), MAX_UNITS);
        let mut wide = vec![0x4e2d; MAX_UNITS / 3 + 1];
        wide.push(0);
        assert!(decode(&wide).is_err());
    }
}
