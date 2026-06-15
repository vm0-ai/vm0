//! Constants.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Heartbeat interval in seconds.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 60;

/// Telemetry upload interval in seconds.
pub const TELEMETRY_INTERVAL_SECS: u64 = 30;

/// Metrics collection interval in seconds.
pub const METRICS_INTERVAL_SECS: u64 = 5;

/// Max HTTP retries for webhook calls.
pub const HTTP_MAX_RETRIES: u32 = 3;

/// HTTP connect timeout in seconds.
pub const HTTP_CONNECT_TIMEOUT_SECS: u64 = 10;

/// HTTP request timeout in seconds.
pub const HTTP_TIMEOUT_SECS: u64 = 30;

/// HTTP request timeout for uploads in seconds.
pub const HTTP_UPLOAD_TIMEOUT_SECS: u64 = 60;

/// Workaround for Claude Code bug where WebSearch/WebFetch hang indefinitely.
/// Kill the CLI process if a network tool hasn't returned a result within
/// this duration.  Override with `VM0_STUCK_TOOL_TIMEOUT_SECS` env var.
/// See: https://github.com/anthropics/claude-code/issues/11650
pub const STUCK_TOOL_TIMEOUT_SECS: u64 = 180;

/// How often (in seconds) to check for stuck tools in the select loop.
pub const STUCK_TOOL_CHECK_INTERVAL_SECS: u64 = 5;

/// After the CLI process exits, continue reading stdout for this many seconds.
/// If EOF is not received within this deadline, break the loop to prevent
/// hanging on orphaned child processes that inherited the stdout fd.
pub const STDOUT_DRAIN_DEADLINE_SECS: u64 = 5;

/// Grace period after observing a `type=result` event before SIGTERM-ing the
/// CLI process group. In vm0's one-shot web-agent integration the turn is
/// complete when the CLI emits its final `result`, but the CLI itself may
/// still be blocked draining long-running backgrounded Bash tasks it spawned
/// via its 2-minute auto-background timeout. Those tasks have been observed
/// holding the sandbox alive for tens of minutes until external cancel.
/// See: https://github.com/vm0-ai/vm0/issues/10879
pub const POST_RESULT_SIGTERM_GRACE_SECS: u64 = 10;

/// Follow-up window after SIGTERM before escalating to SIGKILL when the CLI
/// process group ignores the graceful signal.
pub const POST_RESULT_SIGKILL_GRACE_SECS: u64 = 5;

/// Maximum consecutive heartbeat failures before terminating the run.
/// Each heartbeat attempt already retries `HTTP_MAX_RETRIES` times internally,
/// so 3 consecutive failures = 9 total HTTP attempts over ~3 minutes.
pub const MAX_CONSECUTIVE_HEARTBEAT_FAILURES: u32 = 3;
