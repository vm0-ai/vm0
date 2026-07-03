use crate::error::ProtocolError;
use crate::frame::encode_into;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u32_len, expect_consumed,
    read_slice, read_u8, read_u32,
};
use crate::wire::{EXEC_OUTPUT_FLAG_TRUNCATED, MSG_EXEC_OUTPUT};

const EXEC_OUTPUT_STREAM_STDOUT: u8 = 0x00;
const EXEC_OUTPUT_STREAM_STDERR: u8 = 0x01;

/// Exec output stream selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOutputStream {
    /// Standard output stream.
    Stdout,
    /// Standard error stream.
    Stderr,
}

/// Decoded exec_output payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecOutput<'a> {
    /// Output stream that produced this chunk.
    pub stream: ExecOutputStream,
    /// Per-operation output sequence number.
    ///
    /// This starts at `0` for each exec operation and increments across stdout
    /// and stderr output frames.
    pub output_seq: u32,
    /// Output bytes borrowed from the decoded payload.
    pub chunk: &'a [u8],
    /// Whether this emitted output frame was marked as truncated.
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
    let (chunk_len, payload_len) = validate_exec_output_payload(chunk)?;

    let mut p = Vec::with_capacity(payload_len);
    append_exec_output_payload(&mut p, stream, output_seq, chunk, chunk_len, truncated);
    Ok(p)
}

/// Encode a full exec_output frame into `frame`.
///
/// The resulting frame uses the same bytes as
/// `encode(MSG_EXEC_OUTPUT, seq, &encode_exec_output(...))` without allocating
/// separate payload and frame vectors.
pub fn encode_exec_output_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    stream: ExecOutputStream,
    output_seq: u32,
    chunk: &[u8],
    truncated: bool,
) -> Result<(), ProtocolError> {
    frame.clear();
    let (chunk_len, payload_len) = validate_exec_output_payload(chunk)?;
    encode_into(frame, MSG_EXEC_OUTPUT, seq, payload_len, |frame| {
        append_exec_output_payload(frame, stream, output_seq, chunk, chunk_len, truncated);
    })
}

fn validate_exec_output_payload(chunk: &[u8]) -> Result<(u32, usize), ProtocolError> {
    let chunk_len = ensure_u32_len("chunk", chunk.len())?;
    let payload_len = checked_payload_len_add(1 + 4 + 1 + 4, chunk.len())?;
    ensure_payload_fits_message(payload_len)?;
    Ok((chunk_len, payload_len))
}

fn append_exec_output_payload(
    p: &mut Vec<u8>,
    stream: ExecOutputStream,
    output_seq: u32,
    chunk: &[u8],
    chunk_len: u32,
    truncated: bool,
) {
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
