use crate::error::ProtocolError;
use crate::read::{read_u8_at, read_u16_at, read_u32_at};
use crate::wire::{SPAWN_PROCESS_FLAG_STREAM_STDOUT, SPAWN_PROCESS_FLAG_SUDO};

/// Encode spawn_process payload: command fields + optional `[2B log_path_len][log_path]`.
///
/// `stream_stdout` controls whether stdout is streamed to the host via
/// `MSG_STDOUT_CHUNK`. `stdout_log_path`, when present, additionally asks
/// the guest to tee streamed stdout to that file.
///
/// This always writes the env section (even when empty) so
/// `decode_spawn_process` can unambiguously find the log_path boundary.
pub fn encode_spawn_process(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    stream_stdout: bool,
    stdout_log_path: Option<&str>,
) -> Result<Vec<u8>, ProtocolError> {
    if !stream_stdout && stdout_log_path.is_some() {
        return Err(ProtocolError::InvalidPayload(
            "spawn_process log_path requires stream flag",
        ));
    }
    let cmd = command.as_bytes();
    let env_size: usize = 4 + env
        .iter()
        .map(|(k, v)| 8 + k.len() + v.len())
        .sum::<usize>();
    let log_path = match stdout_log_path {
        Some("") => {
            return Err(ProtocolError::InvalidPayload(
                "spawn_process log_path empty",
            ));
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
    let mut flags = if sudo { SPAWN_PROCESS_FLAG_SUDO } else { 0 };
    if stream_stdout {
        flags |= SPAWN_PROCESS_FLAG_STREAM_STDOUT;
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

/// Encode spawn_process_result payload: `[4B pid]`.
pub fn encode_spawn_process_result(pid: u32) -> Vec<u8> {
    pid.to_be_bytes().to_vec()
}

struct DecodedSpawnProcessCommandPrefix<'a> {
    timeout_ms: u32,
    command: &'a str,
    env: Vec<(&'a str, &'a str)>,
    sudo: bool,
    offset: usize,
    raw_flags: u8,
}

/// Decode the command-shaped prefix used by spawn_process payloads.
///
/// The env section is optional: if the payload ends right after the command, an
/// empty vec is returned. `encode_spawn_process` always writes the env section so
/// the optional log path remains unambiguous for new payloads.
fn decode_spawn_process_command_prefix(
    payload: &[u8],
) -> Result<DecodedSpawnProcessCommandPrefix<'_>, ProtocolError> {
    let timeout_ms = read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload(
        "command fields payload too short",
    ))?;
    let flags = read_u8_at(payload, 4).ok_or(ProtocolError::InvalidPayload(
        "command fields payload too short",
    ))?;
    let sudo = (flags & SPAWN_PROCESS_FLAG_SUDO) != 0;
    let cmd_len = read_u32_at(payload, 5).ok_or(ProtocolError::InvalidPayload(
        "command fields payload too short",
    ))? as usize;
    let command = std::str::from_utf8(payload.get(9..9 + cmd_len).ok_or(
        ProtocolError::InvalidPayload("command fields command truncated"),
    )?)
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in command"))?;

    let env_start = 9 + cmd_len;
    if env_start >= payload.len() {
        return Ok(DecodedSpawnProcessCommandPrefix {
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

    Ok(DecodedSpawnProcessCommandPrefix {
        timeout_ms,
        command,
        env,
        sudo,
        offset,
        raw_flags: flags,
    })
}

/// Decode spawn_process payload. Extends command fields with streaming metadata.
///
/// Wire format: `[command fields...]([2B log_path_len][log_path])`.
/// The log_path section is optional — if the payload ends after the command
/// fields, `stdout_log_path` is `None`.
pub fn decode_spawn_process(payload: &[u8]) -> Result<DecodedSpawnProcess<'_>, ProtocolError> {
    let DecodedSpawnProcessCommandPrefix {
        timeout_ms,
        command,
        env,
        sudo,
        offset,
        raw_flags,
    } = decode_spawn_process_command_prefix(payload)?;
    let stream_flag = (raw_flags & SPAWN_PROCESS_FLAG_STREAM_STDOUT) != 0;
    let stdout_log_path = if offset == payload.len() {
        None
    } else if offset + 2 <= payload.len() {
        let path_len = read_u16_at(payload, offset).ok_or(ProtocolError::InvalidPayload(
            "spawn_process log_path_len truncated",
        ))? as usize;
        if path_len == 0 {
            return Err(ProtocolError::InvalidPayload(
                "spawn_process log_path empty",
            ));
        } else {
            let path_end = offset + 2 + path_len;
            if path_end != payload.len() {
                return Err(ProtocolError::InvalidPayload(
                    "spawn_process trailing bytes",
                ));
            }
            Some(
                std::str::from_utf8(payload.get(offset + 2..path_end).ok_or(
                    ProtocolError::InvalidPayload("spawn_process log_path truncated"),
                )?)
                .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in log_path"))?,
            )
        }
    } else {
        return Err(ProtocolError::InvalidPayload(
            "spawn_process trailing byte after env",
        ));
    };
    if !stream_flag && stdout_log_path.is_some() {
        return Err(ProtocolError::InvalidPayload(
            "spawn_process log_path requires stream flag",
        ));
    }
    Ok(DecodedSpawnProcess {
        timeout_ms,
        command,
        env,
        sudo,
        stream_stdout: stream_flag,
        stdout_log_path,
    })
}

/// Decode spawn_process_result payload. Returns `pid`.
pub fn decode_spawn_process_result(payload: &[u8]) -> Result<u32, ProtocolError> {
    read_u32_at(payload, 0).ok_or(ProtocolError::InvalidPayload(
        "spawn_process_result too short",
    ))
}

/// Decoded spawn_process fields.
pub struct DecodedSpawnProcess<'a> {
    pub timeout_ms: u32,
    pub command: &'a str,
    pub env: Vec<(&'a str, &'a str)>,
    pub sudo: bool,
    /// Whether vsock-guest should stream stdout chunks to the host.
    pub stream_stdout: bool,
    /// Optional guest-side file path where vsock-guest also tees stdout.
    pub stdout_log_path: Option<&'a str>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_process_result_roundtrip() {
        let payload = encode_spawn_process_result(12345);
        let pid = decode_spawn_process_result(&payload).unwrap();
        assert_eq!(pid, 12345);
    }

    #[test]
    fn spawn_process_payload_roundtrip_with_log_path() {
        let payload = encode_spawn_process(
            5000,
            "echo hello",
            &[("FOO", "bar")],
            false,
            true,
            Some("/tmp/vm0-system-123.log"),
        )
        .unwrap();
        let d = decode_spawn_process(&payload).unwrap();
        assert_eq!(d.timeout_ms, 5000);
        assert_eq!(d.command, "echo hello");
        assert_eq!(d.env, vec![("FOO", "bar")]);
        assert!(!d.sudo);
        assert!(d.stream_stdout);
        assert_eq!(d.stdout_log_path.unwrap(), "/tmp/vm0-system-123.log");
    }

    #[test]
    fn spawn_process_payload_roundtrip_stream_only() {
        let payload = encode_spawn_process(3000, "ls", &[], true, true, None).unwrap();
        let d = decode_spawn_process(&payload).unwrap();
        assert_eq!(d.timeout_ms, 3000);
        assert_eq!(d.command, "ls");
        assert!(d.env.is_empty());
        assert!(d.sudo);
        assert!(d.stream_stdout);
        assert!(d.stdout_log_path.is_none());
    }

    #[test]
    fn spawn_process_payload_roundtrip_buffered() {
        let payload = encode_spawn_process(1000, "cmd", &[], false, false, None).unwrap();
        let d = decode_spawn_process(&payload).unwrap();
        assert_eq!(d.command, "cmd");
        assert!(!d.stream_stdout);
        assert!(d.stdout_log_path.is_none());
    }

    #[test]
    fn spawn_process_log_path_requires_streaming() {
        let err =
            encode_spawn_process(1000, "cmd", &[], false, false, Some("/tmp/log")).unwrap_err();
        assert!(matches!(err, ProtocolError::InvalidPayload(_)));
    }

    #[test]
    fn spawn_process_log_path_too_long() {
        let long_path = "x".repeat(u16::MAX as usize + 1);
        let err =
            encode_spawn_process(1000, "cmd", &[], false, true, Some(&long_path)).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::PayloadTooLarge("log_path", size) if size == long_path.len()
        ));
    }

    fn decode_spawn_process_error(payload: &[u8]) -> ProtocolError {
        match decode_spawn_process(payload) {
            Ok(_) => panic!("expected spawn_process payload to be rejected"),
            Err(e) => e,
        }
    }

    #[test]
    fn decode_spawn_process_rejects_empty_log_path() {
        let mut payload = encode_spawn_process(1000, "cmd", &[], false, true, None).unwrap();
        payload.extend_from_slice(&0u16.to_be_bytes());

        let err = decode_spawn_process_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_process log_path empty")
        ));
    }

    #[test]
    fn decode_spawn_process_rejects_trailing_byte_after_env() {
        let mut payload = encode_spawn_process(1000, "cmd", &[], false, true, None).unwrap();
        payload.push(0xFF);

        let err = decode_spawn_process_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_process trailing byte after env")
        ));
    }

    #[test]
    fn decode_spawn_process_rejects_trailing_bytes_after_log_path() {
        let mut payload =
            encode_spawn_process(1000, "cmd", &[], false, true, Some("/tmp/log")).unwrap();
        payload.push(0xFF);

        let err = decode_spawn_process_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_process trailing bytes")
        ));
    }

    #[test]
    fn decode_spawn_process_rejects_log_path_without_stream_flag() {
        let mut payload = encode_spawn_process(1000, "cmd", &[], false, false, None).unwrap();
        let path = b"/tmp/log";
        payload.extend_from_slice(&(path.len() as u16).to_be_bytes());
        payload.extend_from_slice(path);

        let err = decode_spawn_process_error(&payload);
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("spawn_process log_path requires stream flag")
        ));
    }
}
