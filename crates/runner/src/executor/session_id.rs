const MAX_SESSION_ID_LEN: usize = 128;
const INVALID_SESSION_ID_DIAGNOSTIC_PREVIEW_BYTES: usize = MAX_SESSION_ID_LEN;

/// Returns true if the session ID is short enough for guest filenames and
/// contains only safe characters (alphanumeric, dash, underscore).
pub(super) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(super) fn invalid_session_id_diagnostic_preview(id: &str) -> String {
    let mut end = id.len().min(INVALID_SESSION_ID_DIAGNOSTIC_PREVIEW_BYTES);
    while !id.is_char_boundary(end) {
        end -= 1;
    }
    let preview: String = id[..end].chars().flat_map(char::escape_default).collect();
    if end == id.len() {
        preview
    } else {
        format!("{preview}...[truncated {} bytes]", id.len() - end)
    }
}

pub(super) fn canonical_codex_thread_id(id: &str) -> Option<String> {
    guest_contracts::codex_thread_id::canonical_codex_thread_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_session_id_preview_keeps_short_safe_text() {
        assert_eq!(
            invalid_session_id_diagnostic_preview("../session"),
            "../session"
        );
    }

    #[test]
    fn invalid_session_id_preview_escapes_control_characters() {
        assert_eq!(
            invalid_session_id_diagnostic_preview("bad\nsession"),
            "bad\\nsession"
        );
    }

    #[test]
    fn invalid_session_id_preview_truncates_overlong_values() {
        let id = "a".repeat(MAX_SESSION_ID_LEN + 2);

        assert_eq!(
            invalid_session_id_diagnostic_preview(&id),
            format!("{}...[truncated 2 bytes]", "a".repeat(MAX_SESSION_ID_LEN))
        );
    }

    #[test]
    fn invalid_session_id_preview_escapes_and_truncates_overlong_values() {
        let id = format!("bad\n{}", "a".repeat(200));
        let preview = invalid_session_id_diagnostic_preview(&id);

        assert!(preview.contains("bad\\n"), "got: {preview}");
        assert!(preview.contains("[truncated 76 bytes]"), "got: {preview}");
        assert!(
            !preview.contains(&id),
            "preview should not contain the full invalid id: {preview}"
        );
    }

    #[test]
    fn invalid_session_id_preview_truncates_at_char_boundary() {
        let id = "€".repeat(50);
        let preview = invalid_session_id_diagnostic_preview(&id);

        assert!(preview.contains("\\u{20ac}"), "got: {preview}");
        assert!(
            preview.ends_with("...[truncated 24 bytes]"),
            "got: {preview}"
        );
        assert!(
            !preview.contains(&id),
            "preview should not contain the full invalid id: {preview}"
        );
    }
}
