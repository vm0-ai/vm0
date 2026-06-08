use std::io;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use vsock_proto::{ExecTermination, MSG_ERROR, MSG_EXEC_START};

use super::super::support::{
    MockGuest, await_mock_guest, host_from_stream, make_pair, normal_operation_readiness,
    read_guest_message, send_exec_result, setup_host_and_guest, wait_for_operation_count,
};
use super::start_capture_operation;
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn test_exec() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let msg = guest.expect_message(MSG_EXEC_START).await;

        let d = vsock_proto::decode_exec_start(&msg.payload).unwrap();
        assert_eq!(d.command, "echo hello");
        assert_eq!(
            d.timeout,
            vsock_proto::ExecTimeoutPolicy::Duration { timeout_ms: 5000 }
        );
        assert_eq!(d.lifecycle, vsock_proto::ExecLifecyclePolicy::OneShot);
        assert_eq!(d.control, vsock_proto::ExecControlPolicy::Disabled);
        assert!(d.env.is_empty());
        assert!(!d.sudo);
        assert_eq!(d.label, "exec");

        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                b"hello\n",
                b"",
            )
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host.exec("echo hello", 5000, &[], false).await.unwrap();
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    assert!(result.stderr.is_empty());
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn exec_operation_tracks_until_terminal_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("echo tracked", 5000, &[], false).await })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"tracked\n",
        b"",
    )
    .await;

    let result = exec_task.await.unwrap().unwrap();
    assert_eq!(result.stdout, b"tracked\n");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

/// `host.exec` with `timeout_ms == 0` must reject at the boundary rather
/// than send the request to the guest — an unbounded exec would leak a
/// guest-side orphan when the host's outer timeout fires.
#[tokio::test]
async fn test_exec_rejects_zero_timeout() {
    let (host, _guest) = setup_host_and_guest().await;

    let err = host.exec("echo hi", 0, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn test_exec_error_response() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let msg = guest.expect_message(MSG_EXEC_START).await;
        guest
            .send_error_response(msg.seq, "command not found")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("badcmd", 5000, &[], false).await.unwrap_err();
    assert!(err.to_string().contains("command not found"));
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn exec_operation_error_response_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("badcmd", 5000, &[], false).await })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let payload = vsock_proto::encode_error("command not found");
    let resp = vsock_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap();
    guest.write_all(&resp).await.unwrap();

    let err = exec_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("command not found"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn dropping_exec_handle_after_start_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "drop-after-start").await;
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(handle);
    wait_for_operation_count(&host, 0).await;

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let err = host
        .exec("blocked-after-drop", 5000, &[], false)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}
