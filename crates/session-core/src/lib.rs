//! Shared session domain. Transport access belongs to the future service layer.

pub mod pairing;
pub mod screen;
pub mod session;

/// Wire version reserved for the first session service contract.
pub const PROTOCOL_VERSION: u32 = 1;
