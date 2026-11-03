#[cfg(windows)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (instance, fixture) = match args.as_slice() {
        [] => ("main", false),
        [flag, instance] if flag == "--instance" => (instance.as_str(), false),
        [flag, instance, fixture] if flag == "--instance" && fixture == "--test-fixture" => {
            (instance.as_str(), true)
        }
        _ => return Err("invalid session-service arguments".into()),
    };
    // Private parent-to-child channel; do not expose the bootstrap in argv/env/files.
    let hello: session_protocol::Hello = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        session_protocol::read_frame(&mut tokio::io::stdin()),
    )
    .await??
    .ok_or("missing private bootstrap")?;
    hello.validate()?;
    let token = session_core::pairing::SecretToken::parse(hello.token.expose().to_string())?;
    session_service::serve(instance, token, fixture).await?;
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("session-service currently requires Windows");
    std::process::exit(1);
}
