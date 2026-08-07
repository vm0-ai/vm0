//! Exit-status contract for non-terminal Pi standby release.

/// Standby TTL expired before handoff. Runner reports this status to the API,
/// which requeues the retained exact execution context onto the cold-start
/// profile instead of terminating the run.
pub const TTL_RELEASE_EXIT_CODE: i32 = 75;
