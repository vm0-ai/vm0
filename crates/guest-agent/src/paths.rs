//! Derived temp-file paths — all scoped to the current run ID.
//!
//! Naming conventions:
//! - "system log" = guest-agent's own stderr (matches TS `SYSTEM_LOG_FILE` and API `systemLog`)
//! - "agent log" = AI agent (Claude Code) stdout output
//! - "metrics" = periodic CPU/memory/disk snapshots
//! - "sandbox ops" = operation timing records (defined in guest-common, re-exported here)

use crate::env;
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

static SESSION_ID_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-session-{}.txt", env::run_id()));
static SESSION_HISTORY_PATH_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-session-history-{}.txt", env::run_id()));

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
    LazyLock::new(|| format!("/tmp/vm0-event-error-{}", env::run_id()));
static CHECKPOINT_ERROR_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-checkpoint-error-{}", env::run_id()));
static FAILURE_DIAGNOSTIC_FILE: LazyLock<String> =
    LazyLock::new(|| agent_diagnostics::failure_diagnostic_file(env::run_id()));
static SYSTEM_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-system-{}.log", env::run_id()));
static AGENT_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-agent-{}.log", env::run_id()));
static METRICS_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-metrics-{}.jsonl", env::run_id()));

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

static TELEMETRY_SYSTEM_LOG_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-system-log-pos-{}.txt", env::run_id()));
static TELEMETRY_METRICS_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-metrics-pos-{}.txt", env::run_id()));
static TELEMETRY_SANDBOX_OPS_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-sandbox-ops-pos-{}.txt", env::run_id()));

pub fn telemetry_system_log_pos_file() -> &'static str {
    &TELEMETRY_SYSTEM_LOG_POS_FILE
}
pub fn telemetry_metrics_pos_file() -> &'static str {
    &TELEMETRY_METRICS_POS_FILE
}
pub fn telemetry_sandbox_ops_pos_file() -> &'static str {
    &TELEMETRY_SANDBOX_OPS_POS_FILE
}
