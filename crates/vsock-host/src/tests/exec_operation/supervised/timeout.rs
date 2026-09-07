use std::io;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use nix::sys::socket::{Shutdown, setsockopt, shutdown, sockopt};
use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_QUIESCE_OPERATIONS,
};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, host_from_stream, is_connected, make_pair,
    mock_handshake, normal_operation_readiness, operation_count, read_guest_message,
    send_discarded_exec_result, send_exec_started, setup_host_and_guest, wait_for_operation_count,
};
use super::support::supervised_request;
use crate::exec_operation as exec_operation_impl;
use crate::operation_tracker::NormalOperationReadiness;
use crate::{
    FrameWriteObserver, RequestTimeoutError, RequestTimeoutStage, SupervisedExecControl,
    SupervisedExecRequest,
};

const START_ACK_TEST_TIMEOUT: Duration = Duration::from_millis(50);
const AGENT_READY_TEST_TIMEOUT: Duration = Duration::from_millis(200);

fn assert_request_timeout(error: &io::Error, stage: RequestTimeoutStage, timeout: Duration) {
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let timeout_error = error
        .get_ref()
        .and_then(|source| source.downcast_ref::<RequestTimeoutError>())
        .expect("timeout should expose its request stage");
    assert_eq!(timeout_error.stage(), stage);
    assert_eq!(timeout_error.timeout(), timeout);
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
    assert_request_timeout(
        &err,
        RequestTimeoutStage::AwaitingTerminalResponse,
        START_ACK_TEST_TIMEOUT,
    );
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
async fn supervised_agent_ready_timeout_after_started_sends_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                role: vsock_proto::ExecProcessRole::Agent,
                control: SupervisedExecControl::Enabled { sink: true },
                start_timeout: AGENT_READY_TEST_TIMEOUT,
                ..supervised_request("agent-ready-timeout")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    send_exec_started(&mut guest, start.seq, 123).await;
    tokio::task::yield_now().await;
    assert!(!task.is_finished());

    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("Agent-ready wait should respect the start deadline")
        .unwrap();
    let err = match result {
        Ok(_) => panic!("Agent start should time out before exec_agent_ready"),
        Err(err) => err,
    };
    assert_request_timeout(
        &err,
        RequestTimeoutStage::AwaitingTerminalResponse,
        AGENT_READY_TEST_TIMEOUT,
    );
    assert_eq!(operation_count(&host), 0);
    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
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
    assert_request_timeout(
        &err,
        RequestTimeoutStage::BeforeFrameWrite,
        START_ACK_TEST_TIMEOUT,
    );
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
async fn supervised_exec_start_timeout_during_write_reports_frame_write() {
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
            exec_operation_impl::test_support::start_supervised_exec_with_write_observer(
                &host.shared,
                SupervisedExecRequest {
                    stdin_bytes: Some(&stdin_bytes),
                    start_timeout: START_ACK_TEST_TIMEOUT,
                    ..supervised_request("blocked-start-write")
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
    .expect("supervised start should reach the frame write boundary");
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("blocked supervised start write should respect its deadline")
        .unwrap();
    let error = match result {
        Ok(_) => panic!("blocked supervised start write should time out"),
        Err(error) => error,
    };
    assert_request_timeout(
        &error,
        RequestTimeoutStage::FrameWrite,
        START_ACK_TEST_TIMEOUT,
    );
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
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
    assert_request_timeout(
        &err,
        RequestTimeoutStage::AwaitingTerminalResponse,
        START_ACK_TEST_TIMEOUT,
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
    assert_request_timeout(
        &err,
        RequestTimeoutStage::AwaitingTerminalResponse,
        START_ACK_TEST_TIMEOUT,
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
async fn supervised_exec_start_ack_timeout_preserves_stage_when_cancel_write_fails() {
    let (host, mut guest) = setup_host_and_guest().await;
    let result = exec_operation_impl::test_support::start_supervised_exec_after_start_write(
        &host.shared,
        SupervisedExecRequest {
            start_timeout: START_ACK_TEST_TIMEOUT,
            ..supervised_request("start-timeout-broken-cancel")
        },
        async {
            let start = read_guest_message(&mut guest).await;
            assert_eq!(start.msg_type, MSG_EXEC_START);
            // Keep the guest-to-host side open so only the cancel write fails.
            shutdown(guest.as_raw_fd(), Shutdown::Read).unwrap();
        },
        Duration::from_secs(1),
    )
    .await;
    let error = match result {
        Ok(_) => panic!("unacknowledged start should time out"),
        Err(error) => error,
    };

    assert_request_timeout(
        &error,
        RequestTimeoutStage::AwaitingTerminalResponse,
        START_ACK_TEST_TIMEOUT,
    );
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
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

#[tokio::test]
async fn supervised_agent_start_wait_cancellation_after_started_sends_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(SupervisedExecRequest {
                role: vsock_proto::ExecProcessRole::Agent,
                control: SupervisedExecControl::Enabled { sink: true },
                ..supervised_request("cancel-agent-ready-wait")
            })
            .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    send_exec_started(&mut guest, start.seq, 123).await;
    tokio::task::yield_now().await;
    assert!(!task.is_finished());

    task.abort();
    let err = match task.await {
        Ok(_) => panic!("cancelled Agent-ready wait task should abort"),
        Err(err) => err,
    };
    assert!(err.is_cancelled());
    assert_eq!(operation_count(&host), 0);
    let cancel = tokio::time::timeout(Duration::from_secs(5), read_guest_message(&mut guest))
        .await
        .expect("cancelled Agent-ready wait should send exec cancel");
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
}
