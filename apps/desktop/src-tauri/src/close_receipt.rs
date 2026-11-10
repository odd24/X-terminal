//! Own-child safe summaries only. Raw stderr never reaches a file or renderer.
use serde::{Deserialize, Serialize};
use session_service::audit_diagnostic::{CloseDiagnostic, Outcome, PREFIX};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    task::JoinHandle,
};
use uuid::Uuid;
const LINE_LIMIT: usize = 2048;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Ack {
    NotAttempted,
    Acknowledged,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RequestError {
    Unavailable,
    InvalidReply,
    UnknownDelivery,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WaitError {
    Timeout,
    Io,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReaderJoin {
    Complete,
    Aborted,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadSummary {
    pub join: ReaderJoin,
    pub eof: bool,
    pub io_failed: bool,
    pub candidates: u32,
    pub valid: u32,
    pub invalid: u32,
    pub unsupported: u32,
    pub oversized: u32,
    pub ignored: u32,
    pub partial: bool,
    pub diagnostic: Option<CloseDiagnostic>,
}
impl Default for ReadSummary {
    fn default() -> Self {
        Self {
            join: ReaderJoin::Aborted,
            eof: false,
            io_failed: false,
            candidates: 0,
            valid: 0,
            invalid: 0,
            unsupported: 0,
            oversized: 0,
            ignored: 0,
            partial: false,
            diagnostic: None,
        }
    }
}
impl ReadSummary {
    fn reliable(&self) -> bool {
        self.join == ReaderJoin::Complete
            && self.eof
            && !self.io_failed
            && self.candidates == 1
            && self.valid == 1
            && self.invalid == 0
            && self.unsupported == 0
            && self.oversized == 0
            && !self.partial
    }
}
fn diagnostic_valid(d: &CloseDiagnostic) -> bool {
    if d.version != 1 {
        return false;
    }
    if let (Some(a), Some(s)) = (d.accepted, d.synced)
        && s > a
    {
        return false;
    }
    match d.outcome {
        Outcome::Closed => {
            d.state == Some(session_core::audit_journal::State::Closed)
                && d.accepted.is_some()
                && d.accepted == d.synced
                && d.rejected.is_some()
                && d.incomplete.is_some()
                && d.first_failure.is_none()
        }
        Outcome::Incomplete => {
            d.state.is_some()
                && d.accepted.is_some()
                && d.synced.is_some()
                && d.rejected.is_some()
                && d.incomplete.is_some()
                && (d.state != Some(session_core::audit_journal::State::Closed)
                    || d.accepted != d.synced)
        }
        Outcome::SnapshotUnavailable => {
            d.state.is_none()
                && d.accepted.is_none()
                && d.synced.is_none()
                && d.rejected.is_none()
                && d.incomplete.is_none()
                && d.first_failure.is_none()
        }
        Outcome::OwnerJoinFailed | Outcome::OwnerCloseFailed => true,
    }
}
struct Decoder {
    line: Vec<u8>,
    overflow: bool,
    summary: ReadSummary,
}
impl Decoder {
    fn new() -> Self {
        Self {
            line: Vec::with_capacity(LINE_LIMIT),
            overflow: false,
            summary: ReadSummary::default(),
        }
    }
    fn candidate(&self) -> bool {
        self.line.starts_with(PREFIX.as_bytes())
    }
    fn complete_line(&mut self) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        if self.candidate() {
            self.summary.candidates = self.summary.candidates.saturating_add(1);
            if self.overflow {
                self.summary.oversized = self.summary.oversized.saturating_add(1);
            } else if let Ok(line) = std::str::from_utf8(&self.line) {
                if let Some(d) = CloseDiagnostic::parse_line(line).filter(diagnostic_valid) {
                    self.summary.valid = self.summary.valid.saturating_add(1);
                    if self.summary.valid == 1 {
                        self.summary.diagnostic = Some(d);
                    }
                } else {
                    let version = serde_json::from_str::<serde_json::Value>(&line[PREFIX.len()..])
                        .ok()
                        .and_then(|v| v["version"].as_u64());
                    if version.is_some_and(|v| v != 1) {
                        self.summary.unsupported = self.summary.unsupported.saturating_add(1);
                    } else {
                        self.summary.invalid = self.summary.invalid.saturating_add(1);
                    }
                }
            } else {
                self.summary.invalid = self.summary.invalid.saturating_add(1);
            }
        } else {
            self.summary.ignored = self.summary.ignored.saturating_add(1);
        }
        self.line.fill(0);
        self.line.clear();
        self.overflow = false;
    }
    fn push(&mut self, bytes: &[u8]) {
        for b in bytes {
            if *b == b'\n' {
                self.complete_line();
            } else if self.line.len() < LINE_LIMIT {
                self.line.push(*b);
            } else {
                self.overflow = true;
            }
        }
    }
    fn finish(&mut self) {
        self.summary.eof = true;
        if !self.line.is_empty() || self.overflow {
            if self.candidate() || PREFIX.as_bytes().starts_with(&self.line) {
                self.summary.partial = true;
                self.summary.candidates = self.summary.candidates.saturating_add(1);
            }
            self.line.fill(0);
            self.line.clear();
        }
    }
    fn safe(&self) -> ReadSummary {
        let mut result = self.summary.clone();
        if !result.eof
            || result.candidates != 1
            || result.valid != 1
            || result.invalid > 0
            || result.unsupported > 0
            || result.oversized > 0
            || result.partial
            || result.io_failed
        {
            result.diagnostic = None;
        }
        result
    }
}
pub struct Collector {
    task: Option<JoinHandle<ReadSummary>>,
    snapshot: Arc<Mutex<ReadSummary>>,
    finished: Option<ReadSummary>,
}
impl Collector {
    pub fn start(reader: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let snapshot = Arc::new(Mutex::new(ReadSummary::default()));
        let out = snapshot.clone();
        let task = tokio::spawn(async move {
            let mut reader = reader;
            let mut decoder = Decoder::new();
            let mut block = [0u8; 4096];
            loop {
                match reader.read(&mut block).await {
                    Ok(0) => {
                        decoder.finish();
                        break;
                    }
                    Ok(n) => decoder.push(&block[..n]),
                    Err(_) => {
                        decoder.summary.io_failed = true;
                        break;
                    }
                }
                block.fill(0);
                *out.lock().unwrap() = decoder.safe();
                tokio::task::yield_now().await;
            }
            block.fill(0);
            let result = decoder.safe();
            *out.lock().unwrap() = result.clone();
            result
        });
        Self {
            task: Some(task),
            snapshot,
            finished: None,
        }
    }
    pub async fn finish(&mut self) -> ReadSummary {
        if let Some(result) = &self.finished {
            return result.clone();
        }
        let Some(task) = self.task.as_mut() else {
            let mut s = self.snapshot.lock().unwrap().clone();
            s.join = ReaderJoin::Failed;
            s.diagnostic = None;
            return s;
        };
        let waited = tokio::time::timeout(Duration::from_millis(250), task).await;
        let mut result = match waited {
            Ok(Ok(mut s)) => {
                self.task.take();
                s.join = ReaderJoin::Complete;
                s
            }
            Ok(Err(_)) => {
                self.task.take();
                let mut s = self.snapshot.lock().unwrap().clone();
                s.join = ReaderJoin::Failed;
                s
            }
            Err(_) => {
                let task = self.task.take().unwrap();
                task.abort();
                let _ = task.await;
                let mut s = self.snapshot.lock().unwrap().clone();
                s.join = ReaderJoin::Aborted;
                s
            }
        };
        if !result.reliable() {
            result.diagnostic = None;
        }
        self.finished = Some(result.clone());
        result
    }
}
impl Drop for Collector {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub version: u8,
    pub format: Format,
    pub service_id: Uuid,
    pub owned_pid: u32,
    #[serde(with = "count")]
    pub started_at_ms: u64,
    #[serde(with = "count")]
    pub recorded_at_ms: u64,
    pub shutdown_attempted: bool,
    pub shutdown_ack: Ack,
    pub request_error: Option<RequestError>,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub wait_error: Option<WaitError>,
    pub kill_requested: bool,
    pub kill_request_ok: Option<bool>,
    pub reader: ReadSummary,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Format {
    #[serde(rename = "shared-terminal-desktop-close-v1")]
    V1,
}
impl Receipt {
    pub fn validate(&self, id: Uuid) -> bool {
        self.version == 1
            && !id.is_nil()
            && self.service_id == id
            && self.owned_pid > 0
            && self.started_at_ms > 0
            && self.recorded_at_ms >= self.started_at_ms
            && self.recorded_at_ms <= 253402300799999
            && (self.exited || self.exit_code.is_none())
            && (self.kill_requested || self.kill_request_ok.is_none())
            && (self.shutdown_attempted || self.shutdown_ack == Ack::NotAttempted)
            && self
                .reader
                .diagnostic
                .as_ref()
                .is_none_or(|d| self.reader.reliable() && diagnostic_valid(d))
    }
    pub fn attention(&self) -> bool {
        self.exit_code.is_some_and(|n| n != 0)
            || self.kill_requested
            || self.reader.diagnostic.as_ref().is_some_and(|d| {
                d.outcome != Outcome::Closed
                    || d.rejected.is_some_and(|n| n > 0)
                    || d.incomplete.is_some_and(|n| n > 0)
            })
    }
}
mod count {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(n: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&n.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let text = String::deserialize(d)?;
        let n = text
            .parse::<u64>()
            .map_err(|_| serde::de::Error::custom("invalid receipt count"))?;
        if text != n.to_string() {
            return Err(serde::de::Error::custom("invalid receipt count"));
        }
        Ok(n)
    }
}
pub fn clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
fn parse(bytes: &[u8], id: Uuid) -> Result<Receipt, terminal_log::close_store::Unavailable> {
    use terminal_log::close_store::Unavailable as U;
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| U::Untrusted)?;
    if value["version"].as_u64().is_some_and(|v| v != 1) {
        return Err(U::Unsupported);
    }
    let receipt: Receipt = serde_json::from_value(value).map_err(|_| U::Untrusted)?;
    if !receipt.validate(id) {
        return Err(U::Untrusted);
    }
    Ok(receipt)
}
fn trust(bytes: &[u8], id: Uuid) -> Result<u64, terminal_log::close_store::Unavailable> {
    parse(bytes, id).map(|r| r.recorded_at_ms)
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Availability {
    Ready,
    Empty,
    Busy,
    Untrusted,
    Unsupported,
    Capacity,
    Unavailable,
    Timeout,
}
#[derive(Debug, Clone, Serialize)]
pub struct Previous {
    pub availability: Availability,
    pub receipt: Option<Receipt>,
    pub attention: bool,
}
impl Previous {
    fn empty(a: Availability) -> Self {
        Self {
            availability: a,
            receipt: None,
            attention: false,
        }
    }
}
fn availability(u: terminal_log::close_store::Unavailable) -> Availability {
    use terminal_log::close_store::Unavailable as U;
    match u {
        U::Missing => Availability::Empty,
        U::Busy => Availability::Busy,
        U::Untrusted | U::Conflict => Availability::Untrusted,
        U::Unsupported => Availability::Unsupported,
        U::Capacity => Availability::Capacity,
        U::Io => Availability::Unavailable,
    }
}
pub async fn load(root: PathBuf, current: Uuid, started: u64) -> Previous {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _ = std::thread::Builder::new()
        .name("close-receipt-read".into())
        .spawn(move || {
            let result = (|| {
                let entries = terminal_log::close_store::read(&root, trust)?;
                let mut receipts = entries
                    .into_iter()
                    .map(|e| parse(&e.bytes, e.service_id))
                    .collect::<Result<Vec<_>, _>>()?;
                receipts.retain(|r| r.service_id != current && r.recorded_at_ms <= started);
                receipts.sort_by_key(|r| (r.recorded_at_ms, r.service_id));
                Ok::<_, terminal_log::close_store::Unavailable>(receipts.pop())
            })();
            let _ = tx.send(result);
        });
    match tokio::time::timeout(Duration::from_millis(500), rx).await {
        Ok(Ok(Ok(Some(r)))) => Previous {
            availability: Availability::Ready,
            attention: r.attention(),
            receipt: Some(r),
        },
        Ok(Ok(Ok(None))) => Previous::empty(Availability::Empty),
        Ok(Ok(Err(e))) => Previous::empty(availability(e)),
        Err(_) => Previous::empty(Availability::Timeout),
        _ => Previous::empty(Availability::Unavailable),
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Publication {
    Published,
    Failed(Availability),
    UnknownTimeout,
    Unknown,
}
pub async fn publish(root: PathBuf, receipt: Receipt) -> Publication {
    if !receipt.validate(receipt.service_id) {
        return Publication::Failed(Availability::Untrusted);
    }
    let Ok(bytes) = serde_json::to_vec(&receipt) else {
        return Publication::Failed(Availability::Untrusted);
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _ = std::thread::Builder::new()
        .name("close-receipt-publish".into())
        .spawn(move || {
            let result =
                terminal_log::close_store::publish(&root, receipt.service_id, &bytes, trust);
            let _ = tx.send(result);
        });
    match tokio::time::timeout(Duration::from_millis(500), rx).await {
        Ok(Ok(Ok(()))) => Publication::Published,
        Ok(Ok(Err(e))) => Publication::Failed(availability(e)),
        Err(_) => Publication::UnknownTimeout,
        _ => Publication::Failed(Availability::Unavailable),
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct StopOutcome {
    pub receipt: Receipt,
    pub publication: Publication,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(version: u8) -> Vec<u8> {
        format!("{PREFIX}{}\n",serde_json::json!({"version":version,"outcome":"CLOSED","state":"CLOSED","accepted":"3","synced":"3","rejected":"0","incomplete":0,"first_failure":null})).into_bytes()
    }
    fn receipt(id: Uuid) -> Receipt {
        Receipt {
            version: 1,
            format: Format::V1,
            service_id: id,
            owned_pid: 123,
            started_at_ms: 1000,
            recorded_at_ms: 2000,
            shutdown_attempted: true,
            shutdown_ack: Ack::Acknowledged,
            request_error: None,
            exited: true,
            exit_code: Some(0),
            wait_error: None,
            kill_requested: false,
            kill_request_ok: None,
            reader: ReadSummary {
                join: ReaderJoin::Complete,
                eof: true,
                ..ReadSummary::default()
            },
        }
    }
    #[test]
    fn split_strict_decoder_never_retains_noise_and_rejects_ambiguous_or_partial_candidates() {
        let mut d = Decoder::new();
        d.push(b"SYNTHETIC_PRIVATE_TOKEN_NOISE\n");
        for b in line(1) {
            d.push(&[b]);
            assert!(d.line.len() <= LINE_LIMIT);
        }
        d.finish();
        let result = d.safe();
        assert!(result.diagnostic.is_some());
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("SYNTHETIC_PRIVATE")
        );
        for bytes in [
            [line(1), line(1)].concat(),
            line(2),
            format!("{PREFIX}{{bad SYNTHETIC_PRIVATE\n").into_bytes(),
            line(1)[..line(1).len() - 1].to_vec(),
            [PREFIX.as_bytes(), vec![b'x'; 5000].as_slice(), b"\n"].concat(),
        ] {
            let mut d = Decoder::new();
            d.push(&bytes);
            d.finish();
            assert!(d.safe().diagnostic.is_none());
            assert!(d.line.is_empty());
        }
    }
    #[tokio::test]
    async fn sustained_drain_and_abort_join_have_no_late_state_delivery() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut collector = Collector::start(reader);
        let sender = tokio::spawn(async move {
            writer.write_all(&vec![b'z'; 16384]).await.unwrap();
            writer.write_all(b"\n").await.unwrap();
            writer.write_all(&line(1)).await.unwrap();
        });
        sender.await.unwrap();
        let result = collector.finish().await;
        assert_eq!(result.join, ReaderJoin::Complete);
        assert!(result.diagnostic.is_some());
        let (mut writer, reader) = tokio::io::duplex(512);
        let mut collector = Collector::start(reader);
        writer.write_all(&line(1)).await.unwrap();
        let state = collector.snapshot.clone();
        let result = collector.finish().await;
        assert_eq!(result.join, ReaderJoin::Aborted);
        assert!(result.diagnostic.is_none());
        let before = serde_json::to_vec(&*state.lock().unwrap()).unwrap();
        assert!(writer.write_all(&line(1)).await.is_err());
        tokio::task::yield_now().await;
        assert_eq!(before, serde_json::to_vec(&*state.lock().unwrap()).unwrap());
    }
    #[tokio::test]
    async fn previous_binding_bad_version_and_current_service_separation_preserve_files() {
        let root = std::env::temp_dir().join(format!(
            "shared-terminal-close-model-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let id = Uuid::new_v4();
        let normal = receipt(id);
        assert!(!normal.attention());
        assert!(normal.validate(id));
        assert!(!normal.validate(Uuid::new_v4()));
        assert!(matches!(
            publish(root.clone(), normal.clone()).await,
            Publication::Published
        ));
        assert!(load(root.clone(), id, 3000).await.receipt.is_none());
        let prior = load(root.clone(), Uuid::new_v4(), 3000).await;
        assert_eq!(prior.receipt.unwrap().service_id, id);
        assert!(!prior.attention);
        assert!(
            load(root.clone(), Uuid::new_v4(), 1500)
                .await
                .receipt
                .is_none()
        );
        let mut failed = normal.clone();
        failed.exit_code = Some(1);
        assert!(failed.attention());
        failed.exit_code = Some(0);
        failed.reader.io_failed = true;
        assert!(!failed.attention());
        failed.kill_requested = true;
        failed.kill_request_ok = Some(false);
        assert!(failed.attention());
        let file = root
            .join(terminal_log::close_store::DIRECTORY)
            .join(format!("{id}.json"));
        let mut value = serde_json::to_value(normal).unwrap();
        value["version"] = serde_json::json!(2);
        let bytes = serde_json::to_vec(&value).unwrap();
        std::fs::write(&file, &bytes).unwrap();
        let loaded = load(root.clone(), Uuid::new_v4(), 3000).await;
        assert!(matches!(loaded.availability, Availability::Unsupported));
        assert!(!loaded.attention);
        let next = receipt(Uuid::new_v4());
        assert!(matches!(
            publish(root.clone(), next).await,
            Publication::Failed(Availability::Unsupported)
        ));
        assert_eq!(std::fs::read(file).unwrap(), bytes);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("shared-terminal-close-model-中文-")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
