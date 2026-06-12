use std::collections::HashMap;
use std::io;
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};
use vsock_proto::{ExecControlNonce, ExecControlStatus, ExecOutputPolicy, ExecTermination};

use crate::{
    CompositeNormalOperation, ConnectionState, Shared, normal_operation_transition_error,
    operation_tracker::{NormalOperationToken, NormalOperationTransitionHandle},
};

use super::diagnostics::{ExecOperationCloseSnapshot, ExecOperationDiagnostic};
use super::frame::remove_pending_exec_control;
use super::types::{
    ExecControlOutcome, ExecOperationResult, ExecOutputEvent, exec_control_status_error,
};
use super::{
    DEFAULT_EXEC_STREAM_CAPACITY, EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT, MAX_EXEC_STREAM_CAPACITY,
    exec_operation_protocol_error,
};

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

    pub(in crate::exec_operation) fn insert(&mut self, seq: u32, operation: ExecOperation) {
        self.operations.insert(seq, operation);
    }

    pub(crate) fn remove(&mut self, seq: u32) {
        if let Some(operation) = self.operations.remove(&seq) {
            for request_seq in operation.pending_controls.keys() {
                self.control_targets.remove(request_seq);
            }
        }
    }

    pub(in crate::exec_operation) fn take(&mut self, seq: u32) -> Option<ExecOperation> {
        let operation = self.operations.remove(&seq)?;
        for request_seq in operation.pending_controls.keys() {
            self.control_targets.remove(request_seq);
        }
        Some(operation)
    }

    pub(in crate::exec_operation) fn contains(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq)
    }

    pub(in crate::exec_operation) fn get_mut(&mut self, seq: u32) -> Option<&mut ExecOperation> {
        self.operations.get_mut(&seq)
    }

    pub(in crate::exec_operation) fn mark_host_cancel_requested(&mut self, seq: u32) {
        if let Some(operation) = self.operations.get_mut(&seq) {
            operation.host_cancel_requested = true;
        }
    }

    pub(in crate::exec_operation) fn insert_pending_control(
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

    pub(in crate::exec_operation) fn remove_pending_control(&mut self, request_seq: u32) {
        let Some(target_seq) = self.control_targets.remove(&request_seq) else {
            return;
        };
        if let Some(operation) = self.operations.get_mut(&target_seq) {
            operation.pending_controls.remove(&request_seq);
        }
    }

    pub(in crate::exec_operation) fn take_pending_control(
        &mut self,
        request_seq: u32,
    ) -> Option<PendingExecControl> {
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

pub(in crate::exec_operation) struct ExecOperation {
    pub(in crate::exec_operation) normal_operation: Option<ExecOperationNormalTracking>,
    pub(in crate::exec_operation) lifecycle: ExecOperationLifecycle,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
    pub(in crate::exec_operation) stream_tx: Option<mpsc::Sender<ExecOutputEvent>>,
    pub(in crate::exec_operation) stdout_capture: ExecCaptureState,
    pub(in crate::exec_operation) stderr_capture: ExecCaptureState,
    pub(in crate::exec_operation) stdout_stream: Option<ExecStreamState>,
    pub(in crate::exec_operation) stderr_stream: Option<ExecStreamState>,
    pub(in crate::exec_operation) expected_output_seq: u32,
    pub(in crate::exec_operation) stream_overflowed: bool,
    pub(in crate::exec_operation) host_cancel_requested: bool,
    pub(in crate::exec_operation) pending_controls: HashMap<u32, PendingExecControl>,
}

pub(in crate::exec_operation) enum ExecOperationLifecycle {
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

pub(in crate::exec_operation) struct PendingExecControl {
    pub(in crate::exec_operation) target_seq: u32,
    pub(in crate::exec_operation) message_id: String,
    pub(in crate::exec_operation) control_nonce: ExecControlNonce,
    pub(in crate::exec_operation) response_tx: oneshot::Sender<io::Result<ExecControlOutcome>>,
    pub(in crate::exec_operation) normal_operation: NormalOperationToken,
}

pub(in crate::exec_operation) enum ExecOperationNormalTracking {
    Owned(NormalOperationToken),
    Composite(NormalOperationTransitionHandle),
}

impl ExecOperation {
    pub(in crate::exec_operation) fn allows_output(&self) -> bool {
        matches!(
            self.lifecycle,
            ExecOperationLifecycle::OneShot | ExecOperationLifecycle::SupervisedStarted { .. }
        )
    }

    pub(in crate::exec_operation) fn validates_result_before_start(
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

    pub(in crate::exec_operation) fn validate_control_nonce(
        &self,
        control_nonce: ExecControlNonce,
    ) -> io::Result<()> {
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
    pub(in crate::exec_operation) fn mark_possible_guest_write_started(
        &mut self,
    ) -> io::Result<()> {
        match self {
            ExecOperationNormalTracking::Owned(normal_operation) => normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error),
            ExecOperationNormalTracking::Composite(normal_operation) => normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error),
        }
    }

    pub(in crate::exec_operation) fn complete(self) -> io::Result<()> {
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

pub(in crate::exec_operation) enum ExecOperationTracking<'a> {
    Tracked,
    Composite(&'a CompositeNormalOperation),
    Untracked,
}

pub(in crate::exec_operation) struct ExecOperationRegistrationInput<'a> {
    pub(in crate::exec_operation) label: &'a str,
    pub(in crate::exec_operation) stdout: ExecOutputPolicy,
    pub(in crate::exec_operation) stderr: ExecOutputPolicy,
    pub(in crate::exec_operation) stream_queue_capacity: Option<usize>,
    pub(in crate::exec_operation) lifecycle: ExecOperationLifecycle,
    pub(in crate::exec_operation) tracking: ExecOperationTracking<'a>,
}

pub(in crate::exec_operation) struct ExecOperationRegistration {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_rx: oneshot::Receiver<io::Result<ExecOperationResult>>,
    pub(in crate::exec_operation) stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
    pub(in crate::exec_operation) registration_guard: ExecOperationRegistrationGuard,
    pub(in crate::exec_operation) tracks_normal_operation: bool,
}

pub(in crate::exec_operation) enum ExecCaptureState {
    Discard,
    Capture { limit_bytes: usize },
}

pub(in crate::exec_operation) struct ExecStreamState {
    pub(in crate::exec_operation) limit_bytes: usize,
    pub(in crate::exec_operation) chunk_limit_bytes: usize,
    pub(in crate::exec_operation) emitted_bytes: usize,
    pub(in crate::exec_operation) truncated: bool,
}

pub(in crate::exec_operation) struct ExecOperationRegistrationGuard {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) disarmed: bool,
}

pub(in crate::exec_operation) struct PendingExecControlGuard {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) request_seq: u32,
}

impl ExecOperationRegistrationGuard {
    pub(in crate::exec_operation) fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self {
            shared,
            seq,
            disarmed: false,
        }
    }

    pub(in crate::exec_operation) fn disarm(&mut self) {
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
    pub(in crate::exec_operation) fn new(shared: Arc<Shared>, request_seq: u32) -> Self {
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

pub(in crate::exec_operation) fn output_policy_streams(policy: ExecOutputPolicy) -> bool {
    matches!(
        policy,
        ExecOutputPolicy::Stream { .. } | ExecOutputPolicy::CaptureAndStream { .. }
    )
}

pub(in crate::exec_operation) fn stream_queue_capacity_for(
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

pub(in crate::exec_operation) fn capture_state(policy: ExecOutputPolicy) -> ExecCaptureState {
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

pub(in crate::exec_operation) fn stream_state(policy: ExecOutputPolicy) -> Option<ExecStreamState> {
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

pub(in crate::exec_operation) fn register_exec_operation_start(
    shared: &Arc<Shared>,
    input: ExecOperationRegistrationInput<'_>,
) -> io::Result<ExecOperationRegistration> {
    let ExecOperationRegistrationInput {
        label,
        stdout,
        stderr,
        stream_queue_capacity,
        lifecycle,
        tracking,
    } = input;
    let (stream_tx, stream_rx) = match stream_queue_capacity {
        Some(capacity) => {
            let (tx, rx) = mpsc::channel(capacity);
            (Some(tx), Some(rx))
        }
        None => (None, None),
    };
    let (result_tx, result_rx) = oneshot::channel();
    let seq = shared.next_seq();
    let diagnostic = ExecOperationDiagnostic::new(seq, label);
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
        lifecycle,
        diagnostic: diagnostic.clone(),
        result_tx,
        stream_tx,
        stdout_capture: capture_state(stdout),
        stderr_capture: capture_state(stderr),
        stdout_stream: stream_state(stdout),
        stderr_stream: stream_state(stderr),
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

    Ok(ExecOperationRegistration {
        seq,
        diagnostic,
        result_rx,
        stream_rx,
        registration_guard: ExecOperationRegistrationGuard::new(Arc::clone(shared), seq),
        tracks_normal_operation,
    })
}
