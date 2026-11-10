#![cfg(windows)]
mod archives;
pub mod audit_diagnostic;
#[cfg(windows)]
mod audit_journal;
pub mod client;
mod config;
mod logging;
mod protected_export;
mod request_audit;
pub mod security;
mod serial;
#[cfg(feature = "serial-mcp-fixture")]
pub mod serial_mcp_fixture;
mod server;
mod ssh;
pub use server::{serve, serve_with_config};

pub(crate) fn encoding_label(encoding: &config_store::Encoding) -> &'static str {
    match encoding {
        config_store::Encoding::Utf8 => "utf-8",
        config_store::Encoding::Gbk => "gbk",
        config_store::Encoding::Gb18030 => "gb18030",
    }
}
