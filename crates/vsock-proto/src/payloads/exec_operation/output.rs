use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u32_len, expect_consumed,
    read_slice, read_u8, read_u32,
};
use crate::wire::EXEC_OUTPUT_FLAG_TRUNCATED;

const EXEC_OUTPUT_STREAM_STDOUT: u8 = 0x00;
const EXEC_OUTPUT_STREAM_STDERR: u8 = 0x01;

/// Exec output stream selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOutputStream {
    Stdout,
    Stderr,
}

/// Decoded exec_output payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecOutput<'a> {
    pub stream: ExecOutputStream,
    pub output_seq: u32,
    pub chunk: &'a [u8],
    pub truncated: bool,
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
