use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use nix::sys::socket::{setsockopt, sockopt};
use tokio::io::AsyncWriteExt;
use vsock_proto::{ExecTermination, MSG_ERROR, MSG_EXEC_CANCEL, MSG_EXEC_START};

use super::super::support::{
    assert_connection_accepts_exec_operation, captured_output_bytes, exec_capture_default,
    exec_capture_with_write_observer, host_from_stream, is_connected, make_pair, mock_handshake,
    normal_operation_readiness, operation_count, read_guest_message, send_exec_result,
    setup_host_and_guest, wait_for_operation_count,
};
use super::start_capture_operation;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;
use crate::{ExecCaptureRequest, FrameWriteObserver};

const EXEC_START_WRITE_TEST_TIMEOUT: Duration = Duration::from_millis(50);

fn capture_request(command: &str) -> ExecCaptureRequest<'_> {
    ExecCaptureRequest {
        timeout_ms: 5000,
        command,
        env: &[],
        sudo: false,
        label: "test-command",
        stdout_limit_bytes: 1024,
        stderr_limit_bytes: 1024,
        expected_exit_codes: &[],
        stdin_bytes: None,
        wait_timeout: Duration::from_secs(5),
    }
}

#[tokio::test]
async fn exec_start_cancelled_before_write_does_not_poison_or_send_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { start_capture_operation(&host, "blocked").await })
    };

    wait_for_operation_count(&host, 1).await;
    task.abort();
    let _ = task.await;
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));

    drop(writer_guard);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { exec_capture_default(&host, "echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(
        msg.msg_type, MSG_EXEC_START,
        "start frame should not be written"
    );
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(captured_output_bytes(&exec_result.stdout), b"ok");
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_capture_start_timeout_before_write_cleans_state_and_preserves_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            exec_capture_with_write_observer(
                &host,
                ExecCaptureRequest {
                    wait_timeout: EXEC_START_WRITE_TEST_TIMEOUT,
                    ..capture_request("writer-timeout")
                },
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    wait_for_operation_count(&host, 1).await;
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("exec start should respect its writer deadline")
        .unwrap();
    let err = match result {
        Ok(_) => panic!("exec start should time out while waiting for the writer"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(err.to_string(), "exec start timeout");
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("pre-write timeout must not send an exec frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after pre-write timeout: {err}"),
    }

    drop(writer_guard);
    tokio::task::yield_now().await;
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("timed-out exec start must not send a stale frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after releasing the writer: {err}"),
    }
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn exec_capture_wait_timeout_is_not_restarted_after_start_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    tokio::time::pause();
    let writer_guard = host.shared.writer.lock().await;
    let wait_timeout = Duration::from_secs(1);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.exec_operation_capture(ExecCaptureRequest {
                wait_timeout,
                ..capture_request("single-capture-deadline")
            })
            .await
        })
    };

    wait_for_operation_count(&host, 1).await;
    tokio::time::advance(Duration::from_millis(900)).await;
    drop(writer_guard);
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    tokio::time::advance(Duration::from_millis(200)).await;
    tokio::task::yield_now().await;
    assert_eq!(operation_count(&host), 0);
    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"late",
        b"",
    )
    .await;
    let result = task.await.unwrap();
    let err = match result {
        Ok(_) => panic!("capture wait must use the deadline established before frame writing"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(err.to_string(), "exec operation timeout");
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_capture_start_timeout_during_write_poisons_connection() {
    let (host_stream, mut guest) = make_pair();
    setsockopt(&host_stream, sockopt::SndBuf, &4096usize).unwrap();
    let host_task = tokio::spawn(async move { host_from_stream(host_stream).await.unwrap() });
    mock_handshake(&mut guest).await;
    let host = Arc::new(host_task.await.unwrap());
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        let stdin_bytes = vec![0xA5; vsock_proto::MAX_EXEC_STDIN_BYTES];
        tokio::spawn(async move {
            exec_capture_with_write_observer(
                &host,
                ExecCaptureRequest {
                    command: "cat",
                    stdin_bytes: Some(&stdin_bytes),
                    wait_timeout: EXEC_START_WRITE_TEST_TIMEOUT,
                    ..capture_request("blocked-write")
                },
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while write_start_count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("exec start should reach the frame write boundary");
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("blocked exec start write should respect its deadline")
        .unwrap();
    let err = match result {
        Ok(_) => panic!("blocked exec start write should time out"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(err.to_string(), "exec start timeout");

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(host.shared.writer.try_lock().is_ok());
}

#[tokio::test]
async fn exec_write_observer_does_not_fire_before_frame_write() {
    let (host, _guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            exec_capture_with_write_observer(
                &host,
                capture_request("blocked"),
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    wait_for_operation_count(&host, 1).await;

    task.abort();
    let _ = task.await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));

    drop(writer_guard);
}

#[tokio::test]
async fn exec_write_observer_fires_at_frame_write_boundary() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            exec_capture_with_write_observer(
                &host,
                capture_request("observed"),
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    wait_for_operation_count(&host, 1).await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);

    drop(writer_guard);
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;

    let result = task.await.unwrap().unwrap();
    assert_eq!(captured_output_bytes(&result.stdout), b"ok");
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn exec_write_observer_error_cleans_registration_without_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = exec_capture_with_write_observer(
        &host,
        capture_request("observer-error"),
        FrameWriteObserver::new(|| Err(io::Error::other("observer failed"))),
    )
    .await
    .unwrap_err();

    assert!(err.to_string().contains("observer failed"));
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("observer error must not send exec frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after observer error: {err}"),
    }
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_operation_handle_drop_after_full_write_marks_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "drop-after-write").await;
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    drop(handle);
    assert_eq!(operation_count(&host), 0);
    let mut buf = [0u8; 1024];
    match guest.try_read(&mut buf) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("drop must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after handle drop: {err}"),
    }
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_cancel_sends_cancel_and_waits_for_cancelled_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "cancel").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

    send_exec_result(&mut guest, start.seq, ExecTermination::Cancelled, b"", b"").await;
    let result = cancel_task.await.unwrap().unwrap();
    assert_eq!(result.termination, ExecTermination::Cancelled);
}

#[tokio::test]
async fn exec_cancel_writer_lock_timeout_before_write_does_not_poison_or_send_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-lock-timeout").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    let writer_guard = host.shared.writer.lock().await;

    let mut cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_millis(1)).await });
    let err = tokio::time::timeout(Duration::from_secs(1), &mut cancel_task)
        .await
        .expect("cancel_and_wait should return before the test guard")
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    drop(writer_guard);
    tokio::task::yield_now().await;
    let mut buf = [0u8; 1024];
    match guest.try_read(&mut buf) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("timed-out cancel must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after cancel timeout: {err}"),
    }
}

#[tokio::test]
async fn exec_cancel_zero_timeout_cleans_without_cancel_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-timeout-zero").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let err = handle.cancel_and_wait(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let mut buf = [0u8; 1024];
    match guest.try_read(&mut buf) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("zero-timeout cancel must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after zero-timeout cancel: {err}"),
    }
}

#[tokio::test]
async fn exec_cancel_oversized_timeout_cleans_without_cancel_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-timeout-overflow").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let err = handle.cancel_and_wait(Duration::MAX).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let mut buf = [0u8; 1024];
    match guest.try_read(&mut buf) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("oversized timeout must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after oversized timeout: {err}"),
    }
}

#[tokio::test]
async fn exec_cancel_terminal_result_wins_while_cancel_write_is_blocked() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-result-race").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    let writer_guard = host.shared.writer.lock().await;

    let mut cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;

    let result = tokio::time::timeout(Duration::from_secs(1), &mut cancel_task)
        .await
        .expect("terminal result should win before cancel write starts")
        .unwrap()
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    tokio::task::yield_now().await;
    let mut buf = [0u8; 1024];
    match guest.try_read(&mut buf) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("completed operation must not receive stale cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after terminal race: {err}"),
    }

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn exec_cancel_after_terminal_result_returns_result_without_cancel_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "already-done").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    let result = handle.cancel_and_wait(Duration::ZERO).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test(flavor = "current_thread")]
async fn exec_cancel_terminal_before_cancel_write_returns_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-before-write-race").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let writer_guard = host.shared.writer.lock().await;
    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    tokio::task::yield_now().await;

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    drop(writer_guard);
    let result = tokio::time::timeout(Duration::from_secs(5), cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(is_connected(&host));

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test(flavor = "current_thread")]
async fn exec_cancel_error_before_cancel_write_returns_error_without_cancel_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-before-error-race").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let writer_guard = host.shared.writer.lock().await;
    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    tokio::task::yield_now().await;

    let payload = vsock_proto::encode_error("guest rejected exec");
    let frame = vsock_proto::encode(MSG_ERROR, start.seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();
    wait_for_operation_count(&host, 0).await;

    drop(writer_guard);
    let err = tokio::time::timeout(Duration::from_secs(5), cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected exec");
    assert!(is_connected(&host));

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn exec_cancel_non_cancelled_terminal_result_cleans_operation_without_poisoning() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-race").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn exec_cancel_result_timeout_poisons_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "cancel-timeout").await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_millis(50)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}

#[tokio::test]
async fn exec_operation_frame_write_guard_started_drop_poisons_connection() {
    let (host, _guest) = setup_host_and_guest().await;
    exec_operation_impl::test_support::drop_started_frame_write_guard(Arc::clone(&host.shared));
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}
