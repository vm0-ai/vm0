use std::future::{Future, ready};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use vsock_proto::{
    ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecTermination, ExecTimeoutPolicy,
    MSG_EXEC_CANCEL,
};

use crate::{CompositeNormalOperation, ExecResult, FrameWriteObserver, Shared};

use super::frame::{write_exec_start_frame, write_frame};
use super::handle::{
    ExecControlHandle, ExecOperationCancelOnDropGuard, ExecOperationHandle, ExecWaitCore,
    SupervisedExecHandle,
};
use super::state::{
    ExecOperationLifecycle, ExecOperationRegistration, ExecOperationRegistrationInput,
    ExecOperationTracking, output_policy_streams, register_exec_operation_start,
    stream_queue_capacity_for,
};
use super::types::{
    ExecCaptureRequest, ExecOperationRequest, ExecOperationResult, ExecOwnedCapturedOutput,
    ExecStreamRequest, SupervisedExecControl, SupervisedExecRequest,
};
use super::{
    DEFAULT_EXEC_CAPTURE_LIMIT_BYTES, EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT,
    EXEC_TIMEOUT_EXIT_CODE, SMALL_EXEC_CAPTURE_LIMIT_BYTES,
};

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

    let ExecOperationRegistration {
        seq,
        diagnostic,
        result_rx,
        stream_rx,
        mut registration_guard,
        tracks_normal_operation,
    } = register_exec_operation_start(
        shared,
        ExecOperationRegistrationInput {
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            stream_queue_capacity,
            lifecycle: ExecOperationLifecycle::OneShot,
            tracking,
        },
    )?;
    write_exec_start_frame(
        shared,
        seq,
        &payload,
        &diagnostic,
        tracks_normal_operation,
        write_observer,
    )
    .await?;
    registration_guard.disarm();

    Ok(ExecOperationHandle {
        wait_core: ExecWaitCore::new(Arc::clone(shared), seq, diagnostic, result_rx),
        stream_rx,
    })
}

pub(crate) async fn start_supervised_exec_on_shared(
    shared: &Arc<Shared>,
    request: SupervisedExecRequest<'_>,
) -> io::Result<SupervisedExecHandle> {
    start_supervised_exec_on_shared_with_after_start_write(shared, request, ready(())).await
}

pub(in crate::exec_operation) async fn start_supervised_exec_on_shared_with_after_start_write<F>(
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

pub(in crate::exec_operation) async fn start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout<
    F,
>(
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

    let (start_tx, start_rx) = oneshot::channel();
    let ExecOperationRegistration {
        seq,
        diagnostic,
        result_rx,
        stream_rx,
        mut registration_guard,
        tracks_normal_operation,
    } = register_exec_operation_start(
        shared,
        ExecOperationRegistrationInput {
            label: request.label,
            stdout: request.stdout,
            stderr: request.stderr,
            stream_queue_capacity,
            lifecycle: ExecOperationLifecycle::SupervisedAwaitingStart {
                start_tx: Some(start_tx),
                control_nonce,
            },
            tracking: ExecOperationTracking::Tracked,
        },
    )?;
    let mut start_cancel_on_drop =
        ExecOperationCancelOnDropGuard::new_for_seq(Arc::clone(shared), seq, diagnostic.clone());
    let start_write_result = write_exec_start_frame(
        shared,
        seq,
        &payload,
        &diagnostic,
        tracks_normal_operation,
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
        wait_core: ExecWaitCore::new(Arc::clone(shared), seq, diagnostic, result_rx),
        pid,
        cancel_handle_taken: false,
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
