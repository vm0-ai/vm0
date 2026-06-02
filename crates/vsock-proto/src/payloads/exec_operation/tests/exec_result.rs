use super::super::*;

#[test]
fn exec_result_roundtrip_exited_with_captured_outputs() {
    let payload = encode_exec_result(
        ExecTermination::Exited { exit_code: -9 },
        1234,
        ExecCapturedOutput::Captured {
            bytes: b"stdout",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"stderr",
            truncated: true,
        },
        "",
    )
    .unwrap();

    let decoded = decode_exec_result(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedExecResult {
            termination: ExecTermination::Exited { exit_code: -9 },
            duration_ms: 1234,
            stdout: ExecCapturedOutput::Captured {
                bytes: b"stdout",
                truncated: false,
            },
            stderr: ExecCapturedOutput::Captured {
                bytes: b"stderr",
                truncated: true,
            },
            diagnostic: "",
        }
    );
}
#[test]
fn exec_result_roundtrip_timed_out_with_diagnostic() {
    let payload = encode_exec_result(
        ExecTermination::TimedOut,
        300_000,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "timed out",
    )
    .unwrap();

    let decoded = decode_exec_result(&payload).unwrap();
    assert_eq!(decoded.termination, ExecTermination::TimedOut);
    assert_eq!(decoded.duration_ms, 300_000);
    assert_eq!(decoded.stdout, ExecCapturedOutput::Discarded);
    assert_eq!(decoded.stderr, ExecCapturedOutput::Discarded);
    assert_eq!(decoded.diagnostic, "timed out");
}
#[test]
fn exec_result_roundtrip_non_exit_terminal_states() {
    for termination in [
        ExecTermination::Cancelled,
        ExecTermination::StartFailed,
        ExecTermination::WaitFailed,
    ] {
        let payload = encode_exec_result(
            termination,
            42,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            },
            "done",
        )
        .unwrap();

        let decoded = decode_exec_result(&payload).unwrap();
        assert_eq!(decoded.termination, termination);
        assert_eq!(decoded.duration_ms, 42);
        assert_eq!(
            decoded.stderr,
            ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            }
        );
        assert_eq!(decoded.diagnostic, "done");
    }
}
#[test]
fn exec_result_rejects_invalid_tags_flags_and_trailing_bytes() {
    let payload = encode_exec_result(
        ExecTermination::Cancelled,
        1,
        ExecCapturedOutput::Captured {
            bytes: b"out",
            truncated: false,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();

    let mut invalid_termination = payload.clone();
    invalid_termination[0] = 0x99;
    assert!(matches!(
        decode_exec_result(&invalid_termination),
        Err(ProtocolError::InvalidPayload(
            "invalid exec termination tag"
        ))
    ));

    let mut invalid_captured_tag = payload.clone();
    invalid_captured_tag[1 + 4] = 0x99;
    assert!(matches!(
        decode_exec_result(&invalid_captured_tag),
        Err(ProtocolError::InvalidPayload(
            "invalid exec captured output tag"
        ))
    ));

    let mut unknown_captured_flags = payload.clone();
    unknown_captured_flags[1 + 4 + 1] = 0x80;
    assert!(matches!(
        decode_exec_result(&unknown_captured_flags),
        Err(ProtocolError::InvalidPayload(
            "exec captured output unknown flags"
        ))
    ));

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_result(&trailing),
        Err(ProtocolError::InvalidPayload("exec result trailing bytes"))
    ));
}
#[test]
fn exec_result_rejects_truncated_fields() {
    assert!(matches!(
        decode_exec_result(&[]),
        Err(ProtocolError::InvalidPayload(
            "exec result termination truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_result(&[EXEC_TERMINATION_CANCELLED]),
        Err(ProtocolError::InvalidPayload(
            "exec result duration truncated"
        ))
    ));

    let mut payload = encode_exec_result(
        ExecTermination::Exited { exit_code: 1 },
        1,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    payload.truncate(4);
    assert!(matches!(
        decode_exec_result(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec result exit_code truncated"
        ))
    ));

    let mut payload = encode_exec_result(
        ExecTermination::Cancelled,
        1,
        ExecCapturedOutput::Captured {
            bytes: b"out",
            truncated: false,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    payload.truncate(1 + 4 + 1 + 1 + 4 + 2);
    assert!(matches!(
        decode_exec_result(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec captured output bytes truncated"
        ))
    ));

    let mut payload = encode_exec_result(
        ExecTermination::Cancelled,
        1,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "diag",
    )
    .unwrap();
    payload.truncate(payload.len() - 1);
    assert!(matches!(
        decode_exec_result(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec result diagnostic truncated"
        ))
    ));
}
#[test]
fn exec_result_rejects_invalid_diagnostic_utf8() {
    let mut payload = encode_exec_result(
        ExecTermination::Cancelled,
        1,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "x",
    )
    .unwrap();
    let diagnostic_offset = payload.len() - 1;
    payload[diagnostic_offset] = 0xFF;

    assert!(matches!(
        decode_exec_result(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in diagnostic"))
    ));
}
