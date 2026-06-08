//! Telemetry recording for sandbox operations.

use crate::log;
use serde::Serialize;
use std::io::Write;
use std::sync::LazyLock;
use std::time::Duration;

static RUN_ID: LazyLock<String> = LazyLock::new(|| std::env::var("VM0_RUN_ID").unwrap_or_default());

static SANDBOX_OPS_LOG: LazyLock<String> = LazyLock::new(|| {
    let Ok(run_dir) = guest_runtime_paths::run_dir_from_env(&RUN_ID) else {
        return String::new();
    };
    guest_runtime_paths::sandbox_ops_log_file(run_dir)
        .to_string_lossy()
        .into_owned()
});

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
/// Writes a JSONL entry to the guest runtime sandbox operations log.
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

    let path = sandbox_ops_log();
    if path.is_empty() {
        return;
    }

    let Ok(mut file) = guest_runtime_paths::open_private_append(path) else {
        return; // Silently fail if can't open log
    };

    let Ok(json) = serde_json::to_string(&entry) else {
        return;
    };

    let _ = writeln!(file, "{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn record_sandbox_op_writes_and_appends_jsonl() {
        // Single test because all calls share the same static log path.
        let dir = tempfile::tempdir().unwrap();
        let runtime_dir = dir.path().join("runtime");
        unsafe {
            std::env::set_var(guest_runtime_paths::GUEST_RUNTIME_DIR_ENV, &runtime_dir);
        }
        let log_path = sandbox_ops_log();
        let _ = std::fs::remove_file(log_path);

        record_sandbox_op("op_a", Duration::from_millis(10), true, None);
        record_sandbox_op("op_b", Duration::from_millis(20), false, Some("fail"));

        let content = std::fs::read_to_string(log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);

        let a: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(a["action_type"], "op_a");
        assert_eq!(a["duration_ms"], 10);
        assert!(a["success"].as_bool().unwrap());
        assert!(a["ts"].is_string());

        let b: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(b["action_type"], "op_b");
        assert_eq!(b["error"], "fail");
        assert!(!b["success"].as_bool().unwrap());

        let _ = std::fs::remove_file(log_path);
        unsafe {
            std::env::remove_var(guest_runtime_paths::GUEST_RUNTIME_DIR_ENV);
        }
    }
}
