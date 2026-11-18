//! Private framed protocol between a managed SSH1 helper and its parent.
use serde::{Deserialize, Serialize};
use session_core::session::ConnectionRef;
use session_protocol::SensitiveBytes;
use uuid::Uuid;

pub const VERSION: u16 = 2;
pub const MAX_DATA: usize = 16 * 1024;
pub const MAX_PASSWORD: usize = 8192;

pub fn valid_rsa1_key(key: &str) -> bool {
    key.len() <= 16 * 1024
        && key.split_once(',').is_some_and(|(exponent, modulus)| {
            [exponent, modulus].into_iter().all(|value| {
                value.strip_prefix("0x").is_some_and(|hex| {
                    !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            })
        })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub connection: ConnectionRef,
    pub start_id: Uuid,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Ssh1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeKind {
    HostTrust,
    Password,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Challenge {
    pub session: Session,
    pub id: Uuid,
    pub kind: ChallengeKind,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Start {
        version: u16,
        protocol: Protocol,
        session: Session,
        endpoint: Endpoint,
        username: String,
        cols: u16,
        rows: u16,
    },
    HostAnswer {
        challenge: Challenge,
        fingerprint: String,
        approve: bool,
    },
    PasswordAnswer {
        challenge: Challenge,
        value: SensitiveBytes,
    },
    Input {
        session: Session,
        request_id: Uuid,
        bytes: SensitiveBytes,
    },
    Resize {
        session: Session,
        cols: u16,
        rows: u16,
    },
    Close {
        session: Session,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Closed,
    ControlLost,
    InvalidControl,
    HostDeclined,
    AuthFailed,
    Timeout,
    Backend,
    PeerClosed,
    BackendExit,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    HostChallenge {
        challenge: Challenge,
        endpoint: Endpoint,
        algorithm: String,
        fingerprint: String,
        key: String,
    },
    PasswordChallenge {
        challenge: Challenge,
    },
    Ready {
        session: Session,
    },
    Output {
        session: Session,
        stderr: bool,
        bytes: SensitiveBytes,
    },
    InputAccepted {
        session: Session,
        request_id: Uuid,
        bytes: usize,
    },
    Ended {
        session: Session,
        reason: EndReason,
        backend_status: Option<i32>,
    },
}
