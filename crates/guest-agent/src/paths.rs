//! Derived temp-file paths — all scoped to the current run ID.

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
static SYSTEM_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-main-{}.log", env::run_id()));
static AGENT_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-agent-{}.log", env::run_id()));
static METRICS_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-metrics-{}.jsonl", env::run_id()));
static NETWORK_LOG_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-network-{}.jsonl", env::run_id()));

pub fn event_error_flag() -> &'static str {
    &EVENT_ERROR_FLAG
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
pub fn network_log_file() -> &'static str {
    &NETWORK_LOG_FILE
}

// ---------------------------------------------------------------------------
// Telemetry position tracking
// ---------------------------------------------------------------------------

static TELEMETRY_LOG_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-log-pos-{}.txt", env::run_id()));
static TELEMETRY_METRICS_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-metrics-pos-{}.txt", env::run_id()));
static TELEMETRY_NETWORK_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-network-pos-{}.txt", env::run_id()));
static TELEMETRY_SANDBOX_OPS_POS_FILE: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-telemetry-sandbox-ops-pos-{}.txt", env::run_id()));

pub fn telemetry_log_pos_file() -> &'static str {
    &TELEMETRY_LOG_POS_FILE
}
pub fn telemetry_metrics_pos_file() -> &'static str {
    &TELEMETRY_METRICS_POS_FILE
}
pub fn telemetry_network_pos_file() -> &'static str {
    &TELEMETRY_NETWORK_POS_FILE
}
pub fn telemetry_sandbox_ops_pos_file() -> &'static str {
    &TELEMETRY_SANDBOX_OPS_POS_FILE
}
