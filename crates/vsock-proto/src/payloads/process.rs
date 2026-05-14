use crate::error::ProtocolError;
use crate::read::{read_i32_at, read_u32_at};

fn append_output_pair(p: &mut Vec<u8>, stdout: &[u8], stderr: &[u8]) {
    p.extend_from_slice(&(stdout.len() as u32).to_be_bytes());
    p.extend_from_slice(stdout);
    p.extend_from_slice(&(stderr.len() as u32).to_be_bytes());
    p.extend_from_slice(stderr);
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
