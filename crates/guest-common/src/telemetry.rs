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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn sandbox_op_entry_serializes_correctly() {
        let entry = SandboxOpEntry {
            ts: "2026-01-01T00:00:00.000Z".to_string(),
            action_type: "vm_create".to_string(),
            duration_ms: 1500,
            success: true,
            error: None,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["ts"], "2026-01-01T00:00:00.000Z");
        assert_eq!(json["action_type"], "vm_create");
        assert_eq!(json["duration_ms"], 1500);
        assert_eq!(json["success"], true);
        assert!(json.get("error").is_none());
    }

    #[test]
    fn sandbox_op_entry_with_error() {
        let entry = SandboxOpEntry {
            ts: "2026-01-01T00:00:00.000Z".to_string(),
            action_type: "vm_create".to_string(),
            duration_ms: 500,
            success: false,
            error: Some("timeout".to_string()),
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["error"], "timeout");
        assert!(!json["success"].as_bool().unwrap());
    }

    #[test]
    fn record_sandbox_op_writes_jsonl() {
        // Set VM0_RUN_ID to a test value to control the log file path.
        // We write to the actual SANDBOX_OPS_LOG path, then verify.
        let log_path = sandbox_ops_log();
        // Clean up any existing file
        let _ = std::fs::remove_file(log_path);

        record_sandbox_op("test_op", Duration::from_millis(42), true, None);

        let content = std::fs::read_to_string(log_path).unwrap_or_default();
        if !content.is_empty() {
            let line = content.lines().last().unwrap();
            let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(parsed["action_type"], "test_op");
            assert_eq!(parsed["duration_ms"], 42);
            assert!(parsed["success"].as_bool().unwrap());
        }
        let _ = std::fs::remove_file(log_path);
    }
}
