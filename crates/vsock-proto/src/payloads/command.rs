use crate::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_i32, read_slice, read_str, read_u8, read_u16, read_u32,
};
use crate::wire::{
    COMMAND_CAPTURED_OUTPUT_FLAG_TRUNCATED, COMMAND_FLAG_SUDO, COMMAND_OUTPUT_FLAG_TRUNCATED,
};

const COMMAND_OUTPUT_STREAM_STDOUT: u8 = 0x00;
const COMMAND_OUTPUT_STREAM_STDERR: u8 = 0x01;

const COMMAND_OUTPUT_POLICY_DISCARD: u8 = 0x00;
const COMMAND_OUTPUT_POLICY_CAPTURE: u8 = 0x01;
const COMMAND_OUTPUT_POLICY_STREAM: u8 = 0x02;
const COMMAND_OUTPUT_POLICY_CAPTURE_AND_STREAM: u8 = 0x03;

const COMMAND_TERMINATION_EXITED: u8 = 0x00;
const COMMAND_TERMINATION_TIMED_OUT: u8 = 0x01;
const COMMAND_TERMINATION_CANCELLED: u8 = 0x02;
const COMMAND_TERMINATION_START_FAILED: u8 = 0x03;
const COMMAND_TERMINATION_WAIT_FAILED: u8 = 0x04;

const COMMAND_CAPTURED_OUTPUT_DISCARDED: u8 = 0x00;
const COMMAND_CAPTURED_OUTPUT_CAPTURED: u8 = 0x01;

const MAX_COMMAND_ENV_VARS: usize = 4096;

/// Command output stream selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandOutputStream {
    Stdout,
    Stderr,
}

/// Command stdout/stderr handling policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandOutputPolicy {
    /// Drop this stream without retaining or emitting bytes.
    Discard,
    /// Retain at most `limit_bytes` bytes in the final command result.
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

/// Command terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandTermination {
    Exited { exit_code: i32 },
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
}

/// Captured stdout/stderr in a command result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandCapturedOutput<'a> {
    Discarded,
    Captured { bytes: &'a [u8], truncated: bool },
}

/// Decoded command start payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedCommandStart<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: Vec<(&'a str, &'a str)>,
    pub sudo: bool,
    pub label: &'a str,
    pub stdout: CommandOutputPolicy,
    pub stderr: CommandOutputPolicy,
}

/// Decoded command output payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedCommandOutput<'a> {
    pub stream: CommandOutputStream,
    pub output_seq: u32,
    pub chunk: &'a [u8],
    pub truncated: bool,
}

/// Decoded command result payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedCommandResult<'a> {
    pub termination: CommandTermination,
    /// Command wall-clock duration in milliseconds.
    ///
    /// This is encoded as `u32`, matching command timeout width.
    pub duration_ms: u32,
    pub stdout: CommandCapturedOutput<'a>,
    pub stderr: CommandCapturedOutput<'a>,
    pub diagnostic: &'a str,
}

fn command_output_policy_encoded_len(policy: CommandOutputPolicy) -> Result<usize, ProtocolError> {
    match policy {
        CommandOutputPolicy::Discard => Ok(1),
        CommandOutputPolicy::Capture { .. } => Ok(5),
        CommandOutputPolicy::Stream {
            chunk_limit_bytes, ..
        } => {
            if chunk_limit_bytes == 0 {
                return Err(ProtocolError::InvalidPayload(
                    "command output chunk limit must be non-zero",
                ));
            }
            Ok(9)
        }
        CommandOutputPolicy::CaptureAndStream {
            chunk_limit_bytes, ..
        } => {
            if chunk_limit_bytes == 0 {
                return Err(ProtocolError::InvalidPayload(
                    "command output chunk limit must be non-zero",
                ));
            }
            Ok(13)
        }
    }
}

fn append_command_output_policy(p: &mut Vec<u8>, policy: CommandOutputPolicy) {
    match policy {
        CommandOutputPolicy::Discard => p.push(COMMAND_OUTPUT_POLICY_DISCARD),
        CommandOutputPolicy::Capture { limit_bytes } => {
            p.push(COMMAND_OUTPUT_POLICY_CAPTURE);
            p.extend_from_slice(&limit_bytes.to_be_bytes());
        }
        CommandOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        } => {
            p.push(COMMAND_OUTPUT_POLICY_STREAM);
            p.extend_from_slice(&limit_bytes.to_be_bytes());
            p.extend_from_slice(&chunk_limit_bytes.to_be_bytes());
        }
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes,
            stream_limit_bytes,
            chunk_limit_bytes,
        } => {
            p.push(COMMAND_OUTPUT_POLICY_CAPTURE_AND_STREAM);
            p.extend_from_slice(&capture_limit_bytes.to_be_bytes());
            p.extend_from_slice(&stream_limit_bytes.to_be_bytes());
            p.extend_from_slice(&chunk_limit_bytes.to_be_bytes());
        }
    }
}

/// Encode command_start payload.
///
/// Wire format:
/// `[4B timeout_ms][1B flags][4B cmd_len][command][4B env_count]... [2B label_len][label][stdout_policy][stderr_policy]`.
pub fn encode_command_start(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    label: &str,
    stdout: CommandOutputPolicy,
    stderr: CommandOutputPolicy,
) -> Result<Vec<u8>, ProtocolError> {
    let cmd = command.as_bytes();
    let label_bytes = label.as_bytes();
    let cmd_len = ensure_u32_len("command", cmd.len())?;
    let env_count = ensure_u32_len("env_count", env.len())?;
    if env.len() > MAX_COMMAND_ENV_VARS {
        return Err(ProtocolError::PayloadTooLarge("env_count", env.len()));
    }
    let label_len = ensure_u16_len("label", label_bytes.len())?;

    let stdout_policy_len = command_output_policy_encoded_len(stdout)?;
    let stderr_policy_len = command_output_policy_encoded_len(stderr)?;

    let mut payload_len = 4 + 1 + 4;
    payload_len = checked_payload_len_add(payload_len, cmd.len())?;
    payload_len = checked_payload_len_add(payload_len, 4)?;
    for (key, val) in env {
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
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    p.extend_from_slice(&timeout_ms.to_be_bytes());
    p.push(if sudo { COMMAND_FLAG_SUDO } else { 0 });
    p.extend_from_slice(&cmd_len.to_be_bytes());
    p.extend_from_slice(cmd);
    p.extend_from_slice(&env_count.to_be_bytes());
    for (key, val) in env {
        let key_bytes = key.as_bytes();
        let val_bytes = val.as_bytes();
        p.extend_from_slice(&(key_bytes.len() as u32).to_be_bytes());
        p.extend_from_slice(key_bytes);
        p.extend_from_slice(&(val_bytes.len() as u32).to_be_bytes());
        p.extend_from_slice(val_bytes);
    }
    p.extend_from_slice(&label_len.to_be_bytes());
    p.extend_from_slice(label_bytes);
    append_command_output_policy(&mut p, stdout);
    append_command_output_policy(&mut p, stderr);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

/// Encode command_output payload: `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]`.
///
/// `output_seq` starts at 0 for each command operation and increments by 1
/// for every output frame across stdout and stderr.
pub fn encode_command_output(
    stream: CommandOutputStream,
    output_seq: u32,
    chunk: &[u8],
    truncated: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let chunk_len = ensure_u32_len("chunk", chunk.len())?;
    let payload_len = checked_payload_len_add(1 + 4 + 1 + 4, chunk.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    p.push(match stream {
        CommandOutputStream::Stdout => COMMAND_OUTPUT_STREAM_STDOUT,
        CommandOutputStream::Stderr => COMMAND_OUTPUT_STREAM_STDERR,
    });
    p.extend_from_slice(&output_seq.to_be_bytes());
    p.push(if truncated {
        COMMAND_OUTPUT_FLAG_TRUNCATED
    } else {
        0
    });
    p.extend_from_slice(&chunk_len.to_be_bytes());
    p.extend_from_slice(chunk);
    Ok(p)
}

fn command_termination_encoded_len(termination: CommandTermination) -> usize {
    match termination {
        CommandTermination::Exited { .. } => 5,
        CommandTermination::TimedOut
        | CommandTermination::Cancelled
        | CommandTermination::StartFailed
        | CommandTermination::WaitFailed => 1,
    }
}

fn append_command_termination(p: &mut Vec<u8>, termination: CommandTermination) {
    match termination {
        CommandTermination::Exited { exit_code } => {
            p.push(COMMAND_TERMINATION_EXITED);
            p.extend_from_slice(&exit_code.to_be_bytes());
        }
        CommandTermination::TimedOut => p.push(COMMAND_TERMINATION_TIMED_OUT),
        CommandTermination::Cancelled => p.push(COMMAND_TERMINATION_CANCELLED),
        CommandTermination::StartFailed => p.push(COMMAND_TERMINATION_START_FAILED),
        CommandTermination::WaitFailed => p.push(COMMAND_TERMINATION_WAIT_FAILED),
    }
}

fn command_captured_output_encoded_len(
    output: CommandCapturedOutput<'_>,
    field: &'static str,
) -> Result<usize, ProtocolError> {
    match output {
        CommandCapturedOutput::Discarded => Ok(1),
        CommandCapturedOutput::Captured { bytes, .. } => {
            ensure_u32_len(field, bytes.len())?;
            checked_payload_len_add(1 + 1 + 4, bytes.len())
        }
    }
}

fn append_command_captured_output(p: &mut Vec<u8>, output: CommandCapturedOutput<'_>) {
    match output {
        CommandCapturedOutput::Discarded => p.push(COMMAND_CAPTURED_OUTPUT_DISCARDED),
        CommandCapturedOutput::Captured { bytes, truncated } => {
            p.push(COMMAND_CAPTURED_OUTPUT_CAPTURED);
            p.push(if truncated {
                COMMAND_CAPTURED_OUTPUT_FLAG_TRUNCATED
            } else {
                0
            });
            p.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            p.extend_from_slice(bytes);
        }
    }
}

/// Encode command_result payload.
pub fn encode_command_result(
    termination: CommandTermination,
    duration_ms: u32,
    stdout: CommandCapturedOutput<'_>,
    stderr: CommandCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let diagnostic_bytes = diagnostic.as_bytes();
    let diagnostic_len = ensure_u16_len("diagnostic", diagnostic_bytes.len())?;
    let stdout_len = command_captured_output_encoded_len(stdout, "stdout")?;
    let stderr_len = command_captured_output_encoded_len(stderr, "stderr")?;

    let mut payload_len = command_termination_encoded_len(termination);
    payload_len = checked_payload_len_add(payload_len, 4)?;
    payload_len = checked_payload_len_add(payload_len, stdout_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, diagnostic_bytes.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    append_command_termination(&mut p, termination);
    p.extend_from_slice(&duration_ms.to_be_bytes());
    append_command_captured_output(&mut p, stdout);
    append_command_captured_output(&mut p, stderr);
    p.extend_from_slice(&diagnostic_len.to_be_bytes());
    p.extend_from_slice(diagnostic_bytes);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

/// Encode command_cancel payload.
pub fn encode_command_cancel() -> Vec<u8> {
    Vec::new()
}

fn decode_command_output_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<CommandOutputPolicy, ProtocolError> {
    let tag = read_u8(payload, offset, "command output policy tag truncated")?;
    match tag {
        COMMAND_OUTPUT_POLICY_DISCARD => Ok(CommandOutputPolicy::Discard),
        COMMAND_OUTPUT_POLICY_CAPTURE => {
            let limit_bytes = read_u32(payload, offset, "command capture policy limit truncated")?;
            Ok(CommandOutputPolicy::Capture { limit_bytes })
        }
        COMMAND_OUTPUT_POLICY_STREAM => {
            let limit_bytes = read_u32(payload, offset, "command stream policy limit truncated")?;
            let chunk_limit_bytes = read_u32(
                payload,
                offset,
                "command stream policy chunk limit truncated",
            )?;
            if chunk_limit_bytes == 0 {
                return Err(ProtocolError::InvalidPayload(
                    "command output chunk limit must be non-zero",
                ));
            }
            Ok(CommandOutputPolicy::Stream {
                limit_bytes,
                chunk_limit_bytes,
            })
        }
        COMMAND_OUTPUT_POLICY_CAPTURE_AND_STREAM => {
            let capture_limit_bytes = read_u32(
                payload,
                offset,
                "command capture-and-stream capture limit truncated",
            )?;
            let stream_limit_bytes = read_u32(
                payload,
                offset,
                "command capture-and-stream stream limit truncated",
            )?;
            let chunk_limit_bytes = read_u32(
                payload,
                offset,
                "command capture-and-stream chunk limit truncated",
            )?;
            if chunk_limit_bytes == 0 {
                return Err(ProtocolError::InvalidPayload(
                    "command output chunk limit must be non-zero",
                ));
            }
            Ok(CommandOutputPolicy::CaptureAndStream {
                capture_limit_bytes,
                stream_limit_bytes,
                chunk_limit_bytes,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "invalid command output policy tag",
        )),
    }
}

/// Decode command_start payload into a [`DecodedCommandStart`] struct.
pub fn decode_command_start(payload: &[u8]) -> Result<DecodedCommandStart<'_>, ProtocolError> {
    let mut offset = 0;
    let timeout_ms = read_u32(payload, &mut offset, "command start timeout truncated")?;
    let flags = read_u8(payload, &mut offset, "command start flags truncated")?;
    if flags & !COMMAND_FLAG_SUDO != 0 {
        return Err(ProtocolError::InvalidPayload("command start unknown flags"));
    }
    let cmd_len = read_u32(payload, &mut offset, "command start command_len truncated")? as usize;
    let command = read_str(
        payload,
        &mut offset,
        cmd_len,
        "command start command truncated",
        "invalid UTF-8 in command",
    )?;
    let env_count = read_u32(payload, &mut offset, "command start env_count truncated")?;
    if env_count as usize > MAX_COMMAND_ENV_VARS {
        return Err(ProtocolError::InvalidPayload(
            "command start env_count too large",
        ));
    }
    let min_env_bytes = (env_count as usize)
        .checked_mul(8)
        .ok_or(ProtocolError::InvalidPayload("command start env truncated"))?;
    let remaining_for_env = payload.len().saturating_sub(offset).saturating_sub(4);
    if min_env_bytes > remaining_for_env {
        return Err(ProtocolError::InvalidPayload("command start env truncated"));
    }
    let mut env = Vec::new();
    for _ in 0..env_count {
        let key_len =
            read_u32(payload, &mut offset, "command start env key_len truncated")? as usize;
        let key = read_str(
            payload,
            &mut offset,
            key_len,
            "command start env key truncated",
            "invalid UTF-8 in env key",
        )?;
        let val_len =
            read_u32(payload, &mut offset, "command start env val_len truncated")? as usize;
        let val = read_str(
            payload,
            &mut offset,
            val_len,
            "command start env value truncated",
            "invalid UTF-8 in env value",
        )?;
        env.push((key, val));
    }
    let label_len = read_u16(payload, &mut offset, "command start label_len truncated")? as usize;
    let label = read_str(
        payload,
        &mut offset,
        label_len,
        "command start label truncated",
        "invalid UTF-8 in label",
    )?;
    let stdout = decode_command_output_policy(payload, &mut offset)?;
    let stderr = decode_command_output_policy(payload, &mut offset)?;
    expect_consumed(payload, offset, "command start trailing bytes")?;
    Ok(DecodedCommandStart {
        timeout_ms,
        command,
        env,
        sudo: (flags & COMMAND_FLAG_SUDO) != 0,
        label,
        stdout,
        stderr,
    })
}

/// Decode command_output payload into a [`DecodedCommandOutput`] struct.
pub fn decode_command_output(payload: &[u8]) -> Result<DecodedCommandOutput<'_>, ProtocolError> {
    let mut offset = 0;
    let stream = match read_u8(payload, &mut offset, "command output stream truncated")? {
        COMMAND_OUTPUT_STREAM_STDOUT => CommandOutputStream::Stdout,
        COMMAND_OUTPUT_STREAM_STDERR => CommandOutputStream::Stderr,
        _ => {
            return Err(ProtocolError::InvalidPayload(
                "invalid command output stream",
            ));
        }
    };
    let output_seq = read_u32(payload, &mut offset, "command output seq truncated")?;
    let flags = read_u8(payload, &mut offset, "command output flags truncated")?;
    if flags & !COMMAND_OUTPUT_FLAG_TRUNCATED != 0 {
        return Err(ProtocolError::InvalidPayload(
            "command output unknown flags",
        ));
    }
    let chunk_len = read_u32(payload, &mut offset, "command output chunk_len truncated")? as usize;
    let chunk = read_slice(
        payload,
        &mut offset,
        chunk_len,
        "command output chunk truncated",
    )?;
    expect_consumed(payload, offset, "command output trailing bytes")?;
    Ok(DecodedCommandOutput {
        stream,
        output_seq,
        chunk,
        truncated: (flags & COMMAND_OUTPUT_FLAG_TRUNCATED) != 0,
    })
}

fn decode_command_termination(
    payload: &[u8],
    offset: &mut usize,
) -> Result<CommandTermination, ProtocolError> {
    match read_u8(payload, offset, "command result termination truncated")? {
        COMMAND_TERMINATION_EXITED => {
            let exit_code = read_i32(payload, offset, "command result exit_code truncated")?;
            Ok(CommandTermination::Exited { exit_code })
        }
        COMMAND_TERMINATION_TIMED_OUT => Ok(CommandTermination::TimedOut),
        COMMAND_TERMINATION_CANCELLED => Ok(CommandTermination::Cancelled),
        COMMAND_TERMINATION_START_FAILED => Ok(CommandTermination::StartFailed),
        COMMAND_TERMINATION_WAIT_FAILED => Ok(CommandTermination::WaitFailed),
        _ => Err(ProtocolError::InvalidPayload(
            "invalid command termination tag",
        )),
    }
}

fn decode_command_captured_output<'a>(
    payload: &'a [u8],
    offset: &mut usize,
) -> Result<CommandCapturedOutput<'a>, ProtocolError> {
    match read_u8(payload, offset, "command captured output tag truncated")? {
        COMMAND_CAPTURED_OUTPUT_DISCARDED => Ok(CommandCapturedOutput::Discarded),
        COMMAND_CAPTURED_OUTPUT_CAPTURED => {
            let flags = read_u8(payload, offset, "command captured output flags truncated")?;
            if flags & !COMMAND_CAPTURED_OUTPUT_FLAG_TRUNCATED != 0 {
                return Err(ProtocolError::InvalidPayload(
                    "command captured output unknown flags",
                ));
            }
            let bytes_len = read_u32(
                payload,
                offset,
                "command captured output bytes_len truncated",
            )? as usize;
            let bytes = read_slice(
                payload,
                offset,
                bytes_len,
                "command captured output bytes truncated",
            )?;
            Ok(CommandCapturedOutput::Captured {
                bytes,
                truncated: (flags & COMMAND_CAPTURED_OUTPUT_FLAG_TRUNCATED) != 0,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "invalid command captured output tag",
        )),
    }
}

/// Decode command_result payload into a [`DecodedCommandResult`] struct.
pub fn decode_command_result(payload: &[u8]) -> Result<DecodedCommandResult<'_>, ProtocolError> {
    let mut offset = 0;
    let termination = decode_command_termination(payload, &mut offset)?;
    let duration_ms = read_u32(payload, &mut offset, "command result duration truncated")?;
    let stdout = decode_command_captured_output(payload, &mut offset)?;
    let stderr = decode_command_captured_output(payload, &mut offset)?;
    let diagnostic_len = read_u16(
        payload,
        &mut offset,
        "command result diagnostic_len truncated",
    )? as usize;
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "command result diagnostic truncated",
        "invalid UTF-8 in diagnostic",
    )?;
    expect_consumed(payload, offset, "command result trailing bytes")?;
    Ok(DecodedCommandResult {
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    })
}

/// Decode command_cancel payload.
pub fn decode_command_cancel(payload: &[u8]) -> Result<(), ProtocolError> {
    if !payload.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "command cancel payload must be empty",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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
        let payload =
            encode_command_output(CommandOutputStream::Stdout, 7, b"hello", false).unwrap();
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
        let payload =
            encode_command_output(CommandOutputStream::Stdout, 1, b"chunk", false).unwrap();

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
}
