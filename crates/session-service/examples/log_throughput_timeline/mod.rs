use super::*;
use session_core::session::ErrorCode;
use session_service::t19_timeline_fixture::{Envelope, MAX_SUMMARY_BYTES};
use terminal_log::timeline_fixture::{AFTER_FAULT, BEFORE_FAULT, Kind, Operation, Source};
use tokio::io::AsyncReadExt;

pub async fn smoke(client: &mut Client, segment_bytes: u64) -> Result<Value> {
    let Reply::Connection(connection) = request(client, Request::CreateFixture {}).await? else {
        return Err(io::Error::other("expected fixture connection").into());
    };
    let connection = connection.reference();
    require(
        matches!(
            client
                .request(Request::RemoveFixture { connection })
                .await?,
            Response::Error {
                code: ErrorCode::Unsupported,
                ..
            }
        ),
        "fixture dispatch allowlist must reject unrelated action",
    )?;
    let Reply::Logging(log::Reply::Info(log)) = request(
        client,
        Request::Logging {
            request: log::Request::Start {
                connection,
                request_id: Uuid::new_v4(),
                limits: log::Limits {
                    segment_bytes,
                    segments: 2,
                },
            },
        },
    )
    .await?
    else {
        return Err(io::Error::other("expected log start").into());
    };
    require(
        matches!(
            client
                .request(Request::AppendFixture {
                    connection,
                    bytes: vec![0; BLOCK]
                })
                .await?,
            Response::Error {
                code: ErrorCode::InvalidArgument,
                ..
            }
        ),
        "fixture must reject a non-calibration append size",
    )?;
    let bytes = (0..BATCH)
        .flat_map(|seq| payload(0, seq))
        .collect::<Vec<_>>();
    request(client, Request::AppendFixture { connection, bytes }).await?;
    request(
        client,
        Request::Logging {
            request: log::Request::Stop {
                connection,
                log_id: log.log_id,
            },
        },
    )
    .await?;
    let stopped = timeout(Duration::from_secs(5), async {
        loop {
            let status = info(client, connection, log.log_id).await?;
            if status.worker_finished {
                return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(status);
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await??;
    require(
        stopped.failure.is_none()
            && stopped.durable
            && stopped.accepted_records == BATCH
            && stopped.written_records == BATCH
            && stopped.accepted_raw_bytes == BATCH * BLOCK as u64
            && stopped.rejected_records == 0,
        "only the valid fixture burst must reach the logger",
    )?;
    Ok(json!({"passed":true,"smoke":true,"records":stopped.written_records}))
}

pub async fn read(output: tokio::process::ChildStdout) -> Result<Envelope> {
    let mut bytes = Vec::new();
    output
        .take(MAX_SUMMARY_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    require(
        bytes.len() as u64 <= MAX_SUMMARY_BYTES
            && bytes.last() == Some(&b'\n')
            && !bytes[..bytes.len() - 1].contains(&b'\n'),
        "one bounded summary line required",
    )?;
    let envelope = serde_json::from_slice(&bytes)?;
    validate(&envelope)?;
    Ok(envelope)
}

fn validate(envelope: &Envelope) -> Result<()> {
    let summary = &envelope.summary;
    let first = summary.events.iter().position(|event| event.kind.fault());
    let before = first.unwrap_or(summary.events.len());
    let after = first.map_or(0, |index| summary.events.len() - index - 1);
    require(
        envelope.version == 1
            && before <= BEFORE_FAULT
            && after <= AFTER_FAULT
            && (summary.omitted_after_fault == 0 || after == AFTER_FAULT)
            && (summary.evicted_before_fault == 0 || before == BEFORE_FAULT)
            && summary.first_fault == first.map(|index| summary.events[index])
            && summary.events.len() as u128
                + u128::from(summary.evicted_before_fault)
                + u128::from(summary.omitted_after_fault)
                == u128::from(summary.observed_events)
            && summary.events.iter().enumerate().all(|(i, event)| {
                u128::from(event.ordinal)
                    == u128::from(summary.evicted_before_fault) + i as u128 + 1
                    && !matches!(event.source, Source::Logger(index) if index >= STREAMS as u8)
            })
            && summary
                .events
                .iter()
                .zip(summary.events.iter().skip(1))
                .all(|(a, b)| a.elapsed_ns <= b.elapsed_ns),
        "timeline bounds, order and loss counters",
    )
}

pub fn save(envelope: Envelope, workspace: &Path, id: Uuid, smoke: bool) -> Result<Value> {
    // Preserve the safe summary before interpreting closure or reachability.
    serde_json::to_writer(
        File::create_new(workspace.join(format!("P22-throughput-d-tmp-{id}-timeline.json")))?,
        &envelope,
    )?;
    let summary = envelope.summary;
    let audit_sync_seen = summary.events.iter().any(|event| {
        event.source == Source::Audit
            && event.seq > 0
            && event.kind == Kind::IoEnd(Operation::AuditSync)
    });
    let logger_reached = (1..=BATCH).all(|seq| {
        [
            Kind::TrySend,
            Kind::Accepted,
            Kind::Dequeue,
            Kind::IoEnd(Operation::RawWrite),
            Kind::IoEnd(Operation::JsonlWrite),
            Kind::IoEnd(Operation::LiveWrite),
        ]
        .iter()
        .all(|kind| {
            summary.events.iter().any(|event| {
                event.source == Source::Logger(0) && event.seq == seq && event.kind == *kind
            })
        })
    });
    let logger_sync_seen = [
        Operation::LiveFlush,
        Operation::LiveSync,
        Operation::RawSync,
        Operation::JsonlSync,
    ]
    .iter()
    .all(|op| {
        summary.events.iter().any(|event| {
            event.source == Source::Logger(0)
                && event.seq == BATCH
                && event.written_records == Some(BATCH)
                && event.kind == Kind::IoEnd(*op)
        })
    });
    let smoke_passed = !smoke
        || (summary.first_fault.is_none()
            && summary.evicted_before_fault == 0
            && summary.omitted_after_fault == 0
            && audit_sync_seen
            && logger_reached
            && logger_sync_seen);
    Ok(json!({
        "saved":true,"version":envelope.version,
        "workers_closed":envelope.logging_closed && envelope.audit_closed,
        "logging_closed":envelope.logging_closed,"audit_closed":envelope.audit_closed,
        "observed_events":summary.observed_events,"retained_events":summary.events.len(),
        "evicted_before_fault":summary.evicted_before_fault,"omitted_after_fault":summary.omitted_after_fault,
        "first_fault":summary.first_fault,"audit_sync_seen":audit_sync_seen,"smoke_passed":smoke_passed,
    }))
}
