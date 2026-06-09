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
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Maximum captured stdout/stderr bytes.
    pub output_limits: ExecOutputLimits,
}

impl ExecRequest<'_> {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded operation into a zero-timeout request.
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
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded process into an unbounded one.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
}

fn duration_ms(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        0
    } else {
        u32::try_from(timeout.as_millis())
            .unwrap_or(u32::MAX)
            .max(1)
    }
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

impl CopyFileOptions {
    /// Return the timeout as milliseconds, saturating at `u32::MAX`.
    ///
    /// Non-zero sub-millisecond durations round up to 1ms so callers do not
    /// accidentally turn a bounded copy into a zero-timeout request.
    pub fn timeout_ms(&self) -> u32 {
        duration_ms(self.timeout)
    }
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

/// Backend-owned future that resolves after a best-effort process cancel request
/// has been sent to the guest.
pub type GuestProcessCancelFuture =
    Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + 'static>>;

type GuestProcessCancelFn = dyn FnOnce(Duration) -> GuestProcessCancelFuture + Send + 'static;

/// One-shot handle for asking the backend to cancel a started guest process.
pub struct GuestProcessCancelHandle {
    cancel: Box<GuestProcessCancelFn>,
}

impl GuestProcessCancelHandle {
    pub fn new<F>(cancel: F) -> Self
    where
        F: FnOnce(Duration) -> GuestProcessCancelFuture + Send + 'static,
    {
        Self {
            cancel: Box::new(cancel),
        }
    }

    pub async fn cancel(self, timeout: Duration) -> std::io::Result<()> {
        (self.cancel)(timeout).await
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
    /// Message id acknowledged by the provider for the submitted control
    /// payload.
    pub message_id: String,
}

/// Cloneable handle for sending opaque control payloads to a live guest process.
#[derive(Clone)]
pub struct GuestProcessControlHandle {
    control: Arc<GuestProcessControlFn>,
}

impl GuestProcessControlHandle {
    /// Construct a process-control handle from provider-owned send logic.
    ///
    /// The `sandbox` crate treats control payloads as opaque bytes. The
    /// provider and guest process define the payload schema and acknowledgement
    /// semantics for a given started process.
    pub fn new<F>(control: F) -> Self
    where
        F: Fn(String, Vec<u8>, Duration) -> GuestProcessControlFuture + Send + Sync + 'static,
    {
        Self {
            control: Arc::new(control),
        }
    }

    /// Send an opaque control payload to the live guest process.
    ///
    /// `message_id` identifies the control message for provider
    /// acknowledgement. `timeout` bounds how long the provider should wait for
    /// the control sink to acknowledge the payload.
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
    cancel: Option<GuestProcessCancelHandle>,
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
            cancel: None,
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

    /// Attach a one-shot process cancel handle provided by the backend.
    pub fn with_cancel_handle(mut self, cancel: GuestProcessCancelHandle) -> Self {
        self.cancel = Some(cancel);
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

    /// Consume the backend process cancel handle, if supported.
    pub fn take_cancel_handle(&mut self) -> Option<GuestProcessCancelHandle> {
        self.cancel.take()
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

/// Output handling mode for a process started with
/// [`Sandbox::start_process`](crate::Sandbox::start_process).
///
/// Buffered mode returns captured output in [`ProcessExit`]. Stream mode
/// requests real-time stdout delivery through
/// [`GuestProcessHandle::take_stdout_receiver`] when the provider returns a
/// receiver. Callers must handle providers that return no receiver and must
/// drain a returned receiver while the process runs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessOutputMode {
    /// Capture stdout and stderr into the final [`ProcessExit`].
    Buffered {
        /// Capture limits for stdout and stderr bytes retained in
        /// [`ProcessExit`].
        output_limits: ExecOutputLimits,
    },
    /// Request real-time stdout delivery through a bounded host receiver.
    ///
    /// This mode requests stdout streaming only. Provider-specific stderr
    /// handling may differ; the current Firecracker-backed provider discards
    /// stderr in stream mode instead of streaming or capturing it.
    Stream {
        /// Maximum stdout bytes the guest should emit as stream chunks.
        ///
        /// This is a guest-side stream budget. It is separate from captured
        /// output truncation and from host queue overflow.
        stream_limit_bytes: u32,
        /// Maximum bytes in a single stdout stream chunk.
        chunk_limit_bytes: u32,
        /// Capacity of the host-side stdout delivery queue.
        ///
        /// This bounds host buffering for delivered chunks. It is not a
        /// guarantee that a slow caller applies backpressure to the guest; host
        /// delivery overflow is reported through [`ProcessExit::stream_overflowed`].
        queue_capacity: usize,
    },
}

/// Process-control mode for a process started with
/// [`Sandbox::start_process`](crate::Sandbox::start_process).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessControlMode {
    /// Do not request a process-control sink.
    None,
    /// Request a provider-backed process-control sink.
    ///
    /// Providers may still return a process handle without a control handle.
    /// Callers must check [`GuestProcessHandle::control_handle`] on the returned
    /// process handle before sending control messages.
    Enabled,
}

impl ProcessOutputMode {
    /// Default stream byte budget for long-running process logs.
    pub const DEFAULT_STREAM_LIMIT_BYTES: u32 = 64 * 1024 * 1024;
    /// Default maximum size of each streamed process stdout chunk.
    pub const DEFAULT_CHUNK_LIMIT_BYTES: u32 = 8 * 1024;
    /// Default bounded host queue capacity for process stdout chunks.
    pub const DEFAULT_QUEUE_CAPACITY: usize = 8192;

    /// Return buffered output mode with the supplied capture limits.
    pub const fn buffered(output_limits: ExecOutputLimits) -> Self {
        Self::Buffered { output_limits }
    }

    /// Return stdout stream mode with bounded defaults.
    ///
    /// The defaults are [`DEFAULT_STREAM_LIMIT_BYTES`](Self::DEFAULT_STREAM_LIMIT_BYTES),
    /// [`DEFAULT_CHUNK_LIMIT_BYTES`](Self::DEFAULT_CHUNK_LIMIT_BYTES), and
    /// [`DEFAULT_QUEUE_CAPACITY`](Self::DEFAULT_QUEUE_CAPACITY).
    pub const fn stream() -> Self {
        Self::Stream {
            stream_limit_bytes: Self::DEFAULT_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: Self::DEFAULT_CHUNK_LIMIT_BYTES,
            queue_capacity: Self::DEFAULT_QUEUE_CAPACITY,
        }
    }

    /// Return whether this mode requests stdout streaming.
    ///
    /// A `true` return value does not guarantee the provider will return a
    /// receiver. Callers should inspect
    /// [`GuestProcessHandle::take_stdout_receiver`] on the started process
    /// handle.
    pub fn streams_stdout(self) -> bool {
        matches!(self, Self::Stream { .. })
    }
}

/// Terminal state reported by the process provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessTerminationKind {
    /// The process exited with an ordinary exit code.
    Exited,
    /// The provider timed the process out.
    TimedOut,
    /// The provider cancelled the process.
    Cancelled,
    /// The provider failed to start the process.
    StartFailed,
    /// The provider failed while waiting for the process.
    WaitFailed,
}

/// Terminal status and output metadata for a started guest process.
pub struct ProcessExit {
    /// Guest process id reported by the provider.
    pub pid: u32,
    /// Structured terminal state reported by the provider.
    ///
    /// This is separate from `exit_code`: providers still synthesize an exit
    /// code for timeout, cancel, start, and wait failures so older callers can
    /// continue using the existing completion code.
    pub termination: ProcessTerminationKind,
    /// Guest-reported wall-clock duration in milliseconds, when the provider has
    /// terminal duration metadata.
    pub guest_duration_ms: Option<u32>,
    /// Process exit code, or a provider-synthesized code for timeout, cancel,
    /// start, or wait failures.
    pub exit_code: i32,
    /// Captured stdout bytes.
    ///
    /// In stream mode, callers should read streamed stdout from
    /// [`GuestProcessHandle::take_stdout_receiver`] when a receiver is
    /// available instead of treating this field as a complete copy of stdout.
    pub stdout: Vec<u8>,
    /// Captured stderr bytes.
    ///
    /// Providers may include synthesized error text here for timeout, cancel,
    /// start, or wait failures.
    pub stderr: Vec<u8>,
    /// True when captured stdout exceeded the requested capture limit.
    pub stdout_truncated: bool,
    /// True when captured stderr exceeded the requested capture limit.
    pub stderr_truncated: bool,
    /// Provider or supervision diagnostic text.
    ///
    /// This is separate from ordinary process stderr.
    pub diagnostic: String,
    /// True when streamed output overflowed the host delivery queue.
    ///
    /// This is separate from captured-output truncation and from the
    /// per-chunk `truncated` flag on [`ProcessOutputChunk`].
    pub stream_overflowed: bool,
}

impl ProcessExit {
    /// Construct a process exit result with no truncation or stream metadata.
    ///
    /// The returned value sets `termination` to
    /// [`ProcessTerminationKind::Exited`], `guest_duration_ms` to `None`,
    /// `stdout_truncated` and `stderr_truncated` to `false`, `diagnostic` to an
    /// empty string, and `stream_overflowed` to `false`.
    pub fn new(pid: u32, exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            pid,
            termination: ProcessTerminationKind::Exited,
            guest_duration_ms: None,
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
            stdin_bytes: None,
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
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 0);
    }

    #[test]
    fn timeout_ms_rounds_nonzero_submillisecond_up() {
        let req = ExecRequest {
            cmd: "true",
            timeout: Duration::from_nanos(1),
            env: &[],
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        };
        assert_eq!(req.timeout_ms(), 1);
    }

    #[test]
    fn start_process_timeout_ms_rounds_nonzero_submillisecond_up() {
        let req = StartProcessRequest {
            cmd: "true",
            timeout: Duration::from_nanos(1),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        };
        assert_eq!(req.timeout_ms(), 1);
    }

    #[test]
    fn copy_file_timeout_ms_rounds_nonzero_submillisecond_up() {
        let options = CopyFileOptions {
            max_bytes: 1024,
            timeout: Duration::from_nanos(1),
            missing_ok: false,
        };
        assert_eq!(options.timeout_ms(), 1);
    }

    #[test]
    fn timeout_ms_saturates_at_u32_max() {
        let req = ExecRequest {
            cmd: "sleep infinity",
            timeout: Duration::from_secs(u64::MAX / 1000),
            env: &[],
            sudo: false,
            stdin_bytes: None,
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
            stdin_bytes: None,
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
        assert_eq!(exit.termination, ProcessTerminationKind::Exited);
        assert_eq!(exit.guest_duration_ms, None);
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

    #[test]
    fn guest_process_handle_takes_cancel_handle_once() {
        let mut handle = GuestProcessHandle::new(
            42,
            None,
            None,
            GuestProcessWaiter::new(|_| {
                Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
            }),
        )
        .with_cancel_handle(GuestProcessCancelHandle::new(|_| {
            Box::pin(async { Ok(()) })
        }));

        assert!(handle.take_cancel_handle().is_some());
        assert!(handle.take_cancel_handle().is_none());
    }
}
