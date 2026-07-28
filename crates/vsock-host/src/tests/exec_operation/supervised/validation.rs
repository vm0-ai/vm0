use std::io;
use std::time::Duration;

use vsock_proto::{ExecOutputPolicy, ExecTimeoutPolicy};

use super::support::{
    assert_supervised_start_fails_without_frame, supervised_request, supervised_stream_request,
};
use crate::SupervisedExecRequest;

#[tokio::test]
async fn supervised_exec_rejects_zero_stream_capacity_without_sending_frame() {
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            stdin_bytes: None,
            stream_queue_capacity: Some(0),
            ..supervised_stream_request("zero-stream-capacity")
        },
        io::ErrorKind::InvalidInput,
        "exec stream queue capacity must be positive",
    )
    .await;
}

#[tokio::test]
async fn supervised_exec_rejects_oversized_stdin_without_sending_frame() {
    let stdin_bytes = vec![0; vsock_proto::MAX_EXEC_STDIN_BYTES + 1];
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            stdin_bytes: Some(&stdin_bytes),
            ..supervised_request("oversized-stdin")
        },
        io::ErrorKind::InvalidInput,
        "stdin_bytes",
    )
    .await;
}

#[tokio::test]
async fn supervised_exec_rejects_receiver_without_stream_policy() {
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            stdin_bytes: None,
            stream_queue_capacity: Some(1),
            ..supervised_request("receiver-without-stream")
        },
        io::ErrorKind::InvalidInput,
        "exec stream queue capacity requires a streaming output policy",
    )
    .await;
}

#[tokio::test]
async fn supervised_exec_rejects_invalid_output_policy_without_sending_frame() {
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 0,
            },
            stdin_bytes: None,
            stream_queue_capacity: Some(1),
            ..supervised_request("invalid-output-policy")
        },
        io::ErrorKind::InvalidInput,
        "exec output chunk limit must be non-zero",
    )
    .await;
}

#[tokio::test]
async fn supervised_exec_rejects_zero_duration_timeout_without_sending_frame() {
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 0 },
            ..supervised_request("zero-duration-timeout")
        },
        io::ErrorKind::InvalidInput,
        "exec start timeout duration must be positive",
    )
    .await;
}

#[tokio::test]
async fn supervised_exec_zero_start_timeout_does_not_send_frame() {
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            start_timeout: Duration::ZERO,
            ..supervised_request("zero-start-timeout")
        },
        io::ErrorKind::TimedOut,
        "exec start timeout",
    )
    .await;
}

#[tokio::test]
async fn supervised_exec_oversized_start_timeout_does_not_send_frame() {
    assert_supervised_start_fails_without_frame(
        SupervisedExecRequest {
            start_timeout: Duration::MAX,
            ..supervised_request("oversized-start-timeout")
        },
        io::ErrorKind::InvalidInput,
        "exec start timeout is too large",
    )
    .await;
}
