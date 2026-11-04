#![cfg(windows)]
mod archives;
pub mod client;
mod config;
mod logging;
pub mod security;
mod serial;
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
