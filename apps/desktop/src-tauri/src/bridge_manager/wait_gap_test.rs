//! One headless test using the native broker and the real stdio executable.
use super::*;
use crate::{close_receipt::Ack, serial_fixture, service::Service};
use serde_json::{Value, json};
use session_core::{
    access::{Action, Scope, Target},
    session::{ConnectionRef, OutputEvent},
};
use session_protocol::{SensitiveBytes, serial};
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::sleep,
};

struct Mcp {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
}

impl Mcp {
    fn start(info: &Info) -> Self {
        let mut child = Command::new(&info.executable)
            .args([
                "--stdio",
                "--broker",
                &info.instance,
                "--desktop-pid",
                &info.desktop_pid.to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let input = child.stdin.take();
        Self {
            child,
            input,
            output,
        }
    }

    async fn send(&mut self, message: Value) {
        let mut bytes = serde_json::to_vec(&message).unwrap();
        bytes.push(b'\n');
        self.input
            .as_mut()
            .unwrap()
            .write_all(&bytes)
            .await
            .unwrap();
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await;
        let mut bytes = Vec::new();
        (&mut self.output)
            .take(128 * 1024)
            .read_until(b'\n', &mut bytes)
            .await
            .unwrap();
        assert_eq!(
            bytes.last(),
            Some(&b'\n'),
            "bounded MCP reply must end with newline"
        );
        let response: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(response["id"], id);
        assert!(response["error"].is_null(), "unexpected MCP protocol error");
        response["result"].clone()
    }

    async fn stop(&mut self) -> bool {
        drop(self.input.take());
        if let Ok(Ok(status)) = timeout(Duration::from_secs(4), self.child.wait()).await {
            return status.success();
        }
        let _ = self.child.start_kill();
        let _ = timeout(Duration::from_secs(2), self.child.wait()).await;
        false
    }
}

async fn serial(service: &mut Service, request: serial::Request) -> serial::Reply {
    let Reply::Serial(reply) = service
        .request(ServiceRequest::Serial { request })
        .await
        .unwrap()
    else {
        panic!("expected serial reply");
    };
    reply
}

async fn read_until(
    service: &mut Service,
    connection: ConnectionRef,
    cursor: u64,
    predicate: impl Fn(&OutputEvent) -> bool,
) -> Vec<OutputEvent> {
    timeout(Duration::from_secs(4), async {
        loop {
            let Reply::Output(page) = service
                .request(ServiceRequest::Read {
                    connection,
                    cursor,
                    max_bytes: 65536,
                })
                .await
                .unwrap()
            else {
                panic!("expected raw output");
            };
            assert!(!page.truncated && !page.disconnected);
            if page.events.iter().any(&predicate) {
                return page.events;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected owned serial output did not arrive")
}

async fn exercise(service: &mut Service, broker: &Manager, mcp: &mut Mcp) -> (u64, u64) {
    const BLOCK: u64 = 4096;
    let serial::Reply::Inventory {
        revision, devices, ..
    } = serial(service, serial::Request::Inventory {}).await
    else {
        panic!("expected synthetic serial inventory");
    };
    assert_eq!(devices.len(), 1);
    let serial::Reply::Started { connection } = serial(
        service,
        serial::Request::QuickStart {
            settings: config_model::Settings::Serial {
                port: "COM7".into(),
                baud_rate: 115200,
                data_bits: 8,
                stop_bits: 1,
                parity: config_model::Parity::None,
                flow: config_model::Flow::None,
                dtr_on_open: false,
                rts_on_open: Some(false),
                encoding: config_model::Encoding::Utf8,
            },
            request_id: Uuid::new_v4(),
            revision,
            device_id: devices[0].device_id,
        },
    )
    .await
    else {
        panic!("expected owned serial connection");
    };
    let connection = connection.reference();
    let raw = read_until(service, connection, 1, |event| event.gap_bytes.is_some()).await;
    assert_eq!(raw.len(), 17);
    let prefix = &raw[15];
    let gap = &raw[16];
    assert_eq!(prefix.seq, 16);
    assert_eq!(prefix.bytes.len(), BLOCK as usize);
    assert!(prefix.bytes.ends_with(b"JOIN-"));
    assert_eq!(gap.seq, prefix.seq + 1);
    assert_eq!(gap.gap_bytes, Some(BLOCK));
    assert!(gap.bytes.is_empty());
    let serial::Reply::Status(status) =
        serial(service, serial::Request::Status { connection }).await
    else {
        panic!("expected worker counters");
    };
    assert_eq!(status.read_bytes, 17 * BLOCK);
    assert_eq!(status.dropped_bytes, BLOCK);

    // The suffix goes through the existing Desktop write and the memory Port echo
    // only after the genuine gap was visible through the service.
    serial(
        service,
        serial::Request::Write {
            connection,
            request_id: Uuid::new_v4(),
            bytes: SensitiveBytes::new(b"me".to_vec()),
        },
    )
    .await;
    let suffix = read_until(service, connection, gap.seq + 1, |event| {
        !event.bytes.is_empty()
    })
    .await;
    assert_eq!(suffix.len(), 1);
    assert_eq!(suffix[0].seq, gap.seq + 1);
    assert_eq!(suffix[0].bytes, b"me");
    assert!(suffix[0].gap_bytes.is_none());

    let grant_id = Uuid::new_v4();
    let Reply::Agent(agent::Reply::Grant { receipt, .. }) = service
        .request(ServiceRequest::Agent {
            request: agent::Request::Grant {
                request_id: grant_id,
                scopes: vec![Scope {
                    target: Target::Connection { connection },
                    action: Action::Read,
                }],
                lifetime_ms: 30000,
            },
        })
        .await
        .unwrap()
    else {
        panic!("expected scoped Read grant");
    };
    let ticket = receipt.summary.ticket_id;
    let channel = tokio::sync::Mutex::new(service.config_client.take());
    let initialized = mcp.call(1, "initialize", json!({
        "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"p15-gap-headless","version":"1"}
    })).await;
    assert!(initialized["capabilities"]["tools"].is_object());
    mcp.send(json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}))
        .await;
    let peer = timeout(Duration::from_secs(3), async {
        loop {
            if let Some(peer) = broker.info().unwrap().peer {
                break peer;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual MCP native peer");
    assert_eq!(Some(peer.pid), mcp.child.id());
    let preview = broker
        .prepare(&channel, peer.pending_id, grant_id)
        .await
        .unwrap();
    let bound = broker
        .approve(&channel, service.endpoint().unwrap(), preview.preview_id)
        .await
        .unwrap();
    assert_eq!(bound.ticket_id, Some(ticket));
    // Status synchronizes the broker's receipt of the native bind before the wait.
    let status = mcp
        .call(
            2,
            "tools/call",
            json!({"name":"agent_status","arguments":{}}),
        )
        .await;
    assert_eq!(
        status["structuredContent"]["reply"]["data"]["paired_ticket"],
        json!(ticket)
    );
    let wait = mcp.call(3, "tools/call", json!({
        "name":"terminal_wait",
        "arguments":{"connection":connection,"cursor":prefix.seq,"pattern":"JOIN-me","timeout_ms":3000}
    })).await;
    assert_eq!(wait["isError"], false);
    assert_eq!(
        wait["structuredContent"]["reply"],
        json!({
            "result":"wait","data":{"state":"GAP","next_cursor":gap.seq+1,"evidence":{"reason":"SOURCE_GAP"}}
        })
    );
    (gap.seq, BLOCK)
}

#[tokio::test]
#[ignore = "explicit guarded serial fixture executable and real stdio only"]
async fn worker_source_gap_reaches_terminal_wait_over_the_native_broker() {
    let parent = std::env::temp_dir().canonicalize().unwrap();
    let root = parent.join(format!(
        "shared-terminal-mcp-serial-control-中文-wait-gap-{}",
        Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    std::fs::File::create_new(root.join("serial-mcp-wait-gap")).unwrap();
    serial_fixture::configure(&root, true).unwrap();
    let mut service = Service::start(true, root.clone()).await.unwrap();
    let broker = Manager::start_expected(
        service.endpoint().unwrap().2,
        serial_fixture::wait_gap_binary("terminal-mcp.exe"),
    )
    .unwrap();
    let mut mcp = Mcp::start(&broker.info().unwrap());
    let result = timeout(
        Duration::from_secs(15),
        exercise(&mut service, &broker, &mut mcp),
    )
    .await;
    let stdio_closed = mcp.stop().await;
    broker.close().await;
    let stopped = service.stop().await;
    drop(service);
    assert_eq!(stopped.receipt.shutdown_ack, Ack::Acknowledged);
    assert_eq!(stopped.receipt.exit_code, Some(0));
    assert!(!stopped.receipt.kill_requested);
    assert!(stdio_closed, "real stdio must exit successfully on EOF");
    let (gap_seq, lost) = result.expect("headless gap test deadline");
    assert_eq!(root.canonicalize().unwrap(), root);
    assert_eq!(root.parent(), Some(parent.as_path()));
    std::fs::remove_dir_all(root).unwrap();
    println!(
        "P15_WAIT_GAP {}",
        json!({
            "gap_seq":gap_seq,"gap_bytes":lost,"state":"GAP","reason":"SOURCE_GAP",
            "next_cursor":gap_seq+1,"stdio_exit":0,"shutdown_ack":true,"service_exit":0,"forced":false
        })
    );
}
