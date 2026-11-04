//! Optional output-only observers. Implementations must never wait for file or
//! transport I/O, and must surface their own bounded-queue failures separately.
use crate::{presentation::TextEvent, session::*};
pub trait OutputCapture: Send + Sync {
    fn record(&self, raw: Option<&OutputEvent>, text: &TextEvent);
    fn stop(&self);
}
#[derive(Debug, Clone)]
pub struct OutputPosition {
    pub connection: ConnectionRef,
    pub protocol: Protocol,
    pub encoding: String,
    pub source_cursor: u64,
    pub text_cursor: u64,
}
#[cfg(test)]
mod tests;
