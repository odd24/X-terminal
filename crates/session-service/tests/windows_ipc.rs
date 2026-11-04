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
        Self::on_instance_with_data(instance, fixture, None).await
    }
    async fn on_instance_with_data(
        instance: String,
        fixture: bool,
        directory: Option<&std::path::Path>,
    ) -> Self {
        let token = SecretToken::generate();
        let mut command = Command::new(env!("CARGO_BIN_EXE_session-service"));
        command.args(["--instance", &instance]);
        if fixture {
            command.arg("--test-fixture");
        }
        if let Some(directory) = directory {
            command.arg("--data-dir").arg(directory);
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

struct ConfigTemp(std::path::PathBuf);
impl ConfigTemp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("shared-terminal-service-config-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    async fn start(&self) -> Fixture {
        Fixture::on_instance_with_data(Uuid::new_v4().to_string(), true, Some(&self.0)).await
    }
}
impl Drop for ConfigTemp {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        for _ in 0..100 {
            if std::fs::remove_dir_all(&self.0).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("isolated test directory cleanup failed");
    }
}
async fn config_call(client: &mut Client, request: config::ConfigRequest) -> config::ConfigReply {
    match ok(client.request(Request::Config { request }).await.unwrap()) {
        Reply::Config(reply) => reply,
        _ => panic!("expected config response"),
    }
}
fn portable() -> config_store::PortableProfile {
    config_store::PortableProfile {
        id: Uuid::new_v4(),
        folder_id: None,
        name: "synthetic SSH".into(),
        settings: config_store::Settings::Ssh2 {
            host: "example.invalid".into(),
            port: 22,
            username: "synthetic".into(),
            auth: config_store::Auth::Password,
            encoding: config_store::Encoding::Utf8,
        },
    }
}
fn replace_password(value: &str) -> config::CredentialEdit {
    config::CredentialEdit::Replace {
        value: config::CredentialBundle {
            password: Some(Sensitive::new(value.into())),
            private_key: None,
            passphrase: None,
        },
    }
}
#[tokio::test]
async fn config_persists_across_service_processes_and_credentials_are_only_references() {
    use config::{ConfigReply as C, ConfigRequest as Q, CredentialEdit as E};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = portable();
    let C::SavedProfile {
        profile: saved,
        revision,
    } = config_call(
        &mut client,
        Q::SaveProfile {
            profile: profile.clone(),
            credential: replace_password("synthetic protected value"),
        },
    )
    .await
    else {
        panic!("save failed")
    };
    assert!(saved.credential_ref.is_some());
    let page = config_call(
        &mut client,
        Q::Page {
            revision: Some(revision),
            offset: 0,
            folders: false,
        },
    )
    .await;
    assert!(
        !serde_json::to_string(&page)
            .unwrap()
            .contains("synthetic protected value")
    );
    assert!(
        !format!("{:?}", replace_password("synthetic protected value"))
            .contains("synthetic protected value")
    );
    // A failed profile link must keep the old profile/secret and remove only the new orphan.
    let mut invalid = profile.clone();
    invalid.folder_id = Some(Uuid::new_v4());
    assert!(matches!(
        config_call(
            &mut client,
            Q::SaveProfile {
                profile: invalid,
                credential: replace_password("failed synthetic replacement")
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Invalid
        }
    ));
    let conn = rusqlite::Connection::open(temp.0.join("credentials.sqlite")).unwrap();
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT count(*) FROM credentials", [], |row| row.get(0))
            .unwrap(),
        1
    );
    drop(conn);
    let vault = credential_vault::Vault::open(&temp.0.join("credentials.sqlite")).unwrap();
    assert!(
        vault
            .get(saved.credential_ref.unwrap())
            .unwrap()
            .expose()
            .windows(b"synthetic protected value".len())
            .any(|part| part == b"synthetic protected value")
    );
    drop(vault);
    service.stop(&mut client).await;
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    assert!(matches!(
        config_call(
            &mut client,
            Q::Page {
                revision: Some(revision),
                offset: 0,
                folders: false
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    let C::Page { profiles, .. } = config_call(
        &mut client,
        Q::Page {
            revision: None,
            offset: 0,
            folders: false,
        },
    )
    .await
    else {
        panic!("page failed")
    };
    assert_eq!(profiles, vec![saved.clone()]);
    let C::SavedProfile { profile: kept, .. } = config_call(
        &mut client,
        Q::SaveProfile {
            profile: profile.clone(),
            credential: E::Keep {},
        },
    )
    .await
    else {
        panic!("keep failed")
    };
    assert_eq!(kept.credential_ref, saved.credential_ref);
    let C::SavedProfile {
        profile: cleared, ..
    } = config_call(
        &mut client,
        Q::SaveProfile {
            profile: profile.clone(),
            credential: E::Clear {},
        },
    )
    .await
    else {
        panic!("clear failed")
    };
    assert!(cleared.credential_ref.is_none());
    assert!(matches!(
        config_call(&mut client, Q::DeleteProfile { id: profile.id }).await,
        C::Updated { .. }
    ));
    service.stop(&mut client).await;
}

#[tokio::test]
async fn config_observers_are_denied_and_revision_pages_are_bounded() {
    use config::{ConfigReply as C, ConfigRequest as Q, CredentialEdit as E};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let fixture = match ok(client.request(Request::CreateFixture {}).await.unwrap()) {
        Reply::Connection(info) => info.reference(),
        _ => panic!(),
    };
    let ticket = match ok(client
        .request(Request::IssueRead {
            scopes: vec![fixture],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, ticket.expose(), service.pid)
        .await
        .unwrap()
        .0;
    for request in [
        Q::Page {
            revision: None,
            offset: 0,
            folders: false,
        },
        Q::SaveProfile {
            profile: portable(),
            credential: E::Keep {},
        },
    ] {
        assert!(matches!(
            observer.request(Request::Config { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::PermissionDenied,
                ..
            }
        ));
    }
    for _ in 0..65 {
        assert!(matches!(
            config_call(
                &mut client,
                Q::SaveProfile {
                    profile: portable(),
                    credential: E::Keep {}
                }
            )
            .await,
            C::SavedProfile { .. }
        ));
    }
    let C::Page {
        revision,
        profiles,
        next_offset,
        ..
    } = config_call(
        &mut client,
        Q::Page {
            revision: None,
            offset: 0,
            folders: false,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(profiles.len(), 64);
    assert_eq!(next_offset, Some(64));
    let C::Page {
        profiles,
        next_offset,
        ..
    } = config_call(
        &mut client,
        Q::Page {
            revision: Some(revision),
            offset: 64,
            folders: false,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(profiles.len(), 1);
    assert!(next_offset.is_none());
    config_call(
        &mut client,
        Q::SaveFolder {
            folder: config_store::Folder {
                id: Uuid::new_v4(),
                parent_id: None,
                name: "folder".into(),
            },
        },
    )
    .await;
    assert!(matches!(
        config_call(
            &mut client,
            Q::Page {
                revision: Some(revision),
                offset: 64,
                folders: false
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    service.stop(&mut client).await;
}

#[tokio::test]
async fn configuration_owner_lock_and_unknown_schema_are_diagnosed_without_overwrite() {
    use config::{ConfigError, ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut first = temp.start().await;
    let mut a = first.connect().await;
    assert!(matches!(
        config_call(
            &mut a,
            Q::Page {
                revision: None,
                offset: 0,
                folders: false
            }
        )
        .await,
        C::Page { .. }
    ));
    let mut second = temp.start().await;
    let mut b = second.connect().await;
    assert!(matches!(
        config_call(
            &mut b,
            Q::Page {
                revision: None,
                offset: 0,
                folders: false
            }
        )
        .await,
        C::Error {
            code: ConfigError::Locked
        }
    ));
    second.stop(&mut b).await;
    first.stop(&mut a).await;
    let path = temp.0.join("config.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    assert!(matches!(
        config_call(
            &mut client,
            Q::Page {
                revision: None,
                offset: 0,
                folders: false
            }
        )
        .await,
        C::Error {
            code: ConfigError::UnsupportedSchema
        }
    ));
    assert!(matches!(
        ok(client.request(Request::Ping {}).await.unwrap()),
        Reply::Pong { .. }
    ));
    service.stop(&mut client).await;
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::write(&path, b"synthetic corrupted config").unwrap();
    let before = std::fs::read(&path).unwrap();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    assert!(matches!(
        config_call(
            &mut client,
            Q::Page {
                revision: None,
                offset: 0,
                folders: false
            }
        )
        .await,
        C::Error {
            code: ConfigError::Corrupt
        }
    ));
    service.stop(&mut client).await;
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn blocked_configuration_has_a_bounded_queue_and_does_not_block_session_ping() {
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    assert!(matches!(
        config_call(
            &mut desktop,
            config::ConfigRequest::Page {
                revision: None,
                offset: 0,
                folders: false
            }
        )
        .await,
        config::ConfigReply::Page { .. }
    ));
    let blocker = rusqlite::Connection::open(temp.0.join("config.sqlite")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut clients = Vec::new();
    for _ in 0..20 {
        clients.push(service.connect().await);
    }
    let mut tasks = tokio::task::JoinSet::new();
    for mut client in clients {
        tasks.spawn(async move {
            client
                .request(Request::Config {
                    request: config::ConfigRequest::SaveFolder {
                        folder: config_store::Folder {
                            id: Uuid::new_v4(),
                            parent_id: None,
                            name: "queued synthetic folder".into(),
                        },
                    },
                })
                .await
                .unwrap()
        });
    }
    let first = timeout(Duration::from_secs(1), tasks.join_next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            first,
            Response::Error {
                code: ErrorCode::CapacityExceeded,
                ..
            }
        ),
        "bounded actor must reject overload while DB is busy"
    );
    assert!(matches!(
        timeout(Duration::from_secs(1), desktop.request(Request::Ping {}))
            .await
            .unwrap()
            .unwrap(),
        Response::Ok {
            reply: Reply::Pong { .. },
            ..
        }
    ));
    blocker.execute_batch("ROLLBACK").unwrap();
    drop(blocker);
    let mut rejected = 1;
    let mut accepted = 0;
    while let Some(response) = tasks.join_next().await {
        match response.unwrap() {
            Response::Error {
                code: ErrorCode::CapacityExceeded,
                ..
            } => rejected += 1,
            Response::Ok {
                reply: Reply::Config(config::ConfigReply::Updated { .. }),
                ..
            } => accepted += 1,
            other => panic!("unexpected queue result: {other:?}"),
        }
    }
    assert!(rejected >= 3);
    assert_eq!(accepted + rejected, 20);
    let config::ConfigReply::Page { folders, .. } = config_call(
        &mut desktop,
        config::ConfigRequest::Page {
            revision: None,
            offset: 0,
            folders: true,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(folders.len(), accepted);
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn private_key_file_import_is_bounded_and_does_not_return_key_bytes() {
    use config::{ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-header-only-not-a-valid-key\n-----END OPENSSH PRIVATE KEY-----\n";
    let path = temp.0.join("synthetic-key");
    std::fs::write(&path, key).unwrap();
    let mut profile = portable();
    if let config_store::Settings::Ssh2 { auth, .. } = &mut profile.settings {
        *auth = config_store::Auth::PublicKey;
    }
    let saved = config_call(
        &mut client,
        Q::SaveProfileKeyFile {
            profile: profile.clone(),
            key_path: path.to_string_lossy().into_owned(),
            passphrase: None,
        },
    )
    .await;
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("synthetic-header-only")
    );
    let C::SavedProfile { profile: saved, .. } = saved else {
        panic!("key file import failed")
    };
    assert!(saved.credential_ref.is_some());
    let vault = credential_vault::Vault::open(&temp.0.join("credentials.sqlite")).unwrap();
    assert!(
        vault
            .get(saved.credential_ref.unwrap())
            .unwrap()
            .expose()
            .windows(b"synthetic-header-only".len())
            .any(|part| part == b"synthetic-header-only")
    );
    drop(vault);
    for key_path in [
        r"\\.\COM89",
        r"C:\CON",
        r"C:\COM1",
        r"C:\LPT¹",
        r"relative-key",
        r"C:\key:stream",
    ] {
        assert!(matches!(
            config_call(
                &mut client,
                Q::SaveProfileKeyFile {
                    profile: profile.clone(),
                    key_path: key_path.into(),
                    passphrase: None
                }
            )
            .await,
            C::Error {
                code: config::ConfigError::Invalid
            }
        ));
    }
    std::fs::write(&path, vec![b'x'; 65537]).unwrap();
    assert!(matches!(
        config_call(
            &mut client,
            Q::SaveProfileKeyFile {
                profile: profile.clone(),
                key_path: path.to_string_lossy().into_owned(),
                passphrase: None
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Invalid
        }
    ));
    let fixture = match ok(client.request(Request::CreateFixture {}).await.unwrap()) {
        Reply::Connection(info) => info.reference(),
        _ => panic!(),
    };
    let token = match ok(client
        .request(Request::IssueRead {
            scopes: vec![fixture],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    assert!(matches!(
        observer
            .request(Request::Config {
                request: Q::SaveProfileKeyFile {
                    profile,
                    key_path: path.to_string_lossy().into_owned(),
                    passphrase: None
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::PermissionDenied,
            ..
        }
    ));
    service.stop(&mut client).await;
}

#[tokio::test]
async fn host_key_configuration_requires_desktop_and_exact_fingerprint() {
    use config::{ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut store = config_store::Store::open(&temp.0.join("config.sqlite")).unwrap();
    let key = config_store::HostKey {
        endpoint: config_store::HostEndpoint {
            protocol: config_store::HostProtocol::Ssh2,
            host: "trust.invalid".into(),
            port: 22,
        },
        algorithm: "ssh-ed25519".into(),
        key: b"abc".to_vec(),
    };
    let review = store.review_host_key(&key).unwrap();
    store.approve_host_key(key, &review.revision).unwrap();
    drop(store);
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let C::HostKeysPage {
        keys, next_offset, ..
    } = config_call(
        &mut desktop,
        Q::HostKeysPage {
            revision: None,
            offset: 0,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(keys.len(), 1);
    assert!(next_offset.is_none());
    let fixture = match ok(desktop.request(Request::CreateFixture {}).await.unwrap()) {
        Reply::Connection(info) => info.reference(),
        _ => panic!(),
    };
    let token = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![fixture],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    for request in [
        Q::HostKeysPage {
            revision: None,
            offset: 0,
        },
        Q::ForgetHostKey {
            endpoint: keys[0].endpoint.clone(),
            algorithm: keys[0].algorithm.clone(),
            expected_fingerprint: keys[0].fingerprint.clone(),
        },
    ] {
        assert!(matches!(
            observer.request(Request::Config { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::PermissionDenied,
                ..
            }
        ));
    }
    let wrong = format!("SHA256:{}", "A".repeat(43));
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::ForgetHostKey {
                endpoint: keys[0].endpoint.clone(),
                algorithm: keys[0].algorithm.clone(),
                expected_fingerprint: wrong
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::ForgetHostKey {
                endpoint: keys[0].endpoint.clone(),
                algorithm: keys[0].algorithm.clone(),
                expected_fingerprint: keys[0].fingerprint.clone()
            }
        )
        .await,
        C::Updated { .. }
    ));
    service.stop(&mut desktop).await;
    assert!(
        config_store::Store::open(&temp.0.join("config.sqlite"))
            .unwrap()
            .host_keys()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn archive_export_preview_restore_and_new_directory_recovery_preserve_boundaries() {
    use config::{ArchiveKind, ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let original = portable();
    let C::SavedProfile { profile: saved, .. } = config_call(
        &mut desktop,
        Q::SaveProfile {
            profile: original.clone(),
            credential: replace_password("synthetic archive password"),
        },
    )
    .await
    else {
        panic!()
    };
    let C::Artifact { artifact: export } = config_call(&mut desktop, Q::ExportConfig {}).await
    else {
        panic!()
    };
    assert_eq!(export.kind, ArchiveKind::Export);
    let text = std::fs::read_to_string(temp.0.join("artifacts").join(&export.filename)).unwrap();
    assert!(!text.contains("credential_ref"));
    assert!(!text.contains("synthetic archive password"));
    let C::Artifact { artifact: backup } = config_call(&mut desktop, Q::CreateBackup {}).await
    else {
        panic!()
    };
    assert_eq!(
        config_store::Store::read_backup(&temp.0.join("artifacts").join(&backup.filename))
            .unwrap()
            .profiles[0]
            .credential_ref,
        saved.credential_ref
    );
    let fixture = match ok(desktop.request(Request::CreateFixture {}).await.unwrap()) {
        Reply::Connection(info) => info.reference(),
        _ => panic!(),
    };
    desktop
        .request(Request::AppendFixture {
            connection: fixture,
            bytes: b"synthetic output retained".to_vec(),
        })
        .await
        .unwrap();
    let before = match ok(desktop
        .request(Request::Read {
            connection: fixture,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => page,
        _ => panic!(),
    };
    let mut changed = original.clone();
    changed.name = "changed after backup".into();
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile: changed.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let C::BackupPreview {
        digest,
        current_revision: Some(revision),
        missing_credentials,
        ..
    } = config_call(&mut desktop, Q::InspectBackup { id: backup.id }).await
    else {
        panic!()
    };
    assert_eq!(missing_credentials, 0);
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::RestoreBackup {
                id: backup.id,
                digest: "0".repeat(64),
                current_revision: revision
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile: changed,
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::RestoreBackup {
                id: backup.id,
                digest: digest.clone(),
                current_revision: revision
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    let C::BackupPreview {
        current_revision: Some(revision),
        ..
    } = config_call(&mut desktop, Q::InspectBackup { id: backup.id }).await
    else {
        panic!()
    };
    let C::Restored {
        safety_backup,
        missing_credentials,
        ..
    } = config_call(
        &mut desktop,
        Q::RestoreBackup {
            id: backup.id,
            digest: digest.clone(),
            current_revision: revision,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(missing_credentials, 0);
    assert_eq!(
        config_store::Store::read_backup(&temp.0.join("artifacts").join(safety_backup.filename))
            .unwrap()
            .profiles[0]
            .name,
        "changed after backup"
    );
    let C::Page { profiles, .. } = config_call(
        &mut desktop,
        Q::Page {
            revision: None,
            offset: 0,
            folders: false,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(profiles, vec![saved.clone()]);
    let after = match ok(desktop
        .request(Request::Read {
            connection: fixture,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap())
    {
        Reply::Output(page) => page,
        _ => panic!(),
    };
    assert_eq!(
        before, after,
        "restore must not mutate/replay existing session output"
    );
    service.stop(&mut desktop).await;
    let source = temp.0.join("config.sqlite");
    let conn = rusqlite::Connection::open(&source).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    let source_before = std::fs::read(&source).unwrap();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    assert!(matches!(
        config_call(&mut desktop, Q::InspectBackup { id: backup.id }).await,
        C::BackupPreview {
            current_revision: None,
            ..
        }
    ));
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::RestoreBackup {
                id: backup.id,
                digest: digest.clone(),
                current_revision: Uuid::new_v4()
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::UnsupportedSchema
        }
    ));
    let mut second = temp.start().await;
    let mut other = second.connect().await;
    assert!(matches!(
        config_call(&mut other, Q::Archives {}).await,
        C::Error {
            code: config::ConfigError::Locked
        }
    ));
    second.stop(&mut other).await;
    let C::Recovered {
        directory_id,
        missing_credentials,
    } = config_call(
        &mut desktop,
        Q::RecoverBackup {
            id: backup.id,
            digest,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(missing_credentials, 1);
    let recovered = temp.0.join(format!("recovered-{directory_id}"));
    assert!(recovered.join("recovery.ready").is_file());
    assert!(!recovered.join("credentials.sqlite").exists());
    assert_eq!(
        config_store::Store::open(&recovered.join("config.sqlite"))
            .unwrap()
            .profiles()
            .unwrap(),
        vec![saved]
    );
    assert_eq!(std::fs::read(source).unwrap(), source_before);
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn archive_read_write_are_denied_to_observers_and_bad_sources_cannot_restore() {
    use config::{ArchiveKind, ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut desktop = service.connect().await;
    let fixture = match ok(desktop.request(Request::CreateFixture {}).await.unwrap()) {
        Reply::Connection(info) => info.reference(),
        _ => panic!(),
    };
    let token = match ok(desktop
        .request(Request::IssueRead {
            scopes: vec![fixture],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    for request in [
        Q::Archives {},
        Q::CredentialsPage {
            revision: None,
            offset: 0,
        },
        Q::InspectCredential { id: Uuid::new_v4() },
        Q::ForgetCredential {
            id: Uuid::new_v4(),
            revision: Uuid::new_v4(),
        },
        Q::CreateBackup {},
        Q::ExportConfig {},
        Q::InspectBackup { id: Uuid::new_v4() },
        Q::RestoreBackup {
            id: Uuid::new_v4(),
            digest: "0".repeat(64),
            current_revision: Uuid::new_v4(),
        },
        Q::RecoverBackup {
            id: Uuid::new_v4(),
            digest: "0".repeat(64),
        },
        Q::DeleteArchive {
            id: Uuid::new_v4(),
            kind: ArchiveKind::Backup,
        },
    ] {
        assert!(matches!(
            observer.request(Request::Config { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::PermissionDenied,
                ..
            }
        ));
    }
    let C::Artifact { artifact } = config_call(&mut desktop, Q::CreateBackup {}).await else {
        panic!()
    };
    let path = temp.0.join("artifacts").join(&artifact.filename);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    assert!(matches!(
        config_call(&mut desktop, Q::InspectBackup { id: artifact.id }).await,
        C::Error {
            code: config::ConfigError::UnsupportedSchema
        }
    ));
    std::fs::write(&path, b"synthetic corrupt backup").unwrap();
    assert!(matches!(
        config_call(&mut desktop, Q::InspectBackup { id: artifact.id }).await,
        C::Error {
            code: config::ConfigError::Corrupt
        }
    ));
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::DeleteArchive {
                id: artifact.id,
                kind: ArchiveKind::Backup
            }
        )
        .await,
        C::Updated { .. }
    ));
    assert!(!path.exists());
    service.stop(&mut desktop).await;
}

#[tokio::test]
async fn credential_inventory_forgetting_protects_live_and_backup_references_and_stale_previews() {
    use config::{ArchiveKind, ConfigError as E, ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = portable();
    let C::SavedProfile {
        profile: saved,
        revision: initial,
    } = config_call(
        &mut client,
        Q::SaveProfile {
            profile: profile.clone(),
            credential: replace_password("synthetic forget fixture"),
        },
    )
    .await
    else {
        panic!()
    };
    let id = saved.credential_ref.unwrap();
    let C::CredentialsPage {
        entries,
        next_offset,
        ..
    } = config_call(
        &mut client,
        Q::CredentialsPage {
            revision: None,
            offset: 0,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, id);
    assert_eq!(entries[0].current_profiles, 1);
    assert!(next_offset.is_none());
    let serialized = serde_json::to_string(&entries).unwrap();
    assert!(!serialized.contains("synthetic forget fixture"));
    assert!(!serialized.contains("protected"));
    assert!(matches!(
        config_call(
            &mut client,
            Q::ForgetCredential {
                id,
                revision: initial
            }
        )
        .await,
        C::Error { code: E::InUse }
    ));
    let C::Artifact { artifact: backup } = config_call(&mut client, Q::CreateBackup {}).await
    else {
        panic!()
    };
    let C::SavedProfile {
        revision: cleared, ..
    } = config_call(
        &mut client,
        Q::SaveProfile {
            profile,
            credential: config::CredentialEdit::Clear {},
        },
    )
    .await
    else {
        panic!()
    };
    assert!(matches!(
        config_call(
            &mut client,
            Q::ForgetCredential {
                id,
                revision: initial
            }
        )
        .await,
        C::Error { code: E::Conflict }
    ));
    assert!(matches!(
        config_call(&mut client, Q::InspectCredential { id }).await,
        C::CredentialPreview {
            current_profiles: 0,
            backup_profiles: 1,
            ..
        }
    ));
    assert!(matches!(
        config_call(
            &mut client,
            Q::ForgetCredential {
                id,
                revision: cleared
            }
        )
        .await,
        C::Error { code: E::InUse }
    ));
    let backup_path = temp.0.join("artifacts").join(&backup.filename);
    let bytes = std::fs::read(&backup_path).unwrap();
    std::fs::write(&backup_path, b"broken managed backup").unwrap();
    assert!(matches!(
        config_call(&mut client, Q::InspectCredential { id }).await,
        C::Error { code: E::Corrupt }
    ));
    assert!(matches!(
        config_call(
            &mut client,
            Q::ForgetCredential {
                id,
                revision: cleared
            }
        )
        .await,
        C::Error { code: E::Corrupt }
    ));
    std::fs::write(&backup_path, bytes).unwrap();
    config_call(
        &mut client,
        Q::DeleteArchive {
            id: backup.id,
            kind: ArchiveKind::Backup,
        },
    )
    .await;
    let C::CredentialPreview { revision, .. } =
        config_call(&mut client, Q::InspectCredential { id }).await
    else {
        panic!()
    };
    // A backup made after preview must be rechecked by the actual delete.
    let C::Artifact {
        artifact: empty_backup,
    } = config_call(&mut client, Q::CreateBackup {}).await
    else {
        panic!()
    };
    // Inject a reference into that backup without changing the service revision.
    let connection =
        rusqlite::Connection::open(temp.0.join("artifacts").join(&empty_backup.filename)).unwrap();
    connection
        .execute("UPDATE profiles SET credential_ref=?1", [id.to_string()])
        .unwrap();
    drop(connection);
    assert!(matches!(
        config_call(&mut client, Q::ForgetCredential { id, revision }).await,
        C::Error { code: E::InUse }
    ));
    config_call(
        &mut client,
        Q::DeleteArchive {
            id: empty_backup.id,
            kind: ArchiveKind::Backup,
        },
    )
    .await;
    let C::CredentialPreview {
        revision,
        current_profiles: 0,
        backup_profiles: 0,
        ..
    } = config_call(&mut client, Q::InspectCredential { id }).await
    else {
        panic!()
    };
    assert!(matches!(
        config_call(&mut client, Q::ForgetCredential { id, revision }).await,
        C::Updated { .. }
    ));
    assert!(matches!(
        config_call(&mut client, Q::InspectCredential { id }).await,
        C::Error { code: E::NotFound }
    ));
    service.stop(&mut client).await;
    let mut restarted = temp.start().await;
    let mut client = restarted.connect().await;
    assert!(
        matches!(config_call(&mut client,Q::CredentialsPage{revision:None,offset:0}).await,C::CredentialsPage{entries,..} if entries.is_empty())
    );
    restarted.stop(&mut client).await;
    let vault = credential_vault::Vault::open(&temp.0.join("credentials.sqlite")).unwrap();
    assert!(matches!(
        vault.get(id),
        Err(credential_vault::Error::NotFound)
    ));
    drop(vault);
}

#[tokio::test]
async fn credential_inventory_pages_are_bounded_and_revision_consistent() {
    use config::{ConfigError as E, ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut vault = credential_vault::Vault::open(&temp.0.join("credentials.sqlite")).unwrap();
    let mut ids = Vec::new();
    for _ in 0..65 {
        let id = Uuid::new_v4();
        vault
            .set(
                id,
                credential_vault::Secret::new(b"synthetic inventory fixture".to_vec()).unwrap(),
            )
            .unwrap();
        ids.push(id);
    }
    drop(vault);
    ids.sort();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let C::CredentialsPage {
        revision,
        entries,
        next_offset: Some(64),
    } = config_call(
        &mut client,
        Q::CredentialsPage {
            revision: None,
            offset: 0,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(entries.len(), 64);
    assert!(entries.iter().all(|entry| entry.current_profiles == 0));
    assert_eq!(
        entries.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        ids[..64]
    );
    assert!(
        matches!(config_call(&mut client,Q::CredentialsPage{revision:Some(revision),offset:64}).await,C::CredentialsPage{entries,next_offset:None,..} if entries.len()==1 && entries[0].id==ids[64])
    );
    config_call(
        &mut client,
        Q::SaveFolder {
            folder: config_store::Folder {
                id: Uuid::new_v4(),
                parent_id: None,
                name: "revision fixture".into(),
            },
        },
    )
    .await;
    assert!(matches!(
        config_call(
            &mut client,
            Q::CredentialsPage {
                revision: Some(revision),
                offset: 64
            }
        )
        .await,
        C::Error { code: E::Conflict }
    ));
    service.stop(&mut client).await;
}

#[path = "support/ssh_fixture.rs"]
mod ssh_fixture;
async fn ssh_call(client: &mut Client, request: ssh::Request) -> ssh::Reply {
    match ok(client.request(Request::Ssh { request }).await.unwrap()) {
        Reply::Ssh(reply) => reply,
        _ => panic!("SSH response required"),
    }
}
async fn ssh_status(
    client: &mut Client,
    connection: ConnectionRef,
    test: impl Fn(&ssh::Status) -> bool,
) -> ssh::Status {
    timeout(Duration::from_secs(6), async {
        loop {
            let ssh::Reply::Status(status) =
                ssh_call(client, ssh::Request::Status { connection }).await
            else {
                panic!()
            };
            if test(&status) {
                return *status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn ssh_profile(
    fixture: &ssh_fixture::Fixture,
    auth: config_store::Auth,
) -> config_store::PortableProfile {
    let mut profile = portable();
    profile.settings = config_store::Settings::Ssh2 {
        host: "127.0.0.1".into(),
        port: fixture.port,
        username: "synthetic".into(),
        auth,
        encoding: config_store::Encoding::Utf8,
    };
    profile
}
async fn ssh_start(client: &mut Client, id: Uuid, request_id: Uuid) -> ConnectionInfo {
    let ssh::Reply::Started { connection } = ssh_call(
        client,
        ssh::Request::Start {
            profile_id: id,
            request_id,
            cols: 80,
            rows: 24,
        },
    )
    .await
    else {
        panic!()
    };
    connection
}
#[tokio::test]
async fn ssh2_service_shares_real_transport_output_and_protects_host_and_credential_challenges() {
    use ssh::{Challenge as H, Failure, Request as S};
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&remote.password),
        },
    )
    .await;
    let request_id = Uuid::new_v4();
    let connection = ssh_start(&mut client, profile.id, request_id).await;
    let reference = connection.reference();
    assert_eq!(
        ssh_start(&mut client, profile.id, request_id).await,
        connection
    );
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Start {
                    profile_id: profile.id,
                    request_id,
                    cols: 90,
                    rows: 24
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let pending = ssh_status(&mut client, reference, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    let Some(H::HostKey { id, review }) = pending.challenge else {
        panic!()
    };
    assert_eq!(review.status, config_store::HostKeyStatus::Unknown);
    assert_eq!(review.candidate.fingerprint, remote.pin);
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::Authenticate {
                    connection: reference,
                    challenge_id: id,
                    use_saved: true,
                    password: None
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let token = match ok(client
        .request(Request::IssueRead {
            scopes: vec![reference],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    for request in [
        S::Status {
            connection: reference,
        },
        S::AnswerHost {
            connection: reference,
            challenge_id: id,
            approve: true,
        },
        S::Start {
            profile_id: profile.id,
            request_id: Uuid::new_v4(),
            cols: 80,
            rows: 24,
        },
        S::Close {
            connection: reference,
        },
        S::Authenticate {
            connection: reference,
            challenge_id: id,
            use_saved: true,
            password: None,
        },
        S::AnswerInteractive {
            connection: reference,
            challenge_id: id,
            answers: vec![],
        },
    ] {
        assert!(matches!(
            observer.request(Request::Ssh { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::PermissionDenied,
                ..
            }
        ));
    }
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection: reference,
            challenge_id: id,
            approve: true,
        },
    )
    .await;
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::AnswerHost {
                    connection: reference,
                    challenge_id: id,
                    approve: true
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidState,
            ..
        }
    ));
    let pending = ssh_status(&mut client, reference, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    let Some(H::Credentials {
        id,
        stored_available,
        ..
    }) = pending.challenge
    else {
        panic!()
    };
    assert!(stored_available);
    ssh_call(
        &mut client,
        S::Authenticate {
            connection: reference,
            challenge_id: id,
            use_saved: true,
            password: None,
        },
    )
    .await;
    let status = ssh_status(&mut client, reference, |status| {
        status.connection.state == State::Connected
    })
    .await;
    assert!(status.failure.is_none());
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    let read = |connection| Request::Read {
        connection,
        cursor: 1,
        max_bytes: 65536,
    };
    let mut first = None;
    for _ in 0..100 {
        let Reply::Output(output) = ok(client.request(read(reference)).await.unwrap()) else {
            panic!()
        };
        if output
            .events
            .iter()
            .flat_map(|event| event.bytes.iter())
            .copied()
            .collect::<Vec<_>>()
            == b"before-pty|before-shell|service-shared-shell\r\n"
        {
            first = Some(output);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let first = first.unwrap();
    let Reply::Output(other) = ok(observer.request(read(reference)).await.unwrap()) else {
        panic!()
    };
    assert_eq!(first, other);
    remote.push(b"new remote bytes").await;
    assert!(matches!(
        client
            .request(Request::RemoveFixture {
                connection: reference
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::Unsupported,
            ..
        }
    ));
    assert!(matches!(
        client
            .request(Request::CloseFixture {
                connection: reference
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::Unsupported,
            ..
        }
    ));
    remote.end(7).await;
    let status = ssh_status(&mut client, reference, |status| {
        status.connection.state == State::Disconnected
    })
    .await;
    assert_eq!(status.shell_exit_status, Some(7));
    let config::ConfigReply::HostKeysPage { keys, .. } = config_call(
        &mut client,
        config::ConfigRequest::HostKeysPage {
            revision: None,
            offset: 0,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].fingerprint, remote.pin);
    let next = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let pending = ssh_status(&mut client, next, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    let Some(H::Credentials { id, .. }) = pending.challenge else {
        panic!()
    };
    ssh_call(
        &mut client,
        S::Authenticate {
            connection: next,
            challenge_id: id,
            use_saved: false,
            password: Some(Sensitive::new("wrong synthetic service password".into())),
        },
    )
    .await;
    let pending = ssh_status(&mut client, next, |status| {
        status.failure == Some(Failure::AuthenticationRejected)
            && matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    let Some(H::Credentials { id, .. }) = pending.challenge else {
        panic!()
    };
    ssh_call(
        &mut client,
        S::Authenticate {
            connection: next,
            challenge_id: id,
            use_saved: true,
            password: None,
        },
    )
    .await;
    ssh_status(&mut client, next, |status| {
        status.connection.state == State::Connected && status.failure.is_none()
    })
    .await;
    ssh_call(&mut client, S::Close { connection: next }).await;
    ssh_status(&mut client, next, |status| {
        status.connection.state == State::Disconnected
    })
    .await;
    service.stop(&mut client).await;
}
#[tokio::test]
async fn ssh2_service_changed_host_keys_stale_approval_and_closed_challenges_never_authenticate() {
    use ssh::{Challenge as H, Failure, Request as S};
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut store = config_store::Store::open(&temp.0.join("config.sqlite")).unwrap();
    let key = config_store::HostKey {
        endpoint: config_store::HostEndpoint {
            protocol: config_store::HostProtocol::Ssh2,
            host: "127.0.0.1".into(),
            port: remote.port,
        },
        algorithm: "ssh-ed25519".into(),
        key: b"synthetic previous public key".to_vec(),
    };
    let review = store.review_host_key(&key).unwrap();
    store.approve_host_key(key, &review.revision).unwrap();
    drop(store);
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&remote.password),
        },
    )
    .await;
    for approve in [false, true] {
        let connection = ssh_start(&mut client, profile.id, Uuid::new_v4())
            .await
            .reference();
        let pending = ssh_status(&mut client, connection, |status| {
            matches!(status.challenge, Some(H::HostKey { .. }))
        })
        .await;
        let Some(H::HostKey { id, review }) = pending.challenge else {
            panic!()
        };
        assert_eq!(review.status, config_store::HostKeyStatus::Changed);
        assert_eq!(review.known.len(), 1);
        if approve {
            let conn = rusqlite::Connection::open(temp.0.join("config.sqlite")).unwrap();
            conn.execute(
                "UPDATE host_keys SET key=?1",
                [b"other synthetic key".as_slice()],
            )
            .unwrap();
        }
        ssh_call(
            &mut client,
            S::AnswerHost {
                connection,
                challenge_id: id,
                approve,
            },
        )
        .await;
        let failed = ssh_status(&mut client, connection, |status| {
            status.connection.state == State::Failed
        })
        .await;
        assert_eq!(
            failed.failure,
            Some(if approve {
                Failure::HostKeyConflict
            } else {
                Failure::HostKeyRejected
            })
        );
    }
    let connection = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let pending = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    let id = pending.challenge.unwrap().id();
    ssh_call(&mut client, S::Close { connection }).await;
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::AnswerHost {
                    connection,
                    challenge_id: id,
                    approve: true
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidState,
            ..
        }
    ));
    assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 0);
    let conn = rusqlite::Connection::open(temp.0.join("config.sqlite")).unwrap();
    let saved: Vec<u8> = conn
        .query_row("SELECT key FROM host_keys", [], |row| row.get(0))
        .unwrap();
    assert_ne!(saved, remote.key);
    drop(conn);
    service.stop(&mut client).await;
}
#[tokio::test]
async fn ssh2_service_interactive_challenges_are_connection_scoped_and_sensitive() {
    use ssh::{Challenge as H, Request as S};
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::KeyboardInteractive);
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let connection = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let pending = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection,
            challenge_id: pending.challenge.unwrap().id(),
            approve: true,
        },
    )
    .await;
    let pending = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::Interactive { .. }))
    })
    .await;
    let Some(H::Interactive { id, prompts, .. }) = pending.challenge else {
        panic!()
    };
    assert_eq!(prompts.len(), 1);
    assert!(!prompts[0].echo);
    let mut stale = connection;
    stale.generation += 1;
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::AnswerInteractive {
                    connection: stale,
                    challenge_id: id,
                    answers: vec![Sensitive::new(remote.password.to_string())]
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::StaleGeneration,
            ..
        }
    ));
    ssh_call(
        &mut client,
        S::AnswerInteractive {
            connection,
            challenge_id: id,
            answers: vec![Sensitive::new(remote.password.to_string())],
        },
    )
    .await;
    let status = ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Connected
    })
    .await;
    assert!(
        !serde_json::to_string(&status)
            .unwrap()
            .contains(remote.password.as_str())
    );
    remote.signal().await;
    let status = ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Disconnected
    })
    .await;
    assert_eq!(status.shell_exit_signal.as_deref(), Some("TERM"));
    assert!(status.shell_exit_status.is_none());
    assert!(status.failure.is_none());
    service.stop(&mut client).await;
}

#[tokio::test]
async fn ssh2_service_resolves_encrypted_key_internally_and_rejects_changed_profile_snapshot() {
    use ssh::{Challenge as H, Failure, Request as S};
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service =
        Fixture::on_instance_with_data(Uuid::new_v4().to_string(), false, Some(&temp.0)).await;
    let mut client = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::PublicKey);
    let encrypted = remote
        .client_key
        .encrypt(&mut rand::rng(), remote.password.as_bytes())
        .unwrap()
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let path = temp.0.join("synthetic-import-only.key");
    std::fs::write(&path, encrypted.as_bytes()).unwrap();
    let saved = config_call(
        &mut client,
        config::ConfigRequest::SaveProfileKeyFile {
            profile: profile.clone(),
            key_path: path.to_string_lossy().into_owned(),
            passphrase: Some(Sensitive::new(remote.password.to_string())),
        },
    )
    .await;
    assert!(matches!(saved, config::ConfigReply::SavedProfile { .. }));
    let connection = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let pending = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection,
            challenge_id: pending.challenge.unwrap().id(),
            approve: true,
        },
    )
    .await;
    let pending = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    ssh_call(
        &mut client,
        S::Authenticate {
            connection,
            challenge_id: pending.challenge.unwrap().id(),
            use_saved: true,
            password: None,
        },
    )
    .await;
    ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Connected
    })
    .await;
    ssh_call(&mut client, S::Close { connection }).await;
    // Begin another connection, then edit the profile after its snapshot was taken.
    let connection = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let pending = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    let attempts = remote.attempts.load(std::sync::atomic::Ordering::SeqCst);
    let mut edited = profile;
    edited.name = "Changed after SSH start".into();
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: edited,
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    ssh_call(
        &mut client,
        S::Authenticate {
            connection,
            challenge_id: pending.challenge.unwrap().id(),
            use_saved: true,
            password: None,
        },
    )
    .await;
    let status = ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Failed
    })
    .await;
    assert_eq!(status.failure, Some(Failure::CredentialUnavailable));
    assert_eq!(
        remote.attempts.load(std::sync::atomic::Ordering::SeqCst),
        attempts
    );
    service.stop(&mut client).await;
}

#[tokio::test]
async fn ssh2_service_remote_disconnect_fails_without_an_invented_exit_code() {
    use ssh::{Challenge as H, Failure, Request as S};
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let profile = ssh_profile(&remote, config_store::Auth::Password);
    config_call(
        &mut client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&remote.password),
        },
    )
    .await;
    let connection = ssh_start(&mut client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let status = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    ssh_call(
        &mut client,
        S::AnswerHost {
            connection,
            challenge_id: status.challenge.unwrap().id(),
            approve: true,
        },
    )
    .await;
    let status = ssh_status(&mut client, connection, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    ssh_call(
        &mut client,
        S::Authenticate {
            connection,
            challenge_id: status.challenge.unwrap().id(),
            use_saved: true,
            password: None,
        },
    )
    .await;
    ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Connected
    })
    .await;
    remote.disconnect().await;
    let status = ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Failed
    })
    .await;
    assert_eq!(status.failure, Some(Failure::Transport));
    assert!(status.shell_exit_status.is_none());
    let Reply::Output(output) = ok(client
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: 65536,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(output.disconnected);
    service.stop(&mut client).await;
}

async fn ssh_connected_fixture(
    client: &mut Client,
    remote: &ssh_fixture::Fixture,
) -> ConnectionRef {
    use ssh::{Challenge as H, Request as S};
    let profile = ssh_profile(remote, config_store::Auth::Password);
    config_call(
        client,
        config::ConfigRequest::SaveProfile {
            profile: profile.clone(),
            credential: replace_password(&remote.password),
        },
    )
    .await;
    let connection = ssh_start(client, profile.id, Uuid::new_v4())
        .await
        .reference();
    let status = ssh_status(client, connection, |status| {
        matches!(status.challenge, Some(H::HostKey { .. }))
    })
    .await;
    ssh_call(
        client,
        S::AnswerHost {
            connection,
            challenge_id: status.challenge.unwrap().id(),
            approve: true,
        },
    )
    .await;
    let status = ssh_status(client, connection, |status| {
        matches!(status.challenge, Some(H::Credentials { .. }))
    })
    .await;
    ssh_call(
        client,
        S::Authenticate {
            connection,
            challenge_id: status.challenge.unwrap().id(),
            use_saved: true,
            password: None,
        },
    )
    .await;
    ssh_status(client, connection, |status| {
        status.connection.state == State::Connected
    })
    .await;
    connection
}
async fn input_status(
    client: &mut Client,
    connection: ConnectionRef,
    id: Uuid,
    accept: impl Fn(&session_core::input::Receipt) -> bool,
) -> session_core::input::Receipt {
    timeout(Duration::from_secs(4), async {
        loop {
            let ssh::Reply::Input(receipt) = ssh_call(
                client,
                ssh::Request::InputStatus {
                    connection,
                    request_id: id,
                },
            )
            .await
            else {
                panic!()
            };
            if accept(&receipt) {
                return receipt;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
fn input_write(connection: ConnectionRef, request_id: Uuid, bytes: &[u8]) -> ssh::Request {
    ssh::Request::Write {
        connection,
        request_id,
        bytes: SensitiveBytes::new(bytes.to_vec()),
    }
}
#[tokio::test]
async fn ssh2_input_is_fifo_deduplicated_generation_scoped_and_observer_cannot_write() {
    use session_core::input::InputState as I;
    use ssh::Request as S;
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let ids = [Uuid::new_v4(), Uuid::new_v4()];
    ssh_call(&mut client, input_write(connection, ids[0], b"first|")).await;
    ssh_call(&mut client, input_write(connection, ids[0], b"first|")).await;
    ssh_call(&mut client, input_write(connection, ids[1], b"second|")).await;
    for id in ids {
        let receipt = input_status(&mut client, connection, id, |receipt| {
            receipt.state == I::PipelineQueued
        })
        .await;
        assert!(receipt.pipeline_bytes.is_some());
    }
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(connection, ids[0], b"different input")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    let resize = Uuid::new_v4();
    ssh_call(
        &mut client,
        S::Resize {
            connection,
            request_id: resize,
            cols: 101,
            rows: 31,
        },
    )
    .await;
    ssh_call(
        &mut client,
        S::Resize {
            connection,
            request_id: resize,
            cols: 101,
            rows: 31,
        },
    )
    .await;
    let receipt = input_status(&mut client, connection, resize, |receipt| {
        receipt.state == I::PipelineQueued
    })
    .await;
    assert!(receipt.pipeline_bytes.is_none());
    timeout(Duration::from_secs(3), async {
        loop {
            if *remote.sizes.lock().unwrap() == [(80, 24), (101, 31)]
                && remote.received.lock().unwrap().concat() == b"first|second|"
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        *remote.observations.lock().unwrap(),
        vec![
            ssh_fixture::Observation::Data(b"first|".to_vec()),
            ssh_fixture::Observation::Data(b"second|".to_vec()),
            ssh_fixture::Observation::Resize(101, 31)
        ]
    );
    let token = match ok(client
        .request(Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    {
        Reply::ReadTicket { token, .. } => token,
        _ => panic!(),
    };
    let mut observer = Client::connect(&service.instance, token.expose(), service.pid)
        .await
        .unwrap()
        .0;
    for request in [
        input_write(connection, Uuid::new_v4(), b"not permitted"),
        S::Resize {
            connection,
            request_id: Uuid::new_v4(),
            cols: 90,
            rows: 25,
        },
        S::InputStatus {
            connection,
            request_id: ids[0],
        },
    ] {
        assert!(matches!(
            observer.request(Request::Ssh { request }).await.unwrap(),
            Response::Error {
                code: ErrorCode::PermissionDenied,
                ..
            }
        ));
    }
    let mut stale = connection;
    stale.generation += 1;
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(stale, Uuid::new_v4(), b"stale")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::StaleGeneration,
            ..
        }
    ));
    let Reply::Output(output) = ok(observer
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: 65536,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(
        output
            .events
            .iter()
            .flat_map(|event| event.bytes.iter())
            .copied()
            .collect::<Vec<_>>()
            .ends_with(b"first|second|")
    );
    ssh_call(&mut client, S::Close { connection }).await;
    assert_eq!(
        input_status(&mut client, connection, ids[0], |_| true)
            .await
            .state,
        I::PipelineQueued
    );
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(connection, Uuid::new_v4(), b"after close")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::NotConnected,
            ..
        }
    ));
    assert_eq!(remote.received.lock().unwrap().concat(), b"first|second|");
    service.stop(&mut client).await;
}
#[tokio::test]
async fn ssh2_input_backpressure_has_a_bounded_queue_and_close_does_not_replay_partial_or_unsent_input()
 {
    use session_core::input::InputState as I;
    use ssh::Request as S;
    let remote = ssh_fixture::Fixture::options(true).await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let first = Uuid::new_v4();
    let payload = vec![b'x'; 65536];
    ssh_call(&mut client, input_write(connection, first, &payload)).await;
    input_status(&mut client, connection, first, |receipt| {
        receipt.state == I::Dispatching
    })
    .await;
    timeout(Duration::from_secs(2), async {
        while remote.received.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let mut pending = Vec::new();
    for _ in 0..16 {
        let id = Uuid::new_v4();
        let ssh::Reply::Input(receipt) = ssh_call(
            &mut client,
            input_write(connection, id, b"must stay unsent"),
        )
        .await
        else {
            panic!()
        };
        assert_eq!(receipt.state, I::Pending);
        pending.push(id);
    }
    let rejected = Uuid::new_v4();
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(connection, rejected, b"queue overflow")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::CapacityExceeded,
            ..
        }
    ));
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: S::InputStatus {
                    connection,
                    request_id: rejected
                }
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::NotFound,
            ..
        }
    ));
    assert!(matches!(
        ok(client.request(Request::Ping {}).await.unwrap()),
        Reply::Pong { .. }
    ));
    assert!(matches!(
        ok(client
            .request(Request::Read {
                connection,
                cursor: 1,
                max_bytes: 65536
            })
            .await
            .unwrap()),
        Reply::Output(_)
    ));
    ssh_call(&mut client, input_write(connection, first, &payload)).await;
    ssh_call(&mut client, S::Close { connection }).await;
    let first_receipt = input_status(&mut client, connection, first, |receipt| {
        receipt.state == I::Unknown
    })
    .await;
    assert!(first_receipt.pipeline_bytes.is_none());
    for id in pending {
        let receipt = input_status(&mut client, connection, id, |_| true).await;
        assert_eq!(receipt.state, I::CancelledBeforeDispatch);
        assert!(receipt.pipeline_bytes.is_none());
    }
    let ssh::Reply::Input(receipt) =
        ssh_call(&mut client, input_write(connection, first, &payload)).await
    else {
        panic!()
    };
    assert_eq!(receipt.state, I::Unknown);
    assert!(matches!(
        client
            .request(Request::Ssh {
                request: input_write(connection, first, b"changed retry")
            })
            .await
            .unwrap(),
        Response::Error {
            code: ErrorCode::InvalidArgument,
            ..
        }
    ));
    assert_eq!(remote.received.lock().unwrap().concat(), vec![b'x'; 32768]);
    service.stop(&mut client).await;
}

#[tokio::test]
async fn ssh2_input_timeout_keeps_a_partial_send_unknown_and_stops_following_commands() {
    use session_core::input::{InputFailure, InputState as I};
    use ssh::Request as S;
    let remote = ssh_fixture::Fixture::options(true).await;
    let temp = ConfigTemp::new();
    let mut service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let first = Uuid::new_v4();
    let queued = Uuid::new_v4();
    let payload = vec![b't'; 65536];
    ssh_call(&mut client, input_write(connection, first, &payload)).await;
    input_status(&mut client, connection, first, |receipt| {
        receipt.state == I::Dispatching
    })
    .await;
    ssh_call(
        &mut client,
        input_write(connection, queued, b"must not follow timed out send"),
    )
    .await;
    let receipt = timeout(Duration::from_secs(20), async {
        loop {
            let ssh::Reply::Input(receipt) = ssh_call(
                &mut client,
                S::InputStatus {
                    connection,
                    request_id: first,
                },
            )
            .await
            else {
                panic!()
            };
            if receipt.state == I::Unknown {
                break receipt;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(receipt.failure, Some(InputFailure::Timeout));
    assert!(receipt.pipeline_bytes.is_none());
    let status = ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Failed
    })
    .await;
    assert_eq!(status.failure, Some(ssh::Failure::TransportTimeout));
    assert_eq!(
        input_status(&mut client, connection, queued, |_| true)
            .await
            .state,
        I::CancelledBeforeDispatch
    );
    let ssh::Reply::Input(retry) =
        ssh_call(&mut client, input_write(connection, first, &payload)).await
    else {
        panic!()
    };
    assert_eq!(retry, receipt);
    assert_eq!(remote.received.lock().unwrap().concat(), vec![b't'; 32768]);
    service.stop(&mut client).await;
}

#[path = "support/exec_cases.rs"]
mod exec_cases;

#[path = "support/rekey_cases.rs"]
mod rekey_cases;

#[path = "support/reconnect_cases.rs"]
mod reconnect_cases;
