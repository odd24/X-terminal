use super::*;
use session_core::access::{Action, Scope, Target};
use std::path::{Path, PathBuf};
use tokio::net::TcpListener;

async fn save(client: &mut Client, port: u16) -> (Uuid, Uuid) {
    let mut profile = portable();
    profile.settings = config_store::Settings::Ssh1 {
        host: "127.0.0.1".into(),
        port,
        username: "p13-fixture".into(),
        explicitly_enabled: true,
        encoding: config_store::Encoding::Utf8,
    };
    let id = profile.id;
    let config::ConfigReply::SavedProfile { revision, .. } = config_call(
        client,
        config::ConfigRequest::SaveProfile {
            profile,
            credential: config::CredentialEdit::Clear {},
        },
    )
    .await
    else {
        panic!("saved SSH1 configuration required")
    };
    (id, revision)
}

fn fixed(profile_id: Uuid, revision: Uuid, request_id: Uuid) -> ssh::Request {
    ssh::Request::StartFixed {
        profile_id,
        revision,
        request_id,
        cols: 80,
        rows: 24,
    }
}

async fn denied(client: &mut Client, request: Request, code: ErrorCode) {
    let result = client.request(request).await.unwrap();
    assert!(
        matches!(result, Response::Error { code: actual, .. } if actual == code),
        "{result:?}"
    );
}

async fn start(client: &mut Client, profile_id: Uuid, revision: Uuid) -> ConnectionRef {
    let request_id = Uuid::new_v4();
    let ssh::Reply::ConnectReceipt(receipt) =
        ssh_call(client, fixed(profile_id, revision, request_id)).await
    else {
        panic!("fixed SSH1 receipt")
    };
    assert_eq!(receipt.request_id, request_id);
    assert_eq!(receipt.profile_id, profile_id);
    assert_eq!(receipt.revision, revision);
    assert_eq!(receipt.connection.protocol, Protocol::Ssh1);
    let ssh::Reply::ConnectReceipt(recovered) = ssh_call(
        client,
        ssh::Request::ConnectStatus {
            profile_id,
            revision,
            request_id,
        },
    )
    .await
    else {
        panic!("fixed SSH1 receipt recovery")
    };
    assert_eq!(recovered, receipt);
    receipt.connection.reference()
}

async fn host(client: &mut Client, connection: ConnectionRef) -> Uuid {
    let status = ssh_status(client, connection, |value| {
        value.challenge.is_some() || value.failure.is_some()
    })
    .await;
    assert!(
        status.failure.is_none(),
        "SSH1 host phase failed: {:?}",
        status.failure
    );
    let Some(ssh::Challenge::HostKey { id, review }) = status.challenge else {
        panic!("SSH1 host challenge")
    };
    assert_eq!(status.connection.protocol, Protocol::Ssh1);
    assert_eq!(
        review.candidate.endpoint.protocol,
        config_store::HostProtocol::Ssh1
    );
    assert_eq!(review.candidate.algorithm, "rsa1");
    assert!(review.candidate.fingerprint.starts_with("SHA256:"));
    assert_eq!(review.status, config_store::HostKeyStatus::Unknown);
    id
}

async fn stop_numbered(client: &mut Client, connection: ConnectionRef) {
    let request_id = Uuid::new_v4();
    assert!(matches!(
        ssh_call(
            client,
            ssh::Request::Disconnect {
                connection,
                request_id
            }
        )
        .await,
        ssh::Reply::Disconnect(_)
    ));
    timeout(Duration::from_secs(4), async {
        loop {
            let ssh::Reply::Disconnect(close) = ssh_call(
                client,
                ssh::Request::DisconnectStatus {
                    connection,
                    request_id,
                },
            )
            .await
            else {
                panic!("SSH1 disconnect receipt")
            };
            assert_eq!(close.connection, connection);
            if close.state == session_core::disconnect::State::TransportEnded {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn positive(client: &mut Client, connection: ConnectionRef, source: &Path) {
    let id = host(client, connection).await;
    denied(
        client,
        Request::Ssh {
            request: ssh::Request::AnswerHost {
                connection: ConnectionRef {
                    generation: connection.generation + 1,
                    ..connection
                },
                challenge_id: id,
                approve: true,
            },
        },
        ErrorCode::StaleGeneration,
    )
    .await;
    ssh_call(
        client,
        ssh::Request::AnswerHost {
            connection,
            challenge_id: id,
            approve: true,
        },
    )
    .await;
    let status = ssh_status(client, connection, |value| {
        matches!(value.challenge, Some(ssh::Challenge::Credentials { .. }))
    })
    .await;
    let Some(ssh::Challenge::Credentials {
        id,
        auth,
        stored_available,
    }) = status.challenge
    else {
        panic!("SSH1 password challenge")
    };
    assert_eq!(auth, config_store::Auth::Password);
    assert!(!stored_available);
    denied(
        client,
        Request::Ssh {
            request: ssh::Request::Authenticate {
                connection,
                challenge_id: id,
                use_saved: true,
                password: None,
            },
        },
        ErrorCode::InvalidState,
    )
    .await;
    let synthetic = ssh1_fixture::password(source).unwrap();
    let synthetic = std::str::from_utf8(synthetic.expose()).unwrap();
    ssh_call(
        client,
        ssh::Request::Authenticate {
            connection,
            challenge_id: id,
            use_saved: false,
            password: Some(Sensitive::new(synthetic.into())),
        },
    )
    .await;
    let status = ssh_status(client, connection, |value| {
        value.connection.state == State::Connected || value.failure.is_some()
    })
    .await;
    assert_eq!(
        status.connection.state,
        State::Connected,
        "{:?}",
        status.failure
    );
    assert_eq!(status.connection.protocol, Protocol::Ssh1);
    assert!(status.failure.is_none());
    denied(
        client,
        Request::IssueRead {
            scopes: vec![connection],
            lifetime_ms: 5000,
        },
        ErrorCode::Unsupported,
    )
    .await;
    denied(
        client,
        Request::Agent {
            request: agent::Request::Grant {
                request_id: Uuid::new_v4(),
                lifetime_ms: 5000,
                scopes: vec![Scope {
                    target: Target::Connection { connection },
                    action: Action::Read,
                }],
            },
        },
        ErrorCode::Unsupported,
    )
    .await;
    let Reply::Logging(logging::Reply::Info(recording)) = ok(client
        .request(Request::Logging {
            request: logging::Request::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: logging::Limits {
                    segment_bytes: 128 * 1024,
                    segments: 2,
                },
            },
        })
        .await
        .unwrap())
    else {
        panic!("real SSH1 recording")
    };
    assert_eq!(recording.protocol, Protocol::Ssh1);
    let request_id = Uuid::new_v4();
    let bytes = b"test -t 0 && test -t 1 && printf '\\nP13_IPC_DATA_OK\\n'\n";
    let ssh::Reply::Input(receipt) =
        ssh_call(client, input_write(connection, request_id, bytes)).await
    else {
        panic!("SSH1 input receipt")
    };
    assert_eq!(receipt.request_id, request_id);
    timeout(Duration::from_secs(6), async {
        loop {
            let ssh::Reply::Input(receipt) = ssh_call(
                client,
                ssh::Request::InputStatus {
                    connection,
                    request_id,
                },
            )
            .await
            else {
                panic!("SSH1 input receipt query")
            };
            if receipt.state == session_core::input::InputState::PipelineQueued {
                assert_eq!(receipt.pipeline_bytes, Some(bytes.len()));
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    timeout(Duration::from_secs(6), async {
        let marker = b"\r\nP13_IPC_DATA_OK\r\n";
        loop {
            let Reply::Output(output) = ok(client
                .request(Request::Read {
                    connection,
                    cursor: 1,
                    max_bytes: 8192,
                })
                .await
                .unwrap())
            else {
                panic!("SSH1 buffered output")
            };
            let captured: Vec<_> = output
                .events
                .into_iter()
                .flat_map(|event| event.bytes)
                .collect();
            if captured
                .windows(marker.len())
                .any(|candidate| candidate == marker)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let Reply::Logging(logging::Reply::Info(_)) = ok(client
        .request(Request::Logging {
            request: logging::Request::Stop {
                connection,
                log_id: recording.log_id,
            },
        })
        .await
        .unwrap())
    else {
        panic!("SSH1 recording stop")
    };
    let stopped = timeout(Duration::from_secs(4), async {
        loop {
            let Reply::Logging(logging::Reply::Info(info)) = ok(client
                .request(Request::Logging {
                    request: logging::Request::Status {
                        connection,
                        log_id: recording.log_id,
                    },
                })
                .await
                .unwrap())
            else {
                panic!("SSH1 recording status")
            };
            if info.worker_finished {
                break info;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(stopped.protocol, Protocol::Ssh1);
    assert!(stopped.written_raw_bytes > 0 && stopped.durable);
    stop_numbered(client, connection).await;
}

#[tokio::test]
#[ignore = "requires the staged pinned service and a private SSH1 WSL fixture"]
async fn p13_ssh1_saved_desktop_ipc() {
    let binary = PathBuf::from(std::env::var_os("P13_SERVICE_EXE").unwrap());
    let root = std::env::var("P13_WSL_ROOT").unwrap();
    assert!(root.strip_prefix("/tmp/P04-ssh1.").is_some_and(
        |suffix| suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    ));
    let source = PathBuf::from(std::env::var_os("P13_UPPITY_SOURCE").unwrap());
    let data = ConfigTemp::new();
    let mut service = Fixture::launch(
        &binary,
        Uuid::new_v4().to_string(),
        false,
        Some(&data.0),
        &[],
    )
    .await;
    let _desktop_job = ssh1_fixture::job(&service.child).unwrap();
    let mut desktop = service.connect().await;
    for login in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (id, revision) = save(&mut desktop, listener.local_addr().unwrap().port()).await;
        denied(
            &mut desktop,
            Request::Ssh {
                request: fixed(id, Uuid::new_v4(), Uuid::new_v4()),
            },
            ErrorCode::PermissionDenied,
        )
        .await;
        denied(
            &mut desktop,
            Request::Ssh {
                request: ssh::Request::Start {
                    profile_id: id,
                    request_id: Uuid::new_v4(),
                    cols: 80,
                    rows: 24,
                },
            },
            ErrorCode::Unsupported,
        )
        .await;
        denied(
            &mut desktop,
            Request::Agent {
                request: agent::Request::Grant {
                    request_id: Uuid::new_v4(),
                    lifetime_ms: 5000,
                    scopes: vec![Scope {
                        target: Target::ProfileRevision {
                            profile_id: id,
                            revision,
                        },
                        action: Action::Connect,
                    }],
                },
            },
            ErrorCode::Unsupported,
        )
        .await;
        let connection = start(&mut desktop, id, revision).await;
        let remote = ssh1_fixture::bridge(listener, &root);
        let checks = async {
            if login {
                positive(&mut desktop, connection, &source).await;
            } else {
                let id = host(&mut desktop, connection).await;
                ssh_call(
                    &mut desktop,
                    ssh::Request::AnswerHost {
                        connection,
                        challenge_id: id,
                        approve: false,
                    },
                )
                .await;
                let status = ssh_status(&mut desktop, connection, |value| {
                    value.connection.state == State::Failed
                })
                .await;
                assert_eq!(status.failure, Some(ssh::Failure::HostKeyRejected));
                assert!(status.challenge.is_none());
                stop_numbered(&mut desktop, connection).await;
            }
        };
        let (result, ()) = tokio::join!(remote, checks);
        println!("fixture exit {} for login={login}", result.unwrap());
    }
    service.stop(&mut desktop).await;
}

#[tokio::test]
#[ignore = "requires the staged pinned service; creates its own corrupt sibling"]
async fn p13_ssh1_refuses_mismatched_helper_before_network() {
    let binary = PathBuf::from(std::env::var_os("P13_SERVICE_EXE").unwrap());
    let staging = ConfigTemp::new();
    let staged = staging.0.join("session-service.exe");
    std::fs::copy(binary, &staged).unwrap();
    std::fs::write(
        staging.0.join("ssh1-helper.exe"),
        b"synthetic mismatched image",
    )
    .unwrap();
    let data = ConfigTemp::new();
    let mut service = Fixture::launch(
        &staged,
        Uuid::new_v4().to_string(),
        false,
        Some(&data.0),
        &[],
    )
    .await;
    let mut desktop = service.connect().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (id, revision) = save(&mut desktop, listener.local_addr().unwrap().port()).await;
    let connection = start(&mut desktop, id, revision).await;
    let status = ssh_status(&mut desktop, connection, |value| {
        value.connection.state == State::Failed
    })
    .await;
    assert_eq!(status.failure, Some(ssh::Failure::Configuration));
    assert!(status.challenge.is_none());
    assert!(
        timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
    service.stop(&mut desktop).await;
}

#[cfg(not(feature = "ssh1-with-helper"))]
#[tokio::test]
async fn p13_ssh1_default_service_has_no_pin() {
    let data = ConfigTemp::new();
    let mut service =
        Fixture::on_instance_with_data(Uuid::new_v4().to_string(), false, Some(&data.0)).await;
    let mut desktop = service.connect().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (id, revision) = save(&mut desktop, listener.local_addr().unwrap().port()).await;
    denied(
        &mut desktop,
        Request::Ssh {
            request: fixed(id, revision, Uuid::new_v4()),
        },
        ErrorCode::Unsupported,
    )
    .await;
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()), Reply::Sessions(s) if s.is_empty())
    );
    assert!(
        timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
    service.stop(&mut desktop).await;
}
