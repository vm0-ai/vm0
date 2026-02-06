//! File path constants for VM scripts.

use crate::env;
use std::sync::LazyLock;

static SANDBOX_OPS_LOG: LazyLock<String> =
    LazyLock::new(|| format!("/tmp/vm0-sandbox-ops-{}.jsonl", env::run_id()));

/// Path to sandbox operations log file (JSONL format).
/// Cached on first access.
pub fn sandbox_ops_log() -> &'static str {
    &SANDBOX_OPS_LOG
}
