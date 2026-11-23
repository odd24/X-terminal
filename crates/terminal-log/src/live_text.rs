//! User-facing, flat readable logs. Internal evidence journals remain separate.
use crate::Record;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_LIVE_BYTES: u64 = 256 * 1024 * 1024;
static CREATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadableStatus {
    pub filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    pub file_identity: [u8; 32],
    pub written_records: u64,
    pub flushed_records: u64,
    pub synced_records: u64,
    pub written_bytes: u64,
    pub flushed_bytes: u64,
    pub synced_bytes: u64,
    pub written_gap_bytes: u64,
    pub flushed_gap_bytes: u64,
    pub synced_gap_bytes: u64,
    pub flushed_at_ms: u64,
    pub synced_at_ms: u64,
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub fn safe_window_name(name: &str) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in name.chars() {
        let ch = if ch.is_control()
            || "<>:\"/\\|?*".contains(ch)
            || matches!(ch,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{200e}'|'\u{200f}')
        {
            '_'
        } else {
            ch
        };
        units += ch.len_utf16();
        // Leave room for the start timestamp, extension, conflict suffix and a
        // possible reserved-name prefix within Windows' 255 UTF-16-unit limit.
        if units > 227 {
            break;
        }
        out.push(ch);
    }
    out = out.trim_matches([' ', '.']).to_owned();
    if out.is_empty() {
        out = "终端".into();
    }
    let stem = out
        .split('.')
        .next()
        .unwrap()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    // The timestamp makes bare CON/COM7 safe (CON_2026...log). An embedded
    // extension still leaves a reserved stem, e.g. CON.note_2026...log.
    if out.contains('.')
        && matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
                | "CONIN$"
                | "CONOUT$"
                | "COM¹"
                | "COM²"
                | "COM³"
                | "LPT¹"
                | "LPT²"
                | "LPT³"
        )
    {
        out.insert(0, '_');
    }
    out
}
// Gregorian civil date from Unix days; Beijing has a fixed UTC+08 offset.
pub fn readable_stem(name: &str, timestamp_ms: u64) -> io::Result<String> {
    let sec = timestamp_ms / 1000 + 8 * 3600;
    let days = sec / 86400;
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    year += u64::from(month <= 2);
    if year > 9999 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid readable date",
        ));
    }
    let daysec = sec % 86400;
    Ok(format!(
        "{}_{year:04}-{month:02}-{day:02}_{:02}_{:02}_{:02}",
        safe_window_name(name),
        daysec / 3600,
        daysec / 60 % 60,
        daysec % 60
    ))
}
pub(crate) struct LiveText {
    _directory: crate::UserLogDirectory,
    output: BufWriter<File>,
    pub status: ReadableStatus,
    max: u64,
}
impl LiveText {
    #[cfg(all(test, windows))]
    pub(crate) fn probe_flushed_handle(&mut self) -> io::Result<(File, ReadableStatus)> {
        self.checkpoint(false)?;
        Ok((self.output.get_ref().try_clone()?, self.status.clone()))
    }
    pub fn open(
        data: &Path,
        name: &str,
        metadata: &crate::Metadata,
        id: uuid::Uuid,
        max: u64,
    ) -> io::Result<Self> {
        Self::open_at(data, name, metadata, id, max, None)
    }
    pub fn open_registered(
        data: &Path,
        name: &str,
        metadata: &crate::Metadata,
        id: uuid::Uuid,
        directory: (Option<String>, crate::UserLogDirectory),
    ) -> io::Result<Self> {
        Self::open_at(data, name, metadata, id, MAX_LIVE_BYTES, Some(directory))
    }
    fn open_at(
        data: &Path,
        name: &str,
        metadata: &crate::Metadata,
        id: uuid::Uuid,
        max: u64,
        selection: Option<(Option<String>, crate::UserLogDirectory)>,
    ) -> io::Result<Self> {
        let _creation = CREATION
            .lock()
            .map_err(|_| io::Error::other("readable creation lock"))?;
        let registered = selection.is_some();
        let (custom, directory) = match selection {
            Some(selection) => selection,
            None => (None, crate::UserLogDirectory::ensure(data)?),
        };
        let root = directory.path();
        if !registered && fs::read_dir(root)?.take(65).count() >= 64 {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "readable log catalogue full",
            ));
        }
        if registered {
            crate::location::reserve(data)?;
        }
        let stem = readable_stem(name, metadata.started_at_ms)?;
        for suffix in 0..=64 {
            let filename = if suffix == 0 {
                format!("{stem}.log")
            } else {
                format!("{stem}_{suffix}.log")
            };
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1).custom_flags(0x00200000);
            }
            let file = match options.open(root.join(&filename)) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            };
            let file_identity = crate::user_file::identity(&file)?;
            let mut result = Self {
                _directory: directory,
                output: BufWriter::with_capacity(8192, file),
                max: max.min(MAX_LIVE_BYTES),
                status: ReadableStatus {
                    filename,
                    directory: custom,
                    file_identity,
                    written_records: 0,
                    flushed_records: 0,
                    synced_records: 0,
                    written_bytes: 0,
                    flushed_bytes: 0,
                    synced_bytes: 0,
                    written_gap_bytes: 0,
                    flushed_gap_bytes: 0,
                    synced_gap_bytes: 0,
                    flushed_at_ms: 0,
                    synced_at_ms: 0,
                },
            };
            result.write(format!("# 终端通信日志 UTF-8\r\n# 日志 {id}；连接 {} / {}\r\n# 仅起录后的接收输出/终端回显；不含认证表单，未独立记录发送；起录前内容未记录。\r\n",metadata.connection.connection_id.0,metadata.connection.generation).as_bytes())?;
            result.checkpoint(true)?;
            if registered {
                crate::location::register(
                    data,
                    crate::location::Location {
                        log_id: id,
                        connection: metadata.connection,
                        protocol: metadata.protocol,
                        directory: result.status.directory.clone(),
                        filename: result.status.filename.clone(),
                        file_identity,
                    },
                )?;
            }
            return Ok(result);
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "readable filename collision limit",
        ))
    }
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() as u64 > self.max.saturating_sub(self.status.written_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "readable log size limit",
            ));
        }
        timeline_io!(LiveWrite, None, self.output.write_all(bytes))?;
        self.status.written_bytes += bytes.len() as u64;
        Ok(())
    }
    pub fn append(&mut self, record: &Record) -> io::Result<()> {
        if let Some(gap) = record.text.gap_bytes.filter(|v| *v > 0) {
            self.write(format!("\r\n[接收缺口：{gap} 字节]\r\n").as_bytes())?;
        }
        let mut text = String::with_capacity(record.text.text.len());
        for ch in record.text.text.chars() {
            if (ch.is_control() && !matches!(ch, '\r' | '\n' | '\t'))
                || matches!(ch,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{200e}'|'\u{200f}')
            {
                use std::fmt::Write;
                write!(text, "\\u{{{:04x}}}", ch as u32).unwrap();
            } else {
                text.push(ch);
            }
        }
        self.write(text.as_bytes())?;
        if record.text.decode_error {
            self.write(b"\r\n[decode error]\r\n")?;
        }
        self.status.written_records += 1;
        self.status.written_gap_bytes += record.text.gap_bytes.unwrap_or(0);
        Ok(())
    }
    pub fn checkpoint(&mut self, sync: bool) -> io::Result<()> {
        timeline_io!(
            LiveFlush,
            Some(self.status.written_records),
            self.output.flush()
        )?;
        self.status.flushed_records = self.status.written_records;
        self.status.flushed_bytes = self.status.written_bytes;
        self.status.flushed_gap_bytes = self.status.written_gap_bytes;
        self.status.flushed_at_ms = now_ms();
        if sync {
            timeline_io!(
                LiveSync,
                Some(self.status.written_records),
                self.output.get_ref().sync_all()
            )?;
            self.status.synced_records = self.status.written_records;
            self.status.synced_bytes = self.status.written_bytes;
            self.status.synced_gap_bytes = self.status.written_gap_bytes;
            self.status.synced_at_ms = now_ms();
        }
        Ok(())
    }
    #[cfg(all(windows, any(test, feature = "log-timeline-fixture")))]
    pub(crate) fn probe_sync_file(&self) -> &File {
        self.output.get_ref()
    }

    #[cfg(all(windows, any(test, feature = "log-timeline-fixture")))]
    pub(crate) fn probe_publish_synced(&mut self) {
        self.status.synced_records = self.status.flushed_records;
        self.status.synced_bytes = self.status.flushed_bytes;
        self.status.synced_gap_bytes = self.status.flushed_gap_bytes;
        self.status.synced_at_ms = now_ms();
    }
}
