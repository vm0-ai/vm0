use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Capture budgets for stdout/stderr returned by [`ExecRequest`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecOutputLimits {
    /// Maximum stdout bytes to retain in [`ExecResult::stdout`].
    pub stdout_limit_bytes: u32,
    /// Maximum stderr bytes to retain in [`ExecResult::stderr`].
    pub stderr_limit_bytes: u32,
}

impl ExecOutputLimits {
    /// Use the same capture budget for stdout and stderr.
    pub const fn same(limit_bytes: u32) -> Self {
        Self {
            stdout_limit_bytes: limit_bytes,
            stderr_limit_bytes: limit_bytes,
        }
    }

    /// Use separate stdout and stderr capture budgets.
    pub const fn separate(stdout_limit_bytes: u32, stderr_limit_bytes: u32) -> Self {
        Self {
            stdout_limit_bytes,
            stderr_limit_bytes,
        }
    }
}

/// Small diagnostic output budget for helper commands.
pub const EXEC_OUTPUT_LIMIT_64_KIB: ExecOutputLimits = ExecOutputLimits::same(64 * 1024);
/// Default output budget for ordinary bounded guest commands.
pub const EXEC_OUTPUT_LIMIT_1_MIB: ExecOutputLimits = ExecOutputLimits::same(1024 * 1024);
/// Larger output budget used by interactive runner exec-style tooling.
pub const EXEC_OUTPUT_LIMIT_7_MIB: ExecOutputLimits = ExecOutputLimits::same(7 * 1024 * 1024);

/// Request for a bounded command whose output is captured in memory.
pub struct ExecRequest<'a> {
    /// Shell command to run inside the guest.
    pub cmd: &'a str,
    /// Guest-side command timeout.
    pub timeout: Duration,
    /// Environment variables passed to the command.
    pub env: &'a [(&'a str, &'a str)],
    /// Run the command with guest-side sudo privileges.
    pub sudo: bool,
    /// Maximum captured stdout/stderr bytes.
    pub output_limits: ExecOutputLimits,
}

impl ExecRequest<'_> {
    /// Return the timeout as whole milliseconds, saturating at `u32::MAX`.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

/// Request for a watched command whose process can outlive the initial spawn
/// request and is supervised through [`SpawnHandle`].
pub struct SpawnWatchRequest<'a> {
    /// Shell command to run inside the guest.
    pub cmd: &'a str,
    /// Guest-side process timeout.
    pub timeout: Duration,
    /// Environment variables passed to the command.
    pub env: &'a [(&'a str, &'a str)],
    /// Run the command with guest-side sudo privileges.
    pub sudo: bool,
    /// Buffered or streamed stdout behavior.
    pub output: SpawnOutputMode<'a>,
}

impl SpawnWatchRequest<'_> {
    /// Return the timeout as whole milliseconds, saturating at `u32::MAX`.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

fn duration_ms(timeout: Duration) -> u32 {
    u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX)
}

/// Result of a bounded command execution.
pub struct ExecResult {
    /// Process exit code, or a synthetic code for timeout/cancel failures.
    pub exit_code: i32,
    /// Captured stdout bytes, capped by the requested output limit.
    pub stdout: Vec<u8>,
    /// Captured stderr bytes, capped by the requested output limit.
    pub stderr: Vec<u8>,
    /// True when stdout exceeded the requested output limit.
    pub stdout_truncated: bool,
    /// True when stderr exceeded the requested output limit.
    pub stderr_truncated: bool,
}

impl ExecResult {
    pub fn new(exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            exit_code,
            stdout,
            stderr,
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }
}

/// Options for copying a guest file to a host path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyFileOptions {
    /// Maximum bytes to copy before failing.
    pub max_bytes: u64,
    /// Guest-side copy command timeout.
    pub timeout: Duration,
    /// Treat a missing guest file as a successful zero-byte copy.
    pub missing_ok: bool,
}

/// Result of copying a guest file to a host path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyFileResult {
    /// Number of bytes copied into the host file.
    pub bytes_copied: u64,
}

/// Backend-owned future that resolves when a watched process exits.
///
/// Sandbox implementations store this in [`SpawnHandle`] so
/// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit) can consume the exact
/// backend operation created by [`Sandbox::spawn_watch`](crate::Sandbox::spawn_watch).
pub type SpawnExitFuture =
    Pin<Box<dyn Future<Output = std::io::Result<ProcessExit>> + Send + 'static>>;

/// Handle returned by [`Sandbox::spawn_watch`](crate::Sandbox::spawn_watch).
///
/// The handle owns backend-specific exit state and must be consumed by
/// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit). When stdout streaming is
/// enabled, callers may take [`stdout_rx`](Self::stdout_rx) before waiting; if
/// they do, they must drain it while the process runs.
pub struct SpawnHandle {
    pub pid: u32,
    /// Receives stdout chunks in real-time when the guest streams them.
    /// `None` when the backend does not support streaming.
    pub stdout_rx: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
    exit: Option<SpawnExitFuture>,
}

impl SpawnHandle {
    /// Construct a spawn handle from backend-owned process state.
    pub fn new(
        pid: u32,
        stdout_rx: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
        exit: SpawnExitFuture,
    ) -> Self {
        Self {
            pid,
            stdout_rx,
            exit: Some(exit),
        }
    }

    /// Consume the backend exit future.
    ///
    /// This is intended for sandbox backend implementations of
    /// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit); ordinary callers should
    /// pass the handle to that trait method instead.
    pub fn take_exit_future(&mut self) -> Option<SpawnExitFuture> {
        self.exit.take()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpawnOutputMode<'a> {
    Buffered,
    Stream { guest_log_path: Option<&'a str> },
}

impl<'a> SpawnOutputMode<'a> {
    pub fn streams_stdout(self) -> bool {
        matches!(self, Self::Stream { .. })
    }

    pub fn guest_log_path(self) -> Option<&'a str> {
        match self {
            Self::Buffered => None,
            Self::Stream { guest_log_path } => guest_log_path,
        }
    }
}

pub struct ProcessExit {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_ms_normal() {
        let req = ExecRequest {
            cmd: "echo hi",
            timeout: Duration::from_millis(5000),
            env: &[],
            sudo: false,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 5000);
    }

    #[test]
    fn timeout_ms_zero() {
        let req = ExecRequest {
            cmd: "true",
            timeout: Duration::ZERO,
            env: &[],
            sudo: false,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 0);
    }

    #[test]
    fn timeout_ms_saturates_at_u32_max() {
        let req = ExecRequest {
            cmd: "sleep infinity",
            timeout: Duration::from_secs(u64::MAX / 1000),
            env: &[],
            sudo: false,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }

    #[test]
    fn timeout_ms_exact_u32_max() {
        let req = ExecRequest {
            cmd: "cmd",
            timeout: Duration::from_millis(u32::MAX as u64),
            env: &[],
            sudo: false,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }
}
