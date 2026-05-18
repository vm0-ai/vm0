use super::truncate_utf8_to_u16_bytes;
use crate::error::ProtocolError;
use crate::read::{read_u8_at, read_u16_at, read_u32_at};
use crate::wire::{WRITE_FILE_FLAG_APPEND, WRITE_FILE_FLAG_SUDO};

/// Encode write_file payload: `[2B path_len][path][1B flags][4B content_len][content]`.
///
/// Returns `Err` if path exceeds 65535 bytes (u16 field limit).
/// Total message size is validated by [`crate::encode`].
pub fn encode_write_file(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let path_bytes = path.as_bytes();
    if path_bytes.len() > u16::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge("path", path_bytes.len()));
    }
    let path_len = path_bytes.len() as u16;
    let mut flags = 0u8;
    if sudo {
        flags |= WRITE_FILE_FLAG_SUDO;
    }
    if append {
        flags |= WRITE_FILE_FLAG_APPEND;
    }
    let mut p = Vec::with_capacity(7 + path_len as usize + content.len());
    p.extend_from_slice(&path_len.to_be_bytes());
    p.extend_from_slice(path_bytes);
    p.push(flags);
    p.extend_from_slice(&(content.len() as u32).to_be_bytes());
    p.extend_from_slice(content);
    Ok(p)
}

/// Encode write_file_result payload: `[1B success][2B error_len][error]`.
///
/// Error message is truncated to at most 65535 bytes at a UTF-8 boundary.
pub fn encode_write_file_result(success: bool, error: &str) -> Vec<u8> {
    let (err, err_len) = truncate_utf8_to_u16_bytes(error);
    let mut p = Vec::with_capacity(3 + err_len as usize);
    p.push(u8::from(success));
    p.extend_from_slice(&err_len.to_be_bytes());
    p.extend_from_slice(err);
    p
}

/// Decode write_file payload. Returns `(path, content, sudo, append)`.
pub fn decode_write_file(payload: &[u8]) -> Result<(&str, &[u8], bool, bool), ProtocolError> {
    let path_len = read_u16_at(payload, 0)
        .ok_or(ProtocolError::InvalidPayload("write_file too short"))? as usize;
    let path = std::str::from_utf8(
        payload
            .get(2..2 + path_len)
            .ok_or(ProtocolError::InvalidPayload("write_file path truncated"))?,
    )
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in path"))?;
    let flags = read_u8_at(payload, 2 + path_len)
        .ok_or(ProtocolError::InvalidPayload("write_file too short"))?;
    let content_len = read_u32_at(payload, 3 + path_len)
        .ok_or(ProtocolError::InvalidPayload("write_file too short"))?
        as usize;
    let content = payload
        .get(7 + path_len..7 + path_len + content_len)
        .ok_or(ProtocolError::InvalidPayload(
            "write_file content truncated",
        ))?;
    Ok((
        path,
        content,
        (flags & WRITE_FILE_FLAG_SUDO) != 0,
        (flags & WRITE_FILE_FLAG_APPEND) != 0,
    ))
}

/// Decode write_file_result payload. Returns `(success, error)`.
pub fn decode_write_file_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    let success = read_u8_at(payload, 0)
        .ok_or(ProtocolError::InvalidPayload("write_file_result too short"))?
        == 1;
    let err_len = read_u16_at(payload, 1)
        .ok_or(ProtocolError::InvalidPayload("write_file_result too short"))?
        as usize;
    let error = std::str::from_utf8(payload.get(3..3 + err_len).ok_or(
        ProtocolError::InvalidPayload("write_file_result error truncated"),
    )?)
    .map_err(|_| ProtocolError::InvalidPayload("invalid UTF-8 in error"))?;
    Ok((success, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::encode;
    use crate::wire::{MAX_MESSAGE_SIZE, MSG_WRITE_FILE};

    #[test]
    fn write_file_payload_roundtrip() {
        let payload = encode_write_file("/tmp/test.txt", b"content", false, false).unwrap();
        let (path, content, sudo, append) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/test.txt");
        assert_eq!(content, b"content");
        assert!(!sudo);
        assert!(!append);
    }

    #[test]
    fn write_file_with_sudo() {
        let payload = encode_write_file("/etc/hosts", b"127.0.0.1", true, false).unwrap();
        let (path, content, sudo, append) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/etc/hosts");
        assert_eq!(content, b"127.0.0.1");
        assert!(sudo);
        assert!(!append);
    }

    #[test]
    fn write_file_with_append() {
        let payload = encode_write_file("/tmp/out.log", b"more data", false, true).unwrap();
        let (path, content, sudo, append) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/out.log");
        assert_eq!(content, b"more data");
        assert!(!sudo);
        assert!(append);
    }

    #[test]
    fn write_file_with_sudo_and_append() {
        let payload = encode_write_file("/etc/conf", b"line", true, true).unwrap();
        let (_, _, sudo, append) = decode_write_file(&payload).unwrap();
        assert!(sudo);
        assert!(append);
    }

    #[test]
    fn write_file_path_too_long() {
        let long_path = "a".repeat(65536);
        let err = encode_write_file(&long_path, b"", false, false).unwrap_err();
        assert!(matches!(err, ProtocolError::PayloadTooLarge("path", 65536)));
    }

    #[test]
    fn write_file_content_too_large() {
        let big = vec![0u8; MAX_MESSAGE_SIZE];
        let payload = encode_write_file("/tmp/f", &big, false, false).unwrap();
        let err = encode(MSG_WRITE_FILE, 1, &payload).unwrap_err();
        assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    }

    #[test]
    fn write_file_result_roundtrip() {
        let payload = encode_write_file_result(true, "");
        let (success, error) = decode_write_file_result(&payload).unwrap();
        assert!(success);
        assert!(error.is_empty());

        let payload = encode_write_file_result(false, "permission denied");
        let (success, error) = decode_write_file_result(&payload).unwrap();
        assert!(!success);
        assert_eq!(error, "permission denied");
    }

    #[test]
    fn write_file_result_truncates_oversized_utf8_at_character_boundary() {
        let prefix = "A".repeat(u16::MAX as usize - 1);
        let error = format!("{prefix}é");
        let payload = encode_write_file_result(false, &error);

        assert_eq!(payload.first(), Some(&0));
        let declared_len = u16::from_be_bytes(payload.get(1..3).unwrap().try_into().unwrap());
        assert_eq!(declared_len as usize, prefix.len());
        assert_eq!(payload.len(), 3 + prefix.len());

        let (success, decoded_error) = decode_write_file_result(&payload).unwrap();
        assert!(!success);
        assert_eq!(decoded_error, prefix);
    }

    #[test]
    fn decode_write_file_too_short() {
        assert!(decode_write_file(&[0; 3]).is_err());
    }
}
