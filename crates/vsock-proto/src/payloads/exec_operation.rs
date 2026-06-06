use crate::error::ProtocolError;
use crate::payloads::exec_control::{
    DecodedControl, DecodedControlResult, EXEC_CONTROL_CODEC_ERRORS, EXEC_CONTROL_NONCE_LEN,
    EXEC_CONTROL_RESULT_CODEC_ERRORS, ExecControlNonce, ExecControlStatus,
    decode_control_result_with_errors, decode_control_with_errors,
    encode_control_result_with_errors, encode_control_with_errors,
};
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_i32, read_slice, read_str, read_u8, read_u16, read_u32,
};
use crate::wire::{
    EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED, EXEC_FLAG_SUDO, EXEC_OUTPUT_FLAG_TRUNCATED,
};

const EXEC_OUTPUT_STREAM_STDOUT: u8 = 0x00;
const EXEC_OUTPUT_STREAM_STDERR: u8 = 0x01;

const EXEC_OUTPUT_POLICY_DISCARD: u8 = 0x00;
const EXEC_OUTPUT_POLICY_CAPTURE: u8 = 0x01;
const EXEC_OUTPUT_POLICY_STREAM: u8 = 0x02;
const EXEC_OUTPUT_POLICY_CAPTURE_AND_STREAM: u8 = 0x03;

const EXEC_LIFECYCLE_ONE_SHOT: u8 = 0x00;
const EXEC_LIFECYCLE_SUPERVISED: u8 = 0x01;

const EXEC_TIMEOUT_DURATION: u8 = 0x00;
const EXEC_TIMEOUT_NONE: u8 = 0x01;

const EXEC_CONTROL_DISABLED: u8 = 0x00;
const EXEC_CONTROL_ENABLED: u8 = 0x01;
const EXEC_CONTROL_FLAG_SINK: u8 = 0x01;

const EXEC_STDIN_NONE: u8 = 0x00;
const EXEC_STDIN_BYTES: u8 = 0x01;

const EXEC_TERMINATION_EXITED: u8 = 0x00;
const EXEC_TERMINATION_TIMED_OUT: u8 = 0x01;
const EXEC_TERMINATION_CANCELLED: u8 = 0x02;
const EXEC_TERMINATION_START_FAILED: u8 = 0x03;
const EXEC_TERMINATION_WAIT_FAILED: u8 = 0x04;

const EXEC_CAPTURED_OUTPUT_DISCARDED: u8 = 0x00;
const EXEC_CAPTURED_OUTPUT_CAPTURED: u8 = 0x01;

const MAX_EXEC_ENV_VARS: usize = 4096;
const MAX_EXEC_EXPECTED_EXIT_CODES: usize = 64;

/// Maximum bounded stdin payload accepted by an exec_start request.
pub const MAX_EXEC_STDIN_BYTES: usize = 64 * 1024;

/// Exec output stream selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOutputStream {
    Stdout,
    Stderr,
}

/// Exec stdout/stderr handling policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOutputPolicy {
    /// Drop this stream without retaining or emitting bytes.
    Discard,
    /// Retain at most `limit_bytes` bytes in the final exec result.
    ///
    /// A zero limit is valid and means captured output is intentionally empty.
    Capture { limit_bytes: u32 },
    /// Emit output chunks to the host up to `limit_bytes` total bytes.
    ///
    /// A zero stream limit is valid and means no chunks should be emitted.
    /// `chunk_limit_bytes` must be non-zero.
    Stream {
        limit_bytes: u32,
        chunk_limit_bytes: u32,
    },
    /// Retain output in the final result and also emit output chunks.
    ///
    /// Zero capture or stream limits are valid. `chunk_limit_bytes` must be
    /// non-zero.
    CaptureAndStream {
        capture_limit_bytes: u32,
        stream_limit_bytes: u32,
        chunk_limit_bytes: u32,
    },
}

/// Exec process lifecycle policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecLifecyclePolicy {
    /// Run a command to completion and report one terminal result.
    OneShot,
    /// Start a long-running process that will acknowledge its pid.
    Supervised,
}

/// Exec timeout policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecTimeoutPolicy {
    /// Kill the operation after `timeout_ms`.
    Duration { timeout_ms: u32 },
    /// Do not apply a protocol-level timeout.
    None,
}

/// Exec control channel policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecControlPolicy {
    /// Do not enable exec control messages for this operation.
    Disabled,
    /// Enable exec control messages using a per-operation nonce.
    Enabled {
        control_nonce: ExecControlNonce,
        sink: bool,
    },
}

/// Exec terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecTermination {
    Exited { exit_code: i32 },
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
}

/// Captured stdout/stderr in an exec result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCapturedOutput<'a> {
    Discarded,
    Captured { bytes: &'a [u8], truncated: bool },
}

/// Parameters for encoding an exec_start payload with extended metadata.
pub struct ExecStartEncodeRequest<'a> {
    pub lifecycle: ExecLifecyclePolicy,
    pub timeout: ExecTimeoutPolicy,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: ExecOutputPolicy,
    pub stderr: ExecOutputPolicy,
    pub expected_exit_codes: &'a [i32],
    pub control: ExecControlPolicy,
    pub stdin_bytes: Option<&'a [u8]>,
}

/// Decoded exec_start payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedExecStart<'a> {
    pub lifecycle: ExecLifecyclePolicy,
    pub timeout: ExecTimeoutPolicy,
    pub command: &'a str,
    pub env: Vec<(&'a str, &'a str)>,
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: ExecOutputPolicy,
    pub stderr: ExecOutputPolicy,
    pub expected_exit_codes: Vec<i32>,
    pub control: ExecControlPolicy,
    pub stdin_bytes: Option<&'a [u8]>,
}

/// Decoded exec_started payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecStarted {
    pub pid: u32,
}

/// Decoded exec_control payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecControl<'a> {
    pub target_seq: u32,
    pub request_timeout_ms: u32,
    pub control_nonce: ExecControlNonce,
    pub message_id: &'a str,
    pub payload: &'a [u8],
}

/// Decoded exec_control_result payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecControlResult<'a> {
    pub target_seq: u32,
    pub control_nonce: ExecControlNonce,
    pub message_id: &'a str,
    pub status: ExecControlStatus,
    pub diagnostic: &'a str,
}

/// Decoded exec_output payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecOutput<'a> {
    pub stream: ExecOutputStream,
    pub output_seq: u32,
    pub chunk: &'a [u8],
    pub truncated: bool,
}

/// Decoded exec_result payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecResult<'a> {
    pub termination: ExecTermination,
    /// Exec operation wall-clock duration in milliseconds.
    ///
    /// This is encoded as `u32`, matching exec timeout width.
    pub duration_ms: u32,
    pub stdout: ExecCapturedOutput<'a>,
    pub stderr: ExecCapturedOutput<'a>,
    pub diagnostic: &'a str,
}

fn validate_exec_output_chunk_limit(chunk_limit_bytes: u32) -> Result<(), ProtocolError> {
    if chunk_limit_bytes == 0 {
        return Err(ProtocolError::InvalidPayload(
            "exec output chunk limit must be non-zero",
        ));
    }
    Ok(())
}

fn exec_output_policy_encoded_len(policy: ExecOutputPolicy) -> Result<usize, ProtocolError> {
    match policy {
        ExecOutputPolicy::Discard => Ok(1),
        ExecOutputPolicy::Capture { .. } => Ok(5),
        ExecOutputPolicy::Stream {
            chunk_limit_bytes, ..
        } => {
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(9)
        }
        ExecOutputPolicy::CaptureAndStream {
            chunk_limit_bytes, ..
        } => {
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(13)
        }
    }
}

fn exec_timeout_policy_encoded_len(timeout: ExecTimeoutPolicy) -> usize {
    match timeout {
        ExecTimeoutPolicy::Duration { .. } => 1 + 4,
        ExecTimeoutPolicy::None => 1,
    }
}

fn exec_control_policy_encoded_len(control: ExecControlPolicy) -> usize {
    match control {
        ExecControlPolicy::Disabled => 1,
        ExecControlPolicy::Enabled { .. } => 1 + 1 + EXEC_CONTROL_NONCE_LEN,
    }
}

fn exec_stdin_policy_encoded_len(stdin_bytes: Option<&[u8]>) -> Result<usize, ProtocolError> {
    match stdin_bytes {
        None => Ok(1),
        Some(bytes) => {
            if bytes.len() > MAX_EXEC_STDIN_BYTES {
                return Err(ProtocolError::PayloadTooLarge("stdin_bytes", bytes.len()));
            }
            Ok(1 + 4 + bytes.len())
        }
    }
}

fn append_exec_lifecycle(p: &mut Vec<u8>, lifecycle: ExecLifecyclePolicy) {
    p.push(match lifecycle {
        ExecLifecyclePolicy::OneShot => EXEC_LIFECYCLE_ONE_SHOT,
        ExecLifecyclePolicy::Supervised => EXEC_LIFECYCLE_SUPERVISED,
    });
}

fn append_exec_timeout_policy(p: &mut Vec<u8>, timeout: ExecTimeoutPolicy) {
    match timeout {
        ExecTimeoutPolicy::Duration { timeout_ms } => {
            p.push(EXEC_TIMEOUT_DURATION);
            p.extend_from_slice(&timeout_ms.to_be_bytes());
        }
        ExecTimeoutPolicy::None => p.push(EXEC_TIMEOUT_NONE),
    }
}

fn append_exec_control_policy(p: &mut Vec<u8>, control: ExecControlPolicy) {
    match control {
        ExecControlPolicy::Disabled => p.push(EXEC_CONTROL_DISABLED),
        ExecControlPolicy::Enabled {
            control_nonce,
            sink,
        } => {
            p.push(EXEC_CONTROL_ENABLED);
            p.push(if sink { EXEC_CONTROL_FLAG_SINK } else { 0 });
            p.extend_from_slice(&control_nonce);
        }
    }
}

fn append_exec_stdin_policy(p: &mut Vec<u8>, stdin_bytes: Option<&[u8]>) {
    match stdin_bytes {
        None => p.push(EXEC_STDIN_NONE),
        Some(bytes) => {
            p.push(EXEC_STDIN_BYTES);
            p.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            p.extend_from_slice(bytes);
        }
    }
}

fn validate_exec_timeout_policy(timeout: ExecTimeoutPolicy) -> Result<(), ProtocolError> {
    if let ExecTimeoutPolicy::Duration { timeout_ms: 0 } = timeout {
        return Err(ProtocolError::InvalidPayload(
            "exec start timeout duration must be positive",
        ));
    }
    Ok(())
}

fn append_exec_output_policy(p: &mut Vec<u8>, policy: ExecOutputPolicy) {
    match policy {
        ExecOutputPolicy::Discard => p.push(EXEC_OUTPUT_POLICY_DISCARD),
        ExecOutputPolicy::Capture { limit_bytes } => {
            p.push(EXEC_OUTPUT_POLICY_CAPTURE);
            p.extend_from_slice(&limit_bytes.to_be_bytes());
        }
        ExecOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        } => {
            p.push(EXEC_OUTPUT_POLICY_STREAM);
            p.extend_from_slice(&limit_bytes.to_be_bytes());
            p.extend_from_slice(&chunk_limit_bytes.to_be_bytes());
        }
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes,
            stream_limit_bytes,
            chunk_limit_bytes,
        } => {
            p.push(EXEC_OUTPUT_POLICY_CAPTURE_AND_STREAM);
            p.extend_from_slice(&capture_limit_bytes.to_be_bytes());
            p.extend_from_slice(&stream_limit_bytes.to_be_bytes());
            p.extend_from_slice(&chunk_limit_bytes.to_be_bytes());
        }
    }
}

/// Encode exec_start payload with no expected non-zero exits.
pub fn encode_exec_start(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    label: &str,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
) -> Result<Vec<u8>, ProtocolError> {
    encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms },
        command,
        env,
        sudo,
        label,
        stdout,
        stderr,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    })
}

/// Encode exec_start payload.
///
/// Wire format:
/// `[1B lifecycle][timeout_policy][1B flags][4B cmd_len][command][4B env_count]... [2B label_len][label][stdout_policy][stderr_policy][2B expected_exit_count][4B exit_code]...[control_policy][stdin_policy]`.
///
/// Duration timeout policies require a positive `timeout_ms`; use the explicit
/// no-timeout policy for unbounded operation lifetimes.
pub fn encode_exec_start_with_expected_exit_codes(
    request: ExecStartEncodeRequest<'_>,
) -> Result<Vec<u8>, ProtocolError> {
    let cmd = request.command.as_bytes();
    let label_bytes = request.label.as_bytes();
    let cmd_len = ensure_u32_len("command", cmd.len())?;
    let env_count = ensure_u32_len("env_count", request.env.len())?;
    if request.env.len() > MAX_EXEC_ENV_VARS {
        return Err(ProtocolError::PayloadTooLarge(
            "env_count",
            request.env.len(),
        ));
    }
    let label_len = ensure_u16_len("label", label_bytes.len())?;
    let expected_exit_count =
        ensure_u16_len("expected_exit_count", request.expected_exit_codes.len())?;
    if request.expected_exit_codes.len() > MAX_EXEC_EXPECTED_EXIT_CODES {
        return Err(ProtocolError::PayloadTooLarge(
            "expected_exit_count",
            request.expected_exit_codes.len(),
        ));
    }

    let stdout_policy_len = exec_output_policy_encoded_len(request.stdout)?;
    let stderr_policy_len = exec_output_policy_encoded_len(request.stderr)?;
    let timeout_policy_len = exec_timeout_policy_encoded_len(request.timeout);
    let control_policy_len = exec_control_policy_encoded_len(request.control);
    let stdin_policy_len = exec_stdin_policy_encoded_len(request.stdin_bytes)?;
    validate_exec_timeout_policy(request.timeout)?;

    let mut payload_len = 1 + timeout_policy_len + 1 + 4;
    payload_len = checked_payload_len_add(payload_len, cmd.len())?;
    payload_len = checked_payload_len_add(payload_len, 4)?;
    for (key, val) in request.env {
        let key_bytes = key.as_bytes();
        let val_bytes = val.as_bytes();
        ensure_u32_len("env key", key_bytes.len())?;
        ensure_u32_len("env value", val_bytes.len())?;
        payload_len = checked_payload_len_add(payload_len, 8)?;
        payload_len = checked_payload_len_add(payload_len, key_bytes.len())?;
        payload_len = checked_payload_len_add(payload_len, val_bytes.len())?;
    }
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, label_bytes.len())?;
    payload_len = checked_payload_len_add(payload_len, stdout_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, request.expected_exit_codes.len() * 4)?;
    payload_len = checked_payload_len_add(payload_len, control_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, stdin_policy_len)?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    append_exec_lifecycle(&mut p, request.lifecycle);
    append_exec_timeout_policy(&mut p, request.timeout);
    p.push(if request.sudo { EXEC_FLAG_SUDO } else { 0 });
    p.extend_from_slice(&cmd_len.to_be_bytes());
    p.extend_from_slice(cmd);
    p.extend_from_slice(&env_count.to_be_bytes());
    for (key, val) in request.env {
        let key_bytes = key.as_bytes();
        let val_bytes = val.as_bytes();
        p.extend_from_slice(&(key_bytes.len() as u32).to_be_bytes());
        p.extend_from_slice(key_bytes);
        p.extend_from_slice(&(val_bytes.len() as u32).to_be_bytes());
        p.extend_from_slice(val_bytes);
    }
    p.extend_from_slice(&label_len.to_be_bytes());
    p.extend_from_slice(label_bytes);
    append_exec_output_policy(&mut p, request.stdout);
    append_exec_output_policy(&mut p, request.stderr);
    p.extend_from_slice(&expected_exit_count.to_be_bytes());
    for exit_code in request.expected_exit_codes {
        p.extend_from_slice(&exit_code.to_be_bytes());
    }
    append_exec_control_policy(&mut p, request.control);
    append_exec_stdin_policy(&mut p, request.stdin_bytes);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

/// Encode exec_started payload: `[4B pid]`.
pub fn encode_exec_started(pid: u32) -> Result<Vec<u8>, ProtocolError> {
    if pid == 0 {
        return Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero",
        ));
    }
    Ok(pid.to_be_bytes().to_vec())
}

/// Encode exec_control payload.
pub fn encode_exec_control(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    payload: &[u8],
    request_timeout_ms: u32,
) -> Result<Vec<u8>, ProtocolError> {
    encode_control_with_errors(
        target_seq,
        control_nonce,
        message_id,
        payload,
        request_timeout_ms,
        EXEC_CONTROL_CODEC_ERRORS,
    )
}

/// Encode exec_control_result payload.
pub fn encode_exec_control_result(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    encode_control_result_with_errors(
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
        EXEC_CONTROL_RESULT_CODEC_ERRORS,
    )
}

/// Encode exec_output payload: `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]`.
///
/// `output_seq` starts at 0 for each exec operation and increments by 1
/// for every output frame across stdout and stderr.
pub fn encode_exec_output(
    stream: ExecOutputStream,
    output_seq: u32,
    chunk: &[u8],
    truncated: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let chunk_len = ensure_u32_len("chunk", chunk.len())?;
    let payload_len = checked_payload_len_add(1 + 4 + 1 + 4, chunk.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    p.push(match stream {
        ExecOutputStream::Stdout => EXEC_OUTPUT_STREAM_STDOUT,
        ExecOutputStream::Stderr => EXEC_OUTPUT_STREAM_STDERR,
    });
    p.extend_from_slice(&output_seq.to_be_bytes());
    p.push(if truncated {
        EXEC_OUTPUT_FLAG_TRUNCATED
    } else {
        0
    });
    p.extend_from_slice(&chunk_len.to_be_bytes());
    p.extend_from_slice(chunk);
    Ok(p)
}

fn exec_termination_encoded_len(termination: ExecTermination) -> usize {
    match termination {
        ExecTermination::Exited { .. } => 5,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => 1,
    }
}

fn append_exec_termination(p: &mut Vec<u8>, termination: ExecTermination) {
    match termination {
        ExecTermination::Exited { exit_code } => {
            p.push(EXEC_TERMINATION_EXITED);
            p.extend_from_slice(&exit_code.to_be_bytes());
        }
        ExecTermination::TimedOut => p.push(EXEC_TERMINATION_TIMED_OUT),
        ExecTermination::Cancelled => p.push(EXEC_TERMINATION_CANCELLED),
        ExecTermination::StartFailed => p.push(EXEC_TERMINATION_START_FAILED),
        ExecTermination::WaitFailed => p.push(EXEC_TERMINATION_WAIT_FAILED),
    }
}

fn exec_operation_captured_output_encoded_len(
    output: ExecCapturedOutput<'_>,
    field: &'static str,
) -> Result<usize, ProtocolError> {
    match output {
        ExecCapturedOutput::Discarded => Ok(1),
        ExecCapturedOutput::Captured { bytes, .. } => {
            ensure_u32_len(field, bytes.len())?;
            checked_payload_len_add(1 + 1 + 4, bytes.len())
        }
    }
}

fn append_exec_operation_captured_output(p: &mut Vec<u8>, output: ExecCapturedOutput<'_>) {
    match output {
        ExecCapturedOutput::Discarded => p.push(EXEC_CAPTURED_OUTPUT_DISCARDED),
        ExecCapturedOutput::Captured { bytes, truncated } => {
            p.push(EXEC_CAPTURED_OUTPUT_CAPTURED);
            p.push(if truncated {
                EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED
            } else {
                0
            });
            p.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            p.extend_from_slice(bytes);
        }
    }
}

/// Encode exec_result payload.
pub fn encode_exec_result(
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let diagnostic_bytes = diagnostic.as_bytes();
    let diagnostic_len = ensure_u16_len("diagnostic", diagnostic_bytes.len())?;
    let stdout_len = exec_operation_captured_output_encoded_len(stdout, "stdout")?;
    let stderr_len = exec_operation_captured_output_encoded_len(stderr, "stderr")?;

    let mut payload_len = exec_termination_encoded_len(termination);
    payload_len = checked_payload_len_add(payload_len, 4)?;
    payload_len = checked_payload_len_add(payload_len, stdout_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, diagnostic_bytes.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    append_exec_termination(&mut p, termination);
    p.extend_from_slice(&duration_ms.to_be_bytes());
    append_exec_operation_captured_output(&mut p, stdout);
    append_exec_operation_captured_output(&mut p, stderr);
    p.extend_from_slice(&diagnostic_len.to_be_bytes());
    p.extend_from_slice(diagnostic_bytes);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

/// Encode exec_cancel payload.
pub fn encode_exec_cancel() -> Vec<u8> {
    Vec::new()
}

fn decode_exec_output_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecOutputPolicy, ProtocolError> {
    let tag = read_u8(payload, offset, "exec output policy tag truncated")?;
    match tag {
        EXEC_OUTPUT_POLICY_DISCARD => Ok(ExecOutputPolicy::Discard),
        EXEC_OUTPUT_POLICY_CAPTURE => {
            let limit_bytes = read_u32(payload, offset, "exec capture policy limit truncated")?;
            Ok(ExecOutputPolicy::Capture { limit_bytes })
        }
        EXEC_OUTPUT_POLICY_STREAM => {
            let limit_bytes = read_u32(payload, offset, "exec stream policy limit truncated")?;
            let chunk_limit_bytes =
                read_u32(payload, offset, "exec stream policy chunk limit truncated")?;
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(ExecOutputPolicy::Stream {
                limit_bytes,
                chunk_limit_bytes,
            })
        }
        EXEC_OUTPUT_POLICY_CAPTURE_AND_STREAM => {
            let capture_limit_bytes = read_u32(
                payload,
                offset,
                "exec capture-and-stream capture limit truncated",
            )?;
            let stream_limit_bytes = read_u32(
                payload,
                offset,
                "exec capture-and-stream stream limit truncated",
            )?;
            let chunk_limit_bytes = read_u32(
                payload,
                offset,
                "exec capture-and-stream chunk limit truncated",
            )?;
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(ExecOutputPolicy::CaptureAndStream {
                capture_limit_bytes,
                stream_limit_bytes,
                chunk_limit_bytes,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "invalid exec output policy tag",
        )),
    }
}

fn decode_exec_lifecycle(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecLifecyclePolicy, ProtocolError> {
    match read_u8(payload, offset, "exec start lifecycle truncated")? {
        EXEC_LIFECYCLE_ONE_SHOT => Ok(ExecLifecyclePolicy::OneShot),
        EXEC_LIFECYCLE_SUPERVISED => Ok(ExecLifecyclePolicy::Supervised),
        _ => Err(ProtocolError::InvalidPayload(
            "exec start lifecycle invalid",
        )),
    }
}

fn decode_exec_timeout_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecTimeoutPolicy, ProtocolError> {
    match read_u8(payload, offset, "exec start timeout policy truncated")? {
        EXEC_TIMEOUT_DURATION => {
            let timeout_ms = read_u32(payload, offset, "exec start timeout truncated")?;
            if timeout_ms == 0 {
                return Err(ProtocolError::InvalidPayload(
                    "exec start timeout duration must be positive",
                ));
            }
            Ok(ExecTimeoutPolicy::Duration { timeout_ms })
        }
        EXEC_TIMEOUT_NONE => Ok(ExecTimeoutPolicy::None),
        _ => Err(ProtocolError::InvalidPayload(
            "exec start timeout policy invalid",
        )),
    }
}

fn decode_exec_control_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecControlPolicy, ProtocolError> {
    match read_u8(payload, offset, "exec start control policy truncated")? {
        EXEC_CONTROL_DISABLED => Ok(ExecControlPolicy::Disabled),
        EXEC_CONTROL_ENABLED => {
            let flags = read_u8(payload, offset, "exec start control flags truncated")?;
            if flags & !EXEC_CONTROL_FLAG_SINK != 0 {
                return Err(ProtocolError::InvalidPayload(
                    "exec start control unknown flags",
                ));
            }
            let nonce_bytes = read_slice(
                payload,
                offset,
                EXEC_CONTROL_NONCE_LEN,
                "exec start control nonce truncated",
            )?;
            let control_nonce: ExecControlNonce = nonce_bytes
                .try_into()
                .map_err(|_| ProtocolError::InvalidPayload("exec start control nonce invalid"))?;
            Ok(ExecControlPolicy::Enabled {
                control_nonce,
                sink: flags & EXEC_CONTROL_FLAG_SINK != 0,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "exec start control policy invalid",
        )),
    }
}

fn decode_exec_stdin_policy<'a>(
    payload: &'a [u8],
    offset: &mut usize,
) -> Result<Option<&'a [u8]>, ProtocolError> {
    match read_u8(payload, offset, "exec start stdin policy truncated")? {
        EXEC_STDIN_NONE => Ok(None),
        EXEC_STDIN_BYTES => {
            let len = read_u32(payload, offset, "exec start stdin_len truncated")? as usize;
            if len > MAX_EXEC_STDIN_BYTES {
                return Err(ProtocolError::InvalidPayload("exec start stdin too large"));
            }
            let bytes = read_slice(payload, offset, len, "exec start stdin truncated")?;
            Ok(Some(bytes))
        }
        _ => Err(ProtocolError::InvalidPayload(
            "exec start stdin policy invalid",
        )),
    }
}

/// Decode exec_start payload into a [`DecodedExecStart`] struct.
pub fn decode_exec_start(payload: &[u8]) -> Result<DecodedExecStart<'_>, ProtocolError> {
    let mut offset = 0;
    let lifecycle = decode_exec_lifecycle(payload, &mut offset)?;
    let timeout = decode_exec_timeout_policy(payload, &mut offset)?;
    let flags = read_u8(payload, &mut offset, "exec start flags truncated")?;
    if flags & !EXEC_FLAG_SUDO != 0 {
        return Err(ProtocolError::InvalidPayload("exec start unknown flags"));
    }
    let cmd_len = read_u32(payload, &mut offset, "exec start command_len truncated")? as usize;
    let command = read_str(
        payload,
        &mut offset,
        cmd_len,
        "exec start command truncated",
        "invalid UTF-8 in command",
    )?;
    let env_count = read_u32(payload, &mut offset, "exec start env_count truncated")?;
    if env_count as usize > MAX_EXEC_ENV_VARS {
        return Err(ProtocolError::InvalidPayload(
            "exec start env_count too large",
        ));
    }
    let min_env_bytes = (env_count as usize)
        .checked_mul(8)
        .ok_or(ProtocolError::InvalidPayload("exec start env truncated"))?;
    let remaining_for_env = payload.len().saturating_sub(offset).saturating_sub(4);
    if min_env_bytes > remaining_for_env {
        return Err(ProtocolError::InvalidPayload("exec start env truncated"));
    }
    let mut env = Vec::with_capacity(env_count as usize);
    for _ in 0..env_count {
        let key_len = read_u32(payload, &mut offset, "exec start env key_len truncated")? as usize;
        let key = read_str(
            payload,
            &mut offset,
            key_len,
            "exec start env key truncated",
            "invalid UTF-8 in env key",
        )?;
        let val_len = read_u32(payload, &mut offset, "exec start env val_len truncated")? as usize;
        let val = read_str(
            payload,
            &mut offset,
            val_len,
            "exec start env value truncated",
            "invalid UTF-8 in env value",
        )?;
        env.push((key, val));
    }
    let label_len = read_u16(payload, &mut offset, "exec start label_len truncated")? as usize;
    let label = read_str(
        payload,
        &mut offset,
        label_len,
        "exec start label truncated",
        "invalid UTF-8 in label",
    )?;
    let stdout = decode_exec_output_policy(payload, &mut offset)?;
    let stderr = decode_exec_output_policy(payload, &mut offset)?;
    let expected_exit_count = read_u16(
        payload,
        &mut offset,
        "exec start expected_exit_count truncated",
    )?;
    if expected_exit_count as usize > MAX_EXEC_EXPECTED_EXIT_CODES {
        return Err(ProtocolError::InvalidPayload(
            "exec start expected_exit_count too large",
        ));
    }
    let expected_exit_bytes =
        (expected_exit_count as usize)
            .checked_mul(4)
            .ok_or(ProtocolError::InvalidPayload(
                "exec start expected exits truncated",
            ))?;
    if payload.len().saturating_sub(offset) < expected_exit_bytes {
        return Err(ProtocolError::InvalidPayload(
            "exec start expected exits truncated",
        ));
    }
    let mut expected_exit_codes = Vec::with_capacity(expected_exit_count as usize);
    for _ in 0..expected_exit_count {
        expected_exit_codes.push(read_i32(
            payload,
            &mut offset,
            "exec start expected exit truncated",
        )?);
    }
    let control = decode_exec_control_policy(payload, &mut offset)?;
    let stdin_bytes = decode_exec_stdin_policy(payload, &mut offset)?;
    expect_consumed(payload, offset, "exec start trailing bytes")?;
    Ok(DecodedExecStart {
        lifecycle,
        timeout,
        command,
        env,
        sudo: (flags & EXEC_FLAG_SUDO) != 0,
        label,
        stdout,
        stderr,
        expected_exit_codes,
        control,
        stdin_bytes,
    })
}

/// Decode exec_started payload into a [`DecodedExecStarted`] struct.
pub fn decode_exec_started(payload: &[u8]) -> Result<DecodedExecStarted, ProtocolError> {
    let mut offset = 0;
    let pid = read_u32(payload, &mut offset, "exec started pid truncated")?;
    if pid == 0 {
        return Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero",
        ));
    }
    expect_consumed(payload, offset, "exec started trailing bytes")?;
    Ok(DecodedExecStarted { pid })
}

/// Decode exec_control payload into a [`DecodedExecControl`] struct.
pub fn decode_exec_control(payload: &[u8]) -> Result<DecodedExecControl<'_>, ProtocolError> {
    let DecodedControl {
        target_seq,
        request_timeout_ms,
        control_nonce,
        message_id,
        payload: message_payload,
    } = decode_control_with_errors(payload, EXEC_CONTROL_CODEC_ERRORS)?;
    Ok(DecodedExecControl {
        target_seq,
        request_timeout_ms,
        control_nonce,
        message_id,
        payload: message_payload,
    })
}

/// Decode exec_control_result payload into a [`DecodedExecControlResult`] struct.
pub fn decode_exec_control_result(
    payload: &[u8],
) -> Result<DecodedExecControlResult<'_>, ProtocolError> {
    let DecodedControlResult {
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    } = decode_control_result_with_errors(payload, EXEC_CONTROL_RESULT_CODEC_ERRORS)?;
    Ok(DecodedExecControlResult {
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    })
}

/// Decode exec_output payload into a [`DecodedExecOutput`] struct.
pub fn decode_exec_output(payload: &[u8]) -> Result<DecodedExecOutput<'_>, ProtocolError> {
    let mut offset = 0;
    let stream = match read_u8(payload, &mut offset, "exec output stream truncated")? {
        EXEC_OUTPUT_STREAM_STDOUT => ExecOutputStream::Stdout,
        EXEC_OUTPUT_STREAM_STDERR => ExecOutputStream::Stderr,
        _ => {
            return Err(ProtocolError::InvalidPayload("invalid exec output stream"));
        }
    };
    let output_seq = read_u32(payload, &mut offset, "exec output seq truncated")?;
    let flags = read_u8(payload, &mut offset, "exec output flags truncated")?;
    if flags & !EXEC_OUTPUT_FLAG_TRUNCATED != 0 {
        return Err(ProtocolError::InvalidPayload("exec output unknown flags"));
    }
    let chunk_len = read_u32(payload, &mut offset, "exec output chunk_len truncated")? as usize;
    let chunk = read_slice(
        payload,
        &mut offset,
        chunk_len,
        "exec output chunk truncated",
    )?;
    expect_consumed(payload, offset, "exec output trailing bytes")?;
    Ok(DecodedExecOutput {
        stream,
        output_seq,
        chunk,
        truncated: (flags & EXEC_OUTPUT_FLAG_TRUNCATED) != 0,
    })
}

fn decode_exec_termination(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecTermination, ProtocolError> {
    match read_u8(payload, offset, "exec result termination truncated")? {
        EXEC_TERMINATION_EXITED => {
            let exit_code = read_i32(payload, offset, "exec result exit_code truncated")?;
            Ok(ExecTermination::Exited { exit_code })
        }
        EXEC_TERMINATION_TIMED_OUT => Ok(ExecTermination::TimedOut),
        EXEC_TERMINATION_CANCELLED => Ok(ExecTermination::Cancelled),
        EXEC_TERMINATION_START_FAILED => Ok(ExecTermination::StartFailed),
        EXEC_TERMINATION_WAIT_FAILED => Ok(ExecTermination::WaitFailed),
        _ => Err(ProtocolError::InvalidPayload(
            "invalid exec termination tag",
        )),
    }
}

fn decode_exec_operation_captured_output<'a>(
    payload: &'a [u8],
    offset: &mut usize,
) -> Result<ExecCapturedOutput<'a>, ProtocolError> {
    match read_u8(payload, offset, "exec captured output tag truncated")? {
        EXEC_CAPTURED_OUTPUT_DISCARDED => Ok(ExecCapturedOutput::Discarded),
        EXEC_CAPTURED_OUTPUT_CAPTURED => {
            let flags = read_u8(payload, offset, "exec captured output flags truncated")?;
            if flags & !EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED != 0 {
                return Err(ProtocolError::InvalidPayload(
                    "exec captured output unknown flags",
                ));
            }
            let bytes_len =
                read_u32(payload, offset, "exec captured output bytes_len truncated")? as usize;
            let bytes = read_slice(
                payload,
                offset,
                bytes_len,
                "exec captured output bytes truncated",
            )?;
            Ok(ExecCapturedOutput::Captured {
                bytes,
                truncated: (flags & EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED) != 0,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "invalid exec captured output tag",
        )),
    }
}

/// Decode exec_result payload into a [`DecodedExecResult`] struct.
pub fn decode_exec_result(payload: &[u8]) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let mut offset = 0;
    let termination = decode_exec_termination(payload, &mut offset)?;
    let duration_ms = read_u32(payload, &mut offset, "exec result duration truncated")?;
    let stdout = decode_exec_operation_captured_output(payload, &mut offset)?;
    let stderr = decode_exec_operation_captured_output(payload, &mut offset)?;
    let diagnostic_len =
        read_u16(payload, &mut offset, "exec result diagnostic_len truncated")? as usize;
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "exec result diagnostic truncated",
        "invalid UTF-8 in diagnostic",
    )?;
    expect_consumed(payload, offset, "exec result trailing bytes")?;
    Ok(DecodedExecResult {
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    })
}

/// Decode exec_cancel payload.
pub fn decode_exec_cancel(payload: &[u8]) -> Result<(), ProtocolError> {
    if !payload.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "exec cancel payload must be empty",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
