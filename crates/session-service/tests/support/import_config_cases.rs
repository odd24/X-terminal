use super::*;
use config::{
    BatchState as S, ConfigError as E, ConfigReply as C, ConfigRequest as Q, ImportReceipt,
};
fn receipt(r: C) -> ImportReceipt {
    match r {
        C::Import { receipt } => receipt,
        _ => panic!("expected import reply"),
    }
}
#[tokio::test]
async fn import_config_roundtrip_original_owner_once_conflict_cancel_and_restart() {
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let profile = portable();
    let source = config_store::Snapshot {
        format_version: 1,
        folders: vec![],
        profiles: vec![profile.clone()],
    };
    let document = serde_json::to_string(&source).unwrap();
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
    let make = |id| Q::PreviewImport {
        id,
        revision,
        policy: config_store::ImportPolicy::NewIds,
        document: Sensitive::new(document.clone()),
    };
    let cancelled = Uuid::new_v4();
    receipt(config_call(&mut desktop, make(cancelled)).await);
    assert_eq!(
        receipt(config_call(&mut desktop, Q::CancelImport { id: cancelled }).await).state,
        S::Cancelled
    );
    assert_eq!(
        receipt(config_call(&mut desktop, Q::ApplyImport { id: cancelled }).await).state,
        S::Cancelled
    );
    let id = Uuid::new_v4();
    let preview = receipt(config_call(&mut desktop, make(id)).await);
    let mapped = preview.diff.profiles[0].after.id;
    assert_ne!(mapped, profile.id);
    let again = receipt(config_call(&mut desktop, make(id)).await);
    assert_eq!(again.diff.profiles[0].after.id, mapped);
    let applied = receipt(config_call(&mut desktop, Q::ApplyImport { id }).await);
    assert_eq!(applied.state, S::Applied);
    let mut other = fixture.connect().await;
    assert_eq!(
        receipt(config_call(&mut other, Q::ImportStatus { id }).await).state,
        S::Applied
    );
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile: portable(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let applied_again = receipt(config_call(&mut desktop, Q::ApplyImport { id }).await);
    assert_eq!(applied_again.revision, applied.revision);
    let C::Page {
        revision, profiles, ..
    } = config_call(
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
    assert_eq!(profiles.len(), 2);
    assert!(
        profiles
            .iter()
            .any(|p| p.id == mapped && p.credential_ref.is_none())
    );
    let bad = receipt(
        config_call(
            &mut desktop,
            Q::PreviewImport {
                id: Uuid::new_v4(),
                revision,
                policy: config_store::ImportPolicy::Reject,
                document: Sensitive::new("{\"format_version\":2}".into()),
            },
        )
        .await,
    );
    assert_eq!(bad.state, S::Rejected);
    assert_eq!(
        bad.problem.unwrap().code,
        config_store::ImportProblemCode::UnsupportedVersion
    );
    let conflict = Uuid::new_v4();
    receipt(
        config_call(
            &mut desktop,
            Q::PreviewImport {
                id: conflict,
                revision,
                policy: config_store::ImportPolicy::NewIds,
                document: Sensitive::new(document),
            },
        )
        .await,
    );
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile: portable(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    assert_eq!(
        receipt(config_call(&mut desktop, Q::ApplyImport { id: conflict }).await).reason,
        Some(E::Conflict)
    );
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
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
        Q::ImportStatus { id },
        Q::ApplyImport { id },
        Q::CancelImport { id },
    ] {
        assert_eq!(
            error(observer.request(Request::Config { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
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
                    request: Q::ImportStatus { id }
                })
                .await
                .unwrap()
        ),
        ErrorCode::PermissionDenied
    );
    drop(agent);
    drop(observer);
    drop(other);
    fixture.stop(&mut desktop).await;
    drop(desktop);
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    assert!(matches!(
        config_call(&mut desktop, Q::ImportStatus { id }).await,
        C::Error { code: E::NotFound }
    ));
    fixture.stop(&mut desktop).await;
}
