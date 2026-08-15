use vsock_proto::{
    EXEC_CONTROL_MAX_PAYLOAD_BYTES, EXEC_CONTROL_NONCE_LEN, MSG_EXEC_CONTROL, ProtocolError,
    encode, encode_exec_control, encode_exec_control_frame_into, validate_exec_control,
};

const TARGET_SEQ: u32 = 7;
const FRAME_SEQ: u32 = 42;
const REQUEST_TIMEOUT_MS: u32 = 5_000;
const CONTROL_NONCE: [u8; EXEC_CONTROL_NONCE_LEN] = [0xA5; EXEC_CONTROL_NONCE_LEN];
const MESSAGE_ID: &str = "active-input:run-id:1";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

fn assert_frames_match(payload: &[u8]) -> TestResult {
    let control_payload = encode_exec_control(
        TARGET_SEQ,
        CONTROL_NONCE,
        MESSAGE_ID,
        payload,
        REQUEST_TIMEOUT_MS,
    )?;
    let expected = encode(MSG_EXEC_CONTROL, FRAME_SEQ, &control_payload)?;
    let mut actual = b"stale frame bytes".to_vec();

    encode_exec_control_frame_into(
        &mut actual,
        FRAME_SEQ,
        TARGET_SEQ,
        CONTROL_NONCE,
        MESSAGE_ID,
        payload,
        REQUEST_TIMEOUT_MS,
    )?;

    assert_eq!(actual, expected);
    Ok(())
}

fn assert_same_error(actual: ProtocolError, expected: &ProtocolError) {
    assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
    assert_eq!(actual.to_string(), expected.to_string());
}

fn assert_invalid_request_matches(
    target_seq: u32,
    message_id: &str,
    payload: &[u8],
) -> TestResult<ProtocolError> {
    let expected = encode_exec_control(
        target_seq,
        CONTROL_NONCE,
        message_id,
        payload,
        REQUEST_TIMEOUT_MS,
    )
    .err()
    .ok_or_else(|| std::io::Error::other("invalid exec-control payload unexpectedly encoded"))?;
    let validation = validate_exec_control(
        target_seq,
        CONTROL_NONCE,
        message_id,
        payload,
        REQUEST_TIMEOUT_MS,
    )
    .err()
    .ok_or_else(|| std::io::Error::other("invalid exec-control payload unexpectedly validated"))?;
    assert_same_error(validation, &expected);

    let mut frame = b"stale frame bytes".to_vec();
    let direct = encode_exec_control_frame_into(
        &mut frame,
        FRAME_SEQ,
        target_seq,
        CONTROL_NONCE,
        message_id,
        payload,
        REQUEST_TIMEOUT_MS,
    )
    .err()
    .ok_or_else(|| {
        std::io::Error::other("invalid exec-control payload unexpectedly encoded as a frame")
    })?;
    assert_same_error(direct, &expected);
    assert!(frame.is_empty());

    Ok(expected)
}

#[test]
fn direct_exec_control_frames_match_composed_frames() -> TestResult {
    assert_frames_match(b"")?;
    assert_frames_match(br#"{"type":"active-input","text":"hello"}"#)?;
    assert_frames_match(&vec![0xAB; EXEC_CONTROL_MAX_PAYLOAD_BYTES])?;
    Ok(())
}

#[test]
fn direct_exec_control_validation_matches_payload_encoding() -> TestResult {
    let zero_target = assert_invalid_request_matches(0, MESSAGE_ID, b"payload")?;
    assert!(matches!(
        zero_target,
        ProtocolError::InvalidPayload("exec_control target_seq must be non-zero")
    ));

    let empty_message_id = assert_invalid_request_matches(TARGET_SEQ, "", b"payload")?;
    assert!(matches!(
        empty_message_id,
        ProtocolError::InvalidPayload("exec_control message_id empty")
    ));

    let long_message_id = "x".repeat(usize::from(u16::MAX) + 1);
    let oversized_message_id =
        assert_invalid_request_matches(TARGET_SEQ, &long_message_id, b"payload")?;
    assert!(matches!(
        oversized_message_id,
        ProtocolError::PayloadTooLarge("message_id", size) if size == long_message_id.len()
    ));

    let large_payload = vec![0; EXEC_CONTROL_MAX_PAYLOAD_BYTES + 1];
    let oversized_payload = assert_invalid_request_matches(TARGET_SEQ, MESSAGE_ID, &large_payload)?;
    assert!(matches!(
        oversized_payload,
        ProtocolError::PayloadTooLarge("payload", size) if size == large_payload.len()
    ));
    Ok(())
}
