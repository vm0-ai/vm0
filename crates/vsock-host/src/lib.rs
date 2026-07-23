//! Host-side vsock endpoint for Firecracker VM communication.
//!
//! Connects to a guest agent via Unix domain socket (Firecracker forwards
//! vsock connections to `{vsock_path}_{port}` UDS files).
//!
//! ## Connection Flow
//!
//! 1. Host creates UDS listener at `{vsock_path}_{port}`
//! 2. Guest boots and vsock-guest connects to CID=2
//! 3. Firecracker forwards connection to Host's UDS listener
//! 4. Host accepts, receives `ready`, sends `ping`, waits for `pong`
//! 5. Connection established — host can send commands
//!
//! ## Concurrency
//!
//! After connection, a background reader task owns the read half of the
//! stream exclusively. All public methods take `&self` and can be called
//! concurrently. Responses are dispatched to callers via oneshot channels
//! keyed by sequence number.
//!
//! ## Exec Operation Lifecycle
//!
//! [`VsockHost`] supports one-shot exec operations with
//! [`VsockHost::start_exec_operation`] and supervised exec operations with
//! [`VsockHost::start_supervised_exec`]. One-shot exec is request-scoped: the
//! guest sends a terminal result for the original request sequence.
//! Supervised exec first acknowledges a started guest process and then keeps a
//! lifecycle registration until a terminal result arrives, the connection
//! closes, or the host explicitly abandons the registration.
//!
//! [`ExecOperationHandle`] owns a one-shot terminal result registration.
//! Dropping it removes only host-side registration and never sends
//! `MSG_EXEC_CANCEL`; use [`ExecOperationHandle::wait`] to observe the
//! terminal result or [`ExecOperationHandle::cancel_and_wait`] to send
//! cancellation and wait for the cancelled terminal result. If the terminal
//! result is already available or dispatch wins the race before cancellation
//! reaches the write boundary, cancel-and-wait returns that original terminal
//! result instead. The `cancel_and_wait` timeout bounds both the cancel-frame
//! write and the terminal-result wait. A plain wait timeout does not cancel the
//! guest. If terminal proof is abandoned after a request may have reached the
//! guest, the connection can remain open while later normal operations become
//! unavailable on that connection. A timeout after an explicit cancel was sent
//! poisons the connection because the guest process state is no longer known.
//!
//! [`SupervisedExecHandle`] owns the terminal result for a supervised process.
//! Dropping it does not cancel the guest and does not remove the lifecycle
//! registration; the host keeps tracking the operation until terminal result
//! dispatch, connection close, or an explicit wait timeout. Use
//! [`SupervisedExecHandle::cancel_and_wait`] to send cancellation and consume
//! the terminal result under one total timeout covering cancel-frame write and
//! terminal-result wait. If the terminal result is already available or
//! dispatch wins the race before cancellation reaches the write boundary,
//! cancel-and-wait returns that original terminal result instead.
//! [`SupervisedExecCancelHandle::cancel`] sends only the cancel frame and
//! leaves terminal result ownership with the paired
//! [`SupervisedExecHandle`].
//!
//! Streaming exec operations expose a bounded receiver through
//! `take_stream_receiver`. Guest-side stream or capture truncation is reported
//! on individual output/captured-output values, while host-side bounded queue
//! overflow is reported on [`ExecOperationResult::stream_overflowed`].
//!
//! Supervised operations can opt into exec control with
//! [`SupervisedExecControl::Enabled`]. [`ExecControlHandle::control`] requires
//! a delivered acknowledgement, while
//! [`ExecControlHandle::control_with_write_observer`] exposes the raw
//! [`ExecControlOutcome`] so callers can distinguish delivered requests from
//! guest statuses and guest error responses.

mod connection;
mod exec_operation;
mod file;
mod operation_tracker;
#[cfg(test)]
mod tests;

use std::io;
use std::os::unix::io::RawFd;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

use connection::{
    CompositeNormalOperation, ConnectionState, Shared, normal_operation_transition_error,
    normal_request_on_shared_with_write_observer_frame_builder,
    request_on_shared_with_composite_operation_and_observer_frame_builder,
};
#[cfg(test)]
use connection::{RequestWriteGuard, write_request_frame_with_builder};
use operation_tracker::NormalOperationFenceRejection as TrackerNormalOperationFenceRejection;

pub use exec_operation::{
    ExecCaptureRequest, ExecControlAck, ExecControlGuestStatus, ExecControlHandle,
    ExecControlOutcome, ExecOperationHandle, ExecOperationRequest, ExecOperationResult,
    ExecOutputEvent, ExecOwnedCapturedOutput, ExecStreamRequest, SupervisedExecCancelHandle,
    SupervisedExecControl, SupervisedExecHandle, SupervisedExecRequest,
};
pub use file::{CopyFileOptions, CopyFileResult, WriteFileEntry};

/// Observer called when a request frame reaches the guest-write boundary.
///
/// The callback is synchronous because it runs while the shared writer lock is
/// held, immediately before frame bytes are written. Keep the callback fast and
/// do not call back into the same [`VsockHost`], because that can deadlock on
/// the writer lock. Multi-frame helper operations may invoke the same observer
/// more than once.
#[derive(Clone)]
pub struct FrameWriteObserver {
    record_write_start: Arc<dyn Fn() -> io::Result<()> + Send + Sync>,
}

impl FrameWriteObserver {
    pub fn new(record_write_start: impl Fn() -> io::Result<()> + Send + Sync + 'static) -> Self {
        Self {
            record_write_start: Arc::new(record_write_start),
        }
    }

    pub fn noop() -> Self {
        Self::new(|| Ok(()))
    }

    fn record_write_start(&self) -> io::Result<()> {
        (self.record_write_start)()
    }
}

impl Default for FrameWriteObserver {
    fn default() -> Self {
        Self::noop()
    }
}

/// Opaque guard that fences new normal guest operations on a [`VsockHost`].
///
/// While this guard is alive, normal operations such as exec and file transfer
/// requests are rejected by the host-side operation tracker.
/// Lifecycle requests such as quiesce/resume are not normal operations and can
/// still be sent while the guard is held.
#[must_use = "normal operations are fenced only while this guard is held"]
#[derive(Debug)]
pub struct NormalOperationFence {
    _inner: operation_tracker::NormalOperationFence,
}

/// Reason why [`VsockHost::try_fence_normal_operations`] or
/// [`VsockHost::exec_operation_capture_with_fence`] could not acquire a
/// [`NormalOperationFence`].
///
/// The variants identify caller-visible recovery paths for normal-operation
/// fencing without exposing the internal operation tracker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalOperationFenceRejection {
    /// A normal operation is currently in flight.
    ///
    /// Callers may retry after outstanding normal operations have drained.
    Busy,
    /// Another [`NormalOperationFence`] is already held.
    ///
    /// Coordinate with the holder of the existing fence instead of treating the
    /// connection as failed.
    AlreadyFenced,
    /// The connection is no longer safe to park or reuse for future normal
    /// operations.
    ///
    /// Callers should discard this connection instead of retrying normal
    /// operations on it.
    NotParkable,
    /// The connection has closed.
    Closed,
}

impl From<TrackerNormalOperationFenceRejection> for NormalOperationFenceRejection {
    fn from(error: TrackerNormalOperationFenceRejection) -> Self {
        match error {
            TrackerNormalOperationFenceRejection::Busy => Self::Busy,
            TrackerNormalOperationFenceRejection::AlreadyFenced => Self::AlreadyFenced,
            TrackerNormalOperationFenceRejection::NotParkable => Self::NotParkable,
            TrackerNormalOperationFenceRejection::Closed => Self::Closed,
        }
    }
}

/// Failure while atomically fencing normal operations and running one final
/// capture exec.
#[derive(Debug)]
pub enum FencedExecError {
    /// The connection could not enter the fenced final-operation state.
    FenceRejected(NormalOperationFenceRejection),
    /// The reserved capture exec did not produce a trustworthy terminal result.
    Operation(io::Error),
}

impl std::fmt::Display for FencedExecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FenceRejected(reason) => {
                write!(formatter, "normal-operation fence rejected: {reason:?}")
            }
            Self::Operation(error) => write!(formatter, "fenced exec failed: {error}"),
        }
    }
}

impl std::error::Error for FencedExecError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::FenceRejected(_) => None,
            Self::Operation(error) => Some(error),
        }
    }
}

struct FencedNormalOperationGuard {
    normal_operation: Option<CompositeNormalOperation>,
    fence: Option<NormalOperationFence>,
}

impl FencedNormalOperationGuard {
    fn complete(mut self) -> io::Result<NormalOperationFence> {
        let normal_operation = self.normal_operation.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "fenced normal operation already completed",
            )
        })?;
        normal_operation.complete()?;
        self.fence.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "fenced normal operation is missing its fence",
            )
        })
    }
}

impl Drop for FencedNormalOperationGuard {
    fn drop(&mut self) {
        // Release the operation token before the fence. If a request may have
        // reached the guest, dropping the token first makes the tracker
        // NotParkable before the fence can consider reopening it.
        drop(self.normal_operation.take());
        drop(self.fence.take());
    }
}

/// Host-side vsock endpoint.
///
/// Maintains a persistent connection to the guest agent and provides
/// high-level methods for command execution, file operations, and
/// process lifecycle management.
///
/// All public methods take `&self` and can be called concurrently.
/// A background reader task dispatches incoming messages to the
/// appropriate caller.
pub struct VsockHost {
    shared: Arc<Shared>,
    file_write_path_locks: file::FileWritePathLocks,
    _reader: JoinHandle<()>,
    /// Raw fd of the underlying socket, used for shutdown on Drop.
    ///
    /// `shutdown(SHUT_RDWR)` does NOT close the fd — it only signals EOF,
    /// unblocking the reader_loop's async read and any remote peer's
    /// blocking read. The fd itself is still owned by the read/write halves
    /// and is closed normally when they are dropped.
    fd: RawFd,
}

impl VsockHost {
    /// Try to fence new normal guest operations on this connection.
    ///
    /// The returned guard keeps normal operations fenced until it is dropped.
    /// Bind it to a local variable for as long as the fence is needed; ignoring
    /// the guard releases the fence immediately.
    /// Lifecycle requests such as [`quiesce_operations`](Self::quiesce_operations)
    /// and [`resume_operations`](Self::resume_operations) remain available while
    /// the guard is held.
    ///
    /// If the fence cannot be acquired, [`NormalOperationFenceRejection`]
    /// describes whether the caller can retry later, should coordinate with an
    /// existing fence, or should discard/handle the connection.
    pub fn try_fence_normal_operations(
        &self,
    ) -> Result<NormalOperationFence, NormalOperationFenceRejection> {
        self.shared
            .normal_operations
            .try_fence()
            .map(|inner| NormalOperationFence { _inner: inner })
            .map_err(Into::into)
    }

    /// Start a request-scoped exec operation using the exec operation protocol.
    pub async fn start_exec_operation(
        &self,
        request: ExecOperationRequest<'_>,
    ) -> io::Result<ExecOperationHandle> {
        exec_operation::start_exec_operation_on_shared(&self.shared, request).await
    }

    /// Start a supervised exec operation and wait for its PID acknowledgement.
    ///
    /// If `request.start_timeout` elapses after the start frame is written,
    /// the host sends `MSG_EXEC_CANCEL` before returning a timeout error. If
    /// the bounded cancel write also times out, the connection is poisoned.
    /// If the cancel write succeeds, the connection remains open but should
    /// not be reused for later normal operations because terminal proof for the
    /// timed-out operation was abandoned.
    pub async fn start_supervised_exec(
        &self,
        request: SupervisedExecRequest<'_>,
    ) -> io::Result<SupervisedExecHandle> {
        exec_operation::start_supervised_exec_on_shared(&self.shared, request).await
    }

    /// Run a capture-only exec operation with default capture limits.
    pub async fn exec_operation_capture_default(
        &self,
        command: &str,
        timeout_ms: u32,
        env: &[(&str, &str)],
        sudo: bool,
        label: &str,
        wait_timeout: Duration,
    ) -> io::Result<ExecOperationResult> {
        self.exec_operation_capture(ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label,
            stdout_limit_bytes: exec_operation::DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: exec_operation::DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout,
        })
        .await
    }

    /// Run a capture-only exec operation with explicit stdout/stderr limits.
    pub async fn exec_operation_capture(
        &self,
        request: ExecCaptureRequest<'_>,
    ) -> io::Result<ExecOperationResult> {
        exec_operation::exec_operation_capture_on_shared(&self.shared, request).await
    }

    /// Atomically reserve one final normal operation and fence every competing
    /// normal operation while running a capture exec.
    ///
    /// Reservation succeeds only when the normal-operation tracker is open and
    /// idle. The returned fence remains held after the exec reaches a terminal
    /// result, allowing a lifecycle owner to quiesce and pause the guest without
    /// reopening normal-operation admission in between.
    ///
    /// Dropping this future or losing terminal proof releases the operation
    /// token before the fence. If the request may have reached the guest, that
    /// ordering leaves the connection not parkable rather than reopening it.
    pub async fn exec_operation_capture_with_fence(
        &self,
        request: ExecCaptureRequest<'_>,
    ) -> Result<(ExecOperationResult, NormalOperationFence), FencedExecError> {
        let (normal_operation, fence) = self
            .shared
            .normal_operations
            .try_reserve_and_fence()
            .map_err(|error| FencedExecError::FenceRejected(error.into()))?;
        let mut guard = FencedNormalOperationGuard {
            normal_operation: Some(CompositeNormalOperation::from_token(normal_operation)),
            fence: Some(NormalOperationFence { _inner: fence }),
        };
        let normal_operation = guard.normal_operation.as_mut().ok_or_else(|| {
            FencedExecError::Operation(io::Error::new(
                io::ErrorKind::InvalidData,
                "fenced normal operation is unavailable",
            ))
        })?;
        let result = exec_operation::exec_operation_capture_with_composite_on_shared_and_observer(
            &self.shared,
            request,
            normal_operation,
            FrameWriteObserver::default(),
        )
        .await
        .map_err(FencedExecError::Operation)?;
        let fence = guard.complete().map_err(FencedExecError::Operation)?;
        Ok((result, fence))
    }

    /// Start a streaming exec operation with a bounded output event receiver.
    pub async fn exec_operation_stream(
        &self,
        request: ExecStreamRequest<'_>,
    ) -> io::Result<ExecOperationHandle> {
        exec_operation::exec_operation_stream_on_shared(&self.shared, request).await
    }
}
