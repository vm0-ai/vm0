//! File path constants for VM scripts.

use crate::env;

/// Path to sandbox operations log file (JSONL format).
pub fn sandbox_ops_log() -> String {
    format!("/tmp/vm0-sandbox-ops-{}.jsonl", env::run_id())
}

/// Path to system log file.
pub fn system_log() -> String {
    format!("/tmp/vm0-main-{}.log", env::run_id())
}
