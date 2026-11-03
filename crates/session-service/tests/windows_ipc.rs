#![cfg(windows)]
use session_core::{PROTOCOL_VERSION, pairing::SecretToken, session::*};
use session_protocol::*;
use session_service::{client::Client, security::pipe_name};
use std::{process::Stdio, time::Duration};
use tokio::{
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

struct Fixture {
    instance: String,
    token: SecretToken,
    child: Child,
    pid: u32,
}
impl Fixture {
    async fn start(fixture: bool) -> Self {
        let instance = Uuid::new_v4().to_string();
        Self::on_instance(instance, fixture).await
    }
    async fn on_instance(instance: String, fixture: bool) -> Self {
        let token = SecretToken::generate();
        let mut command = Command::new(env!("CARGO_BIN_EXE_session-service"));
        command.args(["--instance", &instance]);
        if fixture {
            command.arg("--test-fixture");
        }
        let mut child = command
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        write_frame(
            &mut stdin,
            &Hello {
                protocol_version: PROTOCOL_VERSION,
                client_name: "private-test-bootstrap".into(),
                token: Sensitive::new(token.expose().to_string()),
            },
        )
        .await
        .unwrap();
        drop(stdin);
        Self {
            instance,
            token,
            child,
            pid,
        }
    }
    async fn connect(&self) -> Client {
        Client::connect(&self.instance, self.token.expose(), self.pid)
            .await
            .unwrap()
            .0
    }
    async fn raw(&self) -> NamedPipeClient {
        timeout(Duration::from_secs(5), async {
            loop {
                match ClientOptions::new().open(pipe_name(&self.instance).unwrap()) {
                    Ok(pipe) => return pipe,
                    Err(error) if matches!(error.raw_os_error(), Some(2 | 231)) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("pipe open failed: {error}"),
                }
            }
        })
        .await
        .unwrap()
    }
    async fn stop(&mut self, client: &mut Client) {
        assert!(matches!(
            ok(client.request(Request::Shutdown {}).await.unwrap()),
            Reply::Ok
        ));
        assert!(
            timeout(Duration::from_secs(3), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
}
fn ok(response: Response) -> Reply {
    match response {
        Response::Ok { reply, .. } => reply,
        Response::Error { code, .. } => panic!("unexpected service error: {code}"),
    }
}
fn error(response: Response) -> ErrorCode {
    match response {
        Response::Error { code, .. } => code,
        _ => panic!("expected service rejection"),
    }
}
fn reference(reply: Reply) -> ConnectionRef {
    match reply {
        Reply::Connection(info) => info.reference(),
        _ => panic!("expected connection"),
    }
}

#[tokio::test]
async fn shared_output_reconnect_tickets_and_ui_disconnect() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let first = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let hidden = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let raw = "共享原始字节\r\n".as_bytes().to_vec();
    ok(desktop
        .request(Request::AppendFixture {
            connection: first,
            bytes: raw.clone(),
        })
        .await
        .unwrap());
    let (ticket_id, token) = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![first],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket {
            ticket_id, token, ..
        } => (ticket_id, token),
        _ => panic!(),
    };
    let (mut observer, welcome) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    assert!(matches!(
        welcome,
        Response::Ok {
            reply: Reply::Welcome(Welcome {
                kind: ClientKind::Observer,
                ..
            }),
            ..
        }
    ));
    match ok(observer.request(Request::List {}).await.unwrap()) {
        Reply::Sessions(list) => assert_eq!(
            list.iter().map(|i| i.reference()).collect::<Vec<_>>(),
            [first]
        ),
        _ => panic!(),
    }
    assert_eq!(
        error(
            observer
                .request(Request::Read {
                    connection: hidden,
                    cursor: 1,
                    max_bytes: EVENT_BYTES
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            observer
                .request(Request::AppendFixture {
                    connection: first,
                    bytes: b"not-allowed".to_vec()
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            observer
                .request(Request::IssueRead {
                    scopes: vec![hidden],
                    lifetime_ms: 100
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    drop(desktop);
    let mut desktop = fixture.connect().await;
    match ok(desktop
        .request(Request::Read {
            connection: first,
            cursor: 1,
            max_bytes: EVENT_BYTES,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => {
            assert_eq!(page.events[0].bytes, raw);
            assert_eq!(page.connection, first);
        }
        _ => panic!(),
    }
    let next = reference(ok(desktop
        .request(Request::ReconnectFixture { connection: first })
        .await
        .unwrap()));
    assert_eq!(next.generation, first.generation + 1);
    assert_eq!(
        error(
            desktop
                .request(Request::Read {
                    connection: first,
                    cursor: 1,
                    max_bytes: EVENT_BYTES
                })
                .await
                .unwrap()
        ),
        ErrorCode::StaleGeneration
    );
    assert_eq!(
        error(
            observer
                .request(Request::Read {
                    connection: next,
                    cursor: 1,
                    max_bytes: EVENT_BYTES
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    match ok(desktop
        .request(Request::Read {
            connection: next,
            cursor: 1,
            max_bytes: EVENT_BYTES,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => assert!(page.events.is_empty()),
        _ => panic!(),
    }
    ok(desktop
        .request(Request::Revoke { ticket_id })
        .await
        .unwrap());
    assert_eq!(
        error(observer.request(Request::List {}).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    let token = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![next],
            lifetime_ms: 100,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let (mut expiring, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        error(expiring.request(Request::Ping {}).await.unwrap()),
        ErrorCode::PermissionDenied
    );
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn production_default_disables_fixture_and_duplicate_instance_fails() {
    let mut fixture = Fixture::start(false).await;
    let mut desktop = fixture.connect().await;
    assert_eq!(
        error(desktop.request(Request::CreateFixture {}).await.unwrap()),
        ErrorCode::Unsupported
    );
    let mut duplicate = Fixture::on_instance(fixture.instance.clone(), true).await;
    assert!(
        !timeout(Duration::from_secs(5), duplicate.child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(matches!(
        ok(desktop.request(Request::Ping {}).await.unwrap()),
        Reply::Pong { .. }
    ));
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn handshake_version_token_pid_and_bad_frame_are_rejected() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let mut wrong_version = fixture.raw().await;
    write_frame(
        &mut wrong_version,
        &Hello {
            protocol_version: 999,
            client_name: "test".into(),
            token: Sensitive::new(fixture.token.expose().to_string()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        error(
            read_frame::<_, Response>(&mut wrong_version)
                .await
                .unwrap()
                .unwrap()
        ),
        ErrorCode::VersionMismatch
    );
    let mut wrong_token = fixture.raw().await;
    write_frame(
        &mut wrong_token,
        &Hello {
            protocol_version: 1,
            client_name: "test".into(),
            token: Sensitive::new(SecretToken::generate().expose().to_string()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        error(
            read_frame::<_, Response>(&mut wrong_token)
                .await
                .unwrap()
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        Client::connect(&fixture.instance, fixture.token.expose(), fixture.pid + 1)
            .await
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let mut oversized = fixture.raw().await;
    use tokio::io::AsyncWriteExt;
    oversized
        .write_all(&((MAX_FRAME + 1) as u32).to_le_bytes())
        .await
        .unwrap();
    let closed = timeout(
        Duration::from_secs(1),
        read_frame::<_, Response>(&mut oversized),
    )
    .await
    .unwrap();
    assert!(matches!(closed, Ok(None) | Err(_)));
    let mut no_hello = fixture.raw().await;
    write_frame(
        &mut no_hello,
        &RequestEnvelope {
            id: 1,
            request: Request::CreateFixture {},
        },
    )
    .await
    .unwrap();
    let closed = timeout(
        Duration::from_secs(1),
        read_frame::<_, Response>(&mut no_hello),
    )
    .await
    .unwrap();
    assert!(matches!(closed, Ok(None) | Err(_)));
    match ok(desktop.request(Request::List {}).await.unwrap()) {
        Reply::Sessions(list) => assert!(list.is_empty()),
        _ => panic!(),
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn bounded_output_gap_is_visible_across_processes() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let connection = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    for byte in 0..80 {
        ok(desktop
            .request(Request::AppendFixture {
                connection,
                bytes: vec![byte; EVENT_BYTES],
            })
            .await
            .unwrap());
    }
    match ok(desktop
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: MAX_APPEND,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => {
            assert!(page.truncated);
            assert_eq!(page.available_from, 17);
            assert_eq!(page.events.len(), 16);
            assert_eq!(page.events[0].bytes[0], 16);
        }
        _ => panic!(),
    }
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn unauthenticated_connection_limit_does_not_block_an_existing_client() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let mut pending = vec![];
    for _ in 0..33 {
        pending.push(fixture.raw().await);
    }
    let mut closed = 0;
    for pipe in &mut pending {
        if matches!(
            timeout(Duration::from_millis(30), read_frame::<_, Response>(pipe)).await,
            Ok(Ok(None) | Err(_))
        ) {
            closed += 1;
        }
    }
    assert!(
        closed >= 2,
        "32 total clients includes the authenticated desktop"
    );
    assert!(matches!(
        ok(desktop.request(Request::Ping {}).await.unwrap()),
        Reply::Pong { .. }
    ));
    drop(pending);
    fixture.stop(&mut desktop).await;
}

#[tokio::test]
async fn service_crash_drops_client_and_restart_does_not_restore_state_or_tickets() {
    let mut fixture = Fixture::start(true).await;
    let mut desktop = fixture.connect().await;
    let first = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let old_token = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![first],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    fixture.child.kill().await.unwrap();
    fixture.child.wait().await.unwrap();
    assert!(desktop.request(Request::Ping {}).await.is_err());
    assert_eq!(
        desktop.request(Request::Ping {}).await.unwrap_err().kind(),
        std::io::ErrorKind::NotConnected
    );
    let mut restarted = Fixture::on_instance(fixture.instance.clone(), true).await;
    let mut new_desktop = restarted.connect().await;
    match ok(new_desktop.request(Request::List {}).await.unwrap()) {
        Reply::Sessions(list) => assert!(list.is_empty()),
        _ => panic!(),
    }
    assert_eq!(
        error(
            new_desktop
                .request(Request::Read {
                    connection: first,
                    cursor: 1,
                    max_bytes: EVENT_BYTES
                })
                .await
                .unwrap()
        ),
        ErrorCode::NotFound
    );
    assert_eq!(
        Client::connect(&restarted.instance, old_token.expose(), restarted.pid)
            .await
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    restarted.stop(&mut new_desktop).await;
}
