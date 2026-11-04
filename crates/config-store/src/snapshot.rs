use crate::{
    Error, Result, SCHEMA_VERSION, Store, check, host_keys, metadata, open_database,
    validate_folder,
};
use config_model::{Folder, HostKey, Profile};
use rusqlite::{OpenFlags, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Internal backup image: credential references/public host keys, never credential material.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigImage {
    pub folders: Vec<Folder>,
    pub profiles: Vec<Profile>,
    pub host_keys: Vec<HostKey>,
}
impl ConfigImage {
    pub fn digest(&self) -> Result<String> {
        struct HashWriter(Sha256);
        impl Write for HashWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.update(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut writer = HashWriter(Sha256::new());
        serde_json::to_writer(&mut writer, self)?;
        Ok(writer
            .0
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
    fn validate(&self) -> Result<()> {
        if self.folders.len() > 1024 || self.profiles.len() > 10000 || self.host_keys.len() > 1024 {
            return Err(Error::Invalid("backup limits"));
        }
        let mut folders = HashSet::new();
        for folder in &self.folders {
            if !folders.insert(folder.id) {
                return Err(Error::Corrupt);
            }
            validate_folder(folder, &self.folders)?;
        }
        let mut profiles = HashSet::new();
        for profile in &self.profiles {
            profile.validate()?;
            if !profiles.insert(profile.id)
                || profile.folder_id.is_some_and(|id| !folders.contains(&id))
            {
                return Err(Error::Corrupt);
            }
        }
        let mut keys = HashSet::new();
        let mut endpoint_counts = std::collections::HashMap::new();
        for key in &self.host_keys {
            key.validate()?;
            let endpoint = key.endpoint.canonical()?;
            if endpoint != key.endpoint {
                return Err(Error::Corrupt);
            }
            let identity = (
                format!("{:?}", endpoint.protocol),
                endpoint.host,
                endpoint.port,
            );
            let count = endpoint_counts.entry(identity.clone()).or_insert(0usize);
            *count += 1;
            if *count > 16 || !keys.insert((identity, key.algorithm.clone())) {
                return Err(Error::Corrupt);
            }
        }
        Ok(())
    }
}
impl Store {
    pub fn image(&self) -> Result<ConfigImage> {
        let tx = self.connection.unchecked_transaction()?;
        check(&tx)?;
        if metadata(&tx)?.1 != SCHEMA_VERSION {
            return Err(Error::Schema);
        }
        let image = ConfigImage {
            folders: self.folders()?,
            profiles: self.profiles()?,
            host_keys: host_keys::read(&tx)?,
        };
        image.validate()?;
        tx.commit()?;
        Ok(image)
    }
    pub fn read_backup(path: &Path) -> Result<ConfigImage> {
        if !std::fs::symlink_metadata(path)?.is_file()
            || std::fs::symlink_metadata(path)?.file_type().is_symlink()
            || std::fs::metadata(path)?.len() > 64 * 1024 * 1024
        {
            return Err(Error::Invalid("backup file"));
        }
        let connection = open_database(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let source = Self {
            connection,
            path: path.to_owned(),
            migration_backup: None,
        };
        source.image()
    }
    /// Validate before transactional replacement; retain the exact old database in a new safety copy.
    pub fn restore_image(
        &mut self,
        image: &ConfigImage,
        expected_digest: &str,
        safety_copy: &Path,
    ) -> Result<PathBuf> {
        image.validate()?;
        if image.digest()? != expected_digest {
            return Err(Error::Conflict);
        }
        let path = self.path.clone();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        check(&tx)?;
        if metadata(&tx)?.1 != SCHEMA_VERSION {
            return Err(Error::Schema);
        }
        // Hold the writer reservation while a second connection snapshots the exact old state.
        let source = open_database(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        drop(
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(safety_copy)?,
        );
        source.backup(
            rusqlite::MAIN_DB,
            safety_copy,
            None::<fn(rusqlite::backup::Progress)>,
        )?;
        drop(source);
        tx.execute_batch("PRAGMA defer_foreign_keys=ON; DELETE FROM profiles; DELETE FROM folders; DELETE FROM host_keys;")?;
        for folder in &image.folders {
            tx.execute(
                "INSERT INTO folders VALUES(?1,?2,?3)",
                params![
                    folder.id.to_string(),
                    folder.parent_id.map(|id| id.to_string()),
                    folder.name
                ],
            )?;
        }
        for profile in &image.profiles {
            tx.execute(
                "INSERT INTO profiles VALUES(?1,?2,?3,?4,?5)",
                params![
                    profile.id.to_string(),
                    profile.folder_id.map(|id| id.to_string()),
                    profile.name,
                    profile.credential_ref.map(|id| id.to_string()),
                    serde_json::to_string(&profile.settings)?
                ],
            )?;
        }
        for key in &image.host_keys {
            let endpoint = key.endpoint.canonical()?;
            tx.execute(
                "INSERT INTO host_keys VALUES(?1,?2,?3,?4,?5)",
                params![
                    match endpoint.protocol {
                        config_model::HostProtocol::Ssh1 => "ssh1",
                        config_model::HostProtocol::Ssh2 => "ssh2",
                    },
                    endpoint.host,
                    endpoint.port,
                    key.algorithm,
                    key.key
                ],
            )?;
        }
        tx.commit()?;
        Ok(safety_copy.to_owned())
    }
}
