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
//! | 0x05 | H→G       | write_file        | `[2B path_len][path][1B flags][4B content_len][content]` |
//! | 0x06 | G→H       | write_file_result | `[1B success][2B error_len][error]` |
//! | 0x07 | H→G       | spawn_watch       | `[4B timeout_ms][1B flags][4B cmd_len][command]([4B env_count]([4B key_len][key][4B val_len][value])*)` |
//! | 0x08 | G→H       | spawn_watch_result| `[4B pid]` |
//! | 0x09 | G→H       | process_exit      | `[4B pid][4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]` |
//! | 0x0A | H→G       | shutdown          | (empty) |
//! | 0x0B | G→H       | shutdown_ack      | (empty) |
//! | 0xFF | G→H       | error             | `[2B error_len][error]` |

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
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

/// Flag: execute with root privileges (used in exec, spawn_watch, and write_file).
pub const FLAG_SUDO: u8 = 0x01;

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
    p.push(if sudo { FLAG_SUDO } else { 0 });
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

/// Encode exec_result payload: `[4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]`.
pub fn encode_exec_result(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(12 + stdout.len() + stderr.len());
    p.extend_from_slice(&exit_code.to_be_bytes());
    p.extend_from_slice(&(stdout.len() as u32).to_be_bytes());
    p.extend_from_slice(stdout);
    p.extend_from_slice(&(stderr.len() as u32).to_be_bytes());
    p.extend_from_slice(stderr);
    p
}

/// Encode write_file payload: `[2B path_len][path][1B flags][4B content_len][content]`.
///
/// Returns `Err` if path exceeds 65535 bytes (u16 field limit).
/// Total message size is validated by [`encode`].
pub fn encode_write_file(path: &str, content: &[u8], sudo: bool) -> Result<Vec<u8>, ProtocolError> {
    let path_bytes = path.as_bytes();
    if path_bytes.len() > u16::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge("path", path_bytes.len()));
    }
    let path_len = path_bytes.len() as u16;
    let mut p = Vec::with_capacity(7 + path_len as usize + content.len());
    p.extend_from_slice(&path_len.to_be_bytes());
    p.extend_from_slice(path_bytes);
    p.push(if sudo { FLAG_SUDO } else { 0 });
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
    p.extend_from_slice(&(stdout.len() as u32).to_be_bytes());
    p.extend_from_slice(stdout);
    p.extend_from_slice(&(stderr.len() as u32).to_be_bytes());
    p.extend_from_slice(stderr);
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

/// Decode exec payload. Returns `(timeout_ms, command, env, sudo)`.
///
/// The env section is optional: if the payload ends right after the command,
/// an empty vec is returned (backward-compatible with old encoders).
pub fn decode_exec(payload: &[u8]) -> Result<DecodedExec<'_>, ProtocolError> {
    let timeout_ms =
        read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("exec payload too short"))?;
    let flags =
        read_u8_at(payload, 4).ok_or(ProtocolError::InvalidPayload("exec payload too short"))?;
    let sudo = (flags & FLAG_SUDO) != 0;
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
        return Ok(DecodedExec {
            timeout_ms,
            command,
            env: Vec::new(),
            sudo,
        });
    }

    let env_count = read_u32_at(payload, env_start)
        .ok_or(ProtocolError::InvalidPayload("exec env count truncated"))?
        as usize;
    let mut env = Vec::with_capacity(env_count);
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

    Ok(DecodedExec {
        timeout_ms,
        command,
        env,
        sudo,
    })
}

/// Decode exec_result payload. Returns `(exit_code, stdout, stderr)`.
pub fn decode_exec_result(payload: &[u8]) -> Result<(i32, &[u8], &[u8]), ProtocolError> {
    let exit_code =
        read_i32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("exec_result too short"))?;
    let stdout_len = read_u32_at(payload, 4)
        .ok_or(ProtocolError::InvalidPayload("exec_result too short"))?
        as usize;
    let stderr_off = 8 + stdout_len;
    let stdout = payload
        .get(8..stderr_off)
        .ok_or(ProtocolError::InvalidPayload(
            "exec_result stdout truncated",
        ))?;
    let stderr_len = read_u32_at(payload, stderr_off)
        .ok_or(ProtocolError::InvalidPayload("exec_result too short"))?
        as usize;
    let stderr = payload
        .get(stderr_off + 4..stderr_off + 4 + stderr_len)
        .ok_or(ProtocolError::InvalidPayload(
            "exec_result stderr truncated",
        ))?;
    Ok((exit_code, stdout, stderr))
}

/// Decode write_file payload. Returns `(path, content, sudo)`.
pub fn decode_write_file(payload: &[u8]) -> Result<(&str, &[u8], bool), ProtocolError> {
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
    Ok((path, content, (flags & FLAG_SUDO) != 0))
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

/// Decoded process_exit fields: `(pid, exit_code, stdout, stderr)`.
pub type ProcessExit<'a> = (u32, i32, &'a [u8], &'a [u8]);

/// Decode process_exit payload. Returns `(pid, exit_code, stdout, stderr)`.
pub fn decode_process_exit(payload: &[u8]) -> Result<ProcessExit<'_>, ProtocolError> {
    let pid =
        read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload("process_exit too short"))?;
    let exit_code =
        read_i32_at(payload, 4).ok_or(ProtocolError::InvalidPayload("process_exit too short"))?;
    let stdout_len = read_u32_at(payload, 8)
        .ok_or(ProtocolError::InvalidPayload("process_exit too short"))?
        as usize;
    let stderr_off = 12 + stdout_len;
    let stdout = payload
        .get(12..stderr_off)
        .ok_or(ProtocolError::InvalidPayload(
            "process_exit stdout truncated",
        ))?;
    let stderr_len = read_u32_at(payload, stderr_off)
        .ok_or(ProtocolError::InvalidPayload("process_exit too short"))?
        as usize;
    let stderr = payload
        .get(stderr_off + 4..stderr_off + 4 + stderr_len)
        .ok_or(ProtocolError::InvalidPayload(
            "process_exit stderr truncated",
        ))?;
    Ok((pid, exit_code, stdout, stderr))
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
        let payload = encode_write_file("/tmp/test.txt", b"content", false).unwrap();
        let (path, content, sudo) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/test.txt");
        assert_eq!(content, b"content");
        assert!(!sudo);
    }

    #[test]
    fn write_file_with_sudo() {
        let payload = encode_write_file("/etc/hosts", b"127.0.0.1", true).unwrap();
        let (path, content, sudo) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/etc/hosts");
        assert_eq!(content, b"127.0.0.1");
        assert!(sudo);
    }

    #[test]
    fn write_file_path_too_long() {
        let long_path = "a".repeat(65536);
        let err = encode_write_file(&long_path, b"", false).unwrap_err();
        assert!(matches!(err, ProtocolError::PayloadTooLarge("path", 65536)));
    }

    #[test]
    fn write_file_content_too_large() {
        let big = vec![0u8; MAX_MESSAGE_SIZE];
        let payload = encode_write_file("/tmp/f", &big, false).unwrap();
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
    fn decode_exec_too_short() {
        assert!(decode_exec(&[0; 4]).is_err());
    }

    #[test]
    fn decode_exec_result_too_short() {
        assert!(decode_exec_result(&[0; 8]).is_err());
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
