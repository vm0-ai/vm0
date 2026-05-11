//! Vsock binary protocol for host-guest communication.
//!
//! ## Wire Format
//!
//! ```text
//! [4-byte length][1-byte type][4-byte seq][payload]
//! ```
//!
//! - **length**: big-endian u32, size of (type + seq + payload)
//! - **type**: u8 message type
//! - **seq**: big-endian u32, sequence number (0 for unsolicited messages)
//! - **payload**: type-specific binary data
//!
//! ## Message Types
//!
//! | Type | Direction | Name              | Payload |
//! |------|-----------|-------------------|---------|
//! | 0x00 | G→H       | ready             | (empty) |
//! | 0x01 | H→G       | ping              | (empty) |
//! | 0x02 | G→H       | pong              | (empty) |
//! | 0x03 | H→G       | exec              | `[4B timeout_ms][1B flags][4B cmd_len][command]([4B env_count]([4B key_len][key][4B val_len][value])*)` |
//! | 0x04 | G→H       | exec_result       | `[4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]` |
//! | 0x05 | H→G       | write_file        | `[2B path_len][path][1B flags][4B content_len][content]` (flags: `SUDO=0x01`, `APPEND=0x02`) |
//! | 0x06 | G→H       | write_file_result | `[1B success][2B error_len][error]` |
//! | 0x07 | H→G       | spawn_watch       | `[4B timeout_ms][1B flags][4B cmd_len][command]([4B env_count]([4B key_len][key][4B val_len][value])*)([2B log_path_len][log_path])` (flags: `SUDO=0x01`, `STREAM_STDOUT=0x02`) |
//! | 0x08 | G→H       | spawn_watch_result| `[4B pid]` |
//! | 0x09 | G→H       | process_exit      | `[4B pid][4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]` |
//! | 0x0A | H→G       | shutdown          | (empty) |
//! | 0x0B | G→H       | shutdown_ack      | (empty) |
//! | 0x0C | G→H       | stdout_chunk      | `[4B pid][data]` |
//! | 0x0D | H→G       | command_start     | `[4B timeout_ms][1B flags][4B cmd_len][command][4B env_count]... [stdout_policy][stderr_policy][2B label_len][label]` |
//! | 0x0E | G→H       | command_output    | `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]` |
//! | 0x0F | G→H       | command_result    | `[1B termination]...[4B duration_ms][stdout][stderr][2B diagnostic_len][diagnostic]` |
//! | 0x10 | H→G       | command_cancel    | (empty) |
//! | 0xFF | G→H       | error             | `[2B error_len][error]` |
//!
//! Command operation messages are request-scoped; host/guest dispatch layers
//! must use a non-zero sequence number for start/output/result/cancel.

/// Header size (4-byte length prefix).
pub const HEADER_SIZE: usize = 4;

/// Maximum message body size (16 MB).
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

/// Minimum body size: type (1) + seq (4).
pub const MIN_BODY_SIZE: usize = 5;

// Message type constants.
pub const MSG_READY: u8 = 0x00;
pub const MSG_PING: u8 = 0x01;
pub const MSG_PONG: u8 = 0x02;
pub const MSG_EXEC: u8 = 0x03;
pub const MSG_EXEC_RESULT: u8 = 0x04;
pub const MSG_WRITE_FILE: u8 = 0x05;
pub const MSG_WRITE_FILE_RESULT: u8 = 0x06;
pub const MSG_SPAWN_WATCH: u8 = 0x07;
pub const MSG_SPAWN_WATCH_RESULT: u8 = 0x08;
pub const MSG_PROCESS_EXIT: u8 = 0x09;
pub const MSG_SHUTDOWN: u8 = 0x0A;
pub const MSG_SHUTDOWN_ACK: u8 = 0x0B;
pub const MSG_STDOUT_CHUNK: u8 = 0x0C;
pub const MSG_COMMAND_START: u8 = 0x0D;
pub const MSG_COMMAND_OUTPUT: u8 = 0x0E;
pub const MSG_COMMAND_RESULT: u8 = 0x0F;
pub const MSG_COMMAND_CANCEL: u8 = 0x10;
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

// Exec payload flags.
pub const EXEC_FLAG_SUDO: u8 = 0x01;

// Spawn-watch payload flags.
pub const SPAWN_WATCH_FLAG_SUDO: u8 = 0x01;
pub const SPAWN_WATCH_FLAG_STREAM_STDOUT: u8 = 0x02;

// Command operation payload flags.
pub const COMMAND_FLAG_SUDO: u8 = 0x01;
pub const COMMAND_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;
pub const COMMAND_CAPTURED_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;

// Write-file payload flags.
pub const WRITE_FILE_FLAG_SUDO: u8 = 0x01;
pub const WRITE_FILE_FLAG_APPEND: u8 = 0x02;

const MAX_PAYLOAD_SIZE: usize = MAX_MESSAGE_SIZE - MIN_BODY_SIZE;

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
    pub stdout: CommandOutputPolicy,
    pub stderr: CommandOutputPolicy,
    pub label: &'a str,
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

/// Protocol error.
#[derive(Debug, Clone)]
pub enum ProtocolError {
    MessageTooLarge(usize),
    MessageTooSmall(usize),
    InvalidPayload(&'static str),
    PayloadTooLarge(&'static str, usize),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MessageTooLarge(size) => write!(f, "message too large: {size}"),
            Self::MessageTooSmall(size) => write!(f, "message too small: {size}"),
            Self::InvalidPayload(msg) => write!(f, "invalid payload: {msg}"),
            Self::PayloadTooLarge(field, size) => {
                write!(f, "payload field too large: {field} ({size} bytes)")
            }
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Read a `u8` from `data` at `offset`. Returns `None` if out of bounds.
fn read_u8_at(data: &[u8], offset: usize) -> Option<u8> {
    data.get(offset).copied()
}

/// Read a `u16` from `data` at `offset`. Returns `None` if out of bounds.
fn read_u16_at(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let bytes: [u8; 2] = data.get(offset..end)?.try_into().ok()?;
    Some(u16::from_be_bytes(bytes))
}

/// Read a `u32` from `data` at `offset`. Returns `None` if out of bounds.
fn read_u32_at(data: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let bytes: [u8; 4] = data.get(offset..end)?.try_into().ok()?;
    Some(u32::from_be_bytes(bytes))
}

/// Read an `i32` from `data` at `offset`. Returns `None` if out of bounds.
fn read_i32_at(data: &[u8], offset: usize) -> Option<i32> {
    let end = offset.checked_add(4)?;
    let bytes: [u8; 4] = data.get(offset..end)?.try_into().ok()?;
    Some(i32::from_be_bytes(bytes))
}

fn ensure_payload_fits_message(payload_len: usize) -> Result<(), ProtocolError> {
    let body_len = MIN_BODY_SIZE
        .checked_add(payload_len)
        .ok_or(ProtocolError::MessageTooLarge(usize::MAX))?;
    if payload_len > MAX_PAYLOAD_SIZE || body_len > MAX_MESSAGE_SIZE {
        return Err(ProtocolError::MessageTooLarge(body_len));
    }
    Ok(())
}

fn checked_payload_len_add(total: usize, add: usize) -> Result<usize, ProtocolError> {
    total
        .checked_add(add)
        .ok_or(ProtocolError::MessageTooLarge(usize::MAX))
}

fn ensure_u16_len(field: &'static str, len: usize) -> Result<u16, ProtocolError> {
    if len > u16::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge(field, len));
    }
    Ok(len as u16)
}

fn ensure_u32_len(field: &'static str, len: usize) -> Result<u32, ProtocolError> {
    if len > u32::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge(field, len));
    }
    Ok(len as u32)
}

fn read_u8(payload: &[u8], offset: &mut usize, err: &'static str) -> Result<u8, ProtocolError> {
    let value = read_u8_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 1;
    Ok(value)
}

fn read_u16(payload: &[u8], offset: &mut usize, err: &'static str) -> Result<u16, ProtocolError> {
    let value = read_u16_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 2;
    Ok(value)
}

fn read_u32(payload: &[u8], offset: &mut usize, err: &'static str) -> Result<u32, ProtocolError> {
    let value = read_u32_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 4;
    Ok(value)
}

fn read_i32(payload: &[u8], offset: &mut usize, err: &'static str) -> Result<i32, ProtocolError> {
    let value = read_i32_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 4;
    Ok(value)
}

fn read_slice<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len: usize,
    err: &'static str,
) -> Result<&'a [u8], ProtocolError> {
    let end = (*offset)
        .checked_add(len)
        .ok_or(ProtocolError::InvalidPayload(err))?;
    let slice = payload
        .get(*offset..end)
        .ok_or(ProtocolError::InvalidPayload(err))?;
    *offset = end;
    Ok(slice)
}

fn read_str<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len: usize,
    truncated_err: &'static str,
    utf8_err: &'static str,
) -> Result<&'a str, ProtocolError> {
    std::str::from_utf8(read_slice(payload, offset, len, truncated_err)?)
        .map_err(|_| ProtocolError::InvalidPayload(utf8_err))
}

fn expect_consumed(payload: &[u8], offset: usize, err: &'static str) -> Result<(), ProtocolError> {
    if offset != payload.len() {
        return Err(ProtocolError::InvalidPayload(err));
    }
    Ok(())
}

/// A raw decoded message.
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub msg_type: u8,
    pub seq: u32,
    pub payload: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/// Encode a raw message: `[4-byte length][1-byte type][4-byte seq][payload]`.
pub fn encode(msg_type: u8, seq: u32, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let body_len = 1 + 4 + payload.len();
    if body_len > MAX_MESSAGE_SIZE {
        return Err(ProtocolError::MessageTooLarge(body_len));
    }
    let mut buf = Vec::with_capacity(HEADER_SIZE + body_len);
    buf.extend_from_slice(&(body_len as u32).to_be_bytes());
    buf.push(msg_type);
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.extend_from_slice(payload);
    Ok(buf)
}

/// Encode exec payload: `[4B timeout_ms][1B flags][4B cmd_len][command]([4B env_count]([4B key_len][key][4B val_len][value])*)`.
///
/// The env section is only appended when `env` is non-empty, keeping the
/// payload backward-compatible with old decoders that don't expect it.
pub fn encode_exec(timeout_ms: u32, command: &str, env: &[(&str, &str)], sudo: bool) -> Vec<u8> {
    let cmd = command.as_bytes();
    let env_size: usize = if env.is_empty() {
        0
    } else {
        4 + env
            .iter()
            .map(|(k, v)| 8 + k.len() + v.len())
            .sum::<usize>()
    };
    let mut p = Vec::with_capacity(9 + cmd.len() + env_size);
    p.extend_from_slice(&timeout_ms.to_be_bytes());
    p.push(if sudo { EXEC_FLAG_SUDO } else { 0 });
    p.extend_from_slice(&(cmd.len() as u32).to_be_bytes());
    p.extend_from_slice(cmd);
    if !env.is_empty() {
        p.extend_from_slice(&(env.len() as u32).to_be_bytes());
        for (key, val) in env {
            let kb = key.as_bytes();
            let vb = val.as_bytes();
            p.extend_from_slice(&(kb.len() as u32).to_be_bytes());
            p.extend_from_slice(kb);
            p.extend_from_slice(&(vb.len() as u32).to_be_bytes());
            p.extend_from_slice(vb);
        }
    }
    p
}

/// Encode spawn_watch payload: exec fields + optional `[2B log_path_len][log_path]`.
///
/// `stream_stdout` controls whether stdout is streamed to the host via
/// `MSG_STDOUT_CHUNK`. `stdout_log_path`, when present, additionally asks
/// the guest to tee streamed stdout to that file.
///
/// Unlike `encode_exec`, this always writes the env section (even when empty)
/// so `decode_spawn_watch` can unambiguously find the log_path boundary.
pub fn encode_spawn_watch(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    stream_stdout: bool,
    stdout_log_path: Option<&str>,
) -> Result<Vec<u8>, ProtocolError> {
    if !stream_stdout && stdout_log_path.is_some() {
        return Err(ProtocolError::InvalidPayload(
            "spawn_watch log_path requires stream flag",
        ));
    }
    let cmd = command.as_bytes();
    let env_size: usize = 4 + env
        .iter()
        .map(|(k, v)| 8 + k.len() + v.len())
        .sum::<usize>();
    let log_path = match stdout_log_path {
        Some("") => {
            return Err(ProtocolError::InvalidPayload("spawn_watch log_path empty"));
        }
        Some(path) if path.len() > u16::MAX as usize => {
            return Err(ProtocolError::PayloadTooLarge("log_path", path.len()));
        }
        Some(path) => Some((path.as_bytes(), path.len() as u16)),
        None => None,
    };
    let log_size = log_path.map_or(0, |(_, len)| 2 + len as usize);
    let mut p = Vec::with_capacity(9 + cmd.len() + env_size + log_size);
    p.extend_from_slice(&timeout_ms.to_be_bytes());
    let mut flags = if sudo { SPAWN_WATCH_FLAG_SUDO } else { 0 };
    if stream_stdout {
        flags |= SPAWN_WATCH_FLAG_STREAM_STDOUT;
    }
    p.push(flags);
    p.extend_from_slice(&(cmd.len() as u32).to_be_bytes());
    p.extend_from_slice(cmd);
    // Always write env_count so the decoder knows where env ends.
    p.extend_from_slice(&(env.len() as u32).to_be_bytes());
    for (key, val) in env {
        let kb = key.as_bytes();
        let vb = val.as_bytes();
        p.extend_from_slice(&(kb.len() as u32).to_be_bytes());
        p.extend_from_slice(kb);
        p.extend_from_slice(&(vb.len() as u32).to_be_bytes());
        p.extend_from_slice(vb);
    }
    if let Some((path_bytes, path_len)) = log_path {
        p.extend_from_slice(&path_len.to_be_bytes());
        p.extend_from_slice(path_bytes);
    }
    Ok(p)
}

/// Encode exec_result payload: `[4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]`.
pub fn encode_exec_result(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(12 + stdout.len() + stderr.len());
    p.extend_from_slice(&exit_code.to_be_bytes());
    append_output_pair(&mut p, stdout, stderr);
    p
}

fn append_output_pair(p: &mut Vec<u8>, stdout: &[u8], stderr: &[u8]) {
    p.extend_from_slice(&(stdout.len() as u32).to_be_bytes());
    p.extend_from_slice(stdout);
    p.extend_from_slice(&(stderr.len() as u32).to_be_bytes());
    p.extend_from_slice(stderr);
}

/// Encode write_file payload: `[2B path_len][path][1B flags][4B content_len][content]`.
///
/// Returns `Err` if path exceeds 65535 bytes (u16 field limit).
/// Total message size is validated by [`encode`].
pub fn encode_write_file(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let path_bytes = path.as_bytes();
    if path_bytes.len() > u16::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge("path", path_bytes.len()));
    }
    let path_len = path_bytes.len() as u16;
    let mut flags = 0u8;
    if sudo {
        flags |= WRITE_FILE_FLAG_SUDO;
    }
    if append {
        flags |= WRITE_FILE_FLAG_APPEND;
    }
    let mut p = Vec::with_capacity(7 + path_len as usize + content.len());
    p.extend_from_slice(&path_len.to_be_bytes());
    p.extend_from_slice(path_bytes);
    p.push(flags);
    p.extend_from_slice(&(content.len() as u32).to_be_bytes());
    p.extend_from_slice(content);
    Ok(p)
}

/// Encode write_file_result payload: `[1B success][2B error_len][error]`.
///
/// Error message is truncated to 65535 bytes if longer.
pub fn encode_write_file_result(success: bool, error: &str) -> Vec<u8> {
    let err = error.as_bytes();
    let err_len = err.len().min(u16::MAX as usize) as u16;
    let mut p = Vec::with_capacity(3 + err_len as usize);
    p.push(u8::from(success));
    p.extend_from_slice(&err_len.to_be_bytes());
    // err_len <= err.len() is guaranteed by .min() above
    p.extend_from_slice(err.get(..err_len as usize).unwrap_or(err));
    p
}

/// Encode spawn_watch_result payload: `[4B pid]`.
pub fn encode_spawn_watch_result(pid: u32) -> Vec<u8> {
    pid.to_be_bytes().to_vec()
}

/// Encode process_exit payload: `[4B pid][4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]`.
pub fn encode_process_exit(pid: u32, exit_code: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(16 + stdout.len() + stderr.len());
    p.extend_from_slice(&pid.to_be_bytes());
    p.extend_from_slice(&exit_code.to_be_bytes());
    append_output_pair(&mut p, stdout, stderr);
    p
}

/// Encode stdout_chunk payload: `[4B pid][data]`.
pub fn encode_stdout_chunk(pid: u32, data: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(4 + data.len());
    p.extend_from_slice(&pid.to_be_bytes());
    p.extend_from_slice(data);
    p
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
/// `[4B timeout_ms][1B flags][4B cmd_len][command][4B env_count]... [stdout_policy][stderr_policy][2B label_len][label]`.
pub fn encode_command_start(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    stdout: CommandOutputPolicy,
    stderr: CommandOutputPolicy,
    label: &str,
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
    payload_len = checked_payload_len_add(payload_len, stdout_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, label_bytes.len())?;
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
    append_command_output_policy(&mut p, stdout);
    append_command_output_policy(&mut p, stderr);
    p.extend_from_slice(&label_len.to_be_bytes());
    p.extend_from_slice(label_bytes);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

/// Encode command_output payload: `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]`.
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

/// Encode error payload: `[2B error_len][error]`.
///
/// Error message is truncated to 65535 bytes if longer.
pub fn encode_error(message: &str) -> Vec<u8> {
    let msg = message.as_bytes();
    let msg_len = msg.len().min(u16::MAX as usize) as u16;
    let mut p = Vec::with_capacity(2 + msg_len as usize);
    p.extend_from_slice(&msg_len.to_be_bytes());
    // msg_len <= msg.len() is guaranteed by .min() above
    p.extend_from_slice(msg.get(..msg_len as usize).unwrap_or(msg));
    p
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

struct DecodedExecInner<'a> {
    exec: DecodedExec<'a>,
    offset: usize,
    raw_flags: u8,
}

/// Decode exec/spawn_watch shared fields.
///
/// The env section is optional: if the payload ends right after the command,
/// an empty vec is returned (backward-compatible with old encoders).
fn decode_exec_inner(payload: &[u8], sudo_flag: u8) -> Result<DecodedExecInner<'_>, ProtocolError> {
    let timeout_ms =
        read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("exec payload too short"))?;
    let flags =
        read_u8_at(payload, 4).ok_or(ProtocolError::InvalidPayload("exec payload too short"))?;
    let sudo = (flags & sudo_flag) != 0;
    let cmd_len = read_u32_at(payload, 5)
        .ok_or(ProtocolError::InvalidPayload("exec payload too short"))? as usize;
    let command = std::str::from_utf8(
        payload
            .get(9..9 + cmd_len)
            .ok_or(ProtocolError::InvalidPayload("exec command truncated"))?,
    )
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in command"))?;

    let env_start = 9 + cmd_len;
    if env_start >= payload.len() {
        return Ok(DecodedExecInner {
            exec: DecodedExec {
                timeout_ms,
                command,
                env: Vec::new(),
                sudo,
            },
            offset: env_start,
            raw_flags: flags,
        });
    }

    let env_count = read_u32_at(payload, env_start)
        .ok_or(ProtocolError::InvalidPayload("exec env count truncated"))?
        as usize;
    // Do not pre-allocate based on env_count: it is untrusted wire data and a
    // malformed message can claim u32::MAX pairs. The per-iteration bounds
    // checks below return an error as soon as the payload runs out.
    let mut env = Vec::new();
    let mut offset = env_start + 4;
    for _ in 0..env_count {
        let key_len = read_u32_at(payload, offset)
            .ok_or(ProtocolError::InvalidPayload("exec env key_len truncated"))?
            as usize;
        offset += 4;
        let key = std::str::from_utf8(
            payload
                .get(offset..offset + key_len)
                .ok_or(ProtocolError::InvalidPayload("exec env key truncated"))?,
        )
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in env key"))?;
        offset += key_len;

        let val_len = read_u32_at(payload, offset)
            .ok_or(ProtocolError::InvalidPayload("exec env val_len truncated"))?
            as usize;
        offset += 4;
        let val = std::str::from_utf8(
            payload
                .get(offset..offset + val_len)
                .ok_or(ProtocolError::InvalidPayload("exec env value truncated"))?,
        )
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in env value"))?;
        offset += val_len;

        env.push((key, val));
    }

    Ok(DecodedExecInner {
        exec: DecodedExec {
            timeout_ms,
            command,
            env,
            sudo,
        },
        offset,
        raw_flags: flags,
    })
}

/// Decode exec payload into a [`DecodedExec`] struct.
pub fn decode_exec(payload: &[u8]) -> Result<DecodedExec<'_>, ProtocolError> {
    decode_exec_inner(payload, EXEC_FLAG_SUDO).map(|d| d.exec)
}

/// Decode spawn_watch payload. Extends exec fields with streaming metadata.
///
/// Wire format: `[exec fields...]([2B log_path_len][log_path])`.
/// The log_path section is optional — if the payload ends after the exec
/// fields, `stdout_log_path` is `None`.
pub fn decode_spawn_watch(payload: &[u8]) -> Result<DecodedSpawnWatch<'_>, ProtocolError> {
    let DecodedExecInner {
        exec,
        offset,
        raw_flags,
    } = decode_exec_inner(payload, SPAWN_WATCH_FLAG_SUDO)?;
    let stream_flag = (raw_flags & SPAWN_WATCH_FLAG_STREAM_STDOUT) != 0;
    let stdout_log_path = if offset == payload.len() {
        None
    } else if offset + 2 <= payload.len() {
        let path_len = read_u16_at(payload, offset).ok_or(ProtocolError::InvalidPayload(
            "spawn_watch log_path_len truncated",
        ))? as usize;
        if path_len == 0 {
            return Err(ProtocolError::InvalidPayload("spawn_watch log_path empty"));
        } else {
            let path_end = offset + 2 + path_len;
            if path_end != payload.len() {
                return Err(ProtocolError::InvalidPayload("spawn_watch trailing bytes"));
            }
            Some(
                std::str::from_utf8(payload.get(offset + 2..path_end).ok_or(
                    ProtocolError::InvalidPayload("spawn_watch log_path truncated"),
                )?)
                .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in log_path"))?,
            )
        }
    } else {
        return Err(ProtocolError::InvalidPayload(
            "spawn_watch trailing byte after env",
        ));
    };
    if !stream_flag && stdout_log_path.is_some() {
        return Err(ProtocolError::InvalidPayload(
            "spawn_watch log_path requires stream flag",
        ));
    }
    Ok(DecodedSpawnWatch {
        exec,
        stream_stdout: stream_flag,
        stdout_log_path,
    })
}

/// Decode exec_result payload. Returns `(exit_code, stdout, stderr)`.
pub fn decode_exec_result(payload: &[u8]) -> Result<(i32, &[u8], &[u8]), ProtocolError> {
    let exit_code =
        read_i32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("exec_result too short"))?;
    let (stdout, stderr) = decode_output_pair_at(payload, 4, OutputPairContext::ExecResult)?;
    Ok((exit_code, stdout, stderr))
}

#[derive(Clone, Copy)]
enum OutputPairContext {
    ExecResult,
    ProcessExit,
}

impl OutputPairContext {
    fn too_short(self) -> &'static str {
        match self {
            Self::ExecResult => "exec_result too short",
            Self::ProcessExit => "process_exit too short",
        }
    }

    fn stdout_truncated(self) -> &'static str {
        match self {
            Self::ExecResult => "exec_result stdout truncated",
            Self::ProcessExit => "process_exit stdout truncated",
        }
    }

    fn stderr_truncated(self) -> &'static str {
        match self {
            Self::ExecResult => "exec_result stderr truncated",
            Self::ProcessExit => "process_exit stderr truncated",
        }
    }
}

fn decode_output_pair_at(
    payload: &[u8],
    offset: usize,
    ctx: OutputPairContext,
) -> Result<(&[u8], &[u8]), ProtocolError> {
    let stdout_len = read_u32_at(payload, offset)
        .ok_or(ProtocolError::InvalidPayload(ctx.too_short()))? as usize;
    let stdout_start = offset
        .checked_add(4)
        .ok_or(ProtocolError::InvalidPayload(ctx.stdout_truncated()))?;
    let stderr_len_offset = stdout_start
        .checked_add(stdout_len)
        .ok_or(ProtocolError::InvalidPayload(ctx.stdout_truncated()))?;
    let stdout = payload
        .get(stdout_start..stderr_len_offset)
        .ok_or(ProtocolError::InvalidPayload(ctx.stdout_truncated()))?;
    let stderr_len = read_u32_at(payload, stderr_len_offset)
        .ok_or(ProtocolError::InvalidPayload(ctx.too_short()))? as usize;
    let stderr_start = stderr_len_offset
        .checked_add(4)
        .ok_or(ProtocolError::InvalidPayload(ctx.stderr_truncated()))?;
    let stderr_end = stderr_start
        .checked_add(stderr_len)
        .ok_or(ProtocolError::InvalidPayload(ctx.stderr_truncated()))?;
    let stderr = payload
        .get(stderr_start..stderr_end)
        .ok_or(ProtocolError::InvalidPayload(ctx.stderr_truncated()))?;
    Ok((stdout, stderr))
}

/// Decode write_file payload. Returns `(path, content, sudo, append)`.
pub fn decode_write_file(payload: &[u8]) -> Result<(&str, &[u8], bool, bool), ProtocolError> {
    let path_len = read_u16_at(payload, 0)
        .ok_or(ProtocolError::InvalidPayload("write_file too short"))? as usize;
    let path = std::str::from_utf8(
        payload
            .get(2..2 + path_len)
            .ok_or(ProtocolError::InvalidPayload("write_file path truncated"))?,
    )
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in path"))?;
    let flags = read_u8_at(payload, 2 + path_len)
        .ok_or(ProtocolError::InvalidPayload("write_file too short"))?;
    let content_len = read_u32_at(payload, 3 + path_len)
        .ok_or(ProtocolError::InvalidPayload("write_file too short"))?
        as usize;
    let content = payload
        .get(7 + path_len..7 + path_len + content_len)
        .ok_or(ProtocolError::InvalidPayload(
            "write_file content truncated",
        ))?;
    Ok((
        path,
        content,
        (flags & WRITE_FILE_FLAG_SUDO) != 0,
        (flags & WRITE_FILE_FLAG_APPEND) != 0,
    ))
}

/// Decode write_file_result payload. Returns `(success, error)`.
pub fn decode_write_file_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    let success = read_u8_at(payload, 0)
        .ok_or(ProtocolError::InvalidPayload("write_file_result too short"))?
        == 1;
    let err_len = read_u16_at(payload, 1)
        .ok_or(ProtocolError::InvalidPayload("write_file_result too short"))?
        as usize;
    let error = std::str::from_utf8(payload.get(3..3 + err_len).ok_or(
        ProtocolError::InvalidPayload("write_file_result error truncated"),
    )?)
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in error"))?;
    Ok((success, error))
}

/// Decode spawn_watch_result payload. Returns `pid`.
pub fn decode_spawn_watch_result(payload: &[u8]) -> Result<u32, ProtocolError> {
    read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload(
        "spawn_watch_result too short",
    ))
}

/// Decoded exec/spawn_watch fields.
pub struct DecodedExec<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: Vec<(&'a str, &'a str)>,
    pub sudo: bool,
}

/// Decoded spawn_watch fields: exec fields + stdout streaming options.
pub struct DecodedSpawnWatch<'a> {
    pub exec: DecodedExec<'a>,
    /// Whether vsock-guest should stream stdout chunks to the host.
    pub stream_stdout: bool,
    /// Optional guest-side file path where vsock-guest also tees stdout.
    pub stdout_log_path: Option<&'a str>,
}

/// Decoded process_exit fields: `(pid, exit_code, stdout, stderr)`.
pub type ProcessExit<'a> = (u32, i32, &'a [u8], &'a [u8]);

/// Decode process_exit payload. Returns `(pid, exit_code, stdout, stderr)`.
pub fn decode_process_exit(payload: &[u8]) -> Result<ProcessExit<'_>, ProtocolError> {
    let pid =
        read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("process_exit too short"))?;
    let exit_code =
        read_i32_at(payload, 4).ok_or(ProtocolError::InvalidPayload("process_exit too short"))?;
    let (stdout, stderr) = decode_output_pair_at(payload, 8, OutputPairContext::ProcessExit)?;
    Ok((pid, exit_code, stdout, stderr))
}

/// Decode stdout_chunk payload. Returns `(pid, data)`.
pub fn decode_stdout_chunk(payload: &[u8]) -> Result<(u32, &[u8]), ProtocolError> {
    let pid =
        read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("stdout_chunk too short"))?;
    let data = payload.get(4..).unwrap_or_default();
    Ok((pid, data))
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
    let stdout = decode_command_output_policy(payload, &mut offset)?;
    let stderr = decode_command_output_policy(payload, &mut offset)?;
    let label_len = read_u16(payload, &mut offset, "command start label_len truncated")? as usize;
    let label = read_str(
        payload,
        &mut offset,
        label_len,
        "command start label truncated",
        "invalid UTF-8 in label",
    )?;
    expect_consumed(payload, offset, "command start trailing bytes")?;
    Ok(DecodedCommandStart {
        timeout_ms,
        command,
        env,
        sudo: (flags & COMMAND_FLAG_SUDO) != 0,
        stdout,
        stderr,
        label,
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

/// Decode error payload. Returns the error message.
pub fn decode_error(payload: &[u8]) -> Result<&str, ProtocolError> {
    let msg_len = read_u16_at(payload, 0)
        .ok_or(ProtocolError::InvalidPayload("error payload too short"))?
        as usize;
    std::str::from_utf8(
        payload
            .get(2..2 + msg_len)
            .ok_or(ProtocolError::InvalidPayload("error message truncated"))?,
    )
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in error"))
}

// ---------------------------------------------------------------------------
// Decoder (buffered, handles partial reads)
// ---------------------------------------------------------------------------

/// Buffered message decoder for streaming data.
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(64 * 1024),
        }
    }

    /// Feed data and extract complete messages.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<RawMessage>, ProtocolError> {
        self.buf.extend_from_slice(data);
        let mut messages = Vec::new();
        let mut offset = 0;

        while offset + HEADER_SIZE <= self.buf.len() {
            let length = match read_u32_at(&self.buf, offset) {
                Some(v) => v as usize,
                None => break,
            };

            if length > MAX_MESSAGE_SIZE {
                self.buf.clear();
                return Err(ProtocolError::MessageTooLarge(length));
            }
            if length < MIN_BODY_SIZE {
                self.buf.clear();
                return Err(ProtocolError::MessageTooSmall(length));
            }

            let total = HEADER_SIZE + length;
            if offset + total > self.buf.len() {
                break;
            }

            let msg_type = match read_u8_at(&self.buf, offset + HEADER_SIZE) {
                Some(v) => v,
                None => break,
            };
            let seq = match read_u32_at(&self.buf, offset + HEADER_SIZE + 1) {
                Some(v) => v,
                None => break,
            };
            let payload = self
                .buf
                .get(offset + HEADER_SIZE + MIN_BODY_SIZE..offset + total)
                .unwrap_or_default()
                .to_vec();

            messages.push(RawMessage {
                msg_type,
                seq,
                payload,
            });
            offset += total;
        }

        // Compact: remove consumed bytes once at the end
        if offset > 0 {
            self.buf.drain(..offset);
        }

        Ok(messages)
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip_empty_payload() {
        let data = encode(MSG_PING, 1, &[]).unwrap();
        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_PING);
        assert_eq!(msgs[0].seq, 1);
        assert!(msgs[0].payload.is_empty());
    }

    #[test]
    fn encode_decode_roundtrip_with_payload() {
        let data = encode(MSG_EXEC, 42, b"hello world").unwrap();
        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_EXEC);
        assert_eq!(msgs[0].seq, 42);
        assert_eq!(msgs[0].payload, b"hello world");
    }

    #[test]
    fn decoder_handles_partial_reads() {
        let data = encode(MSG_PONG, 7, &[]).unwrap();
        let mut dec = Decoder::new();

        // Feed first 4 bytes (header only)
        let msgs = dec.decode(&data[..4]).unwrap();
        assert!(msgs.is_empty());

        // Feed the rest
        let msgs = dec.decode(&data[4..]).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_PONG);
        assert_eq!(msgs[0].seq, 7);
    }

    #[test]
    fn decoder_handles_multiple_messages() {
        let mut data = encode(MSG_PING, 1, &[]).unwrap();
        data.extend_from_slice(&encode(MSG_PONG, 1, &[]).unwrap());
        data.extend_from_slice(&encode(MSG_READY, 0, &[]).unwrap());

        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].msg_type, MSG_PING);
        assert_eq!(msgs[1].msg_type, MSG_PONG);
        assert_eq!(msgs[2].msg_type, MSG_READY);
    }

    #[test]
    fn decoder_rejects_too_large() {
        // Craft a header claiming 17MB body
        let bad = (17 * 1024 * 1024_u32).to_be_bytes();
        let mut dec = Decoder::new();
        let err = dec.decode(&bad).unwrap_err();
        assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    }

    #[test]
    fn decoder_rejects_too_small() {
        // Body length 2 (less than MIN_BODY_SIZE=5)
        let bad = 2_u32.to_be_bytes();
        let mut dec = Decoder::new();
        let err = dec.decode(&bad).unwrap_err();
        assert!(matches!(err, ProtocolError::MessageTooSmall(2)));
    }

    #[test]
    fn exec_payload_roundtrip() {
        let payload = encode_exec(5000, "echo hello", &[], false);
        let d = decode_exec(&payload).unwrap();
        assert_eq!(d.timeout_ms, 5000);
        assert_eq!(d.command, "echo hello");
        assert!(d.env.is_empty());
        assert!(!d.sudo);
    }

    #[test]
    fn exec_payload_roundtrip_with_sudo() {
        let payload = encode_exec(5000, "date -s @123", &[], true);
        let d = decode_exec(&payload).unwrap();
        assert_eq!(d.timeout_ms, 5000);
        assert_eq!(d.command, "date -s @123");
        assert!(d.env.is_empty());
        assert!(d.sudo);
    }

    #[test]
    fn exec_payload_roundtrip_with_env() {
        let env_vars = [("PATH", "/usr/bin"), ("HOME", "/home/user")];
        let payload = encode_exec(3000, "ls", &env_vars, false);
        let d = decode_exec(&payload).unwrap();
        assert_eq!(d.timeout_ms, 3000);
        assert_eq!(d.command, "ls");
        assert_eq!(d.env, vec![("PATH", "/usr/bin"), ("HOME", "/home/user")]);
        assert!(!d.sudo);
    }

    #[test]
    fn exec_result_payload_roundtrip() {
        let payload = encode_exec_result(0, b"out", b"err");
        let (code, stdout, stderr) = decode_exec_result(&payload).unwrap();
        assert_eq!(code, 0);
        assert_eq!(stdout, b"out");
        assert_eq!(stderr, b"err");
    }

    #[test]
    fn exec_result_empty_output() {
        let payload = encode_exec_result(1, &[], &[]);
        let (code, stdout, stderr) = decode_exec_result(&payload).unwrap();
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }

    #[test]
    fn write_file_payload_roundtrip() {
        let payload = encode_write_file("/tmp/test.txt", b"content", false, false).unwrap();
        let (path, content, sudo, append) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/test.txt");
        assert_eq!(content, b"content");
        assert!(!sudo);
        assert!(!append);
    }

    #[test]
    fn write_file_with_sudo() {
        let payload = encode_write_file("/etc/hosts", b"127.0.0.1", true, false).unwrap();
        let (path, content, sudo, append) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/etc/hosts");
        assert_eq!(content, b"127.0.0.1");
        assert!(sudo);
        assert!(!append);
    }

    #[test]
    fn write_file_with_append() {
        let payload = encode_write_file("/tmp/out.log", b"more data", false, true).unwrap();
        let (path, content, sudo, append) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/out.log");
        assert_eq!(content, b"more data");
        assert!(!sudo);
        assert!(append);
    }

    #[test]
    fn write_file_with_sudo_and_append() {
        let payload = encode_write_file("/etc/conf", b"line", true, true).unwrap();
        let (_, _, sudo, append) = decode_write_file(&payload).unwrap();
        assert!(sudo);
        assert!(append);
    }

    #[test]
    fn write_file_path_too_long() {
        let long_path = "a".repeat(65536);
        let err = encode_write_file(&long_path, b"", false, false).unwrap_err();
        assert!(matches!(err, ProtocolError::PayloadTooLarge("path", 65536)));
    }

    #[test]
    fn write_file_content_too_large() {
        let big = vec![0u8; MAX_MESSAGE_SIZE];
        let payload = encode_write_file("/tmp/f", &big, false, false).unwrap();
        let err = encode(MSG_WRITE_FILE, 1, &payload).unwrap_err();
        assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    }

    #[test]
    fn write_file_result_roundtrip() {
        let payload = encode_write_file_result(true, "");
        let (success, error) = decode_write_file_result(&payload).unwrap();
        assert!(success);
        assert!(error.is_empty());

        let payload = encode_write_file_result(false, "permission denied");
        let (success, error) = decode_write_file_result(&payload).unwrap();
        assert!(!success);
        assert_eq!(error, "permission denied");
    }

    #[test]
    fn spawn_watch_result_roundtrip() {
        let payload = encode_spawn_watch_result(12345);
        let pid = decode_spawn_watch_result(&payload).unwrap();
        assert_eq!(pid, 12345);
    }

    #[test]
    fn spawn_watch_payload_roundtrip_with_log_path() {
        let payload = encode_spawn_watch(
            5000,
            "echo hello",
            &[("FOO", "bar")],
            false,
            true,
            Some("/tmp/vm0-system-123.log"),
        )
        .unwrap();
        let d = decode_spawn_watch(&payload).unwrap();
        assert_eq!(d.exec.timeout_ms, 5000);
        assert_eq!(d.exec.command, "echo hello");
        assert_eq!(d.exec.env, vec![("FOO", "bar")]);
        assert!(!d.exec.sudo);
        assert!(d.stream_stdout);
        assert_eq!(d.stdout_log_path.unwrap(), "/tmp/vm0-system-123.log");
    }

    #[test]
    fn spawn_watch_payload_roundtrip_stream_only() {
        let payload = encode_spawn_watch(3000, "ls", &[], true, true, None).unwrap();
        let d = decode_spawn_watch(&payload).unwrap();
        assert_eq!(d.exec.timeout_ms, 3000);
        assert_eq!(d.exec.command, "ls");
        assert!(d.exec.env.is_empty());
        assert!(d.exec.sudo);
        assert!(d.stream_stdout);
        assert!(d.stdout_log_path.is_none());
    }

    #[test]
    fn spawn_watch_payload_roundtrip_buffered() {
        let payload = encode_spawn_watch(1000, "cmd", &[], false, false, None).unwrap();
        let d = decode_spawn_watch(&payload).unwrap();
        assert_eq!(d.exec.command, "cmd");
        assert!(!d.stream_stdout);
        assert!(d.stdout_log_path.is_none());
    }

    #[test]
    fn spawn_watch_log_path_requires_streaming() {
        let err = encode_spawn_watch(1000, "cmd", &[], false, false, Some("/tmp/log")).unwrap_err();
        assert!(matches!(err, ProtocolError::InvalidPayload(_)));
    }

    #[test]
    fn spawn_watch_log_path_too_long() {
        let long_path = "x".repeat(u16::MAX as usize + 1);
        let err = encode_spawn_watch(1000, "cmd", &[], false, true, Some(&long_path)).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::PayloadTooLarge("log_path", size) if size == long_path.len()
        ));
    }

    fn decode_spawn_watch_error(payload: &[u8]) -> ProtocolError {
        match decode_spawn_watch(payload) {
            Ok(_) => panic!("expected spawn_watch payload to be rejected"),
            Err(e) => e,
        }
    }

    #[test]
    fn decode_spawn_watch_rejects_empty_log_path() {
        let mut payload = encode_spawn_watch(1000, "cmd", &[], false, true, None).unwrap();
        payload.extend_from_slice(&0u16.to_be_bytes());

        let err = decode_spawn_watch_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_watch log_path empty")
        ));
    }

    #[test]
    fn decode_spawn_watch_rejects_trailing_byte_after_env() {
        let mut payload = encode_spawn_watch(1000, "cmd", &[], false, true, None).unwrap();
        payload.push(0xFF);

        let err = decode_spawn_watch_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_watch trailing byte after env")
        ));
    }

    #[test]
    fn decode_spawn_watch_rejects_trailing_bytes_after_log_path() {
        let mut payload =
            encode_spawn_watch(1000, "cmd", &[], false, true, Some("/tmp/log")).unwrap();
        payload.push(0xFF);

        let err = decode_spawn_watch_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_watch trailing bytes")
        ));
    }

    #[test]
    fn decode_spawn_watch_rejects_log_path_without_stream_flag() {
        let mut payload = encode_spawn_watch(1000, "cmd", &[], false, false, None).unwrap();
        let path = b"/tmp/log";
        payload.extend_from_slice(&(path.len() as u16).to_be_bytes());
        payload.extend_from_slice(path);

        let err = decode_spawn_watch_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_watch log_path requires stream flag")
        ));
    }

    #[test]
    fn process_exit_roundtrip() {
        let payload = encode_process_exit(999, 137, b"output", b"killed");
        let (pid, code, stdout, stderr) = decode_process_exit(&payload).unwrap();
        assert_eq!(pid, 999);
        assert_eq!(code, 137);
        assert_eq!(stdout, b"output");
        assert_eq!(stderr, b"killed");
    }

    #[test]
    fn error_payload_roundtrip() {
        let payload = encode_error("something went wrong");
        let msg = decode_error(&payload).unwrap();
        assert_eq!(msg, "something went wrong");
    }

    #[test]
    fn stdout_chunk_roundtrip() {
        let payload = encode_stdout_chunk(42, b"hello world");
        let (pid, data) = decode_stdout_chunk(&payload).unwrap();
        assert_eq!(pid, 42);
        assert_eq!(data, b"hello world");
    }

    #[test]
    fn stdout_chunk_empty_data() {
        let payload = encode_stdout_chunk(1, &[]);
        let (pid, data) = decode_stdout_chunk(&payload).unwrap();
        assert_eq!(pid, 1);
        assert!(data.is_empty());
    }

    #[test]
    fn command_start_roundtrip_discard_policies() {
        let payload = encode_command_start(
            5000,
            "echo ready",
            &[],
            false,
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
                stdout: CommandOutputPolicy::Discard,
                stderr: CommandOutputPolicy::Discard,
                label: "",
            }
        );
    }

    #[test]
    fn command_start_roundtrip_env_sudo_label_and_capture() {
        let payload = encode_command_start(
            3000,
            "printenv",
            &[("PATH", "/usr/bin"), ("HOME", "/home/user")],
            true,
            CommandOutputPolicy::Capture { limit_bytes: 0 },
            CommandOutputPolicy::Capture { limit_bytes: 4096 },
            "setup",
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
            CommandOutputPolicy::Stream {
                limit_bytes: 0,
                chunk_limit_bytes: 8192,
            },
            CommandOutputPolicy::Discard,
            "stream",
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
            "combined",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
        )
        .unwrap();
        let label_offset = payload.len() - 2;
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "ok",
        )
        .unwrap();
        payload.truncate(payload.len() - 1);
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
        )
        .unwrap();
        let stdout_policy_offset = 4 + 1 + 4 + "cmd".len() + 4;
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
            CommandOutputPolicy::Stream {
                limit_bytes: 1,
                chunk_limit_bytes: 0,
            },
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Stream {
                limit_bytes: 1,
                chunk_limit_bytes: 1,
            },
            CommandOutputPolicy::Discard,
            "",
        )
        .unwrap();
        let chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 1 + 4;
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
            CommandOutputPolicy::Stream {
                limit_bytes: 1,
                chunk_limit_bytes: 1,
            },
            CommandOutputPolicy::Discard,
            "",
        )
        .unwrap();
        let stream_chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 1 + 4;
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
            CommandOutputPolicy::CaptureAndStream {
                capture_limit_bytes: 1,
                stream_limit_bytes: 1,
                chunk_limit_bytes: 1,
            },
            CommandOutputPolicy::Discard,
            "",
        )
        .unwrap();
        let capture_and_stream_chunk_limit_offset = 4 + 1 + 4 + "cmd".len() + 4 + 1 + 4 + 4;
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            "",
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
            CommandOutputPolicy::Discard,
            CommandOutputPolicy::Discard,
            &label,
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

    #[test]
    fn decode_stdout_chunk_too_short() {
        assert!(decode_stdout_chunk(&[0; 3]).is_err());
    }

    #[test]
    fn decode_exec_too_short() {
        assert!(decode_exec(&[0; 4]).is_err());
    }

    #[test]
    fn decode_exec_rejects_oversized_env_count() {
        // Valid exec header (empty cmd, no env) plus an env_count field claiming
        // u32::MAX pairs but no actual pair bytes. Must return Err without
        // attempting to allocate a vector sized by env_count.
        let mut p = encode_exec(1000, "", &[], false);
        p.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(matches!(
            decode_exec(&p),
            Err(ProtocolError::InvalidPayload(_))
        ));
    }

    #[test]
    fn decode_exec_result_too_short() {
        assert!(decode_exec_result(&[0; 8]).is_err());
    }

    #[test]
    fn decode_exec_result_rejects_truncated_stdout() {
        let mut payload = 0_i32.to_be_bytes().to_vec();
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"ab");

        let err = decode_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("exec_result stdout truncated")
        ));
    }

    #[test]
    fn decode_exec_result_rejects_truncated_stderr() {
        let mut payload = 0_i32.to_be_bytes().to_vec();
        payload.extend_from_slice(&0_u32.to_be_bytes());
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"xy");

        let err = decode_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("exec_result stderr truncated")
        ));
    }

    #[test]
    fn decode_process_exit_rejects_truncated_stdout() {
        let mut payload = 123_u32.to_be_bytes().to_vec();
        payload.extend_from_slice(&1_i32.to_be_bytes());
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"ab");

        let err = decode_process_exit(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_exit stdout truncated")
        ));
    }

    #[test]
    fn decode_process_exit_rejects_truncated_stderr() {
        let mut payload = 123_u32.to_be_bytes().to_vec();
        payload.extend_from_slice(&1_i32.to_be_bytes());
        payload.extend_from_slice(&0_u32.to_be_bytes());
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"xy");

        let err = decode_process_exit(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_exit stderr truncated")
        ));
    }

    #[test]
    fn decode_output_pair_messages_allow_trailing_bytes() {
        let mut exec_result = encode_exec_result(0, b"out", b"err");
        exec_result.extend_from_slice(b"trailing");
        let (code, stdout, stderr) = decode_exec_result(&exec_result).unwrap();
        assert_eq!(code, 0);
        assert_eq!(stdout, b"out");
        assert_eq!(stderr, b"err");

        let mut process_exit = encode_process_exit(123, 1, b"out", b"err");
        process_exit.extend_from_slice(b"trailing");
        let (pid, code, stdout, stderr) = decode_process_exit(&process_exit).unwrap();
        assert_eq!(pid, 123);
        assert_eq!(code, 1);
        assert_eq!(stdout, b"out");
        assert_eq!(stderr, b"err");
    }

    #[test]
    fn decode_write_file_too_short() {
        assert!(decode_write_file(&[0; 3]).is_err());
    }

    #[test]
    fn full_message_exec_roundtrip() {
        let payload = encode_exec(10000, "ls -la", &[], false);
        let msg = encode(MSG_EXEC, 5, &payload).unwrap();

        let mut dec = Decoder::new();
        let msgs = dec.decode(&msg).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_EXEC);
        assert_eq!(msgs[0].seq, 5);

        let d = decode_exec(&msgs[0].payload).unwrap();
        assert_eq!(d.timeout_ms, 10000);
        assert_eq!(d.command, "ls -la");
        assert!(d.env.is_empty());
        assert!(!d.sudo);
    }

    #[test]
    fn decoder_byte_by_byte() {
        let data = encode(MSG_PING, 1, &[]).unwrap();
        let mut dec = Decoder::new();

        for (i, &byte) in data.iter().enumerate() {
            let msgs = dec.decode(&[byte]).unwrap();
            if i < data.len() - 1 {
                assert!(msgs.is_empty());
            } else {
                assert_eq!(msgs.len(), 1);
                assert_eq!(msgs[0].msg_type, MSG_PING);
            }
        }
    }
}
