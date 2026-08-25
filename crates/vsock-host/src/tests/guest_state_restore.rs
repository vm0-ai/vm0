use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use vsock_proto::{
    ExecCapturedOutput, ExecTermination, GuestStateRestoreTimezone, MSG_GUEST_STATE_RESTORE,
    MSG_GUEST_STATE_RESTORE_RESULT,
};

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    MockGuest, host_from_stream, make_pair, normal_operation_readiness, pending_request_count,
};

fn entropy() -> [u8; 256] {
    std::array::from_fn(|index| index as u8)
}

fn success_payload() -> Vec<u8> {
    vsock_proto::encode_guest_state_restore_result(
        ExecTermination::Exited { exit_code: 0 },
        17,
        ExecCapturedOutput::Captured {
            bytes: b"guest timezone sync failed",
            truncated: true,
        },
        "",
    )
    .unwrap()
}

#[tokio::test]
async fn guest_state_restore_sends_fixed_request_and_decodes_result() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let expected_entropy = entropy();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        let decoded = vsock_proto::decode_guest_state_restore_request(&request.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 300_000);
        assert_eq!(decoded.unix_seconds, 1_778_000_000);
        assert_eq!(decoded.unix_nanoseconds, 123_000_000);
        assert_eq!(decoded.entropy, expected_entropy);
        assert_eq!(
            decoded.timezone,
            GuestStateRestoreTimezone::Required("Asia/Shanghai")
        );
        guest
            .send_response(
                MSG_GUEST_STATE_RESTORE_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let result = host
        .guest_state_restore(
            1_778_000_000,
            123_000_000,
            &entropy(),
            GuestStateRestoreTimezone::Required("Asia/Shanghai"),
            300_000,
            Duration::from_secs(1),
        )
        .await
        .unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.duration_ms, 17);
    assert_eq!(result.stderr, b"guest timezone sync failed");
    assert!(result.stderr_truncated);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_state_restore_surfaces_guest_error_and_malformed_result() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        guest
            .send_error_response(request.seq, "guest operations are quiescing")
            .await;
        let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        guest
            .send_response(MSG_GUEST_STATE_RESTORE_RESULT, request.seq, &[0xFF])
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let error = host
        .guest_state_restore(
            1,
            0,
            &entropy(),
            GuestStateRestoreTimezone::None,
            1,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("guest operations are quiescing"));

    let error = host
        .guest_state_restore(
            1,
            0,
            &entropy(),
            GuestStateRestoreTimezone::None,
            1,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_state_restore_timeout_abandons_connection_for_parking() {
    let (host_stream, guest_stream) = make_pair();
    let (request_tx, request_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let _request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        request_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let request_host = Arc::clone(&host);
    let request = tokio::spawn(async move {
        request_host
            .guest_state_restore(
                1,
                0,
                &entropy(),
                GuestStateRestoreTimezone::None,
                1,
                Duration::from_millis(20),
            )
            .await
    });
    request_rx.await.unwrap();

    let error = request.await.unwrap().unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}
