use super::*;
#[tokio::test]
async fn workspace_metadata_is_desktop_only_revision_bound_backed_up_and_never_connects() {
    use config::{ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    let profile = portable();
    config_call(
        &mut desktop,
        Q::SaveProfile {
            profile: profile.clone(),
            credential: config::CredentialEdit::Keep {},
        },
    )
    .await;
    let c = reference(ok(desktop
        .request(Request::CreateFixture {})
        .await
        .unwrap()));
    let (_, token) = issue(
        &mut desktop,
        vec![Scope {
            target: Target::Connection { connection: c },
            action: Action::Read,
        }],
        10000,
    )
    .await;
    let (mut agent, _) = Client::connect(&fixture.instance, token.expose(), fixture.pid)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let tab = Uuid::new_v4();
    let second_tab = Uuid::new_v4();
    let workspace = config_store::Workspace {
        id,
        name: "synthetic workspace".into(),
        groups: vec![],
        tabs: vec![
            config_store::WorkspaceTab {
                id: tab,
                profile_id: profile.id,
                group_id: None,
            },
            config_store::WorkspaceTab {
                id: second_tab,
                profile_id: profile.id,
                group_id: None,
            },
        ],
        selected_tab: Some(tab),
        navigation_open: true,
        split: Some(config_store::WorkspaceSplit {
            direction: config_store::WorkspaceSplitDirection::Vertical,
            tabs: [tab, second_tab],
        }),
    };
    let C::Workspaces { revision, .. } = config_call(&mut desktop, Q::Workspaces {}).await else {
        panic!()
    };
    for request in [
        Q::Workspaces {},
        Q::SaveWorkspace {
            workspace: workspace.clone(),
            revision,
        },
        Q::DeleteWorkspace { id, revision },
    ] {
        assert_eq!(
            error(agent.request(Request::Config { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let C::Workspaces {
        workspaces,
        revision: next,
    } = config_call(
        &mut desktop,
        Q::SaveWorkspace {
            workspace: workspace.clone(),
            revision,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(workspaces, vec![workspace.clone()]);
    assert_ne!(next, revision);
    assert!(matches!(
        config_call(&mut desktop, Q::DeleteWorkspace { id, revision }).await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    let text = serde_json::to_string(&workspace).unwrap();
    assert!(!text.contains(&c.connection_id.0.to_string()));
    for key in [
        "connection_id",
        "generation",
        "service_id",
        "request_id",
        "password",
        "token",
        "credential",
    ] {
        assert!(!text.contains(key));
    }
    drop(agent);
    fixture.stop(&mut desktop).await;
    drop(desktop);
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()),Reply::Sessions(v) if v.is_empty())
    );
    let C::Workspaces { workspaces, .. } = config_call(&mut desktop, Q::Workspaces {}).await else {
        panic!()
    };
    assert_eq!(workspaces, vec![workspace.clone()]);
    let C::Artifact { artifact } = config_call(&mut desktop, Q::CreateBackup {}).await else {
        panic!()
    };
    let C::Workspaces { revision, .. } = config_call(&mut desktop, Q::Workspaces {}).await else {
        panic!()
    };
    config_call(&mut desktop, Q::DeleteWorkspace { id, revision }).await;
    let C::BackupPreview {
        workspaces,
        digest,
        current_revision: Some(current_revision),
        ..
    } = config_call(&mut desktop, Q::InspectBackup { id: artifact.id }).await
    else {
        panic!()
    };
    assert_eq!(workspaces, 1);
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::RestoreBackup {
                id: artifact.id,
                digest,
                current_revision
            }
        )
        .await,
        C::Restored { .. }
    ));
    let C::Workspaces { workspaces, .. } = config_call(&mut desktop, Q::Workspaces {}).await else {
        panic!()
    };
    assert_eq!(workspaces, vec![workspace]);
    assert!(
        matches!(ok(desktop.request(Request::List {}).await.unwrap()),Reply::Sessions(v) if v.is_empty())
    );
    fixture.stop(&mut desktop).await;
}
