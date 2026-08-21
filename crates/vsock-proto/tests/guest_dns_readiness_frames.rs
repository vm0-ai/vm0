use vsock_proto::{ProtocolError, encode_guest_dns_readiness_request_frame_into};

#[test]
fn validation_errors_preserve_existing_frame() {
    for (timeout_ms, hostname, expected_error) in [
        (
            0,
            "example.invalid",
            "guest_dns_readiness timeout_ms must be positive",
        ),
        (1, "", "guest_dns_readiness hostname must not be empty"),
        (1, "bad\0name", "guest_dns_readiness hostname contains NUL"),
    ] {
        let mut frame = b"stale frame bytes".to_vec();

        let error =
            encode_guest_dns_readiness_request_frame_into(&mut frame, 42, timeout_ms, hostname)
                .unwrap_err();

        assert!(matches!(
            error,
            ProtocolError::InvalidPayload(message) if message == expected_error
        ));
        assert_eq!(frame, b"stale frame bytes");
    }
}
