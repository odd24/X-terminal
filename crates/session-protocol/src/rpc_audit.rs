//! Whitelisted metadata extraction. Never serialize or Debug a request here.
use crate::*;
use session_core::{
    access::{Action, Scope, Target},
    rpc_audit::{Area, Descriptor, Resource, ResourceKind, Verb},
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum View {
    Info {},
    JournalInfo {},
    JournalPage {
        cursor: u64,
        through_cursor: u64,
        limit: usize,
    },
    Page {
        cursor: u64,
        through_cursor: u64,
        limit: usize,
    },
}
impl View {
    pub fn valid(self) -> bool {
        match self {
            Self::Info {} | Self::JournalInfo {} => true,
            Self::JournalPage {
                cursor,
                through_cursor,
                limit,
            } => cursor <= through_cursor && (1..=128).contains(&limit),
            Self::Page {
                cursor,
                through_cursor,
                limit,
            } => cursor <= through_cursor && (1..=128).contains(&limit),
        }
    }
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    JournalInfo {
        service_id: Uuid,
        status: session_core::audit_journal::Status,
    },
    JournalPage {
        service_id: Uuid,
        status: session_core::audit_journal::Status,
        page: session_core::audit_journal::Page,
    },
    Info {
        service_id: Uuid,
        through_cursor: u64,
        active_attempts: usize,
        record_failures: u64,
        persistent: bool,
    },
    Page {
        service_id: Uuid,
        page: session_core::rpc_audit::Page,
        record_failures: u64,
        persistent: bool,
    },
}
fn descriptor(area: Area, verb: Verb) -> Descriptor {
    Descriptor {
        area,
        verb,
        wire_id: None,
        request_id: None,
        requested_scope: None,
        resource: None,
    }
}
fn scope(connection: ConnectionRef, action: Action) -> Scope {
    Scope {
        target: Target::Connection { connection },
        action,
    }
}
fn conn(
    area: Area,
    verb: Verb,
    connection: ConnectionRef,
    action: Action,
    id: Option<Uuid>,
) -> Descriptor {
    Descriptor {
        request_id: id,
        requested_scope: Some(scope(connection, action)),
        ..descriptor(area, verb)
    }
}
fn resource(
    area: Area,
    verb: Verb,
    kind: ResourceKind,
    id: Uuid,
    connection: Option<ConnectionRef>,
) -> Descriptor {
    Descriptor {
        resource: Some(Resource {
            kind,
            id,
            connection,
        }),
        ..descriptor(area, verb)
    }
}
fn business(mut d: Descriptor, id: Uuid) -> Descriptor {
    d.request_id = Some(id);
    d
}
fn target(area: Area, verb: Verb, connection: ConnectionRef, id: Option<Uuid>) -> Descriptor {
    let mut d = resource(
        area,
        verb,
        if id.is_some() {
            ResourceKind::Operation
        } else {
            ResourceKind::Connection
        },
        id.unwrap_or(connection.connection_id.0),
        Some(connection),
    );
    d.request_id = id;
    d
}
impl Request {
    pub fn audit_descriptor(&self, wire_id: u32) -> Descriptor {
        use Request as R;
        let mut d = match self {
            R::RpcAudit { .. } => descriptor(Area::Session, Verb::Audit),
            R::Agent { request } => agent_descriptor(request),
            R::Ssh { request } => ssh_descriptor(request),
            R::Serial { request } => serial_descriptor(request),
            R::Config { request } => config_descriptor(request),
            R::Logging { request } => logging_descriptor(request),
            R::Ping {} => descriptor(Area::Session, Verb::Ping),
            R::List {} => descriptor(Area::Session, Verb::List),
            R::Read { connection, .. } | R::ReadText { connection, .. } => {
                conn(Area::Session, Verb::Read, *connection, Action::Read, None)
            }
            R::Screen { connection } => {
                conn(Area::Session, Verb::Screen, *connection, Action::Read, None)
            }
            R::Context {
                connection, window, ..
            } => Descriptor {
                requested_scope: Some(Scope {
                    target: Target::OutputWindow {
                        connection: *connection,
                        window: *window,
                    },
                    action: Action::Read,
                }),
                ..descriptor(Area::Session, Verb::Read)
            },
            R::ProtectedContext {
                connection, window, ..
            } => Descriptor {
                requested_scope: Some(Scope {
                    target: window.map_or(
                        Target::Connection {
                            connection: *connection,
                        },
                        |window| Target::OutputWindow {
                            connection: *connection,
                            window,
                        },
                    ),
                    action: Action::Read,
                }),
                ..descriptor(Area::Session, Verb::Read)
            },
            R::IssueRead { scopes, .. } => Descriptor {
                requested_scope: if scopes.len() == 1 {
                    Some(scope(scopes[0], Action::Read))
                } else {
                    None
                },
                ..descriptor(Area::Session, Verb::Authorize)
            },
            R::Revoke { ticket_id } => resource(
                Area::Session,
                Verb::Revoke,
                ResourceKind::Ticket,
                *ticket_id,
                None,
            ),
            R::CreateFixture {}
            | R::AppendFixture { .. }
            | R::ReconnectFixture { .. }
            | R::CloseFixture { .. }
            | R::RemoveFixture { .. } => {
                let mut d = descriptor(Area::Session, Verb::Fixture);
                if let R::AppendFixture { connection, .. }
                | R::ReconnectFixture { connection }
                | R::CloseFixture { connection }
                | R::RemoveFixture { connection } = self
                {
                    d = target(Area::Session, Verb::Fixture, *connection, None);
                }
                d
            }
            R::Shutdown {} => descriptor(Area::Session, Verb::Maintain),
        };
        d.wire_id = Some(wire_id);
        d
    }
}
fn agent_descriptor(r: &agent::Request) -> Descriptor {
    use agent::Request as A;
    match r {
        A::Grant {
            request_id, scopes, ..
        }
        | A::GrantTask {
            request_id, scopes, ..
        }
        | A::GrantOperation {
            request_id, scopes, ..
        }
        | A::GrantProtected {
            request_id, scopes, ..
        } => {
            let mut d = business(descriptor(Area::Agent, Verb::Authorize), *request_id);
            if scopes.len() == 1 {
                d.requested_scope = Some(scopes[0]);
            }
            if let A::GrantTask { task_id, .. } = r {
                d.resource = Some(Resource {
                    kind: ResourceKind::Task,
                    id: *task_id,
                    connection: None,
                });
            }
            if let Some(op) = r.operation().and_then(|op| op.descriptor()) {
                d.resource = Some(Resource {
                    kind: ResourceKind::Operation,
                    id: op.request_id,
                    connection: op.connection,
                });
            }
            if let A::GrantProtected {
                form: agent::ProtectedForm::TimedTask { task_id, .. },
                ..
            } = r
            {
                d.resource = Some(Resource {
                    kind: ResourceKind::Task,
                    id: *task_id,
                    connection: None,
                });
            }
            d
        }
        A::GrantStatus { request_id } => business(
            resource(
                Area::Agent,
                Verb::Status,
                ResourceKind::Grant,
                *request_id,
                None,
            ),
            *request_id,
        ),
        A::GrantRevoke { request_id } => business(
            resource(
                Area::Agent,
                Verb::Revoke,
                ResourceKind::Grant,
                *request_id,
                None,
            ),
            *request_id,
        ),
        A::GrantList {} => descriptor(Area::Agent, Verb::List),
        A::Acquire { connection, .. } => target(Area::Agent, Verb::Acquire, *connection, None),
        A::Release { connection, .. } => target(Area::Agent, Verb::Release, *connection, None),
        A::Lease { connection } => target(Area::Agent, Verb::Status, *connection, None),
        A::Takeover { connection } => target(Area::Agent, Verb::Takeover, *connection, None),
        A::Audit { .. } => descriptor(Area::Agent, Verb::Audit),
    }
}
fn ssh_descriptor(r: &ssh::Request) -> Descriptor {
    use ssh::Request as S;
    match r {
        S::StartStatus { request_id } => Descriptor {
            request_id: Some(*request_id),
            ..descriptor(Area::Ssh2, Verb::Status)
        },
        S::QuickStart { request_id, .. } => Descriptor {
            request_id: Some(*request_id),
            ..descriptor(Area::Ssh2, Verb::Connect)
        },
        S::Start {
            profile_id,
            request_id,
            ..
        } => Descriptor {
            request_id: Some(*request_id),
            requested_scope: Some(Scope {
                target: Target::Profile {
                    profile_id: *profile_id,
                },
                action: Action::Connect,
            }),
            ..descriptor(Area::Ssh2, Verb::Connect)
        },
        S::Write {
            connection,
            request_id,
            ..
        }
        | S::WriteText {
            connection,
            request_id,
            ..
        } => conn(
            Area::Ssh2,
            Verb::Write,
            *connection,
            Action::Write,
            Some(*request_id),
        ),
        S::Exec {
            connection,
            request_id,
            ..
        } => conn(
            Area::Ssh2,
            Verb::Exec,
            *connection,
            Action::Exec,
            Some(*request_id),
        ),
        S::Resize {
            connection,
            request_id,
            ..
        } => conn(
            Area::Ssh2,
            Verb::Control,
            *connection,
            Action::Control,
            Some(*request_id),
        ),
        S::Disconnect {
            connection,
            request_id,
        } => conn(
            Area::Ssh2,
            Verb::Disconnect,
            *connection,
            Action::Disconnect,
            Some(*request_id),
        ),
        S::Reconnect {
            connection,
            request_id,
            ..
        } => conn(
            Area::Ssh2,
            Verb::Reconnect,
            *connection,
            Action::Reconnect,
            Some(*request_id),
        ),
        S::ForgetStart {
            connection,
            request_id,
        } => conn(
            Area::Ssh2,
            Verb::Forget,
            *connection,
            Action::Forget,
            Some(*request_id),
        ),
        S::InputStatus {
            connection,
            request_id,
        }
        | S::DisconnectStatus {
            connection,
            request_id,
        }
        | S::ReconnectStatus {
            connection,
            request_id,
        }
        | S::ForgetStatus {
            connection,
            request_id,
        } => target(Area::Ssh2, Verb::Status, *connection, Some(*request_id)),
        S::ExecRead {
            connection,
            task_id,
            ..
        }
        | S::ExecReadProtected {
            connection,
            task_id,
            ..
        }
        | S::ExecStatus {
            connection,
            task_id,
        }
        | S::ExecCancel {
            connection,
            task_id,
        } => {
            let verb = match r {
                S::ExecCancel { .. } => Verb::Cancel,
                S::ExecStatus { .. } => Verb::Status,
                _ => Verb::Read,
            };
            resource(
                Area::Ssh2,
                verb,
                ResourceKind::Task,
                *task_id,
                Some(*connection),
            )
        }
        S::Status { connection } => target(Area::Ssh2, Verb::Status, *connection, None),
        S::AnswerHost { connection, .. }
        | S::AuthenticateKey { connection, .. }
        | S::Authenticate { connection, .. }
        | S::AnswerInteractive { connection, .. } => {
            target(Area::Ssh2, Verb::Authorize, *connection, None)
        }
        S::Close { connection } => conn(
            Area::Ssh2,
            Verb::Disconnect,
            *connection,
            Action::Disconnect,
            None,
        ),
        S::Forget { connection } => {
            conn(Area::Ssh2, Verb::Forget, *connection, Action::Forget, None)
        }
    }
}
fn serial_descriptor(r: &serial::Request) -> Descriptor {
    use serial::Request as S;
    match r {
        S::QuickStart { request_id, .. } => Descriptor {
            request_id: Some(*request_id),
            ..descriptor(Area::Serial, Verb::Connect)
        },
        S::StartStatus { request_id } => Descriptor {
            request_id: Some(*request_id),
            ..descriptor(Area::Serial, Verb::Status)
        },
        S::Inventory {} => descriptor(Area::Serial, Verb::Inspect),
        S::Start {
            profile_id,
            request_id,
            ..
        } => Descriptor {
            request_id: Some(*request_id),
            requested_scope: Some(Scope {
                target: Target::Profile {
                    profile_id: *profile_id,
                },
                action: Action::Connect,
            }),
            ..descriptor(Area::Serial, Verb::Connect)
        },
        S::Write {
            connection,
            request_id,
            ..
        }
        | S::Send {
            connection,
            request_id,
            ..
        } => conn(
            Area::Serial,
            Verb::Write,
            *connection,
            Action::Write,
            Some(*request_id),
        ),
        S::Control {
            connection,
            request_id,
            ..
        } => conn(
            Area::Serial,
            Verb::Control,
            *connection,
            Action::Control,
            Some(*request_id),
        ),
        S::Disconnect {
            connection,
            request_id,
        } => conn(
            Area::Serial,
            Verb::Disconnect,
            *connection,
            Action::Disconnect,
            Some(*request_id),
        ),
        S::ForgetStart {
            connection,
            request_id,
        } => conn(
            Area::Serial,
            Verb::Forget,
            *connection,
            Action::Forget,
            Some(*request_id),
        ),
        S::InputStatus {
            connection,
            request_id,
        }
        | S::DisconnectStatus {
            connection,
            request_id,
        }
        | S::ForgetStatus {
            connection,
            request_id,
        } => target(Area::Serial, Verb::Status, *connection, Some(*request_id)),
        S::Status { connection } => target(Area::Serial, Verb::Status, *connection, None),
        S::Close { connection } => conn(
            Area::Serial,
            Verb::Disconnect,
            *connection,
            Action::Disconnect,
            None,
        ),
        S::Forget { connection } => conn(
            Area::Serial,
            Verb::Forget,
            *connection,
            Action::Forget,
            None,
        ),
    }
}
fn config_descriptor(r: &config::ConfigRequest) -> Descriptor {
    use config::ConfigRequest as C;
    match r {
        C::PreviewImport { revision, .. } | C::PreviewBatch { revision, .. } => resource(
            Area::Configuration,
            Verb::Inspect,
            ResourceKind::ConfigurationRevision,
            *revision,
            None,
        ),
        C::ApplyImport { .. }
        | C::CancelImport { .. }
        | C::ApplyBatch { .. }
        | C::CancelBatch { .. } => descriptor(Area::Configuration, Verb::Configure),
        C::ImportStatus { .. } | C::BatchStatus { .. } => {
            descriptor(Area::Configuration, Verb::Status)
        }
        C::Recheck { .. } => descriptor(Area::Configuration, Verb::Configure),
        C::Preferences {}
        | C::Workspaces {}
        | C::QuickCommands {}
        | C::CredentialsPage { .. }
        | C::HostKeysPage { .. }
        | C::Page { .. }
        | C::Archives {} => descriptor(Area::Configuration, Verb::Read),
        C::SavePreferences { revision, .. }
        | C::SaveWorkspace { revision, .. }
        | C::SaveQuickCommand { revision, .. }
        | C::DeleteQuickCommand { revision, .. }
        | C::DeleteWorkspace { revision, .. } => resource(
            Area::Configuration,
            Verb::Configure,
            ResourceKind::ConfigurationRevision,
            *revision,
            None,
        ),
        C::InspectCredential { id } => resource(
            Area::Configuration,
            Verb::Inspect,
            ResourceKind::Credential,
            *id,
            None,
        ),
        C::ForgetCredential { id, .. } => resource(
            Area::Configuration,
            Verb::Forget,
            ResourceKind::Credential,
            *id,
            None,
        ),
        C::CreateBackup {} => descriptor(Area::Configuration, Verb::Configure),
        C::ExportConfig {} => descriptor(Area::Configuration, Verb::Export),
        C::InspectBackup { id } => resource(
            Area::Configuration,
            Verb::Inspect,
            ResourceKind::Archive,
            *id,
            None,
        ),
        C::RestoreBackup { id, .. } | C::RecoverBackup { id, .. } => resource(
            Area::Configuration,
            Verb::Configure,
            ResourceKind::Archive,
            *id,
            None,
        ),
        C::DeleteArchive { id, .. } => resource(
            Area::Configuration,
            Verb::Forget,
            ResourceKind::Archive,
            *id,
            None,
        ),
        C::ForgetHostKey { .. } => descriptor(Area::Configuration, Verb::Forget),
        C::SaveFolder { folder } => resource(
            Area::Configuration,
            Verb::Configure,
            ResourceKind::Folder,
            folder.id,
            None,
        ),
        C::DeleteFolder { id } => resource(
            Area::Configuration,
            Verb::Forget,
            ResourceKind::Folder,
            *id,
            None,
        ),
        C::SaveProfile { profile, .. } | C::SaveProfileKeyFile { profile, .. } => resource(
            Area::Configuration,
            Verb::Configure,
            ResourceKind::Profile,
            profile.id,
            None,
        ),
        C::DeleteProfile { id } => resource(
            Area::Configuration,
            Verb::Forget,
            ResourceKind::Profile,
            *id,
            None,
        ),
    }
}
fn logging_descriptor(r: &logging::Request) -> Descriptor {
    use logging::Request as L;
    match r {
        L::StartStatus {
            connection,
            request_id,
        } => target(Area::Logging, Verb::Status, *connection, Some(*request_id)),
        L::Start {
            connection,
            request_id,
            ..
        } => target(Area::Logging, Verb::Log, *connection, Some(*request_id)),
        L::List { connection } => target(Area::Logging, Verb::List, *connection, None),
        L::CaptureList {} | L::HistoryList {} | L::RecoveryList {} | L::CleanupList { .. } => {
            descriptor(Area::Logging, Verb::List)
        }
        L::Status { connection, log_id } => resource(
            Area::Logging,
            Verb::Status,
            ResourceKind::Log,
            *log_id,
            Some(*connection),
        ),
        L::Stop { connection, log_id } => resource(
            Area::Logging,
            Verb::Cancel,
            ResourceKind::Log,
            *log_id,
            Some(*connection),
        ),
        L::ReleaseFailed { connection, log_id } => resource(
            Area::Logging,
            Verb::Maintain,
            ResourceKind::Log,
            *log_id,
            Some(*connection),
        ),
        L::HistoryOpen {
            connection, log_id, ..
        }
        | L::HistoryRead {
            connection, log_id, ..
        }
        | L::RecoveryOpen {
            connection, log_id, ..
        }
        | L::RecoveryRead {
            connection, log_id, ..
        } => resource(
            Area::Logging,
            Verb::Read,
            ResourceKind::Log,
            *log_id,
            Some(*connection),
        ),
        L::HistoryClose {
            connection, log_id, ..
        }
        | L::RecoveryClose {
            connection, log_id, ..
        } => resource(
            Area::Logging,
            Verb::Release,
            ResourceKind::Log,
            *log_id,
            Some(*connection),
        ),
        L::TextExportStart {
            connection,
            log_id,
            request_id,
        }
        | L::ExportStart {
            connection,
            log_id,
            request_id,
        }
        | L::RecoveryExportStart {
            connection,
            log_id,
            request_id,
        } => business(
            resource(
                Area::Logging,
                Verb::Export,
                ResourceKind::Log,
                *log_id,
                Some(*connection),
            ),
            *request_id,
        ),
        L::TextExportStatus {
            connection,
            log_id,
            request_id,
        }
        | L::ExportStatus {
            connection,
            log_id,
            request_id,
        }
        | L::RecoveryExportStatus {
            connection,
            log_id,
            request_id,
        } => business(
            resource(
                Area::Logging,
                Verb::Status,
                ResourceKind::Log,
                *log_id,
                Some(*connection),
            ),
            *request_id,
        ),
        L::TextExportCancel {
            connection,
            log_id,
            request_id,
        }
        | L::ExportCancel {
            connection,
            log_id,
            request_id,
        }
        | L::RecoveryExportCancel {
            connection,
            log_id,
            request_id,
        } => business(
            resource(
                Area::Logging,
                Verb::Cancel,
                ResourceKind::Log,
                *log_id,
                Some(*connection),
            ),
            *request_id,
        ),
        L::CleanupPreview {
            kind,
            id,
            preview_id,
        }
        | L::CleanupStatus {
            kind,
            id,
            preview_id,
        }
        | L::CleanupCancel {
            kind,
            id,
            preview_id,
        }
        | L::CleanupCommit {
            kind,
            id,
            preview_id,
            ..
        } => {
            let verb = match r {
                L::CleanupStatus { .. } => Verb::Status,
                L::CleanupCancel { .. } => Verb::Cancel,
                L::CleanupPreview { .. } => Verb::Inspect,
                _ => Verb::Maintain,
            };
            let kind = match kind {
                logging::CleanupKind::Log => ResourceKind::Log,
                logging::CleanupKind::Export => ResourceKind::Export,
            };
            business(resource(Area::Logging, verb, kind, *id, None), *preview_id)
        }
    }
}

#[cfg(test)]
#[path = "rpc_audit/tests.rs"]
mod tests;
