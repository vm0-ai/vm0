use super::super::*;
use super::shared::{
    ExecStartLayout, ExecStartLayoutRequest, set_byte_at, write_u16_at, write_u32_at,
};
use super::{NONCE, assert_invalid_payload};

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

    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
        command: "cmd",
        env: &[],
        label: "abc",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Capture { limit_bytes: 7 },
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    });
    assert_eq!(
        &payload[layout.label_len_offset..layout.control.tag_offset],
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
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");
    write_u32_at(&mut payload, layout.timeout_value_offset.unwrap(), 0);

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
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");
    set_byte_at(&mut payload, layout.flags_offset, 0x80);

    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start unknown flags")
    ));
}
#[test]
fn exec_start_rejects_invalid_utf8_fields() {
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[("K", "V")], "ok");

    let mut payload = env_label_exec_start_payload();
    set_byte_at(&mut payload, layout.command_offset, 0xFF);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in command"))
    ));

    let mut payload = env_label_exec_start_payload();
    set_byte_at(&mut payload, layout.env[0].key_offset, 0xFF);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env key"))
    ));

    let mut payload = env_label_exec_start_payload();
    set_byte_at(&mut payload, layout.env[0].value_offset, 0xFF);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("invalid UTF-8 in env value"))
    ));

    let mut payload = env_label_exec_start_payload();
    set_byte_at(&mut payload, layout.label_offset, 0xFF);
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
    let layout = ExecStartLayout::one_shot_duration_discard("", &[], "");
    write_u32_at(&mut payload, layout.env_count_offset, u32::MAX);

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
    let layout = ExecStartLayout::one_shot_duration_discard("", &[], "");
    write_u32_at(
        &mut payload,
        layout.env_count_offset,
        (MAX_EXEC_ENV_VARS as u32) + 1,
    );

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
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[("K", "V")], "ok");
    payload.truncate(layout.command_offset + 2);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start command truncated"
        ))
    ));

    let mut payload = env_label_exec_start_payload();
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[("K", "V")], "ok");
    payload.truncate(layout.env_count_offset + 3);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start env_count truncated"
        ))
    ));

    let mut payload = exec_start_payload("cmd", &[], "ok");
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "ok");
    payload.truncate(layout.label_len_offset + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start label_len truncated"
        ))
    ));

    let mut payload = exec_start_payload("cmd", &[], "ok");
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "ok");
    payload.truncate(layout.label_offset + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload("exec start label truncated"))
    ));

    let mut payload = exec_start_payload("cmd", &[], "ok");
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "ok");
    payload.truncate(layout.control.tag_offset);
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
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");
    set_byte_at(&mut payload, layout.stdout_policy.tag_offset, 0x99);

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
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    });
    write_u32_at(
        &mut payload,
        layout.stdout_policy.chunk_limit_offset.unwrap(),
        0,
    );

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
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1,
            stream_limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    });
    write_u32_at(
        &mut payload,
        layout.stdout_policy.chunk_limit_offset.unwrap(),
        0,
    );

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
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");
    write_u16_at(
        &mut payload,
        layout.expected_exit_count_offset,
        (MAX_EXEC_EXPECTED_EXIT_CODES as u16) + 1,
    );
    let err = decode_exec_start(&payload).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::InvalidPayload("exec start expected_exit_count too large")
    ));
}
#[test]
fn exec_start_rejects_truncated_expected_exit_count() {
    let mut payload = default_exec_start_payload();
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");
    payload.truncate(layout.expected_exit_count_offset + 1);

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
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[66],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    });
    payload.truncate(layout.expected_exit_codes_offset + 3);

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
    let stream_layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    });
    stream_payload.truncate(stream_layout.stdout_policy.chunk_limit_offset.unwrap() + 3);
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
    let capture_and_stream_layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 1,
            stream_limit_bytes: 1,
            chunk_limit_bytes: 1,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    });
    capture_and_stream_payload.truncate(
        capture_and_stream_layout
            .stdout_policy
            .chunk_limit_offset
            .unwrap()
            + 3,
    );
    assert!(matches!(
        decode_exec_start(&capture_and_stream_payload),
        Err(ProtocolError::InvalidPayload(
            "exec capture-and-stream chunk limit truncated"
        ))
    ));
}
#[test]
fn exec_start_rejects_invalid_lifecycle_timeout_and_control() {
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");

    let mut payload = default_exec_start_payload();
    set_byte_at(&mut payload, layout.lifecycle_offset, 0xFE);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start lifecycle invalid"
        ))
    ));

    let mut payload = default_exec_start_payload();
    set_byte_at(&mut payload, layout.timeout_policy_offset, 0xFE);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start timeout policy invalid"
        ))
    ));

    let mut payload = supervised_control_exec_start_payload();
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::None,
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: false,
        },
        stdin_bytes: None,
    });
    set_byte_at(&mut payload, layout.control.tag_offset, 0xFE);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control policy invalid"
        ))
    ));
}
#[test]
fn exec_start_rejects_control_unknown_flags_and_truncated_nonce() {
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::None,
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Enabled {
            control_nonce: NONCE,
            sink: false,
        },
        stdin_bytes: None,
    });

    let mut payload = supervised_control_exec_start_payload();
    payload.truncate(layout.control.flags_offset.unwrap());
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control flags truncated"
        ))
    ));

    let mut payload = supervised_control_exec_start_payload();
    set_byte_at(&mut payload, layout.control.flags_offset.unwrap(), 0x80);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start control unknown flags"
        ))
    ));

    let mut payload = supervised_control_exec_start_payload();
    payload.truncate(layout.control.nonce_offset.unwrap() + EXEC_CONTROL_NONCE_LEN - 2);
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
    let layout = ExecStartLayout::one_shot_duration_discard("cmd", &[], "");
    set_byte_at(&mut payload, layout.stdin.tag_offset, 0xFE);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start stdin policy invalid"
        ))
    ));

    let mut payload = stdin_exec_start_payload(b"x");
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(b"x"),
    });
    payload.truncate(layout.stdin.len_offset.unwrap() + 1);
    assert!(matches!(
        decode_exec_start(&payload),
        Err(ProtocolError::InvalidPayload(
            "exec start stdin_len truncated"
        ))
    ));

    let mut payload = stdin_exec_start_payload(b"x");
    payload.truncate(layout.stdin.bytes_end_offset.unwrap() - 1);
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
    let layout = ExecStartLayout::new(ExecStartLayoutRequest {
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "cmd",
        env: &[],
        label: "",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: Some(b"x"),
    });
    write_u32_at(
        &mut payload,
        layout.stdin.len_offset.unwrap(),
        (MAX_EXEC_STDIN_BYTES as u32) + 1,
    );
    let err = decode_exec_start(&payload).unwrap_err();
    assert_invalid_payload(err, "exec start stdin too large");
}
