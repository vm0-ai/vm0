//! Guest filesystem paths and derived runtime-file paths.
//!
//! Naming conventions:
//! - "system log" = guest-agent's own stderr (matches TS `SYSTEM_LOG_FILE` and API `systemLog`)
//! - "agent log" = AI agent (Claude Code) stdout output
//! - "metrics" = periodic CPU/memory/disk snapshots
//! - "sandbox ops" = operation timing records (defined in guest-common, re-exported here)
//! - runtime-file paths are scoped to the current run ID

pub use api_contracts::generated::constants::runners::paths::{
    CANONICAL_GUEST_HOME_DIR, CANONICAL_WORKING_DIR,
};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

static RUNTIME_DIR: LazyLock<PathBuf> = LazyLock::new(default_run_dir);

#[allow(clippy::panic)]
fn default_run_dir() -> PathBuf {
    let run_id = std::env::var("VM0_RUN_ID").unwrap_or_default();
    guest_runtime_paths::run_dir_from_env(&run_id)
        .unwrap_or_else(|error| panic!("failed to resolve guest runtime directory: {error}"))
}

pub fn runtime_dir() -> &'static Path {
    &RUNTIME_DIR
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

pub fn ensure_parent_dir(path: impl AsRef<Path>) -> io::Result<()> {
    guest_runtime_paths::ensure_parent_dir(path)
}

pub fn write_private(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    guest_runtime_paths::write_private(path, bytes)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

static SESSION_ID_FILE: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::session_id_file(runtime_dir())));
static SESSION_HISTORY_PATH_FILE: LazyLock<String> = LazyLock::new(|| {
    path_to_string(guest_runtime_paths::session_history_marker_file(
        runtime_dir(),
    ))
});

pub fn session_id_file() -> &'static str {
    &SESSION_ID_FILE
}
pub fn session_history_path_file() -> &'static str {
    &SESSION_HISTORY_PATH_FILE
}

// ---------------------------------------------------------------------------
// Log files
// ---------------------------------------------------------------------------

static EVENT_ERROR_FLAG: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::event_error_file(runtime_dir())));
static CHECKPOINT_ERROR_FILE: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::checkpoint_error_file(runtime_dir())));
static FAILURE_DIAGNOSTIC_FILE: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::failure_diagnostic_file(runtime_dir())));
static SYSTEM_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::system_log_file(runtime_dir())));
static AGENT_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::agent_log_file(runtime_dir())));
static METRICS_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| path_to_string(guest_runtime_paths::metrics_log_file(runtime_dir())));

pub fn event_error_flag() -> &'static str {
    &EVENT_ERROR_FLAG
}
pub fn checkpoint_error_file() -> &'static str {
    &CHECKPOINT_ERROR_FILE
}
pub fn failure_diagnostic_file() -> &'static str {
    &FAILURE_DIAGNOSTIC_FILE
}
pub fn system_log_file() -> &'static str {
    &SYSTEM_LOG_FILE
}
pub fn agent_log_file() -> &'static str {
    &AGENT_LOG_FILE
}
pub fn metrics_log_file() -> &'static str {
    &METRICS_LOG_FILE
}

/// Re-export sandbox ops log path from guest-common for consistent access.
pub fn sandbox_ops_file() -> &'static str {
    guest_common::telemetry::sandbox_ops_log()
}

// ---------------------------------------------------------------------------
// Telemetry position tracking
// ---------------------------------------------------------------------------

static TELEMETRY_SYSTEM_LOG_POS_FILE: LazyLock<String> = LazyLock::new(|| {
    path_to_string(guest_runtime_paths::telemetry_system_log_pos_file(
        runtime_dir(),
    ))
});
static TELEMETRY_METRICS_POS_FILE: LazyLock<String> = LazyLock::new(|| {
    path_to_string(guest_runtime_paths::telemetry_metrics_pos_file(
        runtime_dir(),
    ))
});
static TELEMETRY_SANDBOX_OPS_POS_FILE: LazyLock<String> = LazyLock::new(|| {
    path_to_string(guest_runtime_paths::telemetry_sandbox_ops_pos_file(
        runtime_dir(),
    ))
});

pub fn telemetry_system_log_pos_file() -> &'static str {
    &TELEMETRY_SYSTEM_LOG_POS_FILE
}
pub fn telemetry_metrics_pos_file() -> &'static str {
    &TELEMETRY_METRICS_POS_FILE
}
pub fn telemetry_sandbox_ops_pos_file() -> &'static str {
    &TELEMETRY_SANDBOX_OPS_POS_FILE
}
