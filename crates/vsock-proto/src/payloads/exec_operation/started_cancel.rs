use crate::error::ProtocolError;
use crate::read::{expect_consumed, read_u32};

/// Decoded exec_started payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecStarted {
    pub pid: u32,
}

/// Encode exec_started payload: `[4B pid]`.
pub fn encode_exec_started(pid: u32) -> Result<Vec<u8>, ProtocolError> {
    if pid == 0 {
        return Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero",
        ));
    }
    Ok(pid.to_be_bytes().to_vec())
}

/// Encode exec_cancel payload.
pub fn encode_exec_cancel() -> Vec<u8> {
    Vec::new()
}

/// Decode exec_started payload into a [`DecodedExecStarted`] struct.
pub fn decode_exec_started(payload: &[u8]) -> Result<DecodedExecStarted, ProtocolError> {
    let mut offset = 0;
    let pid = read_u32(payload, &mut offset, "exec started pid truncated")?;
    if pid == 0 {
        return Err(ProtocolError::InvalidPayload(
            "exec started pid must be non-zero",
        ));
    }
    expect_consumed(payload, offset, "exec started trailing bytes")?;
    Ok(DecodedExecStarted { pid })
}

/// Decode exec_cancel payload.
pub fn decode_exec_cancel(payload: &[u8]) -> Result<(), ProtocolError> {
    if !payload.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "exec cancel payload must be empty",
        ));
    }
    Ok(())
}
