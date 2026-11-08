use super::*;
#[tokio::test]
async fn quick_commands_are_desktop_only_revision_bound_and_backed_up_without_execution() {
    use config::{ConfigReply as C, ConfigRequest as Q};
    let temp = ConfigTemp::new();
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
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
    let command = config_store::QuickCommand {
        id: Uuid::new_v4(),
        name: "synthetic-command".into(),
        group: "synthetic-group".into(),
        template: "literal {{word}} $HOME `unchanged`".into(),
        ending: config_store::CommandEnding::Crlf,
    };
    let C::QuickCommands { revision, .. } = config_call(&mut desktop, Q::QuickCommands {}).await
    else {
        panic!()
    };
    for request in [
        Q::QuickCommands {},
        Q::SaveQuickCommand {
            command: command.clone(),
            revision,
        },
        Q::DeleteQuickCommand {
            id: command.id,
            revision,
        },
    ] {
        assert_eq!(
            error(agent.request(Request::Config { request }).await.unwrap()),
            ErrorCode::PermissionDenied
        );
    }
    let C::QuickCommands {
        commands,
        revision: next,
    } = config_call(
        &mut desktop,
        Q::SaveQuickCommand {
            command: command.clone(),
            revision,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(commands, vec![command.clone()]);
    assert_ne!(next, revision);
    assert!(matches!(
        config_call(
            &mut desktop,
            Q::DeleteQuickCommand {
                id: command.id,
                revision
            }
        )
        .await,
        C::Error {
            code: config::ConfigError::Conflict
        }
    ));
    drop(agent);
    fixture.stop(&mut desktop).await;
    drop(desktop);
    let mut fixture = temp.start().await;
    let mut desktop = fixture.connect().await;
    assert!(
        matches!(ok(desktop.request(Request::List{}).await.unwrap()),Reply::Sessions(v) if v.is_empty())
    );
    let C::QuickCommands { commands, revision } =
        config_call(&mut desktop, Q::QuickCommands {}).await
    else {
        panic!()
    };
    assert_eq!(commands, vec![command.clone()]);
    let C::Artifact { artifact } = config_call(&mut desktop, Q::CreateBackup {}).await else {
        panic!()
    };
    config_call(
        &mut desktop,
        Q::DeleteQuickCommand {
            id: command.id,
            revision,
        },
    )
    .await;
    let C::BackupPreview {
        quick_commands,
        digest,
        current_revision: Some(current_revision),
        ..
    } = config_call(&mut desktop, Q::InspectBackup { id: artifact.id }).await
    else {
        panic!()
    };
    assert_eq!(quick_commands, 1);
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
    let C::QuickCommands { commands, .. } = config_call(&mut desktop, Q::QuickCommands {}).await
    else {
        panic!()
    };
    assert_eq!(commands, vec![command]);
    assert!(
        matches!(ok(desktop.request(Request::List{}).await.unwrap()),Reply::Sessions(v) if v.is_empty())
    );
    fixture.stop(&mut desktop).await;
}
