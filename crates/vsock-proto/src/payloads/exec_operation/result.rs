use crate::error::ProtocolError;
use crate::frame::encode_into;
use crate::payloads::process_termination::{
    TerminationDecodeErrors, append_termination, decode_termination, termination_encoded_len,
};
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32,
};
use crate::wire::{EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED, MSG_EXEC_RESULT};

use super::ExecTermination;

pub(super) const EXEC_CAPTURED_OUTPUT_DISCARDED: u8 = 0x00;
pub(super) const EXEC_CAPTURED_OUTPUT_CAPTURED: u8 = 0x01;

/// Captured stdout/stderr in an exec result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCapturedOutput<'a> {
    /// This stream was not retained in the terminal result.
    Discarded,
    /// This stream was retained in the terminal result.
    Captured {
        /// Borrowed captured bytes from the decoded payload.
        bytes: &'a [u8],
        /// Whether retained bytes were marked as truncated.
        truncated: bool,
    },
}

/// Decoded exec_result payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecResult<'a> {
    /// Terminal state reported by the guest.
    pub termination: ExecTermination,
    /// Exec operation wall-clock duration in milliseconds.
    ///
    /// This is encoded as `u32`, matching exec timeout width.
    pub duration_ms: u32,
    /// Captured standard output state.
    pub stdout: ExecCapturedOutput<'a>,
    /// Captured standard error state.
    pub stderr: ExecCapturedOutput<'a>,
    /// UTF-8 diagnostic text borrowed from the decoded payload.
    pub diagnostic: &'a str,
}

fn exec_operation_captured_output_encoded_len(
    output: ExecCapturedOutput<'_>,
    field: &'static str,
) -> Result<usize, ProtocolError> {
    match output {
        ExecCapturedOutput::Discarded => Ok(1),
        ExecCapturedOutput::Captured { bytes, .. } => {
            ensure_u32_len(field, bytes.len())?;
            checked_payload_len_add(1 + 1 + 4, bytes.len())
        }
    }
}

fn append_exec_operation_captured_output(p: &mut Vec<u8>, output: ExecCapturedOutput<'_>) {
    match output {
        ExecCapturedOutput::Discarded => p.push(EXEC_CAPTURED_OUTPUT_DISCARDED),
        ExecCapturedOutput::Captured { bytes, truncated } => {
            p.push(EXEC_CAPTURED_OUTPUT_CAPTURED);
            p.push(if truncated {
                EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED
            } else {
                0
            });
            p.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            p.extend_from_slice(bytes);
        }
    }
}

fn validate_exec_result_payload(
    termination: ExecTermination,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(u16, usize), ProtocolError> {
    let diagnostic_len = ensure_u16_len("diagnostic", diagnostic.len())?;
    let stdout_len = exec_operation_captured_output_encoded_len(stdout, "stdout")?;
    let stderr_len = exec_operation_captured_output_encoded_len(stderr, "stderr")?;

    let mut payload_len = termination_encoded_len(termination);
    payload_len = checked_payload_len_add(payload_len, 4)?;
    payload_len = checked_payload_len_add(payload_len, stdout_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, diagnostic.len())?;
    ensure_payload_fits_message(payload_len)?;

    Ok((diagnostic_len, payload_len))
}

fn append_exec_result_payload(
    p: &mut Vec<u8>,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
    diagnostic_len: u16,
) {
    append_termination(p, termination);
    p.extend_from_slice(&duration_ms.to_be_bytes());
    append_exec_operation_captured_output(p, stdout);
    append_exec_operation_captured_output(p, stderr);
    p.extend_from_slice(&diagnostic_len.to_be_bytes());
    p.extend_from_slice(diagnostic.as_bytes());
}

/// Encode exec_result payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `diagnostic` or captured stdout/stderr cannot
/// fit its wire length field, or the encoded payload exceeds the maximum
/// message size.
pub fn encode_exec_result(
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let (diagnostic_len, payload_len) =
        validate_exec_result_payload(termination, stdout, stderr, diagnostic)?;

    let mut p = Vec::with_capacity(payload_len);
    append_exec_result_payload(
        &mut p,
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
        diagnostic_len,
    );
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

/// Encode a full exec_result frame into `frame`.
///
/// The resulting frame uses the same bytes as
/// `encode(MSG_EXEC_RESULT, seq, &encode_exec_result(...))` without allocating
/// separate payload and frame vectors.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `diagnostic` or captured stdout/stderr cannot
/// fit its wire length field, or the encoded payload exceeds the maximum
/// message size.
///
/// `frame` is cleared before payload validation. Consequently, a validation
/// error leaves the destination empty. After validation succeeds, the shared
/// frame encoder also clears `frame` before checking the frame size and writing
/// the encoded bytes.
pub fn encode_exec_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(), ProtocolError> {
    frame.clear();
    encode_exec_result_frame_into_with_type::<MSG_EXEC_RESULT>(
        frame,
        seq,
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    )
}

pub(crate) fn encode_exec_result_frame_into_with_type<const MSG_TYPE: u8>(
    frame: &mut Vec<u8>,
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(), ProtocolError> {
    let (diagnostic_len, payload_len) =
        validate_exec_result_payload(termination, stdout, stderr, diagnostic)?;
    encode_into(frame, MSG_TYPE, seq, payload_len, |frame| {
        append_exec_result_payload(
            frame,
            termination,
            duration_ms,
            stdout,
            stderr,
            diagnostic,
            diagnostic_len,
        );
    })
}

fn decode_exec_operation_captured_output<'a>(
    payload: &'a [u8],
    offset: &mut usize,
) -> Result<ExecCapturedOutput<'a>, ProtocolError> {
    match read_u8(payload, offset, "exec captured output tag truncated")? {
        EXEC_CAPTURED_OUTPUT_DISCARDED => Ok(ExecCapturedOutput::Discarded),
        EXEC_CAPTURED_OUTPUT_CAPTURED => {
            let flags = read_u8(payload, offset, "exec captured output flags truncated")?;
            if flags & !EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED != 0 {
                return Err(ProtocolError::InvalidPayload(
                    "exec captured output unknown flags",
                ));
            }
            let bytes_len =
                read_u32(payload, offset, "exec captured output bytes_len truncated")? as usize;
            let bytes = read_slice(
                payload,
                offset,
                bytes_len,
                "exec captured output bytes truncated",
            )?;
            Ok(ExecCapturedOutput::Captured {
                bytes,
                truncated: (flags & EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED) != 0,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "invalid exec captured output tag",
        )),
    }
}

/// Decode exec_result payload into a [`DecodedExecResult`] struct.
pub fn decode_exec_result(payload: &[u8]) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let mut offset = 0;
    let termination = decode_termination(
        payload,
        &mut offset,
        TerminationDecodeErrors {
            termination_truncated: "exec result termination truncated",
            exit_code_truncated: "exec result exit_code truncated",
            invalid_tag: "invalid exec termination tag",
        },
    )?;
    let duration_ms = read_u32(payload, &mut offset, "exec result duration truncated")?;
    let stdout = decode_exec_operation_captured_output(payload, &mut offset)?;
    let stderr = decode_exec_operation_captured_output(payload, &mut offset)?;
    let diagnostic_len =
        read_u16(payload, &mut offset, "exec result diagnostic_len truncated")? as usize;
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "exec result diagnostic truncated",
        "invalid UTF-8 in diagnostic",
    )?;
    expect_consumed(payload, offset, "exec result trailing bytes")?;
    Ok(DecodedExecResult {
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    })
}
