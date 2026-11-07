//! Completed removal receipts. Authorization and transport cleanup belong to the service.
use crate::{
    input::{MAX_RECEIPTS, RequestWindow, ordered_timestamp},
    session::{ConnectionRef, ErrorCode},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    /// The service removed the exact generation after proving local transport cleanup.
    /// Log files, saved profiles and user exports are not deleted by this operation.
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: Uuid,
    pub connection: ConnectionRef,
    pub state: State,
}

struct Record {
    owner: Option<Uuid>,
    receipt: Receipt,
}

#[derive(Default)]
pub struct Receipts {
    records: HashMap<Uuid, Record>,
    window: RequestWindow,
}

impl Receipts {
    /// The caller must authenticate the current ticket before lookup, including
    /// after scope retirement. None is Desktop, never an arbitrary caller role.
    pub fn lookup(
        &self,
        owner: Option<Uuid>,
        connection: ConnectionRef,
        id: Uuid,
    ) -> Result<Option<Receipt>, ErrorCode> {
        if id.is_nil() || connection.connection_id.0.is_nil() || connection.generation == 0 {
            return Err(ErrorCode::InvalidArgument);
        }
        match self.records.get(&id) {
            Some(record) if record.owner != owner => Err(ErrorCode::PermissionDenied),
            Some(record) if record.receipt.connection != connection => {
                Err(ErrorCode::InvalidArgument)
            }
            Some(record) => Ok(Some(record.receipt.clone())),
            None => {
                self.window.check(id)?;
                Ok(None)
            }
        }
    }

    /// Run under the service lifecycle/policy locks, with no await or external
    /// callbacks. The closure must check cleanup and authority before mutation.
    /// Duplicates never call it; capacity failure never removes a connection.
    /// A failed closure leaves both receipts and the retirement watermark intact.
    pub fn remove_with(
        &mut self,
        owner: Option<Uuid>,
        connection: ConnectionRef,
        id: Uuid,
        remove: impl FnOnce() -> Result<(), ErrorCode>,
    ) -> Result<Receipt, ErrorCode> {
        if let Some(receipt) = self.lookup(owner, connection, id)? {
            return Ok(receipt);
        }
        let evict = if self.records.len() >= MAX_RECEIPTS {
            let (old, timestamp) = self
                .records
                .keys()
                .filter_map(|id| ordered_timestamp(*id).map(|ts| (*id, ts)))
                .min_by_key(|(_, ts)| *ts)
                .ok_or(ErrorCode::CapacityExceeded)?;
            if ordered_timestamp(id).is_some_and(|ts| ts <= timestamp) {
                return Err(ErrorCode::RequestExpired);
            }
            Some((old, timestamp))
        } else {
            None
        };
        remove()?;
        if let Some((old, timestamp)) = evict {
            self.window.retire(timestamp);
            self.records.remove(&old);
        }
        let receipt = Receipt {
            request_id: id,
            connection,
            state: State::Removed,
        };
        self.records.insert(
            id,
            Record {
                owner,
                receipt: receipt.clone(),
            },
        );
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ConnectionId;
    fn connection(generation: u64) -> ConnectionRef {
        ConnectionRef {
            connection_id: ConnectionId(Uuid::from_u128(10)),
            generation,
        }
    }
    fn ordered(timestamp: u64, suffix: u64) -> Uuid {
        Uuid::from_u128(
            ((timestamp as u128) << 80) | (7u128 << 76) | (2u128 << 62) | suffix as u128,
        )
    }

    #[test]
    fn removed_receipt_binds_owner_and_exact_generation_without_repeating_removal() {
        let mut receipts = Receipts::default();
        let owner = Some(Uuid::new_v4());
        let id = Uuid::new_v4();
        let first = receipts
            .remove_with(owner, connection(1), id, || Ok(()))
            .unwrap();
        assert_eq!(first.state, State::Removed);
        assert_eq!(
            receipts.remove_with(owner, connection(1), id, || panic!("replayed")),
            Ok(first)
        );
        for other in [None, Some(Uuid::new_v4())] {
            assert_eq!(
                receipts.remove_with(other, connection(1), id, || panic!("cross owner")),
                Err(ErrorCode::PermissionDenied)
            );
        }
        assert_eq!(
            receipts.lookup(owner, connection(2), id),
            Err(ErrorCode::InvalidArgument)
        );
    }

    #[test]
    fn failed_cleanup_or_authority_has_no_receipt_and_can_be_retried_by_original_id() {
        let mut receipts = Receipts::default();
        let id = Uuid::new_v4();
        for error in [ErrorCode::InvalidState, ErrorCode::PermissionDenied] {
            assert_eq!(
                receipts.remove_with(None, connection(1), id, || Err(error)),
                Err(error)
            );
            assert_eq!(receipts.lookup(None, connection(1), id), Ok(None));
        }
        receipts
            .remove_with(None, connection(1), id, || Ok(()))
            .unwrap();
    }

    #[test]
    fn opaque_capacity_failure_never_calls_removal() {
        let mut receipts = Receipts::default();
        for _ in 0..MAX_RECEIPTS {
            receipts
                .remove_with(None, connection(1), Uuid::new_v4(), || Ok(()))
                .unwrap();
        }
        assert_eq!(
            receipts.remove_with(None, connection(1), ordered(5000, 1), || panic!("capacity")),
            Err(ErrorCode::CapacityExceeded)
        );
    }

    #[test]
    fn ordered_eviction_is_atomic_with_success_and_rejects_the_whole_retired_bucket() {
        let mut receipts = Receipts::default();
        for i in 1..=MAX_RECEIPTS {
            receipts
                .remove_with(None, connection(1), ordered(i as u64, 1), || Ok(()))
                .unwrap();
        }
        assert_eq!(
            receipts.remove_with(None, connection(1), ordered(1, 2), || panic!("old bucket")),
            Err(ErrorCode::RequestExpired)
        );
        let id = ordered(5000, 1);
        assert_eq!(
            receipts.remove_with(None, connection(1), id, || Err(ErrorCode::InvalidState)),
            Err(ErrorCode::InvalidState)
        );
        assert!(
            receipts
                .lookup(None, connection(1), ordered(1, 1))
                .unwrap()
                .is_some()
        );
        receipts
            .remove_with(None, connection(2), id, || Ok(()))
            .unwrap();
        for old in [ordered(1, 1), ordered(1, 2)] {
            assert_eq!(
                receipts.remove_with(None, connection(1), old, || panic!("retired")),
                Err(ErrorCode::RequestExpired)
            );
        }
        assert!(
            receipts
                .lookup(None, connection(1), ordered(2, 1))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn invalid_targets_and_queries_do_not_execute_removal() {
        let mut receipts = Receipts::default();
        let id = Uuid::new_v4();
        assert_eq!(receipts.lookup(None, connection(1), id), Ok(None));
        for (target, id) in [
            (connection(0), id),
            (connection(1), Uuid::nil()),
            (
                ConnectionRef {
                    connection_id: ConnectionId(Uuid::nil()),
                    generation: 1,
                },
                id,
            ),
        ] {
            assert_eq!(
                receipts.remove_with(None, target, id, || panic!("invalid")),
                Err(ErrorCode::InvalidArgument)
            );
        }
        assert!(receipts.records.is_empty());
    }
}
