use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use vsock_proto::{
    ExecCapturedOutput, ExecTermination, MSG_GUEST_STORAGE_MANIFEST,
    MSG_GUEST_STORAGE_MANIFEST_RESULT,
};

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    MockGuest, host_from_stream, make_pair, normal_operation_readiness, pending_request_count,
};

fn success_payload() -> Vec<u8> {
    vsock_proto::encode_guest_storage_manifest_result(
        ExecTermination::Exited { exit_code: 0 },
        17,
        ExecCapturedOutput::Captured {
            bytes: b"out",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"err",
            truncated: true,
        },
        "",
    )
    .unwrap()
}

#[tokio::test]
async fn guest_storage_manifest_sends_request_and_decodes_result() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        let decoded = vsock_proto::decode_guest_storage_manifest_request(&request.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 300_000);
        assert_eq!(decoded.run_id, "run-1");
        assert_eq!(decoded.runtime_dir, "/run/vm0/runs/run-1");
        assert_eq!(decoded.manifest_json, b"{}");
        guest
            .send_response(
                MSG_GUEST_STORAGE_MANIFEST_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let result = host
        .guest_storage_manifest(
            b"{}",
            "run-1",
            "/run/vm0/runs/run-1",
            300_000,
            Duration::from_secs(1),
        )
        .await
        .unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.duration_ms, 17);
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(!result.stdout_truncated);
    assert!(result.stderr_truncated);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_storage_manifest_surfaces_guest_error_and_completes_operation() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        guest
            .send_error_response(request.seq, "guest operations are quiescing")
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let error = host
        .guest_storage_manifest(b"{}", "run", "/run", 1, Duration::from_secs(1))
        .await
        .unwrap_err();

    assert!(error.to_string().contains("guest operations are quiescing"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_storage_manifest_rejects_malformed_terminal_payload_after_completion() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        guest
            .send_response(MSG_GUEST_STORAGE_MANIFEST_RESULT, request.seq, &[0xFF])
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let error = host
        .guest_storage_manifest(b"{}", "run", "/run", 1, Duration::from_secs(1))
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
async fn guest_storage_manifest_timeout_abandons_connection_and_ignores_late_result() {
    let (host_stream, guest_stream) = make_pair();
    let (request_tx, request_rx) = oneshot::channel();
    let (late_tx, late_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        request_tx.send(request.seq).unwrap();
        late_rx.await.unwrap();
        guest
            .send_response(
                MSG_GUEST_STORAGE_MANIFEST_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        tokio::task::yield_now().await;
    });
    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let request_host = Arc::clone(&host);
    let request = tokio::spawn(async move {
        request_host
            .guest_storage_manifest(b"{}", "run", "/run", 1, Duration::from_millis(20))
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
    late_tx.send(()).unwrap();
    guest.await.unwrap();
    assert_eq!(pending_request_count(&host), 0);
}

#[tokio::test]
async fn dropping_guest_storage_manifest_after_write_abandons_connection_for_parking() {
    let (host_stream, guest_stream) = make_pair();
    let (request_tx, request_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let _request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        request_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let request_host = Arc::clone(&host);
    let request = tokio::spawn(async move {
        request_host
            .guest_storage_manifest(b"{}", "run", "/run", 1, Duration::from_secs(1))
            .await
    });
    request_rx.await.unwrap();

    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    tokio::task::yield_now().await;

    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}
