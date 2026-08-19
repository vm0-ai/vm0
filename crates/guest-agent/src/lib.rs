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
mod active_input_receipts;
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
pub mod workload_containment;

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

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn run_unprivileged_test(test_name: &str) -> Result<bool, String> {
    const TEST_ENV: &str = "VM0_GUEST_AGENT_UNPRIVILEGED_TEST";
    const UNPRIVILEGED_ID: u32 = 65_534;

    if std::env::var(TEST_ENV).as_deref() == Ok(test_name) {
        return Ok(true);
    }
    // SAFETY: `geteuid` only reads the effective process credential.
    if unsafe { libc::geteuid() } != 0 {
        return Ok(true);
    }

    use std::os::unix::process::CommandExt;

    let current_exe = std::env::current_exe()
        .map_err(|error| format!("failed to locate test executable: {error}"))?;
    let output = std::process::Command::new(current_exe)
        .arg("--exact")
        .arg(test_name)
        .arg("--nocapture")
        .env(TEST_ENV, test_name)
        .gid(UNPRIVILEGED_ID)
        .uid(UNPRIVILEGED_ID)
        .output()
        .map_err(|error| format!("failed to launch unprivileged test {test_name}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() || !stdout.contains("1 passed") {
        return Err(format!(
            "unprivileged test {test_name} failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
            output.status
        ));
    }
    Ok(false)
}
