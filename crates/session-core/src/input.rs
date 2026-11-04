//! Bounded request receipts shared by transport input schedulers. Payloads are never retained here.
use crate::session::ErrorCode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;
pub const MAX_RECEIPTS: usize = 1024;
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint([u8; 32]);
impl Fingerprint {
    pub fn write(bytes: &[u8]) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"terminal-input/write/v1\0");
        digest.update(bytes);
        Self(digest.finalize().into())
    }
    pub fn resize(cols: u32, rows: u32) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"terminal-input/resize/v1\0");
        digest.update(cols.to_le_bytes());
        digest.update(rows.to_le_bytes());
        Self(digest.finalize().into())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InputState {
    Pending,
    Dispatching,
    PipelineQueued,
    Unknown,
    CancelledBeforeDispatch,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InputFailure {
    Cancelled,
    Timeout,
    Transport,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: Uuid,
    pub state: InputState,
    pub pipeline_bytes: Option<usize>,
    pub failure: Option<InputFailure>,
}
struct Record {
    fingerprint: Fingerprint,
    receipt: Receipt,
}
#[derive(Default)]
pub struct Receipts {
    records: HashMap<Uuid, Record>,
}
impl Receipts {
    pub fn lookup(&self, id: Uuid, fingerprint: Fingerprint) -> Result<Option<Receipt>, ErrorCode> {
        match self.records.get(&id) {
            Some(record) if record.fingerprint == fingerprint => Ok(Some(record.receipt.clone())),
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => Ok(None),
        }
    }
    pub fn get(&self, id: Uuid) -> Result<Receipt, ErrorCode> {
        self.records
            .get(&id)
            .map(|record| record.receipt.clone())
            .ok_or(ErrorCode::NotFound)
    }
    pub fn remember(&mut self, id: Uuid, fingerprint: Fingerprint) -> Result<Receipt, ErrorCode> {
        if id.is_nil() {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(receipt) = self.lookup(id, fingerprint)? {
            return Ok(receipt);
        }
        if self.records.len() >= MAX_RECEIPTS {
            return Err(ErrorCode::CapacityExceeded);
        }
        let receipt = Receipt {
            request_id: id,
            state: InputState::Pending,
            pipeline_bytes: None,
            failure: None,
        };
        self.records.insert(
            id,
            Record {
                fingerprint,
                receipt: receipt.clone(),
            },
        );
        Ok(receipt)
    }
    pub fn dispatch(&mut self, id: Uuid) -> bool {
        if let Some(record) = self.records.get_mut(&id)
            && record.receipt.state == InputState::Pending
        {
            record.receipt.state = InputState::Dispatching;
            true
        } else {
            false
        }
    }
    pub fn complete(&mut self, id: Uuid, result: Result<Option<usize>, InputFailure>) {
        if let Some(record) = self.records.get_mut(&id)
            && record.receipt.state == InputState::Dispatching
        {
            match result {
                Ok(bytes) => {
                    record.receipt.state = InputState::PipelineQueued;
                    record.receipt.pipeline_bytes = bytes;
                }
                Err(error) => {
                    record.receipt.state = InputState::Unknown;
                    record.receipt.failure = Some(error);
                }
            }
        }
    }
    pub fn connection_lost(&mut self, reason: InputFailure) {
        for record in self.records.values_mut() {
            match record.receipt.state {
                InputState::Pending => {
                    record.receipt.state = InputState::CancelledBeforeDispatch;
                    record.receipt.failure = Some(reason);
                }
                InputState::Dispatching => {
                    record.receipt.state = InputState::Unknown;
                    record.receipt.failure = Some(reason);
                }
                _ => {}
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_request_never_dispatches_again_and_conflicting_payload_is_rejected() {
        let mut receipts = Receipts::default();
        let id = Uuid::new_v4();
        let fingerprint = Fingerprint::write(b"sensitive synthetic input");
        let pending = receipts.remember(id, fingerprint).unwrap();
        assert_eq!(receipts.remember(id, fingerprint).unwrap(), pending);
        assert!(receipts.dispatch(id));
        assert!(!receipts.dispatch(id));
        receipts.complete(id, Ok(Some(25)));
        assert_eq!(
            receipts.remember(id, fingerprint).unwrap().state,
            InputState::PipelineQueued
        );
        assert!(!receipts.dispatch(id));
        assert_eq!(
            receipts.remember(id, Fingerprint::resize(80, 24)),
            Err(ErrorCode::InvalidArgument)
        );
        assert_eq!(
            receipts.remember(id, Fingerprint::write(b"different bytes")),
            Err(ErrorCode::InvalidArgument)
        );
        assert!(
            !serde_json::to_string(&receipts.get(id).unwrap())
                .unwrap()
                .contains("sensitive")
        );
    }
    #[test]
    fn closing_marks_unsent_cancelled_and_inflight_unknown_without_overwriting_known_pipeline_receipts()
     {
        let mut receipts = Receipts::default();
        let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        for id in ids {
            receipts.remember(id, Fingerprint::write(b"x")).unwrap();
        }
        receipts.dispatch(ids[1]);
        receipts.dispatch(ids[2]);
        receipts.complete(ids[2], Ok(Some(1)));
        receipts.connection_lost(InputFailure::Cancelled);
        assert_eq!(
            receipts.get(ids[0]).unwrap().state,
            InputState::CancelledBeforeDispatch
        );
        assert_eq!(receipts.get(ids[1]).unwrap().state, InputState::Unknown);
        assert_eq!(
            receipts.get(ids[2]).unwrap().state,
            InputState::PipelineQueued
        );
        receipts.complete(ids[1], Ok(Some(1)));
        assert_eq!(receipts.get(ids[1]).unwrap().state, InputState::Unknown);
        assert!(!receipts.dispatch(ids[0]));
    }
    #[test]
    fn receipts_are_bounded_and_never_evict_the_deduplication_evidence() {
        let mut receipts = Receipts::default();
        let fingerprint = Fingerprint::resize(80, 24);
        let first = Uuid::new_v4();
        receipts.remember(first, fingerprint).unwrap();
        for _ in 1..MAX_RECEIPTS {
            receipts.remember(Uuid::new_v4(), fingerprint).unwrap();
        }
        assert_eq!(
            receipts.remember(Uuid::new_v4(), fingerprint),
            Err(ErrorCode::CapacityExceeded)
        );
        assert!(receipts.lookup(first, fingerprint).unwrap().is_some());
        assert_eq!(
            receipts.remember(Uuid::nil(), fingerprint),
            Err(ErrorCode::InvalidArgument)
        );
    }
}
