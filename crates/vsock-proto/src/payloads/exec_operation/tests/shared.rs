use super::super::*;
use super::NONCE;
use crate::wire::MAX_PAYLOAD_SIZE;

#[test]
fn exec_operation_encoders_reject_oversized_payloads() {
    let command = "x".repeat(MAX_PAYLOAD_SIZE);
    let err = encode_exec_start(
        1,
        &command,
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));

    let chunk = vec![0u8; MAX_PAYLOAD_SIZE - 9];
    let err = encode_exec_output(ExecOutputStream::Stdout, 1, &chunk, false).unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));

    let stdout = vec![0u8; MAX_PAYLOAD_SIZE - 13];
    let err = encode_exec_result(
        ExecTermination::Cancelled,
        1,
        ExecCapturedOutput::Captured {
            bytes: &stdout,
            truncated: false,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
}

#[test]
fn exec_control_rejects_too_long_message_id() {
    let message_id = "x".repeat(u16::MAX as usize + 1);

    let err = encode_exec_control(7, NONCE, &message_id, b"body", 5000).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("message_id", size) if size == message_id.len()
    ));

    let err = encode_exec_control_result(7, NONCE, &message_id, ExecControlStatus::Delivered, "")
        .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("message_id", size) if size == message_id.len()
    ));

    let diagnostic = "x".repeat(u16::MAX as usize + 1);
    let err = encode_exec_control_result(
        7,
        NONCE,
        "message",
        ExecControlStatus::Delivered,
        &diagnostic,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("diagnostic", size) if size == diagnostic.len()
    ));
}

#[test]
fn exec_control_accepts_max_len_message_id_and_diagnostic() {
    let max_message_id = "m".repeat(u16::MAX as usize);

    let payload = encode_exec_control(7, NONCE, &max_message_id, b"body", 5000).unwrap();
    assert_eq!(
        decode_exec_control(&payload).unwrap().message_id,
        max_message_id
    );

    let max_diagnostic = "d".repeat(u16::MAX as usize);
    let result_payload = encode_exec_control_result(
        7,
        NONCE,
        &max_message_id,
        ExecControlStatus::Delivered,
        &max_diagnostic,
    )
    .unwrap();
    let decoded = decode_exec_control_result(&result_payload).unwrap();
    assert_eq!(decoded.message_id, max_message_id);
    assert_eq!(decoded.diagnostic, max_diagnostic);
}

#[test]
fn exec_start_rejects_too_long_label_and_result_diagnostic() {
    let label = "x".repeat(u16::MAX as usize + 1);
    let err = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        &label,
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("label", size) if size == label.len()
    ));

    let diagnostic = "x".repeat(u16::MAX as usize + 1);
    let err = encode_exec_result(
        ExecTermination::Cancelled,
        1,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        &diagnostic,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("diagnostic", size) if size == diagnostic.len()
    ));
}
