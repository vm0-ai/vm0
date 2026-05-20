use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32,
};

pub const EXEC_CONTROL_NONCE_LEN: usize = 16;
/// Mirrors `process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES` so host-side
/// encoding rejects requests that the guest-side local IPC channel cannot carry.
pub const EXEC_CONTROL_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

pub type ExecControlNonce = [u8; EXEC_CONTROL_NONCE_LEN];

const EXEC_CONTROL_STATUS_DELIVERED: u8 = 0x00;
const EXEC_CONTROL_STATUS_INACTIVE: u8 = 0x01;
const EXEC_CONTROL_STATUS_NONCE_MISMATCH: u8 = 0x02;
const EXEC_CONTROL_STATUS_UNSUPPORTED: u8 = 0x03;
const EXEC_CONTROL_STATUS_REJECTED: u8 = 0x04;
const EXEC_CONTROL_STATUS_SINK_UNAVAILABLE: u8 = 0x05;
const EXEC_CONTROL_STATUS_SINK_TIMEOUT: u8 = 0x06;
const EXEC_CONTROL_STATUS_QUEUE_FULL: u8 = 0x07;
const EXEC_CONTROL_STATUS_SINK_ERROR: u8 = 0x08;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecControlStatus {
    Delivered,
    Inactive,
    NonceMismatch,
    Unsupported,
    Rejected,
    SinkUnavailable,
    SinkTimeout,
    QueueFull,
    SinkError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedControl<'a> {
    pub target_seq: u32,
    pub request_timeout_ms: u32,
    pub control_nonce: ExecControlNonce,
    pub message_id: &'a str,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedControlResult<'a> {
    pub target_seq: u32,
    pub control_nonce: ExecControlNonce,
    pub message_id: &'a str,
    pub status: ExecControlStatus,
    pub diagnostic: &'a str,
}

#[derive(Clone, Copy)]
pub(crate) struct ControlCodecErrors {
    target_seq_zero: &'static str,
    message_id_empty: &'static str,
    target_seq_truncated: &'static str,
    request_timeout_ms_truncated: &'static str,
    nonce_truncated: &'static str,
    nonce_invalid: &'static str,
    message_id_len_truncated: &'static str,
    message_id_truncated: &'static str,
    message_id_utf8: &'static str,
    payload_len_truncated: &'static str,
    payload_too_large: &'static str,
    payload_truncated: &'static str,
    trailing_bytes: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct ControlResultCodecErrors {
    target_seq_zero: &'static str,
    message_id_empty: &'static str,
    target_seq_truncated: &'static str,
    nonce_truncated: &'static str,
    nonce_invalid: &'static str,
    message_id_len_truncated: &'static str,
    message_id_truncated: &'static str,
    message_id_utf8: &'static str,
    status_truncated: &'static str,
    status_invalid: &'static str,
    diagnostic_len_truncated: &'static str,
    diagnostic_truncated: &'static str,
    diagnostic_utf8: &'static str,
    trailing_bytes: &'static str,
}

pub(crate) const EXEC_CONTROL_CODEC_ERRORS: ControlCodecErrors = ControlCodecErrors {
    target_seq_zero: "exec_control target_seq must be non-zero",
    message_id_empty: "exec_control message_id empty",
    target_seq_truncated: "exec_control target_seq truncated",
    request_timeout_ms_truncated: "exec_control request_timeout_ms truncated",
    nonce_truncated: "exec_control nonce truncated",
    nonce_invalid: "exec_control nonce invalid",
    message_id_len_truncated: "exec_control message_id_len truncated",
    message_id_truncated: "exec_control message_id truncated",
    message_id_utf8: "invalid UTF-8 in exec_control message_id",
    payload_len_truncated: "exec_control payload_len truncated",
    payload_too_large: "exec_control payload too large",
    payload_truncated: "exec_control payload truncated",
    trailing_bytes: "exec_control trailing bytes",
};

pub(crate) const EXEC_CONTROL_RESULT_CODEC_ERRORS: ControlResultCodecErrors =
    ControlResultCodecErrors {
        target_seq_zero: "exec_control_result target_seq must be non-zero",
        message_id_empty: "exec_control_result message_id empty",
        target_seq_truncated: "exec_control_result target_seq truncated",
        nonce_truncated: "exec_control_result nonce truncated",
        nonce_invalid: "exec_control_result nonce invalid",
        message_id_len_truncated: "exec_control_result message_id_len truncated",
        message_id_truncated: "exec_control_result message_id truncated",
        message_id_utf8: "invalid UTF-8 in exec_control_result message_id",
        status_truncated: "exec_control_result status truncated",
        status_invalid: "exec_control_result status invalid",
        diagnostic_len_truncated: "exec_control_result diagnostic_len truncated",
        diagnostic_truncated: "exec_control_result diagnostic truncated",
        diagnostic_utf8: "invalid UTF-8 in exec_control_result diagnostic",
        trailing_bytes: "exec_control_result trailing bytes",
    };

fn status_to_wire(status: ExecControlStatus) -> u8 {
    match status {
        ExecControlStatus::Delivered => EXEC_CONTROL_STATUS_DELIVERED,
        ExecControlStatus::Inactive => EXEC_CONTROL_STATUS_INACTIVE,
        ExecControlStatus::NonceMismatch => EXEC_CONTROL_STATUS_NONCE_MISMATCH,
        ExecControlStatus::Unsupported => EXEC_CONTROL_STATUS_UNSUPPORTED,
        ExecControlStatus::Rejected => EXEC_CONTROL_STATUS_REJECTED,
        ExecControlStatus::SinkUnavailable => EXEC_CONTROL_STATUS_SINK_UNAVAILABLE,
        ExecControlStatus::SinkTimeout => EXEC_CONTROL_STATUS_SINK_TIMEOUT,
        ExecControlStatus::QueueFull => EXEC_CONTROL_STATUS_QUEUE_FULL,
        ExecControlStatus::SinkError => EXEC_CONTROL_STATUS_SINK_ERROR,
    }
}

fn status_from_wire(
    value: u8,
    invalid_payload_message: &'static str,
) -> Result<ExecControlStatus, ProtocolError> {
    match value {
        EXEC_CONTROL_STATUS_DELIVERED => Ok(ExecControlStatus::Delivered),
        EXEC_CONTROL_STATUS_INACTIVE => Ok(ExecControlStatus::Inactive),
        EXEC_CONTROL_STATUS_NONCE_MISMATCH => Ok(ExecControlStatus::NonceMismatch),
        EXEC_CONTROL_STATUS_UNSUPPORTED => Ok(ExecControlStatus::Unsupported),
        EXEC_CONTROL_STATUS_REJECTED => Ok(ExecControlStatus::Rejected),
        EXEC_CONTROL_STATUS_SINK_UNAVAILABLE => Ok(ExecControlStatus::SinkUnavailable),
        EXEC_CONTROL_STATUS_SINK_TIMEOUT => Ok(ExecControlStatus::SinkTimeout),
        EXEC_CONTROL_STATUS_QUEUE_FULL => Ok(ExecControlStatus::QueueFull),
        EXEC_CONTROL_STATUS_SINK_ERROR => Ok(ExecControlStatus::SinkError),
        _ => Err(ProtocolError::InvalidPayload(invalid_payload_message)),
    }
}

fn encoded_control_len(message_id_len: usize, payload_len: usize) -> Result<usize, ProtocolError> {
    let mut total = 4 + 4 + EXEC_CONTROL_NONCE_LEN + 2;
    total = checked_payload_len_add(total, message_id_len)?;
    total = checked_payload_len_add(total, 4)?;
    checked_payload_len_add(total, payload_len)
}

fn encoded_result_len(
    message_id_len: usize,
    diagnostic_len: usize,
) -> Result<usize, ProtocolError> {
    let mut total = 4 + EXEC_CONTROL_NONCE_LEN + 2;
    total = checked_payload_len_add(total, message_id_len)?;
    total = checked_payload_len_add(total, 1 + 2)?;
    checked_payload_len_add(total, diagnostic_len)
}

pub(crate) fn encode_control_with_errors(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    payload: &[u8],
    request_timeout_ms: u32,
    errors: ControlCodecErrors,
) -> Result<Vec<u8>, ProtocolError> {
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(errors.target_seq_zero));
    }
    if message_id.is_empty() {
        return Err(ProtocolError::InvalidPayload(errors.message_id_empty));
    }
    if payload.len() > EXEC_CONTROL_MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge("payload", payload.len()));
    }
    let message_id_len = ensure_u16_len("message_id", message_id.len())?;
    let payload_len = ensure_u32_len("payload", payload.len())?;
    let total_len = encoded_control_len(message_id.len(), payload.len())?;
    ensure_payload_fits_message(total_len)?;

    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(&target_seq.to_be_bytes());
    out.extend_from_slice(&request_timeout_ms.to_be_bytes());
    out.extend_from_slice(&control_nonce);
    out.extend_from_slice(&message_id_len.to_be_bytes());
    out.extend_from_slice(message_id.as_bytes());
    out.extend_from_slice(&payload_len.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub(crate) fn decode_control_with_errors(
    payload: &[u8],
    errors: ControlCodecErrors,
) -> Result<DecodedControl<'_>, ProtocolError> {
    let mut offset = 0;
    let target_seq = read_u32(payload, &mut offset, errors.target_seq_truncated)?;
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(errors.target_seq_zero));
    }
    let request_timeout_ms = read_u32(payload, &mut offset, errors.request_timeout_ms_truncated)?;
    let nonce_bytes = read_slice(
        payload,
        &mut offset,
        EXEC_CONTROL_NONCE_LEN,
        errors.nonce_truncated,
    )?;
    let control_nonce: ExecControlNonce = nonce_bytes
        .try_into()
        .map_err(|_| ProtocolError::InvalidPayload(errors.nonce_invalid))?;
    let message_id_len = read_u16(payload, &mut offset, errors.message_id_len_truncated)? as usize;
    if message_id_len == 0 {
        return Err(ProtocolError::InvalidPayload(errors.message_id_empty));
    }
    let message_id = read_str(
        payload,
        &mut offset,
        message_id_len,
        errors.message_id_truncated,
        errors.message_id_utf8,
    )?;
    let payload_len = read_u32(payload, &mut offset, errors.payload_len_truncated)? as usize;
    if payload_len > EXEC_CONTROL_MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::InvalidPayload(errors.payload_too_large));
    }
    let message_payload = read_slice(payload, &mut offset, payload_len, errors.payload_truncated)?;
    expect_consumed(payload, offset, errors.trailing_bytes)?;

    Ok(DecodedControl {
        target_seq,
        request_timeout_ms,
        control_nonce,
        message_id,
        payload: message_payload,
    })
}

pub(crate) fn encode_control_result_with_errors(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
    errors: ControlResultCodecErrors,
) -> Result<Vec<u8>, ProtocolError> {
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(errors.target_seq_zero));
    }
    if message_id.is_empty() {
        return Err(ProtocolError::InvalidPayload(errors.message_id_empty));
    }
    let message_id_len = ensure_u16_len("message_id", message_id.len())?;
    let diagnostic_len = ensure_u16_len("diagnostic", diagnostic.len())?;
    let total_len = encoded_result_len(message_id.len(), diagnostic.len())?;
    ensure_payload_fits_message(total_len)?;

    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(&target_seq.to_be_bytes());
    out.extend_from_slice(&control_nonce);
    out.extend_from_slice(&message_id_len.to_be_bytes());
    out.extend_from_slice(message_id.as_bytes());
    out.push(status_to_wire(status));
    out.extend_from_slice(&diagnostic_len.to_be_bytes());
    out.extend_from_slice(diagnostic.as_bytes());
    Ok(out)
}

pub(crate) fn decode_control_result_with_errors(
    payload: &[u8],
    errors: ControlResultCodecErrors,
) -> Result<DecodedControlResult<'_>, ProtocolError> {
    let mut offset = 0;
    let target_seq = read_u32(payload, &mut offset, errors.target_seq_truncated)?;
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(errors.target_seq_zero));
    }
    let nonce_bytes = read_slice(
        payload,
        &mut offset,
        EXEC_CONTROL_NONCE_LEN,
        errors.nonce_truncated,
    )?;
    let control_nonce: ExecControlNonce = nonce_bytes
        .try_into()
        .map_err(|_| ProtocolError::InvalidPayload(errors.nonce_invalid))?;
    let message_id_len = read_u16(payload, &mut offset, errors.message_id_len_truncated)? as usize;
    if message_id_len == 0 {
        return Err(ProtocolError::InvalidPayload(errors.message_id_empty));
    }
    let message_id = read_str(
        payload,
        &mut offset,
        message_id_len,
        errors.message_id_truncated,
        errors.message_id_utf8,
    )?;
    let status = status_from_wire(
        read_u8(payload, &mut offset, errors.status_truncated)?,
        errors.status_invalid,
    )?;
    let diagnostic_len = read_u16(payload, &mut offset, errors.diagnostic_len_truncated)? as usize;
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        errors.diagnostic_truncated,
        errors.diagnostic_utf8,
    )?;
    expect_consumed(payload, offset, errors.trailing_bytes)?;

    Ok(DecodedControlResult {
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    })
}
