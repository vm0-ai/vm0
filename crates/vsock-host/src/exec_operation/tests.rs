use std::collections::HashMap;
use std::io;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;
use tokio::time::Instant;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};
use vsock_proto::{
    ExecCapturedOutput, ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_RESULT, RawMessage,
};

use crate::{ConnectionState, Shared};

use super::diagnostics::*;
use super::dispatch::dispatch_result;
use super::frame::send_supervised_exec_cancel_frame;
use super::handle::{ExecOperationHandle, ExecWaitCore};
use super::state::*;
use super::types::ExecOperationResult;
use super::{
    EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT, EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES,
    EXEC_OPERATION_STAGE_SLOW_THRESHOLD,
};

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
    captured.entries()
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
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, false, &clean).is_empty()
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
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &captured_output),
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
        dispatch_result(&shared, msg.as_borrowed()).unwrap();
    });

    let events = captured.entries();
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

    let (one_shot_events, one_shot_result) = capture_dispatch_terminal_log_events_with_lifecycle(
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
        dispatch_result(&shared, msg.as_borrowed()).unwrap();
    });

    let events = captured.entries();
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
        wait_core: ExecWaitCore::new(Arc::clone(&shared), 7, diagnostic, result_rx),
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
        dispatch_result(&shared, msg.as_borrowed()).unwrap();
    });

    let events = captured.entries();
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
        let context =
            clean_terminal_log_context(lifecycle, false, ExecTermination::Exited { exit_code: 0 });

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
        let context =
            clean_terminal_log_context(lifecycle, false, ExecTermination::Exited { exit_code: 1 });

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
        let clean =
            clean_terminal_log_context(lifecycle, false, ExecTermination::Exited { exit_code: 0 });
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
            ..clean_terminal_log_context(ExecTerminalLogLifecycle::Supervised, false, termination)
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
