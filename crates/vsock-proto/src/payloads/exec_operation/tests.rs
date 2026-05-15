use super::*;
use crate::wire::MAX_PAYLOAD_SIZE;

#[test]
fn exec_start_roundtrip_discard_policies() {
    let payload = encode_exec_start(
        5000,
        "echo ready",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedExecStart {
            timeout_ms: 5000,
            command: "echo ready",
            env: Vec::new(),
            sudo: false,
            label: "",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: Vec::new(),
        }
    );
}

#[test]
fn exec_start_wire_layout_places_label_before_output_policies() {
    let payload = encode_exec_start(
        5000,
        "cmd",
        &[],
        false,
        "abc",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Capture { limit_bytes: 7 },
    )
    .unwrap();

    let label_len_offset = 4 + 1 + 4 + "cmd".len() + 4;
    assert_eq!(
        &payload[label_len_offset..],
        &[
            0,
            3,
            b'a',
            b'b',
            b'c',
            EXEC_OUTPUT_POLICY_DISCARD,
            EXEC_OUTPUT_POLICY_CAPTURE,
            0,
            0,
            0,
            7,
            0,
            0,
        ]
    );
}

#[test]
fn exec_start_roundtrip_env_sudo_label_and_capture() {
    let payload = encode_exec_start(
        3000,
        "printenv",
        &[("PATH", "/usr/bin"), ("HOME", "/home/user")],
        true,
        "setup",
        ExecOutputPolicy::Capture { limit_bytes: 0 },
        ExecOutputPolicy::Capture { limit_bytes: 4096 },
    )
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.timeout_ms, 3000);
    assert_eq!(decoded.command, "printenv");
    assert_eq!(
        decoded.env,
        vec![("PATH", "/usr/bin"), ("HOME", "/home/user")]
    );
    assert!(decoded.sudo);
    assert_eq!(decoded.stdout, ExecOutputPolicy::Capture { limit_bytes: 0 });
    assert_eq!(
        decoded.stderr,
        ExecOutputPolicy::Capture { limit_bytes: 4096 }
    );
    assert_eq!(decoded.label, "setup");
}

#[test]
fn exec_start_roundtrip_stream_policy_allows_zero_stream_limit() {
    let payload = encode_exec_start(
        1000,
        "tail -f /tmp/log",
        &[],
        false,
        "stream",
        ExecOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 8192,
        },
        ExecOutputPolicy::Discard,
    )
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(
        decoded.stdout,
        ExecOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 8192,
        }
    );
    assert_eq!(decoded.stderr, ExecOutputPolicy::Discard);
    assert!(decoded.expected_exit_codes.is_empty());
}

#[test]
fn exec_start_roundtrip_expected_exit_codes() {
    let payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        timeout_ms: 1000,
        command: "optional-file",
        env: &[],
        sudo: false,
        label: "read-file",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[66, -9],
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.label, "read-file");
    assert_eq!(decoded.expected_exit_codes, vec![66, -9]);
}

#[test]
fn exec_start_roundtrip_capture_and_stream_policy() {
    let payload = encode_exec_start(
        1000,
        "run",
        &[],
        false,
        "combined",
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1024,
            stream_limit_bytes: 2048,
            chunk_limit_bytes: 512,
        },
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 0,
            stream_limit_bytes: 0,
            chunk_limit_bytes: 1,
        },
    )
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(
        decoded.stdout,
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1024,
            stream_limit_bytes: 2048,
            chunk_limit_bytes: 512,
        }
    );
    assert_eq!(
        decoded.stderr,
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 0,
            stream_limit_bytes: 0,
            chunk_limit_bytes: 1,
        }
    );
}

#[test]
fn exec_output_roundtrip_stdout() {
    let payload = encode_exec_output(ExecOutputStream::Stdout, 7, b"hello", false).unwrap();
    let decoded = decode_exec_output(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedExecOutput {
            stream: ExecOutputStream::Stdout,
            output_seq: 7,
            chunk: b"hello",
            truncated: false,
        }
    );
}

#[test]
fn exec_output_roundtrip_stderr_truncated() {
    let payload = encode_exec_output(ExecOutputStream::Stderr, 8, b"warn", true).unwrap();
    let decoded = decode_exec_output(&payload).unwrap();
    assert_eq!(decoded.stream, ExecOutputStream::Stderr);
    assert_eq!(decoded.output_seq, 8);
    assert_eq!(decoded.chunk, b"warn");
    assert!(decoded.truncated);
}

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
fn exec_cancel_roundtrip_empty_payload() {
    let payload = encode_exec_cancel();
    assert!(payload.is_empty());
    decode_exec_cancel(&payload).unwrap();
}

#[test]
fn exec_start_rejects_unknown_flags() {
    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    payload[4] = 0x80;

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start unknown flags")
    ));
}

#[test]
fn exec_start_rejects_invalid_utf8_fields() {
    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    payload[9] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in command"))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let key_offset = 4 + 1 + 4 + "cmd".len() + 4 + 4;
    payload[key_offset] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env key"))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let val_offset = key_offset + "K".len() + 4;
    payload[val_offset] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env value"))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let label_offset = 4 + 1 + 4 + "cmd".len() + 4 + 4 + "K".len() + 4 + "V".len() + 2;
    payload[label_offset] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in label"))
    ));
}

#[test]
fn exec_start_rejects_trailing_bytes() {
    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    payload.push(0);

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start trailing bytes")
    ));
}

#[test]
fn exec_start_rejects_malformed_env_count_without_preallocating() {
    let mut payload = encode_exec_start(
        1,
        "",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let env_count_offset = 4 + 1 + 4;
    payload[env_count_offset..env_count_offset + 4].copy_from_slice(&u32::MAX.to_be_bytes());

    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(_))
    ));
}

#[test]
fn exec_start_rejects_env_count_above_limit() {
    let env = vec![("K", "V"); MAX_EXEC_ENV_VARS + 1];
    let err = encode_exec_start(
        1,
        "cmd",
        &env,
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("env_count", size) if size == MAX_EXEC_ENV_VARS + 1
    ));

    let mut payload = encode_exec_start(
        1,
        "",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let env_count_offset = 4 + 1 + 4;
    payload[env_count_offset..env_count_offset + 4]
        .copy_from_slice(&((MAX_EXEC_ENV_VARS as u32) + 1).to_be_bytes());

    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start env_count too large"
        ))
    ));
}

#[test]
fn exec_start_rejects_truncated_fields() {
    assert!(matches!(
        decode_exec_start(&[]),
        Err(ProtocolError::InvalidPayload(
            "exec start timeout truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_start(&[0; 4]),
        Err(ProtocolError::InvalidPayload("exec start flags truncated"))
    ));
    assert!(matches!(
        decode_exec_start(&[0; 8]),
        Err(ProtocolError::InvalidPayload(
            "exec start command_len truncated"
        ))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    payload.truncate(10);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start command truncated"
        ))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let env_count_offset = 4 + 1 + 4 + "cmd".len();
    payload.truncate(env_count_offset + 3);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start env_count truncated"
        ))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let label_len_offset = 4 + 1 + 4 + "cmd".len() + 4;
    payload.truncate(label_len_offset + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start label_len truncated"
        ))
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "ok",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let label_start = 4 + 1 + 4 + "cmd".len() + 4 + 2;
    payload.truncate(label_start + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("exec start label truncated"))
    ));
}

#[test]
fn exec_start_rejects_invalid_policy_tag() {
    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let stdout_policy_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2;
    payload[stdout_policy_offset] = 0x99;

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("invalid exec output policy tag")
    ));
}

#[test]
fn exec_start_rejects_zero_stream_chunk_limit() {
    let err = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 0,
        },
        ExecOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec output chunk limit must be non-zero")
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2 + 1 + 4;
    payload[chunk_limit_offset..chunk_limit_offset + 4].copy_from_slice(&0u32.to_be_bytes());

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec output chunk limit must be non-zero")
    ));
}

#[test]
fn exec_start_rejects_expected_exit_count_above_limit() {
    let expected_exit_codes = vec![0; MAX_EXEC_EXPECTED_EXIT_CODES + 1];
    let err = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        timeout_ms: 1,
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &expected_exit_codes,
    })
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("expected_exit_count", _)
    ));

    let mut payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let count_offset = payload.len() - 2;
    payload[count_offset..]
        .copy_from_slice(&((MAX_EXEC_EXPECTED_EXIT_CODES as u16) + 1).to_be_bytes());
    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start expected_exit_count too large")
    ));
}

#[test]
fn exec_start_rejects_truncated_expected_exit_codes() {
    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        timeout_ms: 1,
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[66],
    })
    .unwrap();
    payload.pop();

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start expected exits truncated")
    ));
}

#[test]
fn exec_start_rejects_truncated_policy_fields() {
    let mut stream_payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let stream_chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2 + 1 + 4;
    stream_payload.truncate(stream_chunk_limit_offset + 3);
    assert!(matches!(
        decode_exec_start(&stream_payload),
        Err(ProtocolError::InvalidPayload(
            "exec stream policy chunk limit truncated"
        ))
    ));

    let mut capture_and_stream_payload = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1,
            stream_limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    let capture_and_stream_chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2 + 1 + 4 + 4;
    capture_and_stream_payload.truncate(capture_and_stream_chunk_limit_offset + 3);
    assert!(matches!(
        decode_exec_start(&capture_and_stream_payload),
        Err(ProtocolError::InvalidPayload(
            "exec capture-and-stream chunk limit truncated"
        ))
    ));
}

#[test]
fn exec_output_rejects_invalid_stream_flags_and_trailing_bytes() {
    let payload = encode_exec_output(ExecOutputStream::Stdout, 1, b"chunk", false).unwrap();

    let mut invalid_stream = payload.clone();
    invalid_stream[0] = 0x99;
    assert!(matches!(
        decode_exec_output(&invalid_stream),
        Err(ProtocolError::InvalidPayload("invalid exec output stream"))
    ));

    let mut unknown_flags = payload.clone();
    unknown_flags[5] = 0x80;
    assert!(matches!(
        decode_exec_output(&unknown_flags),
        Err(ProtocolError::InvalidPayload("exec output unknown flags"))
    ));

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_output(&trailing),
        Err(ProtocolError::InvalidPayload("exec output trailing bytes"))
    ));
}

#[test]
fn exec_output_rejects_truncated_fields() {
    assert!(matches!(
        decode_exec_output(&[]),
        Err(ProtocolError::InvalidPayload(
            "exec output stream truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_output(&[0]),
        Err(ProtocolError::InvalidPayload("exec output seq truncated"))
    ));

    let mut payload = encode_exec_output(ExecOutputStream::Stdout, 1, b"chunk", false).unwrap();
    payload.truncate(6);
    assert!(matches!(
        decode_exec_output(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec output chunk_len truncated"
        ))
    ));

    let mut payload = encode_exec_output(ExecOutputStream::Stdout, 1, b"chunk", false).unwrap();
    payload.truncate(payload.len() - 1);
    assert!(matches!(
        decode_exec_output(&payload),
        Err(ProtocolError::InvalidPayload("exec output chunk truncated"))
    ));
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

#[test]
fn exec_cancel_rejects_non_empty_payload() {
    let err = decode_exec_cancel(&[0]).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec cancel payload must be empty")
    ));
}

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
