use super::super::super::session_id::{canonical_codex_thread_id, is_valid_session_id};
use super::super::super::session_restore::restore_session;
use super::*;

#[test]
fn session_id_validation_rejects_path_traversal() {
    let invalid_ids = [
        "../../etc/passwd",
        "foo/bar",
        "a b",
        "id;rm -rf /",
        "a\nb",
        "",
    ];
    for id in invalid_ids {
        assert!(!is_valid_session_id(id), "expected rejection for: {id:?}");
    }

    let overlong_id = "a".repeat(129);
    assert!(
        !is_valid_session_id(&overlong_id),
        "expected overlong session id rejection"
    );
}

#[test]
fn session_id_validation_accepts_valid_ids() {
    let valid_ids = [
        "abc-123",
        "sess_456",
        "a1b2c3",
        "01961d3a-c0ab-7891-a6d3-9b52cd28716c",
    ];
    for id in valid_ids {
        assert!(is_valid_session_id(id), "expected acceptance for: {id:?}");
    }
}

#[test]
fn codex_thread_id_canonicalizes_uuid_spellings() {
    assert_eq!(
        canonical_codex_thread_id(CODEX_SESSION_ID_COMPACT_UPPERCASE).as_deref(),
        Some(CODEX_SESSION_ID)
    );
    assert_eq!(
        canonical_codex_thread_id(CODEX_SESSION_ID).as_deref(),
        Some(CODEX_SESSION_ID)
    );
    assert!(canonical_codex_thread_id("codex-safe-but-not-uuid").is_none());
}

#[tokio::test]
async fn restore_session_rejects_invalid_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let raw_session_id = "../../etc/passwd";
    let session = materialized_text_session(raw_session_id, "data");
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    let message = err.to_string();
    assert!(message.contains("invalid session_id"));
    assert!(
        !message.contains(raw_session_id),
        "invalid-session error must not echo raw session id: {message}"
    );
}

#[tokio::test]
async fn restore_session_rejects_invalid_codex_session_id() {
    // Path-traversal validation runs before framework dispatch, so codex
    // shares the same allow-list as claude-code.
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session("../../etc/passwd", "{}");
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}
