use super::*;

pub(super) fn request(name: &str, args: Value) -> Option<RequestMessage> {
    Some(match name {
        names::LOGS_EXPORT => RequestMessage::Call {
            request: Operation::LogsExport {
                target: serde_json::from_value(args).ok()?,
            },
        },
        names::LOGS_EXPORT_STATUS => RequestMessage::Call {
            request: Operation::LogsExportStatus {
                query: serde_json::from_value(args).ok()?,
            },
        },
        names::LOGS_EXPORT_CANCEL => RequestMessage::Call {
            request: Operation::LogsExportCancel {
                query: serde_json::from_value(args).ok()?,
            },
        },
        names::SSH_RESIZE => {
            let a = serde_json::from_value::<SshResizeArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::SshResize {
                    connection: a.connection,
                    request_id: a.request_id,
                    cols: a.cols,
                    rows: a.rows,
                },
            }
        }
        names::SERIAL_CONNECT => {
            let target =
                serde_json::from_value::<session_protocol::serial::ConnectTarget>(args).ok()?;
            RequestMessage::Call {
                request: Operation::SerialConnect { target },
            }
        }
        names::SERIAL_CONNECT_STATUS => {
            let target =
                serde_json::from_value::<session_protocol::serial::ConnectTarget>(args).ok()?;
            RequestMessage::Call {
                request: Operation::SerialConnectStatus { target },
            }
        }
        names::SSH_CONNECT => {
            let a = serde_json::from_value::<ConnectArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Connect {
                    profile_id: a.profile_id,
                    revision: a.revision,
                    request_id: a.request_id,
                    cols: a.cols,
                    rows: a.rows,
                },
            }
        }
        names::SSH_CONNECT_STATUS => {
            let a = serde_json::from_value::<ConnectStatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::ConnectStatus {
                    profile_id: a.profile_id,
                    revision: a.revision,
                    request_id: a.request_id,
                },
            }
        }
        names::SSH_RECONNECT => {
            let a = serde_json::from_value::<ReconnectArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Reconnect {
                    connection: a.connection,
                    request_id: a.request_id,
                    cols: a.cols,
                    rows: a.rows,
                },
            }
        }
        names::SSH_RECONNECT_STATUS => {
            let a = serde_json::from_value::<ReconnectStatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::ReconnectStatus {
                    connection: a.connection,
                    request_id: a.request_id,
                },
            }
        }
        names::SESSIONS_FORGET => {
            let a = serde_json::from_value::<StatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Forget {
                    transport: a.transport,
                    connection: a.connection,
                    request_id: a.request_id,
                },
            }
        }
        names::SESSIONS_FORGET_STATUS => {
            let a = serde_json::from_value::<StatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::ForgetStatus {
                    transport: a.transport,
                    connection: a.connection,
                    request_id: a.request_id,
                },
            }
        }
        names::SESSIONS_DISCONNECT => {
            let a = serde_json::from_value::<StatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Disconnect {
                    transport: a.transport,
                    connection: a.connection,
                    request_id: a.request_id,
                },
            }
        }
        names::SESSIONS_DISCONNECT_STATUS => {
            let a = serde_json::from_value::<StatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::DisconnectStatus {
                    transport: a.transport,
                    connection: a.connection,
                    request_id: a.request_id,
                },
            }
        }
        names::SERIAL_WRITE => {
            let a = serde_json::from_value::<SerialWriteArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::SerialWrite {
                    connection: a.connection,
                    request_id: a.request_id,
                    bytes: session_protocol::SensitiveBytes::new(a.bytes),
                },
            }
        }
        names::SERIAL_CONTROL => {
            let a = serde_json::from_value::<SerialControlArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::SerialControl {
                    connection: a.connection,
                    request_id: a.request_id,
                    line: a.line,
                    asserted: a.asserted,
                },
            }
        }
        names::SSH_EXEC => {
            let a = serde_json::from_value::<ExecArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Exec {
                    connection: a.connection,
                    request_id: a.request_id,
                    command: a.command,
                    timeout_ms: a.timeout_ms,
                    max_output_bytes: a.max_output_bytes,
                },
            }
        }
        names::TASKS_GET => {
            let a = serde_json::from_value::<TaskGetArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::TaskGet {
                    connection: a.connection,
                    task_id: a.task_id,
                    view: a.view,
                },
            }
        }
        names::TASKS_CANCEL => {
            let a = serde_json::from_value::<TaskArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::TaskCancel {
                    connection: a.connection,
                    task_id: a.task_id,
                },
            }
        }
        names::AGENT_STATUS => {
            serde_json::from_value::<ListArgs>(args).ok()?;
            RequestMessage::Status {}
        }
        names::SESSIONS_LIST => {
            serde_json::from_value::<ListArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::List {},
            }
        }
        names::TERMINAL_READ => {
            let a = serde_json::from_value::<OutputArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Output {
                    connection: a.connection,
                    window: a.window,
                    view: a.view,
                },
            }
        }
        names::TERMINAL_SCREEN => {
            let a = serde_json::from_value::<ScreenArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Output {
                    connection: a.connection,
                    window: a.window,
                    view: View::Screen {
                        through_cursor: a.through_cursor,
                    },
                },
            }
        }
        names::TERMINAL_SEND => {
            let a = serde_json::from_value::<SendArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Send {
                    transport: a.transport,
                    connection: a.connection,
                    request_id: a.request_id,
                    text: a.text,
                },
            }
        }
        names::TERMINAL_INPUT_STATUS => {
            let a = serde_json::from_value::<StatusArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::InputStatus {
                    transport: a.transport,
                    connection: a.connection,
                    request_id: a.request_id,
                },
            }
        }
        names::INPUT_LEASE => {
            let a = serde_json::from_value::<ConnectionArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Lease {
                    connection: a.connection,
                },
            }
        }
        names::INPUT_ACQUIRE => {
            let a = serde_json::from_value::<AcquireArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Acquire {
                    connection: a.connection,
                    lifetime_ms: a.lifetime_ms,
                },
            }
        }
        names::INPUT_RELEASE => {
            let a = serde_json::from_value::<ReleaseArgs>(args).ok()?;
            RequestMessage::Call {
                request: Operation::Release {
                    connection: a.connection,
                    lease_id: a.lease_id,
                },
            }
        }
        _ => return decode_shortcuts(name, args),
    })
}

fn decode_shortcuts(name: &str, args: Value) -> Option<RequestMessage> {
    Some(match name {
        names::SHORTCUTS_LIST => shortcut_request(
            args,
            shortcuts::Request::List,
            shortcuts::v2::Request::List,
            shortcuts::v3::Request::List,
        )?,
        names::SHORTCUTS_CREATE => shortcut_request(
            args,
            shortcuts::Request::Create,
            shortcuts::v2::Request::Create,
            shortcuts::v3::Request::Create,
        )?,
        names::SHORTCUTS_UPDATE => shortcut_request(
            args,
            shortcuts::Request::Update,
            shortcuts::v2::Request::Update,
            shortcuts::v3::Request::Update,
        )?,
        names::SHORTCUTS_REMOVE => shortcut_request(
            args,
            shortcuts::Request::Remove,
            shortcuts::v2::Request::Remove,
            shortcuts::v3::Request::Remove,
        )?,
        _ => return None,
    })
}

fn shortcut_request<
    T: serde::de::DeserializeOwned,
    U: serde::de::DeserializeOwned,
    V: serde::de::DeserializeOwned,
>(
    args: Value,
    legacy: fn(T) -> shortcuts::Request,
    extended: fn(U) -> shortcuts::v2::Request,
    described: fn(V) -> shortcuts::v3::Request,
) -> Option<RequestMessage> {
    Some(match serde_json::from_value(args).ok()? {
        shortcuts::Compatible::Legacy(args) => RequestMessage::Shortcuts {
            request: legacy(args),
        },
        shortcuts::Compatible::Extended(args) => RequestMessage::ShortcutsV2 {
            request: extended(args),
        },
        shortcuts::Compatible::Described(args) => RequestMessage::ShortcutsV3 {
            request: described(args),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_tools_distinguish_status_from_list_and_reject_invalid_requests() {
        assert!(matches!(
            request(names::AGENT_STATUS, json!({})),
            Some(RequestMessage::Status {})
        ));
        assert!(matches!(
            request(names::SESSIONS_LIST, json!({})),
            Some(RequestMessage::Call {
                request: Operation::List {}
            })
        ));
        assert!(request("unknown", json!({})).is_none());
        assert!(request(names::TERMINAL_WAIT, json!({})).is_none());
        assert!(request(names::TERMINAL_SEND, json!({})).is_none());
        assert!(request(names::SESSIONS_LIST, json!({ "extra": true })).is_none());
    }

    #[test]
    fn shortcut_version_selects_exact_request_family() {
        assert!(matches!(
            request(names::SHORTCUTS_LIST, json!({})),
            Some(RequestMessage::Shortcuts {
                request: shortcuts::Request::List(_)
            })
        ));
        assert!(matches!(
            request(names::SHORTCUTS_LIST, json!({ "version": "v2" })),
            Some(RequestMessage::ShortcutsV2 {
                request: shortcuts::v2::Request::List(_)
            })
        ));
        assert!(matches!(
            request(names::SHORTCUTS_LIST, json!({ "version": "v3" })),
            Some(RequestMessage::ShortcutsV3 {
                request: shortcuts::v3::Request::List(_)
            })
        ));
        assert!(request(names::SHORTCUTS_LIST, json!({ "version": "v4" })).is_none());
        assert!(
            request(
                names::SHORTCUTS_LIST,
                json!({ "version": "v2", "extra": true })
            )
            .is_none()
        );
    }
}
