//! Streaming validation of an immutable segment pair. File identity, directory
//! policy, completion markers and cross-segment continuity belong to the caller.
use crate::{MAX_TEXT, RawReader, Record, SegmentHeader};
use serde::Deserialize;
use session_core::{presentation::TextEvent, session::OutputEvent};
use std::io::{self, BufRead, BufReader, Read};

// JSON escaping may expand one byte into six ASCII bytes. Fixed fields and the
// wrapper fit in the remaining allowance; decoded text has a separate 16KiB cap.
const OUTPUT_LINE: usize = MAX_TEXT * 6 + 512;
const HEADER_LINE: usize = 4096 + 128;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Line {
    Header { header: SegmentHeader },
    Output { event: TextEvent },
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid journal pair")
}
fn line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete journal line",
                ))
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(available.len(), |end| end + 1);
        if count > limit - bytes.len() {
            return Err(invalid());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(bytes));
        }
    }
}

/// Yields matching raw/text records, with bounded per-record memory. An error
/// permanently fails the reader. Clean EOF proves only this pair's framing,
/// never successful completion or completeness of the whole connection/log.
pub struct PairReader<R: Read, T: Read> {
    raw: RawReader<R>,
    text: BufReader<T>,
    header: SegmentHeader,
    failed: bool,
    ended: bool,
}
impl<R: Read, T: Read> PairReader<R, T> {
    pub fn new(raw: R, text: T) -> io::Result<Self> {
        let raw = RawReader::new(raw)?;
        let mut text = BufReader::new(text);
        let first = line(&mut text, HEADER_LINE)?.ok_or_else(invalid)?;
        let Line::Header { header } = serde_json::from_slice(&first).map_err(|_| invalid())? else {
            return Err(invalid());
        };
        if raw.header != header {
            return Err(invalid());
        }
        Ok(Self {
            raw,
            text,
            header,
            failed: false,
            ended: false,
        })
    }
    pub fn header(&self) -> &SegmentHeader {
        &self.header
    }
    pub fn next_record(&mut self) -> io::Result<Option<Record>> {
        if self.failed {
            return Err(invalid());
        }
        if self.ended {
            return Ok(None);
        }
        let result = self.read_next();
        match &result {
            Err(_) => self.failed = true,
            Ok(None) => self.ended = true,
            _ => {}
        }
        result
    }
    fn read_next(&mut self) -> io::Result<Option<Record>> {
        let raw = self.raw.next_record()?;
        let text = line(&mut self.text, OUTPUT_LINE)?;
        let (raw, text) = match (raw, text) {
            (None, None) => return Ok(None),
            (Some(raw), Some(text)) => (raw, text),
            _ => return Err(invalid()),
        };
        let Line::Output { event } = serde_json::from_slice(&text).map_err(|_| invalid())? else {
            return Err(invalid());
        };
        if event.seq != raw.text_seq
            || event.source_seq != raw.source_seq
            || event.timestamp_ms != raw.timestamp_ms
            || event.gap_bytes != raw.gap_bytes
            || event.text.len() > MAX_TEXT
            || (event.gap_bytes.is_some() && (!event.text.is_empty() || event.decode_error))
        {
            return Err(invalid());
        }
        Ok(Some(Record {
            connection: self.header.metadata.connection,
            raw: raw.source_seq.map(|seq| OutputEvent {
                seq,
                timestamp_ms: raw.timestamp_ms,
                bytes: raw.bytes,
                gap_bytes: raw.gap_bytes,
            }),
            text: event,
        }))
    }
}
