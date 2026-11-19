use crate::{Journal, Limits, Metadata, Record, SegmentHeader, Status, format};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
#[cfg(all(test, windows))]
mod checkpoint_probe;

pub(crate) struct FileJournal {
    #[cfg(feature = "log-timeline-fixture")]
    timeline_written_records: u64,
    live: Option<crate::live_text::LiveText>,
    // Retain non-delete-sharing Windows directory handles to prevent junction/rename
    // substitution during all file creation, rotation and completion operations.
    _guards: Vec<File>,
    directory: PathBuf,
    id: Uuid,
    metadata: Metadata,
    limits: Limits,
    segments: VecDeque<u64>,
    raw: Option<File>,
    text: Option<File>,
    bytes: u64,
    source_cursor: u64,
}
pub(crate) fn file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0).custom_flags(0x00200000); // OPEN_REPARSE_POINT
    }
    options.open(path)
}
pub(crate) fn publish(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // MoveFileW, unlike replace-style rename, refuses an existing destination.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileW(source.as_ptr(), target.as_ptr())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(source, target)?;
        fs::remove_file(source)
    }
}
pub(crate) fn pin(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, fs::OpenOptionsExt};
        // Directory handles: permit read/write but deny delete/rename sharing.
        options.share_mode(3).custom_flags(0x02000000 | 0x00200000);
        let guard = options.open(path)?;
        let meta = guard.metadata()?;
        if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "journal directory is not a plain directory",
            ));
        }
        Ok(guard)
    }
    #[cfg(not(windows))]
    {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "journal directory is not plain",
            ));
        }
        options.open(path)
    }
}
pub(crate) fn guards(root: &Path) -> io::Result<Vec<File>> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid local journal root",
        ));
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(root.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "journal root must be a local drive",
            ));
        }
    }
    root.ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(pin)
        .collect()
}
impl FileJournal {
    pub(crate) fn open(
        root: PathBuf,
        id: Uuid,
        metadata: Metadata,
        limits: Limits,
    ) -> io::Result<Self> {
        let mut guards = guards(&root)?;
        let directory = root.join(id.to_string());
        fs::create_dir(&directory)?; // Never append to or clear an existing log.
        guards.push(pin(&directory)?);
        let source = metadata.source_cursor;
        let text = metadata.text_cursor;
        let mut result = Self {
            #[cfg(feature = "log-timeline-fixture")]
            timeline_written_records: 0,
            live: None,
            _guards: guards,
            directory,
            id,
            metadata,
            limits,
            segments: VecDeque::new(),
            raw: None,
            text: None,
            bytes: 0,
            source_cursor: source,
        };
        result.segment(1, source, text)?;
        Ok(result)
    }
    pub(crate) fn open_readable(
        root: PathBuf,
        id: Uuid,
        metadata: Metadata,
        limits: Limits,
        name: &str,
    ) -> io::Result<Self> {
        let data = root
            .parent()
            .ok_or_else(|| io::Error::other("invalid log root"))?
            .to_path_buf();
        let mut journal = Self::open(root, id, metadata.clone(), limits)?;
        journal.live = Some(crate::live_text::LiveText::open(
            &data,
            name,
            &metadata,
            id,
            crate::live_text::MAX_LIVE_BYTES,
        )?);
        Ok(journal)
    }
    fn paths(&self, segment: u64) -> (PathBuf, PathBuf) {
        (
            self.directory.join(format!("{segment:016}.rawlog")),
            self.directory.join(format!("{segment:016}.text.jsonl")),
        )
    }
    fn sync(&mut self) -> io::Result<()> {
        timeline_io!(
            RawSync,
            Some(self.timeline_written_records),
            self.raw.as_mut().unwrap().sync_all()
        )?;
        timeline_io!(
            JsonlSync,
            Some(self.timeline_written_records),
            self.text.as_mut().unwrap().sync_all()
        )
    }

    #[cfg(all(windows, any(test, feature = "log-timeline-fixture")))]
    pub(crate) fn probe_concurrent_sync(
        &mut self,
        clock: std::time::Instant,
    ) -> io::Result<[[u64; 2]; 3]> {
        let live = self.live.as_mut().unwrap();
        live.checkpoint(false)?;
        #[cfg(feature = "log-timeline-fixture")]
        let context = crate::timeline_fixture::logger_context();
        #[cfg(feature = "log-timeline-fixture")]
        let written = self.timeline_written_records;
        macro_rules! call {
            ($op:ident, $file:expr) => {{
                #[cfg(feature = "log-timeline-fixture")]
                let _scope = crate::timeline_fixture::install(context.clone());
                let start = clock.elapsed().as_nanos().try_into().unwrap();
                timeline_io!($op, Some(written), ($file).sync_all())
                    .map(|()| [start, clock.elapsed().as_nanos().try_into().unwrap()])
            }};
        }
        let ranges = std::thread::scope(|scope| {
            let raw_file = self.raw.as_ref().unwrap();
            let jsonl_file = self.text.as_ref().unwrap();
            let raw = scope.spawn(|| call!(RawSync, raw_file));
            let jsonl = scope.spawn(|| call!(JsonlSync, jsonl_file));
            let live = call!(LiveSync, live.probe_sync_file());
            let raw = raw.join().unwrap();
            let jsonl = jsonl.join().unwrap();
            Ok::<_, io::Error>([live?, raw?, jsonl?])
        })?;
        live.probe_publish_synced();
        Ok(ranges)
    }
    fn segment(&mut self, number: u64, source_cursor: u64, text_cursor: u64) -> io::Result<()> {
        if self.raw.is_some() {
            self.sync()?;
        }
        self.raw.take();
        self.text.take();
        // Retire before reserving another pair; a subsequent failure is explicit
        // and cannot silently grow the configured disk quota.
        if self.segments.len() >= self.limits.segments as usize {
            let old = *self.segments.front().unwrap();
            let (raw, text) = self.paths(old);
            fs::remove_file(raw)?;
            fs::remove_file(text)?;
            self.segments.pop_front();
        }
        let (raw_path, text_path) = self.paths(number);
        let mut raw = file(&raw_path)?;
        let mut text = file(&text_path)?;
        let header = SegmentHeader {
            format_version: 1,
            log_id: self.id,
            segment: number,
            metadata: self.metadata.clone(),
            limits: self.limits,
            source_cursor,
            text_cursor,
        };
        let body = serde_json::to_vec(&header)?;
        let mut text_body =
            serde_json::to_vec(&serde_json::json!({"type":"header", "header": header}))?;
        text_body.push(b'\n');
        raw.write_all(format::MAGIC)?;
        raw.write_all(&(body.len() as u32).to_le_bytes())?;
        raw.write_all(&body)?;
        text.write_all(&text_body)?;
        self.bytes = 12 + body.len() as u64 + text_body.len() as u64;
        self.raw = Some(raw);
        self.text = Some(text);
        self.segments.push_back(number);
        Ok(())
    }
}
impl Journal for FileJournal {
    #[cfg(all(windows, feature = "log-timeline-fixture"))]
    fn periodic_checkpoint(&mut self, sync: bool) -> io::Result<()> {
        if sync && self.live.is_some() && crate::timeline_fixture::concurrent_sync() {
            return self
                .probe_concurrent_sync(std::time::Instant::now())
                .map(|_| ());
        }
        self.checkpoint(sync)
    }

    fn checkpoint(&mut self, sync: bool) -> io::Result<()> {
        if let Some(live) = &mut self.live {
            live.checkpoint(sync)?;
        }
        if sync {
            self.sync()?;
        }
        Ok(())
    }
    fn readable(&self) -> Option<crate::ReadableStatus> {
        self.live.as_ref().map(|live| live.status.clone())
    }
    fn readable_guard(&self) -> io::Result<Option<File>> {
        self.live.as_ref().map(|live| live.guard()).transpose()
    }

    fn append(&mut self, record: &Record) -> io::Result<(u64, u64)> {
        let raw = format::raw_frame(record);
        let mut text =
            serde_json::to_vec(&serde_json::json!({"type":"output", "event": record.text}))?;
        text.push(b'\n');
        let size = (raw.len() + text.len()) as u64;
        if size + self.bytes > self.limits.segment_bytes {
            let number = self
                .segments
                .back()
                .unwrap()
                .checked_add(1)
                .ok_or_else(|| io::Error::other("segment counter exhausted"))?;
            let source = record
                .raw
                .as_ref()
                .map_or(self.source_cursor, |raw| raw.seq);
            self.segment(number, source, record.text.seq)?;
        }
        if size + self.bytes > self.limits.segment_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "record exceeds segment budget",
            ));
        }
        #[cfg(all(windows, feature = "log-disk-full-fixture"))]
        crate::disk_full_fixture::before_raw_write(&self.directory)?;
        timeline_io!(RawWrite, None, self.raw.as_mut().unwrap().write_all(&raw))?;
        timeline_io!(
            JsonlWrite,
            None,
            self.text.as_mut().unwrap().write_all(&text)
        )?;
        #[cfg(feature = "log-timeline-fixture")]
        {
            self.timeline_written_records = self.timeline_written_records.saturating_add(1);
        }
        if let Some(live) = &mut self.live {
            live.append(record)?;
        }
        self.bytes += size;
        if let Some(raw) = &record.raw {
            self.source_cursor = raw.seq + 1;
        }
        Ok((
            *self.segments.front().unwrap(),
            *self.segments.back().unwrap(),
        ))
    }
    fn finish(&mut self, status: &Status) -> io::Result<()> {
        self.checkpoint(true)?;
        let completion = crate::Completion {
            format_version: 1,
            log_id: self.id,
            connection: self.metadata.connection,
            written_records: status.written_records,
            written_raw_bytes: status.written_raw_bytes,
            first_retained_segment: *self.segments.front().unwrap(),
            last_segment: *self.segments.back().unwrap(),
            natural_end: status.natural_end,
            source_gap_bytes: Some(status.source_gap_bytes),
        };
        let partial = self.directory.join("completion.partial");
        let mut marker = file(&partial)?;
        marker.write_all(&serde_json::to_vec(&completion)?)?;
        marker.sync_all()?;
        drop(marker);
        publish(&partial, &self.directory.join("completion.json"))
    }
}
