use std::future::{Future, poll_fn};
use std::io;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecCapturedOutput, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream,
    ExecTermination, ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL,
    MSG_EXEC_START, ProcessControlStatus,
};

use super::super::support::{
    normal_operation_readiness, operation_count, read_guest_message, send_discarded_exec_result,
    send_exec_control_result, send_exec_output, send_exec_result, send_exec_started,
    setup_host_and_guest, wait_for_operation_count,
};
use super::start_capture_operation;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;
use crate::{SupervisedExecControl, SupervisedExecRequest};

fn supervised_request(command: &str) -> SupervisedExecRequest<'_> {
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
        stream_queue_capacity: None,
        start_timeout: Duration::from_secs(5),
    }
}

fn supervised_stream_request(command: &str) -> SupervisedExecRequest<'_> {
    SupervisedExecRequest {
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 16,
        },
        stderr: ExecOutputPolicy::Discard,
        stream_queue_capacity: Some(1),
        ..supervised_request(command)
    }
}

async fn send_start_failed(guest: &mut tokio::net::UnixStream, seq: u32, diagnostic: &str) {
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

async fn send_guest_error(stream: &mut tokio::net::UnixStream, seq: u32, message: &str) {
    let payload = vsock_proto::encode_error(message);
    let frame = vsock_proto::encode(MSG_ERROR, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_returns_handle_after_exec_started() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("long-running"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&start.payload).unwrap();
    assert_eq!(decoded.lifecycle, ExecLifecyclePolicy::Supervised);
    assert_eq!(decoded.timeout, ExecTimeoutPolicy::None);
    assert_eq!(decoded.control, ExecControlPolicy::Disabled);

    assert!(
        !task.is_finished(),
        "supervised start must wait for exec_started"
    );

    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    assert_eq!(handle.pid(), 123);

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_start_failed_before_started_returns_error() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("missing-binary"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_start_failed(&mut guest, start.seq, "spawn failed").await;

    let err = match task.await.unwrap() {
        Ok(_) => panic!("supervised exec should fail when start fails"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "spawn failed");
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_output_before_started_poisons_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("stream-before-start"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_output(
        &mut guest,
        start.seq,
        0,
        ExecOutputStream::Stdout,
        b"early",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = match task.await.unwrap() {
        Ok(_) => panic!("supervised exec should fail when early output poisons the connection"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_non_start_failed_result_before_started_poisons_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("result-before-start"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = match task.await.unwrap() {
        Ok(_) => panic!("supervised exec should fail when early result poisons the connection"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_duplicate_started_poisons_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("duplicate-started"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    send_exec_started(&mut guest, start.seq, 456).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn one_shot_exec_rejects_exec_started() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "one-shot-started").await;
    let start = read_guest_message(&mut guest).await;

    send_exec_started(&mut guest, start.seq, 99).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_handle_drop_keeps_terminal_cleanup_without_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("drop-handle"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    drop(handle);

    assert_eq!(operation_count(&host), 1);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("handle drop must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after handle drop: {err}"),
    }

    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    wait_for_operation_count(&host, 0).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_taken_stream_receiver_survives_handle_drop() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("drop-handle-after-take-stream"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
    let mut stream_rx = handle
        .take_stream_receiver()
        .expect("supervised stream receiver should be available");
    drop(handle);

    send_exec_output(
        &mut guest,
        start.seq,
        0,
        ExecOutputStream::Stdout,
        b"still-streams",
        false,
    )
    .await;
    let event = tokio::time::timeout(Duration::from_secs(5), stream_rx.recv())
        .await
        .unwrap()
        .expect("taken stream receiver should stay connected");
    assert_eq!(event.stream, ExecOutputStream::Stdout);
    assert_eq!(event.output_seq, 0);
    assert_eq!(event.chunk, b"still-streams");

    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    wait_for_operation_count(&host, 0).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_wait_releases_unclaimed_stream_sender() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("wait-with-unclaimed-stream"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    let wait_fut = handle.wait(Duration::from_secs(5));
    tokio::pin!(wait_fut);
    poll_fn(|cx| match wait_fut.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(()),
        Poll::Ready(_) => panic!("wait should remain pending until terminal result"),
    })
    .await;

    send_exec_output(
        &mut guest,
        start.seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start.seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = wait_fut.await.unwrap();
    assert!(!result.stream_overflowed);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_cancel_on_drop_sends_exec_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-on-drop"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    let guard = exec_operation_impl::ExecOperationCancelOnDropGuard::new_supervised(&handle)
        .expect("supervised handle should have active seq");
    drop(guard);

    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    send_exec_result(&mut guest, start.seq, ExecTermination::Cancelled, b"", b"").await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Cancelled);
}

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
        ProcessControlStatus::Delivered,
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
async fn supervised_exec_output_sequence_validation_applies_after_started() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("bad-output-seq"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    send_exec_output(
        &mut guest,
        start.seq,
        1,
        ExecOutputStream::Stdout,
        b"out-of-order",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_stream_overflow_is_reported_in_terminal_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("stream-overflow"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
    let _stream_rx = handle
        .take_stream_receiver()
        .expect("supervised stream receiver should be available");
    send_exec_output(
        &mut guest,
        start.seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start.seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(result.stream_overflowed);
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
        ProcessControlStatus::QueueFull,
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
        ProcessControlStatus::Delivered,
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
        ProcessControlStatus::Delivered,
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
        ProcessControlStatus::Delivered,
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
        ProcessControlStatus::Delivered,
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

#[tokio::test]
async fn supervised_exec_terminal_wait_timeout_does_not_send_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("terminal-timeout"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    let err = handle.wait(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(operation_count(&host), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("terminal wait timeout must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after terminal wait timeout: {err}"),
    }
}

#[tokio::test]
async fn supervised_exec_start_ack_timeout_does_not_send_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .start_supervised_exec(SupervisedExecRequest {
            start_timeout: Duration::ZERO,
            ..supervised_request("start-timeout")
        })
        .await
    {
        Ok(_) => panic!("supervised exec should time out before exec_started"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(operation_count(&host), 0);

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("start timeout must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after start timeout: {err}"),
    }
}

#[tokio::test]
async fn supervised_exec_start_wait_cancellation_cleans_registration_without_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-start-wait"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    assert_eq!(operation_count(&host), 1);

    task.abort();
    let err = match task.await {
        Ok(_) => panic!("cancelled start wait task should abort"),
        Err(err) => err,
    };
    assert!(err.is_cancelled());
    assert_eq!(operation_count(&host), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("cancelled start wait must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after cancelled start wait: {err}"),
    }
}
