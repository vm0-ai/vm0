use super::super::*;
use super::shared::{ExecControlLayout, set_byte_at, write_u16_at, write_u32_at};
use super::{NONCE, assert_invalid_payload};
use crate::payloads::exec_control::EXEC_CONTROL_MAX_PAYLOAD_BYTES;

const MESSAGE_ID: &str = "message";
const BODY: &[u8] = b"body";

fn exec_control_payload() -> Vec<u8> {
    encode_exec_control(7, NONCE, MESSAGE_ID, BODY, 5000).unwrap()
}

#[test]
fn exec_control_roundtrip_and_rejects_malformed_payloads() {
    let payload = exec_control_payload();
    let layout = ExecControlLayout::new(MESSAGE_ID, BODY);
    let decoded = decode_exec_control(&payload).unwrap();
    assert_eq!(decoded.target_seq, 7);
    assert_eq!(decoded.request_timeout_ms, 5000);
    assert_eq!(decoded.control_nonce, NONCE);
    assert_eq!(decoded.message_id, MESSAGE_ID);
    assert_eq!(decoded.payload, BODY);

    let empty_payload = encode_exec_control(7, NONCE, MESSAGE_ID, b"", 5000).unwrap();
    assert_eq!(decode_exec_control(&empty_payload).unwrap().payload, b"");

    let max_payload = vec![0xAB; EXEC_CONTROL_MAX_PAYLOAD_BYTES];
    let max_payload_message =
        encode_exec_control(7, NONCE, MESSAGE_ID, &max_payload, 5000).unwrap();
    assert_eq!(
        decode_exec_control(&max_payload_message).unwrap().payload,
        max_payload
    );

    let err = encode_exec_control(0, NONCE, MESSAGE_ID, BODY, 5000).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec_control target_seq must be non-zero")
    ));

    let mut zero_target_seq = payload.clone();
    write_u32_at(&mut zero_target_seq, layout.target_seq_offset, 0);
    assert!(matches!(
        decode_exec_control(&zero_target_seq),
        Err(ProtocolError::InvalidPayload(
            "exec_control target_seq must be non-zero"
        ))
    ));

    let err = encode_exec_control(7, NONCE, "", BODY, 5000).unwrap_err();
    assert_invalid_payload(err, "exec_control message_id empty");

    let too_large = vec![0; EXEC_CONTROL_MAX_PAYLOAD_BYTES + 1];
    let err = encode_exec_control(7, NONCE, MESSAGE_ID, &too_large, 5000).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("payload", size) if size == too_large.len()
    ));

    let mut empty_message_id = exec_control_payload();
    write_u16_at(&mut empty_message_id, layout.message_id_len_offset, 0);
    assert_invalid_payload(
        decode_exec_control(&empty_message_id).unwrap_err(),
        "exec_control message_id empty",
    );

    let mut invalid_message_id = exec_control_payload();
    set_byte_at(&mut invalid_message_id, layout.message_id_offset, 0xFF);
    assert_invalid_payload(
        decode_exec_control(&invalid_message_id).unwrap_err(),
        "invalid UTF-8 in exec_control message_id",
    );

    let mut oversized_payload_len = exec_control_payload();
    write_u32_at(
        &mut oversized_payload_len,
        layout.payload_len_offset,
        (EXEC_CONTROL_MAX_PAYLOAD_BYTES as u32) + 1,
    );
    assert_invalid_payload(
        decode_exec_control(&oversized_payload_len).unwrap_err(),
        "exec_control payload too large",
    );

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_control(&trailing),
        Err(ProtocolError::InvalidPayload("exec_control trailing bytes"))
    ));
}
#[test]
fn exec_control_rejects_truncated_fields() {
    let payload = exec_control_payload();
    let layout = ExecControlLayout::new(MESSAGE_ID, BODY);

    assert_invalid_payload(
        decode_exec_control(&payload[..3]).unwrap_err(),
        "exec_control target_seq truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..layout.request_timeout_offset + 3]).unwrap_err(),
        "exec_control request_timeout_ms truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..layout.nonce_offset + EXEC_CONTROL_NONCE_LEN - 1])
            .unwrap_err(),
        "exec_control nonce truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..layout.message_id_len_offset + 1]).unwrap_err(),
        "exec_control message_id_len truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..layout.message_id_offset + 2]).unwrap_err(),
        "exec_control message_id truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..layout.payload_len_offset + 3]).unwrap_err(),
        "exec_control payload_len truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..layout.payload_end_offset - 2]).unwrap_err(),
        "exec_control payload truncated",
    );
}
