use super::truncate_utf8_to_u16_bytes;
use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32,
};
use crate::wire::{WRITE_FILE_FLAG_APPEND, WRITE_FILE_FLAG_PRIVATE, WRITE_FILE_FLAG_SUDO};

/// One ordinary file write entry in a `write_files` batch payload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileBatchEntry<'a> {
    /// Guest path to create or replace.
    pub path: &'a str,
    /// Bytes to write to the guest path.
    pub content: &'a [u8],
}

/// Encode write_file payload: `[2B path_len][path][1B flags][4B content_len][content]`.
///
/// Returns `Err` if path exceeds 65535 bytes (u16 field limit).
/// Returns `Err` if the payload cannot fit in a protocol frame.
pub fn encode_write_file(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
) -> Result<Vec<u8>, ProtocolError> {
    encode_write_file_flags(path, content, sudo, append, false)
}

/// Encode a private write_file payload.
pub fn encode_private_write_file(
    path: &str,
    content: &[u8],
    append: bool,
) -> Result<Vec<u8>, ProtocolError> {
    encode_write_file_flags(path, content, false, append, true)
}

/// Encode write_files payload:
/// `[2B file_count]` followed by `[2B path_len][path][4B content_len][content]` for each file.
///
/// Returns `Err` if the batch is empty, any path exceeds 65535 bytes, or the
/// payload cannot fit in one protocol frame.
pub fn encode_write_files(files: &[WriteFileBatchEntry<'_>]) -> Result<Vec<u8>, ProtocolError> {
    if files.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "write_files file count must be positive",
        ));
    }
    let file_count = ensure_u16_len("files", files.len())?;
    let mut payload_len = 2;
    let mut encoded_entries = Vec::with_capacity(files.len());
    for file in files {
        let path_bytes = file.path.as_bytes();
        let path_len = ensure_u16_len("path", path_bytes.len())?;
        let content_len = ensure_u32_len("content", file.content.len())?;
        payload_len = checked_payload_len_add(payload_len, 2)?;
        payload_len = checked_payload_len_add(payload_len, path_bytes.len())?;
        payload_len = checked_payload_len_add(payload_len, 4)?;
        payload_len = checked_payload_len_add(payload_len, file.content.len())?;
        encoded_entries.push((path_len, path_bytes, content_len, file.content));
    }
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    p.extend_from_slice(&file_count.to_be_bytes());
    for (path_len, path_bytes, content_len, content) in encoded_entries {
        p.extend_from_slice(&path_len.to_be_bytes());
        p.extend_from_slice(path_bytes);
        p.extend_from_slice(&content_len.to_be_bytes());
        p.extend_from_slice(content);
    }
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

fn encode_write_file_flags(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
    private: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let path_bytes = path.as_bytes();
    let path_len = ensure_u16_len("path", path_bytes.len())?;
    let content_len = ensure_u32_len("content", content.len())?;
    let mut payload_len = checked_payload_len_add(2, path_bytes.len())?;
    payload_len = checked_payload_len_add(payload_len, 1 + 4)?;
    payload_len = checked_payload_len_add(payload_len, content.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut flags = 0u8;
    if sudo {
        flags |= WRITE_FILE_FLAG_SUDO;
    }
    if append {
        flags |= WRITE_FILE_FLAG_APPEND;
    }
    if private {
        flags |= WRITE_FILE_FLAG_PRIVATE;
    }
    let mut p = Vec::with_capacity(payload_len);
    p.extend_from_slice(&path_len.to_be_bytes());
    p.extend_from_slice(path_bytes);
    p.push(flags);
    p.extend_from_slice(&content_len.to_be_bytes());
    p.extend_from_slice(content);
    debug_assert_eq!(p.len(), payload_len);
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

/// Encode write_files_result payload: `[1B success][2B error_len][error]`.
pub fn encode_write_files_result(success: bool, error: &str) -> Vec<u8> {
    encode_write_file_result(success, error)
}

/// Decode write_file payload. Returns `(path, content, sudo, append, private)`.
pub fn decode_write_file(payload: &[u8]) -> Result<(&str, &[u8], bool, bool, bool), ProtocolError> {
    let mut offset = 0;
    let path_len = read_u16(payload, &mut offset, "write_file too short")? as usize;
    let path = read_str(
        payload,
        &mut offset,
        path_len,
        "write_file path truncated",
        "invalid UTF-8 in path",
    )?;
    let flags = read_u8(payload, &mut offset, "write_file too short")?;
    let known_flags = WRITE_FILE_FLAG_SUDO | WRITE_FILE_FLAG_APPEND | WRITE_FILE_FLAG_PRIVATE;
    if flags & !known_flags != 0 {
        return Err(ProtocolError::InvalidPayload("write_file unknown flags"));
    }
    if flags & WRITE_FILE_FLAG_PRIVATE != 0 && flags & WRITE_FILE_FLAG_SUDO != 0 {
        return Err(ProtocolError::InvalidPayload(
            "write_file private flag cannot be combined with sudo",
        ));
    }
    let content_len = read_u32(payload, &mut offset, "write_file too short")? as usize;
    let content = read_slice(
        payload,
        &mut offset,
        content_len,
        "write_file content truncated",
    )?;
    expect_consumed(payload, offset, "write_file trailing bytes")?;

    Ok((
        path,
        content,
        (flags & WRITE_FILE_FLAG_SUDO) != 0,
        (flags & WRITE_FILE_FLAG_APPEND) != 0,
        (flags & WRITE_FILE_FLAG_PRIVATE) != 0,
    ))
}

/// Decode write_files payload.
///
/// Returns borrowed file entries backed by `payload`.
pub fn decode_write_files(payload: &[u8]) -> Result<Vec<WriteFileBatchEntry<'_>>, ProtocolError> {
    let mut offset = 0;
    let file_count = read_u16(payload, &mut offset, "write_files too short")? as usize;
    if file_count == 0 {
        return Err(ProtocolError::InvalidPayload(
            "write_files file count must be positive",
        ));
    }

    let mut files = Vec::with_capacity(file_count);
    for _ in 0..file_count {
        let path_len = read_u16(payload, &mut offset, "write_files path_len truncated")? as usize;
        let path = read_str(
            payload,
            &mut offset,
            path_len,
            "write_files path truncated",
            "invalid UTF-8 in write_files path",
        )?;
        let content_len =
            read_u32(payload, &mut offset, "write_files content_len truncated")? as usize;
        let content = read_slice(
            payload,
            &mut offset,
            content_len,
            "write_files content truncated",
        )?;
        files.push(WriteFileBatchEntry { path, content });
    }
    expect_consumed(payload, offset, "write_files trailing bytes")?;

    Ok(files)
}

/// Decode write_file_result payload. Returns `(success, error)`.
pub fn decode_write_file_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    let mut offset = 0;
    let success = match read_u8(payload, &mut offset, "write_file_result too short")? {
        0 => false,
        1 => true,
        _ => {
            return Err(ProtocolError::InvalidPayload(
                "write_file_result invalid success",
            ));
        }
    };
    let err_len = read_u16(payload, &mut offset, "write_file_result too short")? as usize;
    let error = read_str(
        payload,
        &mut offset,
        err_len,
        "write_file_result error truncated",
        "invalid UTF-8 in error",
    )?;
    expect_consumed(payload, offset, "write_file_result trailing bytes")?;

    Ok((success, error))
}

/// Decode write_files_result payload. Returns `(success, error)`.
pub fn decode_write_files_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    decode_write_file_result(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::MAX_PAYLOAD_SIZE;

    fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
        assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
    }

    #[test]
    fn write_file_payload_roundtrip() {
        let payload = encode_write_file("/tmp/test.txt", b"content", false, false).unwrap();
        let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/test.txt");
        assert_eq!(content, b"content");
        assert!(!sudo);
        assert!(!append);
        assert!(!private);
    }

    #[test]
    fn write_file_with_sudo() {
        let payload = encode_write_file("/etc/hosts", b"127.0.0.1", true, false).unwrap();
        let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/etc/hosts");
        assert_eq!(content, b"127.0.0.1");
        assert!(sudo);
        assert!(!append);
        assert!(!private);
    }

    #[test]
    fn write_file_with_append() {
        let payload = encode_write_file("/tmp/out.log", b"more data", false, true).unwrap();
        let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/out.log");
        assert_eq!(content, b"more data");
        assert!(!sudo);
        assert!(append);
        assert!(!private);
    }

    #[test]
    fn write_file_with_sudo_and_append() {
        let payload = encode_write_file("/etc/conf", b"line", true, true).unwrap();
        let (_, _, sudo, append, private) = decode_write_file(&payload).unwrap();
        assert!(sudo);
        assert!(append);
        assert!(!private);
    }

    #[test]
    fn write_file_with_private() {
        let payload = encode_private_write_file("/tmp/private", b"secret", true).unwrap();
        let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
        assert_eq!(path, "/tmp/private");
        assert_eq!(content, b"secret");
        assert!(!sudo);
        assert!(append);
        assert!(private);
    }

    #[test]
    fn write_files_payload_roundtrip() {
        let files = [
            WriteFileBatchEntry {
                path: "/tmp/a.txt",
                content: b"alpha",
            },
            WriteFileBatchEntry {
                path: "/tmp/b.txt",
                content: b"beta",
            },
        ];

        let payload = encode_write_files(&files).unwrap();
        let decoded = decode_write_files(&payload).unwrap();

        assert_eq!(decoded, files);
    }

    #[test]
    fn write_files_rejects_empty_batch() {
        let err = encode_write_files(&[]).unwrap_err();

        assert_invalid_payload(err, "write_files file count must be positive");
    }

    #[test]
    fn write_files_content_too_large() {
        let path = "/tmp/f";
        let payload_overhead = 2 + 2 + path.len() + 4;
        let big = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead + 1];

        let err = encode_write_files(&[WriteFileBatchEntry {
            path,
            content: &big,
        }])
        .unwrap_err();

        assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    }

    #[test]
    fn write_files_content_at_payload_limit() {
        let path = "/tmp/f";
        let payload_overhead = 2 + 2 + path.len() + 4;
        let content = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead];

        let payload = encode_write_files(&[WriteFileBatchEntry {
            path,
            content: &content,
        }])
        .unwrap();

        assert_eq!(payload.len(), MAX_PAYLOAD_SIZE);
        let decoded = decode_write_files(&payload).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].path, path);
        assert_eq!(decoded[0].content, content.as_slice());
    }

    #[test]
    fn write_file_path_too_long() {
        let long_path = "a".repeat(65536);
        let err = encode_write_file(&long_path, b"", false, false).unwrap_err();
        assert!(matches!(err, ProtocolError::PayloadTooLarge("path", 65536)));
    }

    #[test]
    fn write_file_content_too_large() {
        let path = "/tmp/f";
        let payload_overhead = 2 + path.len() + 1 + 4;
        let big = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead + 1];
        let err = encode_write_file(path, &big, false, false).unwrap_err();

        assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    }

    #[test]
    fn write_file_content_at_payload_limit() {
        let path = "/tmp/f";
        let payload_overhead = 2 + path.len() + 1 + 4;
        let content = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead];

        let payload = encode_write_file(path, &content, false, false).unwrap();

        assert_eq!(payload.len(), MAX_PAYLOAD_SIZE);
        let (decoded_path, decoded_content, sudo, append, private) =
            decode_write_file(&payload).unwrap();
        assert_eq!(decoded_path, path);
        assert_eq!(decoded_content, content.as_slice());
        assert!(!sudo);
        assert!(!append);
        assert!(!private);
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

    #[test]
    fn decode_write_file_rejects_truncated_fields() {
        for (payload, expected) in [
            (b"".as_slice(), "write_file too short"),
            (&[0], "write_file too short"),
            (&[0, 1], "write_file path truncated"),
            (&[0, 0], "write_file too short"),
            (&[0, 0, 0], "write_file too short"),
            (&[0, 0, 0, 0, 0, 0, 1], "write_file content truncated"),
        ] {
            let err = decode_write_file(payload).unwrap_err();
            assert_invalid_payload(err, expected);
        }
    }

    #[test]
    fn decode_write_file_rejects_trailing_bytes() {
        let mut payload = encode_write_file("/tmp/test.txt", b"content", false, false).unwrap();
        payload.push(0);

        let err = decode_write_file(&payload).unwrap_err();

        assert_invalid_payload(err, "write_file trailing bytes");
    }

    #[test]
    fn decode_write_file_rejects_unknown_flags() {
        let payload = [0, 0, 0x80, 0, 0, 0, 0];

        let err = decode_write_file(&payload).unwrap_err();

        assert_invalid_payload(err, "write_file unknown flags");
    }

    #[test]
    fn decode_write_file_rejects_private_with_sudo() {
        let payload = [
            0,
            0,
            WRITE_FILE_FLAG_PRIVATE | WRITE_FILE_FLAG_SUDO,
            0,
            0,
            0,
            0,
        ];

        let err = decode_write_file(&payload).unwrap_err();

        assert_invalid_payload(err, "write_file private flag cannot be combined with sudo");
    }

    #[test]
    fn decode_write_file_rejects_invalid_utf8_path() {
        let payload = [0, 1, 0xC3, 0, 0, 0, 0, 0];

        let err = decode_write_file(&payload).unwrap_err();

        assert_invalid_payload(err, "invalid UTF-8 in path");
    }

    #[test]
    fn decode_write_files_rejects_zero_count() {
        let err = decode_write_files(&[0, 0]).unwrap_err();

        assert_invalid_payload(err, "write_files file count must be positive");
    }

    #[test]
    fn decode_write_files_rejects_truncated_fields() {
        for (payload, expected) in [
            (b"".as_slice(), "write_files too short"),
            (&[0], "write_files too short"),
            (&[0, 1], "write_files path_len truncated"),
            (&[0, 1, 0, 1], "write_files path truncated"),
            (&[0, 1, 0, 0], "write_files content_len truncated"),
            (&[0, 1, 0, 0, 0, 0, 0, 1], "write_files content truncated"),
        ] {
            let err = decode_write_files(payload).unwrap_err();
            assert_invalid_payload(err, expected);
        }
    }

    #[test]
    fn decode_write_files_rejects_trailing_bytes() {
        let mut payload = encode_write_files(&[WriteFileBatchEntry {
            path: "/tmp/test.txt",
            content: b"content",
        }])
        .unwrap();
        payload.push(0);

        let err = decode_write_files(&payload).unwrap_err();

        assert_invalid_payload(err, "write_files trailing bytes");
    }

    #[test]
    fn decode_write_files_rejects_invalid_utf8_path() {
        let payload = [0, 1, 0, 1, 0xC3, 0, 0, 0, 0];

        let err = decode_write_files(&payload).unwrap_err();

        assert_invalid_payload(err, "invalid UTF-8 in write_files path");
    }

    #[test]
    fn decode_write_file_result_rejects_trailing_bytes() {
        let mut payload = encode_write_file_result(false, "permission denied");
        payload.push(0);

        let err = decode_write_file_result(&payload).unwrap_err();

        assert_invalid_payload(err, "write_file_result trailing bytes");
    }

    #[test]
    fn decode_write_file_result_rejects_invalid_success() {
        let payload = [2, 0, 0];

        let err = decode_write_file_result(&payload).unwrap_err();

        assert_invalid_payload(err, "write_file_result invalid success");
    }

    #[test]
    fn decode_write_file_result_rejects_truncated_fields() {
        for (payload, expected) in [
            (b"".as_slice(), "write_file_result too short"),
            (&[0], "write_file_result too short"),
            (&[0, 0, 1], "write_file_result error truncated"),
        ] {
            let err = decode_write_file_result(payload).unwrap_err();
            assert_invalid_payload(err, expected);
        }
    }

    #[test]
    fn decode_write_file_result_rejects_invalid_utf8() {
        let payload = [0, 0, 1, 0xC3];

        let err = decode_write_file_result(&payload).unwrap_err();

        assert_invalid_payload(err, "invalid UTF-8 in error");
    }
}
