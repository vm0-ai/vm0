use super::super::*;
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
