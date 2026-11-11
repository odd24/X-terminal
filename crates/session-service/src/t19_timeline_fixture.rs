//! Explicit, owned D-volume T19 diagnostic only.
use crate::log_calibration_root::Parent;
use serde::{Deserialize, Serialize};
use session_protocol::{Request, logging, rpc_audit};
use std::{
    fs::File,
    io::{self, Write},
    path::{Path, PathBuf},
};
use terminal_log::timeline_fixture::{Summary, Timeline};

pub struct Root {
    pub(crate) path: PathBuf,
    _root: File,
    _parent: Parent,
}

impl Root {
    pub fn open(path: &Path) -> io::Result<Self> {
        let parent = Parent::open()?;
        let (root, path) = parent.pin_empty(path)?;
        Ok(Self {
            path,
            _root: root,
            _parent: parent,
        })
    }
}

pub const MAX_SUMMARY_BYTES: u64 = 1024 * 1024;

pub(crate) fn allows(request: &Request) -> bool {
    matches!(
        request,
        Request::Ping {}
            | Request::List {}
            | Request::Shutdown {}
            | Request::CreateFixture {}
            | Request::AppendFixture { .. }
            | Request::Logging {
                request: logging::Request::Start { .. }
                    | logging::Request::Status { .. }
                    | logging::Request::Stop { .. }
            }
            | Request::RpcAudit {
                view: rpc_audit::View::JournalInfo {}
            }
    )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub version: u8,
    pub logging_closed: bool,
    pub audit_closed: bool,
    pub summary: Summary,
}

pub(crate) fn emit(
    timeline: &Timeline,
    logging_closed: bool,
    audit_closed: bool,
) -> io::Result<()> {
    let summary = timeline
        .take_summary()
        .ok_or_else(|| io::Error::other("T19 summary already taken"))?;
    let mut output = io::stdout().lock();
    serde_json::to_writer(
        &mut output,
        &Envelope {
            version: 1,
            logging_closed,
            audit_closed,
            summary,
        },
    )?;
    writeln!(output)?;
    output.flush()
}
