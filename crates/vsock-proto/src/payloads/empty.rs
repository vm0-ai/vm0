use crate::error::ProtocolError;

/// Decode an empty control-plane payload.
pub fn decode_empty_payload(
    payload_name: &'static str,
    payload: &[u8],
) -> Result<(), ProtocolError> {
    if payload.is_empty() {
        Ok(())
    } else {
        Err(ProtocolError::InvalidPayload(payload_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_payload_accepts_empty_slice() {
        decode_empty_payload("test must be empty", &[]).unwrap();
    }

    #[test]
    fn empty_payload_rejects_non_empty_slice() {
        let err = decode_empty_payload("test must be empty", b"x").unwrap_err();
        assert_eq!(err.to_string(), "invalid payload: test must be empty");
    }
}
