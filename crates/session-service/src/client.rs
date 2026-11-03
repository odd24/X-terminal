use crate::security::{pipe_name, verify_server_pid};
use session_core::PROTOCOL_VERSION;
use session_protocol::{
    Hello, Request, RequestEnvelope, Response, Sensitive, read_frame, write_frame,
};
use std::{io, time::Duration};
use tokio::{
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    time::{sleep, timeout},
};

pub struct Client {
    pipe: Option<NamedPipeClient>,
    next_id: u32,
}
impl Client {
    pub async fn connect(
        instance: &str,
        token: &str,
        expected_pid: u32,
    ) -> io::Result<(Self, Response)> {
        let name = pipe_name(instance)?;
        timeout(Duration::from_secs(5), async {
            let mut pipe = loop {
                match ClientOptions::new().open(&name) {
                    Ok(pipe) => break pipe,
                    Err(error) if matches!(error.raw_os_error(), Some(2 | 231)) => {
                        sleep(Duration::from_millis(20)).await
                    }
                    Err(error) => return Err(error),
                }
            };
            verify_server_pid(&pipe, expected_pid)?;
            write_frame(
                &mut pipe,
                &Hello {
                    protocol_version: PROTOCOL_VERSION,
                    client_name: "native-client".into(),
                    token: Sensitive::new(token.to_string()),
                },
            )
            .await?;
            let response: Response = read_frame(&mut pipe)
                .await?
                .ok_or_else(|| io::Error::other("service closed during handshake"))?;
            if !matches!(&response, Response::Ok { id: 0, reply: session_protocol::Reply::Welcome(welcome) } if welcome.protocol_version == PROTOCOL_VERSION) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "service authentication or version rejected"));
            }
            Ok((Self { pipe: Some(pipe), next_id: 1 }, response))
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "service handshake timeout"))?
    }
    pub async fn request(&mut self, request: Request) -> io::Result<Response> {
        request
            .validate()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid service request"))?;
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or_else(|| io::Error::other("request sequence exhausted"))?;
        let mut pipe = self.pipe.take().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotConnected, "IPC client disconnected")
        })?;
        let outcome = timeout(Duration::from_secs(5), async {
            write_frame(&mut pipe, &RequestEnvelope { id, request }).await?;
            let response: Response = read_frame(&mut pipe)
                .await?
                .ok_or_else(|| io::Error::other("session service exited"))?;
            let response_id = match &response {
                Response::Ok { id, .. } | Response::Error { id, .. } => *id,
            };
            if response_id != id {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "mismatched service response",
                ));
            }
            Ok(response)
        })
        .await
        .unwrap_or_else(|_| {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "service request timeout",
            ))
        });
        if outcome.is_ok() {
            self.pipe = Some(pipe);
        }
        outcome
    }
}
