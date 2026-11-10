//! Synthetic loopback server owned by the native WebView integration harness.
//! The anonymous stdout pipe contains fixture-only credentials, never real device data.
#[allow(dead_code)]
#[path = "../tests/support/ssh_fixture.rs"]
mod fixture;
use std::{io::Write, sync::atomic::Ordering};
use tokio::io::{AsyncBufReadExt, BufReader};
#[tokio::main]
async fn main() {
    let directory =
        std::path::PathBuf::from(std::env::args_os().nth(1).expect("fixture directory"));
    assert!(directory.is_absolute() && directory.is_dir());
    let port = std::env::args()
        .nth(2)
        .map(|s| s.parse::<u16>().expect("synthetic loopback port"))
        .unwrap_or(0);
    let fixture = fixture::Fixture::start_on(port).await;
    let key_path = directory.join("synthetic-client-key");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&key_path)
        .unwrap();
    let key = fixture
        .client_key
        .encrypt(&mut rand::rng(), fixture.password.as_bytes())
        .unwrap()
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    file.write_all(key.as_bytes()).unwrap();
    drop(file);
    println!(
        "{}",
        serde_json::json!({"port":fixture.port,"password":*fixture.password,"pin":fixture.pin,"key_path":key_path})
    );
    std::io::stdout().flush().unwrap();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await.unwrap() {
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        match value["op"].as_str().unwrap() {
            "metrics" => {}
            "stall_next_data" => fixture.stall_next_data(),
            "unblock_data" => fixture.unblock.notify_one(),
            "keyboard_echo" => fixture.keyboard_echo.store(true, Ordering::SeqCst),
            "disconnect" => fixture.disconnect().await,
            "wait_disconnected" => fixture.wait_disconnected().await,
            "end" => fixture.end(7).await,
            "push" => {
                fixture
                    .push(value["text"].as_str().unwrap().as_bytes())
                    .await
            }
            "push_bytes" => {
                let bytes: Vec<u8> = serde_json::from_value(value["bytes"].clone()).unwrap();
                fixture.push(&bytes).await;
            }
            "stop" => break,
            _ => panic!("unknown fixture command"),
        }
        println!(
            "{}",
            serde_json::json!({
                "attempts":fixture.attempts.load(Ordering::SeqCst),
                "accepted_connections":fixture.accepted_connections(),
                "received":*fixture.received.lock().unwrap(),
                "received_at_us":*fixture.received_at.lock().unwrap(),
                "sizes":*fixture.sizes.lock().unwrap(),
                "exec_calls":*fixture.exec_calls.lock().unwrap()
            })
        );
        std::io::stdout().flush().unwrap();
    }
}
