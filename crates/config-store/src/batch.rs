use crate::{Error, Result, Store, require_current};
use config_model::{BatchDiff, BatchPatch, Profile, valid_batch_ids};
use rusqlite::{Transaction, TransactionBehavior, params};
use uuid::Uuid;

/// Only constructed by a validated consistent snapshot; full profiles remain private.
pub struct BatchPlan {
    before_digest: String,
    after_digest: String,
    profiles: Vec<Profile>,
    rows: Vec<BatchDiff>,
}
impl BatchPlan {
    pub fn rows(&self) -> &[BatchDiff] {
        &self.rows
    }
    pub fn changed_count(&self) -> u32 {
        self.rows
            .iter()
            .filter(|row| row.before != row.after)
            .count() as u32
    }
}
impl Store {
    pub fn preview_batch(&self, ids: &[Uuid], patch: &BatchPatch) -> Result<BatchPlan> {
        if !valid_batch_ids(ids) {
            return Err(Error::Invalid("batch selection"));
        }
        patch.validate()?;
        let tx = self.connection.unchecked_transaction()?;
        require_current(&tx)?;
        let mut image = self.image_in_transaction()?;
        if let config_model::BatchFolder::Move {
            folder_id: Some(id),
        } = patch.folder
            && !image.folders.iter().any(|folder| folder.id == id)
        {
            return Err(Error::NotFound);
        }
        let before_digest = image.digest()?;
        let mut rows = Vec::new();
        let mut profiles = Vec::new();
        for id in ids {
            let before = image
                .profiles
                .iter_mut()
                .find(|p| p.id == *id)
                .ok_or(Error::NotFound)?;
            let after = patch.apply(before)?;
            rows.push(BatchDiff {
                before: (&*before).into(),
                after: (&after).into(),
            });
            *before = after.clone();
            profiles.push(after);
        }
        image.validate()?;
        let after_digest = image.digest()?;
        tx.commit()?;
        Ok(BatchPlan {
            before_digest,
            after_digest,
            profiles,
            rows,
        })
    }
    pub fn apply_batch(&self, plan: &BatchPlan) -> Result<()> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        if self.image_in_transaction()?.digest()? != plan.before_digest {
            return Err(Error::Conflict);
        }
        for profile in &plan.profiles {
            if tx.execute(
                "UPDATE profiles SET folder_id=?1,settings=?2 WHERE id=?3",
                params![
                    profile.folder_id.map(|id| id.to_string()),
                    serde_json::to_string(&profile.settings)?,
                    profile.id.to_string()
                ],
            )? != 1
            {
                return Err(Error::Conflict);
            }
        }
        if self.image_in_transaction()?.digest()? != plan.after_digest {
            return Err(Error::Conflict);
        }
        tx.commit()?;
        Ok(())
    }
}
