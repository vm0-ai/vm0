//! Native runtime foundation for the runner-bundled Zero CLI.
//!
//! Commands that are not registered as native handlers are process-replaced
//! with the published npm CLI. Native command modules live behind the handler
//! registry and share the runtime configuration, HTTP, output, and error
//! boundaries exposed here.

pub mod build;
pub mod config;
pub mod dispatch;
pub mod error;
pub mod fallback;
pub mod handlers;
pub mod http;
pub mod output;
pub mod runtime;
pub mod secret;
pub mod token;

/// Version of the native Zero CLI binary built from this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
