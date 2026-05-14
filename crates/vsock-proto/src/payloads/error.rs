use crate::error::ProtocolError;
use crate::read::read_u16_at;

/// Encode error payload: `[2B error_len][error]`.
///
/// Error message is truncated to 65535 bytes if longer.
pub fn encode_error(message: &str) -> Vec<u8> {
    let msg = message.as_bytes();
    let msg_len = msg.len().min(u16::MAX as usize) as u16;
    let mut p = Vec::with_capacity(2 + msg_len as usize);
    p.extend_from_slice(&msg_len.to_be_bytes());
    // msg_len <= msg.len() is guaranteed by .min() above
    p.extend_from_slice(msg.get(..msg_len as usize).unwrap_or(msg));
    p
}

/// Decode error payload. Returns the error message.
pub fn decode_error(payload: &[u8]) -> Result<&str, ProtocolError> {
    let msg_len = read_u16_at(payload, 0)
        .ok_or(ProtocolError::InvalidPayload("error payload too short"))?
        as usize;
    std::str::from_utf8(
        payload
            .get(2..2 + msg_len)
            .ok_or(ProtocolError::InvalidPayload("error message truncated"))?,
    )
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in error"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_payload_roundtrip() {
        let payload = encode_error("something went wrong");
        let msg = decode_error(&payload).unwrap();
        assert_eq!(msg, "something went wrong");
    }
}
