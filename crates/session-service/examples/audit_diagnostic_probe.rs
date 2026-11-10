//! Finite own-service close/permission probes. No device or throughput workload.
use serde_json::{Value, json};
use session_core::{
    PROTOCOL_VERSION,
    access::{Action, Scope, Target},
    pairing::SecretToken,
    session::ErrorCode,
};
use session_protocol::{Hello, Reply, Request, Response, Sensitive, agent, write_frame};
use session_service::{
    audit_diagnostic::{CloseDiagnostic, Outcome},
    client::Client,
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{sleep, timeout},
};
use uuid::Uuid;
type Result<T> = std::result::Result<T, &'static str>;
fn need(ok: bool, stage: &'static str) -> Result<()> {
    if ok { Ok(()) } else { Err(stage) }
}
async fn reply(c: &mut Client, r: Request) -> Result<Reply> {
    match c.request(r).await.map_err(|_| "IPC_UNKNOWN_NO_REPLAY")? {
        Response::Ok { reply, .. } => Ok(reply),
        _ => Err("UNEXPECTED_RPC_DENIAL"),
    }
}
async fn deny(c: &mut Client, r: Request, expected: ErrorCode) -> Result<()> {
    need(
        matches!(c.request(r).await.map_err(|_|"DENIAL_IPC_UNKNOWN")?,Response::Error{code,..} if code==expected),
        "EXPECTED_DENIAL",
    )
}
async fn wait_file(root: &Path, name: &str) -> Result<()> {
    timeout(Duration::from_secs(3), async {
        while !root.join(name).exists() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .map_err(|_| "CONTROL_GATE_TIMEOUT")
}
async fn exercise(
    client: &mut Client,
    agent: &mut Option<Client>,
    root: &Path,
    mode: &str,
    secrets: &mut Vec<zeroize::Zeroizing<String>>,
    instance: &str,
    pid: u32,
) -> Result<()> {
    let Reply::Connection(c) = reply(client, Request::CreateFixture {}).await? else {
        return Err("FIXTURE_REPLY");
    };
    let connection = c.reference();
    let grant_id = Uuid::new_v4();
    let grant = |id| Request::Agent {
        request: agent::Request::Grant {
            request_id: id,
            scopes: vec![Scope {
                target: Target::Connection { connection },
                action: Action::Read,
            }],
            lifetime_ms: 30000,
        },
    };
    let Reply::Agent(agent::Reply::Grant {
        token: Some(peer_token),
        ..
    }) = reply(client, grant(grant_id)).await?
    else {
        return Err("GRANT_REPLY");
    };
    secrets.push(zeroize::Zeroizing::new(peer_token.expose().to_owned()));
    let (mut peer, _) = Client::connect(instance, peer_token.expose(), pid)
        .await
        .map_err(|_| "AGENT_PRIVATE_HANDSHAKE")?;
    reply(
        &mut peer,
        Request::Read {
            connection,
            cursor: 1,
            max_bytes: 4096,
        },
    )
    .await?;
    deny(
        &mut peer,
        Request::RpcAudit {
            view: session_protocol::rpc_audit::View::JournalInfo {},
        },
        ErrorCode::PermissionDenied,
    )
    .await?;
    if mode == "caller-error" {
        return Err("CALLER_SYNTHETIC_FAILURE");
    }
    std::fs::write(root.join("audit-diagnostic-arm"), b"arm").map_err(|_| "ARM_CONTROL")?;
    reply(client, Request::Ping {}).await?;
    if matches!(mode, "queue" | "inflight") {
        wait_file(root, "audit-diagnostic-entered").await?;
    }
    if mode == "queue" {
        for _ in 0..360 {
            reply(client, Request::Ping {}).await?;
        }
    }
    if matches!(mode, "queue" | "write" | "sync") {
        timeout(Duration::from_secs(3), async {
            loop {
                let Reply::RpcAudit(session_protocol::rpc_audit::Reply::JournalInfo {
                    status, ..
                }) = reply(
                    client,
                    Request::RpcAudit {
                        view: session_protocol::rpc_audit::View::JournalInfo {},
                    },
                )
                .await?
                else {
                    return Err("JOURNAL_INFO_REPLY");
                };
                if status.state != session_core::audit_journal::State::Healthy {
                    break Ok(());
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .map_err(|_| "FAULT_NOT_OBSERVED")??;
        deny(
            &mut peer,
            Request::Read {
                connection,
                cursor: 1,
                max_bytes: 4096,
            },
            ErrorCode::CapacityExceeded,
        )
        .await?;
        deny(client, grant(Uuid::new_v4()), ErrorCode::CapacityExceeded).await?;
    }
    reply(
        client,
        Request::Agent {
            request: agent::Request::GrantRevoke {
                request_id: grant_id,
            },
        },
    )
    .await?;
    *agent = Some(peer);
    Ok(())
}
async fn case(mode: &str) -> Result<Value> {
    let run_id = Uuid::new_v4();
    let root = std::env::temp_dir().join(format!("shared-terminal-audit-diagnostic-中文-{run_id}"));
    std::fs::create_dir(&root).map_err(|_| "CREATE_OWN_ROOT")?;
    let token = SecretToken::generate();
    let instance = Uuid::new_v4().to_string();
    let exe = std::env::current_dir()
        .map_err(|_| "WORKSPACE")?
        .join("target/audit-diagnostic-fixture/session-service.exe");
    let fixture_mode = if mode == "caller-error" {
        "normal"
    } else {
        mode
    };
    let mut child = Command::new(exe)
        .args([
            "--instance",
            &instance,
            "--test-fixture",
            "--audit-diagnostic-fixture",
            fixture_mode,
            "--data-dir",
        ])
        .arg(&root)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "SPAWN_OWN_SERVICE")?;
    let pid = child.id().ok_or("OWN_PID")?;
    let stderr = child.stderr.take().ok_or("PRIVATE_STDERR")?;
    let collector = tokio::spawn(async move {
        let mut out = Vec::new();
        let mut stream = stderr.take(16385);
        let ok = stream.read_to_end(&mut out).await.is_ok();
        (out, ok)
    });
    let mut secrets = vec![zeroize::Zeroizing::new(token.expose().to_owned())];
    let mut client = None;
    let mut peer = None;
    let first: Result<()> = async {
        let mut stdin = child.stdin.take().ok_or("PRIVATE_STDIN")?;
        write_frame(
            &mut stdin,
            &Hello {
                protocol_version: PROTOCOL_VERSION,
                client_name: "audit-diagnostic-own-fixture".into(),
                token: Sensitive::new(token.expose().to_owned()),
            },
        )
        .await
        .map_err(|_| "PRIVATE_BOOTSTRAP")?;
        drop(stdin);
        let (c, _) = Client::connect(&instance, token.expose(), pid)
            .await
            .map_err(|_| "DESKTOP_HANDSHAKE")?;
        client = Some(c);
        exercise(
            client.as_mut().unwrap(),
            &mut peer,
            &root,
            mode,
            &mut secrets,
            &instance,
            pid,
        )
        .await
    }
    .await;
    drop(peer);
    // Always release a failed queue probe. Inflight deliberately holds until close.
    if mode != "inflight" || first.is_err() {
        let _ = std::fs::write(root.join("audit-diagnostic-release"), b"release");
    }
    let shutdown_attempted = client.is_some();
    let ack = match client.as_mut() {
        Some(c) => matches!(reply(c, Request::Shutdown {}).await, Ok(Reply::Ok)),
        None => false,
    };
    drop(client);
    let mut cleanup_errors = Vec::new();
    let mut inflight_verified = false;
    if mode == "inflight" && first.is_ok() {
        if wait_file(&root, "audit-diagnostic-closing").await.is_ok() {
            sleep(Duration::from_millis(40)).await;
            match child.try_wait() {
                Ok(status) => inflight_verified = status.is_none(),
                Err(_) => cleanup_errors.push("INFLIGHT_WAIT_ERROR"),
            };
        }
        let _ = std::fs::write(root.join("audit-diagnostic-release"), b"release");
    }
    let waited = timeout(Duration::from_secs(15), child.wait()).await;
    let mut forced = false;
    let mut kill_ok = None;
    let exit = match waited {
        Ok(Ok(s)) => Some(s),
        _ => {
            forced = true;
            kill_ok = Some(child.kill().await.is_ok());
            timeout(Duration::from_secs(5), child.wait())
                .await
                .ok()
                .and_then(|v| v.ok())
        }
    };
    let (output, stderr_ok) = match timeout(Duration::from_secs(3), collector).await {
        Ok(Ok(v)) => v,
        _ => {
            cleanup_errors.push("STDERR_COLLECTOR_JOIN");
            (vec![], false)
        }
    };
    let text = String::from_utf8_lossy(&output);
    let diagnostics = text
        .lines()
        .filter_map(CloseDiagnostic::parse_line)
        .collect::<Vec<_>>();
    let secret_free =
        !text.contains("SYNTHETIC_SECRET") && secrets.iter().all(|s| !text.contains(s.as_str()));
    let normal = matches!(mode, "normal" | "inflight" | "caller-error");
    let diag_ok =
        diagnostics.len() == 1 && matches!(diagnostics[0].outcome, Outcome::Closed) == normal;
    let kind_ok = diagnostics.first().is_some_and(|d| match mode {
        "queue" => d
            .first_failure
            .is_some_and(|f| f.kind == terminal_log::audit::FailureKind::QueueFull),
        "write" => d
            .first_failure
            .is_some_and(|f| f.stage == terminal_log::audit::FailureStage::Append),
        "sync" => d
            .first_failure
            .is_some_and(|f| f.stage == terminal_log::audit::FailureStage::Checkpoint),
        "close" => d
            .first_failure
            .is_some_and(|f| f.stage == terminal_log::audit::FailureStage::CloseBarrier),
        _ => d.first_failure.is_none(),
    });
    let snapshot_ok = diagnostics.first().is_some_and(|d| {
        d.state.is_some()
            && d.accepted.is_some()
            && d.synced.is_some()
            && d.rejected.is_some()
            && d.incomplete.is_some()
            && d.synced <= d.accepted
            && (!normal || d.synced == d.accepted)
    });
    let exit_ok = exit.is_some_and(|s| s.success() == normal);
    let first_expected = if mode == "caller-error" {
        first.as_ref().err() == Some(&"CALLER_SYNTHETIC_FAILURE")
    } else {
        first.is_ok()
    };
    let passed = first_expected
        && shutdown_attempted
        && ack
        && !forced
        && stderr_ok
        && output.len() <= 16384
        && secret_free
        && diag_ok
        && snapshot_ok
        && kind_ok
        && exit_ok
        && (mode != "inflight" || inflight_verified);
    let mut report = json!({"case":mode,"run_id":run_id,"passed":passed,"probe_error_stage":first.err(),"expected_service_failure":!normal,"cleanup":{"shutdown_attempted":shutdown_attempted,"shutdown_ack":ack,"exited":exit.is_some(),"exit_code":exit.and_then(|s|s.code()),"forced_kill_attempted":forced,"forced_kill_ok":kill_ok},"diagnostics":diagnostics,"stderr_bounded":output.len()<=16384,"stderr_secret_free":secret_free,"inflight_close_wait_verified":inflight_verified,"permission_fault_denials_checked":matches!(mode,"queue"|"write"|"sync"),"root_retained":!passed});
    if passed {
        let cleanup = (|| -> Result<()> {
            let resolved = root.canonicalize().map_err(|_| "OWN_ROOT_CANONICAL")?;
            need(
                resolved.parent()
                    == Some(
                        std::env::temp_dir()
                            .canonicalize()
                            .map_err(|_| "TEMP_CANONICAL")?
                            .as_path(),
                    ),
                "OWN_ROOT_PARENT",
            )?;
            need(
                resolved
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("shared-terminal-audit-diagnostic-中文-"),
                "OWN_ROOT_PREFIX",
            )?;
            std::fs::remove_dir_all(resolved).map_err(|_| "OWN_ROOT_CLEANUP")?;
            Ok(())
        })();
        if let Err(e) = cleanup {
            cleanup_errors.push(e);
            report["passed"] = json!(false);
            report["root_retained"] = json!(true);
        }
    }
    report["cleanup_errors"] = json!(cleanup_errors);
    Ok(report)
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut reports = Vec::new();
    for mode in [
        "normal",
        "caller-error",
        "inflight",
        "queue",
        "write",
        "sync",
        "close",
    ] {
        match case(mode).await {
            Ok(v) => reports.push(v),
            Err(stage) => {
                reports.push(json!({"case":mode,"passed":false,"probe_error_stage":stage,"cleanup":{"started":false}}));
                break;
            }
        }
    }
    let passed = reports.len() == 7 && reports.iter().all(|v| v["passed"] == true);
    let output = json!({"passed":passed,"cases":reports,"continuous_load_started":false,"old_roots_opened":false});
    let artifact =
        PathBuf::from("artifacts").join(format!("P22-audit-diagnostic-{}.json", Uuid::new_v4()));
    std::fs::write(
        &artifact,
        serde_json::to_vec_pretty(&output).map_err(|_| "REPORT_ENCODE")?,
    )
    .map_err(|_| "REPORT_WRITE")?;
    println!(
        "AUDIT_DIAGNOSTIC_PROBE {}",
        json!({"passed":passed,"report":artifact.file_name().unwrap().to_string_lossy()})
    );
    if !passed {
        return Err("AUDIT_DIAGNOSTIC_PROBE_FAILED".into());
    }
    Ok(())
}
