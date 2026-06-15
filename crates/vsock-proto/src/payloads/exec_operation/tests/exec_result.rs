use super::super::*;
use super::shared::{ExecResultLayout, set_byte_at};

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
    let stdout = ExecCapturedOutput::Captured {
        bytes: b"out",
        truncated: false,
    };
    let stderr = ExecCapturedOutput::Discarded;
    let payload = encode_exec_result(ExecTermination::Cancelled, 1, stdout, stderr, "").unwrap();
    let layout = ExecResultLayout::new(ExecTermination::Cancelled, stdout, stderr, "");

    let mut invalid_termination = payload.clone();
    set_byte_at(
        &mut invalid_termination,
        layout.termination_tag_offset,
        0x99,
    );
    assert!(matches!(
        decode_exec_result(&invalid_termination),
        Err(ProtocolError::InvalidPayload(
            "invalid exec termination tag"
        ))
    ));

    let mut invalid_captured_tag = payload.clone();
    set_byte_at(&mut invalid_captured_tag, layout.stdout.tag_offset, 0x99);
    assert!(matches!(
        decode_exec_result(&invalid_captured_tag),
        Err(ProtocolError::InvalidPayload(
            "invalid exec captured output tag"
        ))
    ));

    let mut unknown_captured_flags = payload.clone();
    set_byte_at(
        &mut unknown_captured_flags,
        layout.stdout.flags_offset.unwrap(),
        0x80,
    );
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
    let layout = ExecResultLayout::new(
        ExecTermination::Exited { exit_code: 1 },
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    );
    payload.truncate(layout.exit_code_offset.unwrap() + 3);
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
    let layout = ExecResultLayout::new(
        ExecTermination::Cancelled,
        ExecCapturedOutput::Captured {
            bytes: b"out",
            truncated: false,
        },
        ExecCapturedOutput::Discarded,
        "",
    );
    payload.truncate(layout.stdout.bytes_offset.unwrap() + 2);
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
    let layout = ExecResultLayout::new(
        ExecTermination::Cancelled,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "diag",
    );
    payload.truncate(layout.diagnostic_end_offset - 1);
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
    let layout = ExecResultLayout::new(
        ExecTermination::Cancelled,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "x",
    );
    set_byte_at(&mut payload, layout.diagnostic_offset, 0xFF);

    assert!(matches!(
        decode_exec_result(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in diagnostic"))
    ));
}
