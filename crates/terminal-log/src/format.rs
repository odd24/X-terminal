use crate::{Limits, Metadata, Record};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use uuid::Uuid;

pub(crate) const MAGIC: &[u8; 8] = b"STRAW001";
pub(crate) const FRAME_FIXED: usize = 33;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SegmentHeader {
    pub format_version: u32,
    pub log_id: Uuid,
    pub segment: u64,
    pub metadata: Metadata,
    pub limits: Limits,
    pub source_cursor: u64,
    pub text_cursor: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFrame {
    pub text_seq: u64,
    pub source_seq: Option<u64>,
    pub timestamp_ms: u64,
    pub gap_bytes: Option<u64>,
    pub bytes: Vec<u8>,
}

pub(crate) fn raw_frame(record: &Record) -> Vec<u8> {
    let mut body =
        Vec::with_capacity(FRAME_FIXED + record.raw.as_ref().map_or(0, |r| r.bytes.len()));
    let (kind, seq, lost, bytes) = match &record.raw {
        Some(raw) => (
            if raw.gap_bytes.is_some() { 2 } else { 1 },
            raw.seq,
            raw.gap_bytes.unwrap_or(0),
            raw.bytes.as_slice(),
        ),
        None => (3, 0, 0, &[][..]),
    };
    body.push(kind);
    body.extend_from_slice(&record.text.seq.to_le_bytes());
    body.extend_from_slice(&seq.to_le_bytes());
    body.extend_from_slice(&record.text.timestamp_ms.to_le_bytes());
    body.extend_from_slice(&lost.to_le_bytes());
    body.extend_from_slice(bytes);
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid raw journal")
}
fn length<R: Read>(reader: &mut R) -> io::Result<Option<usize>> {
    let mut prefix = [0; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => {
                if result? == 0 {
                    return Ok(None);
                }
                break;
            }
        }
    }
    reader.read_exact(&mut prefix[1..])?;
    Ok(Some(u32::from_le_bytes(prefix) as usize))
}
pub struct RawReader<R: Read> {
    reader: R,
    pub header: SegmentHeader,
    source: u64,
    text: u64,
    ended: bool,
    failed: bool,
}
impl<R: Read> RawReader<R> {
    pub fn new(mut reader: R) -> io::Result<Self> {
        let mut magic = [0; 8];
        reader.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(invalid());
        }
        let size = length(&mut reader)?.ok_or_else(invalid)?;
        if size == 0 || size > 4096 {
            return Err(invalid());
        }
        let mut body = vec![0; size];
        reader.read_exact(&mut body)?;
        let header: SegmentHeader = serde_json::from_slice(&body).map_err(|_| invalid())?;
        if header.format_version != 1
            || header.segment == 0
            || header.log_id.is_nil()
            || !header.metadata.valid()
            || !header.limits.valid()
            || header.source_cursor == 0
            || header.text_cursor == 0
            || header.source_cursor < header.metadata.source_cursor
            || header.text_cursor < header.metadata.text_cursor
        {
            return Err(invalid());
        }
        Ok(Self {
            source: header.source_cursor,
            text: header.text_cursor,
            header,
            reader,
            ended: false,
            failed: false,
        })
    }
    /// EOF at a frame boundary is distinct from truncated headers or payloads.
    /// A clean file boundary alone does not prove that the entire log completed.
    pub fn next_record(&mut self) -> io::Result<Option<RawFrame>> {
        if self.failed {
            return Err(invalid());
        }
        let result = self.read_next();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn read_next(&mut self) -> io::Result<Option<RawFrame>> {
        let Some(size) = length(&mut self.reader)? else {
            return Ok(None);
        };
        if self.ended
            || !(FRAME_FIXED..=FRAME_FIXED + session_core::session::EVENT_BYTES).contains(&size)
        {
            return Err(invalid());
        }
        let mut body = vec![0; size];
        self.reader.read_exact(&mut body)?;
        let number = |offset| u64::from_le_bytes(body[offset..offset + 8].try_into().unwrap());
        let text_seq = number(1);
        let source = number(9);
        let timestamp_ms = number(17);
        let lost = number(25);
        let bytes = body[FRAME_FIXED..].to_vec();
        if text_seq != self.text {
            return Err(invalid());
        }
        let (source_seq, gap_bytes) = match body[0] {
            1 if source == self.source && source != 0 && lost == 0 && !bytes.is_empty() => {
                (Some(source), None)
            }
            2 if source == self.source && source != 0 && lost > 0 && bytes.is_empty() => {
                (Some(source), Some(lost))
            }
            3 if source == 0 && lost == 0 && bytes.is_empty() => {
                self.ended = true;
                (None, None)
            }
            _ => return Err(invalid()),
        };
        self.text = self.text.checked_add(1).ok_or_else(invalid)?;
        if source_seq.is_some() {
            self.source = self.source.checked_add(1).ok_or_else(invalid)?;
        }
        Ok(Some(RawFrame {
            text_seq,
            source_seq,
            timestamp_ms,
            gap_bytes,
            bytes,
        }))
    }
}
