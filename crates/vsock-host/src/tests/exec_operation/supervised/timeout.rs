use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_QUIESCE_OPERATIONS,
};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    operation_count, read_guest_message, send_discarded_exec_result, send_exec_started,
    setup_host_and_guest, wait_for_operation_count,
};
use super::support::supervised_request;
use crate::SupervisedExecRequest;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;

const START_ACK_TEST_TIMEOUT: Duration = Duration::from_millis(50);

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
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("terminal wait timeout must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after terminal wait timeout: {err}"),
    }
}

#[tokio::test]
async fn supervised_exec_start_ack_timeout_sends_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .start_supervised_exec(SupervisedExecRequest {
            start_timeout: START_ACK_TEST_TIMEOUT,
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
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("start timeout must send exactly one exec cancel; read {n} extra bytes"),
        Err(err) => panic!("unexpected read error after start timeout: {err}"),
    }
}

#[tokio::test]
async fn supervised_exec_start_timeout_before_write_preserves_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                start_timeout: START_ACK_TEST_TIMEOUT,
                ..supervised_request("writer-timeout")
            })
            .await
        })
    };

    wait_for_operation_count(&host, 1).await;
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("supervised exec should respect its writer deadline")
        .unwrap();
    let err = match result {
        Ok(_) => panic!("supervised exec should time out while waiting for the writer"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(err.to_string(), "exec start timeout");
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("pre-write timeout must not send start or cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after pre-write timeout: {err}"),
    }

    drop(writer_guard);
    tokio::task::yield_now().await;
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("timed-out supervised start must not send a stale frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after releasing the writer: {err}"),
    }
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_start_timeout_is_not_restarted_after_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    tokio::time::pause();
    let (deadline_elapsed_tx, deadline_elapsed_rx) = tokio::sync::oneshot::channel();
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            exec_operation_impl::test_support::start_supervised_exec_after_start_write(
                &host.shared,
                SupervisedExecRequest {
                    start_timeout: START_ACK_TEST_TIMEOUT,
                    ..supervised_request("single-start-deadline")
                },
                async move {
                    tokio::time::sleep(START_ACK_TEST_TIMEOUT).await;
                    let _ = deadline_elapsed_tx.send(());
                },
                Duration::from_secs(5),
            )
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    tokio::time::advance(START_ACK_TEST_TIMEOUT).await;
    tokio::time::timeout(Duration::from_secs(5), deadline_elapsed_rx)
        .await
        .expect("after-write hook should consume the start deadline")
        .expect("after-write hook should notify");
    assert_eq!(operation_count(&host), 0);
    send_exec_started(&mut guest, start.seq, 123).await;

    let result = task.await.unwrap();
    let err = match result {
        Ok(_) => panic!("elapsed start deadline must win before a late acknowledgement"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        err.to_string(),
        "supervised exec start acknowledgement timeout"
    );
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_late_start_frames_after_start_timeout_are_ignored() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .start_supervised_exec(SupervisedExecRequest {
            start_timeout: START_ACK_TEST_TIMEOUT,
            ..supervised_request("late-start-after-timeout")
        })
        .await
    {
        Ok(_) => panic!("supervised exec should time out before exec_started"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    send_exec_started(&mut guest, start.seq, 123).await;
    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(5)).await })
    };
    let quiesce = read_guest_message(&mut guest).await;
    assert_eq!(quiesce.msg_type, MSG_QUIESCE_OPERATIONS);
    let response = vsock_proto::encode(MSG_OPERATIONS_QUIESCED, quiesce.seq, &[]).unwrap();
    guest.write_all(&response).await.unwrap();
    quiesce_task.await.unwrap().unwrap();

    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_start_ack_timeout_removes_operation_before_cancel_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let (start_written_tx, start_written_rx) = tokio::sync::oneshot::channel();
    let (allow_start_wait_tx, allow_start_wait_rx) = tokio::sync::oneshot::channel();
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            exec_operation_impl::test_support::start_supervised_exec_after_start_write(
                &host.shared,
                SupervisedExecRequest {
                    start_timeout: START_ACK_TEST_TIMEOUT,
                    ..supervised_request("blocked-start-timeout-late-result")
                },
                async move {
                    let _ = start_written_tx.send(());
                    let _ = allow_start_wait_rx.await;
                },
                Duration::from_secs(5),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), start_written_rx)
        .await
        .expect("start frame write should complete")
        .expect("start write hook should notify");
    let writer_guard = host.shared.writer.lock().await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    allow_start_wait_tx
        .send(())
        .expect("start wait hook should still be pending");

    wait_for_operation_count(&host, 0).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    send_exec_started(&mut guest, start.seq, 123).await;
    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    drop(writer_guard);
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    let err = match task.await.unwrap() {
        Ok(_) => panic!("supervised exec should time out before exec_started"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(5)).await })
    };
    let quiesce = read_guest_message(&mut guest).await;
    assert_eq!(quiesce.msg_type, MSG_QUIESCE_OPERATIONS);
    let response = vsock_proto::encode(MSG_OPERATIONS_QUIESCED, quiesce.seq, &[]).unwrap();
    guest.write_all(&response).await.unwrap();
    quiesce_task.await.unwrap().unwrap();

    assert!(is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_start_ack_timeout_cancel_write_is_bounded() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let (start_written_tx, start_written_rx) = tokio::sync::oneshot::channel();
    let (allow_start_wait_tx, allow_start_wait_rx) = tokio::sync::oneshot::channel();
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            exec_operation_impl::test_support::start_supervised_exec_after_start_write(
                &host.shared,
                SupervisedExecRequest {
                    start_timeout: START_ACK_TEST_TIMEOUT,
                    ..supervised_request("blocked-start-timeout-cancel")
                },
                async move {
                    let _ = start_written_tx.send(());
                    let _ = allow_start_wait_rx.await;
                },
                Duration::ZERO,
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), start_written_rx)
        .await
        .expect("start frame write should complete")
        .expect("start write hook should notify");
    let writer_guard = host.shared.writer.lock().await;
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    allow_start_wait_tx
        .send(())
        .expect("start wait hook should still be pending");

    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("blocked start-timeout cancel write should be bounded")
        .unwrap();
    let err = match result {
        Ok(_) => panic!("supervised exec should fail when start-timeout cancel write is blocked"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        err.to_string(),
        "supervised exec start timeout cancel write timed out"
    );
    assert_eq!(operation_count(&host), 0);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!is_connected(&host));

    drop(writer_guard);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(0) => {}
        Ok(n) => panic!("bounded cancel write must not send after timing out; read {n} bytes"),
        Err(err) => panic!("unexpected read error after bounded cancel timeout: {err}"),
    }
}

#[tokio::test]
async fn supervised_exec_start_wait_cancellation_sends_cancel() {
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
    let cancel = tokio::time::timeout(Duration::from_secs(5), read_guest_message(&mut guest))
        .await
        .expect("cancelled start wait should send exec cancel");
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => {
            panic!("cancelled start wait must send exactly one exec cancel; read {n} extra bytes")
        }
        Err(err) => panic!("unexpected read error after cancelled start wait: {err}"),
    }
}
