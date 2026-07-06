use std::io;
use std::time::Duration;

use vsock_proto::{ExecTermination, MSG_EXEC_CANCEL};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    operation_count, read_guest_message, send_exec_result, wait_for_operation_count,
};
use super::support::{
    StartedSupervisedExec, assert_no_guest_frame, send_guest_error, start_supervised_exec_fixture,
    supervised_request,
};
use crate::ExecOwnedCapturedOutput;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn supervised_exec_cancel_on_drop_sends_exec_cancel() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-on-drop")).await;
    let start_seq = start.seq();
    let guard = exec_operation_impl::ExecOperationCancelOnDropGuard::new_supervised(&handle)
        .expect("supervised handle should have active seq");
    drop(guard);

    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start_seq);

    send_exec_result(&mut guest, start_seq, ExecTermination::Cancelled, b"", b"").await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Cancelled);
}

#[tokio::test]
async fn supervised_exec_cancel_and_wait_sends_cancel_and_waits_for_cancelled_result() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-and-wait")).await;
    let start_seq = start.seq();

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start_seq);
    vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

    send_exec_result(&mut guest, start_seq, ExecTermination::Cancelled, b"", b"").await;
    let result = cancel_task.await.unwrap().unwrap();
    assert_eq!(result.termination, ExecTermination::Cancelled);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_cancel_and_wait_writer_lock_timeout_before_write_cleans_registration() {
    let StartedSupervisedExec {
        host,
        mut guest,
        handle,
        ..
    } = start_supervised_exec_fixture(supervised_request("cancel-lock-timeout")).await;
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
    assert_no_guest_frame(&mut guest, "timed-out cancel must not send exec cancel");
}

#[tokio::test]
async fn supervised_exec_cancel_zero_timeout_cleans_without_cancel_frame() {
    let StartedSupervisedExec {
        host,
        mut guest,
        handle,
        ..
    } = start_supervised_exec_fixture(supervised_request("cancel-timeout-zero")).await;

    let err = handle.cancel_and_wait(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    assert_no_guest_frame(&mut guest, "zero-timeout cancel must not send exec cancel");
}

#[tokio::test]
async fn supervised_exec_cancel_oversized_timeout_cleans_without_cancel_frame() {
    let StartedSupervisedExec {
        host,
        mut guest,
        handle,
        ..
    } = start_supervised_exec_fixture(supervised_request("cancel-timeout-overflow")).await;

    let err = handle.cancel_and_wait(Duration::MAX).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    assert_no_guest_frame(&mut guest, "oversized timeout must not send exec cancel");
}

#[tokio::test]
async fn supervised_exec_cancel_and_wait_terminal_result_wins_while_cancel_write_is_blocked() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-result-race")).await;
    let start_seq = start.seq();
    let writer_guard = host.shared.writer.lock().await;

    let mut cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    send_exec_result(
        &mut guest,
        start_seq,
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
    assert_no_guest_frame(
        &mut guest,
        "completed operation must not receive stale cancel",
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_cancel_handle_sends_cancel_without_consuming_wait() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-handle")).await;
    let start_seq = start.seq();
    let cancel_handle = handle
        .take_cancel_handle()
        .expect("supervised handle should expose a cancel handle");
    assert!(handle.take_cancel_handle().is_none());

    let cancel_task =
        tokio::spawn(async move { cancel_handle.cancel(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start_seq);
    vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

    cancel_task.await.unwrap().unwrap();
    assert_eq!(operation_count(&host), 1);

    send_exec_result(&mut guest, start_seq, ExecTermination::Cancelled, b"", b"").await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Cancelled);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_cancel_handle_timeout_before_write_does_not_poison_connection() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-lock-wait")).await;
    let start_seq = start.seq();
    let cancel_handle = handle
        .take_cancel_handle()
        .expect("supervised handle should expose a cancel handle");
    let writer_guard = host.shared.writer.lock().await;

    let err = cancel_handle.cancel(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 1);

    drop(writer_guard);
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
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
}

#[tokio::test]
async fn supervised_exec_cancel_handle_after_terminal_result_preserves_wait_and_connection() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-handle-after-result")).await;
    let start_seq = start.seq();
    let cancel_handle = handle
        .take_cancel_handle()
        .expect("supervised handle should expose a cancel handle");

    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    cancel_handle.cancel(Duration::from_secs(5)).await.unwrap();
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start_seq);
    vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        result.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"done".to_vec(),
            truncated: false,
        }
    );
    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_cancel_after_terminal_result_returns_result_without_cancel_frame() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("already-done")).await;
    let start_seq = start.seq();
    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    let result = handle.cancel_and_wait(Duration::ZERO).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test(flavor = "current_thread")]
async fn supervised_exec_cancel_terminal_before_cancel_write_returns_result() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-before-write-race")).await;
    let start_seq = start.seq();

    let writer_guard = host.shared.writer.lock().await;
    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    tokio::task::yield_now().await;

    send_exec_result(
        &mut guest,
        start_seq,
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
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test(flavor = "current_thread")]
async fn supervised_exec_cancel_error_before_cancel_write_returns_error_without_cancel_frame() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-before-error-race")).await;
    let start_seq = start.seq();

    let writer_guard = host.shared.writer.lock().await;
    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    tokio::task::yield_now().await;

    send_guest_error(&mut guest, start_seq, "guest rejected supervised exec").await;
    wait_for_operation_count(&host, 0).await;

    drop(writer_guard);
    let err = tokio::time::timeout(Duration::from_secs(5), cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected supervised exec");
    assert!(is_connected(&host));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_cancel_non_cancelled_terminal_result_cleans_without_poisoning() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-race")).await;
    let start_seq = start.seq();

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start_seq);

    send_exec_result(
        &mut guest,
        start_seq,
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
async fn supervised_exec_cancel_result_timeout_poisons_connection() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_request("cancel-timeout")).await;
    let start_seq = start.seq();

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_millis(50)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start_seq);

    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}
