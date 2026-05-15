use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{ExecTermination, MSG_ERROR, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START};

use super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    read_guest_message, send_exec_result, setup_host_and_guest, wait_for_operation_count,
};
use super::start_capture_operation;
use crate::{ExecOwnedCapturedOutput, operation_tracker::NormalOperationReadiness};

#[tokio::test]
async fn malformed_exec_error_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "bad-error").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);

    let frame = vsock_proto::encode(MSG_ERROR, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn malformed_exec_output_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "bad-output").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let frame = vsock_proto::encode(MSG_EXEC_OUTPUT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn malformed_exec_result_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "bad-result").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let frame = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn malformed_exec_output_after_result_is_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
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

    let frame = vsock_proto::encode(MSG_EXEC_OUTPUT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    assert_connection_accepts_exec_operation(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn malformed_exec_frames_after_handle_drop_are_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "abandoned").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(operation_count(&host), 1);

    drop(handle);
    wait_for_operation_count(&host, 0).await;

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let err = host.exec("after-drop", 5000, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn malformed_duplicate_exec_result_after_completion_is_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "malformed-duplicate-result").await;
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

    let frame = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    assert_connection_accepts_exec_operation(&host, &mut guest, &mut decoder).await;
}
