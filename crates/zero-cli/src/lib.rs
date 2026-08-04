//! Release tracking hook for the runner-bundled Zero CLI.
//!
//! The CLI implementation lives in the binary target. This library target
//! allows runner to depend on the crate for release-please version tracking.

/// Version of the native Zero CLI binary built from this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
