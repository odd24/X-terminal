//! Compiled out of ordinary Desktop. No renderer command or exported capability.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use session_core::session::{ConnectionRef, OutputPage, Protocol, State};
use session_protocol::{ClientKind, Reply, Request, Response};
use session_service::client::Client;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;
type Shared = Arc<Mutex<std::result::Result<crate::service::Service, String>>>;
type Result<T> = std::result::Result<T, &'static str>;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    service_id: Uuid,
    connections: Vec<ConnectionRef>,
    seconds: u64,
    preflight_only: bool,
}
impl Plan {
    fn rotation(&self) -> Option<(Duration, u64)> {
        match self.seconds {
            25 => Some((Duration::from_secs(12), 25_000)),
            7_200 => Some((Duration::from_secs(1200), 1_800_000)),
            _ => None,
        }
    }
    fn frames(&self) -> u64 {
        if self.rotation().is_some() {
            self.seconds.div_ceil(10)
        } else {
            self.seconds * 21
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Go {
    start_unix_ms: u64,
}
#[derive(Serialize)]
struct Stream {
    connection: ConnectionRef,
    cursor: u64,
    frames: u64,
    bytes: u64,
    inside_bytes: u64,
    late_bytes: u64,
    max_available_from: u64,
    #[serde(skip)]
    pending: Vec<u8>,
    #[serde(skip)]
    hash: Sha256,
}
impl Stream {
    fn new(connection: ConnectionRef, cursor: u64) -> Self {
        Self {
            connection,
            cursor,
            frames: 0,
            bytes: 0,
            inside_bytes: 0,
            late_bytes: 0,
            max_available_from: 1,
            pending: vec![],
            hash: Sha256::new(),
        }
    }
    fn accept(&mut self, page: OutputPage, index: usize, go: &Go, seconds: u64) -> Result<()> {
        if page.connection != self.connection || page.truncated || page.disconnected {
            return Err("observer target/retention/disconnect");
        }
        self.max_available_from = self.max_available_from.max(page.available_from);
        for event in page.events {
            if event.gap_bytes.is_some_and(|b| b > 0) {
                return Err("observer source gap");
            }
            self.pending.extend_from_slice(&event.bytes);
            while self.pending.len() >= 1024 {
                let frame = &self.pending[..1024];
                let mut expected = vec![b'a' + ((index as u64 + self.frames) % 26) as u8; 1024];
                let header = format!("T18|{index:02}|{:08}|", self.frames);
                expected[..header.len()].copy_from_slice(header.as_bytes());
                expected[1023] = 10;
                if frame != expected {
                    return Err("observer exact frame/sequence mismatch");
                }
                self.hash.update(frame);
                self.frames += 1;
                self.bytes += 1024;
                if event.timestamp_ms >= go.start_unix_ms
                    && event.timestamp_ms < go.start_unix_ms + seconds * 1000
                {
                    self.inside_bytes += 1024;
                } else {
                    self.late_bytes += 1024;
                }
                self.pending.drain(..1024);
            }
            if self.pending.len() >= 1024 {
                return Err("observer pending bound");
            }
        }
        self.cursor = page.next_cursor;
        Ok(())
    }
    fn summary(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap();
        v["sha256"] = json!(
            self.hash
                .clone()
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        v["pending_bytes"] = json!(self.pending.len());
        v
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn read<T: serde::de::DeserializeOwned>(root: &Path, name: &str) -> Result<Option<T>> {
    let path = root.join(name);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("observer file metadata"),
    };
    if !meta.is_file() || meta.len() > 16384 {
        return Err("observer fixed input bound");
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "observer input open")?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "observer input read")?;
    if bytes.len() > 16384 {
        return Err("observer fixed input bound");
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "observer input schema")
}
fn write(root: &Path, name: &str, value: Value) -> Result<()> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "observer summary encode")?;
    if bytes.len() > 32768 {
        return Err("observer summary bound");
    }
    let temp = root.join(format!("{name}.tmp"));
    std::fs::write(&temp, bytes).map_err(|_| "observer summary write")?;
    std::fs::rename(temp, root.join(name)).map_err(|_| "observer summary publish")
}
async fn primary(shared: &Shared, request: Request) -> Result<Reply> {
    shared
        .lock()
        .await
        .as_mut()
        .map_err(|_| "observer service unavailable")?
        .request(request)
        .await
        .map_err(|_| "observer Desktop request failed")
}
fn read_request(c: ConnectionRef, cursor: u64) -> Request {
    Request::Read {
        connection: c,
        cursor,
        max_bytes: 65536,
    }
}
async fn page(client: &mut Client, c: ConnectionRef, cursor: u64) -> Result<OutputPage> {
    match client
        .request(read_request(c, cursor))
        .await
        .map_err(|_| "observer IPC unknown; no retry")?
    {
        Response::Ok {
            reply: Reply::Output(p),
            ..
        } => Ok(p),
        _ => Err("observer read denied/invalid"),
    }
}
async fn denied(client: &mut Client, request: Request) -> Result<()> {
    match client
        .request(request)
        .await
        .map_err(|_| "observer denial transport failure")?
    {
        Response::Error {
            code: session_core::session::ErrorCode::PermissionDenied,
            ..
        } => Ok(()),
        _ => Err("observer expected PermissionDenied"),
    }
}
async fn issue(
    shared: &Shared,
    plan: &Plan,
    scopes: Vec<ConnectionRef>,
    lifetime_ms: u64,
    active: &mut Vec<Uuid>,
) -> Result<(Client, Uuid, u64)> {
    let reply = primary(
        shared,
        Request::IssueRead {
            scopes,
            lifetime_ms,
        },
    )
    .await?;
    let Reply::ReadTicket {
        ticket_id,
        token,
        expires_at_ms,
    } = reply
    else {
        return Err("observer ticket reply");
    };
    active.push(ticket_id);
    let endpoint = shared
        .lock()
        .await
        .as_ref()
        .map_err(|_| "observer service unavailable")?
        .endpoint()
        .map_err(|_| "observer endpoint")?;
    if endpoint.2 != plan.service_id {
        return Err("observer stale service");
    }
    let (client, response) = Client::connect(&endpoint.0, token.expose(), endpoint.1)
        .await
        .map_err(|_| "observer private handshake failed")?;
    if !observer_welcome(response, plan.service_id) {
        return Err("observer welcome binding");
    }
    Ok((client, ticket_id, expires_at_ms))
}
fn observer_welcome(response: Response, service_id: Uuid) -> bool {
    // Observer Welcome identifies this pipe, unlike Agent Welcome's ticket ID.
    matches!(response,Response::Ok {reply:Reply::Welcome(w),..} if w.service_id==service_id && !w.client_id.is_nil() && matches!(w.kind,ClientKind::Observer))
}
async fn revoke(shared: &Shared, id: Uuid, active: &mut Vec<Uuid>) -> Result<()> {
    if !matches!(
        primary(shared, Request::Revoke { ticket_id: id }).await?,
        Reply::Ok
    ) {
        return Err("observer revoke reply");
    }
    active.retain(|v| *v != id);
    Ok(())
}
fn binding(
    plan: &Plan,
    all: &[session_core::session::ConnectionInfo],
    service_id: Uuid,
) -> Result<()> {
    if (!matches!(plan.seconds, 8 | 120) && (plan.rotation().is_none() || plan.preflight_only))
        || plan.connections.len() != 20
    {
        return Err("observer plan limits");
    }
    if service_id != plan.service_id {
        return Err("observer service mismatch");
    }
    if all.len() != 20
        || plan.connections.iter().enumerate().any(|(i, c)| {
            plan.connections[..i].contains(c)
                || !all.iter().any(|s| {
                    s.reference() == *c
                        && s.protocol == Protocol::Ssh2
                        && s.state == State::Connected
                })
        })
    {
        return Err("observer exact twenty owned targets");
    }
    Ok(())
}
async fn validate(shared: &Shared, plan: &Plan) -> Result<()> {
    let endpoint = shared
        .lock()
        .await
        .as_ref()
        .map_err(|_| "observer unavailable")?
        .endpoint()
        .map_err(|_| "observer endpoint")?;
    let Reply::Sessions(all) = primary(shared, Request::List {}).await? else {
        return Err("observer sessions reply");
    };
    binding(plan, &all, endpoint.2)?;
    for c in &plan.connections {
        match primary(
            shared,
            Request::Ssh {
                request: session_protocol::ssh::Request::Status { connection: *c },
            },
        )
        .await?
        {
            Reply::Ssh(session_protocol::ssh::Reply::Status(s))
                if s.server_host == "127.0.0.1" && s.connection.reference() == *c => {}
            _ => return Err("observer loopback only"),
        }
    }
    Ok(())
}
async fn run(
    shared: &Shared,
    root: &Path,
    active: &mut Vec<Uuid>,
    streams: &mut Vec<Stream>,
    stats: &mut Value,
) -> Result<()> {
    let waiting = Instant::now();
    let plan: Plan = loop {
        if waiting.elapsed() > Duration::from_secs(90) || root.join("load-observer-stop").exists() {
            return Err("observer plan timeout/stop");
        }
        if let Some(p) = read(root, "load-observer-plan.json")? {
            break p;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    validate(shared, &plan).await?;
    let first = plan.connections[0];
    let (mut restricted, id, _) = issue(shared, &plan, vec![first], 2000, active).await?;
    page(&mut restricted, first, 1).await?;
    denied(&mut restricted, read_request(plan.connections[1], 1)).await?;
    denied(
        &mut restricted,
        read_request(
            ConnectionRef {
                generation: first.generation + 1,
                ..first
            },
            1,
        ),
    )
    .await?;
    denied(
        &mut restricted,
        read_request(
            ConnectionRef {
                connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
                ..first
            },
            1,
        ),
    )
    .await?;
    denied(
        &mut restricted,
        Request::Ssh {
            request: session_protocol::ssh::Request::WriteText {
                connection: first,
                request_id: Uuid::new_v4(),
                text: session_protocol::Sensitive::new("never-sent".into()),
            },
        },
    )
    .await?;
    revoke(shared, id, active).await?;
    denied(&mut restricted, read_request(first, 1)).await?;
    let (mut expired, id, expires_at_ms) = issue(shared, &plan, vec![first], 100, active).await?;
    let observed = Instant::now();
    page(&mut expired, first, 1).await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    denied(&mut expired, read_request(first, 1)).await?;
    stats["expiry_observation"] = json!({"service_expires_at_ms":expires_at_ms,"lifetime_ms":100,"before_expiry_read_allowed":true,"elapsed_after_ticket_handshake_ms":observed.elapsed().as_secs_f64()*1000.0,"after_expiry_read_denied":true});
    // Confirmed expired tickets cannot read. Revoke before any later issue prunes them.
    revoke(shared, id, active).await?;
    stats["permission_preflight"] = json!({"passed":true,"denials":6,"allowed_scoped_read":true,"expiry_ms":100,"revocation_verified":true});
    let rotation = plan.rotation();
    let (mut observer, mut id, _) = issue(
        shared,
        &plan,
        plan.connections.clone(),
        rotation.map_or((plan.seconds + 30) * 1000, |(_, ttl)| ttl),
        active,
    )
    .await?;
    for c in &plan.connections {
        let p = page(&mut observer, *c, 1).await?;
        if p.truncated || p.disconnected {
            return Err("observer baseline");
        }
        streams.push(Stream::new(*c, p.next_cursor));
    }
    write(
        root,
        "load-observer-ready.json",
        json!({"service_id":plan.service_id,"targets":20,"permission_preflight":stats["permission_preflight"]}),
    )?;
    if plan.preflight_only {
        revoke(shared, id, active).await?;
        denied(&mut observer, read_request(first, streams[0].cursor)).await?;
        stats["final_revocation_verified"] = json!(true);
        return Ok(());
    }
    let waiting = Instant::now();
    let go: Go = loop {
        if waiting.elapsed() > Duration::from_secs(10) || root.join("load-observer-stop").exists() {
            return Err("observer go timeout/stop");
        }
        if let Some(g) = read(root, "load-observer-go.json")? {
            break g;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    if go.start_unix_ms.abs_diff(now()) > 1000 {
        return Err("observer start clock bound");
    }
    let mut calls = 0u64;
    let mut max_read = 0f64;
    let mut max_round = 0f64;
    let began = Instant::now();
    let wall_began = now();
    let mut last_round = began;
    let mut next_rotation = rotation.map(|(interval, _)| interval);
    let mut rotations = 0;
    let mut max_handoff_ms = 0f64;
    let outcome = async {
        loop {
            if root.join("load-observer-stop").exists() {
                return Err("observer cancelled");
            }
            let round = Instant::now();
            if rotation.is_some() {
                let age = std::fs::metadata(root.join("load-observer-heartbeat"))
                    .and_then(|info| info.modified())
                    .ok()
                    .and_then(|time| time.elapsed().ok());
                if !age.is_some_and(|age| age < Duration::from_secs(25))
                    || round.duration_since(last_round) > Duration::from_secs(4)
                    || wall_began.saturating_add(began.elapsed().as_millis() as u64).abs_diff(now()) > 500
                {
                    return Err("soak heartbeat/clock/round gap");
                }
                last_round = round;
                if let Some(due) = next_rotation
                    && began.elapsed() >= due
                    && due < Duration::from_secs(plan.seconds)
                {
                    let (interval, ttl) = rotation.unwrap();
                    let handoff = Instant::now();
                    let (next, next_id, _) =
                        issue(shared, &plan, plan.connections.clone(), ttl, active).await?;
                    revoke(shared, id, active).await?;
                    denied(&mut observer, read_request(first, streams[0].cursor)).await?;
                    observer = next;
                    id = next_id;
                    rotations += 1;
                    max_handoff_ms = max_handoff_ms.max(handoff.elapsed().as_secs_f64() * 1000.0);
                    next_rotation = Some(due + interval);
                }
            }
            for (i, s) in streams.iter_mut().enumerate() {
                if rotation.is_some()
                    && (round.elapsed() >= Duration::from_secs(3)
                        || root.join("load-observer-stop").exists())
                {
                    return Err("soak round deadline/stop");
                }
                let start = Instant::now();
                stats["last_read"]=json!({"stream":i,"connection":s.connection,"cursor":s.cursor,"started_elapsed_s":began.elapsed().as_secs_f64(),"phase":"request"});
                let p = page(&mut observer, s.connection, s.cursor).await?;
                stats["last_read"]["phase"]=json!("validate");
                calls += 1;
                max_read = max_read.max(start.elapsed().as_secs_f64() * 1000.0);
                s.accept(p, i, &go, plan.seconds)?;
                if rotation.is_some()
                    && (s.frames > plan.frames()
                        || (s.frames < plan.frames()
                            && now() > go.start_unix_ms + s.frames * 10_000 + 3_000))
                {
                    return Err("soak source cadence/count");
                }
                stats["last_read"]["phase"]=json!("completed");
            }
            max_round = max_round.max(round.elapsed().as_secs_f64() * 1000.0);
            if streams.iter().all(|s| s.frames == plan.frames())
                && (rotation.is_none() || now() >= go.start_unix_ms + plan.seconds * 1000)
            {
                break;
            }
            if now() > go.start_unix_ms + (plan.seconds + 5) * 1000
                || began.elapsed() > Duration::from_secs(plan.seconds + 7)
            {
                return Err("observer finite drain deadline");
            }
            tokio::time::sleep(Duration::from_millis(if rotation.is_some() { 1000 } else { 100 })).await;
        }
        if streams
            .iter()
            .any(|s| !s.pending.is_empty()
                || if rotation.is_some() { s.inside_bytes != s.bytes } else { s.inside_bytes < plan.seconds * 20 * 1024 })
        {
            return Err("observer main-window rate/pending");
        }
        Ok(())
    }
    .await;
    stats["calls"] = json!(calls);
    stats["max_read_ms"] = json!(max_read);
    stats["max_round_ms"] = json!(max_round);
    stats["elapsed_s"] = json!(began.elapsed().as_secs_f64());
    if rotation.is_some() {
        stats["rotations_verified"] = json!(rotations);
        stats["max_handoff_ms"] = json!(max_handoff_ms);
    }
    revoke(shared, id, active).await?;
    denied(&mut observer, read_request(first, streams[0].cursor)).await?;
    stats["final_revocation_verified"] = json!(true);
    outcome
}
pub fn start(shared: Shared, directory: PathBuf) -> std::io::Result<()> {
    let root = directory.canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    if root.parent() != Some(temp.as_path())
        || !root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("shared-terminal-load-latency-ui-中文-")
    {
        return Err(std::io::Error::other("OBSERVER_TEST_ROOT_REJECTED"));
    }
    let worker = std::thread::Builder::new().name("test-load-observer".into()).spawn(move || {
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let mut active=vec![];let mut streams=vec![];let mut stats=json!({});
            let result=run(&shared,&root,&mut active,&mut streams,&mut stats).await;
            let mut cleanup_errors=0;for id in active.clone(){if revoke(&shared,id,&mut active).await.is_err(){cleanup_errors+=1;}}
            json!({"passed":result.is_ok()&&cleanup_errors==0,"error":result.err(),"cleanup_errors":cleanup_errors,"active_ticket_count":active.len(),"stats":stats,"streams":streams.iter().map(Stream::summary).collect::<Vec<_>>()})
        })
    })?;
    // Publish after the observer worker/runtime/clients have actually ended.
    // The finisher holds no service capability.
    let root = directory.canonicalize()?;
    std::thread::Builder::new().name("test-observer-finish".into()).spawn(move || {
        let mut result=match worker.join(){Ok(v)=>v,Err(_)=>json!({"passed":false,"error":"observer worker panicked","active_ticket_count":null})};
        result["observer_worker_joined"]=json!(true);
        let _=write(&root,"load-observer-result.json",result);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observer_welcome_uses_pipe_identity_and_rejects_other_service_or_kind() {
        let service = Uuid::new_v4();
        let pipe = Uuid::new_v4();
        let welcome = |service_id, kind| Response::Ok {
            id: 0,
            reply: Reply::Welcome(session_protocol::Welcome {
                protocol_version: session_core::PROTOCOL_VERSION,
                service_id,
                client_id: pipe,
                kind,
            }),
        };
        assert!(observer_welcome(
            welcome(service, ClientKind::Observer),
            service
        ));
        assert!(!observer_welcome(
            welcome(Uuid::new_v4(), ClientKind::Observer),
            service
        ));
        assert!(!observer_welcome(
            welcome(service, ClientKind::Agent),
            service
        ));
    }
    fn target() -> ConnectionRef {
        ConnectionRef {
            connection_id: session_core::session::ConnectionId(Uuid::new_v4()),
            generation: 1,
        }
    }
    fn output(c: ConnectionRef, bytes: Vec<u8>) -> OutputPage {
        OutputPage {
            connection: c,
            events: vec![session_core::session::OutputEvent {
                seq: 1,
                timestamp_ms: 1000,
                bytes,
                gap_bytes: None,
            }],
            next_cursor: 2,
            available_from: 1,
            truncated: false,
            disconnected: false,
        }
    }
    #[test]
    fn exact_split_frame_and_corruption_gap_retention_fail_closed() {
        let c = target();
        let go = Go {
            start_unix_ms: 1000,
        };
        let mut bytes = vec![b'a'; 1024];
        bytes[..16].copy_from_slice(b"T18|00|00000000|");
        bytes[1023] = 10;
        let mut stream = Stream::new(c, 1);
        stream
            .accept(output(c, bytes[..517].to_vec()), 0, &go, 8)
            .unwrap();
        assert_eq!(stream.frames, 0);
        stream
            .accept(output(c, bytes[517..].to_vec()), 0, &go, 8)
            .unwrap();
        assert_eq!((stream.frames, stream.inside_bytes), (1, 1024));
        assert!(stream.pending.is_empty());
        for kind in 0..4 {
            let mut s = Stream::new(c, 1);
            let mut p = output(c, bytes.clone());
            match kind {
                0 => p.events[0].bytes[20] = b'!',
                1 => p.events[0].gap_bytes = Some(1),
                2 => p.truncated = true,
                _ => p.connection.generation += 1,
            };
            assert!(s.accept(p, 0, &go, 8).is_err());
            assert_eq!(s.frames, 0);
        }
    }
    #[test]
    fn binding_rejects_cross_service_duplicate_generation_and_inactive_targets() {
        let all = (0..20)
            .map(|_| session_core::session::ConnectionInfo {
                connection_id: target().connection_id,
                generation: 1,
                protocol: Protocol::Ssh2,
                state: State::Connected,
            })
            .collect::<Vec<_>>();
        let plan = Plan {
            service_id: Uuid::new_v4(),
            connections: all.iter().map(|s| s.reference()).collect(),
            seconds: 8,
            preflight_only: true,
        };
        assert!(binding(&plan, &all, plan.service_id).is_ok());
        let mut formal = plan.clone();
        formal.seconds = 7_200;
        formal.preflight_only = false;
        assert!(binding(&formal, &all, plan.service_id).is_ok());
        formal.preflight_only = true;
        assert!(binding(&formal, &all, plan.service_id).is_err());
        formal.preflight_only = false;
        formal.seconds = 28_800;
        assert!(binding(&formal, &all, plan.service_id).is_err());
        assert!(binding(&plan, &all, Uuid::new_v4()).is_err());
        let mut wrong = plan.clone();
        wrong.connections[0].generation += 1;
        assert!(binding(&wrong, &all, plan.service_id).is_err());
        wrong = plan.clone();
        wrong.connections[1] = wrong.connections[0];
        assert!(binding(&wrong, &all, plan.service_id).is_err());
        let mut wrong_all = all.clone();
        wrong_all[0].state = State::Disconnected;
        assert!(binding(&plan, &wrong_all, plan.service_id).is_err());
        wrong_all = all.clone();
        wrong_all[0].protocol = Protocol::Serial;
        assert!(binding(&plan, &wrong_all, plan.service_id).is_err());
        wrong = plan.clone();
        wrong.connections.pop();
        assert!(binding(&wrong, &all, plan.service_id).is_err());
    }
    #[test]
    fn private_plan_rejects_unknown_capability_fields() {
        let value = json!({"service_id":Uuid::new_v4(),"connections":[],"seconds":8,"preflight_only":true,"token":"forbidden"});
        assert!(serde_json::from_value::<Plan>(value).is_err());
    }

    #[test]
    fn sparse_modes_keep_fixed_frame_and_ticket_budgets() {
        let mut plan = Plan {
            service_id: Uuid::new_v4(),
            connections: vec![],
            seconds: 7_200,
            preflight_only: false,
        };
        assert_eq!(plan.frames(), 720);
        assert_eq!(
            plan.rotation(),
            Some((Duration::from_secs(1200), 1_800_000))
        );
        plan.seconds = 25;
        assert_eq!(plan.frames(), 3);
        assert_eq!(plan.rotation(), Some((Duration::from_secs(12), 25_000)));
        plan.seconds = 120;
        assert_eq!(plan.frames(), 2520);
        assert_eq!(plan.rotation(), None);
    }
}
