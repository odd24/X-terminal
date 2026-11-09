use super::*;
use std::time::{Duration, Instant};
pub(super) struct Entry {
    owner: Uuid,
    created: Instant,
    original_revision: Uuid,
    fingerprint: String,
    plan: Option<config_store::ImportPlan>,
    receipt: ImportReceipt,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_owner_ttl_capacity_and_no_replayed_mapping() {
        let directory = std::env::temp_dir().join(format!(
            "shared-terminal-import-cache-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        {
            let mut state = State::open(directory.clone()).unwrap();
            let owner = Uuid::new_v4();
            let revision = state.revision;
            let document=serde_json::json!({"format_version":1,"folders":[],"profiles":[{"id":Uuid::new_v4(),"folder_id":null,"name":"synthetic","settings":{"protocol":"ssh2","host":"example.invalid","port":22,"username":"synthetic","auth":"password","encoding":"utf8"}}]}).to_string();
            let make = |id| ConfigRequest::PreviewImport {
                id,
                revision,
                policy: config_store::ImportPolicy::NewIds,
                document: session_protocol::Sensitive::new(document.clone()),
            };
            for _ in 0..8 {
                state.handle_import(owner, make(Uuid::new_v4())).unwrap();
            }
            let id = state.imports[0].receipt.id;
            let mapped = state.imports[0].receipt.diff.profiles[0].after.id;
            let ConfigReply::Import { receipt } = state.handle_import(owner, make(id)).unwrap()
            else {
                panic!()
            };
            assert_eq!(receipt.diff.profiles[0].after.id, mapped);
            for request in [
                ConfigRequest::ImportStatus { id },
                ConfigRequest::ApplyImport { id },
                ConfigRequest::CancelImport { id },
                make(id),
            ] {
                assert!(matches!(
                    state.handle_import(Uuid::new_v4(), request),
                    Err(ConfigError::NotFound)
                ));
            }
            assert!(matches!(
                state.handle_import(owner, make(Uuid::new_v4())),
                Err(ConfigError::Capacity)
            ));
            state.imports[0].created = Instant::now() - Duration::from_secs(121);
            let ConfigReply::Import { receipt } = state
                .handle_import(owner, ConfigRequest::ApplyImport { id })
                .unwrap()
            else {
                panic!()
            };
            assert_eq!(receipt.state, BatchState::Expired);
            assert_eq!(state.store.profiles().unwrap().len(), 0);
            state.handle_import(owner, make(Uuid::new_v4())).unwrap();
            assert_eq!(state.imports.len(), 8);
            let id = state.imports[0].receipt.id;
            state.imports[0].created = Instant::now() - Duration::from_secs(601);
            assert!(matches!(
                state.handle_import(owner, ConfigRequest::ImportStatus { id }),
                Err(ConfigError::NotFound)
            ));
            let rejected = Uuid::new_v4();
            state
                .handle_import(
                    owner,
                    ConfigRequest::PreviewImport {
                        id: rejected,
                        revision,
                        policy: config_store::ImportPolicy::Reject,
                        document: session_protocol::Sensitive::new("{}".into()),
                    },
                )
                .unwrap();
            state.handle_import(owner, make(Uuid::new_v4())).unwrap();
            assert_eq!(state.imports.len(), 8);
            assert!(matches!(
                state.handle_import(owner, ConfigRequest::ImportStatus { id: rejected }),
                Err(ConfigError::NotFound)
            ));
        }
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
impl State {
    pub(super) fn handle_import(
        &mut self,
        owner: Uuid,
        request: ConfigRequest,
    ) -> Result<ConfigReply, ConfigError> {
        if owner.is_nil() || !request.validate() {
            return Err(ConfigError::Invalid);
        }
        let now = Instant::now();
        self.imports
            .retain(|entry| now.duration_since(entry.created) < Duration::from_secs(600));
        for entry in &mut self.imports {
            if entry.receipt.state == BatchState::Preview
                && now.duration_since(entry.created) >= Duration::from_secs(120)
            {
                entry.receipt.state = BatchState::Expired;
                entry.plan = None;
            }
        }
        let id = match &request {
            ConfigRequest::PreviewImport { id, .. }
            | ConfigRequest::ApplyImport { id }
            | ConfigRequest::ImportStatus { id }
            | ConfigRequest::CancelImport { id } => *id,
            _ => return Err(ConfigError::Invalid),
        };
        if let Some(entry) = self.imports.iter_mut().find(|entry| entry.receipt.id == id) {
            if owner != entry.owner {
                return Err(ConfigError::NotFound);
            }
            match request {
                ConfigRequest::PreviewImport {
                    revision,
                    policy,
                    document,
                    ..
                } => {
                    if revision != entry.original_revision
                        || policy != entry.receipt.policy
                        || config_store::import_fingerprint(document.expose().as_bytes())
                            != entry.fingerprint
                    {
                        return Err(ConfigError::Conflict);
                    }
                }
                ConfigRequest::ApplyImport { .. } if entry.receipt.state == BatchState::Preview => {
                    let result = if self.revision != entry.original_revision {
                        Err(ConfigError::Conflict)
                    } else {
                        self.store
                            .apply_import(entry.plan.as_ref().ok_or(ConfigError::Invalid)?)
                            .map_err(config_error)
                    };
                    match result {
                        Ok(()) => {
                            self.revision = Uuid::new_v4();
                            entry.receipt.revision = self.revision;
                            entry.receipt.state = BatchState::Applied;
                        }
                        Err(code) => {
                            entry.receipt.state = BatchState::Rejected;
                            entry.receipt.reason = Some(code);
                        }
                    }
                    entry.plan = None;
                }
                ConfigRequest::CancelImport { .. }
                    if entry.receipt.state == BatchState::Preview =>
                {
                    entry.receipt.state = BatchState::Cancelled;
                    entry.plan = None;
                }
                _ => {}
            }
            return Ok(ConfigReply::Import {
                receipt: entry.receipt.clone(),
            });
        }
        let ConfigRequest::PreviewImport {
            revision,
            policy,
            document,
            ..
        } = request
        else {
            return Err(ConfigError::NotFound);
        };
        if revision != self.revision {
            return Err(ConfigError::Conflict);
        }
        if self.imports.len() >= 8 {
            if let Some(index) = self.imports.iter().position(|entry| {
                matches!(
                    entry.receipt.state,
                    BatchState::Expired | BatchState::Cancelled
                ) || entry.receipt.problem.is_some()
            }) {
                self.imports.remove(index);
            } else {
                return Err(ConfigError::Capacity);
            }
        }
        let fingerprint = config_store::import_fingerprint(document.expose().as_bytes());
        let preview = match config_store::parse_import(document.expose().as_bytes()) {
            Ok(snapshot) => self
                .store
                .preview_import(&snapshot, policy)
                .map_err(config_error)?,
            Err(issue) => config_store::ImportPreview::Rejected(issue),
        };
        let (plan, problem, diff) = match preview {
            config_store::ImportPreview::Ready(plan) => {
                let diff = plan.diff().clone();
                (Some(plan), None, diff)
            }
            config_store::ImportPreview::Rejected(issue) => {
                (None, Some(issue), config_store::ImportDiff::default())
            }
        };
        let receipt = ImportReceipt {
            id,
            revision,
            state: if problem.is_some() {
                BatchState::Rejected
            } else {
                BatchState::Preview
            },
            policy,
            problem,
            reason: None,
            diff,
        };
        self.imports.push(Entry {
            owner,
            created: now,
            original_revision: revision,
            fingerprint,
            plan,
            receipt: receipt.clone(),
        });
        Ok(ConfigReply::Import { receipt })
    }
}
