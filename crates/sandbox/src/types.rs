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

/// Request for a guest process that can outlive the initial start request and
/// is supervised through [`GuestProcessHandle`].
pub struct StartProcessRequest<'a> {
    /// Shell command to run inside the guest.
    pub cmd: &'a str,
    /// Guest-side process timeout.
    pub timeout: Duration,
    /// Environment variables passed to the command.
    pub env: &'a [(&'a str, &'a str)],
    /// Run the command with guest-side sudo privileges.
    pub sudo: bool,
    /// Buffered or streamed stdout behavior.
    pub output: ProcessOutputMode,
    /// Optional operation-bound control sink requested for the started process.
    pub control: ProcessControlMode,
}

impl StartProcessRequest<'_> {
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

/// Process stdout stream event delivered to sandbox callers.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProcessOutputChunk {
    /// Output bytes from the guest process stdout stream.
    pub bytes: Vec<u8>,
    /// True when this chunk was truncated by the guest stream budget.
    pub truncated: bool,
}

/// Bounded receiver for process stdout chunks.
pub type ProcessOutputReceiver = tokio::sync::mpsc::Receiver<ProcessOutputChunk>;

/// Backend-owned future that resolves when a started process exits.
///
/// Sandbox implementations store this in [`GuestProcessHandle`] so
/// [`Sandbox::wait_process`](crate::Sandbox::wait_process) can consume the exact
/// backend operation created by [`Sandbox::start_process`](crate::Sandbox::start_process).
pub type GuestProcessWaitFuture =
    Pin<Box<dyn Future<Output = std::io::Result<ProcessExit>> + Send + 'static>>;

type GuestProcessWaitFn = dyn FnOnce(Duration) -> GuestProcessWaitFuture + Send + 'static;

/// Backend-owned process waiter that accepts the host-side wait timeout.
pub struct GuestProcessWaiter {
    wait: Box<GuestProcessWaitFn>,
}

impl GuestProcessWaiter {
    pub fn new<F>(wait: F) -> Self
    where
        F: FnOnce(Duration) -> GuestProcessWaitFuture + Send + 'static,
    {
        Self {
            wait: Box::new(wait),
        }
    }

    pub fn wait(self, timeout: Duration) -> GuestProcessWaitFuture {
        (self.wait)(timeout)
    }
}

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

/// Handle returned by [`Sandbox::start_process`](crate::Sandbox::start_process).
///
/// The handle owns backend-specific exit state and must be consumed by
/// [`Sandbox::wait_process`](crate::Sandbox::wait_process). When stdout streaming is
/// enabled, callers may use [`take_stdout_receiver`](Self::take_stdout_receiver)
/// before waiting; if they do, they must drain it while the process runs.
pub struct GuestProcessHandle {
    pub pid: u32,
    /// Receives stdout chunks in real-time when the guest streams them.
    /// `None` when the backend does not support streaming.
    stdout_rx: Option<ProcessOutputReceiver>,
    control: Option<GuestProcessControlHandle>,
    wait: Option<GuestProcessWaiter>,
    close_unclaimed_stdout: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl GuestProcessHandle {
    /// Construct a guest process handle from backend-owned process state.
    pub fn new(
        pid: u32,
        stdout_rx: Option<ProcessOutputReceiver>,
        control: Option<GuestProcessControlHandle>,
        wait: GuestProcessWaiter,
    ) -> Self {
        Self {
            pid,
            stdout_rx,
            control,
            wait: Some(wait),
            close_unclaimed_stdout: None,
        }
    }

    /// Return whether this handle currently owns a stdout receiver.
    pub fn has_stdout_receiver(&self) -> bool {
        self.stdout_rx.is_some()
    }

    /// Take the stdout receiver so the caller can drain streamed output.
    pub fn take_stdout_receiver(&mut self) -> Option<ProcessOutputReceiver> {
        self.stdout_rx.take()
    }

    /// Register backend cleanup for an unclaimed stdout receiver.
    pub fn with_unclaimed_stdout_cleanup<F>(mut self, close: F) -> Self
    where
        F: FnOnce() + Send + 'static,
    {
        self.close_unclaimed_stdout = Some(Box::new(close));
        self
    }

    /// Return a cloneable control handle when this process was started with a
    /// control sink.
    pub fn control_handle(&self) -> Option<GuestProcessControlHandle> {
        self.control.clone()
    }

    /// Consume the backend process waiter.
    ///
    /// This is intended for sandbox backend implementations of
    /// [`Sandbox::wait_process`](crate::Sandbox::wait_process); ordinary callers should
    /// pass the handle to that trait method instead.
    pub fn take_waiter(&mut self) -> Option<GuestProcessWaiter> {
        self.wait.take()
    }

    /// Drop a stdout receiver that the caller did not take before waiting.
    pub fn drop_unclaimed_stdout(&mut self) {
        if self.stdout_rx.take().is_some()
            && let Some(close) = self.close_unclaimed_stdout.take()
        {
            close();
        }
    }
}

impl Drop for GuestProcessHandle {
    fn drop(&mut self) {
        self.drop_unclaimed_stdout();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessOutputMode {
    Buffered {
        output_limits: ExecOutputLimits,
    },
    Stream {
        stream_limit_bytes: u32,
        chunk_limit_bytes: u32,
        queue_capacity: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessControlMode {
    None,
    Enabled,
}

impl ProcessOutputMode {
    /// Default stream byte budget for long-running process logs.
    pub const DEFAULT_STREAM_LIMIT_BYTES: u32 = 64 * 1024 * 1024;
    /// Default maximum size of each streamed process stdout chunk.
    pub const DEFAULT_CHUNK_LIMIT_BYTES: u32 = 8 * 1024;
    /// Default bounded host queue capacity for process stdout chunks.
    pub const DEFAULT_QUEUE_CAPACITY: usize = 8192;

    pub const fn buffered(output_limits: ExecOutputLimits) -> Self {
        Self::Buffered { output_limits }
    }

    pub const fn stream() -> Self {
        Self::Stream {
            stream_limit_bytes: Self::DEFAULT_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: Self::DEFAULT_CHUNK_LIMIT_BYTES,
            queue_capacity: Self::DEFAULT_QUEUE_CAPACITY,
        }
    }

    pub fn streams_stdout(self) -> bool {
        matches!(self, Self::Stream { .. })
    }
}

pub struct ProcessExit {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub diagnostic: String,
    pub stream_overflowed: bool,
}

impl ProcessExit {
    pub fn new(pid: u32, exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            pid,
            exit_code,
            stdout,
            stderr,
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: String::new(),
            stream_overflowed: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

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

    #[test]
    fn process_output_mode_stream_uses_bounded_defaults() {
        assert_eq!(
            ProcessOutputMode::stream(),
            ProcessOutputMode::Stream {
                stream_limit_bytes: ProcessOutputMode::DEFAULT_STREAM_LIMIT_BYTES,
                chunk_limit_bytes: ProcessOutputMode::DEFAULT_CHUNK_LIMIT_BYTES,
                queue_capacity: ProcessOutputMode::DEFAULT_QUEUE_CAPACITY,
            }
        );
    }

    #[test]
    fn process_exit_new_defaults_supervised_metadata() {
        let exit = ProcessExit::new(42, 7, b"out".to_vec(), b"err".to_vec());

        assert_eq!(exit.pid, 42);
        assert_eq!(exit.exit_code, 7);
        assert_eq!(exit.stdout, b"out");
        assert_eq!(exit.stderr, b"err");
        assert!(!exit.stdout_truncated);
        assert!(!exit.stderr_truncated);
        assert!(exit.diagnostic.is_empty());
        assert!(!exit.stream_overflowed);
    }

    #[test]
    fn guest_process_handle_closes_only_unclaimed_stdout() {
        let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let close_observed = Arc::clone(&closed);
        let mut handle = GuestProcessHandle::new(
            42,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_unclaimed_stdout_cleanup(move || {
            close_observed.store(true, Ordering::SeqCst);
        });

        let _claimed_stdout = handle.take_stdout_receiver();
        handle.drop_unclaimed_stdout();

        assert!(!closed.load(Ordering::SeqCst));
    }

    #[test]
    fn guest_process_handle_closes_unclaimed_stdout() {
        let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let close_observed = Arc::clone(&closed);
        let mut handle = GuestProcessHandle::new(
            42,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_unclaimed_stdout_cleanup(move || {
            close_observed.store(true, Ordering::SeqCst);
        });

        handle.drop_unclaimed_stdout();

        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn guest_process_handle_drop_closes_unclaimed_stdout() {
        let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let close_observed = Arc::clone(&closed);
        let handle = GuestProcessHandle::new(
            42,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_unclaimed_stdout_cleanup(move || {
            close_observed.store(true, Ordering::SeqCst);
        });

        drop(handle);

        assert!(closed.load(Ordering::SeqCst));
    }
}
