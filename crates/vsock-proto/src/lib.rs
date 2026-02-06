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
//! | 0x03 | H→G       | exec              | `[4B timeout_ms][4B cmd_len][command]` |
//! | 0x04 | G→H       | exec_result       | `[4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]` |
//! | 0x05 | H→G       | write_file        | `[2B path_len][path][1B flags][4B content_len][content]` |
//! | 0x06 | G→H       | write_file_result | `[1B success][2B error_len][error]` |
//! | 0x07 | H→G       | spawn_watch       | `[4B timeout_ms][4B cmd_len][command]` |
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

/// Write-file flag: execute write with sudo.
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

/// Encode exec payload: `[4B timeout_ms][4B cmd_len][command]`.
pub fn encode_exec(timeout_ms: u32, command: &str) -> Vec<u8> {
    let cmd = command.as_bytes();
    let mut p = Vec::with_capacity(8 + cmd.len());
    p.extend_from_slice(&timeout_ms.to_be_bytes());
    p.extend_from_slice(&(cmd.len() as u32).to_be_bytes());
    p.extend_from_slice(cmd);
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
    p.extend_from_slice(&err[..err_len as usize]);
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
    p.extend_from_slice(&msg[..msg_len as usize]);
    p
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/// Decode exec payload.
pub fn decode_exec(payload: &[u8]) -> Result<(u32, &str), ProtocolError> {
    if payload.len() < 8 {
        return Err(ProtocolError::InvalidPayload("exec payload too short"));
    }
    let timeout_ms = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let cmd_len = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;
    if payload.len() < 8 + cmd_len {
        return Err(ProtocolError::InvalidPayload("exec command truncated"));
    }
    let command = std::str::from_utf8(&payload[8..8 + cmd_len])
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in command"))?;
    Ok((timeout_ms, command))
}

/// Decode exec_result payload. Returns `(exit_code, stdout, stderr)`.
pub fn decode_exec_result(payload: &[u8]) -> Result<(i32, &[u8], &[u8]), ProtocolError> {
    if payload.len() < 12 {
        return Err(ProtocolError::InvalidPayload("exec_result too short"));
    }
    let exit_code = i32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let stdout_len = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;
    let stderr_off = 8 + stdout_len;
    if payload.len() < stderr_off + 4 {
        return Err(ProtocolError::InvalidPayload(
            "exec_result stdout truncated",
        ));
    }
    let stdout = &payload[8..stderr_off];
    let stderr_len = u32::from_be_bytes([
        payload[stderr_off],
        payload[stderr_off + 1],
        payload[stderr_off + 2],
        payload[stderr_off + 3],
    ]) as usize;
    if payload.len() < stderr_off + 4 + stderr_len {
        return Err(ProtocolError::InvalidPayload(
            "exec_result stderr truncated",
        ));
    }
    let stderr = &payload[stderr_off + 4..stderr_off + 4 + stderr_len];
    Ok((exit_code, stdout, stderr))
}

/// Decode write_file payload. Returns `(path, content, sudo)`.
pub fn decode_write_file(payload: &[u8]) -> Result<(&str, &[u8], bool), ProtocolError> {
    if payload.len() < 7 {
        return Err(ProtocolError::InvalidPayload("write_file too short"));
    }
    let path_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    if payload.len() < 2 + path_len + 1 + 4 {
        return Err(ProtocolError::InvalidPayload("write_file path truncated"));
    }
    let path = std::str::from_utf8(&payload[2..2 + path_len])
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in path"))?;
    let flags = payload[2 + path_len];
    let content_len = u32::from_be_bytes([
        payload[3 + path_len],
        payload[4 + path_len],
        payload[5 + path_len],
        payload[6 + path_len],
    ]) as usize;
    if payload.len() < 7 + path_len + content_len {
        return Err(ProtocolError::InvalidPayload(
            "write_file content truncated",
        ));
    }
    let content = &payload[7 + path_len..7 + path_len + content_len];
    Ok((path, content, (flags & FLAG_SUDO) != 0))
}

/// Decode write_file_result payload. Returns `(success, error)`.
pub fn decode_write_file_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    if payload.len() < 3 {
        return Err(ProtocolError::InvalidPayload("write_file_result too short"));
    }
    let success = payload[0] == 1;
    let err_len = u16::from_be_bytes([payload[1], payload[2]]) as usize;
    if payload.len() < 3 + err_len {
        return Err(ProtocolError::InvalidPayload(
            "write_file_result error truncated",
        ));
    }
    let error = std::str::from_utf8(&payload[3..3 + err_len])
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in error"))?;
    Ok((success, error))
}

/// Decode spawn_watch_result payload. Returns `pid`.
pub fn decode_spawn_watch_result(payload: &[u8]) -> Result<u32, ProtocolError> {
    if payload.len() < 4 {
        return Err(ProtocolError::InvalidPayload(
            "spawn_watch_result too short",
        ));
    }
    Ok(u32::from_be_bytes([
        payload[0], payload[1], payload[2], payload[3],
    ]))
}

/// Decoded process_exit fields: `(pid, exit_code, stdout, stderr)`.
pub type ProcessExit<'a> = (u32, i32, &'a [u8], &'a [u8]);

/// Decode process_exit payload. Returns `(pid, exit_code, stdout, stderr)`.
pub fn decode_process_exit(payload: &[u8]) -> Result<ProcessExit<'_>, ProtocolError> {
    if payload.len() < 16 {
        return Err(ProtocolError::InvalidPayload("process_exit too short"));
    }
    let pid = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let exit_code = i32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]);
    let stdout_len =
        u32::from_be_bytes([payload[8], payload[9], payload[10], payload[11]]) as usize;
    let stderr_off = 12 + stdout_len;
    if payload.len() < stderr_off + 4 {
        return Err(ProtocolError::InvalidPayload(
            "process_exit stdout truncated",
        ));
    }
    let stdout = &payload[12..stderr_off];
    let stderr_len = u32::from_be_bytes([
        payload[stderr_off],
        payload[stderr_off + 1],
        payload[stderr_off + 2],
        payload[stderr_off + 3],
    ]) as usize;
    if payload.len() < stderr_off + 4 + stderr_len {
        return Err(ProtocolError::InvalidPayload(
            "process_exit stderr truncated",
        ));
    }
    let stderr = &payload[stderr_off + 4..stderr_off + 4 + stderr_len];
    Ok((pid, exit_code, stdout, stderr))
}

/// Decode error payload. Returns the error message.
pub fn decode_error(payload: &[u8]) -> Result<&str, ProtocolError> {
    if payload.len() < 2 {
        return Err(ProtocolError::InvalidPayload("error payload too short"));
    }
    let msg_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    if payload.len() < 2 + msg_len {
        return Err(ProtocolError::InvalidPayload("error message truncated"));
    }
    std::str::from_utf8(&payload[2..2 + msg_len])
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
            let length = u32::from_be_bytes([
                self.buf[offset],
                self.buf[offset + 1],
                self.buf[offset + 2],
                self.buf[offset + 3],
            ]) as usize;

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

            let msg_type = self.buf[offset + HEADER_SIZE];
            let seq = u32::from_be_bytes([
                self.buf[offset + HEADER_SIZE + 1],
                self.buf[offset + HEADER_SIZE + 2],
                self.buf[offset + HEADER_SIZE + 3],
                self.buf[offset + HEADER_SIZE + 4],
            ]);
            let payload = self.buf[offset + HEADER_SIZE + MIN_BODY_SIZE..offset + total].to_vec();

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
        let payload = encode_exec(5000, "echo hello");
        let (timeout, cmd) = decode_exec(&payload).unwrap();
        assert_eq!(timeout, 5000);
        assert_eq!(cmd, "echo hello");
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
        let payload = encode_exec(10000, "ls -la");
        let msg = encode(MSG_EXEC, 5, &payload).unwrap();

        let mut dec = Decoder::new();
        let msgs = dec.decode(&msg).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_EXEC);
        assert_eq!(msgs[0].seq, 5);

        let (timeout, cmd) = decode_exec(&msgs[0].payload).unwrap();
        assert_eq!(timeout, 10000);
        assert_eq!(cmd, "ls -la");
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
