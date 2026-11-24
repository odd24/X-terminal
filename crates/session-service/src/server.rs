mod connection;
mod dispatch;

use crate::security::{PipeSecurity, pipe_name, require_standard_user};
use session_core::{
    pairing::{Identity, Pairing, SecretToken},
    session::*,
};
use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Semaphore, watch},
    task::JoinSet,
    time::timeout,
};
use uuid::Uuid;

pub(crate) struct Store {
    pub(crate) sessions: Sessions,
    pub(crate) pairing: Pairing,
    started: Instant,
}
impl Store {
    pub(crate) fn now(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn require_ssh1_desktop(
        &self,
        identity: &Identity,
        connection: ConnectionRef,
    ) -> Result<(), ErrorCode> {
        if self
            .sessions
            .info(connection)
            .is_ok_and(|info| info.protocol == Protocol::Ssh1)
        {
            self.pairing.require_desktop(identity, self.now())?;
        }
        Ok(())
    }
    fn visible_sessions(&self, identity: &Identity, now: u64) -> Vec<ConnectionInfo> {
        self.sessions
            .list()
            .into_iter()
            .filter(|info| {
                self.require_ssh1_desktop(identity, info.reference())
                    .is_ok()
                    && self
                        .pairing
                        .can_observe(identity, info.reference(), now)
                        .is_ok()
            })
            .collect()
    }
}
#[cfg(test)]
impl Store {
    pub(crate) fn test_store() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            sessions: Sessions::default(),
            pairing: Pairing::new(&SecretToken::generate()),
            started: Instant::now(),
        }))
    }
}
struct Runtime {
    #[cfg(feature = "t19-timeline-fixture")]
    timeline: Option<terminal_log::timeline_fixture::Timeline>,
    audit_journal: crate::audit_journal::Journal,
    request_audit: crate::request_audit::Audit,
    logging: crate::logging::Manager,
    protected_export: crate::protected_export::Manager,
    config: crate::config::ConfigWorker,
    ssh: crate::ssh::Manager,
    serial: crate::serial::Manager,
    store: Arc<Mutex<Store>>,
    service_id: Uuid,
    started: Instant,
    fixture: bool,
    shutdown: watch::Sender<bool>,
}
pub async fn serve(instance: &str, bootstrap: SecretToken, fixture: bool) -> io::Result<()> {
    serve_with_config(instance, bootstrap, fixture, None).await
}
pub async fn serve_with_config(
    instance: &str,
    bootstrap: SecretToken,
    fixture: bool,
    directory: Option<std::path::PathBuf>,
) -> io::Result<()> {
    serve_inner(
        instance,
        bootstrap,
        fixture,
        directory,
        #[cfg(feature = "t19-timeline-fixture")]
        None,
    )
    .await
}

#[cfg(feature = "t19-timeline-fixture")]
pub async fn serve_t19_timeline_fixture(
    instance: &str,
    bootstrap: SecretToken,
    root: crate::t19_timeline_fixture::Root,
) -> io::Result<()> {
    serve_inner(
        instance,
        bootstrap,
        true,
        Some(root.path.clone()),
        Some(terminal_log::timeline_fixture::Timeline::for_owned_probe(
            root.concurrent,
        )),
    )
    .await
}

async fn serve_inner(
    instance: &str,
    bootstrap: SecretToken,
    fixture: bool,
    directory: Option<std::path::PathBuf>,
    #[cfg(feature = "t19-timeline-fixture")] timeline: Option<
        terminal_log::timeline_fixture::Timeline,
    >,
) -> io::Result<()> {
    require_standard_user()?;
    let security = PipeSecurity::current_user()?;
    let name = pipe_name(instance)?;
    // No endpoint gap: create the next listener before handing this connection off.
    let mut listener = security.create(&name, true)?;
    let (shutdown, mut stopping) = watch::channel(false);
    let configured = directory.is_some();
    let config = crate::config::ConfigWorker::start(directory)?;
    let started = Instant::now();
    let service_id = Uuid::new_v4();
    let audit_journal = crate::audit_journal::Journal::start(
        config.access(),
        configured,
        service_id,
        #[cfg(feature = "t19-timeline-fixture")]
        timeline.clone(),
    )
    .await;
    let mut pairing = Pairing::new(&bootstrap);
    // Explicit no-directory test fixtures retain their ephemeral policy tests.
    // An ordinary service without durable storage cannot issue Agent permits.
    if configured || !fixture {
        pairing.set_audit_sink(audit_journal.policy_sink());
    }
    let store = Arc::new(Mutex::new(Store {
        sessions: Sessions::default(),
        pairing,
        started,
    }));
    let ssh = crate::ssh::Manager::new(store.clone(), config.access());
    let serial = crate::serial::Manager::new(store.clone(), config.access());
    let logging = crate::logging::Manager::new(store.clone(), config.access())?;
    #[cfg(feature = "t19-timeline-fixture")]
    let logging = logging.with_timeline(timeline.clone());
    let protected_directory = match config
        .access()
        .request(crate::config::Internal::LoggingDirectory)
        .await
    {
        Ok(crate::config::Value::LoggingDirectory(directory)) => Some(directory),
        _ => None,
    };
    let protected_export =
        crate::protected_export::Manager::new(store.clone(), protected_directory)?;
    #[cfg(feature = "serial-ui-fixture")]
    let serial = if fixture { serial.ui_fixture() } else { serial };
    let runtime = Arc::new(Runtime {
        #[cfg(feature = "t19-timeline-fixture")]
        timeline,
        request_audit: crate::request_audit::Audit::new(service_id, started)
            .with_sink(audit_journal.sink()),
        audit_journal,
        logging,
        protected_export,
        config,
        ssh,
        serial,
        store,
        service_id,
        started,
        fixture,
        shutdown,
    });
    drop(bootstrap);
    let permits = Arc::new(Semaphore::new(32));
    let mut tasks = JoinSet::new();
    let mut serial_tick = tokio::time::interval(Duration::from_millis(10));
    serial_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    eprintln!("session-service ready; fixture={fixture}; no device opened");
    loop {
        // Completed tasks retain JoinSet entries until reaped; bound those too.
        while tasks.try_join_next().is_some() {}
        tokio::select! {
            _ = serial_tick.tick() => runtime.serial.tick(),
            _ = stopping.changed() => break,
            _ = tokio::signal::ctrl_c() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            connected = listener.connect() => {
                connected?;
                let next = security.create(&name, false)?;
                let active = std::mem::replace(&mut listener, next);
                if tasks.len() < 32 && let Ok(permit) = permits.clone().try_acquire_owned() {
                    let runtime = runtime.clone();
                    tasks.spawn(async move { let _permit = permit; let _ = connection::serve(active, runtime).await; });
                } else {
                    // No unbounded task or fabricated response when admission is full.
                    // Metadata bookkeeping failures increment the visible failure count.
                    let _ = runtime.request_audit.reject_capacity(&active);
                }
            }
        }
    }
    // Allow the shutdown RPC's acknowledgement to flush, then bound cleanup time.
    runtime.protected_export.stop();
    drop(listener);
    let _ = timeout(Duration::from_secs(1), async {
        while tasks.join_next().await.is_some() {}
    })
    .await;
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let runtime = Arc::try_unwrap(runtime)
        .map_err(|_| io::Error::other("session tasks still own runtime"))?;
    runtime.ssh.close().await;
    let serial_result = runtime.serial.close().await;
    let logging_result = runtime.logging.close().await;
    let protected_export_result = runtime.protected_export.close().await;
    let audit_result = runtime.audit_journal.close().await;
    let config_result = runtime.config.close().await;
    #[cfg(feature = "t19-timeline-fixture")]
    let timeline_result = runtime.timeline.as_ref().map_or(Ok(()), |timeline| {
        crate::t19_timeline_fixture::emit(timeline, logging_result.is_ok(), audit_result.is_ok())
    });
    serial_result?;
    logging_result?;
    protected_export_result?;
    audit_result?;
    config_result?;
    #[cfg(feature = "t19-timeline-fixture")]
    timeline_result?;
    Ok(())
}
