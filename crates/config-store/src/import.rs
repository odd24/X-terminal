use crate::{Error, Result, Store, require_current};
use config_model::*;
use rusqlite::{Transaction, TransactionBehavior, params};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub fn import_fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn problem(code: ImportProblemCode, row: Option<usize>) -> ImportProblem {
    ImportProblem {
        code,
        row: row.map(|row| row as u16),
    }
}
fn json_depth(value: &serde_json::Value, depth: usize) -> bool {
    depth <= 32
        && match value {
            serde_json::Value::Array(values) => values.iter().all(|v| json_depth(v, depth + 1)),
            serde_json::Value::Object(values) => values.values().all(|v| json_depth(v, depth + 1)),
            _ => true,
        }
}
/// No error contains file values, parser strings or caller-controlled field names.
pub fn parse_import(bytes: &[u8]) -> std::result::Result<Snapshot, ImportProblem> {
    use ImportProblemCode as C;
    if bytes.len() > 65536 {
        return Err(problem(C::Capacity, None));
    }
    if std::str::from_utf8(bytes).is_err() || bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(problem(C::Encoding, None));
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| {
        problem(
            if e.to_string().contains("recursion limit exceeded") {
                C::Depth
            } else {
                C::MalformedJson
            },
            None,
        )
    })?;
    if !json_depth(&value, 0) {
        return Err(problem(C::Depth, None));
    }
    let version = value
        .get("format_version")
        .ok_or_else(|| problem(C::MissingVersion, None))?;
    if version.as_u64() != Some(1) {
        return Err(problem(C::UnsupportedVersion, None));
    }
    let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(|e| {
        let text = e.to_string();
        problem(
            if text.starts_with("unknown field") {
                C::UnsupportedField
            } else if text.starts_with("duplicate field") {
                C::DuplicateField
            } else {
                C::InvalidShape
            },
            None,
        )
    })?;
    if snapshot.folders.len() > 32
        || snapshot.profiles.len() > 64
        || snapshot.folders.len() + snapshot.profiles.len() == 0
    {
        return Err(problem(C::Capacity, None));
    }
    let mut ids = HashSet::new();
    for (row, folder) in snapshot.folders.iter().enumerate() {
        if folder.id.is_nil() || !valid_text(&folder.name, 256) {
            return Err(problem(C::InvalidShape, Some(row)));
        }
        if !ids.insert(folder.id) {
            return Err(problem(C::DuplicateId, Some(row)));
        }
        // Required nullable references; omitted targets must not silently mean root.
        if value["folders"][row].get("parent_id").is_none() {
            return Err(problem(C::InvalidShape, Some(row)));
        }
        let mut seen = HashSet::from([folder.id]);
        let mut parent = folder.parent_id;
        let mut depth = 1;
        while let Some(id) = parent {
            if !seen.insert(id) {
                return Err(problem(C::FolderCycle, Some(row)));
            }
            depth += 1;
            if depth > 16 {
                return Err(problem(C::Depth, Some(row)));
            }
            parent = snapshot
                .folders
                .iter()
                .find(|f| f.id == id)
                .ok_or_else(|| problem(C::FolderReference, Some(row)))?
                .parent_id;
        }
    }
    for (row, profile) in snapshot.profiles.iter().enumerate() {
        if !ids.insert(profile.id) {
            return Err(problem(C::DuplicateId, Some(row)));
        }
        if value["profiles"][row].get("folder_id").is_none()
            || matches!(profile.settings, Settings::Serial { .. })
                && value["profiles"][row]["settings"]
                    .get("rts_on_open")
                    .is_none()
        {
            return Err(problem(C::InvalidShape, Some(row)));
        }
        let full = Profile {
            id: profile.id,
            folder_id: profile.folder_id,
            name: profile.name.clone(),
            credential_ref: None,
            settings: profile.settings.clone(),
        };
        if full.validate().is_err() {
            return Err(problem(C::InvalidProfile, Some(row)));
        }
        if profile
            .folder_id
            .is_some_and(|id| !snapshot.folders.iter().any(|f| f.id == id))
        {
            return Err(problem(C::FolderReference, Some(row)));
        }
    }
    Ok(snapshot)
}
pub struct ImportPlan {
    before_digest: String,
    after_digest: String,
    folders: Vec<Folder>,
    profiles: Vec<(Profile, bool)>,
    diff: ImportDiff,
}
impl ImportPlan {
    pub fn diff(&self) -> &ImportDiff {
        &self.diff
    }
}
pub enum ImportPreview {
    Ready(ImportPlan),
    Rejected(ImportProblem),
}
fn same_protocol(a: &Settings, b: &Settings) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
}
fn credential_endpoint_unchanged(a: &Settings, b: &Settings) -> bool {
    let mut normalized = a.clone();
    match (&mut normalized, b) {
        (
            Settings::Ssh2 { encoding, .. }
            | Settings::Ssh1 { encoding, .. }
            | Settings::Serial { encoding, .. },
            Settings::Ssh2 { encoding: to, .. }
            | Settings::Ssh1 { encoding: to, .. }
            | Settings::Serial { encoding: to, .. },
        ) => *encoding = to.clone(),
    }
    normalized == *b
}
impl Store {
    pub fn preview_import(
        &self,
        snapshot: &Snapshot,
        policy: ImportPolicy,
    ) -> Result<ImportPreview> {
        // Public callers cannot bypass strict source validation with a handcrafted Snapshot.
        let bytes = serde_json::to_vec(snapshot)?;
        if let Err(issue) = parse_import(&bytes) {
            return Ok(ImportPreview::Rejected(issue));
        }
        let tx = self.connection.unchecked_transaction()?;
        require_current(&tx)?;
        let mut image = self.image_in_transaction()?;
        let before_digest = image.digest()?;
        let mut used: HashSet<_> = image
            .folders
            .iter()
            .map(|f| f.id)
            .chain(image.profiles.iter().map(|p| p.id))
            .collect();
        used.extend(
            snapshot
                .folders
                .iter()
                .map(|f| f.id)
                .chain(snapshot.profiles.iter().map(|p| p.id)),
        );
        let mut mapping = HashMap::new();
        for id in snapshot
            .folders
            .iter()
            .map(|f| f.id)
            .chain(snapshot.profiles.iter().map(|p| p.id))
        {
            let next = if policy == ImportPolicy::NewIds {
                let mut next = None;
                for _ in 0..16 {
                    let candidate = Uuid::new_v4();
                    if used.insert(candidate) {
                        next = Some(candidate);
                        break;
                    }
                }
                next.ok_or(Error::Invalid("import identity budget"))?
            } else {
                id
            };
            mapping.insert(id, next);
        }
        let mut folders = Vec::new();
        let mut profiles = Vec::new();
        let mut diff = ImportDiff::default();
        for (row, source) in snapshot.folders.iter().enumerate() {
            let after = Folder {
                id: mapping[&source.id],
                parent_id: source.parent_id.map(|id| mapping[&id]),
                name: source.name.clone(),
            };
            let before = image.folders.iter().find(|f| f.id == after.id).cloned();
            if image.profiles.iter().any(|p| p.id == after.id) {
                return Ok(ImportPreview::Rejected(problem(
                    ImportProblemCode::Conflict,
                    Some(row),
                )));
            }
            if let Some(old) = &before {
                if policy == ImportPolicy::Reject {
                    return Ok(ImportPreview::Rejected(problem(
                        ImportProblemCode::Conflict,
                        Some(row),
                    )));
                }
                if *old != after {
                    return Ok(ImportPreview::Rejected(problem(
                        ImportProblemCode::FolderConflict,
                        Some(row),
                    )));
                }
            } else {
                folders.push(after.clone());
                image.folders.push(after.clone());
            }
            diff.folders.push(ImportFolderDiff {
                source_id: source.id,
                before,
                after,
            });
        }
        for (row, source) in snapshot.profiles.iter().enumerate() {
            let id = mapping[&source.id];
            if image.folders.iter().any(|f| f.id == id) {
                return Ok(ImportPreview::Rejected(problem(
                    ImportProblemCode::Conflict,
                    Some(row),
                )));
            }
            let old = image.profiles.iter().find(|p| p.id == id).cloned();
            if let Some(old) = &old {
                let code = if policy == ImportPolicy::Reject {
                    Some(ImportProblemCode::Conflict)
                } else if !same_protocol(&old.settings, &source.settings) {
                    Some(ImportProblemCode::ProtocolConflict)
                } else if old.credential_ref.is_some()
                    && !credential_endpoint_unchanged(&old.settings, &source.settings)
                {
                    Some(ImportProblemCode::CredentialEndpoint)
                } else {
                    None
                };
                if let Some(code) = code {
                    return Ok(ImportPreview::Rejected(problem(code, Some(row))));
                }
            }
            let after = Profile {
                id,
                folder_id: source.folder_id.map(|id| mapping[&id]),
                name: source.name.clone(),
                credential_ref: old.as_ref().and_then(|p| p.credential_ref),
                settings: source.settings.clone(),
            };
            diff.profiles.push(ImportProfileDiff {
                source_id: source.id,
                before: old.as_ref().map(Into::into),
                after: (&after).into(),
                credential_preserved: after.credential_ref.is_some(),
            });
            image.profiles.retain(|p| p.id != id);
            image.profiles.push(after.clone());
            profiles.push((after, old.is_some()));
        }
        image
            .folders
            .sort_by(|a, b| (&a.name, a.id).cmp(&(&b.name, b.id)));
        image
            .profiles
            .sort_by(|a, b| (&a.name, a.id).cmp(&(&b.name, b.id)));
        image.validate()?;
        let after_digest = image.digest()?;
        tx.commit()?;
        Ok(ImportPreview::Ready(ImportPlan {
            before_digest,
            after_digest,
            folders,
            profiles,
            diff,
        }))
    }
    pub fn apply_import(&self, plan: &ImportPlan) -> Result<()> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_current(&tx)?;
        if self.image_in_transaction()?.digest()? != plan.before_digest {
            return Err(Error::Conflict);
        }
        tx.execute_batch("PRAGMA defer_foreign_keys=ON;")?;
        for f in &plan.folders {
            if tx.execute(
                "INSERT INTO folders(id,parent_id,name) VALUES(?1,?2,?3)",
                params![
                    f.id.to_string(),
                    f.parent_id.map(|id| id.to_string()),
                    f.name
                ],
            )? != 1
            {
                return Err(Error::Conflict);
            }
        }
        for (p, replace) in &plan.profiles {
            let count = if *replace {
                tx.execute(
                    "UPDATE profiles SET folder_id=?1,name=?2,settings=?3 WHERE id=?4",
                    params![
                        p.folder_id.map(|id| id.to_string()),
                        p.name,
                        serde_json::to_string(&p.settings)?,
                        p.id.to_string()
                    ],
                )?
            } else {
                tx.execute("INSERT INTO profiles(id,folder_id,name,credential_ref,settings) VALUES(?1,?2,?3,NULL,?4)",params![p.id.to_string(),p.folder_id.map(|id|id.to_string()),p.name,serde_json::to_string(&p.settings)?])?
            };
            if count != 1 {
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
