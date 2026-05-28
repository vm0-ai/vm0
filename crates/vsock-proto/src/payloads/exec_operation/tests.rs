use super::*;
use crate::payloads::exec_control::EXEC_CONTROL_MAX_PAYLOAD_BYTES;
use crate::wire::MAX_PAYLOAD_SIZE;

const ONE_SHOT_DURATION_START_HEADER_LEN: usize = 1 + 1 + 4 + 1;
const NONCE: ExecControlNonce = *b"0123456789abcdef";

fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
    assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
}

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
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
            command: "echo ready",
            env: Vec::new(),
            sudo: false,
            label: "",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: Vec::new(),
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
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

    let label_len_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4;
    assert_eq!(
        &payload[label_len_offset..payload.len() - 2],
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
    assert_eq!(decoded.lifecycle, ExecLifecyclePolicy::OneShot);
    assert_eq!(
        decoded.timeout,
        ExecTimeoutPolicy::Duration { timeout_ms: 3000 }
    );
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
    assert_eq!(decoded.control, ExecControlPolicy::Disabled);
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
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1000 },
        command: "optional-file",
        env: &[],
        sudo: false,
        label: "read-file",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[66, -9],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.label, "read-file");
    assert_eq!(decoded.expected_exit_codes, vec![66, -9]);
}

#[test]
fn exec_start_roundtrip_stdin_bytes() {
    let payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1000 },
        command: "cat",
        env: &[],
        sudo: false,
        label: "stdin",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(b"payload\n"),
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.stdin_bytes, Some(&b"payload\n"[..]));
}

#[test]
fn exec_start_roundtrip_empty_stdin_bytes() {
    let payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1000 },
        command: "cat",
        env: &[],
        sudo: false,
        label: "stdin",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(&[]),
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.stdin_bytes, Some(&[][..]));
}

#[test]
fn exec_start_roundtrip_max_stdin_bytes() {
    let stdin_bytes = vec![0xA5; MAX_EXEC_STDIN_BYTES];
    let payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1000 },
        command: "cat",
        env: &[],
        sudo: false,
        label: "stdin",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(&stdin_bytes),
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.stdin_bytes, Some(stdin_bytes.as_slice()));
}

#[test]
fn exec_start_roundtrip_supervised_no_timeout_and_control_enabled() {
    let payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::Supervised,
        timeout: ExecTimeoutPolicy::None,
        command: "daemon",
        env: &[("A", "B")],
        sudo: true,
        label: "supervised",
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 128,
        },
        stderr: ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 256,
            stream_limit_bytes: 512,
            chunk_limit_bytes: 64,
        },
        expected_exit_codes: &[0],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: true,
        },
        stdin_bytes: None,
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(decoded.lifecycle, ExecLifecyclePolicy::Supervised);
    assert_eq!(decoded.timeout, ExecTimeoutPolicy::None);
    assert!(decoded.sudo);
    assert_eq!(
        decoded.control,
        ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: true,
        }
    );
}

#[test]
fn exec_start_rejects_zero_duration_timeout() {
    let err = encode_exec_start(
        0,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap_err();
    assert_invalid_payload(err, "exec start timeout duration must be positive");

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
    payload[2..6].copy_from_slice(&0u32.to_be_bytes());

    let err = decode_exec_start(&payload).unwrap_err();
    assert_invalid_payload(err, "exec start timeout duration must be positive");
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
    payload[ONE_SHOT_DURATION_START_HEADER_LEN - 1] = 0x80;

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
    payload[ONE_SHOT_DURATION_START_HEADER_LEN + 4] = 0xFF;
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
    let key_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 4;
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
    let label_offset = ONE_SHOT_DURATION_START_HEADER_LEN
        + 4
        + "cmd".len()
        + 4
        + 4
        + "K".len()
        + 4
        + "V".len()
        + 2;
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
    let env_count_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4;
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
    let env_count_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4;
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
            "exec start lifecycle truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_start(&[EXEC_LIFECYCLE_ONE_SHOT]),
        Err(ProtocolError::InvalidPayload(
            "exec start timeout policy truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_start(&[EXEC_LIFECYCLE_ONE_SHOT, EXEC_TIMEOUT_DURATION, 0, 0, 0]),
        Err(ProtocolError::InvalidPayload(
            "exec start timeout truncated"
        ))
    ));
    assert!(matches!(
        decode_exec_start(&[EXEC_LIFECYCLE_ONE_SHOT, EXEC_TIMEOUT_DURATION, 0, 0, 0, 1,]),
        Err(ProtocolError::InvalidPayload("exec start flags truncated"))
    ));
    assert!(matches!(
        decode_exec_start(&[
            EXEC_LIFECYCLE_ONE_SHOT,
            EXEC_TIMEOUT_DURATION,
            0,
            0,
            0,
            1,
            0,
        ]),
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
    payload.truncate(ONE_SHOT_DURATION_START_HEADER_LEN + 4 + 2);
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
    let env_count_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len();
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
    let label_len_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4;
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
    let label_start = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 2;
    payload.truncate(label_start + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("exec start label truncated"))
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
    payload.truncate(payload.len() - 2);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control policy truncated"
        ))
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
    let stdout_policy_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 2;
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
    let chunk_limit_offset = ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 2 + 1 + 4;
    payload[chunk_limit_offset..chunk_limit_offset + 4].copy_from_slice(&0u32.to_be_bytes());

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec output chunk limit must be non-zero")
    ));
}

#[test]
fn exec_start_rejects_zero_capture_and_stream_chunk_limit() {
    let err = encode_exec_start(
        1,
        "cmd",
        &[],
        false,
        "",
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1,
            stream_limit_bytes: 1,
            chunk_limit_bytes: 0,
        },
        ExecOutputPolicy::Discard,
    )
    .unwrap_err();
    assert_invalid_payload(err, "exec output chunk limit must be non-zero");

    let mut payload = encode_exec_start(
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
    let chunk_limit_offset =
        ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 2 + 1 + 4 + 4;
    payload[chunk_limit_offset..chunk_limit_offset + 4].copy_from_slice(&0u32.to_be_bytes());

    let err = decode_exec_start(&payload).unwrap_err();
    assert_invalid_payload(err, "exec output chunk limit must be non-zero");
}

#[test]
fn exec_start_rejects_expected_exit_count_above_limit() {
    let expected_exit_codes = vec![0; MAX_EXEC_EXPECTED_EXIT_CODES + 1];
    let err = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &expected_exit_codes,
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
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
    let count_offset = payload.len() - 2 - 2;
    payload[count_offset..count_offset + 2]
        .copy_from_slice(&((MAX_EXEC_EXPECTED_EXIT_CODES as u16) + 1).to_be_bytes());
    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start expected_exit_count too large")
    ));
}

#[test]
fn exec_start_rejects_truncated_expected_exit_count() {
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
    payload.truncate(payload.len() - 3);

    let err = decode_exec_start(&payload).unwrap_err();
    assert_invalid_payload(err, "exec start expected_exit_count truncated");
}

#[test]
fn exec_start_rejects_truncated_expected_exit_codes() {
    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[66],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    })
    .unwrap();
    payload.truncate(payload.len() - 3);

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
    let stream_chunk_limit_offset =
        ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 2 + 1 + 4;
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
    let capture_and_stream_chunk_limit_offset =
        ONE_SHOT_DURATION_START_HEADER_LEN + 4 + "cmd".len() + 4 + 2 + 1 + 4 + 4;
    capture_and_stream_payload.truncate(capture_and_stream_chunk_limit_offset + 3);
    assert!(matches!(
        decode_exec_start(&capture_and_stream_payload),
        Err(ProtocolError::InvalidPayload(
            "exec capture-and-stream chunk limit truncated"
        ))
    ));
}

#[test]
fn exec_start_rejects_invalid_lifecycle_timeout_and_control() {
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
    payload[0] = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start lifecycle invalid"
        ))
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
    payload[1] = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start timeout policy invalid"
        ))
    ));

    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::Supervised,
        timeout: ExecTimeoutPolicy::None,
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: false,
        },
        stdin_bytes: None,
    })
    .unwrap();
    let control_tag_offset = payload.len() - (1 + 1 + 1 + EXEC_CONTROL_NONCE_LEN);
    payload[control_tag_offset] = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control policy invalid"
        ))
    ));
}

#[test]
fn exec_start_rejects_control_unknown_flags_and_truncated_nonce() {
    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::Supervised,
        timeout: ExecTimeoutPolicy::None,
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: false,
        },
        stdin_bytes: None,
    })
    .unwrap();
    let control_tag_offset = payload.len() - (1 + 1 + 1 + EXEC_CONTROL_NONCE_LEN);
    payload.truncate(control_tag_offset + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control flags truncated"
        ))
    ));

    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::Supervised,
        timeout: ExecTimeoutPolicy::None,
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: false,
        },
        stdin_bytes: None,
    })
    .unwrap();
    let control_flags_offset = payload.len() - (1 + 1 + EXEC_CONTROL_NONCE_LEN);
    payload[control_flags_offset] = 0x80;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control unknown flags"
        ))
    ));

    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::Supervised,
        timeout: ExecTimeoutPolicy::None,
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: false,
        },
        stdin_bytes: None,
    })
    .unwrap();
    payload.truncate(payload.len() - 2);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control nonce truncated"
        ))
    ));
}

#[test]
fn exec_start_rejects_invalid_or_truncated_stdin_policy() {
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
    *payload.last_mut().unwrap() = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start stdin policy invalid"
        ))
    ));

    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(b"x"),
    })
    .unwrap();
    let stdin_tag_offset = payload.len() - (1 + 4 + 1);
    payload.truncate(stdin_tag_offset + 2);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start stdin_len truncated"
        ))
    ));

    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(b"x"),
    })
    .unwrap();
    payload.pop();
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("exec start stdin truncated"))
    ));
}

#[test]
fn exec_start_rejects_stdin_above_limit() {
    let stdin_bytes = vec![0; MAX_EXEC_STDIN_BYTES + 1];
    let err = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(&stdin_bytes),
    })
    .unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("stdin_bytes", _)
    ));

    let mut payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        sudo: false,
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(b"x"),
    })
    .unwrap();
    let stdin_len_offset = payload.len() - (4 + 1);
    payload[stdin_len_offset..stdin_len_offset + 4]
        .copy_from_slice(&((MAX_EXEC_STDIN_BYTES as u32) + 1).to_be_bytes());
    let err = decode_exec_start(&payload).unwrap_err();
    assert_invalid_payload(err, "exec start stdin too large");
}

#[test]
fn exec_started_roundtrip_and_rejects_malformed_payloads() {
    let payload = encode_exec_started(42).unwrap();
    assert_eq!(decode_exec_started(&payload).unwrap().pid, 42);

    assert!(matches!(
        encode_exec_started(0),
        Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero"
        ))
    ));
    assert!(matches!(
        decode_exec_started(&[0, 0, 0]),
        Err(ProtocolError::InvalidPayload("exec started pid truncated"))
    ));
    assert!(matches!(
        decode_exec_started(&[0, 0, 0, 0]),
        Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero"
        ))
    ));
    let mut trailing = payload;
    trailing.push(0);
    assert!(matches!(
        decode_exec_started(&trailing),
        Err(ProtocolError::InvalidPayload("exec started trailing bytes"))
    ));
}

#[test]
fn exec_control_roundtrip_and_rejects_malformed_payloads() {
    let payload = encode_exec_control(7, NONCE, "message", b"body", 5000).unwrap();
    let decoded = decode_exec_control(&payload).unwrap();
    assert_eq!(decoded.target_seq, 7);
    assert_eq!(decoded.request_timeout_ms, 5000);
    assert_eq!(decoded.control_nonce, NONCE);
    assert_eq!(decoded.message_id, "message");
    assert_eq!(decoded.payload, b"body");

    let empty_payload = encode_exec_control(7, NONCE, "message", b"", 5000).unwrap();
    assert_eq!(decode_exec_control(&empty_payload).unwrap().payload, b"");

    let max_payload = vec![0xAB; EXEC_CONTROL_MAX_PAYLOAD_BYTES];
    let max_payload_message = encode_exec_control(7, NONCE, "message", &max_payload, 5000).unwrap();
    assert_eq!(
        decode_exec_control(&max_payload_message).unwrap().payload,
        max_payload
    );

    let err = encode_exec_control(0, NONCE, "message", b"body", 5000).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec_control target_seq must be non-zero")
    ));

    let mut zero_target_seq = payload.clone();
    zero_target_seq[..4].copy_from_slice(&0u32.to_be_bytes());
    assert!(matches!(
        decode_exec_control(&zero_target_seq),
        Err(ProtocolError::InvalidPayload(
            "exec_control target_seq must be non-zero"
        ))
    ));

    let err = encode_exec_control(7, NONCE, "", b"body", 5000).unwrap_err();
    assert_invalid_payload(err, "exec_control message_id empty");

    let too_large = vec![0; EXEC_CONTROL_MAX_PAYLOAD_BYTES + 1];
    let err = encode_exec_control(7, NONCE, "message", &too_large, 5000).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::PayloadTooLarge("payload", size) if size == too_large.len()
    ));

    let mut empty_message_id = encode_exec_control(7, NONCE, "message", b"body", 5000).unwrap();
    let message_id_len_offset = 4 + 4 + EXEC_CONTROL_NONCE_LEN;
    empty_message_id[message_id_len_offset..message_id_len_offset + 2]
        .copy_from_slice(&0u16.to_be_bytes());
    assert_invalid_payload(
        decode_exec_control(&empty_message_id).unwrap_err(),
        "exec_control message_id empty",
    );

    let mut invalid_message_id = encode_exec_control(7, NONCE, "message", b"body", 5000).unwrap();
    let message_id_offset = 4 + 4 + EXEC_CONTROL_NONCE_LEN + 2;
    invalid_message_id[message_id_offset] = 0xFF;
    assert_invalid_payload(
        decode_exec_control(&invalid_message_id).unwrap_err(),
        "invalid UTF-8 in exec_control message_id",
    );

    let mut oversized_payload_len =
        encode_exec_control(7, NONCE, "message", b"body", 5000).unwrap();
    let payload_len_offset = 4 + 4 + EXEC_CONTROL_NONCE_LEN + 2 + "message".len();
    oversized_payload_len[payload_len_offset..payload_len_offset + 4]
        .copy_from_slice(&((EXEC_CONTROL_MAX_PAYLOAD_BYTES as u32) + 1).to_be_bytes());
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
fn exec_control_rejects_truncated_fields() {
    let payload = encode_exec_control(7, NONCE, "message", b"body", 5000).unwrap();
    let request_timeout_offset = 4;
    let nonce_offset = request_timeout_offset + 4;
    let message_id_len_offset = nonce_offset + EXEC_CONTROL_NONCE_LEN;
    let message_id_offset = message_id_len_offset + 2;
    let payload_len_offset = message_id_offset + "message".len();
    let payload_offset = payload_len_offset + 4;

    assert_invalid_payload(
        decode_exec_control(&payload[..3]).unwrap_err(),
        "exec_control target_seq truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..request_timeout_offset + 3]).unwrap_err(),
        "exec_control request_timeout_ms truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..nonce_offset + EXEC_CONTROL_NONCE_LEN - 1]).unwrap_err(),
        "exec_control nonce truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..message_id_len_offset + 1]).unwrap_err(),
        "exec_control message_id_len truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..message_id_offset + 2]).unwrap_err(),
        "exec_control message_id truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..payload_len_offset + 3]).unwrap_err(),
        "exec_control payload_len truncated",
    );
    assert_invalid_payload(
        decode_exec_control(&payload[..payload_offset + 2]).unwrap_err(),
        "exec_control payload truncated",
    );
}

#[test]
fn exec_control_result_roundtrip_and_rejects_malformed_payloads() {
    let payload =
        encode_exec_control_result(7, NONCE, "message", ExecControlStatus::Delivered, "ok")
            .unwrap();
    let decoded = decode_exec_control_result(&payload).unwrap();
    assert_eq!(decoded.target_seq, 7);
    assert_eq!(decoded.control_nonce, NONCE);
    assert_eq!(decoded.message_id, "message");
    assert_eq!(decoded.status, ExecControlStatus::Delivered);
    assert_eq!(decoded.diagnostic, "ok");

    let empty_diagnostic =
        encode_exec_control_result(7, NONCE, "message", ExecControlStatus::Delivered, "").unwrap();
    assert_eq!(
        decode_exec_control_result(&empty_diagnostic)
            .unwrap()
            .diagnostic,
        ""
    );

    let err = encode_exec_control_result(0, NONCE, "message", ExecControlStatus::Delivered, "")
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

    let mut empty_message_id =
        encode_exec_control_result(7, NONCE, "message", ExecControlStatus::Delivered, "ok")
            .unwrap();
    let message_id_len_offset = 4 + EXEC_CONTROL_NONCE_LEN;
    empty_message_id[message_id_len_offset..message_id_len_offset + 2]
        .copy_from_slice(&0u16.to_be_bytes());
    assert_invalid_payload(
        decode_exec_control_result(&empty_message_id).unwrap_err(),
        "exec_control_result message_id empty",
    );

    let mut invalid_message_id =
        encode_exec_control_result(7, NONCE, "message", ExecControlStatus::Delivered, "ok")
            .unwrap();
    let message_id_offset = 4 + EXEC_CONTROL_NONCE_LEN + 2;
    invalid_message_id[message_id_offset] = 0xFF;
    assert_invalid_payload(
        decode_exec_control_result(&invalid_message_id).unwrap_err(),
        "invalid UTF-8 in exec_control_result message_id",
    );

    let mut unknown_status = payload.clone();
    let status_offset = 4 + EXEC_CONTROL_NONCE_LEN + 2 + "message".len();
    unknown_status[status_offset] = 0xFE;
    assert!(matches!(
        decode_exec_control_result(&unknown_status),
        Err(ProtocolError::InvalidPayload(
            "exec_control_result status invalid"
        ))
    ));

    let mut invalid_diagnostic = payload.clone();
    let diagnostic_offset = status_offset + 1 + 2;
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
    let status_offset = 4 + EXEC_CONTROL_NONCE_LEN + 2 + "message".len();

    for &(status, expected_wire) in cases {
        let payload = encode_exec_control_result(7, NONCE, "message", status, "ok").unwrap();

        assert_eq!(payload[status_offset], expected_wire);
        assert_eq!(decode_exec_control_result(&payload).unwrap().status, status);
    }
}

#[test]
fn exec_control_result_rejects_truncated_fields() {
    let payload =
        encode_exec_control_result(7, NONCE, "message", ExecControlStatus::Delivered, "ok")
            .unwrap();
    let message_id_len_offset = 4 + EXEC_CONTROL_NONCE_LEN;
    let message_id_offset = message_id_len_offset + 2;
    let status_offset = message_id_offset + "message".len();
    let diagnostic_len_offset = status_offset + 1;
    let diagnostic_offset = diagnostic_len_offset + 2;

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
