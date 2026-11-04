//! Bounded request receipts shared by transport input schedulers. Payloads are never retained here.
use crate::session::ErrorCode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::{Uuid, Variant};
pub const MAX_RECEIPTS: usize = 1024;

/// UUIDv7 timestamps order retention buckets; they are not used as trusted wall-clock times.
/// UUIDs without this ordering retain the original fail-closed, non-evicting behavior.
pub fn ordered_timestamp(id: Uuid) -> Option<u64> {
    if id.get_version_num() != 7 || id.get_variant() != Variant::RFC4122 {
        return None;
    }
    let bytes = id.as_bytes();
    Some(u64::from_be_bytes([
        0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5],
    ]))
}
#[derive(Default)]
pub struct RequestWindow {
    retired_through: Option<u64>,
}
impl RequestWindow {
    pub fn check(&self, id: Uuid) -> Result<(), ErrorCode> {
        if let Some(timestamp) = ordered_timestamp(id)
            && self.retired_through.is_some_and(|floor| timestamp <= floor)
        {
            return Err(ErrorCode::RequestExpired);
        }
        Ok(())
    }
    pub fn retire(&mut self, timestamp: u64) {
        self.retired_through = Some(
            self.retired_through
                .map_or(timestamp, |old| old.max(timestamp)),
        );
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint([u8; 32]);
impl Fingerprint {
    pub fn control(line: u8, asserted: bool) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"terminal-input/control/v1\0");
        digest.update([line, u8::from(asserted)]);
        Self(digest.finalize().into())
    }
    pub fn exec(command: &str, timeout_ms: u64, max_output_bytes: usize) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"terminal-input/exec/v1\0");
        digest.update(timeout_ms.to_le_bytes());
        digest.update((max_output_bytes as u64).to_le_bytes());
        digest.update(command.as_bytes());
        Self(digest.finalize().into())
    }
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
    window: RequestWindow,
}
impl Receipts {
    pub fn lookup(&self, id: Uuid, fingerprint: Fingerprint) -> Result<Option<Receipt>, ErrorCode> {
        match self.records.get(&id) {
            Some(record) if record.fingerprint == fingerprint => Ok(Some(record.receipt.clone())),
            Some(_) => Err(ErrorCode::InvalidArgument),
            None => {
                self.window.check(id)?;
                Ok(None)
            }
        }
    }
    pub fn get(&self, id: Uuid) -> Result<Receipt, ErrorCode> {
        if let Some(record) = self.records.get(&id) {
            return Ok(record.receipt.clone());
        }
        self.window.check(id)?;
        Err(ErrorCode::NotFound)
    }
    /// Other actions must also reject a retired input ID instead of accepting it as a new request.
    pub fn check_available(&self, id: Uuid) -> Result<(), ErrorCode> {
        if self.records.contains_key(&id) {
            return Err(ErrorCode::InvalidArgument);
        }
        self.window.check(id)
    }
    pub fn remember(&mut self, id: Uuid, fingerprint: Fingerprint) -> Result<Receipt, ErrorCode> {
        if id.is_nil() {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(receipt) = self.lookup(id, fingerprint)? {
            return Ok(receipt);
        }
        if self.records.len() >= MAX_RECEIPTS {
            let oldest = self
                .records
                .iter()
                .filter_map(|(id, record)| {
                    if matches!(
                        record.receipt.state,
                        InputState::Pending | InputState::Dispatching
                    ) {
                        None
                    } else {
                        ordered_timestamp(*id).map(|timestamp| (*id, timestamp))
                    }
                })
                .min_by_key(|(_, timestamp)| *timestamp);
            let Some((old_id, timestamp)) = oldest else {
                return Err(ErrorCode::CapacityExceeded);
            };
            self.window.retire(timestamp);
            self.records.remove(&old_id);
            // A new ID in the same or an older millisecond must not be admitted after retirement.
            self.window.check(id)?;
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
    fn ordered(stamp: u64, nonce: u64) -> Uuid {
        Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0000 | nonce as u128)
    }
    #[test]
    fn long_session_reclaims_only_terminal_ordered_receipts_and_never_readmits_retired_ids() {
        let mut receipts = Receipts::default();
        let fingerprint = Fingerprint::write(b"once");
        for stamp in 1..=10000 {
            let id = ordered(stamp, 1);
            receipts.remember(id, fingerprint).unwrap();
            assert!(receipts.dispatch(id));
            receipts.complete(id, Ok(Some(4)));
            assert_eq!(
                receipts.lookup(id, fingerprint).unwrap().unwrap().state,
                InputState::PipelineQueued
            );
            assert!(!receipts.dispatch(id));
            assert!(receipts.records.len() <= MAX_RECEIPTS);
        }
        for id in [ordered(1, 1), ordered(1, 2), ordered(5000, 1)] {
            assert_eq!(receipts.get(id), Err(ErrorCode::RequestExpired));
            assert_eq!(
                receipts.remember(id, fingerprint),
                Err(ErrorCode::RequestExpired)
            );
            assert_eq!(
                receipts.remember(id, Fingerprint::resize(90, 30)),
                Err(ErrorCode::RequestExpired)
            );
            assert_eq!(receipts.check_available(id), Err(ErrorCode::RequestExpired));
        }
    }
    #[test]
    fn active_receipts_and_opaque_ids_survive_retirement_of_newer_completed_requests() {
        let mut receipts = Receipts::default();
        let fingerprint = Fingerprint::write(b"once");
        let pending = ordered(1, 1);
        let in_flight = ordered(1, 2);
        let opaque = Uuid::new_v4();
        for id in [pending, in_flight, opaque] {
            receipts.remember(id, fingerprint).unwrap();
        }
        receipts.dispatch(in_flight);
        receipts.dispatch(opaque);
        receipts.complete(opaque, Ok(Some(4)));
        for stamp in 2..2000 {
            let id = ordered(stamp, 1);
            receipts.remember(id, fingerprint).unwrap();
            receipts.dispatch(id);
            receipts.complete(id, Ok(Some(4)));
        }
        assert_eq!(
            receipts.remember(pending, fingerprint).unwrap().state,
            InputState::Pending
        );
        assert_eq!(
            receipts.remember(in_flight, fingerprint).unwrap().state,
            InputState::Dispatching
        );
        assert_eq!(
            receipts.remember(opaque, fingerprint).unwrap().state,
            InputState::PipelineQueued
        );
        assert_eq!(
            receipts.remember(pending, Fingerprint::write(b"other")),
            Err(ErrorCode::InvalidArgument)
        );
        assert_eq!(
            receipts.remember(ordered(1, 3), fingerprint),
            Err(ErrorCode::RequestExpired)
        );
        receipts.complete(in_flight, Err(InputFailure::Timeout));
        receipts.connection_lost(InputFailure::Cancelled);
        assert_eq!(receipts.get(in_flight).unwrap().state, InputState::Unknown);
        assert_eq!(
            receipts.get(pending).unwrap().state,
            InputState::CancelledBeforeDispatch
        );
    }
    #[test]
    fn a_full_millisecond_is_retired_as_a_bucket_and_pending_work_cannot_be_evicted() {
        let mut receipts = Receipts::default();
        let fingerprint = Fingerprint::resize(80, 24);
        for nonce in 1..=MAX_RECEIPTS as u64 {
            receipts.remember(ordered(10, nonce), fingerprint).unwrap();
        }
        assert_eq!(
            receipts.remember(ordered(11, 1), fingerprint),
            Err(ErrorCode::CapacityExceeded)
        );
        receipts.dispatch(ordered(10, 1));
        receipts.complete(ordered(10, 1), Ok(None));
        assert_eq!(
            receipts.remember(ordered(10, MAX_RECEIPTS as u64 + 1), fingerprint),
            Err(ErrorCode::RequestExpired)
        );
        assert_eq!(receipts.get(ordered(10, 1)), Err(ErrorCode::RequestExpired));
        assert!(receipts.remember(ordered(11, 1), fingerprint).is_ok());
        assert_eq!(
            receipts.get(ordered(10, 2)).unwrap().state,
            InputState::Pending
        );
        let mut malformed = *ordered(1, 1).as_bytes();
        malformed[8] = 0; // A version nibble alone does not opt an opaque ID into ordered reclamation.
        assert_eq!(ordered_timestamp(Uuid::from_bytes(malformed)), None);
    }
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
