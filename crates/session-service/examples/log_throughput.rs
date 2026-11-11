//! Opt-in synthetic Named Pipe -> production capture measurement. Never opens a device.
#[path = "../src/log_calibration_root.rs"]
mod log_calibration_root;
mod log_throughput_candidate;
#[cfg(feature = "t19-timeline-fixture")]
mod log_throughput_timeline;

use serde_json::{Value, json};
use session_core::{PROTOCOL_VERSION, pairing::SecretToken, session::ConnectionRef};
use session_protocol::{Hello, Reply, Request, Response, Sensitive, logging as log, write_frame};
use session_service::client::Client;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tokio::{
    process::Command,
    time::{sleep, timeout},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ErrorStage {
    Bootstrap,
    Handshake,
    Setup,
    Offering,
    Stop,
    Verification,
    FinalSample,
    Shutdown,
    ServiceExit,
}
#[derive(serde::Serialize)]
struct Cleanup {
    shutdown_attempted: bool,
    shutdown_ack: bool,
    shutdown_error: Option<String>,
    shutdown_request_s: f64,
    exited: bool,
    exit_code: Option<i32>,
    wait_error: Option<&'static str>,
    service_wait_s: f64,
    forced_kill_attempted: bool,
    forced_kill_ok: Option<bool>,
}
#[derive(Debug)]
enum CheckFailure {
    ScheduleDeadline,
    CaptureRejected,
    Constraint,
}
impl std::fmt::Display for CheckFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}
impl std::error::Error for CheckFailure {}
fn safe_error(e: &(dyn std::error::Error + Send + Sync + 'static)) -> String {
    if let Some(e) = e.downcast_ref::<CheckFailure>() {
        return match e {
            CheckFailure::ScheduleDeadline => "SCHEDULE_DEADLINE",
            CheckFailure::CaptureRejected => "CAPTURE_REJECTED_OR_GAP",
            CheckFailure::Constraint => "CHECK_FAILED",
        }
        .into();
    }
    if let Some(e) = e.downcast_ref::<io::Error>() {
        return match e.kind() {
            io::ErrorKind::UnexpectedEof => "UNEXPECTED_EOF",
            io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            io::ErrorKind::TimedOut => "TIMEOUT",
            io::ErrorKind::InvalidData => "INVALID_DATA",
            io::ErrorKind::NotConnected => "NOT_CONNECTED",
            _ => "IO_ERROR",
        }
        .into();
    }
    if e.is::<tokio::time::error::Elapsed>() {
        return "TIMEOUT".into();
    }
    "MEASUREMENT_ERROR".into()
}
fn finalized(result: Result<Value>, stage: ErrorStage, cleanup: Cleanup) -> Value {
    let clean = cleanup.shutdown_ack
        && cleanup.exited
        && cleanup.exit_code == Some(0)
        && !cleanup.forced_kill_attempted;
    let mut report = match result {
        Ok(v) => v,
        Err(e) => json!({"passed":false,"error":safe_error(e.as_ref()),"error_stage":stage}),
    };
    if !clean {
        report["passed"] = json!(false);
        if report["error"].is_null() {
            report["error"] = json!("SERVICE_CLEANUP_FAILED");
            report["error_stage"] = json!(if cleanup.shutdown_ack {
                ErrorStage::ServiceExit
            } else {
                ErrorStage::Shutdown
            });
        }
    }
    report["owned_service_clean_exit"] = json!(clean);
    report["cleanup"] = serde_json::to_value(cleanup).unwrap();
    report
}
const STREAMS: usize = 8;
const BLOCK: usize = 4096;
const HZ: u64 = 260;
const BATCH: u64 = 4;
const GIB: u64 = 1024 * 1024 * 1024;
struct Settings {
    seconds: u64,
    segment: u64,
    timeline: bool,
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn require(ok: bool, reason: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(match reason {
            "offering missed deadline; no end catch-up allowed" => CheckFailure::ScheduleDeadline,
            "explicit capture failure/rejection/gap" => CheckFailure::CaptureRejected,
            _ => CheckFailure::Constraint,
        }
        .into())
    }
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex(Sha256::digest(bytes.as_ref()).as_slice())
}
async fn offload<T: Send + 'static>(
    probe: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(probe).await?
}
async fn wait_slot(clock: tokio::time::Instant, start: Instant, n: u64) -> Result<(Duration, f64)> {
    let due = Duration::from_nanos(n * BATCH * 1_000_000_000 / HZ);
    tokio::time::sleep_until(clock + due).await;
    let late = start.elapsed().saturating_sub(due).as_secs_f64();
    require(
        late <= 0.250,
        "offering missed deadline; no end catch-up allowed",
    )?;
    Ok((due, late))
}
fn payload(stream: usize, seq: u64) -> Vec<u8> {
    let mut b = vec![b'A'; BLOCK];
    for (i, c) in b.iter_mut().enumerate() {
        *c = b'a' + ((i as u64 + seq * 7 + stream as u64 * 11) % 26) as u8;
    }
    let header = format!("P22|stream={stream}|seq={seq:016}|bytes={BLOCK}| ");
    b[..header.len()].copy_from_slice(header.as_bytes());
    let checksum = digest(&b[..BLOCK - 66]);
    b[BLOCK - 66] = b'|';
    b[BLOCK - 65..BLOCK - 1].copy_from_slice(checksum.as_bytes());
    b[BLOCK - 1] = b'\n';
    b
}
fn free(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut n = 0;
    require(
        unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                w.as_ptr(),
                &mut n,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } != 0,
        "disk free query failed",
    )?;
    Ok(n)
}
#[repr(C)]
#[derive(Default)]
struct Memory {
    cb: u32,
    faults: u32,
    peak_working: usize,
    working: usize,
    peak_paged: usize,
    paged: usize,
    peak_nonpaged: usize,
    nonpaged: usize,
    pagefile: usize,
    peak_pagefile: usize,
    private: usize,
}
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut std::ffi::c_void,
        counters: *mut Memory,
        size: u32,
    ) -> i32;
}
fn memory(pid: u32) -> Result<Value> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    require(!handle.is_null(), "cannot inspect own process memory")?;
    let mut m = Memory {
        cb: std::mem::size_of::<Memory>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetProcessMemoryInfo(handle, &mut m, std::mem::size_of::<Memory>() as u32) };
    unsafe {
        CloseHandle(handle);
    }
    require(ok != 0, "memory query failed")?;
    Ok(
        json!({"working":m.working,"private":m.private,"peak_working":m.peak_working,"peak_private":m.peak_pagefile}),
    )
}
fn disk_bytes(path: &Path) -> Result<u64> {
    let mut n = 0;
    for e in fs::read_dir(path)? {
        let e = e?;
        let m = e.file_type()?;
        require(
            !m.is_symlink(),
            "unexpected link in self-owned measurement root",
        )?;
        n += if m.is_dir() {
            disk_bytes(&e.path())?
        } else {
            e.metadata()?.len()
        };
    }
    Ok(n)
}
fn reply(response: Response) -> Result<Reply> {
    match response {
        Response::Ok { reply, .. } => Ok(reply),
        Response::Error { code, .. } => {
            Err(io::Error::other(format!("service rejected: {code:?}")).into())
        }
    }
}
async fn request(client: &mut Client, r: Request) -> Result<Reply> {
    reply(client.request(r).await?)
}
async fn info(client: &mut Client, c: ConnectionRef, id: Uuid) -> Result<log::Info> {
    match request(
        client,
        Request::Logging {
            request: log::Request::Status {
                connection: c,
                log_id: id,
            },
        },
    )
    .await?
    {
        Reply::Logging(log::Reply::Info(i)) => Ok(*i),
        _ => Err(io::Error::other("unexpected log status").into()),
    }
}
struct Verify {
    last: AtomicU64,
    done: AtomicBool,
    abort: AtomicBool,
    stats: Mutex<Value>,
}
fn verify_journals(root: PathBuf, id: Uuid, stream: usize, v: Arc<Verify>) -> Result<Value> {
    let mut next = 1;
    let mut count = 0u64;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    loop {
        if v.abort.load(Ordering::SeqCst) {
            return Err(io::Error::other("verification aborted").into());
        }
        let last = v.last.load(Ordering::SeqCst);
        let done = v.done.load(Ordering::SeqCst);
        if next < last || (done && next <= last) {
            let d = root.join("terminal-logs").join(id.to_string());
            // Ordinary File::open permits delete sharing; no production archive reader pins live retirement.
            let raw = File::open(d.join(format!("{next:016}.rawlog")))?;
            let text = File::open(d.join(format!("{next:016}.text.jsonl")))?;
            let mut pair =
                terminal_log::PairReader::new(BufReader::new(raw), BufReader::new(text))?;
            require(
                pair.header().segment == next && pair.header().source_cursor == count + 1,
                "cross-segment source discontinuity",
            )?;
            while let Some(r) = pair.next_record()? {
                let raw = r
                    .raw
                    .ok_or_else(|| io::Error::other("unexpected non-source record"))?;
                require(
                    raw.seq == count + 1 && raw.gap_bytes.is_none(),
                    "journal source gap/sequence mismatch",
                )?;
                let expected = payload(stream, count);
                require(raw.bytes == expected, "journal bytes/checksum mismatch")?;
                require(
                    r.text.text.as_bytes() == expected
                        && r.text.gap_bytes.is_none()
                        && !r.text.decode_error,
                    "JSONL text mismatch",
                )?;
                hash.update(&raw.bytes);
                bytes += raw.bytes.len() as u64;
                count += 1;
            }
            *v.stats.lock().unwrap() = json!({"segments":next,"records":count,"bytes":bytes});
            next += 1;
        } else if done {
            break;
        } else {
            thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(
        json!({"segments":next-1,"records":count,"bytes":bytes,"sha256":hex(hash.finalize().as_slice())}),
    )
}
struct Stream {
    connection: ConnectionRef,
    id: Uuid,
    verify: Arc<Verify>,
    join: Option<thread::JoinHandle<Result<Value>>>,
    expected: Sha256,
    count: u64,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.verify.abort.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}
struct Target {
    connection: ConnectionRef,
    id: Uuid,
    verify: Arc<Verify>,
}
fn targets(streams: &[Stream]) -> Vec<Target> {
    streams
        .iter()
        .map(|s| Target {
            connection: s.connection,
            id: s.id,
            verify: s.verify.clone(),
        })
        .collect()
}
async fn sample(client: &mut Client, streams: &[Target], root: &Path, pid: u32) -> Result<Value> {
    let phase_start = Instant::now();
    let mut logs = vec![];
    for s in streams {
        require(
            s.verify.stats.lock().unwrap()["error"].is_null(),
            "live verifier stopped; no tail-only fallback",
        )?;
        let i = info(client, s.connection, s.id).await?;
        if i.failure.is_some()
            || i.rejected_records != 0
            || i.rejected_raw_bytes != 0
            || i.source_gap_bytes != 0
        {
            let fault = json!({"stage":"capture","status":i});
            let path = root.join("first-fault.json");
            offload(move || {
                serde_json::to_writer_pretty(File::create_new(path)?, &fault)?;
                Ok(())
            })
            .await?;
            return Err(io::Error::other(format!(
                "capture failure {:?}; rejected_records={}; rejected_bytes={}; source_gap={}",
                i.failure, i.rejected_records, i.rejected_raw_bytes, i.source_gap_bytes
            ))
            .into());
        }
        s.verify.last.store(i.last_segment, Ordering::SeqCst);
        let verified = s.verify.stats.lock().unwrap().clone();
        // Before a segment disappears, its full prefix must already have been independently checked.
        require(
            verified["segments"].as_u64().unwrap_or(0) >= i.retired_segments,
            "retired segment was not verified in time",
        )?;
        logs.push(json!({"status":i,"verified_prefix":verified}));
    }
    let status_query_s = phase_start.elapsed().as_secs_f64();
    let audit_start = Instant::now();
    let audit = request(
        client,
        Request::RpcAudit {
            view: session_protocol::rpc_audit::View::JournalInfo {},
        },
    )
    .await?;
    let audit_query_s = audit_start.elapsed().as_secs_f64();
    let path = root.to_owned();
    let (service,harness,available,disk,probe_timing)=offload(move ||->Result<_>{
        let t=Instant::now();let service=memory(pid)?;let service_memory_s=t.elapsed().as_secs_f64();
        let t=Instant::now();let harness=memory(std::process::id())?;let harness_memory_s=t.elapsed().as_secs_f64();
        let t=Instant::now();let available=free(&path)?;let free_space_s=t.elapsed().as_secs_f64();
        let t=Instant::now();let disk=disk_bytes(&path)?;let disk_walk_s=t.elapsed().as_secs_f64();
        Ok((service,harness,available,disk,json!({"service_memory_s":service_memory_s,"harness_memory_s":harness_memory_s,"free_space_s":free_space_s,"disk_walk_s":disk_walk_s})))
    }).await?;
    require(
        available >= 16 * GIB + 16 * 1024 * 1024 && disk <= 8 * GIB - 16 * 1024 * 1024,
        "disk low-water/budget stop (16MiB drain reserve)",
    )?;
    require(
        service["private"].as_u64().unwrap() <= GIB && service["working"].as_u64().unwrap() <= GIB,
        "service memory budget stop",
    )?;
    require(
        harness["private"].as_u64().unwrap() <= GIB / 2
            && harness["working"].as_u64().unwrap() <= GIB / 2,
        "harness memory budget stop",
    )?;
    Ok(
        json!({"logs":logs,"audit":audit,"service_memory":service,"harness_memory":harness,"disk_bytes":disk,"disk_available":available,"timing":{"status_query_s":status_query_s,"audit_query_s":audit_query_s,"blocking_probes":probe_timing}}),
    )
}
async fn measured(
    client: &mut Client,
    mut monitor_client: Client,
    streams: &mut [Stream],
    root: &Path,
    pid: u32,
    seconds: u64,
    timeline: bool,
) -> Result<Value> {
    let total = seconds * HZ / BATCH;
    let mut buckets = vec![0u64; seconds as usize + 1];
    let mut generated = 0u64;
    let mut acked = 0u64;
    let mut max_late = 0f64;
    let mut max_rpc = 0f64;
    let mut slow_rpcs = Vec::<Value>::new();
    let mut first_ack = None;
    let mut last_ack = 0f64;
    let mut timeline_gate_rejected_bytes = 0;
    let start = Instant::now();
    let started_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    let clock = tokio::time::Instant::now();
    let stop = Arc::new(AtomicBool::new(false));
    let monitor_error = Arc::new(Mutex::new(None::<String>));
    let generated_counter = Arc::new(AtomicU64::new(0));
    let acked_counter = Arc::new(AtomicU64::new(0));
    let observe = {
        let stop = stop.clone();
        let error = monitor_error.clone();
        let gen_count = generated_counter.clone();
        let ack_count = acked_counter.clone();
        let root = root.to_owned();
        let ts = targets(streams);
        tokio::spawn(async move {
            let result:Result<()>=async {
                let mut progress=BufWriter::new(File::create(root.join("progress.jsonl"))?);
                let mut tick=tokio::time::interval(Duration::from_secs(1));tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);let mut last_print=0;
                loop {
                    tick.tick().await;if stop.load(Ordering::SeqCst){break;}
                    let sample_started=Instant::now();let snapshot=sample(&mut monitor_client,&ts,&root,pid).await?;
                    let elapsed=start.elapsed().as_secs_f64();let g=gen_count.load(Ordering::SeqCst);let a=ack_count.load(Ordering::SeqCst);
                    serde_json::to_writer(&mut progress,&json!({"elapsed":elapsed,"generated_bytes":g,"ipc_ack_bytes":a,"sample_wall_s":sample_started.elapsed().as_secs_f64(),"sample":snapshot}))?;writeln!(progress)?;progress.flush()?;
                    if elapsed as u64>=last_print {
                        println!("PROGRESS {}",json!({"elapsed":elapsed,"generated":g,"acked":a,"disk":snapshot["disk_bytes"],"service_private":snapshot["service_memory"]["private"]}));io::stdout().flush()?;last_print=elapsed as u64+30;
                    }
                }Ok(())
            }.await;
            if let Err(e) = result {
                *error.lock().unwrap() = Some(safe_error(e.as_ref()));
            }
        })
    };
    let outcome: Result<()> = async {
        for n in 0..total {
            let (due,late)=wait_slot(clock,start,n).await?;
            if let Some(e) = monitor_error.lock().unwrap().clone() {
                return Err(io::Error::other(e).into());
            }
            let elapsed = start.elapsed();
            max_late = max_late.max(late);
            require(
                elapsed < Duration::from_secs(seconds) && late <= 0.250,
                "offering missed deadline; no end catch-up allowed",
            )?;
            let s = &mut streams[n as usize % STREAMS];
            let mut b = Vec::with_capacity(BLOCK * BATCH as usize);
            for seq in s.count..s.count + BATCH {
                b.extend(payload(n as usize % STREAMS, seq));
            }
            generated += BLOCK as u64 * BATCH;
            generated_counter.store(generated, Ordering::SeqCst);
            let expected = if timeline {
                let mut expected = s.expected.clone();
                expected.update(&b);
                Some(expected)
            } else {
                s.expected.update(&b);
                s.count += BATCH;
                None
            };
            let rpc = Instant::now();
            let request_started_s=start.elapsed().as_secs_f64();
            let response = client.request(
                Request::AppendFixture {
                    connection: s.connection,
                    bytes: b,
                },
            )
            .await;
            if timeline && matches!(&response, Ok(Response::Error {
                code: session_core::session::ErrorCode::CapacityExceeded, ..
            })) {
                timeline_gate_rejected_bytes = BLOCK as u64 * BATCH;
                return Err(CheckFailure::CaptureRejected.into());
            }
            if let Some(expected) = expected {
                s.expected = expected;
                s.count += BATCH;
            }
            reply(response?)?;
            max_rpc = max_rpc.max(rpc.elapsed().as_secs_f64());
            acked += BLOCK as u64 * BATCH;
            acked_counter.store(acked, Ordering::SeqCst);
            last_ack = start.elapsed().as_secs_f64();
            let rpc_seconds=rpc.elapsed().as_secs_f64();
            if rpc_seconds>=0.050 {slow_rpcs.push(json!({"rpc_no":n,"stream":n as usize%STREAMS,"scheduled_s":due.as_secs_f64(),"request_started_s":request_started_s,"ack_s":last_ack,"rpc_s":rpc_seconds}));slow_rpcs.sort_by(|a,b|b["rpc_s"].as_f64().unwrap().total_cmp(&a["rpc_s"].as_f64().unwrap()));slow_rpcs.truncate(16);}
            if first_ack.is_none() {
                first_ack = Some(last_ack);
            }
            buckets[start.elapsed().as_secs().min(seconds) as usize] += BLOCK as u64 * BATCH;
        }
        tokio::time::sleep_until(clock + Duration::from_secs(seconds)).await;
        Ok(())
    }
    .await;
    let elapsed = start.elapsed().as_secs_f64();
    stop.store(true, Ordering::SeqCst);
    observe.await?;
    let error = outcome
        .err()
        .map(|e| safe_error(e.as_ref()))
        .or(monitor_error.lock().unwrap().clone());
    let mut report = json!({"error":error,"generated_bytes":generated,"ipc_ack_bytes":acked,"elapsed_s":elapsed,"generated_bytes_per_wall_second":generated as f64/elapsed,"ipc_bytes_per_wall_second":acked as f64/elapsed,"first_ack_s":first_ack,"last_ack_s":last_ack,"second_buckets_bytes":buckets,"max_schedule_late_s":max_late,"max_rpc_s":max_rpc,"started_unix_ms":started_unix_ms,"slow_rpcs":slow_rpcs,"runtime_workers":tokio::runtime::Handle::current().metrics().num_workers(),"batch_blocks":BATCH});
    if timeline {
        report["timeline_gate_rejected_bytes"] = json!(timeline_gate_rejected_bytes);
    }
    Ok(report)
}
async fn run(
    client: &mut Client,
    monitor_client: Client,
    root: &Path,
    pid: u32,
    settings: Settings,
    phase: &Mutex<ErrorStage>,
) -> Result<Value> {
    let Settings {
        seconds,
        segment,
        timeline,
    } = settings;
    *phase.lock().unwrap() = ErrorStage::Setup;
    let mut streams = vec![];
    for index in 0..STREAMS {
        let Reply::Connection(c) = request(client, Request::CreateFixture {}).await? else {
            return Err(io::Error::other("expected fixture connection").into());
        };
        let connection = c.reference();
        let Reply::Logging(log::Reply::Info(i)) = request(
            client,
            Request::Logging {
                request: log::Request::Start {
                    connection,
                    request_id: Uuid::new_v4(),
                    limits: log::Limits {
                        segment_bytes: segment,
                        segments: 2,
                    },
                },
            },
        )
        .await?
        else {
            return Err(io::Error::other("expected log start").into());
        };
        let id = i.log_id;
        let v = Arc::new(Verify {
            last: AtomicU64::new(1),
            done: AtomicBool::new(false),
            abort: AtomicBool::new(false),
            stats: Mutex::new(json!({"segments":0,"bytes":0,"records":0})),
        });
        let vr = v.clone();
        let path = root.to_path_buf();
        let join = thread::spawn(move || {
            let result = verify_journals(path, id, index, vr.clone());
            if let Err(e) = &result {
                vr.stats.lock().unwrap()["error"] = json!(safe_error(e.as_ref()));
            }
            result
        });
        streams.push(Stream {
            connection,
            id,
            verify: v,
            join: Some(join),
            expected: Sha256::new(),
            count: 0,
        });
    }
    // Opening must settle before timing begins.
    for s in &streams {
        timeout(Duration::from_secs(10), async {
            loop {
                let i = info(client, s.connection, s.id).await?;
                if matches!(i.phase, log::Phase::Recording) {
                    return Ok::<(), Box<dyn std::error::Error + Send + Sync>>(());
                }
                require(i.failure.is_none(), "log open failed")?;
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await??;
    }
    *phase.lock().unwrap() = ErrorStage::Offering;
    let load = measured(
        client,
        monitor_client,
        &mut streams,
        root,
        pid,
        seconds,
        timeline,
    )
    .await;
    *phase.lock().unwrap() = ErrorStage::Stop;
    let mut final_status = vec![];
    let mut stop_error = None;
    for s in &streams {
        let result = async {
            request(
                client,
                Request::Logging {
                    request: log::Request::Stop {
                        connection: s.connection,
                        log_id: s.id,
                    },
                },
            )
            .await?;
            timeout(Duration::from_secs(15), async {
                loop {
                    let i = info(client, s.connection, s.id).await?;
                    if i.worker_finished {
                        return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(i);
                    }
                    sleep(Duration::from_millis(20)).await;
                }
            })
            .await?
        }
        .await;
        match result {
            Ok(i) => {
                s.verify.last.store(i.last_segment, Ordering::SeqCst);
                final_status.push(i);
            }
            Err(e) => {
                stop_error.get_or_insert_with(|| safe_error(e.as_ref()));
                s.verify.abort.store(true, Ordering::SeqCst);
            }
        }
        s.verify.done.store(true, Ordering::SeqCst);
    }
    *phase.lock().unwrap() = ErrorStage::Verification;
    let mut verified = vec![];
    let mut verification_error = None;
    serde_json::to_writer_pretty(
        File::create(root.join("stopped-counters.json"))?,
        &json!({"load":load.as_ref().ok(),"final_status":final_status,"stop_error":stop_error,"source_blocks":streams.iter().map(|s|s.count).collect::<Vec<_>>(),"audit":request(client,Request::RpcAudit{view:session_protocol::rpc_audit::View::JournalInfo{}}).await.ok()}),
    )?;
    for (index, s) in streams.iter_mut().enumerate() {
        match s.join.take().unwrap().join() {
            Ok(Ok(v)) => verified.push(v),
            Ok(Err(e)) => {
                verification_error.get_or_insert_with(|| safe_error(e.as_ref()));
                continue;
            }
            Err(_) => {
                verification_error.get_or_insert_with(|| "VERIFIER_PANICKED".into());
                continue;
            }
        }
        let expected = hex(s.expected.clone().finalize().as_slice());
        let v = verified.last().unwrap();
        if v["records"] != s.count || v["sha256"] != expected {
            verification_error.get_or_insert_with(|| "FULL_JOURNAL_MISMATCH".into());
        }
        let live_check: Result<()> = (|| {
            if let Some(status) = final_status.get(index) {
                let readable = status
                    .readable
                    .as_ref()
                    .ok_or_else(|| io::Error::other("missing live text status"))?;
                let mut input =
                    BufReader::new(File::open(root.join("logs").join(&readable.filename))?);
                let header = format!(
                    "# 终端通信日志 UTF-8\r\n# 日志 {}；连接 {} / {}\r\n# 仅起录后的接收输出/终端回显；不含认证表单，未独立记录发送；起录前内容未记录。\r\n",
                    s.id, s.connection.connection_id.0, s.connection.generation
                );
                let mut actual_header = vec![0; header.len()];
                input.read_exact(&mut actual_header)?;
                require(actual_header == header.as_bytes(), "live header mismatch")?;
                let mut hash = Sha256::new();
                for seq in 0..s.count {
                    let mut block = vec![0; BLOCK];
                    input.read_exact(&mut block)?;
                    require(
                        block == payload(index, seq),
                        "live file byte/sequence mismatch",
                    )?;
                    hash.update(&block);
                }
                let mut tail = [0];
                require(input.read(&mut tail)? == 0, "unexpected live suffix")?;
                require(
                    hex(hash.finalize().as_slice()) == expected,
                    "independent live digest mismatch",
                )?;
                require(
                    status.accepted_records == s.count
                        && status.written_records == s.count
                        && status.accepted_raw_bytes == s.count * BLOCK as u64
                        && status.written_raw_bytes == s.count * BLOCK as u64
                        && status.rejected_records == 0
                        && status.source_gap_bytes == 0
                        && status.durable
                        && status.failure.is_none(),
                    "final capture conservation/durability failed",
                )?;
                require(
                    readable.written_bytes == header.len() as u64 + s.count * BLOCK as u64
                        && readable.flushed_bytes == readable.written_bytes
                        && readable.synced_bytes == readable.written_bytes,
                    "written/flush/sync counters differ",
                )?;
            }
            Ok(())
        })();
        if let Err(e) = live_check {
            verification_error.get_or_insert_with(|| safe_error(e.as_ref()));
        }
    }
    *phase.lock().unwrap() = ErrorStage::FinalSample;
    let final_sample_result = sample(client, &targets(&streams), root, pid).await;
    let error_stage =
        if load.as_ref().is_err() || load.as_ref().is_ok_and(|v| !v["error"].is_null()) {
            Some(ErrorStage::Offering)
        } else if stop_error.is_some() {
            Some(ErrorStage::Stop)
        } else if verification_error.is_some() {
            Some(ErrorStage::Verification)
        } else if final_sample_result.is_err() {
            Some(ErrorStage::FinalSample)
        } else {
            None
        };
    let error = load
        .as_ref()
        .err()
        .map(|e| safe_error(e.as_ref()))
        .or_else(|| {
            load.as_ref()
                .ok()
                .and_then(|v| v["error"].as_str())
                .map(str::to_owned)
        })
        .or(stop_error)
        .or(verification_error.clone())
        .or_else(|| {
            final_sample_result
                .as_ref()
                .err()
                .map(|e| safe_error(e.as_ref()))
        });
    let min = load
        .as_ref()
        .ok()
        .and_then(|v| v["second_buckets_bytes"].as_array())
        .map(|a| {
            a[..seconds as usize]
                .iter()
                .map(|x| x.as_u64().unwrap())
                .min()
                .unwrap_or(0)
        });
    let pass = error.is_none()
        && min.is_some_and(|n| n >= 1024 * 1024)
        && load.as_ref().is_ok_and(|v| {
            v["generated_bytes"] == seconds * HZ * BLOCK as u64
                && v["ipc_ack_bytes"] == v["generated_bytes"]
        });
    Ok(
        json!({"passed":pass,"error":error,"error_stage":error_stage,"verification_error":verification_error,"duration_seconds":seconds,"streams":STREAMS,"block_bytes":BLOCK,"offered_bytes_per_second":HZ*BLOCK as u64,"minimum_complete_second_ipc_bytes":min,"load":load.ok(),"final_status":final_status,"full_journal_verification":verified,"final_sample":final_sample_result.ok(),"scope":"Named Pipe synthetic append -> production parser/capture/raw+JSONL+live text; not SSH/UART or GUI"}),
    )
}
#[cfg(test)]
mod instrument_tests {
    use super::*;
    fn cleanup_for_test() -> Cleanup {
        Cleanup {
            shutdown_attempted: true,
            shutdown_ack: true,
            shutdown_error: None,
            shutdown_request_s: 0.0,
            exited: true,
            exit_code: Some(1),
            wait_error: None,
            service_wait_s: 0.0,
            forced_kill_attempted: false,
            forced_kill_ok: None,
        }
    }
    #[test]
    fn safe_error_cleanup_preserves_primary_err_and_real_exit_without_fake_kill() {
        let report = finalized(
            Err(io::Error::other("SYNTHETIC_PRIVATE_BODY_PATH_TOKEN").into()),
            ErrorStage::Verification,
            cleanup_for_test(),
        );
        assert_eq!(report["error_stage"], "VERIFICATION");
        assert_eq!(report["error"], "IO_ERROR");
        assert_eq!(report["cleanup"]["exit_code"], 1);
        assert_eq!(report["cleanup"]["forced_kill_attempted"], false);
        assert!(!report.to_string().contains("SYNTHETIC_PRIVATE"));
        let report = finalized(
            Ok(
                json!({"passed":false,"error":"CAPTURE_FAILED","error_stage":"OFFERING","load":{"accepted":7}}),
            ),
            ErrorStage::FinalSample,
            cleanup_for_test(),
        );
        assert_eq!(report["error"], "CAPTURE_FAILED");
        assert_eq!(report["error_stage"], "OFFERING");
        assert_eq!(report["load"]["accepted"], 7);
        let mut cleanup = cleanup_for_test();
        cleanup.shutdown_ack = false;
        cleanup.exit_code = Some(0);
        let report = finalized(
            Ok(json!({"passed":true,"error":null})),
            ErrorStage::FinalSample,
            cleanup,
        );
        assert_eq!(report["error_stage"], "SHUTDOWN");
        assert_eq!(report["passed"], false);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn instrument_slow_probe_does_not_pause_scheduled_generator() -> Result<()> {
        let active = Arc::new(AtomicU64::new(0));
        let peak = Arc::new(AtomicU64::new(0));
        let monitor = {
            let active = active.clone();
            let peak = peak.clone();
            tokio::spawn(async move {
                for _ in 0..4 {
                    let active = active.clone();
                    let peak = peak.clone();
                    offload(move || {
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(350));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await?;
                }
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            })
        };
        let clock = tokio::time::Instant::now();
        let start = Instant::now();
        let mut max_late = 0f64;
        for n in 0..130 {
            let (_, late) = wait_slot(clock, start, n).await?;
            max_late = max_late.max(late);
            let mut bytes = vec![];
            for k in 0..BATCH {
                bytes.extend(payload(0, n * BATCH + k));
            }
            let request = Request::AppendFixture {
                connection: ConnectionRef {
                    connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
                    generation: 1,
                },
                bytes,
            };
            let encoded = serde_json::to_vec(&request)?;
            require(
                encoded.len() < session_protocol::MAX_FRAME,
                "instrument encoding frame budget",
            )?;
        }
        monitor.await??;
        require(
            active.load(Ordering::SeqCst) == 0 && peak.load(Ordering::SeqCst) == 1,
            "probes must never overlap or queue without bound",
        )?;
        println!(
            "INSTRUMENT_SELF_CHECK {}",
            json!({"slots":130,"elapsed_s":start.elapsed().as_secs_f64(),"max_lateness_s":max_late,"runtime_workers":tokio::runtime::Handle::current().metrics().num_workers(),"slow_probe_ms":350,"probes":4,"peak_concurrent":peak.load(Ordering::SeqCst),"production_service_started":false})
        );
        Ok(())
    }
}
async fn execute() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    let mode = args.get(4).and_then(|value| value.to_str());
    let timeline = matches!(mode, Some("--d-tmp-timeline" | "--check-timeline"));
    let timeline_smoke = mode == Some("--check-timeline");
    let candidate_mode =
        timeline || matches!(mode, Some("--d-tmp-calibrate" | "--check-d-tmp-root"));
    let ordinary_probe = mode == Some("--probe-ordinary");
    require(
        !timeline || cfg!(feature = "t19-timeline-fixture"),
        "timeline feature required",
    )?;
    require(
        args.len() == 4 || (args.len() == 5 && (candidate_mode || ordinary_probe)),
        "invalid measurement mode",
    )?;
    let seconds = args[2].to_str().unwrap().parse::<u64>()?;
    let segment = args[3].to_str().unwrap().parse::<u64>()? * 1024 * 1024;
    require(
        if candidate_mode || ordinary_probe {
            seconds == 32 && segment == 1048576
        } else {
            matches!(seconds, 20..=60 | 1800) && matches!(segment, 1048576 | 104857600)
        },
        "bounded calibration or formal parameters only",
    )?;
    let requested = Path::new(&args[1]);
    let candidate = candidate_mode
        .then(|| log_throughput_candidate::Candidate::create(requested))
        .transpose()?;
    if mode == Some("--check-d-tmp-root") {
        let owned = candidate.unwrap();
        let child = owned.path.join("guard-check");
        fs::create_dir(&child)?;
        fs::write(child.join("sentinel"), b"owned")?;
        require(
            log_throughput_candidate::Candidate::create(requested)
                .is_err_and(|e| e.kind() == io::ErrorKind::AlreadyExists),
            "existing candidate root must be rejected",
        )?;
        require(
            fs::read(child.join("sentinel"))? == b"owned",
            "existing candidate contents must remain untouched",
        )?;
        owned.remove_owned()?;
        println!("PASS candidate guard, existing-root refusal and owned root removal");
        return Ok(());
    }
    let workspace = fs::canonicalize(std::env::current_dir()?.join("artifacts"))?;
    let root = if let Some(owned) = &candidate {
        owned.path.clone()
    } else {
        let root = fs::canonicalize(requested)?;
        let prefix = if ordinary_probe {
            "P22-throughput-ordinary-中文-"
        } else {
            "P22-throughput-中文-"
        };
        require(
            root.parent() == Some(workspace.as_path())
                && root
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(prefix)),
            "only fresh own workspace artifact roots",
        )?;
        require(
            fs::read_dir(&root)?.next().is_none(),
            "measurement root must be empty",
        )?;
        root
    };
    let initial_free = if ordinary_probe {
        None
    } else {
        Some(free(&root)?)
    };
    require(
        initial_free.is_none_or(|bytes| bytes >= 24 * GIB),
        "requires 8GiB budget plus 16GiB reserve",
    )?;
    let instance = Uuid::new_v4().to_string();
    let token = SecretToken::generate();
    let executable = if timeline {
        "target/debug/session-service-t19-timeline.exe"
    } else {
        "target/debug/session-service.exe"
    };
    let mut command = Command::new(std::env::current_dir()?.join(executable));
    command.args(["--instance", &instance]);
    if !ordinary_probe {
        command.arg("--test-fixture");
    }
    let stderr = if timeline {
        command.arg("--t19-timeline-fixture");
        let id = candidate.as_ref().unwrap().id;
        File::create_new(workspace.join(format!("P22-throughput-d-tmp-{id}-service-stderr.txt")))?
    } else {
        File::create(root.join("service-stderr.txt"))?
    };
    let mut child = command
        .arg("--data-dir")
        .arg(if timeline { requested } else { &root })
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(if timeline {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true)
        .spawn()?;
    #[cfg(feature = "t19-timeline-fixture")]
    let timeline_reader = child
        .stdout
        .take()
        .map(|output| tokio::spawn(log_throughput_timeline::read(output)));
    let pid = child.id().unwrap();
    let phase = Mutex::new(ErrorStage::Bootstrap);
    let mut client = None;
    let result: Result<Value> = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("private bootstrap unavailable"))?;
        write_frame(
            &mut stdin,
            &Hello {
                protocol_version: PROTOCOL_VERSION,
                client_name: "p22-synthetic-measurement".into(),
                token: Sensitive::new(token.expose().to_string()),
            },
        )
        .await?;
        drop(stdin);
        *phase.lock().unwrap() = ErrorStage::Handshake;
        client = Some(Client::connect(&instance, token.expose(), pid).await?.0);
        if ordinary_probe {
            let client = client.as_mut().unwrap();
            require(
                matches!(request(client, Request::List {}).await?, Reply::Sessions(items) if items.is_empty()),
                "ordinary service sessions must be empty",
            )?;
            require(
                matches!(
                    client.request(Request::CreateFixture {}).await?,
                    Response::Error { code: session_core::session::ErrorCode::Unsupported, .. }
                ),
                "ordinary service must reject fixture creation",
            )?;
            return Ok(json!({"passed":true,"ordinary_runtime_fixture_denied":true}));
        }
        #[cfg(feature = "t19-timeline-fixture")]
        if timeline_smoke {
            return log_throughput_timeline::smoke(client.as_mut().unwrap(), segment).await;
        }
        let monitor_client = Client::connect(&instance, token.expose(), pid).await?.0;
        run(
            client.as_mut().unwrap(),
            monitor_client,
            &root,
            pid,
            Settings { seconds, segment, timeline },
            &phase,
        )
        .await
    }
    .await;
    let first_stage = *phase.lock().unwrap();
    let shutdown_started = Instant::now();
    let shutdown_attempted = client.is_some();
    let shutdown = match client.as_mut() {
        Some(c) => Some(request(c, Request::Shutdown {}).await),
        None => None,
    };
    let shutdown_ack = matches!(&shutdown, Some(Ok(Reply::Ok)));
    let shutdown_error = shutdown
        .as_ref()
        .and_then(|r| r.as_ref().err())
        .map(|e| safe_error(e.as_ref()));
    let shutdown_request_s = shutdown_started.elapsed().as_secs_f64();
    drop(client);
    let wait_started = Instant::now();
    let waited = timeout(Duration::from_secs(15), child.wait()).await;
    let mut forced = false;
    let mut forced_ok = None;
    let mut wait_error = None;
    let exit = match waited {
        Ok(Ok(status)) => Some(status),
        other => {
            wait_error = Some(if other.is_err() {
                "TIMEOUT"
            } else {
                "WAIT_IO_ERROR"
            });
            forced = true;
            forced_ok = Some(child.kill().await.is_ok());
            timeout(Duration::from_secs(5), child.wait())
                .await
                .ok()
                .and_then(|r| r.ok())
        }
    };
    let cleanup = Cleanup {
        shutdown_attempted,
        shutdown_ack,
        shutdown_error,
        shutdown_request_s,
        exited: exit.is_some(),
        exit_code: exit.and_then(|s| s.code()),
        wait_error,
        service_wait_s: wait_started.elapsed().as_secs_f64(),
        forced_kill_attempted: forced,
        forced_kill_ok: forced_ok,
    };
    let mut report = finalized(result, first_stage, cleanup);
    #[cfg(feature = "t19-timeline-fixture")]
    if let Some(reader) = timeline_reader {
        let evidence = match reader.await {
            Ok(Ok(envelope)) => log_throughput_timeline::save(
                envelope,
                &workspace,
                candidate.as_ref().unwrap().id,
                timeline_smoke,
            ),
            Ok(Err(error)) => Err(error),
            Err(error) => Err(error.into()),
        };
        let evidence = evidence
            .unwrap_or_else(|error| json!({"saved":false,"error":safe_error(error.as_ref())}));
        if evidence["workers_closed"] != true
            || evidence["smoke_passed"] != true
            || !evidence["first_fault"].is_null()
        {
            report["passed"] = json!(false);
            if report["error"].is_null() {
                report["error"] = json!(if evidence["first_fault"].is_null() {
                    "TIMELINE_EVIDENCE_FAILED"
                } else {
                    "TIMELINE_CAPTURE_FAULT"
                });
                report["error_stage"] = json!(if evidence["first_fault"].is_null() {
                    ErrorStage::ServiceExit
                } else {
                    ErrorStage::Offering
                });
            }
        }
        report["timeline"] = evidence;
    }
    if candidate.is_some() {
        report["candidate_free_bytes_at_start"] = json!(initial_free);
    }
    let clean = report["owned_service_clean_exit"] == true;
    serde_json::to_writer_pretty(File::create(root.join("result.json"))?, &report)?;
    if let Some(owned) = candidate {
        serde_json::to_writer_pretty(
            File::create_new(workspace.join(format!("P22-throughput-d-tmp-{}.json", owned.id)))?,
            &report,
        )?;
        if clean && report["passed"] == true {
            owned.remove_owned()?;
        }
    }
    println!(
        "RESULT {}",
        json!({"passed":report["passed"],"error":report["error"],"clean_exit":clean})
    );
    require(
        clean && report["passed"] == true,
        "measurement failed; preserve actual evidence",
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    execute()
        .await
        .map_err(|e| io::Error::other(safe_error(e.as_ref())).into())
}
