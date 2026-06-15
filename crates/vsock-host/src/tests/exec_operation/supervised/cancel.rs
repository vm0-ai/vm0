use std::io;
use std::sync::Arc;
use std::time::Duration;

use vsock_proto::{ExecTermination, MSG_EXEC_CANCEL};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    operation_count, read_guest_message, send_exec_result, send_exec_started, setup_host_and_guest,
    wait_for_operation_count,
};
use super::support::supervised_request;
use crate::ExecOwnedCapturedOutput;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;

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
async fn supervised_exec_cancel_and_wait_sends_cancel_and_waits_for_cancelled_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-and-wait"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

    send_exec_result(&mut guest, start.seq, ExecTermination::Cancelled, b"", b"").await;
    let result = cancel_task.await.unwrap().unwrap();
    assert_eq!(result.termination, ExecTermination::Cancelled);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_cancel_handle_sends_cancel_without_consuming_wait() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-handle"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
    let cancel_handle = handle
        .take_cancel_handle()
        .expect("supervised handle should expose a cancel handle");
    assert!(handle.take_cancel_handle().is_none());

    let cancel_task =
        tokio::spawn(async move { cancel_handle.cancel(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    vsock_proto::decode_exec_cancel(&cancel.payload).unwrap();

    cancel_task.await.unwrap().unwrap();
    assert_eq!(operation_count(&host), 1);

    send_exec_result(&mut guest, start.seq, ExecTermination::Cancelled, b"", b"").await;
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-lock-wait"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
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
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-handle-after-result"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
    let cancel_handle = handle
        .take_cancel_handle()
        .expect("supervised handle should expose a cancel handle");

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    cancel_handle.cancel(Duration::from_secs(5)).await.unwrap();
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("already-done"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
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
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_cancel_non_cancelled_terminal_result_cleans_without_poisoning() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_request("cancel-race"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();

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
