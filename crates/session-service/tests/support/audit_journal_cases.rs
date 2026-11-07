use super::*;
use session_core::{
    access::{Action, Scope, Target},
    audit_journal::{Payload, State, Status},
};
use session_protocol::rpc_audit::{Reply as A, View};
async fn status(client: &mut Client) -> (Uuid, Status) {
    match ok(client
        .request(Request::RpcAudit {
            view: View::JournalInfo {},
        })
        .await
        .unwrap())
    {
        Reply::RpcAudit(A::JournalInfo { service_id, status }) => (service_id, status),
        _ => panic!(),
    }
}
async fn wait_synced(client: &mut Client, minimum: u64) -> (Uuid, Status) {
    timeout(Duration::from_secs(5), async {
        loop {
            let result = status(client).await;
            if result.1.synced_through >= minimum {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn audit_journal_real_dual_sources_survive_restart_without_restoring_agent_tickets() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let connection = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let id = Uuid::new_v4();
    let Reply::Agent(agent::Reply::Grant {
        receipt,
        token: Some(token),
    }) = ok(desktop
        .request(Request::Agent {
            request: agent::Request::Grant {
                request_id: id,
                scopes: vec![Scope {
                    target: Target::Connection { connection },
                    action: Action::Read,
                }],
                lifetime_ms: 10000,
            },
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let ticket = receipt.summary.ticket_id;
    let (mut peer, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    assert_eq!(
        error(
            peer.request(Request::RpcAudit {
                view: View::JournalInfo {}
            })
            .await
            .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        error(
            peer.request(Request::RpcAudit {
                view: View::JournalPage {
                    cursor: 0,
                    through_cursor: 0,
                    limit: 1
                }
            })
            .await
            .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    ok(peer
        .request(Request::Read {
            connection,
            cursor: 1,
            max_bytes: 4096,
        })
        .await
        .unwrap());
    drop(peer);
    let prior = status(&mut desktop).await.1.accepted_through;
    let (first, initial) = wait_synced(&mut desktop, prior).await;
    assert_eq!(initial.state, State::Healthy);
    let fixed = initial.synced_through;
    let mut cursor = 0;
    let mut rows = Vec::new();
    loop {
        let Reply::RpcAudit(A::JournalPage { page, .. }) = ok(desktop
            .request(Request::RpcAudit {
                view: View::JournalPage {
                    cursor,
                    through_cursor: fixed,
                    limit: 3,
                },
            })
            .await
            .unwrap())
        else {
            panic!()
        };
        assert!(!page.gap);
        assert!(page.records.iter().all(|r| r.service_id == first));
        cursor = page.next_cursor;
        rows.extend(page.records);
        if cursor == fixed {
            break;
        }
    }
    assert!(rows.iter().any(|r|matches!(&r.payload,Payload::Policy(e) if e.kind==session_core::access::AuditKind::Granted && e.client_id==Some(ticket))));
    assert!(rows.iter().any(|r|matches!(&r.payload,Payload::Rpc(e) if e.attempt.origin.client_id==Some(ticket) && e.phase==session_core::rpc_audit::Phase::ReturnedError {code:ErrorCode::PermissionDenied})));
    let text = serde_json::to_string(&rows).unwrap();
    assert!(!text.contains(token.expose()));
    fixture.stop(&mut desktop).await;
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let (second, again) = status(&mut desktop).await;
    assert_ne!(first, second);
    assert!(again.synced_through >= fixed);
    assert!(
        Client::connect(&fixture.instance, token.expose(), fixture.pid)
            .await
            .is_err()
    );
    let Reply::RpcAudit(A::JournalPage { page, .. }) = ok(desktop
        .request(Request::RpcAudit {
            view: View::JournalPage {
                cursor: 0,
                through_cursor: fixed,
                limit: 128,
            },
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    assert!(page.records.iter().all(|r| r.service_id == first));
    fixture.stop(&mut desktop).await;
    let directory = temp.0.join("terminal-audit");
    let names: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    assert!(!names.is_empty());
    for path in names {
        assert!(
            !std::fs::read_to_string(path)
                .unwrap()
                .contains(token.expose())
        );
    }
}

#[tokio::test]
async fn audit_journal_unknown_storage_preserves_files_and_refuses_new_agent_grants_without_closing_desktop()
 {
    let temp = ConfigTemp::new();
    let directory = temp.0.join("terminal-audit");
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("user.txt");
    std::fs::write(&path, b"preserve user data").unwrap();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    assert_eq!(status(&mut desktop).await.1.state, State::StorageFailure);
    let connection = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    assert_eq!(
        error(
            desktop
                .request(Request::Agent {
                    request: agent::Request::Grant {
                        request_id: Uuid::new_v4(),
                        scopes: vec![Scope {
                            target: Target::Connection { connection },
                            action: Action::Read
                        }],
                        lifetime_ms: 1000
                    }
                })
                .await
                .unwrap()
        ),
        ErrorCode::CapacityExceeded
    );
    ok(desktop.request(Request::Ping {}).await.unwrap());
    ok(desktop
        .request(Request::Screen { connection })
        .await
        .unwrap());
    ok(desktop
        .request(Request::Agent {
            request: agent::Request::Takeover { connection },
        })
        .await
        .unwrap());
    fixture.stop(&mut desktop).await;
    assert_eq!(std::fs::read(path).unwrap(), b"preserve user data");
}
