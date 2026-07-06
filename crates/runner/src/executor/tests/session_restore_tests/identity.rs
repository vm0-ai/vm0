use super::*;
use crate::restored_session_identity::RestoredSessionIdentity;

#[test]
fn restored_session_identity_requires_valid_hash_ref() {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(resume_ref("sess-identity-123", history_ref("hash-a", 12)));

    assert!(RestoredSessionIdentity::from_context(&ctx).is_some());

    ctx.resume_session = Some(ResumeSession::inline(
        "sess-identity-123".into(),
        "{}".into(),
    ));
    assert!(RestoredSessionIdentity::from_context(&ctx).is_none());

    ctx.resume_session = Some(resume_ref("../../etc/passwd", history_ref("hash-a", 12)));
    assert!(RestoredSessionIdentity::from_context(&ctx).is_none());
}

#[test]
fn restored_session_identity_changes_with_framework_session_and_history_hash() {
    let mut ctx = claude_context();
    ctx.resume_session = Some(resume_ref("sess-identity-123", history_ref("hash-a", 12)));
    let claude_identity = RestoredSessionIdentity::from_context(&ctx).expect("claude identity");

    ctx.resume_session = Some(resume_ref("sess-identity-123", history_ref("hash-b", 12)));
    let different_hash_identity =
        RestoredSessionIdentity::from_context(&ctx).expect("different hash identity");
    assert_ne!(claude_identity, different_hash_identity);

    ctx.resume_session = Some(resume_ref("sess-identity-other", history_ref("hash-a", 12)));
    let different_session_identity =
        RestoredSessionIdentity::from_context(&ctx).expect("different session identity");
    assert_ne!(claude_identity, different_session_identity);

    ctx = codex_context();
    ctx.resume_session = Some(resume_ref(CODEX_SESSION_ID, history_ref("hash-a", 12)));
    let codex_identity = RestoredSessionIdentity::from_context(&ctx).expect("codex identity");
    assert_ne!(claude_identity, codex_identity);

    ctx.resume_session = Some(resume_ref(
        CODEX_SESSION_ID_COMPACT_UPPERCASE,
        history_ref("hash-a", 12),
    ));
    let codex_compact_uppercase_identity =
        RestoredSessionIdentity::from_context(&ctx).expect("codex compact uppercase identity");
    assert_eq!(codex_identity, codex_compact_uppercase_identity);
}
