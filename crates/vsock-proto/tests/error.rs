use vsock_proto::ProtocolError;

#[test]
fn payload_too_large_display_identifies_byte_lengths() {
    let error = ProtocolError::PayloadTooLarge("payload", 123);

    assert_eq!(
        error.to_string(),
        "payload field too large: payload (123 bytes)"
    );
}

#[test]
fn payload_count_too_large_display_identifies_element_counts() {
    let error = ProtocolError::PayloadCountTooLarge("env_count", 4097);

    assert_eq!(
        error.to_string(),
        "payload field too large: env_count (4097 elements)"
    );
}
