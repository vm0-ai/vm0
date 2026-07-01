//! Guest agent library for the binary and integration tests.
//!
//! The production runtime model is explicit:
//! - [`run_context::GuestRuntime::from_process_env`] is the startup boundary
//!   that captures runner-provided process state.
//! - [`env::GuestConfigRaw`] is the raw environment snapshot.
//! - [`env::GuestConfig`] owns immutable run-scoped configuration.
//! - [`paths::GuestPaths`] owns immutable run-scoped filesystem paths.
//!
//! Do not add process-global facade readers for run-scoped environment values
//! or paths. Thread `GuestConfig` and `GuestPaths` through the caller instead.

pub mod active_input;
mod artifact;
pub mod checkpoint;
pub mod cli;
mod codex_auth;
pub mod complete;
mod constants;
mod content_hash;
pub mod control;
pub mod env;
pub mod error;
pub mod events;
pub mod heartbeat;
pub mod http;
pub mod masker;
pub mod metrics;
mod nofollow_fs;
pub mod paths;
pub mod run_context;
pub mod session_history;
pub mod session_history_identity;
pub mod session_metadata;
pub mod telemetry;
pub mod timing;
mod urls;
