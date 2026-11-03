//! P03 isolated SSH2 backend experiment; not yet connected to the UI or service.
use anyhow::{Result, bail, ensure};
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(5);

pub struct HostKeyPin {
    fingerprint: String,
    negotiated: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyPin {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates need a separate CA policy. Do not silently trust one.
        Ok(key.certificate().is_none()
            && key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.fingerprint)
    }

    async fn kex_done(
        &mut self,
        _: Option<&[u8]>,
        names: &russh::Names,
        _: &mut client::Session,
    ) -> Result<(), Self::Error> {
        *self.negotiated.lock().unwrap() = Some(format!(
            "kex={:?}, key={}, cipher={:?}, client_mac={:?}, server_mac={:?}, strict_kex={}",
            names.kex,
            names.key,
            names.cipher,
            names.client_mac,
            names.server_mac,
            names.strict_kex()
        ));
        Ok(())
    }
}

pub struct Ssh2Probe {
    session: client::Handle<HostKeyPin>,
    negotiated: Arc<Mutex<Option<String>>>,
}

impl Ssh2Probe {
    /// Pin must come from explicit user approval/protected host store, never remote text.
    pub async fn connect(address: SocketAddr, fingerprint: String) -> Result<Self> {
        ensure!(
            fingerprint.starts_with("SHA256:") && fingerprint.len() <= 100,
            "host key approval required"
        );
        let config = client::Config {
            keepalive_interval: Some(Duration::from_secs(1)),
            keepalive_max: 3,
            window_size: 256 * 1024,
            maximum_packet_size: 32 * 1024,
            channel_buffer_size: 32,
            ..Default::default()
        };
        let negotiated = Arc::new(Mutex::new(None));
        let session = timeout(
            DEADLINE,
            client::connect(
                Arc::new(config),
                address,
                HostKeyPin {
                    fingerprint,
                    negotiated: negotiated.clone(),
                },
            ),
        )
        .await??;
        Ok(Self {
            session,
            negotiated,
        })
    }

    pub fn negotiated(&self) -> Option<String> {
        self.negotiated.lock().unwrap().clone()
    }

    pub async fn password(&mut self, user: &str, password: &str) -> Result<bool> {
        Ok(
            timeout(DEADLINE, self.session.authenticate_password(user, password))
                .await??
                .success(),
        )
    }

    pub async fn public_key(&mut self, user: &str, key: PrivateKey) -> Result<bool> {
        let hash = timeout(DEADLINE, self.session.best_supported_rsa_hash())
            .await??
            .flatten();
        Ok(timeout(
            DEADLINE,
            self.session
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
        )
        .await??
        .success())
    }

    pub async fn keyboard_interactive<F>(&mut self, user: &str, mut respond: F) -> Result<bool>
    where
        F: FnMut(&str, &str, &[client::Prompt]) -> Result<Vec<String>>,
    {
        let mut response = timeout(
            DEADLINE,
            self.session
                .authenticate_keyboard_interactive_start(user, None),
        )
        .await??;
        for _ in 0..8 {
            match response {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
                KeyboardInteractiveAuthResponse::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => {
                    ensure!(
                        prompts.len() <= 16
                            && name.len()
                                + instructions.len()
                                + prompts.iter().map(|p| p.prompt.len()).sum::<usize>()
                                <= 8192,
                        "authentication challenge exceeds limits"
                    );
                    let answers = respond(&name, &instructions, &prompts)?;
                    ensure!(
                        answers.len() == prompts.len()
                            && answers.iter().map(String::len).sum::<usize>() <= 8192,
                        "invalid authentication response"
                    );
                    response = timeout(
                        DEADLINE,
                        self.session
                            .authenticate_keyboard_interactive_respond(answers),
                    )
                    .await??;
                }
            }
        }
        bail!("authentication round limit reached")
    }

    pub async fn shell(&self, cols: u32, rows: u32) -> Result<Channel<client::Msg>> {
        ensure!(
            (2..=500).contains(&cols) && (1..=200).contains(&rows),
            "invalid terminal size"
        );
        let mut channel = timeout(DEADLINE, self.session.channel_open_session()).await??;
        let result = timeout(DEADLINE, async {
            channel
                .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
                .await?;
            expect_success(&mut channel).await?;
            channel.request_shell(true).await?;
            expect_success(&mut channel).await?;
            Ok(())
        })
        .await;
        match result {
            Ok(Ok(())) => Ok(channel),
            error => {
                let _ = timeout(DEADLINE, channel.close()).await;
                match error {
                    Ok(Err(error)) => Err(error),
                    Err(error) => Err(error.into()),
                    _ => unreachable!(),
                }
            }
        }
    }

    /// Separate SSH exec channel: never inherits interactive shell cwd/environment.
    pub async fn exec(&self, command: &str) -> Result<ExecResult> {
        ensure!(command.len() <= 64 * 1024, "command exceeds limit");
        let mut channel = timeout(DEADLINE, self.session.channel_open_session()).await??;
        let result = timeout(DEADLINE, async {
            channel.exec(true, command).await?;
            expect_success(&mut channel).await?;
            let mut result = ExecResult {
                stdout: vec![],
                stderr: vec![],
                exit_status: None,
            };
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        ensure!(
                            result.stdout.len() + result.stderr.len() + data.len() <= 1024 * 1024,
                            "exec output limit exceeded"
                        );
                        result.stdout.extend_from_slice(&data);
                    }
                    ChannelMsg::ExtendedData { data, ext: 1 } => {
                        ensure!(
                            result.stdout.len() + result.stderr.len() + data.len() <= 1024 * 1024,
                            "exec output limit exceeded"
                        );
                        result.stderr.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        result.exit_status = Some(exit_status)
                    }
                    ChannelMsg::ExtendedData { .. } => bail!("unsupported extended stream"),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok(result)
        })
        .await;
        // Closing does not revoke a command already executed by the remote host.
        let _ = timeout(DEADLINE, channel.close()).await;
        result?
    }

    pub async fn disconnect(&self) -> Result<()> {
        timeout(
            DEADLINE,
            self.session
                .disconnect(russh::Disconnect::ByApplication, "", ""),
        )
        .await??;
        Ok(())
    }
}

async fn expect_success(channel: &mut Channel<client::Msg>) -> Result<()> {
    match channel.wait().await {
        Some(ChannelMsg::Success) => Ok(()),
        _ => bail!("SSH channel request rejected or closed"),
    }
}

#[derive(Debug)]
pub struct ExecResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
}
