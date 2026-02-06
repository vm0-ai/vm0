//! Environment variable accessors for VM scripts.

/// Get the run ID (VM0_RUN_ID environment variable).
pub fn run_id() -> String {
    std::env::var("VM0_RUN_ID").unwrap_or_default()
}

/// Check if debug mode is enabled (VM0_DEBUG=1).
pub fn debug_enabled() -> bool {
    std::env::var("VM0_DEBUG")
        .map(|v| v == "1")
        .unwrap_or(false)
}
