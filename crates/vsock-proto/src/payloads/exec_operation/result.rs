use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_i32, read_slice, read_str, read_u8, read_u16, read_u32,
};
use crate::wire::EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED;

pub(super) const EXEC_TERMINATION_EXITED: u8 = 0x00;
pub(super) const EXEC_TERMINATION_TIMED_OUT: u8 = 0x01;
pub(super) const EXEC_TERMINATION_CANCELLED: u8 = 0x02;
pub(super) const EXEC_TERMINATION_START_FAILED: u8 = 0x03;
pub(super) const EXEC_TERMINATION_WAIT_FAILED: u8 = 0x04;

pub(super) const EXEC_CAPTURED_OUTPUT_DISCARDED: u8 = 0x00;
pub(super) const EXEC_CAPTURED_OUTPUT_CAPTURED: u8 = 0x01;

/// Exec terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecTermination {
    /// Process exited with an exit status.
    Exited {
        /// Signed process exit code reported by the guest.
        exit_code: i32,
    },
    /// Operation timed out before completion.
    TimedOut,
    /// Operation was cancelled before completion.
    Cancelled,
    /// Guest failed to start the process.
    StartFailed,
    /// Guest failed while waiting for the process to finish.
    WaitFailed,
}

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

fn exec_termination_encoded_len(termination: ExecTermination) -> usize {
    match termination {
        ExecTermination::Exited { .. } => 5,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => 1,
    }
}

fn append_exec_termination(p: &mut Vec<u8>, termination: ExecTermination) {
    match termination {
        ExecTermination::Exited { exit_code } => {
            p.push(EXEC_TERMINATION_EXITED);
            p.extend_from_slice(&exit_code.to_be_bytes());
        }
        ExecTermination::TimedOut => p.push(EXEC_TERMINATION_TIMED_OUT),
        ExecTermination::Cancelled => p.push(EXEC_TERMINATION_CANCELLED),
        ExecTermination::StartFailed => p.push(EXEC_TERMINATION_START_FAILED),
        ExecTermination::WaitFailed => p.push(EXEC_TERMINATION_WAIT_FAILED),
    }
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

/// Encode exec_result payload.
pub fn encode_exec_result(
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let diagnostic_bytes = diagnostic.as_bytes();
    let diagnostic_len = ensure_u16_len("diagnostic", diagnostic_bytes.len())?;
    let stdout_len = exec_operation_captured_output_encoded_len(stdout, "stdout")?;
    let stderr_len = exec_operation_captured_output_encoded_len(stderr, "stderr")?;

    let mut payload_len = exec_termination_encoded_len(termination);
    payload_len = checked_payload_len_add(payload_len, 4)?;
    payload_len = checked_payload_len_add(payload_len, stdout_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, diagnostic_bytes.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    append_exec_termination(&mut p, termination);
    p.extend_from_slice(&duration_ms.to_be_bytes());
    append_exec_operation_captured_output(&mut p, stdout);
    append_exec_operation_captured_output(&mut p, stderr);
    p.extend_from_slice(&diagnostic_len.to_be_bytes());
    p.extend_from_slice(diagnostic_bytes);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

fn decode_exec_termination(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecTermination, ProtocolError> {
    match read_u8(payload, offset, "exec result termination truncated")? {
        EXEC_TERMINATION_EXITED => {
            let exit_code = read_i32(payload, offset, "exec result exit_code truncated")?;
            Ok(ExecTermination::Exited { exit_code })
        }
        EXEC_TERMINATION_TIMED_OUT => Ok(ExecTermination::TimedOut),
        EXEC_TERMINATION_CANCELLED => Ok(ExecTermination::Cancelled),
        EXEC_TERMINATION_START_FAILED => Ok(ExecTermination::StartFailed),
        EXEC_TERMINATION_WAIT_FAILED => Ok(ExecTermination::WaitFailed),
        _ => Err(ProtocolError::InvalidPayload(
            "invalid exec termination tag",
        )),
    }
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
    let termination = decode_exec_termination(payload, &mut offset)?;
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
