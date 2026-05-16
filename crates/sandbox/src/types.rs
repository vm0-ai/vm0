use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
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

/// Request for a guest process that can outlive the initial spawn request and
/// is supervised through [`GuestProcessHandle`].
pub struct SpawnProcessRequest<'a> {
    /// Shell command to run inside the guest.
    pub cmd: &'a str,
    /// Guest-side process timeout.
    pub timeout: Duration,
    /// Environment variables passed to the command.
    pub env: &'a [(&'a str, &'a str)],
    /// Run the command with guest-side sudo privileges.
    pub sudo: bool,
    /// Buffered or streamed stdout behavior.
    pub output: SpawnProcessOutputMode<'a>,
    /// Optional operation-bound control sink requested for the spawned process.
    pub control: SpawnProcessControl,
}

impl SpawnProcessRequest<'_> {
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

/// Backend-owned future that resolves when a spawned process exits.
///
/// Sandbox implementations store this in [`GuestProcessHandle`] so
/// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit) can consume the exact
/// backend operation created by [`Sandbox::spawn_process`](crate::Sandbox::spawn_process).
pub type GuestProcessExitFuture =
    Pin<Box<dyn Future<Output = std::io::Result<ProcessExit>> + Send + 'static>>;

/// Backend-owned future that resolves when a process-control message is acknowledged.
pub type GuestProcessControlFuture =
    Pin<Box<dyn Future<Output = std::io::Result<ProcessControlAck>> + Send + 'static>>;

type GuestProcessControlFn =
    dyn Fn(String, Vec<u8>, Duration) -> GuestProcessControlFuture + Send + Sync + 'static;

/// Acknowledgement returned by an operation-bound process-control sink.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProcessControlAck {
    pub message_id: String,
}

/// Cloneable handle for sending opaque control payloads to a live guest process.
#[derive(Clone)]
pub struct GuestProcessControlHandle {
    control: Arc<GuestProcessControlFn>,
}

impl GuestProcessControlHandle {
    pub fn new<F>(control: F) -> Self
    where
        F: Fn(String, Vec<u8>, Duration) -> GuestProcessControlFuture + Send + Sync + 'static,
    {
        Self {
            control: Arc::new(control),
        }
    }

    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> std::io::Result<ProcessControlAck> {
        (self.control)(message_id.to_owned(), payload.to_vec(), timeout).await
    }
}

/// Handle returned by [`Sandbox::spawn_process`](crate::Sandbox::spawn_process).
///
/// The handle owns backend-specific exit state and must be consumed by
/// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit). When stdout streaming is
/// enabled, callers may take [`stdout_rx`](Self::stdout_rx) before waiting; if
/// they do, they must drain it while the process runs.
pub struct GuestProcessHandle {
    pub pid: u32,
    /// Receives stdout chunks in real-time when the guest streams them.
    /// `None` when the backend does not support streaming.
    pub stdout_rx: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
    control: Option<GuestProcessControlHandle>,
    exit: Option<GuestProcessExitFuture>,
}

impl GuestProcessHandle {
    /// Construct a guest process handle from backend-owned process state.
    pub fn new(
        pid: u32,
        stdout_rx: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
        control: Option<GuestProcessControlHandle>,
        exit: GuestProcessExitFuture,
    ) -> Self {
        Self {
            pid,
            stdout_rx,
            control,
            exit: Some(exit),
        }
    }

    /// Return a cloneable control handle when this process was spawned with a
    /// control sink.
    pub fn control_handle(&self) -> Option<GuestProcessControlHandle> {
        self.control.clone()
    }

    /// Consume the backend exit future.
    ///
    /// This is intended for sandbox backend implementations of
    /// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit); ordinary callers should
    /// pass the handle to that trait method instead.
    pub fn take_exit_future(&mut self) -> Option<GuestProcessExitFuture> {
        self.exit.take()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpawnProcessOutputMode<'a> {
    Buffered,
    Stream { guest_log_path: Option<&'a str> },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpawnProcessControl {
    None,
    Enabled,
}

impl<'a> SpawnProcessOutputMode<'a> {
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
