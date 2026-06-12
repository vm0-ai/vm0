use std::io;
use std::sync::Arc;

use tokio::sync::mpsc;
use vsock_proto::{
    BorrowedRawMessage, ExecCapturedOutput, ExecControlStatus, ExecOutputStream, MSG_ERROR,
    MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_STARTED,
};

use crate::{ConnectionState, Shared, normal_operation_transition_error};

use super::diagnostics::exec_terminal_log_lifecycle;
use super::exec_operation_protocol_error;
use super::state::{ExecCaptureState, ExecOperation, ExecOperationLifecycle};
use super::types::{
    ExecControlAck, ExecControlGuestStatus, ExecControlOutcome, ExecOperationResult,
    ExecOutputEvent, ExecOwnedCapturedOutput,
};

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
pub(crate) fn dispatch_incoming_frame(
    shared: &Arc<Shared>,
    msg: BorrowedRawMessage<'_>,
) -> io::Result<bool> {
    match msg.msg_type {
        MSG_ERROR => dispatch_error(shared, msg),
        MSG_EXEC_OUTPUT => dispatch_output(shared, msg).map(|_| true),
        MSG_EXEC_STARTED => dispatch_started(shared, msg).map(|_| true),
        MSG_EXEC_RESULT => dispatch_result(shared, msg).map(|_| true),
        MSG_EXEC_CONTROL_RESULT => dispatch_control_result(shared, msg).map(|_| true),
        _ => Ok(false),
    }
}

fn dispatch_output(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    let mut first_output_slow = None;
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let ConnectionState::Connected { operations, .. } = &mut *guard
            && let Some(operation) = operations.get_mut(msg.seq)
        {
            let decoded = vsock_proto::decode_exec_output(msg.payload)
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

fn dispatch_started(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
    let start = {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } => {
                let Some(operation) = operations.get_mut(msg.seq) else {
                    return Ok(());
                };
                let decoded = vsock_proto::decode_exec_started(msg.payload)
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

pub(in crate::exec_operation) fn dispatch_result(
    shared: &Arc<Shared>,
    msg: BorrowedRawMessage<'_>,
) -> io::Result<()> {
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
                let decoded = vsock_proto::decode_exec_result(msg.payload)
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

fn dispatch_control_result(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
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
    let decoded = vsock_proto::decode_exec_control_result(msg.payload)
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

fn dispatch_error(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<bool> {
    let Some((diagnostic, result_tx, start_tx, err)) = ({
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Connected { operations, .. } if operations.contains(msg.seq) => {
                let err = vsock_proto::decode_error(msg.payload)
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

fn dispatch_control_error(shared: &Arc<Shared>, msg: BorrowedRawMessage<'_>) -> io::Result<bool> {
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
    let message = vsock_proto::decode_error(msg.payload)
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
