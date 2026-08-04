//! Shared guest exec terminal-cleanup budgets.

use std::time::Duration;

/// Graceful wait after signaling contained descendants with `SIGTERM`.
pub const EXEC_PROCESS_CONTAINMENT_TERM_GRACE: Duration = Duration::from_millis(500);

/// Maximum wait for a contained cgroup to become empty after `cgroup.kill`.
pub const EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT: Duration = Duration::from_secs(1);

/// Maximum retry window for removing an empty exec cgroup.
pub const EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT: Duration = Duration::from_millis(250);

/// Maximum time to drain a guest-managed child's stdout/stderr after exit.
pub const EXEC_OUTPUT_DRAIN_DEADLINE: Duration = Duration::from_secs(5);

/// Maximum configured wait budget before a guest exec terminal result is built.
///
/// This conservatively includes the graceful containment path followed by the
/// output-drain deadline. Forced cancellation and timeout cleanup skip
/// [`EXEC_PROCESS_CONTAINMENT_TERM_GRACE`]. Scheduling, syscall, drain-poll,
/// and terminal-frame delivery latency are not part of this configured budget.
pub const EXEC_TERMINAL_CLEANUP_BUDGET: Duration = EXEC_PROCESS_CONTAINMENT_TERM_GRACE
    .saturating_add(EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT)
    .saturating_add(EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT)
    .saturating_add(EXEC_OUTPUT_DRAIN_DEADLINE);

const _: () = assert!(
    EXEC_TERMINAL_CLEANUP_BUDGET.as_millis() == 6_750,
    "guest exec terminal cleanup budget changed; review runner host grace"
);
