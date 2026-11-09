use super::*;
use config::{
    BatchReceipt, BatchState as S, ConfigError as E, ConfigReply as C, ConfigRequest as Q,
};
fn receipt(reply: C) -> BatchReceipt {
    if let C::Batch { receipt } = reply {
        receipt
    } else {
        panic!("expected batch receipt: {reply:?}")
    }
}
#[tokio::test]
async fn batch_config_owner_cancel_conflict_apply_once_and_restart_unknown() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let profile = portable();
        ids.push(profile.id);
        assert!(matches!(
            config_call(
                &mut desktop,
                Q::SaveProfile {
                    profile,
                    credential: config::CredentialEdit::Keep {}
                }
            )
            .await,
            C::SavedProfile { .. }
        ));
    }
    let patch = config_store::BatchPatch {
        folder: config_store::BatchFolder::Keep {},
        encoding: Some(config_store::Encoding::Gbk),
        ssh_port: Some(2200),
        serial_baud: None,
    };
    let C::Page { revision, .. } = config_call(
        &mut desktop,
        Q::Page {
            revision: None,
            offset: 0,
            folders: false,
        },
    )
    .await
    else {
        panic!()
    };
    let id = Uuid::new_v4();
    let r = receipt(
        config_call(
            &mut desktop,
            Q::PreviewBatch {
                id,
                revision,
                ids: ids[..2].to_vec(),
                patch: patch.clone(),
            },
        )
        .await,
    );
    assert_eq!(r.state, S::Preview);
    assert_eq!(r.changed_count, 2);
    let mut other = fixture.connect().await;
    // Reconnecting with the same bootstrap authenticates the same Desktop ticket.
    assert_eq!(
        receipt(config_call(&mut other, Q::BatchStatus { id }).await).state,
        S::Preview
    );
    assert_eq!(
        receipt(config_call(&mut desktop, Q::CancelBatch { id }).await).state,
        S::Cancelled
    );
    assert_eq!(
        receipt(config_call(&mut desktop, Q::ApplyBatch { id }).await).state,
        S::Cancelled
    );
    let id = Uuid::new_v4();
    receipt(
        config_call(
            &mut desktop,
            Q::PreviewBatch {
                id,
                revision,
                ids: ids[..2].to_vec(),
                patch: patch.clone(),
            },
        )
        .await,
    );
    let profile = portable();
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile,
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let r = receipt(config_call(&mut desktop, Q::ApplyBatch { id }).await);
    assert_eq!(r.state, S::Rejected);
    assert_eq!(r.reason, Some(E::Conflict));
    let C::Page { revision, .. } = config_call(
        &mut desktop,
        Q::Page {
            revision: None,
            offset: 0,
            folders: false,
        },
    )
    .await
    else {
        panic!()
    };
    let id = Uuid::new_v4();
    receipt(
        config_call(
            &mut desktop,
            Q::PreviewBatch {
                id,
                revision,
                ids: ids[..2].to_vec(),
                patch,
            },
        )
        .await,
    );
    let r = receipt(config_call(&mut desktop, Q::ApplyBatch { id }).await);
    assert_eq!(r.state, S::Applied);
    assert_ne!(r.revision, revision);
    let profile = portable();
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile,
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let again = receipt(config_call(&mut desktop, Q::ApplyBatch { id }).await);
    assert_eq!(again.state, S::Applied);
    assert_eq!(again.revision, r.revision);
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let Reply::Agent(agent::Reply::Grant {
        token: Some(token), ..
    }) = ok(desktop
        .request(Request::Agent {
            request: agent::Request::Grant {
                request_id: Uuid::new_v4(),
                scopes: vec![session_core::access::Scope {
                    target: session_core::access::Target::Connection { connection: c },
                    action: session_core::access::Action::Read,
                }],
                lifetime_ms: 10000,
            },
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut agent, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    assert_eq!(
        error(
            agent
                .request(Request::Config {
                    request: Q::BatchStatus { id }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    let Reply::ReadTicket { token, .. } = ok(desktop
        .request(Request::IssueRead {
            scopes: vec![c],
            lifetime_ms: 10000,
        })
        .await
        .unwrap())
    else {
        panic!()
    };
    let (mut observer, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    for request in [
        Q::BatchStatus { id },
        Q::ApplyBatch { id },
        Q::CancelBatch { id },
    ] {
        assert_eq!(
            error(observer.request(Request::Config { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    drop(observer);
    drop(agent);
    drop(other);
    fixture.stop(&mut desktop).await;
    drop(desktop);
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    assert!(matches!(
        config_call(&mut desktop, Q::BatchStatus { id }).await,
        C::Error { code: E::NotFound }
    ));
    fixture.stop(&mut desktop).await;
}
