//! Exit-status contract for non-terminal Pi standby release.

/// Standby TTL expired before handoff. Runner reports this status to the API,
/// which cancels the still-active run and removes its standby job.
pub const TTL_RELEASE_EXIT_CODE: i32 = 75;
