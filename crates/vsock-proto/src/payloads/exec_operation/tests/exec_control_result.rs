use super::super::*;
use super::{NONCE, assert_invalid_payload};

const MESSAGE_ID: &str = "message";
const DIAGNOSTIC: &str = "ok";

fn delivered_result_payload() -> Vec<u8> {
    encode_exec_control_result(
        7,
        NONCE,
        MESSAGE_ID,
        ExecControlStatus::Delivered,
        DIAGNOSTIC,
    )
    .unwrap()
}

fn message_id_len_field_offset() -> usize {
    4 + EXEC_CONTROL_NONCE_LEN
}

fn message_id_byte_offset() -> usize {
    message_id_len_field_offset() + 2
}

fn status_tag_offset(message_id: &str) -> usize {
    message_id_byte_offset() + message_id.len()
}

fn diagnostic_len_field_offset(message_id: &str) -> usize {
    status_tag_offset(message_id) + 1
}

fn diagnostic_byte_offset(message_id: &str) -> usize {
    diagnostic_len_field_offset(message_id) + 2
}

#[test]
fn exec_control_result_roundtrip_and_rejects_malformed_payloads() {
    let payload = delivered_result_payload();
    let decoded = decode_exec_control_result(&payload).unwrap();
    assert_eq!(decoded.target_seq, 7);
    assert_eq!(decoded.control_nonce, NONCE);
    assert_eq!(decoded.message_id, MESSAGE_ID);
    assert_eq!(decoded.status, ExecControlStatus::Delivered);
    assert_eq!(decoded.diagnostic, DIAGNOSTIC);

    let empty_diagnostic =
        encode_exec_control_result(7, NONCE, MESSAGE_ID, ExecControlStatus::Delivered, "").unwrap();
    assert_eq!(
        decode_exec_control_result(&empty_diagnostic)
            .unwrap()
            .diagnostic,
        ""
    );

    let err = encode_exec_control_result(0, NONCE, MESSAGE_ID, ExecControlStatus::Delivered, "")
        .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec_control_result target_seq must be non-zero")
    ));

    let mut zero_target_seq = payload.clone();
    zero_target_seq[..4].copy_from_slice(&0u32.to_be_bytes());
    assert!(matches!(
        decode_exec_control_result(&zero_target_seq),
        Err(ProtocolError::InvalidPayload(
            "exec_control_result target_seq must be non-zero"
        ))
    ));

    let err =
        encode_exec_control_result(7, NONCE, "", ExecControlStatus::Delivered, "").unwrap_err();
    assert_invalid_payload(err, "exec_control_result message_id empty");

    let mut empty_message_id = delivered_result_payload();
    let message_id_len_offset = message_id_len_field_offset();
    empty_message_id[message_id_len_offset..message_id_len_offset + 2]
        .copy_from_slice(&0u16.to_be_bytes());
    assert_invalid_payload(
        decode_exec_control_result(&empty_message_id).unwrap_err(),
        "exec_control_result message_id empty",
    );

    let mut invalid_message_id = delivered_result_payload();
    let message_id_offset = message_id_byte_offset();
    invalid_message_id[message_id_offset] = 0xFF;
    assert_invalid_payload(
        decode_exec_control_result(&invalid_message_id).unwrap_err(),
        "invalid UTF-8 in exec_control_result message_id",
    );

    let mut unknown_status = payload.clone();
    let status_offset = status_tag_offset(MESSAGE_ID);
    unknown_status[status_offset] = 0xFE;
    assert!(matches!(
        decode_exec_control_result(&unknown_status),
        Err(ProtocolError::InvalidPayload(
            "exec_control_result status invalid"
        ))
    ));

    let mut invalid_diagnostic = payload.clone();
    let diagnostic_offset = diagnostic_byte_offset(MESSAGE_ID);
    invalid_diagnostic[diagnostic_offset] = 0xFF;
    assert_invalid_payload(
        decode_exec_control_result(&invalid_diagnostic).unwrap_err(),
        "invalid UTF-8 in exec_control_result diagnostic",
    );

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_control_result(&trailing),
        Err(ProtocolError::InvalidPayload(
            "exec_control_result trailing bytes"
        ))
    ));
}
#[test]
fn exec_control_result_status_wire_values_are_stable() {
    let cases: &[(ExecControlStatus, u8)] = &[
        (ExecControlStatus::Delivered, 0x00),
        (ExecControlStatus::Inactive, 0x01),
        (ExecControlStatus::NonceMismatch, 0x02),
        (ExecControlStatus::Unsupported, 0x03),
        (ExecControlStatus::Rejected, 0x04),
        (ExecControlStatus::SinkUnavailable, 0x05),
        (ExecControlStatus::SinkTimeout, 0x06),
        (ExecControlStatus::QueueFull, 0x07),
        (ExecControlStatus::SinkError, 0x08),
    ];
    let status_offset = status_tag_offset(MESSAGE_ID);

    for &(status, expected_wire) in cases {
        let payload = encode_exec_control_result(7, NONCE, MESSAGE_ID, status, DIAGNOSTIC).unwrap();

        assert_eq!(payload[status_offset], expected_wire);
        assert_eq!(decode_exec_control_result(&payload).unwrap().status, status);
    }
}
#[test]
fn exec_control_result_rejects_truncated_fields() {
    let payload = delivered_result_payload();
    let message_id_len_offset = message_id_len_field_offset();
    let message_id_offset = message_id_byte_offset();
    let status_offset = status_tag_offset(MESSAGE_ID);
    let diagnostic_len_offset = diagnostic_len_field_offset(MESSAGE_ID);
    let diagnostic_offset = diagnostic_byte_offset(MESSAGE_ID);

    assert_invalid_payload(
        decode_exec_control_result(&payload[..3]).unwrap_err(),
        "exec_control_result target_seq truncated",
    );
    assert_invalid_payload(
        decode_exec_control_result(&payload[..4 + EXEC_CONTROL_NONCE_LEN - 1]).unwrap_err(),
        "exec_control_result nonce truncated",
    );
    assert_invalid_payload(
        decode_exec_control_result(&payload[..message_id_len_offset + 1]).unwrap_err(),
        "exec_control_result message_id_len truncated",
    );
    assert_invalid_payload(
        decode_exec_control_result(&payload[..message_id_offset + 2]).unwrap_err(),
        "exec_control_result message_id truncated",
    );
    assert_invalid_payload(
        decode_exec_control_result(&payload[..status_offset]).unwrap_err(),
        "exec_control_result status truncated",
    );
    assert_invalid_payload(
        decode_exec_control_result(&payload[..diagnostic_len_offset + 1]).unwrap_err(),
        "exec_control_result diagnostic_len truncated",
    );
    assert_invalid_payload(
        decode_exec_control_result(&payload[..diagnostic_offset + 1]).unwrap_err(),
        "exec_control_result diagnostic truncated",
    );
}
