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
//! | 0x03 | H→G       | write_file        | `[2B path_len][path][1B flags][4B content_len][content]` (flags: `SUDO=0x01`, `APPEND=0x02`) |
//! | 0x04 | G→H       | write_file_result | `[1B success][2B error_len][error]` |
//! | 0x05 | H→G       | spawn_watch       | `[4B timeout_ms][1B flags][4B cmd_len][command]([4B env_count]([4B key_len][key][4B val_len][value])*)([2B log_path_len][log_path])` (flags: `SUDO=0x01`, `STREAM_STDOUT=0x02`) |
//! | 0x06 | G→H       | spawn_watch_result| `[4B pid]` |
//! | 0x07 | G→H       | process_exit      | `[4B pid][4B exit_code][4B stdout_len][stdout][4B stderr_len][stderr]` |
//! | 0x08 | H→G       | shutdown          | (empty) |
//! | 0x09 | G→H       | shutdown_ack      | (empty) |
//! | 0x0A | G→H       | stdout_chunk      | `[4B pid][data]` |
//! | 0x0B | H→G       | command_start     | `[4B timeout_ms][1B flags][4B cmd_len][command][4B env_count]... [2B label_len][label][stdout_policy][stderr_policy]` |
//! | 0x0C | G→H       | command_output    | `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]` |
//! | 0x0D | G→H       | command_result    | `[1B termination]...[4B duration_ms][stdout][stderr][2B diagnostic_len][diagnostic]` |
//! | 0x0E | H→G       | command_cancel    | (empty) |
//! | 0xFF | G→H       | error             | `[2B error_len][error]` |
//!
//! Command operation messages are request-scoped; host/guest dispatch layers
//! must use a non-zero sequence number for start/output/result/cancel.
//! `command_output.output_seq` is per command operation and starts at 0,
//! incrementing by 1 for each output frame across stdout and stderr.

mod error;
mod frame;
mod payloads;
mod read;
mod wire;

pub use error::ProtocolError;
pub use frame::{Decoder, RawMessage, encode};
pub use payloads::command::{
    CommandCapturedOutput, CommandOutputPolicy, CommandOutputStream, CommandTermination,
    DecodedCommandOutput, DecodedCommandResult, DecodedCommandStart, decode_command_cancel,
    decode_command_output, decode_command_result, decode_command_start, encode_command_cancel,
    encode_command_output, encode_command_result, encode_command_start,
};
pub use wire::{
    COMMAND_CAPTURED_OUTPUT_FLAG_TRUNCATED, COMMAND_FLAG_SUDO, COMMAND_OUTPUT_FLAG_TRUNCATED,
    HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_COMMAND_CANCEL, MSG_COMMAND_OUTPUT,
    MSG_COMMAND_RESULT, MSG_COMMAND_START, MSG_ERROR, MSG_PING, MSG_PONG, MSG_PROCESS_EXIT,
    MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT,
    MSG_STDOUT_CHUNK, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, SPAWN_WATCH_FLAG_STREAM_STDOUT,
    SPAWN_WATCH_FLAG_SUDO, VSOCK_PORT, WRITE_FILE_FLAG_APPEND, WRITE_FILE_FLAG_SUDO,
};

use crate::read::{read_i32_at, read_u8_at, read_u16_at, read_u32_at};

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/// Encode spawn_watch payload: command fields + optional `[2B log_path_len][log_path]`.
///
/// `stream_stdout` controls whether stdout is streamed to the host via
/// `MSG_STDOUT_CHUNK`. `stdout_log_path`, when present, additionally asks
/// the guest to tee streamed stdout to that file.
///
/// This always writes the env section (even when empty) so
/// `decode_spawn_watch` can unambiguously find the log_path boundary.
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

struct DecodedCommandFieldsInner<'a> {
    timeout_ms: u32,
    command: &'a str,
    env: Vec<(&'a str, &'a str)>,
    sudo: bool,
    offset: usize,
    raw_flags: u8,
}

/// Decode the command-shaped prefix used by spawn_watch payloads.
///
/// The env section is optional: if the payload ends right after the command, an
/// empty vec is returned. `encode_spawn_watch` always writes the env section so
/// the optional log path remains unambiguous for new payloads.
fn decode_command_fields(payload: &[u8]) -> Result<DecodedCommandFieldsInner<'_>, ProtocolError> {
    let timeout_ms = read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload(
        "command fields payload too short",
    ))?;
    let flags = read_u8_at(payload, 4).ok_or(ProtocolError::InvalidPayload(
        "command fields payload too short",
    ))?;
    let sudo = (flags & SPAWN_WATCH_FLAG_SUDO) != 0;
    let cmd_len = read_u32_at(payload, 5).ok_or(ProtocolError::InvalidPayload(
        "command fields payload too short",
    ))? as usize;
    let command = std::str::from_utf8(payload.get(9..9 + cmd_len).ok_or(
        ProtocolError::InvalidPayload("command fields command truncated"),
    )?)
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in command"))?;

    let env_start = 9 + cmd_len;
    if env_start >= payload.len() {
        return Ok(DecodedCommandFieldsInner {
            timeout_ms,
            command,
            env: Vec::new(),
            sudo,
            offset: env_start,
            raw_flags: flags,
        });
    }

    let env_count = read_u32_at(payload, env_start).ok_or(ProtocolError::InvalidPayload(
        "command fields env count truncated",
    ))? as usize;
    // Do not pre-allocate based on env_count: it is untrusted wire data and a
    // malformed message can claim u32::MAX pairs. The per-iteration bounds
    // checks below return an error as soon as the payload runs out.
    let mut env = Vec::new();
    let mut offset = env_start + 4;
    for _ in 0..env_count {
        let key_len = read_u32_at(payload, offset).ok_or(ProtocolError::InvalidPayload(
            "command fields env key_len truncated",
        ))? as usize;
        offset += 4;
        let key = std::str::from_utf8(payload.get(offset..offset + key_len).ok_or(
            ProtocolError::InvalidPayload("command fields env key truncated"),
        )?)
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in env key"))?;
        offset += key_len;

        let val_len = read_u32_at(payload, offset).ok_or(ProtocolError::InvalidPayload(
            "command fields env val_len truncated",
        ))? as usize;
        offset += 4;
        let val = std::str::from_utf8(payload.get(offset..offset + val_len).ok_or(
            ProtocolError::InvalidPayload("command fields env value truncated"),
        )?)
        .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in env value"))?;
        offset += val_len;

        env.push((key, val));
    }

    Ok(DecodedCommandFieldsInner {
        timeout_ms,
        command,
        env,
        sudo,
        offset,
        raw_flags: flags,
    })
}

/// Decode spawn_watch payload. Extends command fields with streaming metadata.
///
/// Wire format: `[command fields...]([2B log_path_len][log_path])`.
/// The log_path section is optional — if the payload ends after the command
/// fields, `stdout_log_path` is `None`.
pub fn decode_spawn_watch(payload: &[u8]) -> Result<DecodedSpawnWatch<'_>, ProtocolError> {
    let DecodedCommandFieldsInner {
        timeout_ms,
        command,
        env,
        sudo,
        offset,
        raw_flags,
    } = decode_command_fields(payload)?;
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
        timeout_ms,
        command,
        env,
        sudo,
        stream_stdout: stream_flag,
        stdout_log_path,
    })
}

fn decode_output_pair_at(payload: &[u8], offset: usize) -> Result<(&[u8], &[u8]), ProtocolError> {
    let stdout_len = read_u32_at(payload, offset)
        .ok_or(ProtocolError::InvalidPayload("process_exit too short"))?
        as usize;
    let stdout_start = offset.checked_add(4).ok_or(ProtocolError::InvalidPayload(
        "process_exit stdout truncated",
    ))?;
    let stderr_len_offset =
        stdout_start
            .checked_add(stdout_len)
            .ok_or(ProtocolError::InvalidPayload(
                "process_exit stdout truncated",
            ))?;
    let stdout =
        payload
            .get(stdout_start..stderr_len_offset)
            .ok_or(ProtocolError::InvalidPayload(
                "process_exit stdout truncated",
            ))?;
    let stderr_len = read_u32_at(payload, stderr_len_offset)
        .ok_or(ProtocolError::InvalidPayload("process_exit too short"))?
        as usize;
    let stderr_start = stderr_len_offset
        .checked_add(4)
        .ok_or(ProtocolError::InvalidPayload(
            "process_exit stderr truncated",
        ))?;
    let stderr_end = stderr_start
        .checked_add(stderr_len)
        .ok_or(ProtocolError::InvalidPayload(
            "process_exit stderr truncated",
        ))?;
    let stderr = payload
        .get(stderr_start..stderr_end)
        .ok_or(ProtocolError::InvalidPayload(
            "process_exit stderr truncated",
        ))?;
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

/// Decoded spawn_watch fields.
pub struct DecodedSpawnWatch<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: Vec<(&'a str, &'a str)>,
    pub sudo: bool,
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
    let (stdout, stderr) = decode_output_pair_at(payload, 8)?;
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
        let data = encode(MSG_PING, 42, b"hello world").unwrap();
        let mut dec = Decoder::new();
        let msgs = dec.decode(&data).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_PING);
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
        assert_eq!(d.timeout_ms, 5000);
        assert_eq!(d.command, "echo hello");
        assert_eq!(d.env, vec![("FOO", "bar")]);
        assert!(!d.sudo);
        assert!(d.stream_stdout);
        assert_eq!(d.stdout_log_path.unwrap(), "/tmp/vm0-system-123.log");
    }

    #[test]
    fn spawn_watch_payload_roundtrip_stream_only() {
        let payload = encode_spawn_watch(3000, "ls", &[], true, true, None).unwrap();
        let d = decode_spawn_watch(&payload).unwrap();
        assert_eq!(d.timeout_ms, 3000);
        assert_eq!(d.command, "ls");
        assert!(d.env.is_empty());
        assert!(d.sudo);
        assert!(d.stream_stdout);
        assert!(d.stdout_log_path.is_none());
    }

    #[test]
    fn spawn_watch_payload_roundtrip_buffered() {
        let payload = encode_spawn_watch(1000, "cmd", &[], false, false, None).unwrap();
        let d = decode_spawn_watch(&payload).unwrap();
        assert_eq!(d.command, "cmd");
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
    fn decode_process_exit_allows_trailing_bytes() {
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
