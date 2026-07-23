//! One-shot Codex thread path lookup contract shared by runner and guest-agent.

use serde::{Deserialize, Serialize};

/// Maximum serialized size accepted for a Codex thread path lookup report.
pub const CODEX_THREAD_PATH_LOOKUP_REPORT_MAX_BYTES: usize = 16 * 1024;
/// Helper completed successfully and emitted a lookup report.
pub const CODEX_THREAD_PATH_LOOKUP_EXIT_SUCCESS: i32 = 0;
/// Helper failed to query Codex for the thread path.
pub const CODEX_THREAD_PATH_LOOKUP_EXIT_FAILURE: i32 = 1;
/// Helper request arguments were invalid.
pub const CODEX_THREAD_PATH_LOOKUP_EXIT_INVALID_ARGS: i32 = 2;

/// Result of asking Codex for its recorded rollout path for one thread.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum CodexThreadPathLookupReport {
    /// Codex has a recorded logical `.jsonl` rollout path.
    Found {
        /// Path returned by Codex app-server.
        path: String,
    },
    /// Codex has no local record for the requested thread.
    NotFound {},
}
