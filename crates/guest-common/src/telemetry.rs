//! Telemetry recording for sandbox operations.

use crate::log;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::LazyLock;
use std::time::Duration;

static RUN_ID: LazyLock<String> = LazyLock::new(|| std::env::var("VM0_RUN_ID").unwrap_or_default());

static SANDBOX_OPS_LOG: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-sandbox-ops-{}.jsonl", &*RUN_ID));

/// Path to sandbox operations log file (JSONL format).
pub fn sandbox_ops_log() -> &'static str {
    &SANDBOX_OPS_LOG
}

#[derive(Serialize)]
struct SandboxOpEntry {
    ts: String,
    action_type: String,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Record a sandbox operation to the telemetry log.
///
/// Writes a JSONL entry to `/tmp/vm0-sandbox-ops-{RUN_ID}.jsonl`.
/// Format is compatible with the TypeScript version for consistency.
pub fn record_sandbox_op(
    action_type: &str,
    duration: Duration,
    success: bool,
    error: Option<&str>,
) {
    let entry = SandboxOpEntry {
        ts: log::timestamp(),
        action_type: action_type.to_string(),
        duration_ms: duration.as_millis() as u64,
        success,
        error: error.map(String::from),
    };

    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(sandbox_ops_log())
    else {
        return; // Silently fail if can't open log
    };

    let Ok(json) = serde_json::to_string(&entry) else {
        return;
    };

    let _ = writeln!(file, "{json}");
}
