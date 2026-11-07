//! Grant forms. A single operation binds an exact canonical request, not one GUI click.
use crate::{
    access::{Action, Scope, Target},
    session::ErrorCode,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq, JsonSchema)]
pub struct OperationFingerprint(#[schemars(with = "String")] [u8; 32]);
impl OperationFingerprint {
    /// Service callers must supply the canonical, strictly typed operation bytes.
    /// No payload is retained. Never hash a caller-provided digest as a substitute.
    pub fn of_canonical(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }
    pub fn hex(self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
impl std::fmt::Debug for OperationFingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("OperationFingerprint")
            .field(&self.hex())
            .finish()
    }
}
impl Serialize for OperationFingerprint {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.hex())
    }
}
impl<'de> Deserialize<'de> for OperationFingerprint {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.len() != 64
            || !text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(serde::de::Error::custom("invalid operation fingerprint"));
        }
        let mut bytes = [0; 32];
        for (index, chunk) in text.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let digit = |b: u8| {
                if b.is_ascii_digit() {
                    b - b'0'
                } else {
                    b - b'a' + 10
                }
            };
            bytes[index] = digit(chunk[0]) * 16 + digit(chunk[1]);
        }
        Ok(Self(bytes))
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperationKey {
    pub request_id: Uuid,
    pub fingerprint: OperationFingerprint,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Form {
    #[default]
    Scoped,
    SingleOperation {
        operation: OperationKey,
    },
    TimedTask {
        task_id: Uuid,
        label: String,
    },
}
impl Form {
    pub fn valid_for(&self, scopes: &[Scope]) -> bool {
        match self {
            Self::Scoped => true,
            Self::TimedTask { task_id, label } => {
                !task_id.is_nil()
                    && !label.is_empty()
                    && label.len() <= 256
                    && label.trim() == label
                    && !label.chars().any(char::is_control)
            }
            Self::SingleOperation { operation } => {
                if operation.request_id.is_nil()
                    || scopes.is_empty()
                    || scopes.len() > 2
                    || scopes.iter().any(|s| {
                        s.action == Action::Read
                            || (s.action == Action::Connect
                                && !matches!(s.target, Target::ProfileRevision { .. }))
                    })
                {
                    return false;
                }
                scopes.len() == 1
                    || (scopes
                        .iter()
                        .filter(|s| s.action == Action::Reconnect)
                        .count()
                        == 1
                        && scopes
                            .iter()
                            .filter(|s| s.action == Action::Connect)
                            .count()
                            == 1)
            }
        }
    }
}

/// In-process proof minted after the service re-hashes the actual operation.
/// Not serializable/deserializable, and never accepted from a wire identity field.
#[derive(Clone, Copy)]
pub(crate) struct OperationProof {
    pub(crate) client_id: Uuid,
    pub(crate) grant_id: Uuid,
    pub(crate) operation: OperationKey,
}
pub(crate) fn matches(
    form: &Form,
    proof: Option<OperationProof>,
    client_id: Uuid,
    grant_id: Uuid,
    request_id: Uuid,
) -> Result<(), ErrorCode> {
    match form {
        Form::SingleOperation { operation }
            if proof.is_none_or(|proof| {
                proof.client_id != client_id
                    || proof.grant_id != grant_id
                    || proof.operation != *operation
                    || request_id != operation.request_id
            }) =>
        {
            Err(ErrorCode::PermissionDenied)
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests;
