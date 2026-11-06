//! Disconnect receipts survive connection retirement; they never authorize new work.
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
    /// Cancellation was dispatched locally. The transport may still be running.
    Requested,
    /// The service has observed local transport task/worker cleanup completing.
    /// This does not prove remote commands were undone or driver buffers drained.
    TransportEnded,
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
    /// Authenticate the current ticket before calling this method. A retained
    /// same-owner receipt can be read after its Disconnect scope/lease retired.
    /// None denotes Desktop, and cannot borrow an Agent's request ID.
    pub fn lookup(
        &self,
        owner: Option<Uuid>,
        connection: ConnectionRef,
        id: Uuid,
    ) -> Result<Option<Receipt>, ErrorCode> {
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

    /// Reserve under the service policy/lifecycle lock, after authorization and
    /// before cancellation. Failure must leave the transport untouched.
    pub fn reserve(
        &mut self,
        owner: Option<Uuid>,
        connection: ConnectionRef,
        id: Uuid,
    ) -> Result<Receipt, ErrorCode> {
        if id.is_nil() || connection.connection_id.0.is_nil() || connection.generation == 0 {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(receipt) = self.lookup(owner, connection, id)? {
            return Ok(receipt);
        }
        if self.records.len() >= MAX_RECEIPTS {
            let oldest = self
                .records
                .iter()
                .filter(|(_, record)| record.receipt.state == State::TransportEnded)
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|ts| (*id, ts)))
                .min_by_key(|(_, ts)| *ts);
            let Some((old_id, timestamp)) = oldest else {
                return Err(ErrorCode::CapacityExceeded);
            };
            // Reject before changing retention when the candidate itself would
            // fall into the retiring bucket, including another UUID in that ms.
            if ordered_timestamp(id).is_some_and(|ts| ts <= timestamp) {
                return Err(ErrorCode::RequestExpired);
            }
            self.window.retire(timestamp);
            self.records.remove(&old_id);
        }
        let receipt = Receipt {
            request_id: id,
            connection,
            state: State::Requested,
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

    /// Call only after observing cleanup for this exact generation. Domain
    /// Disconnected alone, cancellation requests and timeouts are insufficient.
    pub fn transport_ended(&mut self, connection: ConnectionRef) {
        for record in self.records.values_mut() {
            if record.receipt.connection == connection {
                record.receipt.state = State::TransportEnded;
            }
        }
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
    fn original_owner_and_generation_remain_bound_after_cleanup() {
        let mut receipts = Receipts::default();
        let owner = Some(Uuid::new_v4());
        let id = Uuid::new_v4();
        let first = receipts.reserve(owner, connection(1), id).unwrap();
        assert_eq!(first.state, State::Requested);
        assert_eq!(
            receipts.reserve(owner, connection(1), id),
            Ok(first.clone())
        );
        assert_eq!(
            receipts.lookup(None, connection(1), id),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            receipts.lookup(Some(Uuid::new_v4()), connection(1), id),
            Err(ErrorCode::PermissionDenied)
        );
        assert_eq!(
            receipts.lookup(owner, connection(2), id),
            Err(ErrorCode::InvalidArgument)
        );
        receipts.transport_ended(connection(2));
        assert_eq!(receipts.lookup(owner, connection(1), id), Ok(Some(first)));
        receipts.transport_ended(connection(1));
        let ended = receipts.lookup(owner, connection(1), id).unwrap().unwrap();
        assert_eq!(ended.state, State::TransportEnded);
        assert_eq!(receipts.reserve(owner, connection(1), id), Ok(ended));
        assert_eq!(
            receipts.reserve(None, connection(1), id),
            Err(ErrorCode::PermissionDenied)
        );
    }

    #[test]
    fn pending_and_opaque_receipts_cannot_be_evicted() {
        for opaque in [false, true] {
            let mut receipts = Receipts::default();
            for i in 0..MAX_RECEIPTS {
                let id = if opaque {
                    Uuid::new_v4()
                } else {
                    ordered(i as u64 + 1, 1)
                };
                receipts.reserve(None, connection(1), id).unwrap();
            }
            assert_eq!(
                receipts.reserve(None, connection(1), ordered(5000, 1)),
                Err(ErrorCode::CapacityExceeded)
            );
            if opaque {
                receipts.transport_ended(connection(1));
                assert_eq!(
                    receipts.reserve(None, connection(1), ordered(5000, 1)),
                    Err(ErrorCode::CapacityExceeded)
                );
            }
        }
    }

    #[test]
    fn completed_ordered_receipts_retire_without_replaying_or_losing_pending() {
        let mut receipts = Receipts::default();
        for i in 1..=MAX_RECEIPTS {
            receipts
                .reserve(
                    None,
                    connection(if i == 1 { 1 } else { 2 }),
                    ordered(i as u64, 1),
                )
                .unwrap();
        }
        receipts.transport_ended(connection(1));
        assert_eq!(
            receipts.reserve(None, connection(1), ordered(1, 2)),
            Err(ErrorCode::RequestExpired)
        );
        assert!(
            receipts
                .lookup(None, connection(1), ordered(1, 1))
                .unwrap()
                .is_some()
        );
        receipts
            .reserve(None, connection(3), ordered(5000, 1))
            .unwrap();
        assert_eq!(
            receipts.lookup(None, connection(1), ordered(1, 1)),
            Err(ErrorCode::RequestExpired)
        );
        assert_eq!(
            receipts.lookup(None, connection(1), ordered(1, 2)),
            Err(ErrorCode::RequestExpired)
        );
        assert_eq!(
            receipts.reserve(None, connection(3), ordered(5001, 1)),
            Err(ErrorCode::CapacityExceeded)
        );
        assert_eq!(
            receipts
                .lookup(None, connection(2), ordered(2, 1))
                .unwrap()
                .unwrap()
                .state,
            State::Requested
        );
    }

    #[test]
    fn invalid_targets_never_reserve_and_absent_ids_are_only_queries() {
        let mut receipts = Receipts::default();
        let id = Uuid::new_v4();
        assert_eq!(receipts.lookup(None, connection(1), id), Ok(None));
        assert_eq!(
            receipts.reserve(None, connection(0), id),
            Err(ErrorCode::InvalidArgument)
        );
        assert_eq!(
            receipts.reserve(None, connection(1), Uuid::nil()),
            Err(ErrorCode::InvalidArgument)
        );
        assert_eq!(receipts.lookup(None, connection(1), id), Ok(None));
    }
}
