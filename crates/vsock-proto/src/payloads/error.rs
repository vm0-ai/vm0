use super::truncate_utf8_to_u16_bytes;
use crate::error::ProtocolError;
use crate::read::{expect_consumed, read_str, read_u16};

/// Encode error payload: `[2B error_len][error]`.
///
/// Error message is truncated to at most 65535 bytes at a UTF-8 boundary.
pub fn encode_error(message: &str) -> Vec<u8> {
    let (msg, msg_len) = truncate_utf8_to_u16_bytes(message);
    let mut p = Vec::with_capacity(2 + msg_len as usize);
    p.extend_from_slice(&msg_len.to_be_bytes());
    p.extend_from_slice(msg);
    p
}

/// Decode error payload. Returns the error message.
pub fn decode_error(payload: &[u8]) -> Result<&str, ProtocolError> {
    let mut offset = 0;
    let msg_len = read_u16(payload, &mut offset, "error payload too short")? as usize;
    let message = read_str(
        payload,
        &mut offset,
        msg_len,
        "error message truncated",
        "invalid UTF-8 in error",
    )?;
    expect_consumed(payload, offset, "error trailing bytes")?;
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
        assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
    }

    #[test]
    fn error_payload_roundtrip() {
        let payload = encode_error("something went wrong");
        let msg = decode_error(&payload).unwrap();
        assert_eq!(msg, "something went wrong");
    }

    #[test]
    fn error_payload_roundtrip_empty_message() {
        let payload = encode_error("");

        assert_eq!(payload.as_slice(), &[0, 0]);
        assert!(decode_error(&payload).unwrap().is_empty());
    }

    #[test]
    fn error_payload_truncates_oversized_ascii_to_u16_max() {
        let message = "A".repeat(u16::MAX as usize + 1);
        let payload = encode_error(&message);

        assert_eq!(payload.len(), 2 + u16::MAX as usize);
        assert_eq!(payload.get(..2), Some(u16::MAX.to_be_bytes().as_slice()));

        let msg = decode_error(&payload).unwrap();
        assert_eq!(msg.len(), u16::MAX as usize);
        assert!(msg.bytes().all(|byte| byte == b'A'));
    }

    #[test]
    fn error_payload_keeps_utf8_character_ending_at_u16_max() {
        let prefix = "A".repeat(u16::MAX as usize - "é".len());
        let expected = format!("{prefix}é");
        let message = format!("{expected}B");
        let payload = encode_error(&message);

        let declared_len = u16::from_be_bytes(payload.get(..2).unwrap().try_into().unwrap());
        assert_eq!(declared_len as usize, expected.len());
        assert_eq!(payload.len(), 2 + expected.len());

        let msg = decode_error(&payload).unwrap();
        assert_eq!(msg, expected);
    }

    #[test]
    fn error_payload_truncates_oversized_utf8_at_character_boundary() {
        let emoji = "\u{1F600}";
        let prefix = "A".repeat(u16::MAX as usize - (emoji.len() - 1));
        let message = format!("{prefix}{emoji}");
        let payload = encode_error(&message);

        let declared_len = u16::from_be_bytes(payload.get(..2).unwrap().try_into().unwrap());
        assert_eq!(declared_len as usize, prefix.len());
        assert_eq!(payload.len(), 2 + prefix.len());

        let msg = decode_error(&payload).unwrap();
        assert_eq!(msg, prefix);
    }

    #[test]
    fn decode_error_rejects_invalid_utf8() {
        let payload = [0, 1, 0xC3];
        let err = decode_error(&payload).unwrap_err();

        assert_invalid_payload(err, "invalid UTF-8 in error");
    }

    #[test]
    fn decode_error_rejects_too_short_payload() {
        for payload in [b"".as_slice(), &[0]] {
            let err = decode_error(payload).unwrap_err();
            assert_invalid_payload(err, "error payload too short");
        }
    }

    #[test]
    fn decode_error_rejects_truncated_message() {
        let payload = [0, 2, b'a'];
        let err = decode_error(&payload).unwrap_err();

        assert_invalid_payload(err, "error message truncated");
    }

    #[test]
    fn decode_error_rejects_trailing_bytes() {
        let mut payload = encode_error("x");
        payload.push(b'y');

        let err = decode_error(&payload).unwrap_err();

        assert_invalid_payload(err, "error trailing bytes");
    }
}
