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
    ExecCapturedOutput, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream,
    ExecTermination, ExecTimeoutPolicy, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_START,
    ProcessControlNonce, ProcessControlStatus, RawMessage,
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
    /// Exit codes that should not be treated as notable in diagnostics.
    pub expected_exit_codes: &'a [i32],
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
    pub status: ProcessControlStatus,
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

    fn insert_pending_control(
        &mut self,
        target_seq: u32,
        request_seq: u32,
        pending: PendingExecControl,
    ) -> io::Result<()> {
        let Some(operation) = self.operations.get_mut(&target_seq) else {
            return Err(exec_control_status_error(
                ProcessControlStatus::Inactive,
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
    pending_controls: HashMap<u32, PendingExecControl>,
}

enum ExecOperationLifecycle {
    OneShot,
    SupervisedAwaitingStart {
        start_tx: Option<oneshot::Sender<io::Result<u32>>>,
        control_nonce: Option<ProcessControlNonce>,
    },
    SupervisedStarted {
        pid: u32,
        control_nonce: Option<ProcessControlNonce>,
    },
}

struct PendingExecControl {
    target_seq: u32,
    message_id: String,
    control_nonce: ProcessControlNonce,
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

    fn validate_control_nonce(&self, control_nonce: ProcessControlNonce) -> io::Result<()> {
        match self.lifecycle {
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: Some(expected),
                ..
            } if expected == control_nonce => Ok(()),
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: Some(_),
                ..
            } => Err(exec_control_status_error(
                ProcessControlStatus::NonceMismatch,
                "exec operation nonce mismatch",
            )),
            ExecOperationLifecycle::SupervisedStarted {
                control_nonce: None,
                ..
            } => Err(exec_control_status_error(
                ProcessControlStatus::Unsupported,
                "exec control is not supported by this operation",
            )),
            ExecOperationLifecycle::OneShot
            | ExecOperationLifecycle::SupervisedAwaitingStart { .. } => {
                Err(exec_control_status_error(
                    ProcessControlStatus::Inactive,
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

#[derive(Clone)]
struct ExecOperationDiagnostic {
    seq: u32,
    label_log: String,
    expected_exit_codes: Vec<i32>,
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
    fn new(seq: u32, label: &str, expected_exit_codes: &[i32]) -> Self {
        Self {
            seq,
            label_log: exec_operation_label_log(label),
            expected_exit_codes: expected_exit_codes.to_vec(),
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

    fn log_terminal(&self, result: &vsock_proto::DecodedExecResult<'_>, stream_overflowed: bool) {
        let elapsed_ms = self.elapsed_ms();
        let slow = elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis();
        let notable = exec_termination_is_notable(result.termination, &self.expected_exit_codes)
            || exec_result_has_truncation(result)
            || stream_overflowed
            || !result.diagnostic.is_empty();
        if !slow && !notable {
            return;
        }

        tracing::warn!(
            seq = self.seq,
            label = %self.label_log,
            elapsed_ms,
            guest_duration_ms = result.duration_ms,
            termination = ?result.termination,
            stream_overflowed,
            stdout_truncated = exec_operation_captured_output_truncated(result.stdout),
            stderr_truncated = exec_operation_captured_output_truncated(result.stderr),
            diagnostic_present = !result.diagnostic.is_empty(),
            "exec operation terminal result"
        );
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
            FrameWriteObserver::default(),
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
    result_rx: Option<oneshot::Receiver<io::Result<ExecOperationResult>>>,
    stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
    control: Option<ExecControlHandle>,
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
                    ProcessControlStatus::Unsupported,
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
        let payload = vsock_proto::encode_exec_cancel();
        write_frame(
            &self.shared,
            MSG_EXEC_CANCEL,
            seq,
            &payload,
            Some(self.diagnostic.frame("cancel")),
            None,
            FrameWriteObserver::default(),
        )
        .await?;
        tracing::info!(
            seq = seq,
            label = %self.diagnostic.label_log,
            elapsed_ms = self.diagnostic.elapsed_ms(),
            "supervised exec operation cancel sent"
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
    control_nonce: ProcessControlNonce,
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
                    FrameWriteObserver::default(),
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

fn exec_control_status_error(status: ProcessControlStatus, diagnostic: &str) -> io::Error {
    let message = if diagnostic.is_empty() {
        default_exec_control_status_message(status).to_owned()
    } else {
        diagnostic.to_owned()
    };
    io::Error::new(exec_control_status_error_kind(status), message)
}

fn exec_control_status_error_kind(status: ProcessControlStatus) -> io::ErrorKind {
    match status {
        ProcessControlStatus::Delivered => io::ErrorKind::Other,
        ProcessControlStatus::Inactive => io::ErrorKind::NotFound,
        ProcessControlStatus::NonceMismatch => io::ErrorKind::PermissionDenied,
        ProcessControlStatus::Unsupported => io::ErrorKind::Unsupported,
        ProcessControlStatus::Rejected => io::ErrorKind::PermissionDenied,
        ProcessControlStatus::SinkUnavailable => io::ErrorKind::NotConnected,
        ProcessControlStatus::SinkTimeout => io::ErrorKind::TimedOut,
        ProcessControlStatus::QueueFull => io::ErrorKind::WouldBlock,
        ProcessControlStatus::SinkError => io::ErrorKind::BrokenPipe,
    }
}

fn default_exec_control_status_message(status: ProcessControlStatus) -> &'static str {
    match status {
        ProcessControlStatus::Delivered => "exec control request delivered",
        ProcessControlStatus::Inactive => "exec operation is not active",
        ProcessControlStatus::NonceMismatch => "exec operation nonce mismatch",
        ProcessControlStatus::Unsupported => "exec control is not supported by this operation",
        ProcessControlStatus::Rejected => "exec control request rejected",
        ProcessControlStatus::SinkUnavailable => "exec control sink is not connected",
        ProcessControlStatus::SinkTimeout => "exec control sink timed out",
        ProcessControlStatus::QueueFull => "exec control queue is full",
        ProcessControlStatus::SinkError => "exec control sink error",
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

fn exec_termination_is_notable(termination: ExecTermination, expected_exit_codes: &[i32]) -> bool {
    !matches!(
        termination,
        ExecTermination::Exited { exit_code }
            if exit_code == 0 || expected_exit_codes.contains(&exit_code)
    )
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

fn exec_result_has_truncation(result: &vsock_proto::DecodedExecResult<'_>) -> bool {
    exec_operation_captured_output_truncated(result.stdout)
        || exec_operation_captured_output_truncated(result.stderr)
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

pub(crate) fn dispatch_output(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
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

pub(crate) fn dispatch_started(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
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
            ConnectionState::Closed { .. } => None,
        }
    };

    if let Some((start_tx, pid)) = start {
        let _ = start_tx.send(Ok(pid));
    }

    Ok(())
}

pub(crate) fn dispatch_result(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let Some((diagnostic, result_tx, start_tx, stream_overflowed, decoded)) = ({
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
                Some((diagnostic, result_tx, start_tx, stream_overflowed, decoded))
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed { .. } => None,
        }
    }) else {
        return Ok(());
    };

    diagnostic.log_terminal(&decoded, stream_overflowed);
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

pub(crate) fn dispatch_control_result(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let Some(pending) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                operations.take_pending_control(msg.seq)
            }
            ConnectionState::Closed { .. } => None,
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
        ProcessControlStatus::Delivered => ExecControlOutcome::Delivered(ExecControlAck {
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

pub(crate) fn dispatch_error(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<bool> {
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
            ConnectionState::Connected { .. } | ConnectionState::Closed { .. } => None,
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
            ConnectionState::Closed { .. } => None,
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
        ConnectionState::Closed { .. } => Err(io::Error::new(
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
                    ProcessControlStatus::Inactive,
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
        ConnectionState::Closed { .. } => Err(io::Error::new(
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
    control_nonce: ProcessControlNonce,
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
            ConnectionState::Closed { .. } => {
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
            "exec operation requires a positive timeout; use spawn_process for unbounded commands",
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
    let diagnostic = ExecOperationDiagnostic::new(seq, request.label, request.expected_exit_codes);
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
        pending_controls: HashMap::new(),
    };

    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
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
    let diagnostic = ExecOperationDiagnostic::new(seq, request.label, request.expected_exit_codes);
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
        pending_controls: HashMap::new(),
    };

    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed { .. } => {
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
            "exec requires a positive timeout; use spawn_process for unbounded commands",
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

    fn exec_operation_for_snapshot(seq: u32, label: &str) -> ExecOperation {
        let (result_tx, _result_rx) = oneshot::channel();
        let normal_operations = crate::operation_tracker::NormalOperationTracker::new();
        ExecOperation {
            normal_operation: Some(ExecOperationNormalTracking::Owned(
                normal_operations.reserve().unwrap(),
            )),
            lifecycle: ExecOperationLifecycle::OneShot,
            diagnostic: ExecOperationDiagnostic::new(seq, label, &[]),
            result_tx,
            stream_tx: None,
            stdout_capture: ExecCaptureState::Discard,
            stderr_capture: ExecCaptureState::Discard,
            stdout_stream: None,
            stderr_stream: None,
            expected_output_seq: 0,
            stream_overflowed: false,
            pending_controls: HashMap::new(),
        }
    }

    #[test]
    fn exec_termination_notable_tracks_nonzero_exit() {
        assert!(!exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 0 },
            &[]
        ));
        assert!(exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 1 },
            &[]
        ));
        assert!(!exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 66 },
            &[66]
        ));
        assert!(exec_termination_is_notable(
            ExecTermination::TimedOut,
            &[124]
        ));
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
        let mut diagnostic = ExecOperationDiagnostic::new(7, &label, &[]);
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
            expected_exit_codes: Vec::new(),
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
