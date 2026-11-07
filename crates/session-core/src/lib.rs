//! Shared session domain. Transport access belongs to the future service layer.

pub mod access;
pub mod authorization;
pub mod capture;
pub mod context;
pub mod disconnect;
pub mod forget;
pub mod input;
pub mod pairing;
pub mod presentation;
pub mod screen;
pub mod serial_input;
pub mod session;
pub mod task_output;

/// Wire version reserved for the first session service contract.
pub const PROTOCOL_VERSION: u32 = 1;
