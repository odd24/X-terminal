#[cfg(windows)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let directory = if args.len() >= 2 && args[args.len() - 2] == "--data-dir" {
        let path = std::path::PathBuf::from(args.pop().unwrap());
        args.pop();
        if !path.is_absolute() {
            return Err("data directory must be absolute".into());
        }
        Some(path)
    } else {
        None
    };
    let serial_mcp_fixture =
        if let Some(index) = args.iter().position(|s| s == "--serial-mcp-fixture") {
            if !cfg!(feature = "serial-mcp-fixture") {
                return Err("SERIAL_MCP_FIXTURE_DISABLED".into());
            }
            args.remove(index);
            true
        } else {
            false
        };
    let diagnostic_mode =
        if let Some(index) = args.iter().position(|s| s == "--audit-diagnostic-fixture") {
            if !cfg!(feature = "audit-diagnostics-fixture") {
                return Err("AUDIT_DIAGNOSTIC_FIXTURE_DISABLED".into());
            }
            if index + 1 >= args.len() {
                return Err("AUDIT_TEST_MODE_REJECTED".into());
            }
            let mode = args.remove(index + 1);
            args.remove(index);
            Some(mode)
        } else {
            None
        };
    if let Some(index) = args.iter().position(|arg| arg == "--log-disk-full-fixture") {
        if !cfg!(feature = "log-disk-full-fixture") {
            return Err("LOG_DISK_FULL_FIXTURE_DISABLED".into());
        }
        args.remove(index);
        #[cfg(feature = "log-disk-full-fixture")]
        terminal_log::disk_full_fixture::configure(
            directory
                .as_deref()
                .ok_or("LOG_DISK_FULL_TEST_ROOT_REQUIRED")?,
        )
        .map_err(|_| "LOG_DISK_FULL_TEST_ROOT_REJECTED")?;
    }
    let (instance, fixture) = match args.as_slice() {
        [] => ("main", false),
        [flag, instance] if flag == "--instance" => (instance.as_str(), false),
        [flag, instance, fixture] if flag == "--instance" && fixture == "--test-fixture" => {
            (instance.as_str(), true)
        }
        _ => return Err("invalid session-service arguments".into()),
    };
    if let Some(mode) = diagnostic_mode {
        if !fixture {
            return Err("AUDIT_TEST_REQUIRES_FIXTURE".into());
        }
        #[cfg(feature = "audit-diagnostics-fixture")]
        terminal_log::audit::configure_diagnostic_fixture(
            directory.as_deref().ok_or("AUDIT_TEST_ROOT_REQUIRED")?,
            &mode,
        )
        .map_err(|_| "AUDIT_TEST_CONFIGURATION_REJECTED")?;
        #[cfg(not(feature = "audit-diagnostics-fixture"))]
        let _ = mode;
    }
    if serial_mcp_fixture {
        if !fixture {
            return Err("SERIAL_MCP_REQUIRES_FIXTURE".into());
        }
        #[cfg(feature = "serial-mcp-fixture")]
        session_service::serial_mcp_fixture::configure(
            directory.as_deref().ok_or("SERIAL_MCP_ROOT_REQUIRED")?,
        )
        .map_err(|_| "SERIAL_MCP_ROOT_REJECTED")?;
    }
    // Private parent-to-child channel; do not expose the bootstrap in argv/env/files.
    let hello: session_protocol::Hello = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        session_protocol::read_frame(&mut tokio::io::stdin()),
    )
    .await??
    .ok_or("missing private bootstrap")?;
    hello.validate()?;
    let token = session_core::pairing::SecretToken::parse(hello.token.expose().to_string())?;
    session_service::serve_with_config(instance, token, fixture, directory).await?;
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("session-service currently requires Windows");
    std::process::exit(1);
}
