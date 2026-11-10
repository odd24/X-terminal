//! Blocking storage owner, independent from configuration and terminal journals.
use session_core::{
    access::{AuditEvent, AuditSink},
    audit_journal::{Payload, State, Status},
    session::ErrorCode,
};
use session_protocol::rpc_audit::{Reply, View};
use std::{io, sync::Arc};
use terminal_log::audit::{Sink, Writer};
use uuid::Uuid;

pub(crate) struct Journal {
    writer: Option<Writer>,
    sink: Option<Sink>,
    fallback: State,
    service_id: Uuid,
}
struct PolicySink {
    sink: Option<Sink>,
}
impl AuditSink for PolicySink {
    fn record(&self, event: AuditEvent) -> bool {
        self.sink
            .as_ref()
            .is_some_and(|s| s.submit(Payload::Policy(event)))
    }
    fn healthy(&self) -> bool {
        self.sink
            .as_ref()
            .is_some_and(|s| s.status().state == State::Healthy)
    }
}
impl Journal {
    pub(crate) async fn start(
        config: crate::config::Access,
        configured: bool,
        service_id: Uuid,
    ) -> Self {
        let mut result = Self {
            writer: None,
            sink: None,
            fallback: if configured {
                State::StorageFailure
            } else {
                State::Disabled
            },
            service_id,
        };
        if !configured {
            return result;
        }
        if let Ok(crate::config::Value::LoggingDirectory(path)) = config
            .request(crate::config::Internal::LoggingDirectory)
            .await
            && let Ok(Ok(writer)) =
                tokio::task::spawn_blocking(move || Writer::open(&path, service_id)).await
        {
            result.sink = Some(writer.sink());
            result.writer = Some(writer);
        }
        result
    }
    pub(crate) fn sink(&self) -> Option<Sink> {
        self.sink.clone()
    }
    pub(crate) fn policy_sink(&self) -> Arc<dyn AuditSink> {
        Arc::new(PolicySink {
            sink: self.sink.clone(),
        })
    }
    fn status(&self) -> Status {
        self.sink.as_ref().map(Sink::status).unwrap_or(Status {
            state: self.fallback,
            accepted_through: 0,
            synced_through: 0,
            rejected_records: 0,
            incomplete_segments: 0,
            available_from: 0,
            retained_records: 0,
        })
    }
    pub(crate) fn query(&self, view: View) -> Result<Reply, ErrorCode> {
        match view {
            View::JournalInfo {} => Ok(Reply::JournalInfo {
                service_id: self.service_id,
                status: self.status(),
            }),
            View::JournalPage {
                cursor,
                through_cursor,
                limit,
            } => {
                let sink = self.sink.as_ref().ok_or(ErrorCode::InvalidState)?;
                let page = sink
                    .page(cursor, through_cursor, limit)
                    .map_err(|_| ErrorCode::InvalidArgument)?;
                Ok(Reply::JournalPage {
                    service_id: self.service_id,
                    status: self.status(),
                    page,
                })
            }
            _ => Err(ErrorCode::InvalidArgument),
        }
    }
    pub(crate) async fn close(mut self) -> io::Result<()> {
        if let Some(writer) = self.writer.take() {
            use crate::audit_diagnostic::{CloseDiagnostic, Outcome, PREFIX};
            let sink = self.sink.take();
            let result = tokio::task::spawn_blocking(move || writer.close()).await;
            let snapshot = sink.and_then(|s| s.diagnostic_snapshot().ok());
            let outcome = match (&result, &snapshot) {
                (Err(_), _) => Outcome::OwnerJoinFailed,
                (Ok(Err(_)), _) => Outcome::OwnerCloseFailed,
                (_, None) => Outcome::SnapshotUnavailable,
                (_, Some((s, _)))
                    if s.synced_through != s.accepted_through || s.state != State::Closed =>
                {
                    Outcome::Incomplete
                }
                _ => Outcome::Closed,
            };
            let diagnostic = CloseDiagnostic::new(outcome, snapshot);
            // Serialize only typed safe metadata, never the Result/error payload.
            if let Ok(json) = serde_json::to_string(&diagnostic) {
                eprintln!("{PREFIX}{json}");
            }
            if outcome != Outcome::Closed {
                return Err(io::Error::other(
                    "audit journal closed with incomplete recording",
                ));
            }
        }
        Ok(())
    }
}
