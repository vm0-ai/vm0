use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use vsock_proto::{ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_START};

use super::super::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    operation_count, read_guest_message, send_exec_result, setup_host_and_guest,
    wait_for_operation_count,
};
use super::start_capture_operation;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;
use crate::{ExecCaptureRequest, FrameWriteObserver};

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
        tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
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
    assert_eq!(exec_result.stdout, b"ok");
    assert!(is_connected(&host));
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
            host.exec_capture_with_write_observer(
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
            host.exec_capture_with_write_observer(
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
    assert_eq!(result.stdout, b"ok");
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn exec_write_observer_error_cleans_registration_without_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host
        .exec_capture_with_write_observer(
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

    let result = handle
        .cancel_and_wait(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });

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

    let cancel_task = tokio::spawn(async move { handle.cancel_and_wait(Duration::ZERO).await });
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
