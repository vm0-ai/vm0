use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32,
};

/// Number of bytes in an exec-control nonce.
pub const EXEC_CONTROL_NONCE_LEN: usize = 16;
/// Mirrors `process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES` so host-side
/// encoding rejects requests that the guest-side local IPC channel cannot carry.
pub const EXEC_CONTROL_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Opaque token registered with an exec operation and echoed by control messages.
pub type ExecControlNonce = [u8; EXEC_CONTROL_NONCE_LEN];

/// Terminal status carried by the `exec_control_result.status` byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecControlStatus {
    /// Wire value `0x00`: the control request reached the sink and was accepted.
    Delivered = 0x00,
    /// Wire value `0x01`: no active exec operation exists for the target sequence.
    Inactive = 0x01,
    /// Wire value `0x02`: the target operation exists, but the nonce did not match.
    NonceMismatch = 0x02,
    /// Wire value `0x03`: the target operation does not support exec control.
    Unsupported = 0x03,
    /// Wire value `0x04`: the sink received the request and rejected it.
    Rejected = 0x04,
    /// Wire value `0x05`: the peer reports that the control sink is unavailable.
    SinkUnavailable = 0x05,
    /// Wire value `0x06`: the sink did not respond before the request timeout.
    SinkTimeout = 0x06,
    /// Wire value `0x07`: the target operation cannot queue another control request.
    QueueFull = 0x07,
    /// Wire value `0x08`: the sink failed while processing or exchanging the request.
    SinkError = 0x08,
}

const EXEC_CONTROL_STATUS_DELIVERED: u8 = ExecControlStatus::Delivered as u8;
const EXEC_CONTROL_STATUS_INACTIVE: u8 = ExecControlStatus::Inactive as u8;
const EXEC_CONTROL_STATUS_NONCE_MISMATCH: u8 = ExecControlStatus::NonceMismatch as u8;
const EXEC_CONTROL_STATUS_UNSUPPORTED: u8 = ExecControlStatus::Unsupported as u8;
const EXEC_CONTROL_STATUS_REJECTED: u8 = ExecControlStatus::Rejected as u8;
const EXEC_CONTROL_STATUS_SINK_UNAVAILABLE: u8 = ExecControlStatus::SinkUnavailable as u8;
const EXEC_CONTROL_STATUS_SINK_TIMEOUT: u8 = ExecControlStatus::SinkTimeout as u8;
const EXEC_CONTROL_STATUS_QUEUE_FULL: u8 = ExecControlStatus::QueueFull as u8;
const EXEC_CONTROL_STATUS_SINK_ERROR: u8 = ExecControlStatus::SinkError as u8;

/// Decoded exec_control payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecControl<'a> {
    /// Non-zero sequence number of the active exec operation being controlled.
    ///
    /// This is distinct from the outer frame `seq` used to correlate the
    /// `exec_control` request message with its `exec_control_result` response.
    pub target_seq: u32,
    /// Caller-visible local sink budget in milliseconds after guest receipt.
    ///
    /// The guest applies this budget across local sink connection, request
    /// write, and response read. A value of `0` is valid and means no remaining
    /// local sink budget, not an unbounded timeout.
    pub request_timeout_ms: u32,
    /// Per-operation nonce registered with the target exec operation.
    ///
    /// Peers echo this value in results and use it to reject stale or
    /// mismatched control messages.
    pub control_nonce: ExecControlNonce,
    /// Non-empty payload-level correlation id for the local sink exchange.
    ///
    /// This identifies the local control request/response payload exchange and
    /// does not replace the outer frame `seq` correlation.
    pub message_id: &'a str,
    /// Local sink request bytes.
    ///
    /// This may be empty and is bounded by
    /// [`crate::EXEC_CONTROL_MAX_PAYLOAD_BYTES`].
    pub payload: &'a [u8],
}

/// Decoded exec_control_result payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedExecControlResult<'a> {
    /// Sequence number of the exec operation that the result refers to.
    ///
    /// This echoes the control request payload's `target_seq` and is distinct
    /// from the outer frame `seq` used for the control request/result exchange.
    pub target_seq: u32,
    /// Per-operation nonce echoed from the control request.
    ///
    /// Peers use this value to reject results that do not match the pending
    /// control request.
    pub control_nonce: ExecControlNonce,
    /// Payload-level correlation id echoed from the local sink exchange.
    ///
    /// This must match the pending control request's `message_id`.
    pub message_id: &'a str,
    /// Terminal delivery outcome for the control request.
    pub status: ExecControlStatus,
    /// UTF-8 diagnostic string for the terminal delivery outcome.
    ///
    /// This may be empty and is bounded by the result payload's `u16`
    /// diagnostic length field.
    pub diagnostic: &'a str,
}

#[derive(Clone, Copy)]
struct ControlIdentity<'a> {
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &'a str,
}

#[derive(Clone, Copy)]
struct ControlIdentityErrors {
    target_seq_zero: &'static str,
    message_id_empty: &'static str,
    target_seq_truncated: &'static str,
    nonce_truncated: &'static str,
    message_id_len_truncated: &'static str,
    message_id_truncated: &'static str,
    message_id_utf8: &'static str,
}

const EXEC_CONTROL_IDENTITY_ERRORS: ControlIdentityErrors = ControlIdentityErrors {
    target_seq_zero: "exec_control target_seq must be non-zero",
    message_id_empty: "exec_control message_id empty",
    target_seq_truncated: "exec_control target_seq truncated",
    nonce_truncated: "exec_control nonce truncated",
    message_id_len_truncated: "exec_control message_id_len truncated",
    message_id_truncated: "exec_control message_id truncated",
    message_id_utf8: "invalid UTF-8 in exec_control message_id",
};

const EXEC_CONTROL_RESULT_IDENTITY_ERRORS: ControlIdentityErrors = ControlIdentityErrors {
    target_seq_zero: "exec_control_result target_seq must be non-zero",
    message_id_empty: "exec_control_result message_id empty",
    target_seq_truncated: "exec_control_result target_seq truncated",
    nonce_truncated: "exec_control_result nonce truncated",
    message_id_len_truncated: "exec_control_result message_id_len truncated",
    message_id_truncated: "exec_control_result message_id truncated",
    message_id_utf8: "invalid UTF-8 in exec_control_result message_id",
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

fn status_from_wire(value: u8) -> Result<ExecControlStatus, ProtocolError> {
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
        _ => Err(ProtocolError::InvalidPayload(
            "exec_control_result status invalid",
        )),
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

fn validate_control_identity(
    identity: ControlIdentity<'_>,
    errors: ControlIdentityErrors,
) -> Result<(), ProtocolError> {
    if identity.target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(errors.target_seq_zero));
    }
    if identity.message_id.is_empty() {
        return Err(ProtocolError::InvalidPayload(errors.message_id_empty));
    }
    Ok(())
}

fn append_control_identity_tail(
    out: &mut Vec<u8>,
    identity: ControlIdentity<'_>,
    message_id_len: u16,
) {
    out.extend_from_slice(&identity.control_nonce);
    out.extend_from_slice(&message_id_len.to_be_bytes());
    out.extend_from_slice(identity.message_id.as_bytes());
}

fn read_non_zero_target_seq(
    payload: &[u8],
    offset: &mut usize,
    errors: ControlIdentityErrors,
) -> Result<u32, ProtocolError> {
    let target_seq = read_u32(payload, offset, errors.target_seq_truncated)?;
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(errors.target_seq_zero));
    }
    Ok(target_seq)
}

fn read_control_nonce(
    payload: &[u8],
    offset: &mut usize,
    errors: ControlIdentityErrors,
) -> Result<ExecControlNonce, ProtocolError> {
    let nonce_bytes = read_slice(
        payload,
        offset,
        EXEC_CONTROL_NONCE_LEN,
        errors.nonce_truncated,
    )?;
    let mut control_nonce = [0; EXEC_CONTROL_NONCE_LEN];
    control_nonce.copy_from_slice(nonce_bytes);
    Ok(control_nonce)
}

fn read_control_message_id<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    errors: ControlIdentityErrors,
) -> Result<&'a str, ProtocolError> {
    let message_id_len = read_u16(payload, offset, errors.message_id_len_truncated)? as usize;
    if message_id_len == 0 {
        return Err(ProtocolError::InvalidPayload(errors.message_id_empty));
    }
    read_str(
        payload,
        offset,
        message_id_len,
        errors.message_id_truncated,
        errors.message_id_utf8,
    )
}

fn read_control_identity_tail<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    target_seq: u32,
    errors: ControlIdentityErrors,
) -> Result<ControlIdentity<'a>, ProtocolError> {
    let control_nonce = read_control_nonce(payload, offset, errors)?;
    let message_id = read_control_message_id(payload, offset, errors)?;
    Ok(ControlIdentity {
        target_seq,
        control_nonce,
        message_id,
    })
}

/// Encode an exec_control payload.
///
/// `target_seq` is the non-zero sequence number of the active exec operation
/// being controlled. It is separate from the outer frame `seq` that carries the
/// control request itself.
///
/// `control_nonce` is the per-operation nonce registered with the target exec
/// operation and later echoed by the result. `message_id` is the non-empty
/// payload-level correlation id for the local sink request/response exchange.
/// `payload` contains the local sink request bytes and may be empty.
///
/// `request_timeout_ms` is the caller-visible local sink budget in milliseconds
/// after guest receipt. A value of `0` is valid and means no remaining local
/// sink budget, not an unbounded timeout.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `target_seq` is zero, `message_id` is empty or
/// too long, `payload` exceeds [`crate::EXEC_CONTROL_MAX_PAYLOAD_BYTES`], or
/// the encoded payload would exceed the maximum message size.
pub fn encode_exec_control(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    payload: &[u8],
    request_timeout_ms: u32,
) -> Result<Vec<u8>, ProtocolError> {
    let identity = ControlIdentity {
        target_seq,
        control_nonce,
        message_id,
    };
    validate_control_identity(identity, EXEC_CONTROL_IDENTITY_ERRORS)?;
    if payload.len() > EXEC_CONTROL_MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge("payload", payload.len()));
    }
    let message_id_len = ensure_u16_len("message_id", identity.message_id.len())?;
    let payload_len = ensure_u32_len("payload", payload.len())?;
    let total_len = encoded_control_len(message_id.len(), payload.len())?;
    ensure_payload_fits_message(total_len)?;

    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(&identity.target_seq.to_be_bytes());
    out.extend_from_slice(&request_timeout_ms.to_be_bytes());
    append_control_identity_tail(&mut out, identity, message_id_len);
    out.extend_from_slice(&payload_len.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Encode an exec_control_result payload.
///
/// `target_seq`, `control_nonce`, and `message_id` echo the corresponding
/// control request payload fields so the peer can match the result to the
/// pending control request. The outer frame `seq` still carries the
/// request/response correlation for the control message itself.
///
/// `status` carries the terminal delivery outcome as an [`ExecControlStatus`].
/// `diagnostic` is a UTF-8 diagnostic string for that outcome and may be empty.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `target_seq` is zero, `message_id` is empty or
/// too long, `diagnostic` is too long, or the encoded payload would exceed the
/// maximum message size.
pub fn encode_exec_control_result(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let identity = ControlIdentity {
        target_seq,
        control_nonce,
        message_id,
    };
    validate_control_identity(identity, EXEC_CONTROL_RESULT_IDENTITY_ERRORS)?;
    let message_id_len = ensure_u16_len("message_id", identity.message_id.len())?;
    let diagnostic_len = ensure_u16_len("diagnostic", diagnostic.len())?;
    let total_len = encoded_result_len(message_id.len(), diagnostic.len())?;
    ensure_payload_fits_message(total_len)?;

    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(&identity.target_seq.to_be_bytes());
    append_control_identity_tail(&mut out, identity, message_id_len);
    out.push(status_to_wire(status));
    out.extend_from_slice(&diagnostic_len.to_be_bytes());
    out.extend_from_slice(diagnostic.as_bytes());
    Ok(out)
}

/// Decode exec_control payload into a [`DecodedExecControl`] struct.
pub fn decode_exec_control(payload: &[u8]) -> Result<DecodedExecControl<'_>, ProtocolError> {
    let mut offset = 0;
    let target_seq = read_non_zero_target_seq(payload, &mut offset, EXEC_CONTROL_IDENTITY_ERRORS)?;
    let request_timeout_ms = read_u32(
        payload,
        &mut offset,
        "exec_control request_timeout_ms truncated",
    )?;
    let identity = read_control_identity_tail(
        payload,
        &mut offset,
        target_seq,
        EXEC_CONTROL_IDENTITY_ERRORS,
    )?;
    let payload_len =
        read_u32(payload, &mut offset, "exec_control payload_len truncated")? as usize;
    if payload_len > EXEC_CONTROL_MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "exec_control payload too large",
        ));
    }
    let message_payload = read_slice(
        payload,
        &mut offset,
        payload_len,
        "exec_control payload truncated",
    )?;
    expect_consumed(payload, offset, "exec_control trailing bytes")?;

    Ok(DecodedExecControl {
        target_seq: identity.target_seq,
        request_timeout_ms,
        control_nonce: identity.control_nonce,
        message_id: identity.message_id,
        payload: message_payload,
    })
}

/// Decode exec_control_result payload into a [`DecodedExecControlResult`] struct.
pub fn decode_exec_control_result(
    payload: &[u8],
) -> Result<DecodedExecControlResult<'_>, ProtocolError> {
    let mut offset = 0;
    let target_seq =
        read_non_zero_target_seq(payload, &mut offset, EXEC_CONTROL_RESULT_IDENTITY_ERRORS)?;
    let identity = read_control_identity_tail(
        payload,
        &mut offset,
        target_seq,
        EXEC_CONTROL_RESULT_IDENTITY_ERRORS,
    )?;
    let status = status_from_wire(read_u8(
        payload,
        &mut offset,
        "exec_control_result status truncated",
    )?)?;
    let diagnostic_len = read_u16(
        payload,
        &mut offset,
        "exec_control_result diagnostic_len truncated",
    )? as usize;
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "exec_control_result diagnostic truncated",
        "invalid UTF-8 in exec_control_result diagnostic",
    )?;
    expect_consumed(payload, offset, "exec_control_result trailing bytes")?;

    Ok(DecodedExecControlResult {
        target_seq: identity.target_seq,
        control_nonce: identity.control_nonce,
        message_id: identity.message_id,
        status,
        diagnostic,
    })
}
