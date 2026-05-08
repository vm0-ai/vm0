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
//! | 0x0D | H→G       | bounded_exec      | `[4B timeout_ms][1B flags][4B stdout_limit][4B stderr_limit][4B stream_chunk_limit][4B stdout_stream_limit][4B stderr_stream_limit][4B cmd_len][command][4B env_count]([4B key_len][key][4B val_len][value])*[4B stdin_len][stdin]` |
//! | 0x0E | G→H       | bounded_exec_result | `[1B termination][1B flags][4B exit_code][8B duration_ms][4B stdout_len][stdout][4B stderr_len][stderr]` |
//! | 0x0F | G→H       | bounded_exec_output_chunk | `[1B stream][1B flags][4B sequence][4B chunk_len][chunk]` |
//! | 0xFF | G→H       | error             | `[2B error_len][error]` |
//!
//! Bounded exec output chunks are request-scoped: they use the same non-zero
//! `seq` as the bounded exec request. They are separate from pid-scoped
//! `MSG_STDOUT_CHUNK` messages used by `spawn_watch`.
//!
//! Bounded exec stream tags are `0 = stdout` and `1 = stderr`. Termination
//! tags are `0 = exited`, `1 = timed_out`, `2 = cancelled`,
//! `3 = start_failed`, and `4 = wait_failed`.

/// Header size (4-byte length prefix).
pub const HEADER_SIZE: usize = 4;

/// Maximum message body size (16 MB).
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

/// Minimum body size: type (1) + seq (4).
pub const MIN_BODY_SIZE: usize = 5;

/// Fixed bytes in a bounded_exec_result payload before stdout/stderr contents.
pub const BOUNDED_EXEC_RESULT_FIXED_PAYLOAD_BYTES: usize = 1 + 1 + 4 + 8 + 4 + 4;
/// Fixed bytes in a bounded_exec_output_chunk payload before chunk contents.
pub const BOUNDED_EXEC_OUTPUT_CHUNK_FIXED_PAYLOAD_BYTES: usize = 1 + 1 + 4 + 4;
/// Maximum combined stdout+stderr bytes that fit in one bounded_exec_result frame.
pub const MAX_BOUNDED_EXEC_RESULT_OUTPUT_BYTES: usize =
    MAX_MESSAGE_SIZE - MIN_BODY_SIZE - BOUNDED_EXEC_RESULT_FIXED_PAYLOAD_BYTES;
/// Maximum chunk bytes that fit in one bounded_exec_output_chunk frame.
pub const MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES: usize =
    MAX_MESSAGE_SIZE - MIN_BODY_SIZE - BOUNDED_EXEC_OUTPUT_CHUNK_FIXED_PAYLOAD_BYTES;
/// Minimum stream chunk limit accepted by bounded exec implementations.
pub const MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES: usize = 1024;

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
pub const MSG_BOUNDED_EXEC: u8 = 0x0D;
pub const MSG_BOUNDED_EXEC_RESULT: u8 = 0x0E;
pub const MSG_BOUNDED_EXEC_OUTPUT_CHUNK: u8 = 0x0F;
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

// Exec payload flags.
pub const EXEC_FLAG_SUDO: u8 = 0x01;

// Spawn-watch payload flags.
pub const SPAWN_WATCH_FLAG_SUDO: u8 = 0x01;
pub const SPAWN_WATCH_FLAG_STREAM_STDOUT: u8 = 0x02;

// Write-file payload flags.
pub const WRITE_FILE_FLAG_SUDO: u8 = 0x01;
pub const WRITE_FILE_FLAG_APPEND: u8 = 0x02;

// Bounded-exec payload flags.
pub const BOUNDED_EXEC_FLAG_SUDO: u8 = 0x01;
pub const BOUNDED_EXEC_FLAG_STREAM_STDOUT: u8 = 0x02;
pub const BOUNDED_EXEC_FLAG_STREAM_STDERR: u8 = 0x04;
pub const BOUNDED_EXEC_FLAG_STDIN_PRESENT: u8 = 0x08;

// Bounded-exec-result payload flags.
pub const BOUNDED_EXEC_RESULT_FLAG_STDOUT_TRUNCATED: u8 = 0x01;
pub const BOUNDED_EXEC_RESULT_FLAG_STDERR_TRUNCATED: u8 = 0x02;

// Bounded-exec-output-chunk payload flags.
pub const BOUNDED_EXEC_OUTPUT_CHUNK_FLAG_TRUNCATED: u8 = 0x01;

const BOUNDED_EXEC_KNOWN_FLAGS: u8 = BOUNDED_EXEC_FLAG_SUDO
    | BOUNDED_EXEC_FLAG_STREAM_STDOUT
    | BOUNDED_EXEC_FLAG_STREAM_STDERR
    | BOUNDED_EXEC_FLAG_STDIN_PRESENT;
const BOUNDED_EXEC_RESULT_KNOWN_FLAGS: u8 =
    BOUNDED_EXEC_RESULT_FLAG_STDOUT_TRUNCATED | BOUNDED_EXEC_RESULT_FLAG_STDERR_TRUNCATED;
const BOUNDED_EXEC_OUTPUT_CHUNK_KNOWN_FLAGS: u8 = BOUNDED_EXEC_OUTPUT_CHUNK_FLAG_TRUNCATED;

const BOUNDED_EXEC_STREAM_STDOUT: u8 = 0;
const BOUNDED_EXEC_STREAM_STDERR: u8 = 1;

const BOUNDED_EXEC_TERMINATION_EXITED: u8 = 0;
const BOUNDED_EXEC_TERMINATION_TIMED_OUT: u8 = 1;
const BOUNDED_EXEC_TERMINATION_CANCELLED: u8 = 2;
const BOUNDED_EXEC_TERMINATION_START_FAILED: u8 = 3;
const BOUNDED_EXEC_TERMINATION_WAIT_FAILED: u8 = 4;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BoundedExecStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BoundedExecTermination {
    Exited { exit_code: i32 },
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
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
    let bytes: [u8; 2] = data.get(offset..offset + 2)?.try_into().ok()?;
    Some(u16::from_be_bytes(bytes))
}

/// Read a `u32` from `data` at `offset`. Returns `None` if out of bounds.
fn read_u32_at(data: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = data.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(bytes))
}

/// Read an `i32` from `data` at `offset`. Returns `None` if out of bounds.
fn read_i32_at(data: &[u8], offset: usize) -> Option<i32> {
    let bytes: [u8; 4] = data.get(offset..offset + 4)?.try_into().ok()?;
    Some(i32::from_be_bytes(bytes))
}

/// Read a `u64` from `data` at `offset`. Returns `None` if out of bounds.
fn read_u64_at(data: &[u8], offset: usize) -> Option<u64> {
    let bytes: [u8; 8] = data.get(offset..offset + 8)?.try_into().ok()?;
    Some(u64::from_be_bytes(bytes))
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

fn checked_u32_len(field: &'static str, len: usize) -> Result<u32, ProtocolError> {
    u32::try_from(len).map_err(|_| ProtocolError::PayloadTooLarge(field, len))
}

fn append_len_prefixed_bytes(
    p: &mut Vec<u8>,
    field: &'static str,
    bytes: &[u8],
) -> Result<(), ProtocolError> {
    p.extend_from_slice(&checked_u32_len(field, bytes.len())?.to_be_bytes());
    p.extend_from_slice(bytes);
    Ok(())
}

fn add_payload_capacity(
    capacity: &mut usize,
    field: &'static str,
    amount: usize,
) -> Result<(), ProtocolError> {
    *capacity = capacity
        .checked_add(amount)
        .ok_or(ProtocolError::PayloadTooLarge(field, usize::MAX))?;
    Ok(())
}

fn add_len_prefixed_capacity(
    capacity: &mut usize,
    field: &'static str,
    bytes: &[u8],
) -> Result<(), ProtocolError> {
    checked_u32_len(field, bytes.len())?;
    add_payload_capacity(capacity, field, 4)?;
    add_payload_capacity(capacity, field, bytes.len())
}

#[derive(Debug, Clone, Copy)]
pub struct BoundedExecRequest<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub stdin: Option<&'a [u8]>,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
    /// Whether stdout should be emitted through request-scoped
    /// `MSG_BOUNDED_EXEC_OUTPUT_CHUNK` messages.
    pub stream_stdout: bool,
    /// Whether stderr should be emitted through request-scoped
    /// `MSG_BOUNDED_EXEC_OUTPUT_CHUNK` messages.
    pub stream_stderr: bool,
    pub stream_chunk_limit_bytes: u32,
    /// Maximum emitted stdout bytes when `stream_stdout` is enabled.
    /// Execution layers should ignore this field when stdout streaming is off.
    pub stdout_stream_limit_bytes: u32,
    /// Maximum emitted stderr bytes when `stream_stderr` is enabled.
    /// Execution layers should ignore this field when stderr streaming is off.
    pub stderr_stream_limit_bytes: u32,
}

/// Encode bounded_exec payload.
///
/// Wire format:
/// `[4B timeout_ms][1B flags][4B stdout_limit][4B stderr_limit]`
/// `[4B stream_chunk_limit][4B stdout_stream_limit][4B stderr_stream_limit]`
/// `[4B cmd_len][command][4B env_count]([4B key_len][key][4B val_len][value])*`
/// `[4B stdin_len][stdin]`.
///
/// This encoder preserves protocol fields as provided. Execution policy, such
/// as whether non-zero stream limits are valid when a stream flag is disabled,
/// belongs in the host/guest execution layers.
pub fn encode_bounded_exec(request: &BoundedExecRequest<'_>) -> Result<Vec<u8>, ProtocolError> {
    let command = request.command.as_bytes();
    let stdin = request.stdin.unwrap_or_default();
    let mut capacity = 25;
    add_len_prefixed_capacity(&mut capacity, "command", command)?;
    add_payload_capacity(&mut capacity, "env", 4)?;
    for (key, val) in request.env {
        add_len_prefixed_capacity(&mut capacity, "env key", key.as_bytes())?;
        add_len_prefixed_capacity(&mut capacity, "env value", val.as_bytes())?;
    }
    add_len_prefixed_capacity(&mut capacity, "stdin", stdin)?;

    let mut p = Vec::with_capacity(capacity);
    p.extend_from_slice(&request.timeout_ms.to_be_bytes());
    let mut flags = 0u8;
    if request.sudo {
        flags |= BOUNDED_EXEC_FLAG_SUDO;
    }
    if request.stream_stdout {
        flags |= BOUNDED_EXEC_FLAG_STREAM_STDOUT;
    }
    if request.stream_stderr {
        flags |= BOUNDED_EXEC_FLAG_STREAM_STDERR;
    }
    if request.stdin.is_some() {
        flags |= BOUNDED_EXEC_FLAG_STDIN_PRESENT;
    }
    p.push(flags);
    p.extend_from_slice(&request.stdout_limit_bytes.to_be_bytes());
    p.extend_from_slice(&request.stderr_limit_bytes.to_be_bytes());
    p.extend_from_slice(&request.stream_chunk_limit_bytes.to_be_bytes());
    p.extend_from_slice(&request.stdout_stream_limit_bytes.to_be_bytes());
    p.extend_from_slice(&request.stderr_stream_limit_bytes.to_be_bytes());
    append_len_prefixed_bytes(&mut p, "command", command)?;
    p.extend_from_slice(&checked_u32_len("env", request.env.len())?.to_be_bytes());
    for (key, val) in request.env {
        append_len_prefixed_bytes(&mut p, "env key", key.as_bytes())?;
        append_len_prefixed_bytes(&mut p, "env value", val.as_bytes())?;
    }
    append_len_prefixed_bytes(&mut p, "stdin", stdin)?;
    Ok(p)
}

fn bounded_exec_stream_tag(stream: BoundedExecStream) -> u8 {
    match stream {
        BoundedExecStream::Stdout => BOUNDED_EXEC_STREAM_STDOUT,
        BoundedExecStream::Stderr => BOUNDED_EXEC_STREAM_STDERR,
    }
}

fn bounded_exec_termination_tag(termination: BoundedExecTermination) -> (u8, i32) {
    match termination {
        BoundedExecTermination::Exited { exit_code } => {
            (BOUNDED_EXEC_TERMINATION_EXITED, exit_code)
        }
        BoundedExecTermination::TimedOut => (BOUNDED_EXEC_TERMINATION_TIMED_OUT, 0),
        BoundedExecTermination::Cancelled => (BOUNDED_EXEC_TERMINATION_CANCELLED, 0),
        BoundedExecTermination::StartFailed => (BOUNDED_EXEC_TERMINATION_START_FAILED, 0),
        BoundedExecTermination::WaitFailed => (BOUNDED_EXEC_TERMINATION_WAIT_FAILED, 0),
    }
}

/// Encode bounded_exec_result payload.
pub fn encode_bounded_exec_result(
    termination: BoundedExecTermination,
    duration_ms: u64,
    stdout: &[u8],
    stderr: &[u8],
    stdout_truncated: bool,
    stderr_truncated: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let (termination_tag, exit_code) = bounded_exec_termination_tag(termination);
    let mut flags = 0u8;
    if stdout_truncated {
        flags |= BOUNDED_EXEC_RESULT_FLAG_STDOUT_TRUNCATED;
    }
    if stderr_truncated {
        flags |= BOUNDED_EXEC_RESULT_FLAG_STDERR_TRUNCATED;
    }

    let mut capacity = 14;
    add_len_prefixed_capacity(&mut capacity, "stdout", stdout)?;
    add_len_prefixed_capacity(&mut capacity, "stderr", stderr)?;

    let mut p = Vec::with_capacity(capacity);
    p.push(termination_tag);
    p.push(flags);
    p.extend_from_slice(&exit_code.to_be_bytes());
    p.extend_from_slice(&duration_ms.to_be_bytes());
    append_len_prefixed_bytes(&mut p, "stdout", stdout)?;
    append_len_prefixed_bytes(&mut p, "stderr", stderr)?;
    Ok(p)
}

/// Encode bounded_exec_output_chunk payload.
///
/// This message is scoped to a bounded exec request: callers should send it
/// with the same non-zero `seq` as the request it belongs to. It is not a
/// pid-scoped `MSG_STDOUT_CHUNK` replacement.
pub fn encode_bounded_exec_output_chunk(
    stream: BoundedExecStream,
    sequence: u32,
    chunk: &[u8],
    truncated: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let mut capacity = 6;
    add_len_prefixed_capacity(&mut capacity, "chunk", chunk)?;

    let mut p = Vec::with_capacity(capacity);
    p.push(bounded_exec_stream_tag(stream));
    p.push(if truncated {
        BOUNDED_EXEC_OUTPUT_CHUNK_FLAG_TRUNCATED
    } else {
        0
    });
    p.extend_from_slice(&sequence.to_be_bytes());
    append_len_prefixed_bytes(&mut p, "chunk", chunk)?;
    Ok(p)
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

#[derive(Debug)]
pub struct DecodedBoundedExec<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: Vec<(&'a str, &'a str)>,
    pub sudo: bool,
    pub stdin: Option<&'a [u8]>,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
    pub stream_stdout: bool,
    pub stream_stderr: bool,
    pub stream_chunk_limit_bytes: u32,
    pub stdout_stream_limit_bytes: u32,
    pub stderr_stream_limit_bytes: u32,
}

#[derive(Debug)]
pub struct DecodedBoundedExecResult<'a> {
    pub termination: BoundedExecTermination,
    pub duration_ms: u64,
    pub stdout: &'a [u8],
    pub stderr: &'a [u8],
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug)]
pub struct DecodedBoundedExecOutputChunk<'a> {
    pub stream: BoundedExecStream,
    pub sequence: u32,
    pub chunk: &'a [u8],
    pub truncated: bool,
}

fn advance_offset(
    offset: &mut usize,
    amount: usize,
    truncated_msg: &'static str,
) -> Result<usize, ProtocolError> {
    let start = *offset;
    *offset = offset
        .checked_add(amount)
        .ok_or(ProtocolError::InvalidPayload(truncated_msg))?;
    Ok(start)
}

fn read_u8_cursor(
    payload: &[u8],
    offset: &mut usize,
    msg: &'static str,
) -> Result<u8, ProtocolError> {
    let start = advance_offset(offset, 1, msg)?;
    read_u8_at(payload, start).ok_or(ProtocolError::InvalidPayload(msg))
}

fn read_u32_cursor(
    payload: &[u8],
    offset: &mut usize,
    msg: &'static str,
) -> Result<u32, ProtocolError> {
    let start = advance_offset(offset, 4, msg)?;
    read_u32_at(payload, start).ok_or(ProtocolError::InvalidPayload(msg))
}

fn read_i32_cursor(
    payload: &[u8],
    offset: &mut usize,
    msg: &'static str,
) -> Result<i32, ProtocolError> {
    let start = advance_offset(offset, 4, msg)?;
    read_i32_at(payload, start).ok_or(ProtocolError::InvalidPayload(msg))
}

fn read_u64_cursor(
    payload: &[u8],
    offset: &mut usize,
    msg: &'static str,
) -> Result<u64, ProtocolError> {
    let start = advance_offset(offset, 8, msg)?;
    read_u64_at(payload, start).ok_or(ProtocolError::InvalidPayload(msg))
}

fn read_bytes_cursor<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len: usize,
    msg: &'static str,
) -> Result<&'a [u8], ProtocolError> {
    let start = advance_offset(offset, len, msg)?;
    payload
        .get(start..start + len)
        .ok_or(ProtocolError::InvalidPayload(msg))
}

fn read_len_prefixed_bytes_cursor<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len_msg: &'static str,
    truncated_msg: &'static str,
) -> Result<&'a [u8], ProtocolError> {
    let len = read_u32_cursor(payload, offset, len_msg)? as usize;
    read_bytes_cursor(payload, offset, len, truncated_msg)
}

fn read_len_prefixed_str_cursor<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len_msg: &'static str,
    truncated_msg: &'static str,
    utf8_msg: &'static str,
) -> Result<&'a str, ProtocolError> {
    std::str::from_utf8(read_len_prefixed_bytes_cursor(
        payload,
        offset,
        len_msg,
        truncated_msg,
    )?)
    .map_err(|_| ProtocolError::InvalidPayload(utf8_msg))
}

fn ensure_no_trailing_bytes(
    payload: &[u8],
    offset: usize,
    msg: &'static str,
) -> Result<(), ProtocolError> {
    if offset == payload.len() {
        Ok(())
    } else {
        Err(ProtocolError::InvalidPayload(msg))
    }
}

fn reject_unknown_flags(
    flags: u8,
    known_flags: u8,
    msg: &'static str,
) -> Result<(), ProtocolError> {
    if flags & !known_flags == 0 {
        Ok(())
    } else {
        Err(ProtocolError::InvalidPayload(msg))
    }
}

fn decode_bounded_exec_termination(
    tag: u8,
    exit_code: i32,
) -> Result<BoundedExecTermination, ProtocolError> {
    match tag {
        BOUNDED_EXEC_TERMINATION_EXITED => Ok(BoundedExecTermination::Exited { exit_code }),
        BOUNDED_EXEC_TERMINATION_TIMED_OUT => Ok(BoundedExecTermination::TimedOut),
        BOUNDED_EXEC_TERMINATION_CANCELLED => Ok(BoundedExecTermination::Cancelled),
        BOUNDED_EXEC_TERMINATION_START_FAILED => Ok(BoundedExecTermination::StartFailed),
        BOUNDED_EXEC_TERMINATION_WAIT_FAILED => Ok(BoundedExecTermination::WaitFailed),
        _ => Err(ProtocolError::InvalidPayload(
            "bounded_exec_result invalid termination tag",
        )),
    }
}

fn validate_bounded_exec_termination_tag(tag: u8) -> Result<(), ProtocolError> {
    match tag {
        BOUNDED_EXEC_TERMINATION_EXITED
        | BOUNDED_EXEC_TERMINATION_TIMED_OUT
        | BOUNDED_EXEC_TERMINATION_CANCELLED
        | BOUNDED_EXEC_TERMINATION_START_FAILED
        | BOUNDED_EXEC_TERMINATION_WAIT_FAILED => Ok(()),
        _ => Err(ProtocolError::InvalidPayload(
            "bounded_exec_result invalid termination tag",
        )),
    }
}

fn decode_bounded_exec_stream(tag: u8) -> Result<BoundedExecStream, ProtocolError> {
    match tag {
        BOUNDED_EXEC_STREAM_STDOUT => Ok(BoundedExecStream::Stdout),
        BOUNDED_EXEC_STREAM_STDERR => Ok(BoundedExecStream::Stderr),
        _ => Err(ProtocolError::InvalidPayload(
            "bounded_exec_output_chunk invalid stream tag",
        )),
    }
}

/// Decode bounded_exec payload into a [`DecodedBoundedExec`] struct.
pub fn decode_bounded_exec(payload: &[u8]) -> Result<DecodedBoundedExec<'_>, ProtocolError> {
    let mut offset = 0usize;
    let timeout_ms = read_u32_cursor(payload, &mut offset, "bounded_exec payload too short")?;
    let flags = read_u8_cursor(payload, &mut offset, "bounded_exec payload too short")?;
    reject_unknown_flags(
        flags,
        BOUNDED_EXEC_KNOWN_FLAGS,
        "bounded_exec unknown flags",
    )?;
    let stdout_limit_bytes =
        read_u32_cursor(payload, &mut offset, "bounded_exec stdout_limit truncated")?;
    let stderr_limit_bytes =
        read_u32_cursor(payload, &mut offset, "bounded_exec stderr_limit truncated")?;
    let stream_chunk_limit_bytes = read_u32_cursor(
        payload,
        &mut offset,
        "bounded_exec stream_chunk_limit truncated",
    )?;
    let stdout_stream_limit_bytes = read_u32_cursor(
        payload,
        &mut offset,
        "bounded_exec stdout_stream_limit truncated",
    )?;
    let stderr_stream_limit_bytes = read_u32_cursor(
        payload,
        &mut offset,
        "bounded_exec stderr_stream_limit truncated",
    )?;
    let command = read_len_prefixed_str_cursor(
        payload,
        &mut offset,
        "bounded_exec command_len truncated",
        "bounded_exec command truncated",
        "invalid UTF-8 in bounded_exec command",
    )?;
    let env_count =
        read_u32_cursor(payload, &mut offset, "bounded_exec env count truncated")? as usize;
    let mut env = Vec::new();
    for _ in 0..env_count {
        let key = read_len_prefixed_str_cursor(
            payload,
            &mut offset,
            "bounded_exec env key_len truncated",
            "bounded_exec env key truncated",
            "invalid UTF-8 in bounded_exec env key",
        )?;
        let value = read_len_prefixed_str_cursor(
            payload,
            &mut offset,
            "bounded_exec env value_len truncated",
            "bounded_exec env value truncated",
            "invalid UTF-8 in bounded_exec env value",
        )?;
        env.push((key, value));
    }
    let stdin_bytes = read_len_prefixed_bytes_cursor(
        payload,
        &mut offset,
        "bounded_exec stdin_len truncated",
        "bounded_exec stdin truncated",
    )?;
    let stdin_present = flags & BOUNDED_EXEC_FLAG_STDIN_PRESENT != 0;
    if !stdin_present && !stdin_bytes.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "bounded_exec stdin bytes without stdin flag",
        ));
    }
    ensure_no_trailing_bytes(payload, offset, "bounded_exec trailing bytes")?;

    Ok(DecodedBoundedExec {
        timeout_ms,
        command,
        env,
        sudo: flags & BOUNDED_EXEC_FLAG_SUDO != 0,
        stdin: stdin_present.then_some(stdin_bytes),
        stdout_limit_bytes,
        stderr_limit_bytes,
        stream_stdout: flags & BOUNDED_EXEC_FLAG_STREAM_STDOUT != 0,
        stream_stderr: flags & BOUNDED_EXEC_FLAG_STREAM_STDERR != 0,
        stream_chunk_limit_bytes,
        stdout_stream_limit_bytes,
        stderr_stream_limit_bytes,
    })
}

/// Decode bounded_exec_result payload.
pub fn decode_bounded_exec_result(
    payload: &[u8],
) -> Result<DecodedBoundedExecResult<'_>, ProtocolError> {
    let mut offset = 0usize;
    let termination_tag = read_u8_cursor(
        payload,
        &mut offset,
        "bounded_exec_result payload too short",
    )?;
    let flags = read_u8_cursor(
        payload,
        &mut offset,
        "bounded_exec_result payload too short",
    )?;
    reject_unknown_flags(
        flags,
        BOUNDED_EXEC_RESULT_KNOWN_FLAGS,
        "bounded_exec_result unknown flags",
    )?;
    validate_bounded_exec_termination_tag(termination_tag)?;
    let exit_code = read_i32_cursor(
        payload,
        &mut offset,
        "bounded_exec_result exit_code truncated",
    )?;
    let duration_ms = read_u64_cursor(
        payload,
        &mut offset,
        "bounded_exec_result duration_ms truncated",
    )?;
    let stdout = read_len_prefixed_bytes_cursor(
        payload,
        &mut offset,
        "bounded_exec_result stdout_len truncated",
        "bounded_exec_result stdout truncated",
    )?;
    let stderr = read_len_prefixed_bytes_cursor(
        payload,
        &mut offset,
        "bounded_exec_result stderr_len truncated",
        "bounded_exec_result stderr truncated",
    )?;
    ensure_no_trailing_bytes(payload, offset, "bounded_exec_result trailing bytes")?;

    Ok(DecodedBoundedExecResult {
        termination: decode_bounded_exec_termination(termination_tag, exit_code)?,
        duration_ms,
        stdout,
        stderr,
        stdout_truncated: flags & BOUNDED_EXEC_RESULT_FLAG_STDOUT_TRUNCATED != 0,
        stderr_truncated: flags & BOUNDED_EXEC_RESULT_FLAG_STDERR_TRUNCATED != 0,
    })
}

/// Decode bounded_exec_output_chunk payload.
pub fn decode_bounded_exec_output_chunk(
    payload: &[u8],
) -> Result<DecodedBoundedExecOutputChunk<'_>, ProtocolError> {
    let mut offset = 0usize;
    let stream_tag = read_u8_cursor(
        payload,
        &mut offset,
        "bounded_exec_output_chunk payload too short",
    )?;
    let flags = read_u8_cursor(
        payload,
        &mut offset,
        "bounded_exec_output_chunk payload too short",
    )?;
    reject_unknown_flags(
        flags,
        BOUNDED_EXEC_OUTPUT_CHUNK_KNOWN_FLAGS,
        "bounded_exec_output_chunk unknown flags",
    )?;
    let stream = decode_bounded_exec_stream(stream_tag)?;
    let sequence = read_u32_cursor(
        payload,
        &mut offset,
        "bounded_exec_output_chunk sequence truncated",
    )?;
    let chunk = read_len_prefixed_bytes_cursor(
        payload,
        &mut offset,
        "bounded_exec_output_chunk chunk_len truncated",
        "bounded_exec_output_chunk chunk truncated",
    )?;
    ensure_no_trailing_bytes(payload, offset, "bounded_exec_output_chunk trailing bytes")?;

    Ok(DecodedBoundedExecOutputChunk {
        stream,
        sequence,
        chunk,
        truncated: flags & BOUNDED_EXEC_OUTPUT_CHUNK_FLAG_TRUNCATED != 0,
    })
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

    fn full_bounded_exec_request<'a>() -> BoundedExecRequest<'a> {
        BoundedExecRequest {
            timeout_ms: 12_345,
            command: "printf hello",
            env: &[("TOKEN", "secret"), ("HOME", "/home/user")],
            sudo: true,
            stdin: Some(b"input"),
            stdout_limit_bytes: 1024,
            stderr_limit_bytes: 2048,
            stream_stdout: true,
            stream_stderr: true,
            stream_chunk_limit_bytes: 256,
            stdout_stream_limit_bytes: 4096,
            stderr_stream_limit_bytes: 8192,
        }
    }

    #[test]
    fn bounded_exec_payload_roundtrip_with_env_stdin_and_streaming() {
        let request = full_bounded_exec_request();
        let payload = encode_bounded_exec(&request).unwrap();
        let d = decode_bounded_exec(&payload).unwrap();

        assert_eq!(d.timeout_ms, request.timeout_ms);
        assert_eq!(d.command, request.command);
        assert_eq!(d.env, request.env);
        assert!(d.sudo);
        assert_eq!(d.stdin, Some(b"input".as_slice()));
        assert_eq!(d.stdout_limit_bytes, 1024);
        assert_eq!(d.stderr_limit_bytes, 2048);
        assert!(d.stream_stdout);
        assert!(d.stream_stderr);
        assert_eq!(d.stream_chunk_limit_bytes, 256);
        assert_eq!(d.stdout_stream_limit_bytes, 4096);
        assert_eq!(d.stderr_stream_limit_bytes, 8192);
    }

    #[test]
    fn bounded_exec_payload_roundtrip_without_stdin_or_streaming() {
        let request = BoundedExecRequest {
            timeout_ms: 1,
            command: "true",
            env: &[],
            sudo: false,
            stdin: None,
            stdout_limit_bytes: 0,
            stderr_limit_bytes: 0,
            stream_stdout: false,
            stream_stderr: false,
            stream_chunk_limit_bytes: 0,
            stdout_stream_limit_bytes: 0,
            stderr_stream_limit_bytes: 0,
        };
        let payload = encode_bounded_exec(&request).unwrap();
        let d = decode_bounded_exec(&payload).unwrap();

        assert_eq!(d.timeout_ms, 1);
        assert_eq!(d.command, "true");
        assert!(d.env.is_empty());
        assert!(!d.sudo);
        assert_eq!(d.stdin, None);
        assert!(!d.stream_stdout);
        assert!(!d.stream_stderr);
    }

    #[test]
    fn bounded_exec_payload_roundtrip_with_empty_env_value() {
        let request = BoundedExecRequest {
            env: &[("EMPTY", "")],
            ..full_bounded_exec_request()
        };
        let payload = encode_bounded_exec(&request).unwrap();
        let d = decode_bounded_exec(&payload).unwrap();

        assert_eq!(d.env, vec![("EMPTY", "")]);
    }

    #[test]
    fn bounded_exec_payload_distinguishes_explicit_empty_stdin() {
        let request = BoundedExecRequest {
            stdin: Some(b""),
            ..full_bounded_exec_request()
        };
        let payload = encode_bounded_exec(&request).unwrap();
        let d = decode_bounded_exec(&payload).unwrap();

        assert_eq!(d.stdin, Some(b"".as_slice()));
    }

    #[test]
    fn decode_bounded_exec_rejects_stdin_bytes_without_stdin_flag() {
        let mut payload = encode_bounded_exec(&full_bounded_exec_request()).unwrap();
        payload[4] &= !BOUNDED_EXEC_FLAG_STDIN_PRESENT;

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec stdin bytes without stdin flag")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_truncated_stdin() {
        let mut payload = encode_bounded_exec(&full_bounded_exec_request()).unwrap();
        payload.pop();

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec stdin truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_missing_stdin_len_after_env() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty command
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty env

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec stdin_len truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_unknown_flags() {
        let mut payload = encode_bounded_exec(&full_bounded_exec_request()).unwrap();
        payload[4] |= 0x80;

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec unknown flags")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_truncated_command() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"ab");

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec command truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_truncated_env_value() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty command
        payload.extend_from_slice(&1_u32.to_be_bytes()); // one env pair
        payload.extend_from_slice(&1_u32.to_be_bytes()); // key len
        payload.push(b'K');
        payload.extend_from_slice(&3_u32.to_be_bytes()); // value len
        payload.extend_from_slice(b"xy");

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec env value truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_invalid_utf8_command() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0xFF);
        payload.extend_from_slice(&0_u32.to_be_bytes());
        payload.extend_from_slice(&0_u32.to_be_bytes());

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("invalid UTF-8 in bounded_exec command")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_invalid_utf8_env_key() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty command
        payload.extend_from_slice(&1_u32.to_be_bytes()); // one env pair
        payload.extend_from_slice(&1_u32.to_be_bytes()); // key len
        payload.push(0xFF);
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty value
        payload.extend_from_slice(&0_u32.to_be_bytes()); // no stdin

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("invalid UTF-8 in bounded_exec env key")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_invalid_utf8_env_value() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty command
        payload.extend_from_slice(&1_u32.to_be_bytes()); // one env pair
        payload.extend_from_slice(&1_u32.to_be_bytes()); // key len
        payload.push(b'K');
        payload.extend_from_slice(&1_u32.to_be_bytes()); // value len
        payload.push(0xFF);
        payload.extend_from_slice(&0_u32.to_be_bytes()); // no stdin

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("invalid UTF-8 in bounded_exec env value")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_oversized_env_count_without_large_allocation() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u32.to_be_bytes());
        payload.push(0);
        for _ in 0..5 {
            payload.extend_from_slice(&0_u32.to_be_bytes());
        }
        payload.extend_from_slice(&0_u32.to_be_bytes()); // empty command
        payload.extend_from_slice(&u32::MAX.to_be_bytes());

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec env key_len truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_rejects_trailing_bytes() {
        let mut payload = encode_bounded_exec(&full_bounded_exec_request()).unwrap();
        payload.push(0xFF);

        let err = decode_bounded_exec(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec trailing bytes")
        ));
    }

    #[test]
    fn bounded_exec_result_roundtrip_exited() {
        let payload = encode_bounded_exec_result(
            BoundedExecTermination::Exited { exit_code: 42 },
            123,
            b"out",
            b"err",
            false,
            true,
        )
        .unwrap();
        let d = decode_bounded_exec_result(&payload).unwrap();

        assert_eq!(
            d.termination,
            BoundedExecTermination::Exited { exit_code: 42 }
        );
        assert_eq!(d.duration_ms, 123);
        assert_eq!(d.stdout, b"out");
        assert_eq!(d.stderr, b"err");
        assert!(!d.stdout_truncated);
        assert!(d.stderr_truncated);
    }

    #[test]
    fn bounded_exec_result_empty_output_roundtrip() {
        let payload = encode_bounded_exec_result(
            BoundedExecTermination::Exited { exit_code: 0 },
            0,
            b"",
            b"",
            false,
            false,
        )
        .unwrap();
        let d = decode_bounded_exec_result(&payload).unwrap();

        assert_eq!(
            d.termination,
            BoundedExecTermination::Exited { exit_code: 0 }
        );
        assert_eq!(d.duration_ms, 0);
        assert!(d.stdout.is_empty());
        assert!(d.stderr.is_empty());
        assert!(!d.stdout_truncated);
        assert!(!d.stderr_truncated);
    }

    #[test]
    fn bounded_exec_result_truncation_flags_roundtrip_independently() {
        for (stdout_truncated, stderr_truncated) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let payload = encode_bounded_exec_result(
                BoundedExecTermination::Exited { exit_code: 0 },
                1,
                b"out",
                b"err",
                stdout_truncated,
                stderr_truncated,
            )
            .unwrap();
            let d = decode_bounded_exec_result(&payload).unwrap();

            assert_eq!(d.stdout_truncated, stdout_truncated);
            assert_eq!(d.stderr_truncated, stderr_truncated);
        }
    }

    #[test]
    fn bounded_exec_result_roundtrip_non_exit_terminations() {
        for termination in [
            BoundedExecTermination::TimedOut,
            BoundedExecTermination::Cancelled,
            BoundedExecTermination::StartFailed,
            BoundedExecTermination::WaitFailed,
        ] {
            let payload =
                encode_bounded_exec_result(termination, 999, b"partial", b"diagnostic", true, true)
                    .unwrap();
            let d = decode_bounded_exec_result(&payload).unwrap();

            assert_eq!(d.termination, termination);
            assert_eq!(d.duration_ms, 999);
            assert_eq!(d.stdout, b"partial");
            assert_eq!(d.stderr, b"diagnostic");
            assert!(d.stdout_truncated);
            assert!(d.stderr_truncated);
        }
    }

    #[test]
    fn decode_bounded_exec_result_rejects_invalid_termination_tag() {
        let mut payload =
            encode_bounded_exec_result(BoundedExecTermination::TimedOut, 0, b"", b"", false, false)
                .unwrap();
        payload[0] = 0xFF;

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result invalid termination tag")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_invalid_termination_tag_before_body() {
        let err = decode_bounded_exec_result(&[0xFF, 0]).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result invalid termination tag")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_unknown_flags() {
        let mut payload =
            encode_bounded_exec_result(BoundedExecTermination::TimedOut, 0, b"", b"", false, false)
                .unwrap();
        payload[1] = 0x80;

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result unknown flags")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_truncated_exit_code() {
        let payload = [BOUNDED_EXEC_TERMINATION_EXITED, 0, 0, 0, 0];

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result exit_code truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_truncated_duration() {
        let mut payload = Vec::new();
        payload.push(BOUNDED_EXEC_TERMINATION_EXITED);
        payload.push(0);
        payload.extend_from_slice(&0_i32.to_be_bytes());
        payload.extend_from_slice(&0_u64.to_be_bytes()[..7]);

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result duration_ms truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_truncated_stdout() {
        let mut payload = Vec::new();
        payload.push(BOUNDED_EXEC_TERMINATION_EXITED);
        payload.push(0);
        payload.extend_from_slice(&0_i32.to_be_bytes());
        payload.extend_from_slice(&0_u64.to_be_bytes());
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"ab");

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result stdout truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_truncated_stderr() {
        let mut payload = encode_bounded_exec_result(
            BoundedExecTermination::Exited { exit_code: 0 },
            0,
            b"out",
            b"err",
            false,
            false,
        )
        .unwrap();
        payload.pop();

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result stderr truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_result_rejects_trailing_bytes() {
        let mut payload = encode_bounded_exec_result(
            BoundedExecTermination::Exited { exit_code: 0 },
            0,
            b"out",
            b"err",
            false,
            false,
        )
        .unwrap();
        payload.push(0);

        let err = decode_bounded_exec_result(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_result trailing bytes")
        ));
    }

    #[test]
    fn bounded_exec_output_chunk_roundtrip_stdout_and_stderr() {
        for stream in [BoundedExecStream::Stdout, BoundedExecStream::Stderr] {
            let payload = encode_bounded_exec_output_chunk(stream, 7, b"chunk", true).unwrap();
            let d = decode_bounded_exec_output_chunk(&payload).unwrap();

            assert_eq!(d.stream, stream);
            assert_eq!(d.sequence, 7);
            assert_eq!(d.chunk, b"chunk");
            assert!(d.truncated);
        }
    }

    #[test]
    fn bounded_exec_output_chunk_empty_chunk_roundtrip() {
        let payload =
            encode_bounded_exec_output_chunk(BoundedExecStream::Stdout, 0, b"", false).unwrap();
        let d = decode_bounded_exec_output_chunk(&payload).unwrap();

        assert_eq!(d.stream, BoundedExecStream::Stdout);
        assert_eq!(d.sequence, 0);
        assert!(d.chunk.is_empty());
        assert!(!d.truncated);
    }

    #[test]
    fn decode_bounded_exec_output_chunk_rejects_invalid_stream_tag() {
        let mut payload =
            encode_bounded_exec_output_chunk(BoundedExecStream::Stdout, 0, b"", false).unwrap();
        payload[0] = 0xFF;

        let err = decode_bounded_exec_output_chunk(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_output_chunk invalid stream tag")
        ));
    }

    #[test]
    fn decode_bounded_exec_output_chunk_rejects_invalid_stream_tag_before_body() {
        let err = decode_bounded_exec_output_chunk(&[0xFF, 0]).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_output_chunk invalid stream tag")
        ));
    }

    #[test]
    fn decode_bounded_exec_output_chunk_rejects_unknown_flags() {
        let mut payload =
            encode_bounded_exec_output_chunk(BoundedExecStream::Stdout, 0, b"", false).unwrap();
        payload[1] = 0x80;

        let err = decode_bounded_exec_output_chunk(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_output_chunk unknown flags")
        ));
    }

    #[test]
    fn decode_bounded_exec_output_chunk_rejects_truncated_sequence() {
        let payload = [BOUNDED_EXEC_STREAM_STDOUT, 0, 0, 0, 0];

        let err = decode_bounded_exec_output_chunk(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_output_chunk sequence truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_output_chunk_rejects_truncated_chunk() {
        let mut payload = Vec::new();
        payload.push(BOUNDED_EXEC_STREAM_STDOUT);
        payload.push(0);
        payload.extend_from_slice(&0_u32.to_be_bytes());
        payload.extend_from_slice(&3_u32.to_be_bytes());
        payload.extend_from_slice(b"ab");

        let err = decode_bounded_exec_output_chunk(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_output_chunk chunk truncated")
        ));
    }

    #[test]
    fn decode_bounded_exec_output_chunk_rejects_trailing_bytes() {
        let mut payload =
            encode_bounded_exec_output_chunk(BoundedExecStream::Stdout, 0, b"ok", false).unwrap();
        payload.push(0);

        let err = decode_bounded_exec_output_chunk(&payload).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("bounded_exec_output_chunk trailing bytes")
        ));
    }

    #[test]
    fn full_message_bounded_exec_roundtrip() {
        let request_payload = encode_bounded_exec(&full_bounded_exec_request()).unwrap();
        let result_payload = encode_bounded_exec_result(
            BoundedExecTermination::Exited { exit_code: 0 },
            15,
            b"out",
            b"err",
            false,
            false,
        )
        .unwrap();
        let chunk_payload =
            encode_bounded_exec_output_chunk(BoundedExecStream::Stderr, 3, b"warn", false).unwrap();

        let mut data = encode(MSG_BOUNDED_EXEC, 10, &request_payload).unwrap();
        data.extend_from_slice(&encode(MSG_BOUNDED_EXEC_RESULT, 10, &result_payload).unwrap());
        data.extend_from_slice(&encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, 10, &chunk_payload).unwrap());

        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].msg_type, MSG_BOUNDED_EXEC);
        assert_eq!(msgs[1].msg_type, MSG_BOUNDED_EXEC_RESULT);
        assert_eq!(msgs[2].msg_type, MSG_BOUNDED_EXEC_OUTPUT_CHUNK);
        assert_eq!(msgs[0].seq, 10);
        assert_eq!(
            decode_bounded_exec(&msgs[0].payload).unwrap().command,
            "printf hello"
        );
        assert_eq!(
            decode_bounded_exec_result(&msgs[1].payload)
                .unwrap()
                .termination,
            BoundedExecTermination::Exited { exit_code: 0 }
        );
        assert_eq!(
            decode_bounded_exec_output_chunk(&msgs[2].payload)
                .unwrap()
                .stream,
            BoundedExecStream::Stderr
        );
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
