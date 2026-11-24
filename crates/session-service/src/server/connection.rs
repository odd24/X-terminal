use super::Runtime;
use session_core::{PROTOCOL_VERSION, pairing::SecretToken, session::ErrorCode};
#[cfg(feature = "audit-diagnostics-fixture")]
use session_protocol::Request;
use session_protocol::{ClientKind, Hello, Reply, RequestEnvelope, Response, Welcome, read_frame};
use std::{io, sync::Arc, time::Duration};
use tokio::{net::windows::named_pipe::NamedPipeServer, time::timeout};
use uuid::Uuid;

pub(super) async fn serve(mut pipe: NamedPipeServer, runtime: Arc<Runtime>) -> io::Result<()> {
    use crate::request_audit::{io_reason, origin_kind, write_response};
    use session_core::rpc_audit::{
        Area, Descriptor, IoReason, IoStage, Origin, OriginKind, Phase, Verb,
    };
    let unverified = Origin {
        pipe_id: Uuid::new_v4(),
        client_id: None,
        kind: OriginKind::Unauthenticated,
        peer_pid: crate::request_audit::peer_pid(&pipe),
    };
    let hello_guard = runtime.request_audit.begin(
        unverified,
        Descriptor {
            area: Area::Transport,
            verb: Verb::Hello,
            wire_id: None,
            request_id: None,
            requested_scope: None,
            resource: None,
        },
    )?;
    let hello: Hello = match timeout(Duration::from_secs(5), read_frame(&mut pipe)).await {
        Ok(Ok(Some(hello))) => hello,
        Ok(Ok(None)) => {
            hello_guard.end(Phase::IoFailure {
                stage: IoStage::HelloRead,
                reason: IoReason::Closed,
            })?;
            return Ok(());
        }
        Ok(Err(error)) => {
            hello_guard.end(Phase::IoFailure {
                stage: IoStage::HelloRead,
                reason: io_reason(&error),
            })?;
            return Err(error);
        }
        Err(_) => {
            hello_guard.end(Phase::IoFailure {
                stage: IoStage::HelloRead,
                reason: IoReason::Timeout,
            })?;
            return Err(io::Error::new(io::ErrorKind::TimedOut, "hello timeout"));
        }
    };
    let result = (|| {
        hello.validate()?;
        let token = SecretToken::parse(hello.token.expose().to_string())?;
        let store = runtime.store.lock().map_err(|_| ErrorCode::InvalidState)?;
        let identity = store.pairing.authenticate(&token, runtime.now())?;
        let kind = if store
            .pairing
            .require_desktop(&identity, runtime.now())
            .is_ok()
        {
            ClientKind::Desktop
        } else {
            if store.pairing.is_agent(&identity, runtime.now())? {
                ClientKind::Agent
            } else {
                ClientKind::Observer
            }
        };
        Ok::<_, ErrorCode>((identity, kind))
    })();
    let (identity, kind) = match result {
        Ok(value) => value,
        Err(code) => {
            hello_guard.returned(Err(code))?;
            write_response(&mut pipe, hello_guard, &Response::Error { id: 0, code }).await?;
            return Ok(());
        }
    };
    hello_guard.authenticated(identity.ticket_id(), origin_kind(kind))?;
    hello_guard.returned(Ok(()))?;
    write_response(
        &mut pipe,
        hello_guard,
        &Response::Ok {
            id: 0,
            reply: Reply::Welcome(Welcome {
                protocol_version: PROTOCOL_VERSION,
                service_id: runtime.service_id,
                client_id: if matches!(kind, ClientKind::Agent) {
                    identity.ticket_id()
                } else {
                    unverified.pipe_id
                },
                kind,
            }),
        },
    )
    .await?;
    let origin = Origin {
        client_id: Some(identity.ticket_id()),
        kind: origin_kind(kind),
        ..unverified
    };
    let mut shutdown = runtime.shutdown.subscribe();
    loop {
        let request: RequestEnvelope = tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            frame = timeout(Duration::from_secs(30), read_frame(&mut pipe)) => match frame {
                Ok(Ok(Some(value)))=>value,
                Ok(Ok(None))=>{runtime.request_audit.read_failure(origin,IoStage::RequestRead,IoReason::Closed)?;return Ok(());},
                Ok(Err(error))=>{runtime.request_audit.read_failure(origin,IoStage::RequestRead,io_reason(&error))?;return Err(error);},
                Err(_)=>{runtime.request_audit.read_failure(origin,IoStage::RequestRead,IoReason::Timeout)?;return Err(io::Error::new(io::ErrorKind::TimedOut,"idle client timeout"));},
            }
        };
        let guard = runtime
            .request_audit
            .begin(origin, request.request.audit_descriptor(request.id))?;
        #[cfg(feature = "audit-diagnostics-fixture")]
        let drop_shutdown = matches!(request.request, Request::Shutdown {})
            && matches!(kind, ClientKind::Desktop)
            && terminal_log::audit::diagnostic_drop_shutdown_reply();
        let result = runtime.dispatch(&identity, request.request).await;
        guard.returned(result.as_ref().map(|_| ()).map_err(|code| *code))?;
        #[cfg(feature = "audit-diagnostics-fixture")]
        if drop_shutdown && matches!(result, Ok(Reply::Ok)) {
            // The real dispatch already happened; deliberately close only its reply pipe.
            return Ok(());
        }
        let response = match result {
            Ok(reply) => Response::Ok {
                id: request.id,
                reply,
            },
            Err(code) => Response::Error {
                id: request.id,
                code,
            },
        };
        write_response(&mut pipe, guard, &response).await?;
    }
}
