//! Guest agent library for the binary and integration tests.
//!
//! The production runtime model is explicit:
//! - [`run_context::GuestRuntime::from_process_env`] is the startup boundary
//!   that captures runner-provided process state.
//! - [`env::GuestConfigRaw`] owns captured raw startup values.
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
pub mod codex_thread_path;
pub mod complete;
mod constants;
mod content_hash;
pub mod control;
pub mod env;
pub mod error;
pub mod events;
pub mod failure_diagnostics;
mod failure_patterns;
pub mod heartbeat;
pub mod http;
pub mod masker;
pub mod metrics;
mod nofollow_fs;
pub mod paths;
pub mod reuse_preparation;
pub mod run_context;
pub mod session_history;
pub mod session_history_identity;
pub mod session_metadata;
pub mod telemetry;
pub mod timing;
mod urls;

#[cfg(test)]
static SYSTEM_LOG_TEST_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
pub(crate) fn lock_system_log_test_state() -> tokio::sync::MutexGuard<'static, ()> {
    SYSTEM_LOG_TEST_MUTEX.blocking_lock()
}

#[cfg(test)]
pub(crate) async fn lock_system_log_test_state_async() -> tokio::sync::MutexGuard<'static, ()> {
    SYSTEM_LOG_TEST_MUTEX.lock().await
}
