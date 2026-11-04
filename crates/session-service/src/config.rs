//! One blocking actor owns configuration and protected credentials. No secret read RPC.
use config_store::{Auth, Profile, Settings, Store};
use credential_vault::{Secret, Vault};
use session_protocol::config::*;
use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::fs::OpenOptionsExt,
    path::PathBuf,
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

struct Message {
    request: ConfigRequest,
    reply: oneshot::Sender<ConfigReply>,
}
pub struct ConfigWorker {
    sender: Option<mpsc::Sender<Message>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl ConfigWorker {
    pub fn start(directory: Option<PathBuf>) -> io::Result<Self> {
        let Some(directory) = directory else {
            return Ok(Self {
                sender: None,
                thread: None,
            });
        };
        let (sender, mut receiver) = mpsc::channel::<Message>(16);
        let thread = std::thread::Builder::new()
            .name("configuration-store".into())
            .spawn(move || {
                let owner = lock_directory(&directory);
                let mut state = match &owner {
                    Ok(_) => State::open(directory.clone()),
                    Err(error) => Err(*error),
                };
                let archives = crate::archives::Archives::new(directory);
                while let Some(message) = receiver.blocking_recv() {
                    // Skip work if its server response future was already cancelled.
                    // Network loss alone is not proof of cancellation; running writes may commit.
                    if message.reply.is_closed() {
                        continue;
                    }
                    let result = match &owner {
                        Ok(_) => archives.handle(message.request, &mut state),
                        Err(code) => Err(*code),
                    };
                    let _ = message
                        .reply
                        .send(result.unwrap_or_else(|code| ConfigReply::Error { code }));
                }
            })?;
        Ok(Self {
            sender: Some(sender),
            thread: Some(thread),
        })
    }
    pub async fn request(
        &self,
        request: ConfigRequest,
    ) -> Result<ConfigReply, session_core::session::ErrorCode> {
        use session_core::session::ErrorCode;
        let sender = self.sender.as_ref().ok_or(ErrorCode::Unsupported)?;
        let (reply, receiver) = oneshot::channel();
        sender
            .try_send(Message { request, reply })
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => ErrorCode::CapacityExceeded,
                _ => ErrorCode::InvalidState,
            })?;
        receiver.await.map_err(|_| ErrorCode::InvalidState)
    }
    pub async fn close(self) -> io::Result<()> {
        drop(self.sender);
        if let Some(thread) = self.thread {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|_| io::Error::other("configuration cleanup task failed"))?
                .map_err(|_| io::Error::other("configuration worker failed"))?;
        }
        Ok(())
    }
}
fn lock_directory(directory: &std::path::Path) -> Result<File, ConfigError> {
    std::fs::create_dir_all(directory).map_err(|_| ConfigError::Storage)?;
    // Windows share mode zero prevents separate service instances using this directory.
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(directory.join("configuration.lock"))
        .map_err(|error| {
            if matches!(error.raw_os_error(), Some(32 | 33)) {
                ConfigError::Locked
            } else {
                ConfigError::Storage
            }
        })?;

    Ok(lock)
}

pub(super) struct State {
    pub(super) store: Store,
    pub(super) vault: Vault,
    pub(super) revision: Uuid,
}
impl State {
    fn open(directory: PathBuf) -> Result<Self, ConfigError> {
        let store = Store::open(&directory.join("config.sqlite")).map_err(|error| {
            match config_error(error) {
                ConfigError::Invalid => ConfigError::Corrupt,
                code => code,
            }
        })?;
        let vault = Vault::open(&directory.join("credentials.sqlite")).map_err(vault_error)?;
        Ok(Self {
            store,
            vault,
            revision: Uuid::new_v4(),
        })
    }
    pub(super) fn changed(&mut self) -> Uuid {
        self.revision = Uuid::new_v4();
        self.revision
    }
    pub(super) fn handle(&mut self, request: ConfigRequest) -> Result<ConfigReply, ConfigError> {
        if !request.validate() {
            return Err(ConfigError::Invalid);
        }
        match request {
            ConfigRequest::CredentialsPage { .. }
            | ConfigRequest::InspectCredential { .. }
            | ConfigRequest::ForgetCredential { .. } => Err(ConfigError::Invalid),
            ConfigRequest::Archives {}
            | ConfigRequest::CreateBackup {}
            | ConfigRequest::ExportConfig {}
            | ConfigRequest::InspectBackup { .. }
            | ConfigRequest::RestoreBackup { .. }
            | ConfigRequest::RecoverBackup { .. }
            | ConfigRequest::DeleteArchive { .. } => Err(ConfigError::Invalid),
            ConfigRequest::HostKeysPage { revision, offset } => {
                if revision.is_some_and(|revision| revision != self.revision) {
                    return Err(ConfigError::Conflict);
                }
                let keys = self.store.host_keys().map_err(config_error)?;
                let total = keys.len();
                if offset as usize > total {
                    return Err(ConfigError::Invalid);
                }
                Ok(ConfigReply::HostKeysPage {
                    revision: self.revision,
                    keys: keys.into_iter().skip(offset as usize).take(64).collect(),
                    next_offset: ((offset as usize) + 64 < total).then_some(offset + 64),
                })
            }
            ConfigRequest::ForgetHostKey {
                endpoint,
                algorithm,
                expected_fingerprint,
            } => {
                self.store
                    .forget_host_key(&endpoint, &algorithm, &expected_fingerprint)
                    .map_err(config_error)?;
                Ok(ConfigReply::Updated {
                    revision: self.changed(),
                })
            }
            ConfigRequest::SaveProfileKeyFile {
                profile,
                key_path,
                passphrase,
            } => {
                use std::io::Read;
                let path = std::path::Path::new(&key_path);
                // A key import is a local regular-file operation, never a device/UNC/ADS open.
                let bytes = key_path.as_bytes();
                if bytes.len() < 4
                    || !bytes[0].is_ascii_alphabetic()
                    || bytes[1] != b':'
                    || !matches!(bytes[2], b'\\' | b'/')
                    || key_path[2..].contains(':')
                    || !path.is_absolute()
                {
                    return Err(ConfigError::Invalid);
                }
                let root: Vec<u16> = format!("{}:\\", bytes[0] as char)
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let drive = unsafe {
                    windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr())
                };
                if !matches!(
                    drive,
                    windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED
                        | windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOVABLE
                ) {
                    return Err(ConfigError::Invalid);
                }
                for component in path.components() {
                    if let std::path::Component::Normal(name) = component {
                        let name = name
                            .to_string_lossy()
                            .split('.')
                            .next()
                            .unwrap_or("")
                            .trim_end_matches(' ')
                            .to_ascii_uppercase();
                        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"]
                            .contains(&name.as_str())
                            || (name.starts_with("COM") || name.starts_with("LPT"))
                                && (name[3..].parse::<u8>().is_ok_and(|n| (1..=9).contains(&n))
                                    || ["¹", "²", "³"].contains(&&name[3..]))
                        {
                            return Err(ConfigError::Invalid);
                        }
                    }
                }
                let metadata = std::fs::symlink_metadata(path).map_err(|_| ConfigError::Storage)?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > 65536
                {
                    return Err(ConfigError::Invalid);
                }
                let mut file = OpenOptions::new()
                    .read(true)
                    .custom_flags(
                        windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                    )
                    .open(path)
                    .map_err(|_| ConfigError::Storage)?
                    .take(65537);
                let mut key = zeroize::Zeroizing::new(String::new());
                file.read_to_string(&mut key)
                    .map_err(|_| ConfigError::Invalid)?;
                if key.len() > 65536
                    || ![
                        "-----BEGIN OPENSSH PRIVATE KEY-----",
                        "-----BEGIN PRIVATE KEY-----",
                        "-----BEGIN ENCRYPTED PRIVATE KEY-----",
                        "-----BEGIN RSA PRIVATE KEY-----",
                        "-----BEGIN EC PRIVATE KEY-----",
                    ]
                    .iter()
                    .any(|prefix| key.starts_with(prefix))
                {
                    return Err(ConfigError::Invalid);
                }
                self.handle(ConfigRequest::SaveProfile {
                    profile,
                    credential: CredentialEdit::Replace {
                        value: CredentialBundle {
                            password: None,
                            private_key: Some(session_protocol::Sensitive::new(std::mem::take(
                                &mut *key,
                            ))),
                            passphrase,
                        },
                    },
                })
            }
            ConfigRequest::Page {
                revision,
                offset,
                folders,
            } => {
                if revision.is_some_and(|revision| revision != self.revision) {
                    return Err(ConfigError::Conflict);
                }
                let start = offset as usize;
                let (folders, profiles, total) = if folders {
                    let rows = self.store.folders().map_err(config_error)?;
                    let total = rows.len();
                    (
                        rows.into_iter().skip(start).take(64).collect(),
                        Vec::new(),
                        total,
                    )
                } else {
                    let rows = self.store.profiles().map_err(config_error)?;
                    let total = rows.len();
                    (
                        Vec::new(),
                        rows.into_iter().skip(start).take(64).collect(),
                        total,
                    )
                };
                if start > total {
                    return Err(ConfigError::Invalid);
                }
                let mut missing_credential_profiles = Vec::new();
                for profile in &profiles {
                    if let Some(id) = profile.credential_ref
                        && !self.vault.contains(id).map_err(vault_error)?
                    {
                        missing_credential_profiles.push(profile.id);
                    }
                }
                Ok(ConfigReply::Page {
                    revision: self.revision,
                    folders,
                    profiles,
                    next_offset: (start + 64 < total).then_some(offset + 64),
                    missing_credential_profiles,
                })
            }
            ConfigRequest::SaveFolder { folder } => {
                self.store.put_folder(folder).map_err(config_error)?;
                Ok(ConfigReply::Updated {
                    revision: self.changed(),
                })
            }
            ConfigRequest::DeleteFolder { id } => {
                self.store.delete_folder(id).map_err(config_error)?;
                Ok(ConfigReply::Updated {
                    revision: self.changed(),
                })
            }
            ConfigRequest::DeleteProfile { id } => {
                // Keep encrypted records: config backups/other profiles may still reference them.
                self.store.delete_profile(id).map_err(config_error)?;
                Ok(ConfigReply::Updated {
                    revision: self.changed(),
                })
            }
            ConfigRequest::SaveProfile {
                profile,
                credential,
            } => {
                let previous = self.store.profile(profile.id).map_err(config_error)?;
                let mut created = None;
                let reference = match credential {
                    CredentialEdit::Keep {} => {
                        let reference = previous.as_ref().and_then(|p| p.credential_ref);
                        if let Some(id) = reference {
                            let secret = self.vault.get(id).map_err(vault_error)?;
                            let bundle: CredentialBundle = serde_json::from_slice(secret.expose())
                                .map_err(|_| ConfigError::CredentialUnavailable)?;
                            validate_credential(&profile.settings, &bundle)?;
                        }
                        reference
                    }
                    CredentialEdit::Clear {} => None,
                    CredentialEdit::Replace { value } => {
                        validate_credential(&profile.settings, &value)?;
                        let secret = Secret::new(
                            serde_json::to_vec(&value).map_err(|_| ConfigError::Invalid)?,
                        )
                        .map_err(vault_error)?;
                        let id = Uuid::new_v4();
                        self.vault.set(id, secret).map_err(vault_error)?;
                        created = Some(id);
                        Some(id)
                    }
                };
                let saved = Profile {
                    id: profile.id,
                    folder_id: profile.folder_id,
                    name: profile.name,
                    settings: profile.settings,
                    credential_ref: reference,
                };
                if let Err(error) = self.store.put_profile(saved.clone()) {
                    // Failed config linking cannot replace the old credential. Clean only the new ID.
                    if let Some(id) = created {
                        let _ = self.vault.delete(id);
                    }
                    return Err(config_error(error));
                }
                Ok(ConfigReply::SavedProfile {
                    profile: saved,
                    revision: self.changed(),
                })
            }
        }
    }
}
fn validate_credential(settings: &Settings, value: &CredentialBundle) -> Result<(), ConfigError> {
    let valid = match settings {
        Settings::Ssh1 { .. }
        | Settings::Ssh2 {
            auth: Auth::Password,
            ..
        } => value.password.is_some() && value.private_key.is_none() && value.passphrase.is_none(),
        Settings::Ssh2 {
            auth: Auth::PublicKey,
            ..
        } => {
            value
                .private_key
                .as_ref()
                .is_some_and(|key| !key.expose().is_empty())
                && value.password.is_none()
        }
        Settings::Ssh2 {
            auth: Auth::KeyboardInteractive,
            ..
        } => value.private_key.is_none() && value.passphrase.is_none() && value.password.is_some(),
        Settings::Serial { .. } => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ConfigError::Invalid)
    }
}
pub(super) fn config_error(error: config_store::Error) -> ConfigError {
    match error {
        config_store::Error::Conflict => ConfigError::Conflict,
        config_store::Error::Invalid(_)
        | config_store::Error::Validation(_)
        | config_store::Error::Json(_) => ConfigError::Invalid,
        config_store::Error::NotFound => ConfigError::NotFound,
        config_store::Error::Schema => ConfigError::UnsupportedSchema,
        config_store::Error::Corrupt => ConfigError::Corrupt,
        config_store::Error::Sql(rusqlite_error) => {
            // Only classify, never return SQL or user values over IPC.
            match rusqlite_error.sqlite_error_code() {
                Some(rusqlite::ErrorCode::ConstraintViolation) => ConfigError::Invalid,
                Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
                    ConfigError::Corrupt
                }
                _ => ConfigError::Storage,
            }
        }
        _ => ConfigError::Storage,
    }
}
pub(super) fn vault_error(error: credential_vault::Error) -> ConfigError {
    match error {
        credential_vault::Error::Schema => ConfigError::UnsupportedSchema,
        credential_vault::Error::Corrupt => ConfigError::Corrupt,
        credential_vault::Error::Invalid => ConfigError::Invalid,
        _ => ConfigError::CredentialUnavailable,
    }
}
