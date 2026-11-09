use super::*;
use std::time::{Duration, Instant};

pub(super) struct Entry {
    owner: Uuid,
    created: Instant,
    original_revision: Uuid,
    ids: Vec<Uuid>,
    patch: config_store::BatchPatch,
    plan: Option<config_store::BatchPlan>,
    receipt: BatchReceipt,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_cache_owner_ttl_capacity_and_original_receipt() {
        let directory = std::env::temp_dir().join(format!(
            "shared-terminal-batch-cache-中文-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        {
            let mut state = State::open(directory.clone()).unwrap();
            let profiles: Vec<_> = (0..2)
                .map(|_| Profile {
                    id: Uuid::new_v4(),
                    folder_id: None,
                    name: "same synthetic".into(),
                    credential_ref: None,
                    settings: Settings::Ssh2 {
                        host: "example.invalid".into(),
                        port: 22,
                        username: "synthetic".into(),
                        auth: Auth::Password,
                        encoding: config_store::Encoding::Utf8,
                    },
                })
                .collect();
            for p in &profiles {
                state.store.put_profile(p.clone()).unwrap();
            }
            let owner = Uuid::new_v4();
            let revision = state.revision;
            let patch = config_store::BatchPatch {
                folder: config_store::BatchFolder::Keep {},
                encoding: Some(config_store::Encoding::Gbk),
                ssh_port: None,
                serial_baud: None,
            };
            let make = |id| ConfigRequest::PreviewBatch {
                id,
                revision,
                ids: profiles.iter().map(|p| p.id).collect(),
                patch: patch.clone(),
            };
            for _ in 0..32 {
                state.handle_batch(owner, make(Uuid::new_v4())).unwrap();
            }
            let id = state.batches[0].receipt.id;
            for request in [
                ConfigRequest::BatchStatus { id },
                ConfigRequest::ApplyBatch { id },
                ConfigRequest::CancelBatch { id },
                make(id),
            ] {
                assert!(matches!(
                    state.handle_batch(Uuid::new_v4(), request),
                    Err(ConfigError::NotFound)
                ));
            }
            assert!(matches!(
                state.handle_batch(owner, make(Uuid::new_v4())),
                Err(ConfigError::Capacity)
            ));
            state.batches[0].created = Instant::now() - Duration::from_secs(121);
            let ConfigReply::Batch { receipt } = state
                .handle_batch(owner, ConfigRequest::ApplyBatch { id })
                .unwrap()
            else {
                panic!()
            };
            assert_eq!(receipt.state, BatchState::Expired);
            assert_eq!(state.revision, revision);
            state.handle_batch(owner, make(Uuid::new_v4())).unwrap();
            assert_eq!(state.batches.len(), 32);
            let id = state.batches[0].receipt.id;
            state.batches[0].created = Instant::now() - Duration::from_secs(601);
            assert!(matches!(
                state.handle_batch(owner, ConfigRequest::BatchStatus { id }),
                Err(ConfigError::NotFound)
            ));
        }
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
impl State {
    pub(super) fn handle_batch(
        &mut self,
        owner: Uuid,
        request: ConfigRequest,
    ) -> Result<ConfigReply, ConfigError> {
        if owner.is_nil() || !request.validate() {
            return Err(ConfigError::Invalid);
        }
        let now = Instant::now();
        self.batches
            .retain(|entry| now.duration_since(entry.created) < Duration::from_secs(600));
        for entry in &mut self.batches {
            if entry.receipt.state == BatchState::Preview
                && now.duration_since(entry.created) >= Duration::from_secs(120)
            {
                entry.receipt.state = BatchState::Expired;
                entry.plan = None;
            }
        }
        let id = match &request {
            ConfigRequest::PreviewBatch { id, .. }
            | ConfigRequest::ApplyBatch { id }
            | ConfigRequest::BatchStatus { id }
            | ConfigRequest::CancelBatch { id } => *id,
            _ => return Err(ConfigError::Invalid),
        };
        if let Some(index) = self.batches.iter().position(|entry| entry.receipt.id == id) {
            let entry = &mut self.batches[index];
            if entry.owner != owner {
                return Err(ConfigError::NotFound);
            }
            match request {
                ConfigRequest::PreviewBatch {
                    revision,
                    ids,
                    patch,
                    ..
                } => {
                    if entry.original_revision != revision
                        || entry.ids != ids
                        || entry.patch != patch
                    {
                        return Err(ConfigError::Conflict);
                    }
                }
                ConfigRequest::ApplyBatch { .. } if entry.receipt.state == BatchState::Preview => {
                    let result = if self.revision != entry.original_revision {
                        Err(ConfigError::Conflict)
                    } else {
                        self.store
                            .apply_batch(entry.plan.as_ref().ok_or(ConfigError::Invalid)?)
                            .map_err(config_error)
                    };
                    match result {
                        Ok(()) => {
                            entry.receipt.state = BatchState::Applied;
                            if entry.receipt.changed_count > 0 {
                                self.revision = Uuid::new_v4();
                            }
                            entry.receipt.revision = self.revision;
                        }
                        Err(code) => {
                            entry.receipt.state = BatchState::Rejected;
                            entry.receipt.reason = Some(code);
                        }
                    }
                    entry.plan = None;
                }
                ConfigRequest::CancelBatch { .. } if entry.receipt.state == BatchState::Preview => {
                    entry.receipt.state = BatchState::Cancelled;
                    entry.plan = None;
                }
                _ => {}
            }
            return Ok(ConfigReply::Batch {
                receipt: entry.receipt.clone(),
            });
        }
        let ConfigRequest::PreviewBatch {
            revision,
            ids,
            patch,
            ..
        } = request
        else {
            return Err(ConfigError::NotFound);
        };
        if revision != self.revision {
            return Err(ConfigError::Conflict);
        }
        if self.batches.len() >= 32 {
            if let Some(index) = self.batches.iter().position(|entry| {
                matches!(
                    entry.receipt.state,
                    BatchState::Cancelled | BatchState::Expired
                )
            }) {
                self.batches.remove(index);
            } else {
                return Err(ConfigError::Capacity);
            }
        }
        let plan = self
            .store
            .preview_batch(&ids, &patch)
            .map_err(config_error)?;
        let receipt = BatchReceipt {
            id,
            revision,
            state: BatchState::Preview,
            reason: None,
            changed_count: plan.changed_count(),
            rows: plan.rows().to_vec(),
        };
        self.batches.push(Entry {
            owner,
            created: now,
            original_revision: revision,
            ids,
            patch,
            plan: Some(plan),
            receipt: receipt.clone(),
        });
        Ok(ConfigReply::Batch { receipt })
    }
}
