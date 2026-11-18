use super::probe::{CONNECTION, Reply, Request};
use serde::{Deserialize, Serialize};
use session_core::session::ConnectionRef;
use session_protocol::{Sensitive, read_frame, write_frame};
use std::io;
use tokio::process::{ChildStdin, ChildStdout};
use uuid::Uuid;

const APPROVED_VALUE: &str = "p04-synthetic-auth-only-383ecd";
const REJECTED_VALUE: &str = "p04-synthetic-decoy-509d3d";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
enum Kind {
    HostTrust,
    Authentication,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    connection: ConnectionRef,
    id: Uuid,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Issued {
    host: Target,
    auth: Target,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) enum Answer {
    HostTrust { target: Target, approve: bool },
    Authentication { target: Target, value: Sensitive },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
enum Status {
    Accepted,
    Mismatch,
    Consumed,
    NotReady,
    Declined,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Ack {
    kind: Kind,
    target: Target,
    status: Status,
    host_callbacks: u32,
    auth_callbacks: u32,
}

pub(super) struct Backend {
    issued: Issued,
    host_approved: Option<bool>,
    auth_callbacks: u32,
}

impl Backend {
    pub(super) fn new() -> Self {
        let target = || Target {
            connection: CONNECTION,
            id: Uuid::new_v4(),
        };
        Self {
            issued: Issued {
                host: target(),
                auth: target(),
            },
            host_approved: None,
            auth_callbacks: 0,
        }
    }

    pub(super) fn issued(&self) -> Issued {
        self.issued
    }

    pub(super) fn answer(&mut self, answer: Answer) -> Ack {
        let (kind, target, status) = match answer {
            Answer::HostTrust { target, approve } => {
                let status = if target != self.issued.host {
                    Status::Mismatch
                } else if self.host_approved.is_some() {
                    Status::Consumed
                } else {
                    self.host_approved = Some(approve);
                    if approve {
                        Status::Accepted
                    } else {
                        Status::Declined
                    }
                };
                (Kind::HostTrust, target, status)
            }
            Answer::Authentication { target, value } => {
                let status = if target != self.issued.auth {
                    Status::Mismatch
                } else if self.host_approved != Some(true) {
                    Status::NotReady
                } else if self.auth_callbacks != 0 {
                    Status::Consumed
                } else {
                    self.auth_callbacks += 1;
                    synthetic_authenticate(value)
                };
                (Kind::Authentication, target, status)
            }
        };
        Ack {
            kind,
            target,
            status,
            host_callbacks: u32::from(self.host_approved.is_some()),
            auth_callbacks: self.auth_callbacks,
        }
    }
}

fn synthetic_authenticate(value: Sensitive) -> Status {
    if value.expose() == APPROVED_VALUE {
        Status::Accepted
    } else {
        Status::Declined
    }
}

async fn exchange(
    input: &mut ChildStdin,
    output: &mut ChildStdout,
    request: Request,
) -> io::Result<Reply> {
    write_frame(input, &request).await?;
    let response: serde_json::Value = read_frame(output)
        .await?
        .ok_or_else(|| io::Error::other("missing challenge probe reply"))?;
    let text = response.to_string();
    if [APPROVED_VALUE, REJECTED_VALUE]
        .iter()
        .any(|value| text.contains(value))
    {
        return Err(io::Error::other(
            "synthetic authentication value appeared in a reply",
        ));
    }
    serde_json::from_value(response)
        .map_err(|_| io::Error::other("unexpected challenge probe reply"))
}

pub(super) async fn exercise(input: &mut ChildStdin, output: &mut ChildStdout) -> io::Result<()> {
    let Reply::Challenges(issued) = exchange(input, output, Request::Challenges).await? else {
        return Err(io::Error::other("expected synthetic challenges"));
    };
    if issued.host.connection != CONNECTION
        || issued.auth.connection != CONNECTION
        || issued.host.id.is_nil()
        || issued.auth.id.is_nil()
        || issued.host.id == issued.auth.id
    {
        return Err(io::Error::other("invalid synthetic challenge targets"));
    }
    let host = |target| Answer::HostTrust {
        target,
        approve: true,
    };
    let auth = |target, value: &str| Answer::Authentication {
        target,
        value: Sensitive::new(value.into()),
    };
    let stale = |target: Target| Target {
        connection: ConnectionRef {
            generation: 2,
            ..target.connection
        },
        ..target
    };
    let wrong = |target| Target {
        id: Uuid::nil(),
        ..target
    };
    for (answer, status, host_callbacks, auth_callbacks) in [
        (auth(issued.auth, REJECTED_VALUE), Status::NotReady, 0, 0),
        (auth(issued.host, REJECTED_VALUE), Status::Mismatch, 0, 0),
        (host(issued.auth), Status::Mismatch, 0, 0),
        (host(wrong(issued.host)), Status::Mismatch, 0, 0),
        (host(stale(issued.host)), Status::Mismatch, 0, 0),
        (host(issued.host), Status::Accepted, 1, 0),
        (host(issued.host), Status::Consumed, 1, 0),
        (
            auth(wrong(issued.auth), REJECTED_VALUE),
            Status::Mismatch,
            1,
            0,
        ),
        (
            auth(stale(issued.auth), REJECTED_VALUE),
            Status::Mismatch,
            1,
            0,
        ),
        (auth(issued.auth, APPROVED_VALUE), Status::Accepted, 1, 1),
        (auth(issued.auth, REJECTED_VALUE), Status::Consumed, 1, 1),
    ] {
        let (kind, target) = match &answer {
            Answer::HostTrust { target, .. } => (Kind::HostTrust, *target),
            Answer::Authentication { target, .. } => (Kind::Authentication, *target),
        };
        let Reply::Answer(ack) = exchange(input, output, Request::Answer(answer)).await? else {
            return Err(io::Error::other("expected challenge acknowledgement"));
        };
        if ack
            != (Ack {
                kind,
                target,
                status,
                host_callbacks,
                auth_callbacks,
            })
        {
            return Err(io::Error::other(format!(
                "unexpected challenge acknowledgement for {status:?}: {ack:?}"
            )));
        }
    }
    let Reply::Application(data) = exchange(input, output, Request::Application).await? else {
        return Err(io::Error::other("expected application frame"));
    };
    if data != b"synthetic terminal output" {
        return Err(io::Error::other("unexpected application bytes"));
    }
    Ok(())
}
