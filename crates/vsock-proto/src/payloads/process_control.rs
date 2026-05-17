use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32,
};

pub const PROCESS_CONTROL_NONCE_LEN: usize = 16;
/// Mirrors `process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES` so host-side
/// encoding rejects requests that the guest-side local IPC channel cannot carry.
pub const PROCESS_CONTROL_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

pub type ProcessControlNonce = [u8; PROCESS_CONTROL_NONCE_LEN];

const PROCESS_CONTROL_STATUS_DELIVERED: u8 = 0x00;
const PROCESS_CONTROL_STATUS_INACTIVE: u8 = 0x01;
const PROCESS_CONTROL_STATUS_NONCE_MISMATCH: u8 = 0x02;
const PROCESS_CONTROL_STATUS_UNSUPPORTED: u8 = 0x03;
const PROCESS_CONTROL_STATUS_REJECTED: u8 = 0x04;
const PROCESS_CONTROL_STATUS_SINK_UNAVAILABLE: u8 = 0x05;
const PROCESS_CONTROL_STATUS_SINK_TIMEOUT: u8 = 0x06;
const PROCESS_CONTROL_STATUS_QUEUE_FULL: u8 = 0x07;
const PROCESS_CONTROL_STATUS_SINK_ERROR: u8 = 0x08;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessControlStatus {
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
pub struct DecodedProcessControl<'a> {
    pub target_seq: u32,
    pub request_timeout_ms: u32,
    pub control_nonce: ProcessControlNonce,
    pub message_id: &'a str,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedProcessControlResult<'a> {
    pub target_seq: u32,
    pub control_nonce: ProcessControlNonce,
    pub message_id: &'a str,
    pub status: ProcessControlStatus,
    pub diagnostic: &'a str,
}

fn status_to_wire(status: ProcessControlStatus) -> u8 {
    match status {
        ProcessControlStatus::Delivered => PROCESS_CONTROL_STATUS_DELIVERED,
        ProcessControlStatus::Inactive => PROCESS_CONTROL_STATUS_INACTIVE,
        ProcessControlStatus::NonceMismatch => PROCESS_CONTROL_STATUS_NONCE_MISMATCH,
        ProcessControlStatus::Unsupported => PROCESS_CONTROL_STATUS_UNSUPPORTED,
        ProcessControlStatus::Rejected => PROCESS_CONTROL_STATUS_REJECTED,
        ProcessControlStatus::SinkUnavailable => PROCESS_CONTROL_STATUS_SINK_UNAVAILABLE,
        ProcessControlStatus::SinkTimeout => PROCESS_CONTROL_STATUS_SINK_TIMEOUT,
        ProcessControlStatus::QueueFull => PROCESS_CONTROL_STATUS_QUEUE_FULL,
        ProcessControlStatus::SinkError => PROCESS_CONTROL_STATUS_SINK_ERROR,
    }
}

fn status_from_wire(value: u8) -> Result<ProcessControlStatus, ProtocolError> {
    match value {
        PROCESS_CONTROL_STATUS_DELIVERED => Ok(ProcessControlStatus::Delivered),
        PROCESS_CONTROL_STATUS_INACTIVE => Ok(ProcessControlStatus::Inactive),
        PROCESS_CONTROL_STATUS_NONCE_MISMATCH => Ok(ProcessControlStatus::NonceMismatch),
        PROCESS_CONTROL_STATUS_UNSUPPORTED => Ok(ProcessControlStatus::Unsupported),
        PROCESS_CONTROL_STATUS_REJECTED => Ok(ProcessControlStatus::Rejected),
        PROCESS_CONTROL_STATUS_SINK_UNAVAILABLE => Ok(ProcessControlStatus::SinkUnavailable),
        PROCESS_CONTROL_STATUS_SINK_TIMEOUT => Ok(ProcessControlStatus::SinkTimeout),
        PROCESS_CONTROL_STATUS_QUEUE_FULL => Ok(ProcessControlStatus::QueueFull),
        PROCESS_CONTROL_STATUS_SINK_ERROR => Ok(ProcessControlStatus::SinkError),
        _ => Err(ProtocolError::InvalidPayload(
            "process_control_result status invalid",
        )),
    }
}

fn encoded_control_len(message_id_len: usize, payload_len: usize) -> Result<usize, ProtocolError> {
    let mut total = 4 + 4 + PROCESS_CONTROL_NONCE_LEN + 2;
    total = checked_payload_len_add(total, message_id_len)?;
    total = checked_payload_len_add(total, 4)?;
    checked_payload_len_add(total, payload_len)
}

fn encoded_result_len(
    message_id_len: usize,
    diagnostic_len: usize,
) -> Result<usize, ProtocolError> {
    let mut total = 4 + PROCESS_CONTROL_NONCE_LEN + 2;
    total = checked_payload_len_add(total, message_id_len)?;
    total = checked_payload_len_add(total, 1 + 2)?;
    checked_payload_len_add(total, diagnostic_len)
}

pub fn encode_process_control(
    target_seq: u32,
    control_nonce: ProcessControlNonce,
    message_id: &str,
    payload: &[u8],
    request_timeout_ms: u32,
) -> Result<Vec<u8>, ProtocolError> {
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(
            "process_control target_seq must be non-zero",
        ));
    }
    if message_id.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "process_control message_id empty",
        ));
    }
    if payload.len() > PROCESS_CONTROL_MAX_PAYLOAD_BYTES {
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

pub fn decode_process_control(payload: &[u8]) -> Result<DecodedProcessControl<'_>, ProtocolError> {
    let mut offset = 0;
    let target_seq = read_u32(payload, &mut offset, "process_control target_seq truncated")?;
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(
            "process_control target_seq must be non-zero",
        ));
    }
    let request_timeout_ms = read_u32(
        payload,
        &mut offset,
        "process_control request_timeout_ms truncated",
    )?;
    let nonce_bytes = read_slice(
        payload,
        &mut offset,
        PROCESS_CONTROL_NONCE_LEN,
        "process_control nonce truncated",
    )?;
    let control_nonce: ProcessControlNonce = nonce_bytes
        .try_into()
        .map_err(|_| ProtocolError::InvalidPayload("process_control nonce invalid"))?;
    let message_id_len = read_u16(
        payload,
        &mut offset,
        "process_control message_id_len truncated",
    )? as usize;
    if message_id_len == 0 {
        return Err(ProtocolError::InvalidPayload(
            "process_control message_id empty",
        ));
    }
    let message_id = read_str(
        payload,
        &mut offset,
        message_id_len,
        "process_control message_id truncated",
        "invalid UTF-8 in process_control message_id",
    )?;
    let payload_len = read_u32(
        payload,
        &mut offset,
        "process_control payload_len truncated",
    )? as usize;
    if payload_len > PROCESS_CONTROL_MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "process_control payload too large",
        ));
    }
    let message_payload = read_slice(
        payload,
        &mut offset,
        payload_len,
        "process_control payload truncated",
    )?;
    expect_consumed(payload, offset, "process_control trailing bytes")?;

    Ok(DecodedProcessControl {
        target_seq,
        request_timeout_ms,
        control_nonce,
        message_id,
        payload: message_payload,
    })
}

pub fn encode_process_control_result(
    target_seq: u32,
    control_nonce: ProcessControlNonce,
    message_id: &str,
    status: ProcessControlStatus,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(
            "process_control_result target_seq must be non-zero",
        ));
    }
    if message_id.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "process_control_result message_id empty",
        ));
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

pub fn decode_process_control_result(
    payload: &[u8],
) -> Result<DecodedProcessControlResult<'_>, ProtocolError> {
    let mut offset = 0;
    let target_seq = read_u32(
        payload,
        &mut offset,
        "process_control_result target_seq truncated",
    )?;
    if target_seq == 0 {
        return Err(ProtocolError::InvalidPayload(
            "process_control_result target_seq must be non-zero",
        ));
    }
    let nonce_bytes = read_slice(
        payload,
        &mut offset,
        PROCESS_CONTROL_NONCE_LEN,
        "process_control_result nonce truncated",
    )?;
    let control_nonce: ProcessControlNonce = nonce_bytes
        .try_into()
        .map_err(|_| ProtocolError::InvalidPayload("process_control_result nonce invalid"))?;
    let message_id_len = read_u16(
        payload,
        &mut offset,
        "process_control_result message_id_len truncated",
    )? as usize;
    if message_id_len == 0 {
        return Err(ProtocolError::InvalidPayload(
            "process_control_result message_id empty",
        ));
    }
    let message_id = read_str(
        payload,
        &mut offset,
        message_id_len,
        "process_control_result message_id truncated",
        "invalid UTF-8 in process_control_result message_id",
    )?;
    let status = status_from_wire(read_u8(
        payload,
        &mut offset,
        "process_control_result status truncated",
    )?)?;
    let diagnostic_len = read_u16(
        payload,
        &mut offset,
        "process_control_result diagnostic_len truncated",
    )? as usize;
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "process_control_result diagnostic truncated",
        "invalid UTF-8 in process_control_result diagnostic",
    )?;
    expect_consumed(payload, offset, "process_control_result trailing bytes")?;

    Ok(DecodedProcessControlResult {
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: ProcessControlNonce = *b"0123456789abcdef";
    const REQUEST_TIMEOUT_MS: u32 = 5000;

    fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
        assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
    }

    #[test]
    fn process_control_roundtrip() {
        let encoded =
            encode_process_control(7, NONCE, "msg-1", b"hello", REQUEST_TIMEOUT_MS).unwrap();
        let decoded = decode_process_control(&encoded).unwrap();

        assert_eq!(decoded.target_seq, 7);
        assert_eq!(decoded.request_timeout_ms, REQUEST_TIMEOUT_MS);
        assert_eq!(decoded.control_nonce, NONCE);
        assert_eq!(decoded.message_id, "msg-1");
        assert_eq!(decoded.payload, b"hello");
    }

    #[test]
    fn process_control_allows_empty_payload() {
        let encoded = encode_process_control(7, NONCE, "msg-1", b"", REQUEST_TIMEOUT_MS).unwrap();
        let decoded = decode_process_control(&encoded).unwrap();

        assert_eq!(decoded.payload, b"");
    }

    #[test]
    fn process_control_rejects_payload_over_local_ipc_limit() {
        let too_large = vec![0; PROCESS_CONTROL_MAX_PAYLOAD_BYTES + 1];
        let err =
            encode_process_control(7, NONCE, "msg-1", &too_large, REQUEST_TIMEOUT_MS).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::PayloadTooLarge("payload", size) if size == too_large.len()
        ));

        let mut encoded =
            encode_process_control(7, NONCE, "msg-1", b"hello", REQUEST_TIMEOUT_MS).unwrap();
        let payload_len_offset = 4 + 4 + PROCESS_CONTROL_NONCE_LEN + 2 + "msg-1".len();
        encoded[payload_len_offset..payload_len_offset + 4]
            .copy_from_slice(&((PROCESS_CONTROL_MAX_PAYLOAD_BYTES as u32) + 1).to_be_bytes());

        let err = decode_process_control(&encoded).unwrap_err();
        assert_invalid_payload(err, "process_control payload too large");
    }

    #[test]
    fn process_control_rejects_zero_target_seq() {
        let err =
            encode_process_control(0, NONCE, "msg-1", b"payload", REQUEST_TIMEOUT_MS).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control target_seq must be non-zero")
        ));

        let mut encoded =
            encode_process_control(7, NONCE, "msg-1", b"payload", REQUEST_TIMEOUT_MS).unwrap();
        encoded[0..4].copy_from_slice(&0u32.to_be_bytes());

        let err = decode_process_control(&encoded).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control target_seq must be non-zero")
        ));
    }

    #[test]
    fn process_control_rejects_empty_message_id() {
        let err = encode_process_control(7, NONCE, "", b"payload", REQUEST_TIMEOUT_MS).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control message_id empty")
        ));

        let mut encoded =
            encode_process_control(7, NONCE, "msg-1", b"payload", REQUEST_TIMEOUT_MS).unwrap();
        let message_id_len_offset = 4 + 4 + PROCESS_CONTROL_NONCE_LEN;
        encoded[message_id_len_offset..message_id_len_offset + 2]
            .copy_from_slice(&0u16.to_be_bytes());

        let err = decode_process_control(&encoded).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control message_id empty")
        ));
    }

    #[test]
    fn process_control_rejects_trailing_bytes() {
        let mut encoded =
            encode_process_control(7, NONCE, "msg-1", b"hello", REQUEST_TIMEOUT_MS).unwrap();
        encoded.push(0);

        let err = decode_process_control(&encoded).unwrap_err();
        assert_invalid_payload(err, "process_control trailing bytes");
    }

    #[test]
    fn process_control_rejects_truncated_fields() {
        let encoded =
            encode_process_control(7, NONCE, "msg-1", b"hello", REQUEST_TIMEOUT_MS).unwrap();
        let request_timeout_offset = 4;
        let nonce_offset = request_timeout_offset + 4;
        let message_id_len_offset = nonce_offset + PROCESS_CONTROL_NONCE_LEN;
        let message_id_offset = message_id_len_offset + 2;
        let payload_len_offset = message_id_offset + "msg-1".len();
        let payload_offset = payload_len_offset + 4;

        assert_invalid_payload(
            decode_process_control(&encoded[..3]).unwrap_err(),
            "process_control target_seq truncated",
        );
        assert_invalid_payload(
            decode_process_control(&encoded[..request_timeout_offset + 3]).unwrap_err(),
            "process_control request_timeout_ms truncated",
        );
        assert_invalid_payload(
            decode_process_control(&encoded[..nonce_offset + PROCESS_CONTROL_NONCE_LEN - 1])
                .unwrap_err(),
            "process_control nonce truncated",
        );
        assert_invalid_payload(
            decode_process_control(&encoded[..message_id_len_offset + 1]).unwrap_err(),
            "process_control message_id_len truncated",
        );
        assert_invalid_payload(
            decode_process_control(&encoded[..message_id_offset + 2]).unwrap_err(),
            "process_control message_id truncated",
        );
        assert_invalid_payload(
            decode_process_control(&encoded[..payload_len_offset + 3]).unwrap_err(),
            "process_control payload_len truncated",
        );
        assert_invalid_payload(
            decode_process_control(&encoded[..payload_offset + 2]).unwrap_err(),
            "process_control payload truncated",
        );
    }

    #[test]
    fn process_control_rejects_invalid_utf8_message_id() {
        let mut encoded =
            encode_process_control(7, NONCE, "msg-1", b"hello", REQUEST_TIMEOUT_MS).unwrap();
        let message_id_offset = 4 + 4 + PROCESS_CONTROL_NONCE_LEN + 2;
        encoded[message_id_offset] = 0xFF;

        let err = decode_process_control(&encoded).unwrap_err();
        assert_invalid_payload(err, "invalid UTF-8 in process_control message_id");
    }

    #[test]
    fn process_control_result_roundtrip() {
        let encoded = encode_process_control_result(
            7,
            NONCE,
            "msg-1",
            ProcessControlStatus::Inactive,
            "not active",
        )
        .unwrap();
        let decoded = decode_process_control_result(&encoded).unwrap();

        assert_eq!(decoded.target_seq, 7);
        assert_eq!(decoded.control_nonce, NONCE);
        assert_eq!(decoded.message_id, "msg-1");
        assert_eq!(decoded.status, ProcessControlStatus::Inactive);
        assert_eq!(decoded.diagnostic, "not active");
    }

    #[test]
    fn process_control_result_roundtrips_sink_statuses() {
        for status in [
            ProcessControlStatus::Rejected,
            ProcessControlStatus::SinkUnavailable,
            ProcessControlStatus::SinkTimeout,
            ProcessControlStatus::QueueFull,
            ProcessControlStatus::SinkError,
        ] {
            let encoded =
                encode_process_control_result(7, NONCE, "msg-1", status, "diagnostic").unwrap();
            let decoded = decode_process_control_result(&encoded).unwrap();
            assert_eq!(decoded.status, status);
            assert_eq!(decoded.diagnostic, "diagnostic");
        }
    }

    #[test]
    fn process_control_result_rejects_zero_target_seq() {
        let err =
            encode_process_control_result(0, NONCE, "msg-1", ProcessControlStatus::Delivered, "")
                .unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control_result target_seq must be non-zero")
        ));

        let mut encoded =
            encode_process_control_result(7, NONCE, "msg-1", ProcessControlStatus::Delivered, "")
                .unwrap();
        encoded[0..4].copy_from_slice(&0u32.to_be_bytes());

        let err = decode_process_control_result(&encoded).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control_result target_seq must be non-zero")
        ));
    }

    #[test]
    fn process_control_result_rejects_empty_message_id() {
        let err = encode_process_control_result(7, NONCE, "", ProcessControlStatus::Delivered, "")
            .unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control_result message_id empty")
        ));

        let mut encoded =
            encode_process_control_result(7, NONCE, "msg-1", ProcessControlStatus::Delivered, "")
                .unwrap();
        let message_id_len_offset = 4 + PROCESS_CONTROL_NONCE_LEN;
        encoded[message_id_len_offset..message_id_len_offset + 2]
            .copy_from_slice(&0u16.to_be_bytes());

        let err = decode_process_control_result(&encoded).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control_result message_id empty")
        ));
    }

    #[test]
    fn process_control_result_rejects_unknown_status() {
        let mut encoded =
            encode_process_control_result(7, NONCE, "msg-1", ProcessControlStatus::Delivered, "")
                .unwrap();
        let status_offset = 4 + PROCESS_CONTROL_NONCE_LEN + 2 + "msg-1".len();
        encoded[status_offset] = 0xFE;

        let err = decode_process_control_result(&encoded).unwrap_err();
        assert!(matches!(
            err,
            ProtocolError::InvalidPayload("process_control_result status invalid")
        ));
    }

    #[test]
    fn process_control_result_rejects_trailing_bytes() {
        let mut encoded =
            encode_process_control_result(7, NONCE, "msg-1", ProcessControlStatus::Delivered, "")
                .unwrap();
        encoded.push(0);

        let err = decode_process_control_result(&encoded).unwrap_err();
        assert_invalid_payload(err, "process_control_result trailing bytes");
    }

    #[test]
    fn process_control_result_rejects_truncated_fields() {
        let encoded = encode_process_control_result(
            7,
            NONCE,
            "msg-1",
            ProcessControlStatus::Delivered,
            "diagnostic",
        )
        .unwrap();
        let message_id_len_offset = 4 + PROCESS_CONTROL_NONCE_LEN;
        let message_id_offset = message_id_len_offset + 2;
        let status_offset = message_id_offset + "msg-1".len();
        let diagnostic_len_offset = status_offset + 1;
        let diagnostic_offset = diagnostic_len_offset + 2;

        assert_invalid_payload(
            decode_process_control_result(&encoded[..3]).unwrap_err(),
            "process_control_result target_seq truncated",
        );
        assert_invalid_payload(
            decode_process_control_result(&encoded[..4 + PROCESS_CONTROL_NONCE_LEN - 1])
                .unwrap_err(),
            "process_control_result nonce truncated",
        );
        assert_invalid_payload(
            decode_process_control_result(&encoded[..message_id_len_offset + 1]).unwrap_err(),
            "process_control_result message_id_len truncated",
        );
        assert_invalid_payload(
            decode_process_control_result(&encoded[..message_id_offset + 2]).unwrap_err(),
            "process_control_result message_id truncated",
        );
        assert_invalid_payload(
            decode_process_control_result(&encoded[..status_offset]).unwrap_err(),
            "process_control_result status truncated",
        );
        assert_invalid_payload(
            decode_process_control_result(&encoded[..diagnostic_len_offset + 1]).unwrap_err(),
            "process_control_result diagnostic_len truncated",
        );
        assert_invalid_payload(
            decode_process_control_result(&encoded[..diagnostic_offset + 3]).unwrap_err(),
            "process_control_result diagnostic truncated",
        );
    }

    #[test]
    fn process_control_result_rejects_invalid_utf8_strings() {
        let mut encoded = encode_process_control_result(
            7,
            NONCE,
            "msg-1",
            ProcessControlStatus::Delivered,
            "diagnostic",
        )
        .unwrap();
        let message_id_offset = 4 + PROCESS_CONTROL_NONCE_LEN + 2;
        encoded[message_id_offset] = 0xFF;
        let err = decode_process_control_result(&encoded).unwrap_err();
        assert_invalid_payload(err, "invalid UTF-8 in process_control_result message_id");

        let mut encoded = encode_process_control_result(
            7,
            NONCE,
            "msg-1",
            ProcessControlStatus::Delivered,
            "diagnostic",
        )
        .unwrap();
        let diagnostic_offset = 4 + PROCESS_CONTROL_NONCE_LEN + 2 + "msg-1".len() + 1 + 2;
        encoded[diagnostic_offset] = 0xFF;
        let err = decode_process_control_result(&encoded).unwrap_err();
        assert_invalid_payload(err, "invalid UTF-8 in process_control_result diagnostic");
    }
}
