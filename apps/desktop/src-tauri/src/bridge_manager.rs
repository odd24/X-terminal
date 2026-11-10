//! Native-only Agent client custody. stdio peers never receive a bearer.
use serde::{Deserialize, Serialize};
use session_core::{pairing::grants::View, session::ErrorCode};
use session_protocol::{
    Reply, Request as ServiceRequest, Response, agent, bridge as wire, read_frame, write_frame,
};
use session_service::{
    client::Client,
    security::{PipeSecurity, pipe_name},
};
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::windows::named_pipe::NamedPipeServer,
    sync::{oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;
use windows_sys::Win32::System::{
    Pipes::GetNamedPipeClientProcessId,
    Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
};

#[derive(Clone, Serialize)]
pub struct Peer {
    pub pending_id: Uuid,
    pub pid: u32,
    pub ticket_id: Option<Uuid>,
}
#[derive(Serialize)]
pub struct Info {
    pub executable: String,
    pub broker_id: Uuid,
    pub instance: String,
    pub desktop_pid: u32,
    pub service_id: Uuid,
    pub peer: Option<Peer>,
}
#[derive(Clone, Serialize)]
pub struct Preview {
    pub preview_id: Uuid,
    pub peer: Peer,
    pub service_id: Uuid,
    #[serde(skip_serializing)]
    pub grant: View,
    pub grant_request_id: Uuid,
    pub grant_metadata: String,
}
struct Frozen {
    preview: Preview,
    until: Instant,
}
struct Entry {
    peer: Peer,
    sender: Option<oneshot::Sender<Bound>>,
}
#[derive(Default)]
struct Inner {
    entry: Option<Entry>,
    preview: Option<Frozen>,
}
struct Shared {
    inner: Mutex<Inner>,
    id: Uuid,
    service_id: Uuid,
    instance: String,
    expected: PathBuf,
}
struct Bound {
    client: Client,
    view: View,
}
pub struct Manager {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
fn failure() -> String {
    "BRIDGE_UNAVAILABLE".into()
}
fn open(instance: &str, first: bool) -> io::Result<NamedPipeServer> {
    PipeSecurity::current_user()?.create(&pipe_name(instance)?, first)
}
fn image_is(pipe: &NamedPipeServer, expected: &Path) -> io::Result<u32> {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 || pid == 0 {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let mut buffer = vec![0u16; 32768];
    let mut count = buffer.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut count)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let actual = PathBuf::from(
        String::from_utf16(&buffer[..count as usize])
            .map_err(|_| io::Error::other("invalid process image"))?,
    );
    let actual = std::fs::canonicalize(actual)?;
    let expected = std::fs::canonicalize(expected)?;
    if !actual
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unrecognized bridge process",
        ));
    }
    Ok(pid)
}
impl Manager {
    pub fn start(service_id: Uuid) -> io::Result<Self> {
        let instance = format!("bridge-{}", Uuid::new_v4().simple());
        let listener = open(&instance, true)?;
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner::default()),
            id: Uuid::new_v4(),
            service_id,
            instance,
            expected: std::env::current_exe()?.with_file_name("terminal-mcp.exe"),
        });
        let (stop, stopping) = watch::channel(false);
        let copy = shared.clone();
        let task = tauri::async_runtime::spawn(async move {
            listen(listener, copy, stopping).await;
        });
        Ok(Self {
            shared,
            stop,
            task: Mutex::new(Some(task)),
        })
    }
    pub fn info(&self) -> Result<Info, String> {
        let inner = self.shared.inner.lock().map_err(|_| failure())?;
        Ok(Info {
            executable: self.shared.expected.to_string_lossy().into_owned(),
            broker_id: self.shared.id,
            instance: self.shared.instance.clone(),
            desktop_pid: std::process::id(),
            service_id: self.shared.service_id,
            peer: inner.entry.as_ref().map(|e| e.peer.clone()),
        })
    }
    pub async fn prepare(
        &self,
        channel: &tokio::sync::Mutex<Option<Client>>,
        pending_id: Uuid,
        grant_id: Uuid,
    ) -> Result<Preview, String> {
        let peer = self
            .info()?
            .peer
            .filter(|p| p.pending_id == pending_id && p.ticket_id.is_none())
            .ok_or_else(failure)?;
        let (grant, _) = grant(channel, grant_id).await?;
        let preview = Preview {
            preview_id: Uuid::new_v4(),
            peer,
            service_id: self.shared.service_id,
            grant_request_id: grant.summary.request_id,
            grant_metadata: serde_json::to_string_pretty(&grant).map_err(|_| failure())?,
            grant,
        };
        let mut inner = self.shared.inner.lock().map_err(|_| failure())?;
        if !inner
            .entry
            .as_ref()
            .is_some_and(|e| e.peer.pending_id == pending_id && e.sender.is_some())
        {
            return Err(failure());
        }
        inner.preview = Some(Frozen {
            preview: preview.clone(),
            until: Instant::now() + Duration::from_secs(30),
        });
        Ok(preview)
    }
    pub async fn approve(
        &self,
        channel: &tokio::sync::Mutex<Option<Client>>,
        endpoint: (String, u32, Uuid),
        id: Uuid,
    ) -> Result<Peer, String> {
        // Consume before awaits: a lost approval reply cannot deliver twice.
        let frozen = {
            let mut inner = self.shared.inner.lock().map_err(|_| failure())?;
            let frozen = inner.preview.take().ok_or_else(failure)?;
            if frozen.preview.preview_id != id || Instant::now() >= frozen.until {
                return Err(failure());
            }
            frozen
        };
        let preview = frozen.preview;
        if endpoint.2 != preview.service_id {
            return Err(failure());
        }
        let (view, token) = grant(channel, preview.grant.summary.request_id).await?;
        if serde_json::to_vec(&view).map_err(|_| failure())?
            != serde_json::to_vec(&preview.grant).map_err(|_| failure())?
        {
            return Err("BRIDGE_GRANT_CHANGED".into());
        }
        let (client, response) = Client::connect(&endpoint.0, token.expose(), endpoint.1)
            .await
            .map_err(|_| failure())?;
        if !matches!(response,Response::Ok {reply:Reply::Welcome(w),..} if w.service_id==preview.service_id && matches!(w.kind,session_protocol::ClientKind::Agent) && w.client_id==view.summary.ticket_id)
        {
            return Err(failure());
        }
        let mut inner = self.shared.inner.lock().map_err(|_| failure())?;
        let entry = inner
            .entry
            .as_mut()
            .filter(|e| {
                e.peer.pending_id == preview.peer.pending_id && e.peer.pid == preview.peer.pid
            })
            .ok_or_else(failure)?;
        let sender = entry.sender.take().ok_or_else(failure)?;
        sender.send(Bound { client, view }).map_err(|_| failure())?;
        entry.peer.ticket_id = Some(preview.grant.summary.ticket_id);
        Ok(entry.peer.clone())
    }
    pub async fn close(&self) {
        let _ = self.stop.send(true);
        let task = self.task.lock().ok().and_then(|mut v| v.take());
        if let Some(mut task) = task
            && timeout(Duration::from_secs(2), &mut task).await.is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
async fn grant(
    channel: &tokio::sync::Mutex<Option<Client>>,
    id: Uuid,
) -> Result<(View, session_protocol::Sensitive), String> {
    let mut channel = channel.lock().await;
    let client = channel.as_mut().ok_or_else(failure)?;
    match client
        .request(ServiceRequest::Agent {
            request: agent::Request::GrantStatus { request_id: id },
        })
        .await
    {
        Ok(Response::Ok {
            reply:
                Reply::Agent(agent::Reply::Grant {
                    receipt,
                    token: Some(token),
                }),
            ..
        }) if receipt.summary.state == session_core::pairing::grants::State::Active => {
            Ok((receipt, token))
        }
        _ => Err("BRIDGE_GRANT_UNAVAILABLE".into()),
    }
}
struct Cleanup {
    shared: Arc<Shared>,
    id: Uuid,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.shared.inner.lock()
            && inner
                .entry
                .as_ref()
                .is_some_and(|e| e.peer.pending_id == self.id)
        {
            inner.entry = None;
            inner.preview = None;
        }
    }
}
async fn listen(
    mut listener: NamedPipeServer,
    shared: Arc<Shared>,
    mut stopping: watch::Receiver<bool>,
) {
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        while tasks.try_join_next().is_some() {}
        tokio::select! {
            _=stopping.changed()=>break,
            Some(_)=tasks.join_next(),if !tasks.is_empty()=>{},
            result=listener.connect()=>{
                if result.is_err() {break;}
                let Ok(next)=open(&shared.instance,false) else {break;};
                let pipe=std::mem::replace(&mut listener,next);
                while tasks.try_join_next().is_some() {}
                if tasks.is_empty() {let copy=shared.clone();tasks.spawn(async move {let _=peer(pipe,copy).await;});}
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}
async fn peer(pipe: NamedPipeServer, shared: Arc<Shared>) -> io::Result<()> {
    let pid = image_is(&pipe, &shared.expected)?;
    let id = Uuid::new_v4();
    let (sender, mut authorized) = oneshot::channel();
    {
        let mut inner = shared
            .inner
            .lock()
            .map_err(|_| io::Error::other("bridge state"))?;
        inner.entry = Some(Entry {
            peer: Peer {
                pending_id: id,
                pid,
                ticket_id: None,
            },
            sender: Some(sender),
        });
        inner.preview = None;
    }
    let _cleanup = Cleanup {
        shared: shared.clone(),
        id,
    };
    let (mut read, mut write) = tokio::io::split(pipe);
    let (incoming, mut messages) = tokio::sync::mpsc::channel(1);
    let reader = tokio::spawn(async move {
        while let Ok(Some(message)) = read_frame::<_, wire::RequestMessage>(&mut read).await {
            if incoming.send(message).await.is_err() {
                break;
            }
        }
    });
    struct Abort(JoinHandle<()>);
    impl Drop for Abort {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _reader = Abort(reader);
    let mut bound: Option<Bound> = None;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let response = tokio::select! {
            biased;
            delivery=&mut authorized,if bound.is_none()=>{let Ok(delivery)=delivery else {break;};bound=Some(delivery);continue;},
            _=heartbeat.tick()=>{if let Some(pair)=bound.as_mut() {let _=pair.client.request(ServiceRequest::Ping {}).await;}continue;},
            message=messages.recv()=>{
                let Some(message)=message else {break;};
                match message {
                    wire::RequestMessage::Status {}=>wire::ResultMessage::Status(wire::Status {broker_id:shared.id,service_id:shared.service_id,peer_pid:pid,paired_ticket:bound.as_ref().map(|v|v.view.summary.ticket_id),approved_scopes:bound.as_ref().map(|v|v.view.approved_scopes.clone()).unwrap_or_default(),protection:bound.as_ref().and_then(|v|v.view.protection)}),
                    wire::RequestMessage::Call {request}=>{
                        if let Some(pair)=bound.as_mut() {
                            let expected_task=request.task_target();
                            let expected_serial=request.serial_target();
                            let expected_disconnect=request.disconnect_target();
                            let expected_forget=request.forget_target();
                            let expected_reconnect=request.reconnect_target();
                            let expected_connect=request.connect_target();
                            let expected_serial_connect=request.serial_connect_target();
                            let expected_ssh_resize=request.ssh_resize_request_id();
                            let protected=pair.view.protection.is_some();
                            match request.into_service(protected) {
                                Ok(request) => {
                                    let response = pair.client.request(request).await?;
                                    if let Some(id) = expected_ssh_resize {
                                        wire::ResultMessage::from_ssh_resize_service(response, id)?
                                    } else if let Some(target) = expected_serial_connect {
                                        wire::ResultMessage::from_serial_connect_service(response, target)?
                                    } else if let Some((profile_id, revision, id)) = expected_connect {
                                        wire::ResultMessage::from_connect_service(response, profile_id, revision, id)?
                                    } else if let Some((previous, id, query)) = expected_reconnect {
                                        wire::ResultMessage::from_reconnect_service(response, previous, id, query)?
                                    } else if let Some((transport, connection, id)) = expected_forget {
                                        wire::ResultMessage::from_forget_service(response, transport, connection, id)?
                                    } else if let Some((transport, connection, id)) = expected_disconnect {
                                        wire::ResultMessage::from_disconnect_service(response, transport, connection, id)
                                    } else if let Some((connection, id, status_only)) = expected_task {
                                        wire::ResultMessage::from_task_service(response, connection, id, protected, status_only)
                                    } else if let Some((connection, id, envelope)) = expected_serial {
                                        wire::ResultMessage::from_serial_service(response, connection, id, envelope)
                                    } else {
                                        wire::ResultMessage::from_service(response)
                                    }
                                },
                                Err(code)=>wire::ResultMessage::Error(code),
                            }
                        } else {wire::ResultMessage::Error(ErrorCode::PermissionDenied)}
                    },
                }
            },
        };
        timeout(Duration::from_secs(5), write_frame(&mut write, &response))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "bridge reply timeout"))??;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Management {
    Info {},
    Preview {
        pending_id: Uuid,
        grant_request_id: Uuid,
    },
    Approve {
        preview_id: Uuid,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn actual_kernel_peer_image_is_required_and_callers_cannot_assign_their_own_identity() {
        let instance = format!("p15-test-{}", Uuid::new_v4().simple());
        let server = open(&instance, true).unwrap();
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(pipe_name(&instance).unwrap())
            .unwrap();
        server.connect().await.unwrap();
        let actual = std::env::current_exe().unwrap();
        assert_eq!(image_is(&server, &actual).unwrap(), std::process::id());
        let other = actual
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("terminal-mcp.exe");
        assert_eq!(
            image_is(&server, &other).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        drop(client);
        for value in [
            serde_json::json!({"op":"info","token":"secret"}),
            serde_json::json!({"op":"preview","pending_id":Uuid::new_v4(),"grant_request_id":Uuid::new_v4(),"pid":std::process::id()}),
            serde_json::json!({"op":"approve","preview_id":Uuid::new_v4(),"role":"desktop"}),
        ] {
            assert!(serde_json::from_value::<Management>(value).is_err());
        }
    }
}
