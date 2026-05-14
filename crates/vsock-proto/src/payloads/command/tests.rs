use super::*;
use crate::wire::MAX_PAYLOAD_SIZE;

#[test]
fn command_start_roundtrip_discard_policies() {
    let payload = encode_command_start(
        5000,
        "echo ready",
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();

    let decoded = decode_command_start(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedCommandStart {
            timeout_ms: 5000,
            command: "echo ready",
            env: Vec::new(),
            sudo: false,
            label: "",
            stdout: CommandOutputPolicy::Discard,
            stderr: CommandOutputPolicy::Discard,
        }
    );
}

#[test]
fn command_start_wire_layout_places_label_before_output_policies() {
    let payload = encode_command_start(
        5000,
        "cmd",
        &[],
        false,
        "abc",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Capture { limit_bytes: 7 },
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
            COMMAND_OUTPUT_POLICY_DISCARD,
            COMMAND_OUTPUT_POLICY_CAPTURE,
            0,
            0,
            0,
            7,
        ]
    );
}

#[test]
fn command_start_roundtrip_env_sudo_label_and_capture() {
    let payload = encode_command_start(
        3000,
        "printenv",
        &[("PATH", "/usr/bin"), ("HOME", "/home/user")],
        true,
        "setup",
        CommandOutputPolicy::Capture { limit_bytes: 0 },
        CommandOutputPolicy::Capture { limit_bytes: 4096 },
    )
    .unwrap();

    let decoded = decode_command_start(&payload).unwrap();
    assert_eq!(decoded.timeout_ms, 3000);
    assert_eq!(decoded.command, "printenv");
    assert_eq!(
        decoded.env,
        vec![("PATH", "/usr/bin"), ("HOME", "/home/user")]
    );
    assert!(decoded.sudo);
    assert_eq!(
        decoded.stdout,
        CommandOutputPolicy::Capture { limit_bytes: 0 }
    );
    assert_eq!(
        decoded.stderr,
        CommandOutputPolicy::Capture { limit_bytes: 4096 }
    );
    assert_eq!(decoded.label, "setup");
}

#[test]
fn command_start_roundtrip_stream_policy_allows_zero_stream_limit() {
    let payload = encode_command_start(
        1000,
        "tail -f /tmp/log",
        &[],
        false,
        "stream",
        CommandOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 8192,
        },
        CommandOutputPolicy::Discard,
    )
    .unwrap();

    let decoded = decode_command_start(&payload).unwrap();
    assert_eq!(
        decoded.stdout,
        CommandOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 8192,
        }
    );
    assert_eq!(decoded.stderr, CommandOutputPolicy::Discard);
}

#[test]
fn command_start_roundtrip_capture_and_stream_policy() {
    let payload = encode_command_start(
        1000,
        "run",
        &[],
        false,
        "combined",
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1024,
            stream_limit_bytes: 2048,
            chunk_limit_bytes: 512,
        },
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 0,
            stream_limit_bytes: 0,
            chunk_limit_bytes: 1,
        },
    )
    .unwrap();

    let decoded = decode_command_start(&payload).unwrap();
    assert_eq!(
        decoded.stdout,
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1024,
            stream_limit_bytes: 2048,
            chunk_limit_bytes: 512,
        }
    );
    assert_eq!(
        decoded.stderr,
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 0,
            stream_limit_bytes: 0,
            chunk_limit_bytes: 1,
        }
    );
}

#[test]
fn command_output_roundtrip_stdout() {
    let payload = encode_command_output(CommandOutputStream::Stdout, 7, b"hello", false).unwrap();
    let decoded = decode_command_output(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedCommandOutput {
            stream: CommandOutputStream::Stdout,
            output_seq: 7,
            chunk: b"hello",
            truncated: false,
        }
    );
}

#[test]
fn command_output_roundtrip_stderr_truncated() {
    let payload = encode_command_output(CommandOutputStream::Stderr, 8, b"warn", true).unwrap();
    let decoded = decode_command_output(&payload).unwrap();
    assert_eq!(decoded.stream, CommandOutputStream::Stderr);
    assert_eq!(decoded.output_seq, 8);
    assert_eq!(decoded.chunk, b"warn");
    assert!(decoded.truncated);
}

#[test]
fn command_result_roundtrip_exited_with_captured_outputs() {
    let payload = encode_command_result(
        CommandTermination::Exited { exit_code: -9 },
        1234,
        CommandCapturedOutput::Captured {
            bytes: b"stdout",
            truncated: false,
        },
        CommandCapturedOutput::Captured {
            bytes: b"stderr",
            truncated: true,
        },
        "",
    )
    .unwrap();

    let decoded = decode_command_result(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedCommandResult {
            termination: CommandTermination::Exited { exit_code: -9 },
            duration_ms: 1234,
            stdout: CommandCapturedOutput::Captured {
                bytes: b"stdout",
                truncated: false,
            },
            stderr: CommandCapturedOutput::Captured {
                bytes: b"stderr",
                truncated: true,
            },
            diagnostic: "",
        }
    );
}

#[test]
fn command_result_roundtrip_timed_out_with_diagnostic() {
    let payload = encode_command_result(
        CommandTermination::TimedOut,
        300_000,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Discarded,
        "timed out",
    )
    .unwrap();

    let decoded = decode_command_result(&payload).unwrap();
    assert_eq!(decoded.termination, CommandTermination::TimedOut);
    assert_eq!(decoded.duration_ms, 300_000);
    assert_eq!(decoded.stdout, CommandCapturedOutput::Discarded);
    assert_eq!(decoded.stderr, CommandCapturedOutput::Discarded);
    assert_eq!(decoded.diagnostic, "timed out");
}

#[test]
fn command_result_roundtrip_non_exit_terminal_states() {
    for termination in [
        CommandTermination::Cancelled,
        CommandTermination::StartFailed,
        CommandTermination::WaitFailed,
    ] {
        let payload = encode_command_result(
            termination,
            42,
            CommandCapturedOutput::Discarded,
            CommandCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            },
            "done",
        )
        .unwrap();

        let decoded = decode_command_result(&payload).unwrap();
        assert_eq!(decoded.termination, termination);
        assert_eq!(decoded.duration_ms, 42);
        assert_eq!(
            decoded.stderr,
            CommandCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            }
        );
        assert_eq!(decoded.diagnostic, "done");
    }
}

#[test]
fn command_cancel_roundtrip_empty_payload() {
    let payload = encode_command_cancel();
    assert!(payload.is_empty());
    decode_command_cancel(&payload).unwrap();
}

#[test]
fn command_start_rejects_unknown_flags() {
    let mut payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    payload[4] = 0x80;

    let err = decode_command_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("command start unknown flags")
    ));
}

#[test]
fn command_start_rejects_invalid_utf8_fields() {
    let mut payload = encode_command_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    payload[9] = 0xFF;
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in command"))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let key_offset = 4 + 1 + 4 + "cmd".len() + 4 + 4;
    payload[key_offset] = 0xFF;
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env key"))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let val_offset = key_offset + "K".len() + 4;
    payload[val_offset] = 0xFF;
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env value"))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let label_offset = 4 + 1 + 4 + "cmd".len() + 4 + 4 + "K".len() + 4 + "V".len() + 2;
    payload[label_offset] = 0xFF;
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in label"))
    ));
}

#[test]
fn command_start_rejects_trailing_bytes() {
    let mut payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    payload.push(0);

    let err = decode_command_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("command start trailing bytes")
    ));
}

#[test]
fn command_start_rejects_malformed_env_count_without_preallocating() {
    let mut payload = encode_command_start(
        1,
        "",
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let env_count_offset = 4 + 1 + 4;
    payload[env_count_offset..env_count_offset + 4].copy_from_slice(&u32::MAX.to_be_bytes());

    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload(_))
    ));
}

#[test]
fn command_start_rejects_env_count_above_limit() {
    let env = vec![("K", "V"); MAX_COMMAND_ENV_VARS + 1];
    let err = encode_command_start(
        1,
        "cmd",
        &env,
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("env_count", size) if size == MAX_COMMAND_ENV_VARS + 1
    ));

    let mut payload = encode_command_start(
        1,
        "",
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let env_count_offset = 4 + 1 + 4;
    payload[env_count_offset..env_count_offset + 4]
        .copy_from_slice(&((MAX_COMMAND_ENV_VARS as u32) + 1).to_be_bytes());

    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "command start env_count too large"
        ))
    ));
}

#[test]
fn command_start_rejects_truncated_fields() {
    assert!(matches!(
        decode_command_start(&[]),
        Err(ProtocolError::InvalidPayload(
            "command start timeout truncated"
        ))
    ));
    assert!(matches!(
        decode_command_start(&[0; 4]),
        Err(ProtocolError::InvalidPayload(
            "command start flags truncated"
        ))
    ));
    assert!(matches!(
        decode_command_start(&[0; 8]),
        Err(ProtocolError::InvalidPayload(
            "command start command_len truncated"
        ))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    payload.truncate(10);
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "command start command truncated"
        ))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[("K", "V")],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let env_count_offset = 4 + 1 + 4 + "cmd".len();
    payload.truncate(env_count_offset + 3);
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "command start env_count truncated"
        ))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let label_len_offset = 4 + 1 + 4 + "cmd".len() + 4;
    payload.truncate(label_len_offset + 1);
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "command start label_len truncated"
        ))
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "ok",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let label_start = 4 + 1 + 4 + "cmd".len() + 4 + 2;
    payload.truncate(label_start + 1);
    assert!(matches!(
        decode_command_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "command start label truncated"
        ))
    ));
}

#[test]
fn command_start_rejects_invalid_policy_tag() {
    let mut payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let stdout_policy_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2;
    payload[stdout_policy_offset] = 0x99;

    let err = decode_command_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("invalid command output policy tag")
    ));
}

#[test]
fn command_start_rejects_zero_stream_chunk_limit() {
    let err = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 0,
        },
        CommandOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("command output chunk limit must be non-zero")
    ));

    let mut payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2 + 1 + 4;
    payload[chunk_limit_offset..chunk_limit_offset + 4].copy_from_slice(&0u32.to_be_bytes());

    let err = decode_command_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("command output chunk limit must be non-zero")
    ));
}

#[test]
fn command_start_rejects_truncated_policy_fields() {
    let mut stream_payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let stream_chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2 + 1 + 4;
    stream_payload.truncate(stream_chunk_limit_offset + 3);
    assert!(matches!(
        decode_command_start(&stream_payload),
        Err(ProtocolError::InvalidPayload(
            "command stream policy chunk limit truncated"
        ))
    ));

    let mut capture_and_stream_payload = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        "",
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1,
            stream_limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        CommandOutputPolicy::Discard,
    )
    .unwrap();
    let capture_and_stream_chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 2 + 1 + 4 + 4;
    capture_and_stream_payload.truncate(capture_and_stream_chunk_limit_offset + 3);
    assert!(matches!(
        decode_command_start(&capture_and_stream_payload),
        Err(ProtocolError::InvalidPayload(
            "command capture-and-stream chunk limit truncated"
        ))
    ));
}

#[test]
fn command_output_rejects_invalid_stream_flags_and_trailing_bytes() {
    let payload = encode_command_output(CommandOutputStream::Stdout, 1, b"chunk", false).unwrap();

    let mut invalid_stream = payload.clone();
    invalid_stream[0] = 0x99;
    assert!(matches!(
        decode_command_output(&invalid_stream),
        Err(ProtocolError::InvalidPayload(
            "invalid command output stream"
        ))
    ));

    let mut unknown_flags = payload.clone();
    unknown_flags[5] = 0x80;
    assert!(matches!(
        decode_command_output(&unknown_flags),
        Err(ProtocolError::InvalidPayload(
            "command output unknown flags"
        ))
    ));

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_command_output(&trailing),
        Err(ProtocolError::InvalidPayload(
            "command output trailing bytes"
        ))
    ));
}

#[test]
fn command_output_rejects_truncated_fields() {
    assert!(matches!(
        decode_command_output(&[]),
        Err(ProtocolError::InvalidPayload(
            "command output stream truncated"
        ))
    ));
    assert!(matches!(
        decode_command_output(&[0]),
        Err(ProtocolError::InvalidPayload(
            "command output seq truncated"
        ))
    ));

    let mut payload =
        encode_command_output(CommandOutputStream::Stdout, 1, b"chunk", false).unwrap();
    payload.truncate(6);
    assert!(matches!(
        decode_command_output(&payload),
        Err(ProtocolError::InvalidPayload(
            "command output chunk_len truncated"
        ))
    ));

    let mut payload =
        encode_command_output(CommandOutputStream::Stdout, 1, b"chunk", false).unwrap();
    payload.truncate(payload.len() - 1);
    assert!(matches!(
        decode_command_output(&payload),
        Err(ProtocolError::InvalidPayload(
            "command output chunk truncated"
        ))
    ));
}

#[test]
fn command_result_rejects_invalid_tags_flags_and_trailing_bytes() {
    let payload = encode_command_result(
        CommandTermination::Cancelled,
        1,
        CommandCapturedOutput::Captured {
            bytes: b"out",
            truncated: false,
        },
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap();

    let mut invalid_termination = payload.clone();
    invalid_termination[0] = 0x99;
    assert!(matches!(
        decode_command_result(&invalid_termination),
        Err(ProtocolError::InvalidPayload(
            "invalid command termination tag"
        ))
    ));

    let mut invalid_captured_tag = payload.clone();
    invalid_captured_tag[1 + 4] = 0x99;
    assert!(matches!(
        decode_command_result(&invalid_captured_tag),
        Err(ProtocolError::InvalidPayload(
            "invalid command captured output tag"
        ))
    ));

    let mut unknown_captured_flags = payload.clone();
    unknown_captured_flags[1 + 4 + 1] = 0x80;
    assert!(matches!(
        decode_command_result(&unknown_captured_flags),
        Err(ProtocolError::InvalidPayload(
            "command captured output unknown flags"
        ))
    ));

    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_command_result(&trailing),
        Err(ProtocolError::InvalidPayload(
            "command result trailing bytes"
        ))
    ));
}

#[test]
fn command_result_rejects_truncated_fields() {
    assert!(matches!(
        decode_command_result(&[]),
        Err(ProtocolError::InvalidPayload(
            "command result termination truncated"
        ))
    ));
    assert!(matches!(
        decode_command_result(&[COMMAND_TERMINATION_CANCELLED]),
        Err(ProtocolError::InvalidPayload(
            "command result duration truncated"
        ))
    ));

    let mut payload = encode_command_result(
        CommandTermination::Exited { exit_code: 1 },
        1,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    payload.truncate(4);
    assert!(matches!(
        decode_command_result(&payload),
        Err(ProtocolError::InvalidPayload(
            "command result exit_code truncated"
        ))
    ));

    let mut payload = encode_command_result(
        CommandTermination::Cancelled,
        1,
        CommandCapturedOutput::Captured {
            bytes: b"out",
            truncated: false,
        },
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    payload.truncate(1 + 4 + 1 + 1 + 4 + 2);
    assert!(matches!(
        decode_command_result(&payload),
        Err(ProtocolError::InvalidPayload(
            "command captured output bytes truncated"
        ))
    ));

    let mut payload = encode_command_result(
        CommandTermination::Cancelled,
        1,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Discarded,
        "diag",
    )
    .unwrap();
    payload.truncate(payload.len() - 1);
    assert!(matches!(
        decode_command_result(&payload),
        Err(ProtocolError::InvalidPayload(
            "command result diagnostic truncated"
        ))
    ));
}

#[test]
fn command_result_rejects_invalid_diagnostic_utf8() {
    let mut payload = encode_command_result(
        CommandTermination::Cancelled,
        1,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Discarded,
        "x",
    )
    .unwrap();
    let diagnostic_offset = payload.len() - 1;
    payload[diagnostic_offset] = 0xFF;

    assert!(matches!(
        decode_command_result(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in diagnostic"))
    ));
}

#[test]
fn command_cancel_rejects_non_empty_payload() {
    let err = decode_command_cancel(&[0]).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("command cancel payload must be empty")
    ));
}

#[test]
fn command_encoders_reject_oversized_payloads() {
    let command = "x".repeat(MAX_PAYLOAD_SIZE);
    let err = encode_command_start(
        1,
        &command,
        &[],
        false,
        "",
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));

    let chunk = vec![0u8; MAX_PAYLOAD_SIZE - 9];
    let err = encode_command_output(CommandOutputStream::Stdout, 1, &chunk, false).unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));

    let stdout = vec![0u8; MAX_PAYLOAD_SIZE - 13];
    let err = encode_command_result(
        CommandTermination::Cancelled,
        1,
        CommandCapturedOutput::Captured {
            bytes: &stdout,
            truncated: false,
        },
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
}

#[test]
fn command_start_rejects_too_long_label_and_result_diagnostic() {
    let label = "x".repeat(u16::MAX as usize + 1);
    let err = encode_command_start(
        1,
        "cmd",
        &[],
        false,
        &label,
        CommandOutputPolicy::Discard,
        CommandOutputPolicy::Discard,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("label", size) if size == label.len()
    ));

    let diagnostic = "x".repeat(u16::MAX as usize + 1);
    let err = encode_command_result(
        CommandTermination::Cancelled,
        1,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Discarded,
        &diagnostic,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("diagnostic", size) if size == diagnostic.len()
    ));
}
