use super::super::*;
use super::NONCE;
use crate::wire::MAX_PAYLOAD_SIZE;

pub(super) fn set_byte_at(payload: &mut [u8], offset: usize, value: u8) {
    payload[offset] = value;
}

pub(super) fn write_u16_at(payload: &mut [u8], offset: usize, value: u16) {
    payload[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

pub(super) fn write_u32_at(payload: &mut [u8], offset: usize, value: u32) {
    payload[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

#[derive(Clone, Copy)]
pub(super) struct ExecCapturedOutputLayout {
    pub tag_offset: usize,
    pub flags_offset: Option<usize>,
    pub bytes_offset: Option<usize>,
    pub end_offset: usize,
}

impl ExecCapturedOutputLayout {
    fn new(start_offset: usize, output: ExecCapturedOutput<'_>) -> Self {
        match output {
            ExecCapturedOutput::Discarded => Self {
                tag_offset: start_offset,
                flags_offset: None,
                bytes_offset: None,
                end_offset: start_offset + 1,
            },
            ExecCapturedOutput::Captured { bytes, .. } => {
                let bytes_offset = start_offset + 1 + 1 + 4;

                Self {
                    tag_offset: start_offset,
                    flags_offset: Some(start_offset + 1),
                    bytes_offset: Some(bytes_offset),
                    end_offset: bytes_offset + bytes.len(),
                }
            }
        }
    }
}

pub(super) struct ExecResultLayout {
    pub termination_tag_offset: usize,
    pub exit_code_offset: Option<usize>,
    pub stdout: ExecCapturedOutputLayout,
    pub diagnostic_offset: usize,
    pub diagnostic_end_offset: usize,
}

impl ExecResultLayout {
    pub fn new(
        termination: ExecTermination,
        stdout: ExecCapturedOutput<'_>,
        stderr: ExecCapturedOutput<'_>,
        diagnostic: &str,
    ) -> Self {
        let mut offset = 0;
        let termination_tag_offset = offset;
        offset += 1;

        let exit_code_offset = match termination {
            ExecTermination::Exited { .. } => {
                let exit_code_offset = offset;
                offset += 4;
                Some(exit_code_offset)
            }
            ExecTermination::TimedOut
            | ExecTermination::Cancelled
            | ExecTermination::StartFailed
            | ExecTermination::WaitFailed => None,
        };

        offset += 4;

        let stdout = ExecCapturedOutputLayout::new(offset, stdout);
        offset = stdout.end_offset;

        let stderr = ExecCapturedOutputLayout::new(offset, stderr);
        offset = stderr.end_offset;

        offset += 2;

        let diagnostic_offset = offset;
        let diagnostic_end_offset = diagnostic_offset + diagnostic.len();

        Self {
            termination_tag_offset,
            exit_code_offset,
            stdout,
            diagnostic_offset,
            diagnostic_end_offset,
        }
    }
}

pub(super) struct ExecOutputLayout {
    pub stream_offset: usize,
    pub flags_offset: usize,
    pub chunk_len_offset: usize,
    pub chunk_end_offset: usize,
}

impl ExecOutputLayout {
    pub fn new(chunk: &[u8]) -> Self {
        let chunk_offset = 1 + 4 + 1 + 4;

        Self {
            stream_offset: 0,
            flags_offset: 1 + 4,
            chunk_len_offset: 1 + 4 + 1,
            chunk_end_offset: chunk_offset + chunk.len(),
        }
    }
}

pub(super) struct ExecControlLayout {
    pub target_seq_offset: usize,
    pub request_timeout_offset: usize,
    pub nonce_offset: usize,
    pub message_id_len_offset: usize,
    pub message_id_offset: usize,
    pub payload_len_offset: usize,
    pub payload_end_offset: usize,
}

impl ExecControlLayout {
    pub fn new(message_id: &str, payload: &[u8]) -> Self {
        let target_seq_offset = 0;
        let request_timeout_offset = target_seq_offset + 4;
        let nonce_offset = request_timeout_offset + 4;
        let message_id_len_offset = nonce_offset + EXEC_CONTROL_NONCE_LEN;
        let message_id_offset = message_id_len_offset + 2;
        let payload_len_offset = message_id_offset + message_id.len();
        let payload_offset = payload_len_offset + 4;

        Self {
            target_seq_offset,
            request_timeout_offset,
            nonce_offset,
            message_id_len_offset,
            message_id_offset,
            payload_len_offset,
            payload_end_offset: payload_offset + payload.len(),
        }
    }
}

pub(super) struct ExecControlResultLayout {
    pub target_seq_offset: usize,
    pub nonce_offset: usize,
    pub message_id_len_offset: usize,
    pub message_id_offset: usize,
    pub status_offset: usize,
    pub diagnostic_len_offset: usize,
    pub diagnostic_offset: usize,
    pub diagnostic_end_offset: usize,
}

impl ExecControlResultLayout {
    pub fn new(message_id: &str, diagnostic: &str) -> Self {
        let target_seq_offset = 0;
        let nonce_offset = target_seq_offset + 4;
        let message_id_len_offset = nonce_offset + EXEC_CONTROL_NONCE_LEN;
        let message_id_offset = message_id_len_offset + 2;
        let status_offset = message_id_offset + message_id.len();
        let diagnostic_len_offset = status_offset + 1;
        let diagnostic_offset = diagnostic_len_offset + 2;

        Self {
            target_seq_offset,
            nonce_offset,
            message_id_len_offset,
            message_id_offset,
            status_offset,
            diagnostic_len_offset,
            diagnostic_offset,
            diagnostic_end_offset: diagnostic_offset + diagnostic.len(),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct ExecOutputPolicyLayout {
    pub tag_offset: usize,
    pub chunk_limit_offset: Option<usize>,
    end_offset: usize,
}

impl ExecOutputPolicyLayout {
    fn new(start_offset: usize, policy: ExecOutputPolicy) -> Self {
        match policy {
            ExecOutputPolicy::Discard => Self {
                tag_offset: start_offset,
                chunk_limit_offset: None,
                end_offset: start_offset + 1,
            },
            ExecOutputPolicy::Capture { .. } => Self {
                tag_offset: start_offset,
                chunk_limit_offset: None,
                end_offset: start_offset + 1 + 4,
            },
            ExecOutputPolicy::Stream { .. } => Self {
                tag_offset: start_offset,
                chunk_limit_offset: Some(start_offset + 1 + 4),
                end_offset: start_offset + 1 + 4 + 4,
            },
            ExecOutputPolicy::CaptureAndStream { .. } => Self {
                tag_offset: start_offset,
                chunk_limit_offset: Some(start_offset + 1 + 4 + 4),
                end_offset: start_offset + 1 + 4 + 4 + 4,
            },
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct ExecStartEnvLayout {
    pub key_offset: usize,
    pub value_offset: usize,
}

#[derive(Clone, Copy)]
pub(super) struct ExecStartControlLayout {
    pub tag_offset: usize,
    pub flags_offset: Option<usize>,
    pub nonce_offset: Option<usize>,
    end_offset: usize,
}

impl ExecStartControlLayout {
    fn new(start_offset: usize, control: ExecControlPolicy) -> Self {
        match control {
            ExecControlPolicy::Disabled => Self {
                tag_offset: start_offset,
                flags_offset: None,
                nonce_offset: None,
                end_offset: start_offset + 1,
            },
            ExecControlPolicy::Enabled { .. } => Self {
                tag_offset: start_offset,
                flags_offset: Some(start_offset + 1),
                nonce_offset: Some(start_offset + 1 + 1),
                end_offset: start_offset + 1 + 1 + EXEC_CONTROL_NONCE_LEN,
            },
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct ExecStartStdinLayout {
    pub tag_offset: usize,
    pub len_offset: Option<usize>,
    pub bytes_end_offset: Option<usize>,
}

impl ExecStartStdinLayout {
    fn new(start_offset: usize, stdin_bytes: Option<&[u8]>) -> Self {
        match stdin_bytes {
            None => Self {
                tag_offset: start_offset,
                len_offset: None,
                bytes_end_offset: None,
            },
            Some(bytes) => {
                let bytes_offset = start_offset + 1 + 4;

                Self {
                    tag_offset: start_offset,
                    len_offset: Some(start_offset + 1),
                    bytes_end_offset: Some(bytes_offset + bytes.len()),
                }
            }
        }
    }
}

pub(super) struct ExecStartLayout {
    pub lifecycle_offset: usize,
    pub timeout_policy_offset: usize,
    pub timeout_value_offset: Option<usize>,
    pub flags_offset: usize,
    pub command_offset: usize,
    pub env_count_offset: usize,
    pub env: Vec<ExecStartEnvLayout>,
    pub label_len_offset: usize,
    pub label_offset: usize,
    pub stdout_policy: ExecOutputPolicyLayout,
    pub expected_exit_count_offset: usize,
    pub expected_exit_codes_offset: usize,
    pub control: ExecStartControlLayout,
    pub stdin: ExecStartStdinLayout,
}

impl ExecStartLayout {
    pub fn new(request: ExecStartLayoutRequest<'_>) -> Self {
        let mut offset = 0;

        let lifecycle_offset = offset;
        offset += 1;

        let timeout_policy_offset = offset;
        offset += 1;
        let timeout_value_offset = match request.timeout {
            ExecTimeoutPolicy::Duration { .. } => {
                let timeout_value_offset = offset;
                offset += 4;
                Some(timeout_value_offset)
            }
            ExecTimeoutPolicy::None => None,
        };

        let flags_offset = offset;
        offset += 1;

        offset += 4;

        let command_offset = offset;
        offset += request.command.len();

        let env_count_offset = offset;
        offset += 4;

        let mut env = Vec::with_capacity(request.env.len());
        for (key, value) in request.env {
            offset += 4;

            let key_offset = offset;
            offset += key.len();

            offset += 4;

            let value_offset = offset;
            offset += value.len();

            env.push(ExecStartEnvLayout {
                key_offset,
                value_offset,
            });
        }

        let label_len_offset = offset;
        offset += 2;

        let label_offset = offset;
        offset += request.label.len();

        let stdout_policy = ExecOutputPolicyLayout::new(offset, request.stdout);
        offset = stdout_policy.end_offset;

        offset = ExecOutputPolicyLayout::new(offset, request.stderr).end_offset;

        let expected_exit_count_offset = offset;
        offset += 2;

        let expected_exit_codes_offset = offset;
        offset += request.expected_exit_codes.len() * 4;

        let control = ExecStartControlLayout::new(offset, request.control);
        offset = control.end_offset;

        let stdin = ExecStartStdinLayout::new(offset, request.stdin_bytes);

        Self {
            lifecycle_offset,
            timeout_policy_offset,
            timeout_value_offset,
            flags_offset,
            command_offset,
            env_count_offset,
            env,
            label_len_offset,
            label_offset,
            stdout_policy,
            expected_exit_count_offset,
            expected_exit_codes_offset,
            control,
            stdin,
        }
    }

    pub fn one_shot_duration_discard(command: &str, env: &[(&str, &str)], label: &str) -> Self {
        Self::new(ExecStartLayoutRequest {
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
            command,
            env,
            label,
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        })
    }
}

pub(super) struct ExecStartLayoutRequest<'a> {
    pub timeout: ExecTimeoutPolicy,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub label: &'a str,
    pub stdout: ExecOutputPolicy,
    pub stderr: ExecOutputPolicy,
    pub expected_exit_codes: &'a [i32],
    pub control: ExecControlPolicy,
    pub stdin_bytes: Option<&'a [u8]>,
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
