//! Shared Claude Code session ID validation contract.
//!
//! Claude session IDs become guest filenames and cross the guest/runner
//! boundary. The contract therefore keeps them short and restricts them to
//! ASCII characters that are safe in a single filename component.

/// Maximum accepted Claude session ID length in bytes.
pub const MAX_CLAUDE_SESSION_ID_BYTES: usize = 128;

/// Returns whether a Claude session ID satisfies the shared guest/runner contract.
pub fn is_valid_claude_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CLAUDE_SESSION_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_contract_ids() {
        for id in [
            "abc-123",
            "sess_456",
            "550e8400-e29b-41d4-a716-446655440000",
            "mock-019c279d-ff8e-7000-8000-000000000001",
        ] {
            assert!(
                is_valid_claude_session_id(id),
                "expected acceptance for {id:?}"
            );
        }

        assert!(is_valid_claude_session_id(
            &"a".repeat(MAX_CLAUDE_SESSION_ID_BYTES)
        ));
    }

    #[test]
    fn rejects_non_contract_ids() {
        for id in [
            "",
            ".",
            "..",
            "../escape",
            "..\\escape",
            "/absolute",
            "nested/path",
            "nested\\path",
            "session with space",
            "line\nbreak",
            "session.with.dot",
            "session:semicolon",
            "é",
        ] {
            assert!(
                !is_valid_claude_session_id(id),
                "expected rejection for {id:?}"
            );
        }

        assert!(!is_valid_claude_session_id(
            &"a".repeat(MAX_CLAUDE_SESSION_ID_BYTES + 1)
        ));
    }
}
