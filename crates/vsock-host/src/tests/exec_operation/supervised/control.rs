use std::io;
use std::sync::Arc;
use std::time::Duration;

use vsock_proto::{ExecControlPolicy, ExecControlStatus, ExecTermination, MSG_EXEC_CONTROL};

use super::super::super::support::{
    normal_operation_readiness, operation_count, read_guest_message, send_exec_control_result,
    send_exec_result, send_exec_started, setup_host_and_guest,
};
use super::support::{send_guest_error, supervised_request};
use crate::operation_tracker::NormalOperationReadiness;
use crate::{SupervisedExecControl, SupervisedExecRequest};

#[tokio::test]
async fn supervised_exec_control_uses_exec_control_messages() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled {
        control_nonce,
        sink,
    } = decoded_start.control
    else {
        panic!("supervised exec should enable control");
    };
    assert!(sink);
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let handle = handle.control_handle().unwrap();
        async move {
            handle
                .control("message-1", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let decoded_control = vsock_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start.seq);
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
    assert_eq!(ack.target_seq, start.seq);
    assert_eq!(ack.message_id, "message-1");

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_rejects_empty_message_id_without_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-empty-message-id")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let err = handle
        .control("", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string().contains("exec_control message_id empty"),
        "unexpected error: {err}",
    );
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("invalid control request must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after invalid control request: {err}"),
    }

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_sub_millisecond_timeout_rounds_up_to_one_ms() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-sub-ms-timeout")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled { control_nonce, .. } = decoded_start.control else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let control_handle = handle.control_handle().unwrap();
        async move {
            control_handle
                .control("sub-ms-timeout", b"payload", Duration::from_nanos(1))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = vsock_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start.seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "sub-ms-timeout");
    assert_eq!(decoded_control.request_timeout_ms, 1);
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_large_timeout_saturates_request_timeout_ms() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-large-timeout")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled { control_nonce, .. } = decoded_start.control else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let control_handle = handle.control_handle().unwrap();
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
    assert_eq!(decoded_control.target_seq, start.seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "large-timeout");
    assert_eq!(decoded_control.request_timeout_ms, u32::MAX);

    send_exec_control_result(
        &mut guest,
        control.seq,
        start.seq,
        control_nonce,
        "large-timeout",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    let ack = control_task.await.unwrap().unwrap();
    assert_eq!(ack.target_seq, start.seq);
    assert_eq!(ack.message_id, "large-timeout");

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_disabled_returns_unsupported_without_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("control-disabled"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    assert!(handle.control_handle().is_none());

    let err = handle
        .control("disabled", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Unsupported);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("disabled control must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after disabled control: {err}"),
    }

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_reports_guest_status_and_error() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-status")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled { control_nonce, .. } = decoded_start.control else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    let control_handle = handle.control_handle().unwrap();

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
        start.seq,
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
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_timeout_ignores_late_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-timeout")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled { control_nonce, .. } = decoded_start.control else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let control_handle = handle.control_handle().unwrap();
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
        start.seq,
        control_nonce,
        "timeout",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    send_exec_result(
        &mut guest,
        start.seq,
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
async fn supervised_exec_control_nonce_mismatch_poisons_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-mismatch")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled {
        mut control_nonce, ..
    } = decoded_start.control
    else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let control_handle = handle.control_handle().unwrap();
        async move {
            control_handle
                .control("nonce-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    control_nonce[0] ^= 1;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-target-mismatch")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled { control_nonce, .. } = decoded_start.control else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let control_handle = handle.control_handle().unwrap();
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
        start.seq + 1,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-message-mismatch")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    let decoded_start = vsock_proto::decode_exec_start(&start.payload).unwrap();
    let ExecControlPolicy::Enabled { control_nonce, .. } = decoded_start.control else {
        panic!("supervised exec should enable control");
    };
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let control_task = tokio::spawn({
        let control_handle = handle.control_handle().unwrap();
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
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("control-inactive")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    let control_handle = handle.control_handle().unwrap();
    send_exec_result(
        &mut guest,
        start.seq,
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
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("inactive control must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after inactive control: {err}"),
    }
}
