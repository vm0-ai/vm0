use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR, MSG_EXEC_START};

use super::super::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    operation_count, read_guest_message, send_exec_output, send_exec_result, setup_host_and_guest,
};
use super::start_capture_operation;
use crate::{
    ExecOperationRequest, ExecOwnedCapturedOutput, ExecStreamRequest,
    operation_tracker::NormalOperationReadiness,
};

#[tokio::test]
async fn exec_operation_wait_timeout_cleans_operation_state() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "timeout").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(operation_count(&host), 1);

    let err = handle.wait(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_error_response_completes_operation_without_timeout() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "error-response").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);

    let payload = vsock_proto::encode_error("exec operation already active");
    let frame = vsock_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();

    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "exec operation already active");
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn exec_operation_connection_close_wakes_result_and_stream() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "close",
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);

    drop(guest);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert!(rx.recv().await.is_none());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn exec_start_after_connection_close_returns_connection_reset() {
    let (host, guest, _decoder) = setup_host_and_guest().await;
    drop(guest);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = match host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "echo ok",
            env: &[],
            sudo: false,
            label: "closed",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
    {
        Ok(_) => panic!("exec start after connection close should fail"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(operation_count(&host), 0);
}

#[tokio::test]
async fn host_drop_closes_active_exec_result_and_stream() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "host-drop",
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);

    drop(host);

    let err = tokio::time::timeout(Duration::from_secs(5), handle.wait(Duration::from_secs(60)))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn exec_output_after_result_does_not_poison_or_resurrect_state() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "done").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(operation_count(&host), 0);

    send_exec_output(
        &mut guest,
        msg.seq,
        1,
        ExecOutputStream::Stdout,
        b"late",
        false,
    )
    .await;

    let exec_task = tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await });
    let exec_msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(exec_msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&exec_msg.payload).unwrap();
    assert_eq!(decoded.command, "echo ok");
    send_exec_result(
        &mut guest,
        exec_msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
}

#[tokio::test]
async fn duplicate_exec_result_after_completion_is_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "duplicate-result").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);

    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"first",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"first".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);

    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 1 },
        b"duplicate",
        b"",
    )
    .await;

    assert_connection_accepts_exec_operation(&host, &mut guest, &mut decoder).await;
}
