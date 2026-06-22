const MAX_SESSION_ID_LEN: usize = 128;

/// Returns true if the session ID is short enough for guest filenames and
/// contains only safe characters (alphanumeric, dash, underscore).
pub(super) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(super) fn canonical_codex_thread_id(id: &str) -> Option<String> {
    if !is_valid_session_id(id) {
        return None;
    }
    uuid::Uuid::parse_str(id).ok().map(|uuid| uuid.to_string())
}
