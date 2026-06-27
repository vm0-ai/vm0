use std::io;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecControlStatus, ExecTermination, MSG_ERROR, MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT,
};

use super::super::super::support::{
    normal_operation_readiness, operation_count, read_guest_message, send_exec_control_result,
    send_exec_result,
};
use super::support::{
    StartedControlSupervisedExec, StartedSupervisedExec, assert_no_guest_frame,
    finish_supervised_exec_success, send_guest_error, start_control_supervised_exec_fixture,
    start_supervised_exec_fixture, supervised_request,
};
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn supervised_exec_control_uses_exec_control_messages() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("message-1", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let decoded_control = vsock_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start_seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "message-1");
    assert_eq!(decoded_control.payload, b"payload");

    send_exec_control_result(
        &mut guest,
        control.seq,
        decoded_control.target_seq,
        decoded_control.control_nonce,
        decoded_control.message_id,
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    let ack = control_task.await.unwrap().unwrap();
    assert_eq!(ack.target_seq, start_seq);
    assert_eq!(ack.message_id, "message-1");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_rejects_empty_message_id_without_frame() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        ..
    } = start_control_supervised_exec_fixture("control-empty-message-id").await;
    let start_seq = start.seq();

    let err = handle
        .control("", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string().contains("exec_control message_id empty"),
        "unexpected error: {err}",
    );
    assert_no_guest_frame(&mut guest, "invalid control request must not send a frame");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_sub_millisecond_timeout_rounds_up_to_one_ms() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-sub-ms-timeout").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("sub-ms-timeout", b"payload", Duration::from_nanos(1))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = vsock_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start_seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "sub-ms-timeout");
    assert_eq!(decoded_control.request_timeout_ms, 1);
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_large_timeout_saturates_request_timeout_ms() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-large-timeout").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control(
                    "large-timeout",
                    b"payload",
                    Duration::from_millis(u64::from(u32::MAX) + 1),
                )
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = vsock_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start_seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "large-timeout");
    assert_eq!(decoded_control.request_timeout_ms, u32::MAX);

    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "large-timeout",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    let ack = control_task.await.unwrap().unwrap();
    assert_eq!(ack.target_seq, start_seq);
    assert_eq!(ack.message_id, "large-timeout");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_disabled_returns_unsupported_without_frame() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        ..
    } = start_supervised_exec_fixture(supervised_request("control-disabled")).await;
    let start_seq = start.seq();
    assert!(handle.control_handle().is_none());

    let err = handle
        .control("disabled", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Unsupported);
    assert_no_guest_frame(&mut guest, "disabled control must not send a frame");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_reports_guest_status_and_error() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-status").await;
    let start_seq = start.seq();

    let status_task = tokio::spawn({
        let control_handle = control_handle.clone();
        async move {
            control_handle
                .control("status", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let status_control = read_guest_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        status_control.seq,
        start_seq,
        control_nonce,
        "status",
        ExecControlStatus::QueueFull,
        "queue full",
    )
    .await;
    let err = status_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::WouldBlock);
    assert_eq!(err.to_string(), "queue full");

    let error_task = tokio::spawn({
        let control_handle = control_handle.clone();
        async move {
            control_handle
                .control("error", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let error_control = read_guest_message(&mut guest).await;
    send_guest_error(&mut guest, error_control.seq, "guest rejected control").await;
    let err = error_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected control");

    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_guest_error_uses_control_error_fallback() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-error-fallback").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("guest-error", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    send_guest_error(&mut guest, control.seq, "guest rejected control").await;

    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected control");

    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_timeout_ignores_late_result() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-timeout").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("timeout", b"payload", Duration::ZERO)
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = vsock_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.request_timeout_ms, 0);
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "timeout",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_malformed_result_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-malformed-result").await;

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("malformed-result", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let frame = vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, control.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_malformed_error_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-malformed-error").await;

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("malformed-error", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let frame = vsock_proto::encode(MSG_ERROR, control.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_nonce_mismatch_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-mismatch").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("nonce-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let mut control_nonce = control_nonce;
    control_nonce[0] ^= 1;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "nonce-mismatch",
        ExecControlStatus::Delivered,
        "",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_control_target_seq_mismatch_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-target-mismatch").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("target-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq + 1,
        control_nonce,
        "target-mismatch",
        ExecControlStatus::Delivered,
        "",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_control_message_id_mismatch_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-message-mismatch").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("message-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "different-message-id",
        ExecControlStatus::Delivered,
        "",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_control_inactive_target_returns_not_found_without_frame() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-inactive").await;
    let start_seq = start.seq();
    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();

    let err = control_handle
        .control("after-exit", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
    assert_no_guest_frame(&mut guest, "inactive control must not send a frame");
}
