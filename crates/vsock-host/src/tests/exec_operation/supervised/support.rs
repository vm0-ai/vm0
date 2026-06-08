use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecTermination, ExecTimeoutPolicy, MSG_ERROR,
};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    setup_host_and_guest,
};
use crate::operation_tracker::NormalOperationReadiness;
use crate::{SupervisedExecControl, SupervisedExecRequest};

pub(super) fn supervised_request(command: &str) -> SupervisedExecRequest<'_> {
    SupervisedExecRequest {
        timeout: ExecTimeoutPolicy::None,
        command,
        env: &[],
        sudo: false,
        label: "supervised-test",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: &[],
        control: SupervisedExecControl::Disabled,
        stdin_bytes: None,
        stream_queue_capacity: None,
        start_timeout: Duration::from_secs(5),
    }
}

pub(super) fn supervised_stream_request(command: &str) -> SupervisedExecRequest<'_> {
    SupervisedExecRequest {
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 16,
        },
        stderr: ExecOutputPolicy::Discard,
        stdin_bytes: None,
        stream_queue_capacity: Some(1),
        ..supervised_request(command)
    }
}

pub(super) async fn assert_supervised_start_rejected_without_frame(
    request: SupervisedExecRequest<'_>,
    expected_message: &str,
) {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host.start_supervised_exec(request).await {
        Ok(_) => panic!("invalid supervised exec request should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string().contains(expected_message),
        "unexpected error: {err}",
    );
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

pub(super) async fn send_start_failed(
    guest: &mut tokio::net::UnixStream,
    seq: u32,
    diagnostic: &str,
) {
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::StartFailed,
        7,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        diagnostic,
    )
    .unwrap();
    let frame = vsock_proto::encode(vsock_proto::MSG_EXEC_RESULT, seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();
}

pub(super) async fn send_guest_error(stream: &mut tokio::net::UnixStream, seq: u32, message: &str) {
    let payload = vsock_proto::encode_error(message);
    let frame = vsock_proto::encode(MSG_ERROR, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}
