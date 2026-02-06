//! Environment variable accessors for VM scripts.

use std::sync::LazyLock;

static RUN_ID: LazyLock<String> = LazyLock::new(|| std::env::var("VM0_RUN_ID").unwrap_or_default());

/// Get the run ID (VM0_RUN_ID environment variable).
/// Cached on first access.
pub fn run_id() -> &'static str {
    &RUN_ID
}
