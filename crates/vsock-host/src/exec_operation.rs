use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::{ConnectionState, ExecResult, Shared};
use vsock_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_EXEC_CANCEL,
    MSG_EXEC_START, RawMessage,
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

pub(crate) struct Operations {
    operations: HashMap<u32, ExecOperation>,
}

impl Operations {
    pub(crate) fn new() -> Self {
        Self {
            operations: HashMap::new(),
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
        self.operations.remove(&seq);
    }

    fn take(&mut self, seq: u32) -> Option<ExecOperation> {
        self.operations.remove(&seq)
    }

    fn contains(&self, seq: u32) -> bool {
        self.operations.contains_key(&seq)
    }

    fn get_mut(&mut self, seq: u32) -> Option<&mut ExecOperation> {
        self.operations.get_mut(&seq)
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
    diagnostic: ExecOperationDiagnostic,
    result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
    stream_tx: Option<mpsc::Sender<ExecOutputEvent>>,
    stdout_capture: ExecCaptureState,
    stderr_capture: ExecCaptureState,
    stdout_stream: Option<ExecStreamState>,
    stderr_stream: Option<ExecStreamState>,
    expected_output_seq: u32,
    stream_overflowed: bool,
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
    pub async fn cancel_and_wait(mut self, timeout: Duration) -> io::Result<ExecOperationResult> {
        if let Some(result) = self.try_take_ready_result()? {
            return Ok(result);
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
        )
        .await?;
        tracing::info!(
            seq = seq,
            label = %self.diagnostic.label_log,
            elapsed_ms = self.diagnostic.elapsed_ms(),
            "exec operation cancel sent"
        );

        let cancel_label_log = self.diagnostic.label_log.clone();
        let registered_at = self.diagnostic.registered_at;
        let result = self.wait_with_timeout(timeout, true).await?;
        if result.termination == ExecTermination::Cancelled {
            tracing::info!(
                seq = seq,
                label = %cancel_label_log,
                elapsed_ms = registered_at.elapsed().as_millis(),
                "exec operation cancel completed"
            );
            return Ok(result);
        }

        Err(io::Error::other(format!(
            "exec cancel returned terminal state: {:?}",
            result.termination
        )))
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

pub(crate) struct ExecOperationCancelOnDropGuard {
    shared: Option<Arc<Shared>>,
    seq: u32,
    diagnostic: ExecOperationDiagnostic,
}

impl ExecOperationCancelOnDropGuard {
    pub(crate) fn new(handle: &ExecOperationHandle) -> Option<Self> {
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

pub(crate) fn dispatch_result(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<()> {
    let (operation, decoded) = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains(msg.seq) => {
                let decoded = vsock_proto::decode_exec_result(&msg.payload)
                    .map_err(exec_operation_protocol_error)?;
                (operations.take(msg.seq), decoded)
            }
            ConnectionState::Connected { .. } | ConnectionState::Closed { .. } => {
                return Ok(());
            }
        }
    };

    if let Some(operation) = operation {
        validate_result(&operation, &decoded)?;
        operation
            .diagnostic
            .log_terminal(&decoded, operation.stream_overflowed);
        let ExecOperation {
            result_tx,
            stream_overflowed,
            ..
        } = operation;
        let result = owned_result(decoded, stream_overflowed);
        let _ = result_tx.send(Ok(result));
    }

    Ok(())
}

pub(crate) fn dispatch_error(shared: &Arc<Shared>, msg: &RawMessage) -> io::Result<bool> {
    let operation = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => operations.take(msg.seq),
            ConnectionState::Closed { .. } => None,
        }
    };

    if let Some(operation) = operation {
        let err = vsock_proto::decode_error(&msg.payload)
            .map(|message| io::Error::other(message.to_string()))
            .map_err(exec_operation_protocol_error)?;
        operation.diagnostic.log_error_response(&err);
        let _ = operation.result_tx.send(Err(err));
        return Ok(true);
    }

    Ok(false)
}

async fn write_frame(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
) -> io::Result<()> {
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let state = Arc::new(AtomicU8::new(EXEC_OPERATION_FRAME_WRITE_NOT_STARTED));
    let guard = ExecOperationFrameWriteGuard::new(Arc::clone(shared), Arc::clone(&state));

    let wait_started_at = Instant::now();
    let mut writer = shared.writer.lock().await;
    let wait_elapsed_ms = wait_started_at.elapsed().as_millis();
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
    if request.timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec operation requires a positive timeout; use spawn_process for unbounded commands",
        ));
    }
    if matches!(request.stream_queue_capacity, Some(0)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec stream queue capacity must be positive",
        ));
    }
    if let Some(capacity) = request.stream_queue_capacity
        && capacity > MAX_EXEC_STREAM_CAPACITY
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("exec stream queue capacity must be at most {MAX_EXEC_STREAM_CAPACITY}"),
        ));
    }
    let streams_output =
        output_policy_streams(request.stdout) || output_policy_streams(request.stderr);
    if !streams_output && request.stream_queue_capacity.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec stream queue capacity requires a streaming output policy",
        ));
    }
    let stream_queue_capacity = if streams_output {
        Some(
            request
                .stream_queue_capacity
                .unwrap_or(DEFAULT_EXEC_STREAM_CAPACITY),
        )
    } else {
        None
    };

    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(
        vsock_proto::ExecStartEncodeRequest {
            timeout_ms: request.timeout_ms,
            command: request.command,
            env: request.env,
            sudo: request.sudo,
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            expected_exit_codes: request.expected_exit_codes,
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
    let operation = ExecOperation {
        diagnostic: diagnostic.clone(),
        result_tx,
        stream_tx,
        stdout_capture: capture_state(request.stdout),
        stderr_capture: capture_state(request.stderr),
        stdout_stream: stream_state(request.stdout),
        stderr_stream: stream_state(request.stderr),
        expected_output_seq: 0,
        stream_overflowed: false,
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

pub(crate) async fn exec_operation_stream_on_shared(
    shared: &Arc<Shared>,
    request: ExecStreamRequest<'_>,
) -> io::Result<ExecOperationHandle> {
    if !output_policy_streams(request.stdout) && !output_policy_streams(request.stderr) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec_operation_stream requires a streaming output policy",
        ));
    }

    start_exec_operation_on_shared(
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

pub(crate) async fn exec_cleanup_on_shared(
    shared: &Arc<Shared>,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    sudo: bool,
) -> io::Result<ExecResult> {
    exec_capture_on_shared(
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
    )
    .await
}

pub(crate) async fn exec_capture_on_shared(
    shared: &Arc<Shared>,
    request: ExecCaptureRequest<'_>,
) -> io::Result<ExecResult> {
    if request.timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec requires a positive timeout; use spawn_process for unbounded commands",
        ));
    }
    let result = exec_operation_capture_on_shared(shared, request).await?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec_operation_for_snapshot(seq: u32, label: &str) -> ExecOperation {
        let (result_tx, _result_rx) = oneshot::channel();
        ExecOperation {
            diagnostic: ExecOperationDiagnostic::new(seq, label, &[]),
            result_tx,
            stream_tx: None,
            stdout_capture: ExecCaptureState::Discard,
            stderr_capture: ExecCaptureState::Discard,
            stdout_stream: None,
            stderr_stream: None,
            expected_output_seq: 0,
            stream_overflowed: false,
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
