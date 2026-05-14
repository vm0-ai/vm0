use std::io;
use std::sync::Arc;
use std::time::Duration;

use vsock_proto::{CommandTermination, MSG_COMMAND_CANCEL, MSG_COMMAND_START};

use super::super::support::{
    assert_connection_accepts_command_exec, is_connected, operation_count, read_guest_message,
    send_command_result, setup_host_and_guest, wait_for_operation_count,
};
use super::start_capture_operation;
use crate::command as command_impl;

#[tokio::test]
async fn command_start_cancelled_before_write_does_not_poison_or_send_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { start_capture_operation(&host, "blocked").await })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while operation_count(&host) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));

    drop(writer_guard);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(
        msg.msg_type, MSG_COMMAND_START,
        "start frame should not be written"
    );
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_handle_drop_after_full_write_sends_no_cancel() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "drop-after-write").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    drop(handle);
    assert_eq!(operation_count(&host), 0);

    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(
        msg.msg_type, MSG_COMMAND_START,
        "drop must not send command cancel"
    );
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_cancel_sends_cancel_and_waits_for_cancelled_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "cancel").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    vsock_proto::decode_command_cancel(&cancel.payload).unwrap();

    send_command_result(
        &mut guest,
        start.seq,
        CommandTermination::Cancelled,
        b"",
        b"",
    )
    .await;
    let result = cancel_task.await.unwrap().unwrap();
    assert_eq!(result.termination, CommandTermination::Cancelled);
}

#[tokio::test]
async fn command_cancel_after_terminal_result_returns_result_without_cancel_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "already-done").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);
    send_command_result(
        &mut guest,
        start.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    let result = handle
        .cancel_and_wait(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_cancel_non_cancelled_terminal_result_cleans_operation_without_poisoning() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-race").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    send_command_result(
        &mut guest,
        start.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_cancel_result_timeout_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "cancel-timeout").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);

    let cancel_task = tokio::spawn(async move { handle.cancel_and_wait(Duration::ZERO).await });
    let cancel = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}

#[tokio::test]
async fn command_frame_write_guard_started_drop_poisons_connection() {
    let (host, _guest, _decoder) = setup_host_and_guest().await;
    command_impl::test_support::drop_started_frame_write_guard(Arc::clone(&host.shared));
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}
