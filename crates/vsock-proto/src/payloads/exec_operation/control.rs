use crate::error::ProtocolError;
use crate::payloads::exec_control::{
    DecodedControl, DecodedControlResult, EXEC_CONTROL_CODEC_ERRORS,
    EXEC_CONTROL_RESULT_CODEC_ERRORS, ExecControlNonce, ExecControlStatus,
    decode_control_result_with_errors, decode_control_with_errors,
    encode_control_result_with_errors, encode_control_with_errors,
};

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
    encode_control_with_errors(
        target_seq,
        control_nonce,
        message_id,
        payload,
        request_timeout_ms,
        EXEC_CONTROL_CODEC_ERRORS,
    )
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
    encode_control_result_with_errors(
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
        EXEC_CONTROL_RESULT_CODEC_ERRORS,
    )
}

/// Decode exec_control payload into a [`DecodedExecControl`] struct.
pub fn decode_exec_control(payload: &[u8]) -> Result<DecodedExecControl<'_>, ProtocolError> {
    let DecodedControl {
        target_seq,
        request_timeout_ms,
        control_nonce,
        message_id,
        payload: message_payload,
    } = decode_control_with_errors(payload, EXEC_CONTROL_CODEC_ERRORS)?;
    Ok(DecodedExecControl {
        target_seq,
        request_timeout_ms,
        control_nonce,
        message_id,
        payload: message_payload,
    })
}

/// Decode exec_control_result payload into a [`DecodedExecControlResult`] struct.
pub fn decode_exec_control_result(
    payload: &[u8],
) -> Result<DecodedExecControlResult<'_>, ProtocolError> {
    let DecodedControlResult {
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    } = decode_control_result_with_errors(payload, EXEC_CONTROL_RESULT_CODEC_ERRORS)?;
    Ok(DecodedExecControlResult {
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    })
}
