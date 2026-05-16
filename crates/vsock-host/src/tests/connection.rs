use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vsock_proto::{
    Decoder, ExecTermination, MSG_ERROR, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED, MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK,
};

use super::support::{
    drop_started_pending_normal_request_write_guard, fence_normal_operations, host_from_stream,
    make_pair, mock_handshake, normal_operation_readiness, poison_connection, read_guest_message,
    send_exec_result, setup_host_and_guest,
};
use crate::{VsockHost, operation_tracker::NormalOperationReadiness};

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
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SHUTDOWN);

        let resp = vsock_proto::encode(MSG_SHUTDOWN_ACK, msgs[0].seq, &[]).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    assert!(host.shutdown(Duration::from_secs(2)).await);
}

#[tokio::test]
async fn quiesce_operations_sends_request_and_accepts_empty_ack() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_QUIESCE_OPERATIONS);
        assert!(msgs[0].payload.is_empty());

        let resp = vsock_proto::encode(MSG_OPERATIONS_QUIESCED, msgs[0].seq, &[]).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap();
}

#[tokio::test]
async fn resume_operations_sends_request_and_accepts_empty_ack() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_RESUME_OPERATIONS);
        assert!(msgs[0].payload.is_empty());

        let resp = vsock_proto::encode(MSG_OPERATIONS_RESUMED, msgs[0].seq, &[]).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
}

#[tokio::test]
async fn lifecycle_request_bypasses_normal_operation_fence() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let _fence = fence_normal_operations(&host);

    let err = host.exec("blocked", 5000, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(2)).await })
    };

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_QUIESCE_OPERATIONS);
    let resp = vsock_proto::encode(MSG_OPERATIONS_QUIESCED, msg.seq, &[]).unwrap();
    guest.write_all(&resp).await.unwrap();

    quiesce_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn quiesce_operations_surfaces_guest_error() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_QUIESCE_OPERATIONS);

        let payload = vsock_proto::encode_error("guest operations still pending: 1");
        let resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest operations still pending: 1");
}

#[tokio::test]
async fn quiesce_operations_rejects_wrong_ack_type() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let resp = vsock_proto::encode(MSG_OPERATIONS_RESUMED, msgs[0].seq, &[]).unwrap();
        guest.write_all(&resp).await.unwrap();
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
}

#[tokio::test]
async fn quiesce_operations_rejects_non_empty_ack_payload() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let resp = vsock_proto::encode(MSG_OPERATIONS_QUIESCED, msgs[0].seq, b"x").unwrap();
        guest.write_all(&resp).await.unwrap();
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
}

#[tokio::test]
async fn quiesce_operations_times_out_and_late_ack_is_ignored() {
    let (host_stream, mut guest) = make_pair();
    let (quiesce_seen_tx, quiesce_seen_rx) = tokio::sync::oneshot::channel();
    let (send_late_ack, receive_late_ack) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let quiesce = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(quiesce.msg_type, MSG_QUIESCE_OPERATIONS);
        quiesce_seen_tx.send(()).unwrap();

        receive_late_ack.await.unwrap();
        let late = vsock_proto::encode(MSG_OPERATIONS_QUIESCED, quiesce.seq, &[]).unwrap();
        guest.write_all(&late).await.unwrap();

        let resume = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(resume.msg_type, MSG_RESUME_OPERATIONS);
        let resp = vsock_proto::encode(MSG_OPERATIONS_RESUMED, resume.seq, &[]).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.quiesce_operations(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    tokio::time::timeout(Duration::from_secs(2), quiesce_seen_rx)
        .await
        .unwrap()
        .unwrap();
    send_late_ack.send(()).unwrap();
    host.resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
}

#[tokio::test]
async fn test_connection_closed_returns_error() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        // Read the exec request then close the connection.
        let mut buf = [0u8; 4096];
        let _ = guest.read(&mut buf).await.unwrap();
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("echo hi", 5000, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

/// Request made after connection is already closed returns ConnectionReset
/// immediately (not after timeout).
#[tokio::test]
async fn test_request_after_close_returns_immediately() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
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
}

#[tokio::test]
async fn connection_close_marks_normal_operations_closed() {
    let (host_stream, mut guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
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
    guest_task.await.unwrap();
}

#[tokio::test]
async fn late_poison_after_connection_close_does_not_reclassify_readiness() {
    let (host_stream, mut guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
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
    guest_task.await.unwrap();
}

#[tokio::test]
async fn connection_poison_marks_normal_operations_not_parkable() {
    let (host_stream, mut guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
        let mut buf = [0u8; 1];
        let _ = guest.read(&mut buf).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    poison_connection(&host);

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    tokio::time::timeout(Duration::from_secs(5), guest_task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cancelled_normal_request_frame_write_poisons_connection() {
    let (host, _guest, _decoder) = setup_host_and_guest().await;

    drop_started_pending_normal_request_write_guard(&host);

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
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        // Read both exec requests (may arrive in one or two reads).
        let mut all_msgs = Vec::new();
        let mut buf = [0u8; 4096];
        while all_msgs.len() < 2 {
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            all_msgs.extend(msgs);
        }
        assert_eq!(all_msgs.len(), 2);
        assert!(all_msgs.iter().all(|m| m.msg_type == MSG_EXEC_START));

        // Reply in reverse order to exercise seq-based dispatching.
        for msg in all_msgs.iter().rev() {
            let d = vsock_proto::decode_exec_start(&msg.payload).unwrap();
            let out = format!("reply:{}", d.command);
            send_exec_result(
                &mut guest,
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                out.as_bytes(),
                b"",
            )
            .await;
        }

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
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
}

/// Verify that post-handshake request seq starts at 2 (seq=1 is used by handshake ping).
#[tokio::test]
async fn test_seq_starts_at_2() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        // Read the first exec request and verify its seq.
        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_EXEC_START);
        // Handshake used seq=1, so first request must be seq=2.
        assert_eq!(msgs[0].seq, 2, "first post-handshake seq should be 2");

        send_exec_result(
            &mut guest,
            msgs[0].seq,
            ExecTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host.exec("test", 5000, &[], false).await.unwrap();
    assert_eq!(result.exit_code, 0);
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
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        // Read the exec request.
        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_EXEC_START);

        // Write the response and close the socket. The response must
        // race with EOF such that reader_loop processes both before the
        // host's `request_raw` returns from its select!.
        send_exec_result(
            &mut guest,
            msgs[0].seq,
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
}
