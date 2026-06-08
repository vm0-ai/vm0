use std::io;
use std::sync::Arc;
use std::time::Duration;

use vsock_proto::{
    ExecTermination, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED,
    MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK,
};

use super::support::{
    MockGuest, await_mock_guest, drop_idle_request_write_guard, drop_started_request_write_guard,
    fence_normal_operations, host_from_stream, is_connected, make_pair, normal_operation_readiness,
    poison_connection, setup_host_and_mock_guest,
};
use crate::{
    NormalOperationFenceRejection, VsockHost, operation_tracker::NormalOperationReadiness,
};

#[tokio::test]
async fn wait_for_connection_oversized_timeout_returns_invalid_input() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "vsock-host-timeout-overflow-{}-{unique}",
        std::process::id()
    ));
    let listener =
        std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
    let base = base.display().to_string();

    let result = VsockHost::wait_for_connection(&base, Duration::MAX).await;
    let error_kind = match result {
        Ok(_) => panic!("oversized timeout should return InvalidInput"),
        Err(error) => error.kind(),
    };

    assert_eq!(error_kind, io::ErrorKind::InvalidInput);
    assert!(
        !listener.exists(),
        "invalid timeout should not create listener socket"
    );
}

#[tokio::test]
async fn wait_for_connection_removes_listener_socket_on_abort() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base =
        std::env::temp_dir().join(format!("vsock-host-abort-{}-{unique}", std::process::id()));
    let listener =
        std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
    let base = base.display().to_string();

    let handle = tokio::spawn(async move {
        VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        while !listener.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    handle.abort();
    let _ = handle.await;

    assert!(
        !listener.exists(),
        "aborted listener should remove its socket path"
    );
}

#[tokio::test]
async fn test_shutdown() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
        guest
            .send_empty_response(MSG_SHUTDOWN_ACK, shutdown.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    assert!(host.shutdown(Duration::from_secs(2)).await);
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_sends_request_and_accepts_empty_ack() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        assert!(quiesce.payload.is_empty());

        guest
            .send_empty_response(MSG_OPERATIONS_QUIESCED, quiesce.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap();
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn resume_operations_sends_request_and_accepts_empty_ack() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let resume = guest.expect_message(MSG_RESUME_OPERATIONS).await;
        assert!(resume.payload.is_empty());

        guest
            .send_empty_response(MSG_OPERATIONS_RESUMED, resume.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn lifecycle_request_bypasses_normal_operation_fence() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let _fence = fence_normal_operations(&host);

    let err = host.exec("blocked", 5000, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(2)).await })
    };

    let msg = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
    guest
        .send_empty_response(MSG_OPERATIONS_QUIESCED, msg.seq)
        .await;

    quiesce_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn normal_operation_fence_rejects_new_normal_operations_until_dropped() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let fence = host
        .try_fence_normal_operations()
        .expect("idle host should fence normal operations");
    assert_eq!(
        host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::AlreadyFenced
    );

    let err = host.exec("blocked", 5000, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

    drop(fence);
    let exec_task = tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await });
    let request = guest.expect_message(MSG_EXEC_START).await;
    guest
        .send_exec_result(
            request.seq,
            ExecTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;

    assert_eq!(exec_task.await.unwrap().unwrap().stdout, b"ok");
}

#[tokio::test]
async fn normal_operation_fence_reports_busy_closed_and_not_parkable() {
    let (host_stream, guest) = make_pair();
    let release_exec = Arc::new(tokio::sync::Notify::new());
    let (request_seen_tx, request_seen_rx) = tokio::sync::oneshot::channel();
    let mut guest_task = {
        let release_exec = Arc::clone(&release_exec);
        tokio::spawn(async move {
            let mut guest = MockGuest::new(guest);
            guest.complete_handshake().await;
            let request = guest.expect_message(MSG_EXEC_START).await;
            let _ = request_seen_tx.send(());
            release_exec.notified().await;
            guest
                .send_exec_result(
                    request.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    b"done",
                    b"",
                )
                .await;
            drop(guest);
        })
    };

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("sleep", 5000, &[], false).await })
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(2), request_seen_rx) => {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    match (&mut guest_task).await {
                        Ok(()) => panic!("mock guest finished before exec request"),
                        Err(err) => panic!("mock guest task panicked before exec request: {err}"),
                    }
                }
                Err(_) => panic!("guest should receive exec start before busy assertion"),
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before exec request");
            panic!("mock guest finished before exec request");
        }
    }
    assert_eq!(
        host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::Busy
    );

    release_exec.notify_one();
    exec_task.await.unwrap().unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::Closed
    );
    await_mock_guest(guest_task).await;

    let (poisoned_host, _guest) = setup_host_and_mock_guest().await;
    poison_connection(&poisoned_host);
    assert_eq!(
        poisoned_host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::NotParkable
    );
}

#[tokio::test]
async fn quiesce_operations_surfaces_guest_error() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        guest
            .send_error_response(quiesce.seq, "guest operations still pending: 1")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest operations still pending: 1");
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_rejects_wrong_ack_type() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        guest
            .send_empty_response(MSG_OPERATIONS_RESUMED, quiesce.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        err.to_string()
            .contains("unexpected lifecycle response type")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_rejects_non_empty_ack_payload() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        guest
            .send_response(MSG_OPERATIONS_QUIESCED, quiesce.seq, b"x")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        err.to_string()
            .contains("operations_quiesced payload must be empty")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_times_out_and_late_ack_is_ignored() {
    let (host_stream, guest) = make_pair();
    let (quiesce_seen_tx, quiesce_seen_rx) = tokio::sync::oneshot::channel();
    let (send_late_ack, receive_late_ack) = tokio::sync::oneshot::channel();

    let mut guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        quiesce_seen_tx.send(()).unwrap();

        receive_late_ack.await.unwrap();
        guest
            .send_empty_response(MSG_OPERATIONS_QUIESCED, quiesce.seq)
            .await;

        let resume = guest.expect_message(MSG_RESUME_OPERATIONS).await;
        guest
            .send_empty_response(MSG_OPERATIONS_RESUMED, resume.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.quiesce_operations(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(2), quiesce_seen_rx) => {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    match (&mut guest_task).await {
                        Ok(()) => panic!("mock guest finished before quiesce request"),
                        Err(err) => panic!("mock guest task panicked before quiesce request: {err}"),
                    }
                }
                Err(_) => panic!("guest should receive quiesce request before late ack"),
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before quiesce request");
            panic!("mock guest finished before quiesce request");
        }
    }
    assert!(is_connected(&host));
    send_late_ack.send(()).unwrap();
    host.resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn test_connection_closed_returns_error() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        // Read the exec request then close the connection.
        let _request = guest.expect_message(MSG_EXEC_START).await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("echo hi", 5000, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    await_mock_guest(guest_task).await;
}

/// Request made after connection is already closed returns ConnectionReset
/// immediately (not after timeout).
#[tokio::test]
async fn test_request_after_close_returns_immediately() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        // Close immediately after handshake.
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();

    // Deterministically wait for reader to detect EOF and transition state
    // to Closed — no wall-clock sleep, driven by `close_notify`.
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    // This should return from the closed-state path, not hang until the exec
    // timeout.
    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.exec("echo hi", 5000, &[], false),
    )
    .await
    .expect("exec should return when the connection is already closed")
    .unwrap_err();
    assert!(
        matches!(
            err.kind(),
            io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
        ),
        "expected ConnectionReset or BrokenPipe, got {:?}",
        err.kind()
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn lifecycle_request_after_connection_close_returns_immediately() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.quiesce_operations(Duration::from_secs(60)),
    )
    .await
    .expect("lifecycle request should return when the connection is already closed")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn connection_close_marks_normal_operations_closed() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn late_poison_after_connection_close_does_not_reclassify_readiness() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );

    poison_connection(&host);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn connection_poison_marks_normal_operations_not_parkable() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        guest.expect_eof().await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    poison_connection(&host);

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn cancelled_request_before_frame_write_does_not_poison_connection() {
    let (host, _guest) = setup_host_and_mock_guest().await;

    drop_idle_request_write_guard(&host);

    assert!(is_connected(&host));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn cancelled_request_frame_write_poisons_connection() {
    let (host, _guest) = setup_host_and_mock_guest().await;

    drop_started_request_write_guard(&host);

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

/// Two concurrent exec calls get the correct response matched by seq.
#[tokio::test]
async fn test_concurrent_execs() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let all_msgs = guest.read_messages(2).await;
        assert_eq!(all_msgs.len(), 2);
        assert!(all_msgs.iter().all(|m| m.msg_type == MSG_EXEC_START));

        // Reply in reverse order to exercise seq-based dispatching.
        for msg in all_msgs.iter().rev() {
            let d = vsock_proto::decode_exec_start(&msg.payload).unwrap();
            let out = format!("reply:{}", d.command);
            guest
                .send_exec_result(
                    msg.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    out.as_bytes(),
                    b"",
                )
                .await;
        }

        guest.expect_eof().await;
    });

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());

    let h1 = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("cmd-a", 5000, &[], false).await })
    };
    let h2 = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("cmd-b", 5000, &[], false).await })
    };

    let r1 = h1.await.unwrap().unwrap();
    let r2 = h2.await.unwrap().unwrap();

    // Each response matches its own command, regardless of reply order.
    let out1 = String::from_utf8_lossy(&r1.stdout);
    let out2 = String::from_utf8_lossy(&r2.stdout);
    assert_eq!(out1, "reply:cmd-a");
    assert_eq!(out2, "reply:cmd-b");
    drop(host);
    await_mock_guest(guest_task).await;
}

/// Verify that post-handshake request seq starts at 2 (seq=1 is used by handshake ping).
#[tokio::test]
async fn test_seq_starts_at_2() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        // Read the first exec request and verify its seq.
        let msg = guest.expect_message(MSG_EXEC_START).await;
        // Handshake used seq=1, so first request must be seq=2.
        assert_eq!(msg.seq, 2, "first post-handshake seq should be 2");

        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                b"ok",
                b"",
            )
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host.exec("test", 5000, &[], false).await.unwrap();
    assert_eq!(result.exit_code, 0);
    await_mock_guest(guest_task).await;
}

/// Regression for #10076: the guest writes the exec response and then
/// immediately closes the socket. The reader dispatches the response,
/// then observes EOF and transitions state to `Closed`. Before the fix,
/// `request_raw` would observe `is_closed=true` after `write_all` and
/// return `ConnectionReset`, discarding the already-delivered response
/// sitting in `rx`. Under the new `ConnectionState` refactor the
/// `is_closed` early-exit no longer exists — the response must be
/// returned via the biased `rx` arm of `select!`.
#[tokio::test]
async fn test_response_then_close_returns_ok() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        // Read the exec request.
        let msg = guest.expect_message(MSG_EXEC_START).await;

        // Write the response and close the socket. The response must
        // race with EOF such that reader_loop processes both before the
        // host's `request_raw` returns from its select!.
        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                b"race-survived",
                b"",
            )
            .await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host.exec("echo race", 5000, &[], false).await;

    // The response was delivered before close; the refactor guarantees
    // it is returned via `rx` rather than being shadowed by a close
    // observation.
    let result = result.expect("response delivered before close must not be lost");
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"race-survived");
    await_mock_guest(guest_task).await;
}
