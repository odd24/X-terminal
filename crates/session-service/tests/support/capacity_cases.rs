use super::*;
use ssh::Request as S;

fn ordered(stamp: u64, nonce: u64) -> Uuid {
    Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | nonce as u128)
}
async fn expired(client: &mut Client, request: S) {
    assert!(matches!(
        client.request(Request::Ssh { request }).await.unwrap(),
        Response::Error {
            code: ErrorCode::RequestExpired,
            ..
        }
    ));
}

#[tokio::test]
async fn ordered_input_survives_multiple_retention_windows_without_replaying_expired_ids() {
    let remote = ssh_fixture::Fixture::start().await;
    let temp = ConfigTemp::new();
    let service = temp.start().await;
    let mut client = service.connect().await;
    let connection = ssh_connected_fixture(&mut client, &remote).await;
    let mut expected = Vec::new();
    for stamp in 1..=2200u64 {
        let id = ordered(stamp, 1);
        let bytes = format!("{stamp:04}|").into_bytes();
        expected.extend_from_slice(&bytes);
        ssh_call(&mut client, input_write(connection, id, &bytes)).await;
        input_status(&mut client, connection, id, |receipt| {
            receipt.state == session_core::input::InputState::PipelineQueued
        })
        .await;
        if stamp == 2200 {
            ssh_call(&mut client, input_write(connection, id, &bytes)).await;
        }
    }
    for id in [ordered(1, 1), ordered(1, 2), ordered(1000, 1)] {
        expired(&mut client, input_write(connection, id, b"must-not-replay")).await;
        expired(
            &mut client,
            S::Resize {
                connection,
                request_id: id,
                cols: 90,
                rows: 30,
            },
        )
        .await;
        expired(
            &mut client,
            S::InputStatus {
                connection,
                request_id: id,
            },
        )
        .await;
        expired(
            &mut client,
            S::Exec {
                connection,
                request_id: id,
                command: Sensitive::new("must-not-exec".into()),
                timeout_ms: 1000,
                max_output_bytes: 4096,
            },
        )
        .await;
    }
    // The shared receipt/action boundary must also preserve duplicate exec lookup even after
    // the input watermark advances beyond that still-retained task's timestamp.
    let task_request = ordered(2201, 1);
    let ssh::Reply::Exec(task) = ssh_call(
        &mut client,
        S::Exec {
            connection,
            request_id: task_request,
            command: Sensitive::new("fail".into()),
            timeout_ms: 1000,
            max_output_bytes: 4096,
        },
    )
    .await
    else {
        panic!()
    };
    for stamp in 2202..=3300u64 {
        ssh_call(
            &mut client,
            S::Resize {
                connection,
                request_id: ordered(stamp, 1),
                cols: 90,
                rows: 30,
            },
        )
        .await;
        input_status(&mut client, connection, ordered(stamp, 1), |receipt| {
            receipt.state == session_core::input::InputState::PipelineQueued
        })
        .await;
    }
    let ssh::Reply::Exec(duplicate) = ssh_call(
        &mut client,
        S::Exec {
            connection,
            request_id: task_request,
            command: Sensitive::new("fail".into()),
            timeout_ms: 1000,
            max_output_bytes: 4096,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(duplicate.task_id, task.task_id);
    assert_eq!(*remote.exec_calls.lock().unwrap(), [b"fail".to_vec()]);
    timeout(Duration::from_secs(4), async {
        while remote.received.lock().unwrap().concat().len() < expected.len() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(remote.received.lock().unwrap().concat(), expected);
    ssh_call(&mut client, S::Close { connection }).await;
    ssh_status(&mut client, connection, |status| {
        status.connection.state == State::Disconnected
    })
    .await;
    expired(
        &mut client,
        S::Reconnect {
            connection,
            request_id: ordered(1, 1),
            cols: 80,
            rows: 24,
        },
    )
    .await;
    let current = ssh_status(&mut client, connection, |_| true).await;
    assert_eq!(current.connection.generation, connection.generation);
}
