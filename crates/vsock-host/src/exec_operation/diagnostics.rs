use std::io;

use tokio::time::Instant;
use vsock_proto::{ExecCapturedOutput, ExecTermination};

use super::state::ExecOperationLifecycle;
use super::{EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES, EXEC_OPERATION_STAGE_SLOW_THRESHOLD};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecTerminalLogLifecycle {
    OneShot,
    Supervised,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecTerminalLogSeverity {
    Info,
    Warn,
}

#[derive(Clone, Copy)]
pub(in crate::exec_operation) struct ExecTerminalLogContext {
    pub(in crate::exec_operation) lifecycle: ExecTerminalLogLifecycle,
    pub(in crate::exec_operation) slow: bool,
    pub(in crate::exec_operation) termination: ExecTermination,
    pub(in crate::exec_operation) stdout_truncated: bool,
    pub(in crate::exec_operation) stderr_truncated: bool,
    pub(in crate::exec_operation) stream_overflowed: bool,
    pub(in crate::exec_operation) diagnostic_present: bool,
    pub(in crate::exec_operation) host_cancel_requested: bool,
}

#[derive(Clone)]
pub(in crate::exec_operation) struct ExecOperationDiagnostic {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) label_log: String,
    pub(in crate::exec_operation) registered_at: Instant,
    pub(in crate::exec_operation) first_output_at: Option<Instant>,
}

pub(in crate::exec_operation) struct ExecOperationSnapshot {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) label_log: String,
    pub(in crate::exec_operation) elapsed_ms: u128,
}

pub(crate) struct ExecOperationCloseSnapshot {
    pub(in crate::exec_operation) active_count: usize,
    pub(in crate::exec_operation) operations: Vec<ExecOperationSnapshot>,
}

pub(in crate::exec_operation) struct ExecOperationFrameDiagnostic {
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) label_log: String,
    pub(in crate::exec_operation) frame: &'static str,
}

impl ExecOperationDiagnostic {
    pub(in crate::exec_operation) fn new(seq: u32, label: &str) -> Self {
        Self {
            seq,
            label_log: exec_operation_label_log(label),
            registered_at: Instant::now(),
            first_output_at: None,
        }
    }

    pub(in crate::exec_operation) fn frame(
        &self,
        frame: &'static str,
    ) -> ExecOperationFrameDiagnostic {
        ExecOperationFrameDiagnostic {
            seq: self.seq,
            label_log: self.label_log.clone(),
            frame,
        }
    }

    pub(in crate::exec_operation) fn elapsed_ms(&self) -> u128 {
        self.registered_at.elapsed().as_millis()
    }

    pub(in crate::exec_operation) fn snapshot(&self) -> ExecOperationSnapshot {
        ExecOperationSnapshot {
            seq: self.seq,
            label_log: self.label_log.clone(),
            elapsed_ms: self.elapsed_ms(),
        }
    }

    pub(in crate::exec_operation) fn mark_first_output(&mut self) -> Option<ExecOperationSnapshot> {
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

    pub(in crate::exec_operation) fn log_terminal(
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

    pub(in crate::exec_operation) fn log_error_response(&self, error: &io::Error) {
        tracing::warn!(
            seq = self.seq,
            label = %self.label_log,
            elapsed_ms = self.elapsed_ms(),
            error = %error,
            "exec operation error response"
        );
    }
}

pub(in crate::exec_operation) fn exec_termination_requires_low_level_warning(
    termination: ExecTermination,
) -> bool {
    match termination {
        ExecTermination::Exited { .. } => false,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => true,
    }
}

pub(in crate::exec_operation) fn exec_terminal_cancel_is_expected(
    context: ExecTerminalLogContext,
) -> bool {
    matches!(context.termination, ExecTermination::Cancelled)
        && context.host_cancel_requested
        && !context.stdout_truncated
        && !context.stderr_truncated
        && !context.stream_overflowed
        && !context.diagnostic_present
}

pub(in crate::exec_operation) fn exec_terminal_log_lifecycle(
    lifecycle: &ExecOperationLifecycle,
) -> ExecTerminalLogLifecycle {
    match lifecycle {
        ExecOperationLifecycle::OneShot => ExecTerminalLogLifecycle::OneShot,
        ExecOperationLifecycle::SupervisedAwaitingStart { .. }
        | ExecOperationLifecycle::SupervisedStarted { .. } => ExecTerminalLogLifecycle::Supervised,
    }
}

pub(in crate::exec_operation) fn exec_terminal_log_severity(
    context: ExecTerminalLogContext,
) -> Option<ExecTerminalLogSeverity> {
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

pub(in crate::exec_operation) fn exec_operation_label_log(label: &str) -> String {
    if label.len() <= EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES {
        return label.to_string();
    }

    let mut end = EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES;
    while !label.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &label[..end])
}

pub(in crate::exec_operation) fn exec_operation_captured_output_truncated(
    output: ExecCapturedOutput<'_>,
) -> bool {
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
