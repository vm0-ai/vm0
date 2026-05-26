use std::collections::HashMap;
use std::future::{Future, ready};
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::{
    CompositeNormalOperation, ConnectionState, ExecResult, FrameWriteObserver, Shared,
    normal_operation_transition_error,
    operation_tracker::{NormalOperationToken, NormalOperationTransitionHandle},
};
use vsock_proto::{
    ExecCapturedOutput, ExecControlNonce, ExecControlPolicy, ExecControlStatus,
    ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream, ExecTermination, ExecTimeoutPolicy,
    MSG_ERROR, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT,
    MSG_EXEC_RESULT, MSG_EXEC_START, MSG_EXEC_STARTED, RawMessage,
};

pub(crate) const DEFAULT_EXEC_CAPTURE_LIMIT_BYTES: u32 = 1024 * 1024;
pub(crate) const SMALL_EXEC_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;
const EXEC_TIMEOUT_EXIT_CODE: i32 = 124;
const DEFAULT_EXEC_STREAM_CAPACITY: usize = 32;
// Large enough for the current 64 MiB guest-log copy cap even when the guest
// emits stream events at the exec-operation drainer's 8 KiB read granularity.
pub(crate) const MAX_EXEC_STREAM_CAPACITY: usize = 8192;
const EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES: usize = 100;
const EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT: usize = 16;
const EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD: Duration = Duration::from_millis(500);
const EXEC_OPERATION_STAGE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const EXEC_OPERATION_FRAME_WRITE_NOT_STARTED: u8 = 0;
const EXEC_OPERATION_FRAME_WRITE_STARTED: u8 = 1;
const EXEC_OPERATION_FRAME_WRITE_COMPLETED: u8 = 2;

/// Owned captured output from an exec operation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecOwnedCapturedOutput {
    /// The stream was discarded by policy and therefore has no captured bytes.
    Discarded,
    /// The stream was captured, possibly with protocol-level truncation.
    Captured { bytes: Vec<u8>, truncated: bool },
}

/// Terminal result for a host exec operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOperationResult {
    pub termination: ExecTermination,
    pub duration_ms: u32,
    pub stdout: ExecOwnedCapturedOutput,
    pub stderr: ExecOwnedCapturedOutput,
    pub diagnostic: String,
    pub stream_overflowed: bool,
}

/// Streamed output event for a host exec operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutputEvent {
    pub stream: ExecOutputStream,
    pub output_seq: u32,
    pub chunk: Vec<u8>,
    pub truncated: bool,
}

/// Request parameters for starting an exec operation.
pub struct ExecOperationRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: ExecOutputPolicy,
    pub stderr: ExecOutputPolicy,
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Optional bounded host-side output event queue override.
    ///
    /// `None` uses the default queue capacity when either output policy
    /// streams, and creates no queue when neither output policy streams.
    /// `Some` is valid only when stdout or stderr streams; zero and oversized
    /// capacities are rejected.
    pub stream_queue_capacity: Option<usize>,
}

/// Request parameters for a capture-only exec operation helper.
pub struct ExecCaptureRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    pub wait_timeout: Duration,
}

/// Request parameters for a streaming exec operation helper.
pub struct ExecStreamRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: ExecOutputPolicy,
    pub stderr: ExecOutputPolicy,
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Optional host-side output event queue capacity override.
    ///
    /// `None` uses the default queue capacity. Zero and oversized capacities
    /// are rejected.
    pub stream_queue_capacity: Option<usize>,
}

/// Exec control policy for supervised host operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisedExecControl {
    /// Do not register an exec-control route for the operation.
    Disabled,
    /// Register an exec-control route.
    ///
    /// When `sink` is true, the guest also exposes the bootstrap endpoint to
    /// the child process through the process-control environment variable.
    Enabled { sink: bool },
}

/// Request parameters for starting a supervised exec operation.
pub struct SupervisedExecRequest<'a> {
    /// Guest-side process timeout policy.
    ///
    /// `ExecTimeoutPolicy::None` lets the process run until it exits, is
    /// cancelled, or the connection closes.
    pub timeout: ExecTimeoutPolicy,
    /// Shell command to run in the guest.
    pub command: &'a str,
    /// Environment variables injected into the guest shell command.
    pub env: &'a [(&'a str, &'a str)],
    /// Whether to run the command with guest-side sudo handling.
    pub sudo: bool,
    /// Human-readable label used for diagnostics and logs.
    pub label: &'a str,
    /// Stdout output policy requested from the guest.
    pub stdout: ExecOutputPolicy,
    /// Stderr output policy requested from the guest.
    pub stderr: ExecOutputPolicy,
    /// Exit codes that should be marked expected in the guest-side exec request.
    pub expected_exit_codes: &'a [i32],
    /// Optional bounded stdin payload written to the child and then closed.
    pub stdin_bytes: Option<&'a [u8]>,
    /// Optional exec-control route for this supervised operation.
    pub control: SupervisedExecControl,
    /// Optional bounded host-side output event queue override.
    ///
    /// `None` uses the default queue capacity when either output policy
    /// streams, and creates no queue when neither output policy streams.
    /// `Some` is valid only when stdout or stderr streams; zero and oversized
    /// capacities are rejected.
    pub stream_queue_capacity: Option<usize>,
    /// Maximum time to wait for the guest `exec_started` acknowledgement.
    ///
    /// If this elapses after the start frame is written, the host sends
    /// `MSG_EXEC_CANCEL` for the operation before returning a timeout error.
    /// If that cancel frame cannot be written within the bounded fallback
    /// window, the connection is poisoned because the guest process state is
    /// no longer known.
    ///
    /// A successful start-timeout cancellation still abandons terminal proof
    /// for this operation, so the connection should not be reused for later
    /// normal operations.
    pub start_timeout: Duration,
}

/// Host-side acknowledgement for a delivered exec-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecControlAck {
    pub target_seq: u32,
    pub message_id: String,
}

/// Guest-side terminal status for an exec-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecControlGuestStatus {
    pub status: ExecControlStatus,
    pub diagnostic: String,
}

/// Terminal guest response for an exec-control request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecControlOutcome {
    Delivered(ExecControlAck),
    GuestStatus(ExecControlGuestStatus),
    GuestError(String),
}

impl ExecControlOutcome {
    pub fn into_ack(self) -> io::Result<ExecControlAck> {
        match self {
            Self::Delivered(ack) => Ok(ack),
            Self::GuestStatus(status) => {
                Err(exec_control_status_error(status.status, &status.diagnostic))
            }
            Self::GuestError(message) => Err(io::Error::other(message)),
        }
    }
}

pub(crate) struct Operations {
    operations: HashMap<u32, ExecOperation>,
    control_targets: HashMap<u32, u32>,
}

impl Operations {
    pub(crate) fn new() -> Self {
        Self {
            operations: HashMap::new(),
            control_targets: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.operations.len()
    }

    fn insert(&mut self, seq: u32, operation: ExecOperation) {
        self.operations.insert(seq, operation);
    }

    pub(crate) fn remove(&mut self, seq: u32) {
        if let Some(operation) = self.operations.remove(&seq) {
            for request_seq in operation.pending_controls.keys() {
                self.control_targets.remove(request_seq);
            }
        }
    }

    fn take(&mut self, seq: u32) -> Option<ExecOperation> {
        let operation = self.operations.remove(&seq)?;
        for request_seq in operation.pending_controls.keys() {
            self.control_targets.remove(request_seq);
        }
        Some(operation)
    }

    fn contains(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq)
    }

    fn get_mut(&mut self, seq: u32) -> Option<&mut ExecOperation> {
        self.operations.get_mut(&seq)
    }

    fn mark_host_cancel_requested(&mut self, seq: u32) {
        if let Some(operation) = self.operations.get_mut(&seq) {
            operation.host_cancel_requested = true;
        }
    }

    fn insert_pending_control(
        &mut self,
        target_seq: u32,
        request_seq: u32,
        pending: PendingExecControl,
    ) -> io::Result<()> {
        let Some(operation) = self.operations.get_mut(&target_seq) else {
            return Err(exec_control_status_error(
                ExecControlStatus::Inactive,
                "exec operation is not active",
            ));
        };
        operation.validate_control_nonce(pending.control_nonce)?;
        operation.pending_controls.insert(request_seq, pending);
        self.control_targets.insert(request_seq, target_seq);
        Ok(())
    }

    fn remove_pending_control(&mut self, request_seq: u32) {
        let Some(target_seq) = self.control_targets.remove(&request_seq) else {
            return;
        };
        if let Some(operation) = self.operations.get_mut(&target_seq) {
            operation.pending_controls.remove(&request_seq);
        }
    }

    fn take_pending_control(&mut self, request_seq: u32) -> Option<PendingExecControl> {
        let target_seq = self.control_targets.remove(&request_seq)?;
        self.operations
            .get_mut(&target_seq)?
            .pending_controls
            .remove(&request_seq)
    }

    pub(crate) fn close_snapshot(&self) -> ExecOperationCloseSnapshot {
        let active_count = self.operations.len();
        let operations = self
            .operations
            .values()
            .take(EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT)
            .map(|operation| operation.diagnostic.snapshot())
            .collect();
        ExecOperationCloseSnapshot {
            active_count,
            operations,
        }
    }
}

impl Default for Operations {
    fn default() -> Self {
        Self::new()
    }
}

struct ExecOperation {
    normal_operation: Option<ExecOperationNormalTracking>,
    lifecycle: ExecOperationLifecycle,
    diagnostic: ExecOperationDiagnostic,
    result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
    stream_tx: Option<mpsc::Sender<ExecOutputEvent>>,
    stdout_capture: ExecCaptureState,
    stderr_capture: ExecCaptureState,
    stdout_stream: Option<ExecStreamState>,
    stderr_stream: Option<ExecStreamState>,
    expected_output_seq: u32,
    stream_overflowed: bool,
    host_cancel_requested: bool,
    pending_controls: HashMap<u32, PendingExecControl>,
}

enum ExecOperationLifecycle {
    OneShot,
    SupervisedAwaitingStart {
        start_tx: Option<oneshot::Sender<io::Result<u32>>>,
        control_nonce: Option<ExecControlNonce>,
    },
    SupervisedStarted {
        pid: u32,
        control_nonce: Option<ExecControlNonce>,
    },
}

struct PendingExecControl {
    target_seq: u32,
    message_id: String,
    control_nonce: ExecControlNonce,
    response_tx: oneshot::Sender<io::Result<ExecControlOutcome>>,
    normal_operation: NormalOperationToken,
}

enum ExecOperationNormalTracking {
    Owned(NormalOperationToken),
    Composite(NormalOperationTransitionHandle),
}

impl ExecOperation {
    fn allows_output(&self) -> bool {
        matches!(
            self.lifecycle,
            ExecOperationLifecycle::OneShot | ExecOperationLifecycle::SupervisedStarted { .. }
        )
    }

    fn validates_result_before_start(
        &self,
        result: &vsock_proto::DecodedExecResult<'_>,
    ) -> io::Result<()> {
        if matches!(
            self.lifecycle,
            ExecOperationLifecycle::SupervisedAwaitingStart { .. }
        ) && result.termination != ExecTermination::StartFailed
        {
            return Err(exec_operation_protocol_error(
                "supervised exec result before exec_started must be StartFailed",
            ));
        }
        Ok(())
    }

    fn validate_control_nonce(&self, control_nonce: ExecControlNonce) -> io::Result<()> {
        match self.lifecycle {
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: Some(expected),
                ..
            } if expected == control_nonce => Ok(()),
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: Some(_),
                ..
            } => Err(exec_control_status_error(
                ExecControlStatus::NonceMismatch,
                "exec operation nonce mismatch",
            )),
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: None,
                ..
            } => Err(exec_control_status_error(
                ExecControlStatus::Unsupported,
                "exec control is not supported by this operation",
            )),
            ExecOperationLifecycle::OneShot
            | ExecOperationLifecycle::SupervisedAwaitingStart { .. } => {
                Err(exec_control_status_error(
                    ExecControlStatus::Inactive,
                    "exec operation is not active",
                ))
            }
        }
    }
}

impl ExecOperationNormalTracking {
    fn mark_possible_guest_write_started(&mut self) -> io::Result<()> {
        match self {
            ExecOperationNormalTracking::Owned(normal_operation) => normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error),
            ExecOperationNormalTracking::Composite(normal_operation) => normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error),
        }
    }

    fn complete(self) -> io::Result<()> {
        match self {
            ExecOperationNormalTracking::Owned(normal_operation) => normal_operation
                .complete()
                .map_err(normal_operation_transition_error),
            ExecOperationNormalTracking::Composite(normal_operation) => normal_operation
                .mark_possible_guest_write_completed()
                .map_err(normal_operation_transition_error),
        }
    }
}

enum ExecOperationTracking<'a> {
    Tracked,
    Composite(&'a CompositeNormalOperation),
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecTerminalLogLifecycle {
    OneShot,
    Supervised,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecTerminalLogSeverity {
    Info,
    Warn,
}

#[derive(Clone, Copy)]
struct ExecTerminalLogContext {
    lifecycle: ExecTerminalLogLifecycle,
    slow: bool,
    termination: ExecTermination,
    stdout_truncated: bool,
    stderr_truncated: bool,
    stream_overflowed: bool,
    diagnostic_present: bool,
    host_cancel_requested: bool,
}

#[derive(Clone)]
struct ExecOperationDiagnostic {
    seq: u32,
    label_log: String,
    registered_at: Instant,
    first_output_at: Option<Instant>,
}

struct ExecOperationSnapshot {
    seq: u32,
    label_log: String,
    elapsed_ms: u128,
}

pub(crate) struct ExecOperationCloseSnapshot {
    active_count: usize,
    operations: Vec<ExecOperationSnapshot>,
}

struct ExecOperationFrameDiagnostic {
    seq: u32,
    label_log: String,
    frame: &'static str,
}

enum ExecCaptureState {
    Discard,
    Capture { limit_bytes: usize },
}

struct ExecStreamState {
    limit_bytes: usize,
    chunk_limit_bytes: usize,
    emitted_bytes: usize,
    truncated: bool,
}

struct ExecOperationRegistrationGuard {
    shared: Arc<Shared>,
    seq: u32,
    disarmed: bool,
}

struct PendingExecControlGuard {
    shared: Arc<Shared>,
    request_seq: u32,
}

impl ExecOperationRegistrationGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self {
            shared,
            seq,
            disarmed: false,
        }
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for ExecOperationRegistrationGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            self.shared.remove_operation(self.seq);
        }
    }
}

impl PendingExecControlGuard {
    fn new(shared: Arc<Shared>, request_seq: u32) -> Self {
        Self {
            shared,
            request_seq,
        }
    }
}

impl Drop for PendingExecControlGuard {
    fn drop(&mut self) {
        remove_pending_exec_control(&self.shared, self.request_seq);
    }
}

struct ExecOperationFrameWriteGuard {
    shared: Arc<Shared>,
    state: Arc<AtomicU8>,
}

impl ExecOperationFrameWriteGuard {
    fn new(shared: Arc<Shared>, state: Arc<AtomicU8>) -> Self {
        Self { shared, state }
    }
}

impl Drop for ExecOperationFrameWriteGuard {
    fn drop(&mut self) {
        if self.state.load(Ordering::Acquire) == EXEC_OPERATION_FRAME_WRITE_STARTED {
            self.shared.poison_connection();
        }
    }
}

impl ExecOperationDiagnostic {
    fn new(seq: u32, label: &str) -> Self {
        Self {
            seq,
            label_log: exec_operation_label_log(label),
            registered_at: Instant::now(),
            first_output_at: None,
        }
    }

    fn frame(&self, frame: &'static str) -> ExecOperationFrameDiagnostic {
        ExecOperationFrameDiagnostic {
            seq: self.seq,
            label_log: self.label_log.clone(),
            frame,
        }
    }

    fn elapsed_ms(&self) -> u128 {
        self.registered_at.elapsed().as_millis()
    }

    fn snapshot(&self) -> ExecOperationSnapshot {
        ExecOperationSnapshot {
            seq: self.seq,
            label_log: self.label_log.clone(),
            elapsed_ms: self.elapsed_ms(),
        }
    }

    fn mark_first_output(&mut self) -> Option<ExecOperationSnapshot> {
        if self.first_output_at.is_some() {
            return None;
        }

        self.first_output_at = Some(Instant::now());
        let elapsed_ms = self.elapsed_ms();
        if elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis() {
            return Some(ExecOperationSnapshot {
                seq: self.seq,
                label_log: self.label_log.clone(),
                elapsed_ms,
            });
        }

        None
    }

    fn log_terminal(
        &self,
        lifecycle: ExecTerminalLogLifecycle,
        result: &vsock_proto::DecodedExecResult<'_>,
        stream_overflowed: bool,
        host_cancel_requested: bool,
    ) {
        let elapsed_ms = self.elapsed_ms();
        let slow = elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis();
        let stdout_truncated = exec_operation_captured_output_truncated(result.stdout);
        let stderr_truncated = exec_operation_captured_output_truncated(result.stderr);
        let diagnostic_present = !result.diagnostic.is_empty();
        let Some(severity) = exec_terminal_log_severity(ExecTerminalLogContext {
            lifecycle,
            slow,
            termination: result.termination,
            stdout_truncated,
            stderr_truncated,
            stream_overflowed,
            diagnostic_present,
            host_cancel_requested,
        }) else {
            return;
        };

        match severity {
            ExecTerminalLogSeverity::Info => {
                tracing::info!(
                    seq = self.seq,
                    label = %self.label_log,
                    elapsed_ms,
                    guest_duration_ms = result.duration_ms,
                    termination = ?result.termination,
                    stream_overflowed,
                    stdout_truncated,
                    stderr_truncated,
                    diagnostic_present,
                    host_cancel_requested,
                    "exec operation terminal result"
                );
            }
            ExecTerminalLogSeverity::Warn => {
                tracing::warn!(
                    seq = self.seq,
                    label = %self.label_log,
                    elapsed_ms,
                    guest_duration_ms = result.duration_ms,
                    termination = ?result.termination,
                    stream_overflowed,
                    stdout_truncated,
                    stderr_truncated,
                    diagnostic_present,
                    host_cancel_requested,
                    "exec operation terminal result"
                );
            }
        }
    }

    fn log_error_response(&self, error: &io::Error) {
        tracing::warn!(
            seq = self.seq,
            label = %self.label_log,
            elapsed_ms = self.elapsed_ms(),
            error = %error,
            "exec operation error response"
        );
    }
}

/// Handle for a host-side exec operation.
///
/// Dropping the handle removes the host-side registration only. It never sends
/// `MSG_EXEC_CANCEL`; callers that need remote cancellation must call
/// [`ExecOperationHandle::cancel_and_wait`].
pub struct ExecOperationHandle {
    shared: Arc<Shared>,
    seq: Option<u32>,
    diagnostic: ExecOperationDiagnostic,
    result_rx: Option<oneshot::Receiver<io::Result<ExecOperationResult>>>,
    stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
}

struct ExecCancelWaitResult {
    result: ExecOperationResult,
    cancel_seq: Option<u32>,
}

impl ExecOperationHandle {
    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<ExecOutputEvent>> {
        self.stream_rx.take()
    }

    /// Wait for the terminal exec result.
    ///
    /// On timeout, this removes the host-side operation registration but does
    /// not cancel the guest-side exec operation.
    pub async fn wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        self.wait_with_timeout(timeout, false).await
    }

    /// Send an explicit cancel request and wait for a cancelled terminal result.
    ///
    /// If the terminal result is already available before cancel is sent, this
    /// returns that result without sending a duplicate cancel frame.
    pub async fn cancel_and_wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        let cancel_label_log = self.diagnostic.label_log.clone();
        let registered_at = self.diagnostic.registered_at;
        let wait_result = self.cancel_and_wait_for_terminal_status(timeout).await?;
        if wait_result.cancel_seq.is_none()
            || wait_result.result.termination == ExecTermination::Cancelled
        {
            if let Some(seq) = wait_result.cancel_seq {
                tracing::info!(
                    seq = seq,
                    label = %cancel_label_log,
                    elapsed_ms = registered_at.elapsed().as_millis(),
                    "exec operation cancel completed"
                );
            }
            return Ok(wait_result.result);
        }

        Err(io::Error::other(format!(
            "exec cancel returned terminal state: {:?}",
            wait_result.result.termination
        )))
    }

    pub(crate) async fn cancel_and_wait_for_terminal(
        self,
        timeout: Duration,
    ) -> io::Result<ExecOperationResult> {
        self.cancel_and_wait_for_terminal_status(timeout)
            .await
            .map(|wait_result| wait_result.result)
    }

    async fn cancel_and_wait_for_terminal_status(
        mut self,
        timeout: Duration,
    ) -> io::Result<ExecCancelWaitResult> {
        if let Some(result) = self.try_take_ready_result()? {
            return Ok(ExecCancelWaitResult {
                result,
                cancel_seq: None,
            });
        }

        let seq = self.seq.ok_or_else(|| {
            io::Error::new(io::ErrorKind::ConnectionReset, "exec operation closed")
        })?;
        let payload = vsock_proto::encode_exec_cancel();
        write_frame(
            &self.shared,
            MSG_EXEC_CANCEL,
            seq,
            &payload,
            Some(self.diagnostic.frame("cancel")),
            None,
            exec_cancel_write_observer(&self.shared, seq),
        )
        .await?;
        tracing::info!(
            seq = seq,
            label = %self.diagnostic.label_log,
            elapsed_ms = self.diagnostic.elapsed_ms(),
            "exec operation cancel sent"
        );

        let result = self.wait_with_timeout(timeout, true).await?;
        Ok(ExecCancelWaitResult {
            result,
            cancel_seq: Some(seq),
        })
    }

    fn try_take_ready_result(&mut self) -> io::Result<Option<ExecOperationResult>> {
        let Some(rx) = self.result_rx.as_mut() else {
            return Ok(None);
        };

        match rx.try_recv() {
            Ok(result) => {
                self.seq = None;
                self.result_rx = None;
                result.map(Some)
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.seq = None;
                self.result_rx = None;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
            }
        }
    }

    async fn wait_with_timeout(
        mut self,
        timeout: Duration,
        poison_on_timeout: bool,
    ) -> io::Result<ExecOperationResult> {
        let seq = self.seq.ok_or_else(|| {
            io::Error::new(io::ErrorKind::ConnectionReset, "exec operation closed")
        })?;
        let rx = self.result_rx.as_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::ConnectionReset, "exec operation closed")
        })?;

        tokio::select! {
            biased;
            result = rx => {
                self.seq = None;
                self.result_rx = None;
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))?
            }
            _ = tokio::time::sleep(timeout) => {
                self.shared.remove_operation(seq);
                self.seq = None;
                self.result_rx = None;
                tracing::warn!(
                    seq = seq,
                    label = %self.diagnostic.label_log,
                    elapsed_ms = self.diagnostic.elapsed_ms(),
                    poison_connection = poison_on_timeout,
                    "exec operation wait timeout"
                );
                if poison_on_timeout {
                    self.shared.poison_connection();
                }
                Err(io::Error::new(io::ErrorKind::TimedOut, "exec operation timeout"))
            }
        }
    }
}

impl Drop for ExecOperationHandle {
    fn drop(&mut self) {
        if let Some(seq) = self.seq.take() {
            self.shared.remove_operation(seq);
        }
    }
}

/// Handle for a host-side supervised exec operation.
///
/// Dropping this handle never sends `MSG_EXEC_CANCEL` and does not remove the
/// operation lifecycle registration. The host keeps the registration until a
/// terminal exec result arrives, the connection closes, or a caller explicitly
/// waits with a timeout that abandons the operation.
pub struct SupervisedExecHandle {
    shared: Arc<Shared>,
    seq: Option<u32>,
    pid: u32,
    diagnostic: ExecOperationDiagnostic,
    cancel_handle_taken: bool,
    result_rx: Option<oneshot::Receiver<io::Result<ExecOperationResult>>>,
    stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
    control: Option<ExecControlHandle>,
}

/// One-shot handle that sends `MSG_EXEC_CANCEL` for a supervised exec operation.
pub struct SupervisedExecCancelHandle {
    shared: Arc<Shared>,
    seq: u32,
    diagnostic: ExecOperationDiagnostic,
}

impl SupervisedExecCancelHandle {
    /// Send the cancel frame without consuming the terminal exec result.
    ///
    /// The paired [`SupervisedExecHandle`] still owns the result receiver and must
    /// be waited or abandoned by its caller.
    pub async fn cancel(self, timeout: Duration) -> io::Result<()> {
        tokio::time::timeout(
            timeout,
            send_supervised_exec_cancel_frame(&self.shared, self.seq, &self.diagnostic),
        )
        .await
        .unwrap_or_else(|_| {
            tracing::warn!(
                seq = self.seq,
                label = %self.diagnostic.label_log,
                elapsed_ms = self.diagnostic.elapsed_ms(),
                "supervised exec operation cancel write timed out"
            );
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "supervised exec cancel write timed out",
            ))
        })
    }
}

impl SupervisedExecHandle {
    /// Guest process id reported by the `exec_started` acknowledgement.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Return a cloneable exec-control handle when control was enabled.
    pub fn control_handle(&self) -> Option<ExecControlHandle> {
        self.control.clone()
    }

    /// Take a one-shot handle that can send `MSG_EXEC_CANCEL` without consuming
    /// this handle's terminal result receiver.
    pub fn take_cancel_handle(&mut self) -> Option<SupervisedExecCancelHandle> {
        if self.cancel_handle_taken {
            return None;
        }
        let seq = self.seq?;
        self.cancel_handle_taken = true;
        Some(SupervisedExecCancelHandle {
            shared: Arc::clone(&self.shared),
            seq,
            diagnostic: self.diagnostic.clone(),
        })
    }

    /// Send an exec-control request for this supervised operation.
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control
            .as_ref()
            .ok_or_else(|| {
                exec_control_status_error(
                    ExecControlStatus::Unsupported,
                    "exec control is not supported by this operation",
                )
            })?
            .control(message_id, payload, timeout)
            .await
    }

    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<ExecOutputEvent>> {
        self.stream_rx.take()
    }

    fn clear_unclaimed_stream_sender(&mut self) {
        let Some(seq) = self.seq else {
            return;
        };
        if self.stream_rx.take().is_some() {
            clear_exec_operation_stream_sender(&self.shared, seq);
        }
    }

    /// Wait for the terminal exec result.
    ///
    /// On timeout, this abandons the host-side operation registration but does
    /// not send `MSG_EXEC_CANCEL`. Because the terminal proof is abandoned
    /// after a guest write, the connection should not be reused for later
    /// normal operations.
    pub async fn wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        self.wait_with_timeout(timeout, false).await
    }

    /// Send `MSG_EXEC_CANCEL` and wait for the terminal exec result.
    ///
    /// If the terminal result is already available before cancel is sent, this
    /// returns that result without sending a duplicate cancel frame.
    pub async fn cancel_and_wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        let cancel_label_log = self.diagnostic.label_log.clone();
        let registered_at = self.diagnostic.registered_at;
        let wait_result = self.cancel_and_wait_for_terminal_status(timeout).await?;
        if wait_result.cancel_seq.is_none()
            || wait_result.result.termination == ExecTermination::Cancelled
        {
            if let Some(seq) = wait_result.cancel_seq {
                tracing::info!(
                    seq = seq,
                    label = %cancel_label_log,
                    elapsed_ms = registered_at.elapsed().as_millis(),
                    "supervised exec operation cancel completed"
                );
            }
            return Ok(wait_result.result);
        }

        Err(io::Error::other(format!(
            "supervised exec cancel returned terminal state: {:?}",
            wait_result.result.termination
        )))
    }

    async fn cancel_and_wait_for_terminal_status(
        mut self,
        timeout: Duration,
    ) -> io::Result<ExecCancelWaitResult> {
        if let Some(result) = self.try_take_ready_result()? {
            return Ok(ExecCancelWaitResult {
                result,
                cancel_seq: None,
            });
        }

        let seq = self.seq.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                "supervised exec operation closed",
            )
        })?;
        send_supervised_exec_cancel_frame(&self.shared, seq, &self.diagnostic).await?;

        let result = self.wait_with_timeout(timeout, true).await?;
        Ok(ExecCancelWaitResult {
            result,
            cancel_seq: Some(seq),
        })
    }

    fn try_take_ready_result(&mut self) -> io::Result<Option<ExecOperationResult>> {
        let Some(rx) = self.result_rx.as_mut() else {
            return Ok(None);
        };

        match rx.try_recv() {
            Ok(result) => {
                self.seq = None;
                self.result_rx = None;
                result.map(Some)
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.seq = None;
                self.result_rx = None;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
            }
        }
    }

    async fn wait_with_timeout(
        mut self,
        timeout: Duration,
        poison_on_timeout: bool,
    ) -> io::Result<ExecOperationResult> {
        let seq = self.seq.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                "supervised exec operation closed",
            )
        })?;
        self.clear_unclaimed_stream_sender();
        let rx = self.result_rx.as_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                "supervised exec operation closed",
            )
        })?;

        tokio::select! {
            biased;
            result = rx => {
                self.seq = None;
                self.result_rx = None;
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))?
            }
            _ = tokio::time::sleep(timeout) => {
                self.shared.remove_operation(seq);
                self.seq = None;
                self.result_rx = None;
                tracing::warn!(
                    seq = seq,
                    label = %self.diagnostic.label_log,
                    elapsed_ms = self.diagnostic.elapsed_ms(),
                    poison_connection = poison_on_timeout,
                    "supervised exec operation wait timeout"
                );
                if poison_on_timeout {
                    self.shared.poison_connection();
                }
                Err(io::Error::new(io::ErrorKind::TimedOut, "supervised exec operation timeout"))
            }
        }
    }
}

impl Drop for SupervisedExecHandle {
    fn drop(&mut self) {
        self.clear_unclaimed_stream_sender();
    }
}

/// Cloneable handle for sending control messages to a supervised exec operation.
#[derive(Clone)]
pub struct ExecControlHandle {
    shared: Arc<Shared>,
    target_seq: u32,
    control_nonce: ExecControlNonce,
}

impl ExecControlHandle {
    /// Send an exec-control request and require a delivered acknowledgement.
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control_with_write_observer(
            message_id,
            payload,
            timeout,
            FrameWriteObserver::default(),
        )
        .await?
        .into_ack()
    }

    /// Send an exec-control request and return the raw guest outcome.
    pub async fn control_with_write_observer(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
        write_observer: FrameWriteObserver,
    ) -> io::Result<ExecControlOutcome> {
        exec_control_on_shared(
            &self.shared,
            self.target_seq,
            self.control_nonce,
            message_id,
            payload,
            timeout,
            write_observer,
        )
        .await
    }
}

pub(crate) struct ExecOperationCancelOnDropGuard {
    shared: Option<Arc<Shared>>,
    seq: u32,
    diagnostic: ExecOperationDiagnostic,
}

impl ExecOperationCancelOnDropGuard {
    fn new_for_seq(shared: Arc<Shared>, seq: u32, diagnostic: ExecOperationDiagnostic) -> Self {
        Self {
            shared: Some(shared),
            seq,
            diagnostic,
        }
    }

    pub(crate) fn new(handle: &ExecOperationHandle) -> Option<Self> {
        Some(Self {
            shared: Some(Arc::clone(&handle.shared)),
            seq: handle.seq?,
            diagnostic: handle.diagnostic.clone(),
        })
    }

    #[cfg(test)]
    pub(crate) fn new_supervised(handle: &SupervisedExecHandle) -> Option<Self> {
        Some(Self {
            shared: Some(Arc::clone(&handle.shared)),
            seq: handle.seq?,
            diagnostic: handle.diagnostic.clone(),
        })
    }

    pub(crate) fn disarm(&mut self) {
        self.shared = None;
    }
}

impl Drop for ExecOperationCancelOnDropGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else {
            return;
        };
        let seq = self.seq;
        let diagnostic = self.diagnostic.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };

        handle.spawn(async move {
            let payload = vsock_proto::encode_exec_cancel();
            let result = tokio::time::timeout(
                EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT,
                write_frame(
                    &shared,
                    MSG_EXEC_CANCEL,
                    seq,
                    &payload,
                    Some(diagnostic.frame("drop-cancel")),
                    None,
                    exec_cancel_write_observer(&shared, seq),
                ),
            )
            .await;
            match result {
                Ok(Ok(())) => {
                    tracing::info!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        "exec operation cancel sent on drop"
                    );
                }
                Ok(Err(err)) => {
                    tracing::warn!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        error = %err,
                        "exec operation cancel on drop failed"
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        "exec operation cancel on drop timed out"
                    );
                }
            }
        });
    }
}

fn exec_operation_protocol_error(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn exec_cancel_write_observer(shared: &Arc<Shared>, seq: u32) -> FrameWriteObserver {
    let shared = Arc::clone(shared);
    FrameWriteObserver::new(move || {
        mark_exec_operation_host_cancel_requested(&shared, seq);
        Ok(())
    })
}

fn mark_exec_operation_host_cancel_requested(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard {
        operations.mark_host_cancel_requested(seq);
    }
}

async fn send_supervised_exec_cancel_frame(
    shared: &Arc<Shared>,
    seq: u32,
    diagnostic: &ExecOperationDiagnostic,
) -> io::Result<()> {
    let payload = vsock_proto::encode_exec_cancel();
    write_frame(
        shared,
        MSG_EXEC_CANCEL,
        seq,
        &payload,
        Some(diagnostic.frame("cancel")),
        None,
        exec_cancel_write_observer(shared, seq),
    )
    .await?;
    tracing::info!(
        seq = seq,
        label = %diagnostic.label_log,
        elapsed_ms = diagnostic.elapsed_ms(),
        "supervised exec operation cancel sent"
    );
    Ok(())
}

fn exec_control_status_error(status: ExecControlStatus, diagnostic: &str) -> io::Error {
    let message = if diagnostic.is_empty() {
        default_exec_control_status_message(status).to_owned()
    } else {
        diagnostic.to_owned()
    };
    io::Error::new(exec_control_status_error_kind(status), message)
}

fn exec_control_status_error_kind(status: ExecControlStatus) -> io::ErrorKind {
    match status {
        ExecControlStatus::Delivered => io::ErrorKind::Other,
        ExecControlStatus::Inactive => io::ErrorKind::NotFound,
        ExecControlStatus::NonceMismatch => io::ErrorKind::PermissionDenied,
        ExecControlStatus::Unsupported => io::ErrorKind::Unsupported,
        ExecControlStatus::Rejected => io::ErrorKind::PermissionDenied,
        ExecControlStatus::SinkUnavailable => io::ErrorKind::NotConnected,
        ExecControlStatus::SinkTimeout => io::ErrorKind::TimedOut,
        ExecControlStatus::QueueFull => io::ErrorKind::WouldBlock,
        ExecControlStatus::SinkError => io::ErrorKind::BrokenPipe,
    }
}

fn default_exec_control_status_message(status: ExecControlStatus) -> &'static str {
    match status {
        ExecControlStatus::Delivered => "exec control request delivered",
        ExecControlStatus::Inactive => "exec operation is not active",
        ExecControlStatus::NonceMismatch => "exec operation nonce mismatch",
        ExecControlStatus::Unsupported => "exec control is not supported by this operation",
        ExecControlStatus::Rejected => "exec control request rejected",
        ExecControlStatus::SinkUnavailable => "exec control sink is not connected",
        ExecControlStatus::SinkTimeout => "exec control sink timed out",
        ExecControlStatus::QueueFull => "exec control queue is full",
        ExecControlStatus::SinkError => "exec control sink error",
    }
}

fn duration_to_request_timeout_ms(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }

    u32::try_from(timeout.as_millis())
        .unwrap_or(u32::MAX)
        .max(1)
}

fn exec_termination_requires_low_level_warning(termination: ExecTermination) -> bool {
    match termination {
        ExecTermination::Exited { .. } => false,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => true,
    }
}

fn exec_terminal_cancel_is_expected(context: ExecTerminalLogContext) -> bool {
    matches!(context.termination, ExecTermination::Cancelled)
        && context.host_cancel_requested
        && !context.stdout_truncated
        && !context.stderr_truncated
        && !context.stream_overflowed
        && !context.diagnostic_present
}

fn exec_terminal_log_lifecycle(lifecycle: &ExecOperationLifecycle) -> ExecTerminalLogLifecycle {
    match lifecycle {
        ExecOperationLifecycle::OneShot => ExecTerminalLogLifecycle::OneShot,
        ExecOperationLifecycle::SupervisedAwaitingStart { .. }
        | ExecOperationLifecycle::SupervisedStarted { .. } => ExecTerminalLogLifecycle::Supervised,
    }
}

fn exec_terminal_log_severity(context: ExecTerminalLogContext) -> Option<ExecTerminalLogSeverity> {
    if exec_terminal_cancel_is_expected(context) {
        return Some(ExecTerminalLogSeverity::Info);
    }

    let notable = exec_termination_requires_low_level_warning(context.termination)
        || context.stdout_truncated
        || context.stderr_truncated
        || context.stream_overflowed
        || context.diagnostic_present;
    if notable {
        return Some(ExecTerminalLogSeverity::Warn);
    }
    if !context.slow {
        return None;
    }
    match context.lifecycle {
        ExecTerminalLogLifecycle::OneShot => Some(ExecTerminalLogSeverity::Warn),
        ExecTerminalLogLifecycle::Supervised => Some(ExecTerminalLogSeverity::Info),
    }
}

fn exec_operation_label_log(label: &str) -> String {
    if label.len() <= EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES {
        return label.to_string();
    }

    let mut end = EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES;
    while !label.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &label[..end])
}

fn exec_operation_captured_output_truncated(output: ExecCapturedOutput<'_>) -> bool {
    matches!(
        output,
        ExecCapturedOutput::Captured {
            truncated: true,
            ..
        }
    )
}

pub(crate) fn log_operations_closed(reason: &'static str, snapshot: &ExecOperationCloseSnapshot) {
    if snapshot.active_count == 0 {
        return;
    }

    let active_operations = snapshot
        .operations
        .iter()
        .map(|operation| {
            format!(
                "seq={} label={} elapsed_ms={}",
                operation.seq, operation.label_log, operation.elapsed_ms
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let active_omitted = snapshot
        .active_count
        .saturating_sub(snapshot.operations.len());
    tracing::warn!(
        reason = reason,
        active_count = snapshot.active_count,
        active_omitted,
        active_operations = %active_operations,
        "closing connection with active exec operations"
    );
}

fn output_policy_streams(policy: ExecOutputPolicy) -> bool {
    matches!(
        policy,
        ExecOutputPolicy::Stream { .. } | ExecOutputPolicy::CaptureAndStream { .. }
    )
}

fn stream_queue_capacity_for(
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
    requested: Option<usize>,
) -> io::Result<Option<usize>> {
    if matches!(requested, Some(0)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec stream queue capacity must be positive",
        ));
    }
    if let Some(capacity) = requested
        && capacity > MAX_EXEC_STREAM_CAPACITY
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("exec stream queue capacity must be at most {MAX_EXEC_STREAM_CAPACITY}"),
        ));
    }
    let streams_output = output_policy_streams(stdout) || output_policy_streams(stderr);
    if !streams_output && requested.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec stream queue capacity requires a streaming output policy",
        ));
    }
    if streams_output {
        Ok(Some(requested.unwrap_or(DEFAULT_EXEC_STREAM_CAPACITY)))
    } else {
        Ok(None)
    }
}

fn capture_state(policy: ExecOutputPolicy) -> ExecCaptureState {
    match policy {
        ExecOutputPolicy::Discard | ExecOutputPolicy::Stream { .. } => ExecCaptureState::Discard,
        ExecOutputPolicy::Capture { limit_bytes }
        | ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: limit_bytes,
            ..
        } => ExecCaptureState::Capture {
            limit_bytes: limit_bytes as usize,
        },
    }
}

fn stream_state(policy: ExecOutputPolicy) -> Option<ExecStreamState> {
    match policy {
        ExecOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        }
        | ExecOutputPolicy::CaptureAndStream {
            stream_limit_bytes: limit_bytes,
            chunk_limit_bytes,
            ..
        } => Some(ExecStreamState {
            limit_bytes: limit_bytes as usize,
            chunk_limit_bytes: chunk_limit_bytes as usize,
            emitted_bytes: 0,
            truncated: false,
        }),
        ExecOutputPolicy::Discard | ExecOutputPolicy::Capture { .. } => None,
    }
}

fn validate_output(
    operation: &mut ExecOperation,
    output: &vsock_proto::DecodedExecOutput<'_>,
) -> io::Result<()> {
    if output.output_seq != operation.expected_output_seq {
        return Err(exec_operation_protocol_error(format!(
            "exec output seq mismatch: {} != {}",
            output.output_seq, operation.expected_output_seq
        )));
    }
    let stream = match output.stream {
        ExecOutputStream::Stdout => &mut operation.stdout_stream,
        ExecOutputStream::Stderr => &mut operation.stderr_stream,
    };
    let Some(stream) = stream else {
        return Err(exec_operation_protocol_error(
            "exec output received for non-streaming output policy",
        ));
    };
    if stream.truncated {
        return Err(exec_operation_protocol_error(
            "exec output received after stream truncation",
        ));
    }
    if output.chunk.is_empty() && !output.truncated {
        return Err(exec_operation_protocol_error(
            "exec output empty chunk must mark stream truncation",
        ));
    }
    if output.chunk.len() > stream.chunk_limit_bytes {
        return Err(exec_operation_protocol_error(
            "exec output chunk exceeds requested chunk limit",
        ));
    }
    let emitted_bytes = stream
        .emitted_bytes
        .checked_add(output.chunk.len())
        .ok_or_else(|| exec_operation_protocol_error("exec output stream byte count overflow"))?;
    if emitted_bytes > stream.limit_bytes {
        return Err(exec_operation_protocol_error(
            "exec output exceeds requested stream limit",
        ));
    }
    stream.emitted_bytes = emitted_bytes;
    if output.truncated {
        stream.truncated = true;
    }
    operation.expected_output_seq = operation.expected_output_seq.wrapping_add(1);
    Ok(())
}

fn validate_result_output(
    name: &str,
    state: &ExecCaptureState,
    output: ExecCapturedOutput<'_>,
) -> io::Result<()> {
    match (state, output) {
        (ExecCaptureState::Discard, ExecCapturedOutput::Discarded) => Ok(()),
        (ExecCaptureState::Discard, ExecCapturedOutput::Captured { .. }) => {
            Err(exec_operation_protocol_error(format!(
                "exec result {name} captured output for non-capturing policy",
            )))
        }
        (ExecCaptureState::Capture { limit_bytes }, ExecCapturedOutput::Captured { bytes, .. })
            if bytes.len() <= *limit_bytes =>
        {
            Ok(())
        }
        (ExecCaptureState::Capture { limit_bytes }, ExecCapturedOutput::Captured { bytes, .. }) => {
            Err(exec_operation_protocol_error(format!(
                "exec result {name} exceeds requested capture limit: {} > {limit_bytes}",
                bytes.len()
            )))
        }
        (ExecCaptureState::Capture { .. }, ExecCapturedOutput::Discarded) => {
            Err(exec_operation_protocol_error(format!(
                "exec result {name} discarded output for capturing policy",
            )))
        }
    }
}

fn validate_result(
    operation: &ExecOperation,
    result: &vsock_proto::DecodedExecResult<'_>,
) -> io::Result<()> {
    validate_result_output("stdout", &operation.stdout_capture, result.stdout)?;
    validate_result_output("stderr", &operation.stderr_capture, result.stderr)
}

fn owned_captured_output(output: ExecCapturedOutput<'_>) -> ExecOwnedCapturedOutput {
    match output {
        ExecCapturedOutput::Discarded => ExecOwnedCapturedOutput::Discarded,
        ExecCapturedOutput::Captured { bytes, truncated } => ExecOwnedCapturedOutput::Captured {
            bytes: bytes.to_vec(),
            truncated,
        },
    }
}

fn owned_output_event(output: vsock_proto::DecodedExecOutput<'_>) -> ExecOutputEvent {
    ExecOutputEvent {
        stream: output.stream,
        output_seq: output.output_seq,
        chunk: output.chunk.to_vec(),
        truncated: output.truncated,
    }
}

fn owned_result(
    result: vsock_proto::DecodedExecResult<'_>,
    stream_overflowed: bool,
) -> ExecOperationResult {
    ExecOperationResult {
        termination: result.termination,
        duration_ms: result.duration_ms,
        stdout: owned_captured_output(result.stdout),
        stderr: owned_captured_output(result.stderr),
        diagnostic: result.diagnostic.to_string(),
        stream_overflowed,
    }
}

/// Returns true when exec handling consumed the frame; false lets the normal
/// pending-response dispatcher handle it.
pub(crate) fn dispatch_incoming_frame(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<bool> {
    match msg.msg_type {
        MSG_ERROR => dispatch_error(shared, msg),
        MSG_EXEC_OUTPUT => dispatch_output(shared, msg).map(|_| true),
        MSG_EXEC_STARTED => dispatch_started(shared, msg).map(|_| true),
        MSG_EXEC_RESULT => dispatch_result(shared, msg).map(|_| true),
        MSG_EXEC_CONTROL_RESULT => dispatch_control_result(shared, msg).map(|_| true),
        _ => Ok(false),
    }
}

fn dispatch_output(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let mut first_output_slow = None;
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard
            && let Some(operation) = operations.get_mut(msg.seq)
        {
            let decoded = vsock_proto::decode_exec_output(&msg.payload)
                .map_err(exec_operation_protocol_error)?;
            if !operation.allows_output() {
                return Err(exec_operation_protocol_error(
                    "exec output arrived before exec_started",
                ));
            }
            validate_output(operation, &decoded)?;
            first_output_slow = operation.diagnostic.mark_first_output();
            if let Some(tx) = operation.stream_tx.take() {
                match tx.try_reserve_owned() {
                    Ok(permit) => {
                        operation.stream_tx = Some(permit.send(owned_output_event(decoded)));
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        operation.stream_overflowed = true;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {}
                }
            }
        }
    }

    if let Some(snapshot) = first_output_slow {
        tracing::warn!(
            seq = snapshot.seq,
            label = %snapshot.label_log,
            elapsed_ms = snapshot.elapsed_ms,
            "slow exec operation first output"
        );
    }

    Ok(())
}

fn dispatch_started(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let start = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                let Some(operation) = operations.get_mut(msg.seq) else {
                    return Ok(());
                };
                let decoded = vsock_proto::decode_exec_started(&msg.payload)
                    .map_err(exec_operation_protocol_error)?;
                let lifecycle =
                    std::mem::replace(&mut operation.lifecycle, ExecOperationLifecycle::OneShot);
                match lifecycle {
                    ExecOperationLifecycle::SupervisedAwaitingStart {
                        mut start_tx,
                        control_nonce,
                    } => {
                        let start_tx = start_tx.take();
                        operation.lifecycle = ExecOperationLifecycle::SupervisedStarted {
                            pid: decoded.pid,
                            control_nonce,
                        };
                        start_tx.map(|start_tx| (start_tx, decoded.pid))
                    }
                    lifecycle @ ExecOperationLifecycle::SupervisedStarted { pid, .. } => {
                        operation.lifecycle = lifecycle;
                        return Err(exec_operation_protocol_error(format!(
                            "duplicate exec_started for pid {pid}",
                        )));
                    }
                    ExecOperationLifecycle::OneShot => {
                        return Err(exec_operation_protocol_error(
                            "exec_started received for one-shot exec operation",
                        ));
                    }
                }
            }
            ConnectionState::Closed => None,
        }
    };

    if let Some((start_tx, pid)) = start {
        let _ = start_tx.send(Ok(pid));
    }

    Ok(())
}

fn dispatch_result(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let Some((
        diagnostic,
        result_tx,
        start_tx,
        log_lifecycle,
        stream_overflowed,
        host_cancel_requested,
        decoded,
    )) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains(msg.seq) => {
                let decoded = vsock_proto::decode_exec_result(&msg.payload)
                    .map_err(exec_operation_protocol_error)?;
                let Some(operation) = operations.get_mut(msg.seq) else {
                    return Ok(());
                };
                operation.validates_result_before_start(&decoded)?;
                validate_result(operation, &decoded)?;
                let Some(operation) = operations.take(msg.seq) else {
                    return Ok(());
                };
                let ExecOperation {
                    normal_operation,
                    mut lifecycle,
                    diagnostic,
                    result_tx,
                    stream_overflowed,
                    host_cancel_requested,
                    ..
                } = operation;
                let log_lifecycle = exec_terminal_log_lifecycle(&lifecycle);
                let start_tx = match &mut lifecycle {
                    ExecOperationLifecycle::SupervisedAwaitingStart { start_tx, .. } => {
                        start_tx.take()
                    }
                    ExecOperationLifecycle::OneShot
                    | ExecOperationLifecycle::SupervisedStarted { .. } => None,
                };
                if let Some(normal_operation) = normal_operation {
                    normal_operation.complete()?;
                }
                Some((
                    diagnostic,
                    result_tx,
                    start_tx,
                    log_lifecycle,
                    stream_overflowed,
                    host_cancel_requested,
                    decoded,
                ))
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed => None,
        }
    })
    else {
        return Ok(());
    };

    diagnostic.log_terminal(
        log_lifecycle,
        &decoded,
        stream_overflowed,
        host_cancel_requested,
    );
    let result = owned_result(decoded, stream_overflowed);
    if let Some(start_tx) = start_tx {
        let message = if result.diagnostic.is_empty() {
            "supervised exec start failed".to_owned()
        } else {
            result.diagnostic.clone()
        };
        let _ = start_tx.send(Err(io::Error::other(message)));
    }
    let _ = result_tx.send(Ok(result));

    Ok(())
}

fn dispatch_control_result(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let Some(pending) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                operations.take_pending_control(msg.seq)
            }
            ConnectionState::Closed => None,
        }
    }) else {
        return Ok(());
    };
    let decoded = vsock_proto::decode_exec_control_result(&msg.payload)
        .map_err(exec_operation_protocol_error)?;

    if decoded.control_nonce != pending.control_nonce {
        return Err(exec_operation_protocol_error(
            "exec_control_result nonce mismatch",
        ));
    }
    if decoded.target_seq != pending.target_seq {
        return Err(exec_operation_protocol_error(format!(
            "exec_control_result target seq mismatch: expected {}, got {}",
            pending.target_seq, decoded.target_seq
        )));
    }
    if decoded.message_id != pending.message_id {
        return Err(exec_operation_protocol_error(format!(
            "exec_control_result message_id mismatch: expected {}, got {}",
            pending.message_id, decoded.message_id
        )));
    }
    pending
        .normal_operation
        .complete()
        .map_err(normal_operation_transition_error)?;
    let outcome = match decoded.status {
        ExecControlStatus::Delivered => ExecControlOutcome::Delivered(ExecControlAck {
            target_seq: decoded.target_seq,
            message_id: decoded.message_id.to_owned(),
        }),
        status => ExecControlOutcome::GuestStatus(ExecControlGuestStatus {
            status,
            diagnostic: decoded.diagnostic.to_owned(),
        }),
    };
    let _ = pending.response_tx.send(Ok(outcome));
    Ok(())
}

fn dispatch_error(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<bool> {
    let Some((diagnostic, result_tx, start_tx, err)) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains(msg.seq) => {
                let err = vsock_proto::decode_error(&msg.payload)
                    .map(|message| io::Error::other(message.to_string()))
                    .map_err(exec_operation_protocol_error)?;
                let Some(operation) = operations.take(msg.seq) else {
                    return Ok(false);
                };
                let ExecOperation {
                    normal_operation,
                    mut lifecycle,
                    diagnostic,
                    result_tx,
                    ..
                } = operation;
                let start_tx = match &mut lifecycle {
                    ExecOperationLifecycle::SupervisedAwaitingStart { start_tx, .. } => {
                        start_tx.take()
                    }
                    ExecOperationLifecycle::OneShot
                    | ExecOperationLifecycle::SupervisedStarted { .. } => None,
                };
                if let Some(normal_operation) = normal_operation {
                    normal_operation.complete()?;
                }
                Some((diagnostic, result_tx, start_tx, err))
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed => None,
        }
    }) else {
        return dispatch_control_error(shared, msg);
    };

    diagnostic.log_error_response(&err);
    if let Some(start_tx) = start_tx {
        let _ = start_tx.send(Err(io::Error::new(err.kind(), err.to_string())));
    }
    let _ = result_tx.send(Err(err));
    Ok(true)
}

fn dispatch_control_error(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<bool> {
    let Some(pending) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                operations.take_pending_control(msg.seq)
            }
            ConnectionState::Closed => None,
        }
    }) else {
        return Ok(false);
    };
    let message = vsock_proto::decode_error(&msg.payload)
        .map(|message| message.to_owned())
        .map_err(exec_operation_protocol_error)?;
    pending
        .normal_operation
        .complete()
        .map_err(normal_operation_transition_error)?;
    let _ = pending
        .response_tx
        .send(Ok(ExecControlOutcome::GuestError(message)));
    Ok(true)
}

fn mark_exec_operation_possible_guest_write(shared: &Arc<Shared>, seq: u32) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            let Some(operation) = operations.get_mut(seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "exec operation closed before frame write",
                ));
            };
            if let Some(normal_operation) = operation.normal_operation.as_mut() {
                normal_operation.mark_possible_guest_write_started()
            } else {
                Ok(())
            }
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

fn clear_exec_operation_stream_sender(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard
        && let Some(operation) = operations.get_mut(seq)
    {
        operation.stream_tx = None;
    }
}

fn remove_pending_exec_control(shared: &Arc<Shared>, request_seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard {
        operations.remove_pending_control(request_seq);
    }
}

fn mark_pending_exec_control_possible_guest_write(
    shared: &Arc<Shared>,
    target_seq: u32,
    request_seq: u32,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            let Some(operation) = operations.get_mut(target_seq) else {
                return Err(exec_control_status_error(
                    ExecControlStatus::Inactive,
                    "exec operation is not active",
                ));
            };
            let Some(pending) = operation.pending_controls.get_mut(&request_seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "exec control request closed before frame write",
                ));
            };
            pending
                .normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error)
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

async fn write_frame(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    normal_operation_seq: Option<u32>,
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    write_frame_with_pre_write(shared, msg_type, seq, payload, diagnostic, || {
        if let Some(normal_operation_seq) = normal_operation_seq {
            mark_exec_operation_possible_guest_write(shared, normal_operation_seq)?;
        }
        write_observer.record_write_start()
    })
    .await
}

async fn write_frame_with_pre_write(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    pre_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let state = Arc::new(AtomicU8::new(EXEC_OPERATION_FRAME_WRITE_NOT_STARTED));
    let guard = ExecOperationFrameWriteGuard::new(Arc::clone(shared), Arc::clone(&state));

    let wait_started_at = Instant::now();
    let mut writer = shared.writer.lock().await;
    let wait_elapsed_ms = wait_started_at.elapsed().as_millis();
    pre_write()?;
    state.store(EXEC_OPERATION_FRAME_WRITE_STARTED, Ordering::Release);
    let write_started_at = Instant::now();
    let result = writer.write_all(&data).await;
    let write_elapsed_ms = write_started_at.elapsed().as_millis();
    if result.is_ok() {
        state.store(EXEC_OPERATION_FRAME_WRITE_COMPLETED, Ordering::Release);
    } else {
        shared.poison_connection();
    }
    drop(writer);

    if wait_elapsed_ms >= EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD.as_millis()
        && let Some(diagnostic) = &diagnostic
    {
        tracing::warn!(
            seq = diagnostic.seq,
            label = %diagnostic.label_log,
            frame = diagnostic.frame,
            wait_elapsed_ms,
            "slow exec operation frame writer lock wait"
        );
    }

    if write_elapsed_ms >= EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD.as_millis()
        && result.is_ok()
        && let Some(diagnostic) = &diagnostic
    {
        tracing::warn!(
            seq = diagnostic.seq,
            label = %diagnostic.label_log,
            frame = diagnostic.frame,
            write_elapsed_ms,
            "slow exec operation frame write"
        );
    }

    if let Err(e) = result {
        if let Some(diagnostic) = &diagnostic {
            tracing::warn!(
                seq = diagnostic.seq,
                label = %diagnostic.label_log,
                frame = diagnostic.frame,
                write_elapsed_ms,
                error = %e,
                "exec operation frame write failed"
            );
        }
        return Err(e);
    }

    drop(guard);

    Ok(())
}

async fn exec_control_on_shared(
    shared: &Arc<Shared>,
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    control_payload: &[u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecControlOutcome> {
    let request_timeout_ms = duration_to_request_timeout_ms(timeout);
    let payload = vsock_proto::encode_exec_control(
        target_seq,
        control_nonce,
        message_id,
        control_payload,
        request_timeout_ms,
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let request_seq = shared.next_seq();
    let normal_operation = shared.reserve_normal_operation()?;
    let (response_tx, response_rx) = oneshot::channel();
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { operations, .. } => {
                operations.insert_pending_control(
                    target_seq,
                    request_seq,
                    PendingExecControl {
                        target_seq,
                        message_id: message_id.to_owned(),
                        control_nonce,
                        response_tx,
                        normal_operation,
                    },
                )?;
            }
        }
    }
    let _pending_guard = PendingExecControlGuard::new(Arc::clone(shared), request_seq);
    write_frame_with_pre_write(
        shared,
        MSG_EXEC_CONTROL,
        request_seq,
        &payload,
        None,
        || {
            mark_pending_exec_control_possible_guest_write(shared, target_seq, request_seq)?;
            write_observer.record_write_start()
        },
    )
    .await?;

    tokio::select! {
        biased;
        result = response_rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))?
        }
        _ = tokio::time::sleep(timeout) => {
            Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
        }
    }
}

fn capture_output_to_bytes(
    name: &str,
    output: ExecOwnedCapturedOutput,
) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("exec result discarded {name} for capture request"),
        )),
    }
}

pub(crate) fn append_diagnostic(stderr: &mut Vec<u8>, diagnostic: &str) {
    if diagnostic.is_empty() {
        return;
    }
    if !stderr.is_empty() && !stderr.ends_with(b"\n") {
        stderr.push(b'\n');
    }
    stderr.extend_from_slice(diagnostic.as_bytes());
}

fn result_to_exec_result(result: ExecOperationResult) -> io::Result<ExecResult> {
    if result.stream_overflowed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "exec capture unexpectedly overflowed a stream queue",
        ));
    }

    let (stdout, stdout_truncated) = capture_output_to_bytes("stdout", result.stdout)?;
    let (mut stderr, stderr_truncated) = capture_output_to_bytes("stderr", result.stderr)?;

    let exit_code = match result.termination {
        ExecTermination::Exited { exit_code } => exit_code,
        ExecTermination::TimedOut => {
            if stderr.is_empty() {
                stderr.extend_from_slice(b"Timeout");
            }
            EXEC_TIMEOUT_EXIT_CODE
        }
        ExecTermination::Cancelled => {
            if stderr.is_empty() {
                stderr.extend_from_slice(b"Cancelled");
            }
            append_diagnostic(&mut stderr, &result.diagnostic);
            1
        }
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            append_diagnostic(&mut stderr, &result.diagnostic);
            1
        }
    };

    Ok(ExecResult {
        exit_code,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

pub(crate) async fn start_exec_operation_on_shared(
    shared: &Arc<Shared>,
    request: ExecOperationRequest<'_>,
) -> io::Result<ExecOperationHandle> {
    start_exec_operation_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        FrameWriteObserver::default(),
    )
    .await
}

async fn start_exec_operation_on_shared_with_tracking(
    shared: &Arc<Shared>,
    request: ExecOperationRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationHandle> {
    if request.timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec operation requires a positive timeout; use supervised exec for unbounded commands",
        ));
    }
    let stream_queue_capacity = stream_queue_capacity_for(
        request.stdout,
        request.stderr,
        request.stream_queue_capacity,
    )?;

    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::Duration {
                timeout_ms: request.timeout_ms,
            },
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
            control: ExecControlPolicy::Disabled,
            stdin_bytes: request.stdin_bytes,
        },
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    let (stream_tx, stream_rx) = match stream_queue_capacity {
        Some(capacity) => {
            let (tx, rx) = mpsc::channel(capacity);
            (Some(tx), Some(rx))
        }
        None => (None, None),
    };
    let (result_tx, result_rx) = oneshot::channel();
    let seq = shared.next_seq();
    let diagnostic = ExecOperationDiagnostic::new(seq, request.label);
    let normal_operation = match tracking {
        ExecOperationTracking::Tracked => Some(ExecOperationNormalTracking::Owned(
            shared.reserve_normal_operation()?,
        )),
        ExecOperationTracking::Composite(normal_operation) => Some(
            ExecOperationNormalTracking::Composite(normal_operation.transition_handle()?),
        ),
        ExecOperationTracking::Untracked => None,
    };
    let tracks_normal_operation = normal_operation.is_some();
    let operation = ExecOperation {
        normal_operation,
        lifecycle: ExecOperationLifecycle::OneShot,
        diagnostic: diagnostic.clone(),
        result_tx,
        stream_tx,
        stdout_capture: capture_state(request.stdout),
        stderr_capture: capture_state(request.stderr),
        stdout_stream: stream_state(request.stdout),
        stderr_stream: stream_state(request.stderr),
        expected_output_seq: 0,
        stream_overflowed: false,
        host_cancel_requested: false,
        pending_controls: HashMap::new(),
    };

    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { operations, .. } => {
                operations.insert(seq, operation);
            }
        }
    }

    let mut registration_guard = ExecOperationRegistrationGuard::new(Arc::clone(shared), seq);
    write_frame(
        shared,
        MSG_EXEC_START,
        seq,
        &payload,
        Some(diagnostic.frame("start")),
        tracks_normal_operation.then_some(seq),
        write_observer,
    )
    .await?;
    registration_guard.disarm();

    Ok(ExecOperationHandle {
        shared: Arc::clone(shared),
        seq: Some(seq),
        diagnostic,
        result_rx: Some(result_rx),
        stream_rx,
    })
}

pub(crate) async fn start_supervised_exec_on_shared(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
) -> io::Result<SupervisedExecHandle> {
    start_supervised_exec_on_shared_with_after_start_write(shared, request, ready(())).await
}

async fn start_supervised_exec_on_shared_with_after_start_write<F>(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
    after_start_write: F,
) -> io::Result<SupervisedExecHandle>
where
    F: Future<Output = ()>,
{
    start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout(
        shared,
        request,
        after_start_write,
        EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT,
    )
    .await
}

async fn start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout<F>(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
    after_start_write: F,
    start_timeout_cancel_write_timeout: Duration,
) -> io::Result<SupervisedExecHandle>
where
    F: Future<Output = ()>,
{
    let stream_queue_capacity = stream_queue_capacity_for(
        request.stdout,
        request.stderr,
        request.stream_queue_capacity,
    )?;
    let (control, control_nonce) = match request.control {
        SupervisedExecControl::Disabled => (ExecControlPolicy::Disabled, None),
        SupervisedExecControl::Enabled { sink } => {
            let control_nonce = *uuid::Uuid::new_v4().as_bytes();
            (
                ExecControlPolicy::Enabled {
                    control_nonce,
                    sink,
                },
                Some(control_nonce),
            )
        }
    };
    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            timeout: request.timeout,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
            control,
            stdin_bytes: request.stdin_bytes,
        },
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;

    let (stream_tx, stream_rx) = match stream_queue_capacity {
        Some(capacity) => {
            let (tx, rx) = mpsc::channel(capacity);
            (Some(tx), Some(rx))
        }
        None => (None, None),
    };
    let (result_tx, result_rx) = oneshot::channel();
    let (start_tx, start_rx) = oneshot::channel();
    let seq = shared.next_seq();
    let diagnostic = ExecOperationDiagnostic::new(seq, request.label);
    let operation = ExecOperation {
        normal_operation: Some(ExecOperationNormalTracking::Owned(
            shared.reserve_normal_operation()?,
        )),
        lifecycle: ExecOperationLifecycle::SupervisedAwaitingStart {
            start_tx: Some(start_tx),
            control_nonce,
        },
        diagnostic: diagnostic.clone(),
        result_tx,
        stream_tx,
        stdout_capture: capture_state(request.stdout),
        stderr_capture: capture_state(request.stderr),
        stdout_stream: stream_state(request.stdout),
        stderr_stream: stream_state(request.stderr),
        expected_output_seq: 0,
        stream_overflowed: false,
        host_cancel_requested: false,
        pending_controls: HashMap::new(),
    };

    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { operations, .. } => {
                operations.insert(seq, operation);
            }
        }
    }

    let mut registration_guard = ExecOperationRegistrationGuard::new(Arc::clone(shared), seq);
    let mut start_cancel_on_drop =
        ExecOperationCancelOnDropGuard::new_for_seq(Arc::clone(shared), seq, diagnostic.clone());
    let start_write_result = write_frame(
        shared,
        MSG_EXEC_START,
        seq,
        &payload,
        Some(diagnostic.frame("start")),
        Some(seq),
        FrameWriteObserver::default(),
    )
    .await;
    if let Err(error) = start_write_result {
        start_cancel_on_drop.disarm();
        return Err(error);
    }
    after_start_write.await;

    let pid = tokio::select! {
        biased;
        result = start_rx => {
            match result {
                Ok(Ok(pid)) => pid,
                Ok(Err(error)) => {
                    start_cancel_on_drop.disarm();
                    return Err(error);
                }
                Err(_) => {
                    start_cancel_on_drop.disarm();
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection closed",
                    ));
                }
            }
        }
        _ = tokio::time::sleep(request.start_timeout) => {
            let payload = vsock_proto::encode_exec_cancel();
            shared.remove_operation(seq);
            registration_guard.disarm();
            let cancel_result = tokio::time::timeout(
                start_timeout_cancel_write_timeout,
                write_frame(
                    shared,
                    MSG_EXEC_CANCEL,
                    seq,
                    &payload,
                    Some(diagnostic.frame("start-timeout-cancel")),
                    None,
                    FrameWriteObserver::default(),
                ),
            )
            .await
            .unwrap_or_else(|_| {
                tracing::warn!(
                    seq = seq,
                    label = %diagnostic.label_log,
                    elapsed_ms = diagnostic.elapsed_ms(),
                    "supervised exec start timeout cancel write timed out"
                );
                shared.poison_connection();
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "supervised exec start timeout cancel write timed out",
                ))
            });
            start_cancel_on_drop.disarm();
            cancel_result?;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "supervised exec start acknowledgement timeout",
            ));
        }
    };
    start_cancel_on_drop.disarm();
    registration_guard.disarm();

    Ok(SupervisedExecHandle {
        shared: Arc::clone(shared),
        seq: Some(seq),
        pid,
        diagnostic,
        cancel_handle_taken: false,
        result_rx: Some(result_rx),
        stream_rx,
        control: control_nonce.map(|control_nonce| ExecControlHandle {
            shared: Arc::clone(shared),
            target_seq: seq,
            control_nonce,
        }),
    })
}

pub(crate) async fn exec_operation_capture_on_shared(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
) -> io::Result<ExecOperationResult> {
    let handle = start_exec_operation_on_shared(
        shared,
        ExecOperationRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: request.stdout_limit_bytes,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: request.stderr_limit_bytes,
            },
            expected_exit_codes: request.expected_exit_codes,
            stdin_bytes: request.stdin_bytes,
            stream_queue_capacity: None,
        },
    )
    .await?;
    handle.wait(request.wait_timeout).await
}

async fn exec_operation_capture_on_shared_with_tracking(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationResult> {
    let handle = start_exec_operation_on_shared_with_tracking(
        shared,
        ExecOperationRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: request.stdout_limit_bytes,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: request.stderr_limit_bytes,
            },
            expected_exit_codes: request.expected_exit_codes,
            stdin_bytes: request.stdin_bytes,
            stream_queue_capacity: None,
        },
        tracking,
        write_observer,
    )
    .await?;
    handle.wait(request.wait_timeout).await
}

pub(crate) async fn exec_operation_stream_on_shared(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
) -> io::Result<ExecOperationHandle> {
    exec_operation_stream_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        FrameWriteObserver::default(),
    )
    .await
}

async fn exec_operation_stream_on_shared_with_tracking(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
    tracking: ExecOperationTracking<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationHandle> {
    if !output_policy_streams(request.stdout) && !output_policy_streams(request.stderr) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec_operation_stream requires a streaming output policy",
        ));
    }

    start_exec_operation_on_shared_with_tracking(
        shared,
        ExecOperationRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
            stdin_bytes: request.stdin_bytes,
            stream_queue_capacity: request.stream_queue_capacity,
        },
        tracking,
        write_observer,
    )
    .await
}

pub(crate) async fn exec_operation_stream_with_composite_on_shared_and_observer(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecOperationHandle> {
    exec_operation_stream_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Composite(normal_operation),
        write_observer,
    )
    .await
}

pub(crate) async fn exec_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<ExecResult> {
    let request_timeout = Duration::from_millis(timeout_ms as u64 + 5000);
    exec_capture_on_shared(
        shared,
        ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label: "exec",
            stdout_limit_bytes: DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: DEFAULT_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: request_timeout,
        },
    )
    .await
}

pub(crate) async fn exec_cleanup_untracked_on_shared_with_write_observer(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecResult> {
    let result = exec_operation_capture_on_shared_with_tracking(
        shared,
        ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label: "exec-cleanup",
            stdout_limit_bytes: SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(timeout_ms as u64),
        },
        ExecOperationTracking::Untracked,
        write_observer,
    )
    .await?;
    result_to_exec_result(result)
}

pub(crate) async fn exec_cleanup_with_composite_on_shared_and_observer(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecResult> {
    let result = exec_operation_capture_on_shared_with_tracking(
        shared,
        ExecCaptureRequest {
            timeout_ms,
            command,
            env,
            sudo,
            label: "exec-cleanup",
            stdout_limit_bytes: SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(timeout_ms as u64),
        },
        ExecOperationTracking::Composite(normal_operation),
        write_observer,
    )
    .await?;
    result_to_exec_result(result)
}

pub(crate) async fn exec_capture_with_composite_on_shared_and_observer(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecResult> {
    let result = exec_operation_capture_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Composite(normal_operation),
        write_observer,
    )
    .await?;
    result_to_exec_result(result)
}

pub(crate) async fn exec_capture_on_shared(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
) -> io::Result<ExecResult> {
    exec_capture_on_shared_with_write_observer(shared, request, FrameWriteObserver::default()).await
}

pub(crate) async fn exec_capture_on_shared_with_write_observer(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecResult> {
    if request.timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec requires a positive timeout; use supervised exec for unbounded commands",
        ));
    }
    let result = exec_operation_capture_on_shared_with_tracking(
        shared,
        request,
        ExecOperationTracking::Tracked,
        write_observer,
    )
    .await?;
    result_to_exec_result(result)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) const MAX_STREAM_CAPACITY: usize = MAX_EXEC_STREAM_CAPACITY;

    pub(crate) fn drop_started_frame_write_guard(shared: Arc<Shared>) {
        let state = Arc::new(AtomicU8::new(EXEC_OPERATION_FRAME_WRITE_STARTED));
        drop(ExecOperationFrameWriteGuard::new(shared, state));
    }

    pub(crate) async fn start_supervised_exec_after_start_write<F>(
        shared: &Arc<Shared>,
        request: SupervisedExecRequest<'_>,
        after_start_write: F,
        start_timeout_cancel_write_timeout: Duration,
    ) -> io::Result<SupervisedExecHandle>
    where
        F: Future<Output = ()>,
    {
        start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout(
            shared,
            request,
            after_start_write,
            start_timeout_cancel_write_timeout,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fmt;
    use std::os::fd::AsRawFd;
    use std::sync::atomic::AtomicU32;
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncReadExt;
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Subscriber};
    use tracing_subscriber::layer::{Context, Layer};
    use tracing_subscriber::prelude::*;

    #[derive(Clone, Debug)]
    struct CapturedEvent {
        level: Level,
        fields: BTreeMap<String, String>,
    }

    #[derive(Clone, Default)]
    struct CapturedEvents {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl CapturedEvents {
        fn events(&self) -> Vec<CapturedEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl<S> Layer<S> for CapturedEvents
    where
        S: Subscriber,
    {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = CapturedFields::default();
            event.record(&mut visitor);
            self.events.lock().unwrap().push(CapturedEvent {
                level: *event.metadata().level(),
                fields: visitor.fields,
            });
        }
    }

    #[derive(Default)]
    struct CapturedFields {
        fields: BTreeMap<String, String>,
    }

    impl Visit for CapturedFields {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_u64(&mut self, field: &Field, value: u64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_i128(&mut self, field: &Field, value: i128) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_u128(&mut self, field: &Field, value: u128) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_bool(&mut self, field: &Field, value: bool) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
            self.fields
                .insert(field.name().to_string(), format!("{value:?}"));
        }
    }

    fn exec_operation_for_snapshot(seq: u32, label: &str) -> ExecOperation {
        let (result_tx, _result_rx) = oneshot::channel();
        let normal_operations = crate::operation_tracker::NormalOperationTracker::new();
        ExecOperation {
            normal_operation: Some(ExecOperationNormalTracking::Owned(
                normal_operations.reserve().unwrap(),
            )),
            lifecycle: ExecOperationLifecycle::OneShot,
            diagnostic: ExecOperationDiagnostic::new(seq, label),
            result_tx,
            stream_tx: None,
            stdout_capture: ExecCaptureState::Discard,
            stderr_capture: ExecCaptureState::Discard,
            stdout_stream: None,
            stderr_stream: None,
            expected_output_seq: 0,
            stream_overflowed: false,
            host_cancel_requested: false,
            pending_controls: HashMap::new(),
        }
    }

    fn clean_terminal_result() -> vsock_proto::DecodedExecResult<'static> {
        vsock_proto::DecodedExecResult {
            termination: ExecTermination::Exited { exit_code: 0 },
            duration_ms: 10,
            stdout: ExecCapturedOutput::Discarded,
            stderr: ExecCapturedOutput::Discarded,
            diagnostic: "",
        }
    }

    fn capture_terminal_log_levels(
        lifecycle: ExecTerminalLogLifecycle,
        slow: bool,
        result: &vsock_proto::DecodedExecResult<'_>,
    ) -> Vec<Level> {
        capture_terminal_log_levels_with_context(lifecycle, slow, result, false)
    }

    fn capture_terminal_log_levels_with_context(
        lifecycle: ExecTerminalLogLifecycle,
        slow: bool,
        result: &vsock_proto::DecodedExecResult<'_>,
        stream_overflowed: bool,
    ) -> Vec<Level> {
        capture_terminal_log_events_with_context(lifecycle, slow, result, stream_overflowed, false)
            .into_iter()
            .map(|event| event.level)
            .collect()
    }

    fn capture_terminal_log_events_with_context(
        lifecycle: ExecTerminalLogLifecycle,
        slow: bool,
        result: &vsock_proto::DecodedExecResult<'_>,
        stream_overflowed: bool,
        host_cancel_requested: bool,
    ) -> Vec<CapturedEvent> {
        let mut diagnostic = ExecOperationDiagnostic::new(7, "terminal-log");
        if slow {
            diagnostic.registered_at =
                Instant::now() - EXEC_OPERATION_STAGE_SLOW_THRESHOLD - Duration::from_millis(1);
        }
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            diagnostic.log_terminal(lifecycle, result, stream_overflowed, host_cancel_requested);
        });
        captured.events()
    }

    fn assert_terminal_log_field(event: &CapturedEvent, field: &str, expected: &str) {
        let value = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(value, expected, "field {field} mismatch; event={event:#?}");
    }

    fn terminal_log_field_u128(event: &CapturedEvent, field: &str) -> u128 {
        let value = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        value
            .parse()
            .unwrap_or_else(|err| panic!("invalid u128 field {field}={value:?}: {err}"))
    }

    async fn read_exec_operation_frame(stream: &mut tokio::net::UnixStream) -> RawMessage {
        let mut header = [0u8; vsock_proto::HEADER_SIZE];
        stream.read_exact(&mut header).await.unwrap();
        let body_len = u32::from_be_bytes(header) as usize;
        assert!(
            (vsock_proto::MIN_BODY_SIZE..=vsock_proto::MAX_MESSAGE_SIZE).contains(&body_len),
            "invalid message body length: {body_len}",
        );

        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).await.unwrap();
        RawMessage {
            msg_type: body[0],
            seq: u32::from_be_bytes(body[1..vsock_proto::MIN_BODY_SIZE].try_into().unwrap()),
            payload: body[vsock_proto::MIN_BODY_SIZE..].to_vec(),
        }
    }

    #[test]
    fn exec_termination_warning_tracks_low_level_terminal_states() {
        assert!(!exec_termination_requires_low_level_warning(
            ExecTermination::Exited { exit_code: 0 }
        ));
        assert!(!exec_termination_requires_low_level_warning(
            ExecTermination::Exited { exit_code: 1 }
        ));
        assert!(exec_termination_requires_low_level_warning(
            ExecTermination::TimedOut
        ));
        assert!(exec_termination_requires_low_level_warning(
            ExecTermination::Cancelled
        ));
        assert!(exec_termination_requires_low_level_warning(
            ExecTermination::StartFailed
        ));
        assert!(exec_termination_requires_low_level_warning(
            ExecTermination::WaitFailed
        ));
    }

    #[test]
    fn exec_operation_diagnostic_logs_terminal_result_at_classified_level() {
        let clean = clean_terminal_result();
        assert_eq!(
            capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &clean),
            vec![Level::INFO]
        );
        assert_eq!(
            capture_terminal_log_levels(ExecTerminalLogLifecycle::OneShot, true, &clean),
            vec![Level::WARN]
        );
        assert!(
            capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, false, &clean)
                .is_empty()
        );

        let nonzero_exit = vsock_proto::DecodedExecResult {
            termination: ExecTermination::Exited { exit_code: 1 },
            ..clean
        };
        assert_eq!(
            capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &nonzero_exit),
            vec![Level::INFO]
        );
    }

    #[test]
    fn exec_operation_diagnostic_preserves_terminal_log_fields() {
        let clean = clean_terminal_result();
        let info_events = capture_terminal_log_events_with_context(
            ExecTerminalLogLifecycle::Supervised,
            true,
            &clean,
            false,
            false,
        );
        assert_eq!(info_events.len(), 1, "captured events: {info_events:#?}");
        let info_event = &info_events[0];
        assert_eq!(info_event.level, Level::INFO);
        assert_terminal_log_field(info_event, "message", "exec operation terminal result");
        assert_terminal_log_field(info_event, "seq", "7");
        assert_terminal_log_field(info_event, "label", "terminal-log");
        assert!(
            terminal_log_field_u128(info_event, "elapsed_ms")
                >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis(),
            "elapsed_ms should preserve the slow terminal duration; event={info_event:#?}"
        );
        assert_terminal_log_field(info_event, "guest_duration_ms", "10");
        assert_terminal_log_field(info_event, "termination", "Exited { exit_code: 0 }");
        assert_terminal_log_field(info_event, "stream_overflowed", "false");
        assert_terminal_log_field(info_event, "stdout_truncated", "false");
        assert_terminal_log_field(info_event, "stderr_truncated", "false");
        assert_terminal_log_field(info_event, "diagnostic_present", "false");
        assert_terminal_log_field(info_event, "host_cancel_requested", "false");

        let warn_result = vsock_proto::DecodedExecResult {
            termination: ExecTermination::TimedOut,
            duration_ms: 77,
            stdout: ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: true,
            },
            stderr: ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: true,
            },
            diagnostic: "guest diagnostic",
        };
        let warn_events = capture_terminal_log_events_with_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            &warn_result,
            true,
            false,
        );
        assert_eq!(warn_events.len(), 1, "captured events: {warn_events:#?}");
        let warn_event = &warn_events[0];
        assert_eq!(warn_event.level, Level::WARN);
        assert_terminal_log_field(warn_event, "message", "exec operation terminal result");
        assert_terminal_log_field(warn_event, "seq", "7");
        assert_terminal_log_field(warn_event, "label", "terminal-log");
        let _ = terminal_log_field_u128(warn_event, "elapsed_ms");
        assert_terminal_log_field(warn_event, "guest_duration_ms", "77");
        assert_terminal_log_field(warn_event, "termination", "TimedOut");
        assert_terminal_log_field(warn_event, "stream_overflowed", "true");
        assert_terminal_log_field(warn_event, "stdout_truncated", "true");
        assert_terminal_log_field(warn_event, "stderr_truncated", "true");
        assert_terminal_log_field(warn_event, "diagnostic_present", "true");
        assert_terminal_log_field(warn_event, "host_cancel_requested", "false");
    }

    #[test]
    fn exec_operation_diagnostic_logs_host_requested_cancel_as_info() {
        let cancelled = vsock_proto::DecodedExecResult {
            termination: ExecTermination::Cancelled,
            ..clean_terminal_result()
        };
        let events = capture_terminal_log_events_with_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            &cancelled,
            false,
            true,
        );

        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        assert_eq!(events[0].level, Level::INFO);
        assert_terminal_log_field(&events[0], "termination", "Cancelled");
        assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
    }

    #[test]
    fn exec_operation_diagnostic_warns_for_terminal_result_metadata() {
        let clean = clean_terminal_result();
        let stdout_truncated = vsock_proto::DecodedExecResult {
            stdout: ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: true,
            },
            ..clean
        };
        let stderr_truncated = vsock_proto::DecodedExecResult {
            stderr: ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: true,
            },
            ..clean
        };
        let diagnostic_present = vsock_proto::DecodedExecResult {
            diagnostic: "guest diagnostic",
            ..clean
        };

        for (result, stream_overflowed) in [
            (stdout_truncated, false),
            (stderr_truncated, false),
            (diagnostic_present, false),
            (clean, true),
        ] {
            assert_eq!(
                capture_terminal_log_levels_with_context(
                    ExecTerminalLogLifecycle::Supervised,
                    false,
                    &result,
                    stream_overflowed,
                ),
                vec![Level::WARN]
            );
        }
    }

    #[test]
    fn exec_operation_diagnostic_ignores_non_truncated_captured_output() {
        let captured_output = vsock_proto::DecodedExecResult {
            stdout: ExecCapturedOutput::Captured {
                bytes: b"stdout",
                truncated: false,
            },
            stderr: ExecCapturedOutput::Captured {
                bytes: b"stderr",
                truncated: false,
            },
            ..clean_terminal_result()
        };

        assert!(
            capture_terminal_log_levels(
                ExecTerminalLogLifecycle::Supervised,
                false,
                &captured_output,
            )
            .is_empty()
        );
        assert_eq!(
            capture_terminal_log_levels(
                ExecTerminalLogLifecycle::Supervised,
                true,
                &captured_output
            ),
            vec![Level::INFO]
        );
    }

    #[test]
    fn exec_operation_diagnostic_treats_nonzero_exits_as_ordinary_terminal_results() {
        let nonzero_exit = vsock_proto::DecodedExecResult {
            termination: ExecTermination::Exited { exit_code: 66 },
            ..clean_terminal_result()
        };
        assert_eq!(
            capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &nonzero_exit),
            vec![Level::INFO]
        );
        assert!(
            capture_terminal_log_levels(ExecTerminalLogLifecycle::OneShot, false, &nonzero_exit)
                .is_empty()
        );

        let nonzero_exit_with_diagnostic = vsock_proto::DecodedExecResult {
            diagnostic: "nonzero with diagnostic",
            ..nonzero_exit
        };
        assert_eq!(
            capture_terminal_log_levels(
                ExecTerminalLogLifecycle::Supervised,
                true,
                &nonzero_exit_with_diagnostic
            ),
            vec![Level::WARN]
        );
    }

    fn capture_dispatch_terminal_log_events_with_lifecycle(
        lifecycle: ExecOperationLifecycle,
        label: &str,
    ) -> (Vec<CapturedEvent>, ExecOperationResult) {
        capture_dispatch_terminal_log_events_with_options(
            lifecycle,
            label,
            ExecTermination::Exited { exit_code: 0 },
            false,
        )
    }

    fn capture_dispatch_terminal_log_events_with_options(
        lifecycle: ExecOperationLifecycle,
        label: &str,
        termination: ExecTermination,
        host_cancel_requested: bool,
    ) -> (Vec<CapturedEvent>, ExecOperationResult) {
        let (result_tx, mut result_rx) = oneshot::channel();
        let (shared, _read_stream, _diagnostic) =
            shared_with_logged_operation(lifecycle, label, result_tx, host_cancel_requested);
        let payload = vsock_proto::encode_exec_result(
            termination,
            10,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        let msg = RawMessage {
            msg_type: MSG_EXEC_RESULT,
            seq: 7,
            payload,
        };

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            dispatch_result(&shared, &msg).unwrap();
        });

        let events = captured.events();
        let result = result_rx.try_recv().unwrap().unwrap();
        (events, result)
    }

    fn shared_with_logged_operation(
        lifecycle: ExecOperationLifecycle,
        label: &str,
        result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
        host_cancel_requested: bool,
    ) -> (Arc<Shared>, tokio::net::UnixStream, ExecOperationDiagnostic) {
        let (read_stream, write_stream) = tokio::net::UnixStream::pair().unwrap();
        let fd = write_stream.as_raw_fd();
        let (_read_half, write_half) = write_stream.into_split();
        let shared = Arc::new(Shared {
            writer: tokio::sync::Mutex::new(write_half),
            fd,
            seq: AtomicU32::new(2),
            state: std::sync::Mutex::new(ConnectionState::Connected {
                pending: HashMap::new(),
                operations: Operations::new(),
            }),
            normal_operations: crate::operation_tracker::NormalOperationTracker::new(),
            close_notify: tokio::sync::Notify::new(),
        });
        let mut diagnostic = ExecOperationDiagnostic::new(7, label);
        diagnostic.registered_at =
            Instant::now() - EXEC_OPERATION_STAGE_SLOW_THRESHOLD - Duration::from_millis(1);
        {
            let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            let ConnectionState::Connected { operations, .. } = &mut *guard else {
                panic!("test shared state must be connected");
            };
            operations.insert(
                7,
                ExecOperation {
                    normal_operation: None,
                    lifecycle,
                    diagnostic: diagnostic.clone(),
                    result_tx,
                    stream_tx: None,
                    stdout_capture: ExecCaptureState::Discard,
                    stderr_capture: ExecCaptureState::Discard,
                    stdout_stream: None,
                    stderr_stream: None,
                    expected_output_seq: 0,
                    stream_overflowed: false,
                    host_cancel_requested,
                    pending_controls: HashMap::new(),
                },
            );
        }
        (shared, read_stream, diagnostic)
    }

    #[tokio::test]
    async fn dispatch_result_logs_terminal_result_with_operation_lifecycle() {
        let (supervised_events, supervised_result) =
            capture_dispatch_terminal_log_events_with_lifecycle(
                ExecOperationLifecycle::SupervisedStarted {
                    pid: 42,
                    control_nonce: None,
                },
                "dispatch-supervised-terminal-log",
            );
        assert_eq!(
            supervised_events.len(),
            1,
            "captured events: {supervised_events:#?}"
        );
        assert_eq!(supervised_events[0].level, Level::INFO);
        assert_terminal_log_field(
            &supervised_events[0],
            "label",
            "dispatch-supervised-terminal-log",
        );
        assert_eq!(
            supervised_result.termination,
            ExecTermination::Exited { exit_code: 0 }
        );

        let (one_shot_events, one_shot_result) =
            capture_dispatch_terminal_log_events_with_lifecycle(
                ExecOperationLifecycle::OneShot,
                "dispatch-one-shot-terminal-log",
            );
        assert_eq!(
            one_shot_events.len(),
            1,
            "captured events: {one_shot_events:#?}"
        );
        assert_eq!(one_shot_events[0].level, Level::WARN);
        assert_terminal_log_field(
            &one_shot_events[0],
            "label",
            "dispatch-one-shot-terminal-log",
        );
        assert_eq!(
            one_shot_result.termination,
            ExecTermination::Exited { exit_code: 0 }
        );
    }

    #[tokio::test]
    async fn dispatch_result_logs_host_requested_cancel_as_info() {
        let lifecycle = ExecOperationLifecycle::SupervisedStarted {
            pid: 42,
            control_nonce: None,
        };
        let (events, result) = capture_dispatch_terminal_log_events_with_options(
            lifecycle,
            "dispatch-host-cancelled-terminal-log",
            ExecTermination::Cancelled,
            true,
        );

        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        assert_eq!(events[0].level, Level::INFO);
        assert_terminal_log_field(&events[0], "termination", "Cancelled");
        assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
        assert_eq!(result.termination, ExecTermination::Cancelled);
    }

    #[tokio::test]
    async fn supervised_cancel_frame_marks_terminal_result_as_host_requested_cancel() {
        let (result_tx, mut result_rx) = oneshot::channel();
        let lifecycle = ExecOperationLifecycle::SupervisedStarted {
            pid: 42,
            control_nonce: None,
        };
        let (shared, _read_stream, diagnostic) = shared_with_logged_operation(
            lifecycle,
            "supervised-cancel-marker-terminal-log",
            result_tx,
            false,
        );

        send_supervised_exec_cancel_frame(&shared, 7, &diagnostic)
            .await
            .unwrap();

        let payload = vsock_proto::encode_exec_result(
            ExecTermination::Cancelled,
            10,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        let msg = RawMessage {
            msg_type: MSG_EXEC_RESULT,
            seq: 7,
            payload,
        };

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            dispatch_result(&shared, &msg).unwrap();
        });

        let events = captured.events();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        assert_eq!(events[0].level, Level::INFO);
        assert_terminal_log_field(&events[0], "termination", "Cancelled");
        assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
        assert_eq!(
            result_rx.try_recv().unwrap().unwrap().termination,
            ExecTermination::Cancelled
        );
    }

    #[tokio::test]
    async fn one_shot_cancel_handle_marks_terminal_result_as_host_requested_cancel() {
        let (result_tx, result_rx) = oneshot::channel();
        let (shared, mut read_stream, diagnostic) = shared_with_logged_operation(
            ExecOperationLifecycle::OneShot,
            "one-shot-cancel-marker-terminal-log",
            result_tx,
            false,
        );
        let handle = ExecOperationHandle {
            shared: Arc::clone(&shared),
            seq: Some(7),
            diagnostic,
            result_rx: Some(result_rx),
            stream_rx: None,
        };

        let cancel_task = tokio::spawn(async move {
            handle
                .cancel_and_wait_for_terminal_status(Duration::from_secs(5))
                .await
        });
        let cancel = read_exec_operation_frame(&mut read_stream).await;
        assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
        assert_eq!(cancel.seq, 7);
        vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

        let payload = vsock_proto::encode_exec_result(
            ExecTermination::Cancelled,
            10,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        let msg = RawMessage {
            msg_type: MSG_EXEC_RESULT,
            seq: 7,
            payload,
        };

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            dispatch_result(&shared, &msg).unwrap();
        });

        let events = captured.events();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        assert_eq!(events[0].level, Level::INFO);
        assert_terminal_log_field(&events[0], "termination", "Cancelled");
        assert_terminal_log_field(&events[0], "host_cancel_requested", "true");

        let wait_result = cancel_task.await.unwrap().unwrap();
        assert_eq!(wait_result.cancel_seq, Some(7));
        assert_eq!(wait_result.result.termination, ExecTermination::Cancelled);
    }

    #[test]
    fn exec_terminal_log_lifecycle_maps_supervised_states() {
        let (start_tx, _start_rx) = oneshot::channel();
        let awaiting_start = ExecOperationLifecycle::SupervisedAwaitingStart {
            start_tx: Some(start_tx),
            control_nonce: None,
        };
        let started = ExecOperationLifecycle::SupervisedStarted {
            pid: 42,
            control_nonce: None,
        };

        assert_eq!(
            exec_terminal_log_lifecycle(&ExecOperationLifecycle::OneShot),
            ExecTerminalLogLifecycle::OneShot
        );
        assert_eq!(
            exec_terminal_log_lifecycle(&awaiting_start),
            ExecTerminalLogLifecycle::Supervised
        );
        assert_eq!(
            exec_terminal_log_lifecycle(&started),
            ExecTerminalLogLifecycle::Supervised
        );
    }

    fn clean_terminal_log_context(
        lifecycle: ExecTerminalLogLifecycle,
        slow: bool,
        termination: ExecTermination,
    ) -> ExecTerminalLogContext {
        ExecTerminalLogContext {
            lifecycle,
            slow,
            termination,
            stdout_truncated: false,
            stderr_truncated: false,
            stream_overflowed: false,
            diagnostic_present: false,
            host_cancel_requested: false,
        }
    }

    #[test]
    fn exec_terminal_log_severity_demotes_slow_clean_supervised_result() {
        let context = clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            true,
            ExecTermination::Exited { exit_code: 0 },
        );

        assert_eq!(
            exec_terminal_log_severity(context),
            Some(ExecTerminalLogSeverity::Info)
        );
    }

    #[test]
    fn exec_terminal_log_severity_warns_for_slow_clean_one_shot_result() {
        let context = clean_terminal_log_context(
            ExecTerminalLogLifecycle::OneShot,
            true,
            ExecTermination::Exited { exit_code: 0 },
        );

        assert_eq!(
            exec_terminal_log_severity(context),
            Some(ExecTerminalLogSeverity::Warn)
        );
    }

    #[test]
    fn exec_terminal_log_severity_suppresses_clean_fast_results() {
        for lifecycle in [
            ExecTerminalLogLifecycle::OneShot,
            ExecTerminalLogLifecycle::Supervised,
        ] {
            let context = clean_terminal_log_context(
                lifecycle,
                false,
                ExecTermination::Exited { exit_code: 0 },
            );

            assert_eq!(exec_terminal_log_severity(context), None);
        }
    }

    #[test]
    fn exec_terminal_log_severity_treats_nonzero_exits_as_ordinary_results() {
        let fast_nonzero = clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            ExecTermination::Exited { exit_code: 66 },
        );
        let slow_nonzero = ExecTerminalLogContext {
            slow: true,
            ..fast_nonzero
        };
        let fast_one_shot_nonzero = ExecTerminalLogContext {
            lifecycle: ExecTerminalLogLifecycle::OneShot,
            ..fast_nonzero
        };
        let slow_one_shot_nonzero = ExecTerminalLogContext {
            lifecycle: ExecTerminalLogLifecycle::OneShot,
            ..slow_nonzero
        };

        assert_eq!(exec_terminal_log_severity(fast_nonzero), None);
        assert_eq!(exec_terminal_log_severity(fast_one_shot_nonzero), None);
        assert_eq!(
            exec_terminal_log_severity(slow_nonzero),
            Some(ExecTerminalLogSeverity::Info)
        );
        assert_eq!(
            exec_terminal_log_severity(slow_one_shot_nonzero),
            Some(ExecTerminalLogSeverity::Warn)
        );
    }

    #[test]
    fn exec_terminal_log_severity_suppresses_fast_nonzero_exits() {
        for lifecycle in [
            ExecTerminalLogLifecycle::OneShot,
            ExecTerminalLogLifecycle::Supervised,
        ] {
            let context = clean_terminal_log_context(
                lifecycle,
                false,
                ExecTermination::Exited { exit_code: 1 },
            );

            assert_eq!(exec_terminal_log_severity(context), None);
        }
    }

    #[test]
    fn exec_terminal_log_severity_warns_for_notable_slow_supervised_result() {
        let clean_slow = clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            true,
            ExecTermination::Exited { exit_code: 0 },
        );
        for context in [
            ExecTerminalLogContext {
                stdout_truncated: true,
                ..clean_slow
            },
            ExecTerminalLogContext {
                stderr_truncated: true,
                ..clean_slow
            },
            ExecTerminalLogContext {
                stream_overflowed: true,
                ..clean_slow
            },
            ExecTerminalLogContext {
                diagnostic_present: true,
                ..clean_slow
            },
            ExecTerminalLogContext {
                termination: ExecTermination::TimedOut,
                ..clean_slow
            },
        ] {
            assert_eq!(
                exec_terminal_log_severity(context),
                Some(ExecTerminalLogSeverity::Warn)
            );
        }
    }

    #[test]
    fn exec_terminal_log_severity_warns_for_notable_result_metadata() {
        for lifecycle in [
            ExecTerminalLogLifecycle::OneShot,
            ExecTerminalLogLifecycle::Supervised,
        ] {
            let clean = clean_terminal_log_context(
                lifecycle,
                false,
                ExecTermination::Exited { exit_code: 0 },
            );
            for context in [
                ExecTerminalLogContext {
                    stdout_truncated: true,
                    ..clean
                },
                ExecTerminalLogContext {
                    stderr_truncated: true,
                    ..clean
                },
                ExecTerminalLogContext {
                    stream_overflowed: true,
                    ..clean
                },
                ExecTerminalLogContext {
                    diagnostic_present: true,
                    ..clean
                },
            ] {
                assert_eq!(
                    exec_terminal_log_severity(context),
                    Some(ExecTerminalLogSeverity::Warn)
                );
            }
        }
    }

    #[test]
    fn exec_terminal_log_severity_demotes_expected_host_cancel() {
        for lifecycle in [
            ExecTerminalLogLifecycle::OneShot,
            ExecTerminalLogLifecycle::Supervised,
        ] {
            let context = ExecTerminalLogContext {
                host_cancel_requested: true,
                ..clean_terminal_log_context(lifecycle, false, ExecTermination::Cancelled)
            };

            assert_eq!(
                exec_terminal_log_severity(context),
                Some(ExecTerminalLogSeverity::Info)
            );
        }
    }

    #[test]
    fn exec_terminal_log_severity_warns_for_expected_host_cancel_with_metadata() {
        let clean_cancel = ExecTerminalLogContext {
            host_cancel_requested: true,
            ..clean_terminal_log_context(
                ExecTerminalLogLifecycle::Supervised,
                false,
                ExecTermination::Cancelled,
            )
        };
        for context in [
            ExecTerminalLogContext {
                stdout_truncated: true,
                ..clean_cancel
            },
            ExecTerminalLogContext {
                stderr_truncated: true,
                ..clean_cancel
            },
            ExecTerminalLogContext {
                stream_overflowed: true,
                ..clean_cancel
            },
            ExecTerminalLogContext {
                diagnostic_present: true,
                ..clean_cancel
            },
        ] {
            assert_eq!(
                exec_terminal_log_severity(context),
                Some(ExecTerminalLogSeverity::Warn)
            );
        }
    }

    #[test]
    fn exec_terminal_log_severity_warns_for_host_cancel_with_failure_terminations() {
        for termination in [
            ExecTermination::TimedOut,
            ExecTermination::StartFailed,
            ExecTermination::WaitFailed,
        ] {
            let context = ExecTerminalLogContext {
                host_cancel_requested: true,
                ..clean_terminal_log_context(
                    ExecTerminalLogLifecycle::Supervised,
                    false,
                    termination,
                )
            };

            assert_eq!(
                exec_terminal_log_severity(context),
                Some(ExecTerminalLogSeverity::Warn)
            );
        }
    }

    #[test]
    fn exec_terminal_log_severity_warns_for_non_exit_terminations() {
        for lifecycle in [
            ExecTerminalLogLifecycle::OneShot,
            ExecTerminalLogLifecycle::Supervised,
        ] {
            for termination in [
                ExecTermination::TimedOut,
                ExecTermination::Cancelled,
                ExecTermination::StartFailed,
                ExecTermination::WaitFailed,
            ] {
                let context = clean_terminal_log_context(lifecycle, false, termination);

                assert_eq!(
                    exec_terminal_log_severity(context),
                    Some(ExecTerminalLogSeverity::Warn)
                );
            }
        }
    }

    #[test]
    fn exec_operation_label_log_truncates_at_utf8_boundary() {
        let exact = "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES);
        assert_eq!(exec_operation_label_log(&exact), exact);

        let over_ascii = format!("{}b", "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES));
        assert_eq!(
            exec_operation_label_log(&over_ascii),
            format!(
                "{}...",
                "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES)
            )
        );

        let boundary = format!(
            "{}\u{00e9}tail",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 2)
        );
        assert_eq!(
            exec_operation_label_log(&boundary),
            format!(
                "{}\u{00e9}...",
                "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 2)
            )
        );

        let crossing = format!(
            "{}\u{00e9}tail",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 1)
        );
        assert_eq!(
            exec_operation_label_log(&crossing),
            format!(
                "{}...",
                "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 1)
            )
        );
    }

    #[test]
    fn exec_operation_diagnostic_keeps_only_truncated_label_log() {
        let label = format!(
            "{}secret-tail",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES)
        );
        let mut diagnostic = ExecOperationDiagnostic::new(7, &label);
        diagnostic.registered_at =
            Instant::now() - EXEC_OPERATION_STAGE_SLOW_THRESHOLD - Duration::from_millis(1);

        assert_eq!(
            diagnostic.label_log,
            format!(
                "{}...",
                "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES)
            )
        );
        assert!(!diagnostic.label_log.contains("secret-tail"));
        assert_eq!(diagnostic.frame("start").label_log, diagnostic.label_log);
        assert_eq!(diagnostic.snapshot().label_log, diagnostic.label_log);
        assert_eq!(
            diagnostic.mark_first_output().unwrap().label_log,
            diagnostic.label_log
        );
    }

    #[test]
    fn exec_operation_diagnostic_marks_only_first_slow_output() {
        let mut diagnostic = ExecOperationDiagnostic {
            seq: 9,
            label_log: "slow-first-output".to_string(),
            registered_at: Instant::now()
                - EXEC_OPERATION_STAGE_SLOW_THRESHOLD
                - Duration::from_millis(1),
            first_output_at: None,
        };

        let snapshot = diagnostic.mark_first_output().unwrap();
        assert_eq!(snapshot.seq, 9);
        assert_eq!(snapshot.label_log, "slow-first-output");
        assert!(snapshot.elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis());
        assert!(diagnostic.mark_first_output().is_none());
    }

    #[test]
    fn exec_operation_close_snapshot_limits_logged_operations() {
        let active_count = EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT + 3;
        let mut operations = Operations::new();
        for seq in 0..active_count {
            operations.insert(
                seq as u32,
                exec_operation_for_snapshot(seq as u32, &format!("operation-{seq}")),
            );
        }

        let snapshot = operations.close_snapshot();
        assert_eq!(snapshot.active_count, active_count);
        assert_eq!(
            snapshot.operations.len(),
            EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT
        );
        assert_eq!(
            snapshot.active_count - snapshot.operations.len(),
            active_count - EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT
        );
        for operation in snapshot.operations {
            assert!(operations.contains(operation.seq));
            assert!(operation.label_log.starts_with("operation-"));
        }
    }
}
