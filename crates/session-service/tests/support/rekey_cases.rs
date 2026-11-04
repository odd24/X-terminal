use super::*;

// Trust is removed through the same desktop service API while a live transport remains open.
// The next byte-triggered rekey must pause for a fresh scoped decision, not silently reuse trust.
#[tokio::test]
async fn rekey_reloads_trust_and_pauses_new_input_until_the_desktop_decides() {
    use ssh::{Challenge as H, Request as S};
    for (approve, changed) in [(true, false), (false, false), (true, true), (false, true)] {
        let remote = ssh_fixture::Fixture::with_rekey(false, true).await;
        let temp = ConfigTemp::new();
        let service = temp.start().await;
        let mut client = service.connect().await;
        let connection = ssh_connected_fixture(&mut client, &remote).await;
        if changed {
            // A concurrent trust-store change must be observed on the next rekey.
            // This changes stored public trust, not the server's actual host key.
            let database = rusqlite::Connection::open(temp.0.join("config.sqlite")).unwrap();
            database
                .execute(
                    "UPDATE host_keys SET key=?1",
                    [remote.client_key.public_key().to_bytes().unwrap()],
                )
                .unwrap();
        } else {
            config_call(
                &mut client,
                config::ConfigRequest::ForgetHostKey {
                    endpoint: config_store::HostEndpoint {
                        protocol: config_store::HostProtocol::Ssh2,
                        host: "127.0.0.1".into(),
                        port: remote.port,
                    },
                    algorithm: "ssh-ed25519".into(),
                    expected_fingerprint: remote.pin.clone(),
                },
            )
            .await;
        }
        let first = Uuid::new_v4();
        ssh_call(
            &mut client,
            input_write(connection, first, &vec![b'r'; 32768]),
        )
        .await;
        let pending = ssh_status(&mut client, connection, |status| {
            matches!(status.challenge, Some(H::HostKey { .. }))
        })
        .await;
        let Some(H::HostKey { id, review }) = pending.challenge else {
            panic!()
        };
        assert_eq!(
            review.status,
            if changed {
                config_store::HostKeyStatus::Changed
            } else {
                config_store::HostKeyStatus::Unknown
            }
        );
        assert_eq!(review.candidate.fingerprint, remote.pin);
        let blocked = Uuid::new_v4();
        assert!(matches!(
            client
                .request(Request::Ssh {
                    request: input_write(connection, blocked, b"must-not-send")
                })
                .await
                .unwrap(),
            Response::Error {
                code: ErrorCode::InvalidState,
                ..
            }
        ));
        assert!(matches!(
            ok(client.request(Request::Ping {}).await.unwrap()),
            Reply::Pong { .. }
        ));
        ssh_call(
            &mut client,
            S::AnswerHost {
                connection,
                challenge_id: id,
                approve,
            },
        )
        .await;
        if approve {
            ssh_status(&mut client, connection, |status| {
                status.challenge.is_none() && status.connection.state == State::Connected
            })
            .await;
            let next = Uuid::new_v4();
            ssh_call(&mut client, input_write(connection, next, b"after-rekey")).await;
            input_status(&mut client, connection, next, |receipt| {
                receipt.state == session_core::input::InputState::PipelineQueued
            })
            .await;
            timeout(Duration::from_secs(4), async {
                loop {
                    let actual = remote.received.lock().unwrap().concat();
                    if actual.len() >= 32768 + 11 {
                        assert_eq!(
                            actual,
                            [vec![b'r'; 32768], b"after-rekey".to_vec()].concat()
                        );
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            ssh_call(&mut client, S::Close { connection }).await;
        } else {
            let failed = ssh_status(&mut client, connection, |status| {
                status.connection.state == State::Failed
            })
            .await;
            assert_eq!(failed.failure, Some(ssh::Failure::HostKeyRejected));
            assert_eq!(failed.shell_exit_status, None);
            assert_eq!(failed.shell_exit_signal, None);
        }
        assert_eq!(remote.attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(
            !remote
                .received
                .lock()
                .unwrap()
                .concat()
                .windows(13)
                .any(|bytes| bytes == b"must-not-send")
        );
    }
}
