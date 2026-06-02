use super::super::*;
use super::{NONCE, assert_invalid_payload};

const ONE_SHOT_DURATION_START_HEADER_LEN: usize = 1 + 1 + 4 + 1;

fn exec_start_payload(command: &str, env: &[(&str, &str)], label: &str) -> Vec<u8> {
    encode_exec_start(
        1,
        command,
        env,
        false,
        label,
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap()
}

fn default_exec_start_payload() -> Vec<u8> {
    exec_start_payload("cmd", &[], "")
}

fn env_label_exec_start_payload() -> Vec<u8> {
    exec_start_payload("cmd", &[("K", "V")], "ok")
}

fn command_byte_offset() -> usize {
    ONE_SHOT_DURATION_START_HEADER_LEN + 4
}

fn flags_byte_offset() -> usize {
    ONE_SHOT_DURATION_START_HEADER_LEN - 1
}

fn env_count_field_offset(command: &str) -> usize {
    command_byte_offset() + command.len()
}

fn env_key_byte_offset(command: &str) -> usize {
    env_count_field_offset(command) + 4 + 4
}

fn env_value_byte_offset(command: &str, key: &str) -> usize {
    env_key_byte_offset(command) + key.len() + 4
}

fn label_len_field_offset(command: &str, env: &[(&str, &str)]) -> usize {
    let env_bytes = env
        .iter()
        .map(|(key, value)| 4 + key.len() + 4 + value.len())
        .sum::<usize>();
    env_count_field_offset(command) + 4 + env_bytes
}

fn label_byte_offset(command: &str, env: &[(&str, &str)]) -> usize {
    label_len_field_offset(command, env) + 2
}

fn stdout_policy_tag_offset(command: &str, env: &[(&str, &str)], label: &str) -> usize {
    label_byte_offset(command, env) + label.len()
}

fn stream_chunk_limit_field_offset(command: &str, label: &str) -> usize {
    stdout_policy_tag_offset(command, &[], label) + 1 + 4
}

fn capture_and_stream_chunk_limit_field_offset(command: &str, label: &str) -> usize {
    stdout_policy_tag_offset(command, &[], label) + 1 + 4 + 4
}

fn supervised_control_exec_start_payload() -> Vec<u8> {
    encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
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
    .unwrap()
}

fn stdin_exec_start_payload(stdin_bytes: &[u8]) -> Vec<u8> {
    encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
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
        stdin_bytes: Some(stdin_bytes),
    })
    .unwrap()
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

    let label_len_offset = label_len_field_offset("cmd", &[]);
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

    let mut payload = default_exec_start_payload();
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
fn exec_start_rejects_unknown_flags() {
    let mut payload = default_exec_start_payload();
    payload[flags_byte_offset()] = 0x80;

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start unknown flags")
    ));
}
#[test]
fn exec_start_rejects_invalid_utf8_fields() {
    let mut payload = env_label_exec_start_payload();
    payload[command_byte_offset()] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in command"))
    ));

    let mut payload = env_label_exec_start_payload();
    let key_offset = env_key_byte_offset("cmd");
    payload[key_offset] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env key"))
    ));

    let mut payload = env_label_exec_start_payload();
    let val_offset = env_value_byte_offset("cmd", "K");
    payload[val_offset] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env value"))
    ));

    let mut payload = env_label_exec_start_payload();
    payload[label_byte_offset("cmd", &[("K", "V")])] = 0xFF;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in label"))
    ));
}
#[test]
fn exec_start_rejects_trailing_bytes() {
    let mut payload = default_exec_start_payload();
    payload.push(0);

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start trailing bytes")
    ));
}
#[test]
fn exec_start_rejects_malformed_env_count_without_preallocating() {
    let mut payload = exec_start_payload("", &[], "");
    let env_count_offset = env_count_field_offset("");
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

    let mut payload = exec_start_payload("", &[], "");
    let env_count_offset = env_count_field_offset("");
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

    let mut payload = env_label_exec_start_payload();
    payload.truncate(command_byte_offset() + 2);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start command truncated"
        ))
    ));

    let mut payload = env_label_exec_start_payload();
    let env_count_offset = env_count_field_offset("cmd");
    payload.truncate(env_count_offset + 3);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start env_count truncated"
        ))
    ));

    let mut payload = exec_start_payload("cmd", &[], "ok");
    let label_len_offset = label_len_field_offset("cmd", &[]);
    payload.truncate(label_len_offset + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start label_len truncated"
        ))
    ));

    let mut payload = exec_start_payload("cmd", &[], "ok");
    let label_start = label_byte_offset("cmd", &[]);
    payload.truncate(label_start + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("exec start label truncated"))
    ));

    let mut payload = exec_start_payload("cmd", &[], "ok");
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
    let mut payload = default_exec_start_payload();
    let stdout_policy_offset = stdout_policy_tag_offset("cmd", &[], "");
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
    let chunk_limit_offset = stream_chunk_limit_field_offset("cmd", "");
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
    let chunk_limit_offset = capture_and_stream_chunk_limit_field_offset("cmd", "");
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

    let mut payload = default_exec_start_payload();
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
    let mut payload = default_exec_start_payload();
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
    let stream_chunk_limit_offset = stream_chunk_limit_field_offset("cmd", "");
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
        capture_and_stream_chunk_limit_field_offset("cmd", "");
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
    let mut payload = default_exec_start_payload();
    payload[0] = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start lifecycle invalid"
        ))
    ));

    let mut payload = default_exec_start_payload();
    payload[1] = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start timeout policy invalid"
        ))
    ));

    let mut payload = supervised_control_exec_start_payload();
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
    let mut payload = supervised_control_exec_start_payload();
    let control_tag_offset = payload.len() - (1 + 1 + 1 + EXEC_CONTROL_NONCE_LEN);
    payload.truncate(control_tag_offset + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control flags truncated"
        ))
    ));

    let mut payload = supervised_control_exec_start_payload();
    let control_flags_offset = payload.len() - (1 + 1 + EXEC_CONTROL_NONCE_LEN);
    payload[control_flags_offset] = 0x80;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control unknown flags"
        ))
    ));

    let mut payload = supervised_control_exec_start_payload();
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
    let mut payload = default_exec_start_payload();
    *payload.last_mut().unwrap() = 0xFE;
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start stdin policy invalid"
        ))
    ));

    let mut payload = stdin_exec_start_payload(b"x");
    let stdin_tag_offset = payload.len() - (1 + 4 + 1);
    payload.truncate(stdin_tag_offset + 2);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start stdin_len truncated"
        ))
    ));

    let mut payload = stdin_exec_start_payload(b"x");
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

    let mut payload = stdin_exec_start_payload(b"x");
    let stdin_len_offset = payload.len() - (4 + 1);
    payload[stdin_len_offset..stdin_len_offset + 4]
        .copy_from_slice(&((MAX_EXEC_STDIN_BYTES as u32) + 1).to_be_bytes());
    let err = decode_exec_start(&payload).unwrap_err();
    assert_invalid_payload(err, "exec start stdin too large");
}
