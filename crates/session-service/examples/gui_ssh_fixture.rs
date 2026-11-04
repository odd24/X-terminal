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
    let fixture = fixture::Fixture::start().await;
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
            "disconnect" => fixture.disconnect().await,
            "end" => fixture.end(7).await,
            "push" => {
                fixture
                    .push(value["text"].as_str().unwrap().as_bytes())
                    .await
            }
            "stop" => break,
            _ => panic!("unknown fixture command"),
        }
        println!(
            "{}",
            serde_json::json!({
                "attempts":fixture.attempts.load(Ordering::SeqCst),
                "received":*fixture.received.lock().unwrap(),
                "sizes":*fixture.sizes.lock().unwrap(),
                "exec_calls":*fixture.exec_calls.lock().unwrap()
            })
        );
        std::io::stdout().flush().unwrap();
    }
}
