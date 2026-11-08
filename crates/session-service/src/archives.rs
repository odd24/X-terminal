use crate::config::{State, config_error, vault_error};
use config_store::{ConfigImage, Store};
use session_protocol::config::*;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::UNIX_EPOCH,
};
use uuid::Uuid;

pub struct Archives {
    root: PathBuf,
}
impl Archives {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn directory(&self) -> Result<PathBuf, ConfigError> {
        let path = self.root.join("artifacts");
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ConfigError::Storage),
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| ConfigError::Storage)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(ConfigError::Storage);
        }
        Ok(path)
    }
    fn filename(id: Uuid, kind: ArchiveKind) -> String {
        match kind {
            ArchiveKind::Backup => format!("backup-{id}.sqlite"),
            ArchiveKind::Export => format!("export-{id}.json"),
        }
    }
    fn path(&self, id: Uuid, kind: ArchiveKind) -> Result<PathBuf, ConfigError> {
        Ok(self.directory()?.join(Self::filename(id, kind)))
    }
    fn info(&self, id: Uuid, kind: ArchiveKind) -> Result<ArchiveInfo, ConfigError> {
        let path = self.path(id, kind)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| ConfigError::NotFound)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ConfigError::Corrupt);
        }
        Ok(ArchiveInfo {
            id,
            kind,
            filename: Self::filename(id, kind),
            bytes: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_millis().min(u64::MAX as u128) as u64)
                .unwrap_or(0),
        })
    }
    pub fn list(&self) -> Result<Vec<ArchiveInfo>, ConfigError> {
        let mut result = Vec::new();
        for entry in fs::read_dir(self.directory()?).map_err(|_| ConfigError::Storage)? {
            let entry = entry.map_err(|_| ConfigError::Storage)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let parsed = [
                ("backup-", ".sqlite", ArchiveKind::Backup),
                ("export-", ".json", ArchiveKind::Export),
            ]
            .into_iter()
            .find_map(|(prefix, suffix, kind)| {
                name.strip_prefix(prefix)?
                    .strip_suffix(suffix)
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .filter(|id| !id.is_nil() && Self::filename(*id, kind) == name)
                    .map(|id| (id, kind))
            });
            if let Some((id, kind)) = parsed {
                result.push(self.info(id, kind)?);
                if result.len() > 64 {
                    return Err(ConfigError::Capacity);
                }
            }
        }
        result.sort_by_key(|entry| (entry.modified_ms, entry.id));
        result.reverse();
        Ok(result)
    }
    fn reserve(&self, kind: ArchiveKind) -> Result<(Uuid, PathBuf), ConfigError> {
        if self.list()?.len() >= 64 {
            return Err(ConfigError::Capacity);
        }
        let id = Uuid::new_v4();
        Ok((id, self.path(id, kind)?))
    }
    fn publish(source: &std::path::Path, target: &std::path::Path) -> Result<(), ConfigError> {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileW(source.as_ptr(), target.as_ptr())
        } == 0
        {
            return Err(ConfigError::Storage);
        }
        Ok(())
    }
    pub fn create_backup(&self, state: &State) -> Result<ArchiveInfo, ConfigError> {
        if fs::metadata(state.store.path())
            .map_err(|_| ConfigError::Storage)?
            .len()
            > 64 * 1024 * 1024
        {
            return Err(ConfigError::Capacity);
        }
        let (id, path) = self.reserve(ArchiveKind::Backup)?;
        let partial = path.with_extension("partial");
        state.store.backup(&partial).map_err(config_error)?;
        Store::read_backup(&partial).map_err(config_error)?;
        Self::publish(&partial, &path)?;
        self.info(id, ArchiveKind::Backup)
    }
    pub fn export(&self, state: &State) -> Result<ArchiveInfo, ConfigError> {
        let (id, path) = self.reserve(ArchiveKind::Export)?;
        let snapshot = state.store.export().map_err(config_error)?;
        let partial = path.with_extension("partial");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|_| ConfigError::Storage)?;
        let mut writer = std::io::BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, &snapshot).map_err(|_| ConfigError::Storage)?;
        writer.flush().map_err(|_| ConfigError::Storage)?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|_| ConfigError::Storage)?;
        drop(writer);
        Self::publish(&partial, &path)?;
        self.info(id, ArchiveKind::Export)
    }
    fn read(&self, id: Uuid) -> Result<ConfigImage, ConfigError> {
        self.info(id, ArchiveKind::Backup)?;
        Store::read_backup(&self.path(id, ArchiveKind::Backup)?).map_err(
            |error| match config_error(error) {
                ConfigError::UnsupportedSchema => ConfigError::UnsupportedSchema,
                _ => ConfigError::Corrupt,
            },
        )
    }
    fn missing(image: &ConfigImage, state: Option<&State>) -> u32 {
        image
            .profiles
            .iter()
            .filter(|profile| {
                profile.credential_ref.is_some_and(|id| {
                    state.is_none_or(|state| !state.vault.contains(id).unwrap_or(false))
                })
            })
            .count() as u32
    }
    pub fn inspect(&self, id: Uuid, state: Option<&State>) -> Result<ConfigReply, ConfigError> {
        let image = self.read(id)?;
        Ok(ConfigReply::BackupPreview {
            quick_commands: image.quick_commands.len() as u32,
            workspaces: image.workspaces.len() as u32,
            id,
            digest: image.digest().map_err(config_error)?,
            folders: image.folders.len() as u32,
            profiles: image.profiles.len() as u32,
            host_keys: image.host_keys.len() as u32,
            preferences: image.preferences.clone(),
            missing_credentials: Self::missing(&image, state),
            current_revision: state.map(|state| state.revision),
            sample_profiles: image
                .profiles
                .iter()
                .take(16)
                .map(|profile| profile.name.clone())
                .collect(),
        })
    }
    pub fn restore(
        &self,
        id: Uuid,
        digest: &str,
        expected_revision: Uuid,
        state: &mut State,
    ) -> Result<ConfigReply, ConfigError> {
        if state.revision != expected_revision {
            return Err(ConfigError::Conflict);
        }
        let image = self.read(id)?;
        if image.digest().map_err(config_error)? != digest {
            return Err(ConfigError::Conflict);
        }
        let missing_credentials = Self::missing(&image, Some(state));
        let (safety_id, safety_path) = self.reserve(ArchiveKind::Backup)?;
        state
            .store
            .restore_image(&image, digest, &safety_path)
            .map_err(config_error)?;
        Ok(ConfigReply::Restored {
            revision: state.changed(),
            safety_backup: self.info(safety_id, ArchiveKind::Backup)?,
            missing_credentials,
        })
    }
    pub fn recover(&self, id: Uuid, digest: &str) -> Result<ConfigReply, ConfigError> {
        let image = self.read(id)?;
        if image.digest().map_err(config_error)? != digest {
            return Err(ConfigError::Conflict);
        }
        let count = fs::read_dir(&self.root)
            .map_err(|_| ConfigError::Storage)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("recovered-")
            })
            .count();
        if count >= 16 {
            return Err(ConfigError::Capacity);
        }
        let directory_id = Uuid::new_v4();
        let directory = self.root.join(format!("recovered-{directory_id}"));
        fs::create_dir(&directory).map_err(|_| ConfigError::Storage)?;
        let mut store = Store::open(&directory.join("config.sqlite")).map_err(config_error)?;
        store
            .restore_image(&image, digest, &directory.join("initial-state.sqlite"))
            .map_err(config_error)?;
        // Publish readiness only after the complete transaction; no vault copy is made.
        fs::write(directory.join("recovery.ready"), id.to_string())
            .map_err(|_| ConfigError::Storage)?;
        Ok(ConfigReply::Recovered {
            directory_id,
            missing_credentials: Self::missing(&image, None),
        })
    }
    pub fn delete(&self, id: Uuid, kind: ArchiveKind) -> Result<(), ConfigError> {
        self.info(id, kind)?;
        fs::remove_file(self.path(id, kind)?).map_err(|_| ConfigError::Storage)
    }
    fn credential_usage(&self, id: Uuid, state: &State) -> Result<(u32, u32), ConfigError> {
        if !state.vault.contains(id).map_err(vault_error)? {
            return Err(ConfigError::NotFound);
        }
        let count = |image: &ConfigImage| {
            image
                .profiles
                .iter()
                .filter(|profile| profile.credential_ref == Some(id))
                .count() as u32
        };
        let current = count(&state.store.image().map_err(config_error)?);
        let mut backups = 0;
        for entry in self.list()? {
            if entry.kind == ArchiveKind::Backup {
                // Fail closed on an unreadable managed backup; never guess that a reference is unused.
                backups += count(&self.read(entry.id)?);
            }
        }
        Ok((current, backups))
    }
    pub fn handle(
        &self,
        request: ConfigRequest,
        state: &mut Result<State, ConfigError>,
    ) -> Result<ConfigReply, ConfigError> {
        if !request.validate() {
            return Err(ConfigError::Invalid);
        }
        match request {
            ConfigRequest::CredentialsPage { revision, offset } => {
                let state = state.as_ref().map_err(|error| *error)?;
                if revision.is_some_and(|revision| revision != state.revision) {
                    return Err(ConfigError::Conflict);
                }
                let ids = state.vault.ids().map_err(vault_error)?;
                if offset as usize > ids.len() {
                    return Err(ConfigError::Invalid);
                }
                let image = state.store.image().map_err(config_error)?;
                let mut counts = std::collections::HashMap::<Uuid, u32>::new();
                for profile in image.profiles {
                    if let Some(id) = profile.credential_ref {
                        *counts.entry(id).or_default() += 1;
                    }
                }
                let next_offset = ((offset as usize) + 64 < ids.len()).then_some(offset + 64);
                Ok(ConfigReply::CredentialsPage {
                    revision: state.revision,
                    entries: ids
                        .into_iter()
                        .skip(offset as usize)
                        .take(64)
                        .map(|id| CredentialInfo {
                            id,
                            current_profiles: counts.get(&id).copied().unwrap_or(0),
                        })
                        .collect(),
                    next_offset,
                })
            }
            ConfigRequest::InspectCredential { id } => {
                let state = state.as_ref().map_err(|error| *error)?;
                let (current_profiles, backup_profiles) = self.credential_usage(id, state)?;
                Ok(ConfigReply::CredentialPreview {
                    id,
                    revision: state.revision,
                    current_profiles,
                    backup_profiles,
                })
            }
            ConfigRequest::ForgetCredential { id, revision } => {
                let state = state.as_mut().map_err(|error| *error)?;
                if revision != state.revision {
                    return Err(ConfigError::Conflict);
                }
                let (current, backups) = self.credential_usage(id, state)?;
                if current != 0 || backups != 0 {
                    return Err(ConfigError::InUse);
                }
                state.vault.delete(id).map_err(vault_error)?;
                Ok(ConfigReply::Updated {
                    revision: state.changed(),
                })
            }
            ConfigRequest::Archives {} => Ok(ConfigReply::Archives {
                entries: self.list()?,
            }),
            ConfigRequest::InspectBackup { id } => self.inspect(id, state.as_ref().ok()),
            ConfigRequest::RecoverBackup { id, digest } => self.recover(id, &digest),
            ConfigRequest::CreateBackup {} => Ok(ConfigReply::Artifact {
                artifact: self.create_backup(state.as_ref().map_err(|error| *error)?)?,
            }),
            ConfigRequest::ExportConfig {} => Ok(ConfigReply::Artifact {
                artifact: self.export(state.as_ref().map_err(|error| *error)?)?,
            }),
            ConfigRequest::RestoreBackup {
                id,
                digest,
                current_revision,
            } => self.restore(
                id,
                &digest,
                current_revision,
                state.as_mut().map_err(|error| *error)?,
            ),
            ConfigRequest::DeleteArchive { id, kind } => {
                self.delete(id, kind)?;
                let revision = state
                    .as_mut()
                    .map(|state| state.changed())
                    .unwrap_or_else(|_| Uuid::new_v4());
                Ok(ConfigReply::Updated { revision })
            }
            request => match state {
                Ok(state) => state.handle(request),
                Err(error) => Err(*error),
            },
        }
    }
}
