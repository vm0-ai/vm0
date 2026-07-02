use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecResult, SandboxError, SandboxInvalidStateContext,
    SandboxOperation,
};
use sandbox_mock::MockSandbox;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tracing_subscriber::prelude::*;

use super::super::DEFAULT_EXEC_TIMEOUT;
use super::super::session_id::{canonical_codex_thread_id, is_valid_session_id};
use super::super::session_restore::{MaterializedResumeSession, restore_session};
use super::support::{CapturedEvent, CapturedEvents, minimal_context, sandbox_write_file_error};
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::types::{
    ResumeSession, ResumeSessionHistory, ResumeSessionHistoryRef, ResumeSessionHistoryRefKind,
};

static RESTORE_SESSION_LOG_CALLSITE_LOCK: Mutex<()> = Mutex::new(());

fn materialized_text_session(
    session_id: String,
    history: String,
) -> MaterializedResumeSession<'static> {
    MaterializedResumeSession::new(session_id, history.into_bytes())
}

fn materialized_bytes_session(
    session_id: String,
    history: &[u8],
) -> MaterializedResumeSession<'static> {
    MaterializedResumeSession::new(session_id, history.to_vec())
}

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
        canonical_codex_thread_id("019E9154C30470F0ADDE36EFB1BE1701").as_deref(),
        Some("019e9154-c304-70f0-adde-36efb1be1701")
    );
    assert_eq!(
        canonical_codex_thread_id("019e9154-c304-70f0-adde-36efb1be1701").as_deref(),
        Some("019e9154-c304-70f0-adde-36efb1be1701")
    );
    assert!(canonical_codex_thread_id("codex-safe-but-not-uuid").is_none());
}

#[test]
fn restored_session_identity_requires_valid_hash_ref() {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-identity-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-a".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });

    assert!(RestoredSessionIdentity::from_context(&ctx).is_some());

    ctx.resume_session = Some(ResumeSession::inline(
        "sess-identity-123".into(),
        "{}".into(),
    ));
    assert!(RestoredSessionIdentity::from_context(&ctx).is_none());

    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "../../etc/passwd".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-a".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });
    assert!(RestoredSessionIdentity::from_context(&ctx).is_none());
}

#[test]
fn restored_session_identity_changes_with_framework_session_and_history_hash() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-identity-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-a".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });
    let claude_identity = RestoredSessionIdentity::from_context(&ctx).expect("claude identity");

    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-identity-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-b".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });
    let different_hash_identity =
        RestoredSessionIdentity::from_context(&ctx).expect("different hash identity");
    assert_ne!(claude_identity, different_hash_identity);

    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-identity-other".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-a".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });
    let different_session_identity =
        RestoredSessionIdentity::from_context(&ctx).expect("different session identity");
    assert_ne!(claude_identity, different_session_identity);

    ctx.cli_agent_type = "codex".into();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "019e9154-c304-70f0-adde-36efb1be1701".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-a".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });
    let codex_identity = RestoredSessionIdentity::from_context(&ctx).expect("codex identity");
    assert_ne!(claude_identity, codex_identity);

    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "019E9154C30470F0ADDE36EFB1BE1701".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: "hash-a".into(),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: 12,
                encoded_size: 12,
            },
        },
    });
    let codex_compact_uppercase_identity =
        RestoredSessionIdentity::from_context(&ctx).expect("codex compact uppercase identity");
    assert_eq!(codex_identity, codex_compact_uppercase_identity);
}

#[test]
fn restore_session_writes_history() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let history = r#"{"type":"init"}"#;
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-abc-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history.as_bytes())),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let session = materialized_text_session("sess-abc-123".into(), history.into());
    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[tokio::test]
async fn restore_session_rejects_invalid_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let raw_session_id = "../../etc/passwd";
    let session = materialized_text_session(raw_session_id.into(), "data".into());
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    let message = err.to_string();
    assert!(message.contains("invalid session_id"));
    assert!(
        !message.contains(raw_session_id),
        "invalid-session error must not echo raw session id: {message}"
    );
}

#[test]
fn restore_session_logs_claude_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let raw_session_id = "sess-sensitive-restore-17975";
    let session = materialized_text_session(raw_session_id.into(), r#"{"type":"init"}"#.into());

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session));

    let diagnostics = result.unwrap();
    assert_eq!(diagnostics.framework, "claude-code");
    assert_eq!(diagnostics.session_id, raw_session_id);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
    let event = captured_event(&events, "restored session history");
    assert_eq!(
        event.fields.get("framework").map(String::as_str),
        Some("claude-code")
    );
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
    assert!(
        !event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {event:#?}"
    );
}

#[test]
fn restore_session_unknown_framework_uses_claude_fallback() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let session = materialized_text_session("sess-1".into(), "data".into());

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-1.jsonl"
    );
    assert_eq!(writes[0].content, b"data");
}

#[test]
fn restore_session_allows_empty_agent_type() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = String::new(); // empty defaults to claude-code
    let session = materialized_text_session("sess-1".into(), "{}".into());
    // Should proceed (empty agent type treated as claude-code).
    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();
}

#[test]
fn restore_session_writes_codex_session() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history = format!(
        "{}\n",
        serde_json::json!({
            "timestamp": "2026-06-04T07:18:08.001Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": "2026-06-04T07:18:08.000Z",
                "cwd": "/workspace",
                "originator": "test",
                "cli_version": "0.137.0",
                "source": "cli",
                "model_provider": "test-provider",
                "base_instructions": null,
            },
        }),
    );
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history.as_bytes())),
                url: "https://example.com/history".into(),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let session = materialized_text_session(session_id.into(), history.clone());
    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.ends_with(
            "/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        ),
        "codex resume history must be restored as a canonical rollout jsonl, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, session.history_bytes());
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_logs_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let raw_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session = materialized_text_session(raw_session_id.into(), "{}\n".into());

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session));

    let diagnostics = result.unwrap();
    assert_eq!(diagnostics.framework, "codex");
    assert_eq!(diagnostics.session_id, raw_session_id);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
    let restore_event = captured_event(&events, "restored session history");
    assert_eq!(
        restore_event.fields.get("framework").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        restore_event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
    assert!(
        !restore_event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {restore_event:#?}"
    );
}

#[test]
fn restore_session_writes_codex_session_with_canonical_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = materialized_text_session(
        "019e9154-c304-70f0-adde-36efb1be1701".into(),
        "{\"type\":\"thread.started\"}\n{not-json}\n".into(),
    );

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = writes[0]
        .path
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with("-019e9154-c304-70f0-adde-36efb1be1701.jsonl"),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, session.history_bytes());
}

#[test]
fn restore_session_writes_invalid_utf8_claude_history_bytes() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let session = materialized_bytes_session("sess-non-utf8-123".into(), history);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-non-utf8-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_writes_invalid_utf8_codex_history_with_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history = b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-06-04T07:18:08.000Z\"}}\n\xff\n";
    let session = materialized_bytes_session(session_id.into(), history);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = writes[0]
        .path
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with("-019e9154-c304-70f0-adde-36efb1be1701.jsonl"),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, history);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_canonicalizes_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session =
        materialized_text_session("019E9154C30470F0ADDE36EFB1BE1701".into(), "{}\n".into());

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0]
            .path
            .ends_with("-019e9154-c304-70f0-adde-36efb1be1701.jsonl"),
        "codex restore path must use canonical thread id, got {}",
        writes[0].path
    );
}

#[tokio::test]
async fn restore_session_rejects_invalid_codex_session_id() {
    // Path-traversal validation runs before framework dispatch, so codex
    // shares the same allow-list as claude-code.
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = materialized_text_session("../../etc/passwd".into(), "{}".into());
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}

#[tokio::test]
async fn restore_session_rejects_short_codex_session_id_without_cleanup() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = materialized_text_session("abc".into(), "{}".into());

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("invalid codex session_id"), "got: {err}");
    assert!(
        !message.contains("abc"),
        "invalid codex error must not echo raw session id: {message}"
    );
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_rejects_decorated_codex_session_id_without_cleanup() {
    for raw_session_id in [
        "{019e9154-c304-70f0-adde-36efb1be1701}",
        "urn:uuid:019e9154-c304-70f0-adde-36efb1be1701",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        let session = materialized_text_session(raw_session_id.into(), "{}".into());

        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

        let message = err.to_string();
        assert!(message.contains("invalid session_id"), "got: {err}");
        assert!(
            !message.contains(raw_session_id),
            "invalid codex error must not echo raw session id: {message}"
        );
        assert!(sandbox.exec_calls().is_empty());
        assert!(sandbox.write_file_calls().is_empty());
    }
}

#[tokio::test]
async fn restore_session_fails_when_codex_cleanup_fails() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session =
        materialized_text_session("019e9154-c304-70f0-adde-36efb1be1701".into(), "{}\n".into());
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        b"cleanup stdout".to_vec(),
        b"cleanup failed".to_vec(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains("codex session cleanup failed"),
        "got: {message}"
    );
    assert!(message.contains("cleanup failed"), "got: {message}");
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_fails_when_codex_cleanup_exceeds_scan_budget() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session =
        materialized_text_session("019e9154-c304-70f0-adde-36efb1be1701".into(), "{}\n".into());
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"codex session cleanup exceeded scan budget".to_vec(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed"));
    assert!(message.contains("codex session cleanup exceeded scan budget"));
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_preserves_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session_id_no_dashes = session_id.replace('-', "");
    let session_path = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
    let session = materialized_text_session(
        session_id.into(),
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-06-04T07:18:08.001Z",
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": "2026-06-04T07:18:08.000Z",
                },
            }),
        ),
    );
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        format!("stdout includes {session_id_no_dashes}").into_bytes(),
        format!("find: {session_path}: Permission denied").into_bytes(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed"));
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(&session_id_no_dashes), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_preserves_non_exited_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session_id_no_dashes = session_id.replace('-', "");
    let session_path = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
    let session = materialized_text_session(
        session_id.into(),
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-06-04T07:18:08.001Z",
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": "2026-06-04T07:18:08.000Z",
                },
            }),
        ),
    );
    sandbox.push_exec_result(Ok(ExecResult {
        termination: sandbox::ExecTermination::WaitFailed,
        stdout: format!("stdout includes {session_id_no_dashes}").into_bytes(),
        stderr: format!("find: {session_path}: Permission denied").into_bytes(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed (wait failed)"));
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(&session_id_no_dashes), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_preserves_claude_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session_id = "sess-sensitive-write-17975";
    let session_path =
        "/home/user/.claude/projects/-home-user-workspace/sess-sensitive-write-17975.jsonl";
    let session = materialized_text_session(session_id.into(), r#"{"type":"init"}"#.into());
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_codex_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session_id_no_dashes = session_id.replace('-', "");
    let session_path = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
    let session = materialized_text_session(
        session_id.into(),
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-06-04T07:18:08.001Z",
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": "2026-06-04T07:18:08.000Z",
                },
            }),
        ),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to rename temp file to {session_path}: thread {session_id_no_dashes}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(&session_id_no_dashes), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_codex_original_no_dash_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let raw_session_id = "019E9154C30470F0ADDE36EFB1BE1701";
    let canonical_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session_path = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
    let session = materialized_text_session(
        raw_session_id.into(),
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-06-04T07:18:08.001Z",
                "type": "session_meta",
                "payload": {
                    "id": canonical_session_id,
                    "timestamp": "2026-06-04T07:18:08.000Z",
                },
            }),
        ),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write original thread {raw_session_id} at {session_path}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(raw_session_id), "got: {message}");
    assert!(message.contains(canonical_session_id), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_codex_mixed_case_original_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let raw_session_id = "019e9154C30470f0ADDE36efB1be1701";
    let canonical_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session = materialized_text_session(
        raw_session_id.into(),
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-06-04T07:18:08.001Z",
                "type": "session_meta",
                "payload": {
                    "id": canonical_session_id,
                    "timestamp": "2026-06-04T07:18:08.000Z",
                },
            }),
        ),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write original thread {raw_session_id} with canonical {canonical_session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(raw_session_id), "got: {message}");
    assert!(message.contains(canonical_session_id), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_write_file_invalid_state() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session_id = "sess-invalid-state-17975";
    let session_path =
        "/home/user/.claude/projects/-home-user-workspace/sess-invalid-state-17975.jsonl";
    let session = materialized_text_session(session_id.into(), r#"{"type":"init"}"#.into());
    sandbox.push_write_file_result(Err(SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Operation(SandboxOperation::WriteFile),
        state: format!("blocked for {session_path}"),
        message: format!("cannot write session {session_id}"),
    }));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_session_path_and_id_words() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session_id = "session";
    let session_path = "/home/user/.claude/projects/-home-user-workspace/session.jsonl";
    let session = materialized_text_session(session_id.into(), r#"{"type":"init"}"#.into());
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(&format!("failed to write {session_path} for {session_id}")),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_preserves_short_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session_id = "a";
    let session_path = "/home/user/.claude/projects/-home-user-workspace/a.jsonl";
    let session = materialized_text_session(session_id.into(), r#"{"type":"init"}"#.into());
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(&format!("failed to write {session_path} for {session_id}")),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let session = materialized_text_session("sess-abc".into(), r#"{"type":"init"}"#.into());
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("disk full"), "got: {err}");
}

fn assert_codex_cleanup_call(sandbox: &MockSandbox) {
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert_eq!(
        exec_calls[0].env_keys,
        [
            "VM0_CODEX_RESTORE_SESSION_ID".to_string(),
            "VM0_CODEX_RESTORE_SESSION_FILENAME_KEY".to_string(),
            "VM0_CODEX_RESTORE_SESSION_PATH".to_string()
        ]
    );
    assert_eq!(exec_calls[0].timeout, DEFAULT_EXEC_TIMEOUT);
    assert_eq!(exec_calls[0].output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
    assert!(!exec_calls[0].sudo);
    assert!(exec_calls[0].stdin_bytes.is_none());
    assert!(exec_calls[0].cmd.contains("codex_home='/home/user/.codex'"));
    assert!(exec_calls[0].cmd.contains("root=\"$codex_home/sessions\""));
    assert!(exec_calls[0].cmd.contains("check_restore_dir_component"));
    assert!(
        exec_calls[0]
            .cmd
            .contains("check_restore_dir_component \"$codex_home\"")
    );
    assert!(
        exec_calls[0]
            .cmd
            .contains("codex restore directory is a symlink")
    );
    assert!(exec_calls[0].cmd.contains("scan_budget="));
    assert!(
        exec_calls[0]
            .cmd
            .contains("collect_matching_session_entries")
    );
    assert!(
        exec_calls[0]
            .cmd
            .contains("find \"$root\" -mindepth 1 -print0")
    );
    assert!(
        exec_calls[0]
            .cmd
            .contains("delete_matching_session_entries")
    );
    assert!(exec_calls[0].cmd.contains("xargs -0"));
    assert!(exec_calls[0].cmd.contains("\\\\.jsonl\\\\.zst"));
    assert!(exec_calls[0].cmd.contains("\\\\.jsonl\\\\.vm0tmp-"));
    assert!(exec_calls[0].cmd.contains("id_no_dashes"));
    assert!(
        exec_calls[0]
            .cmd
            .contains("VM0_CODEX_RESTORE_SESSION_FILENAME_KEY")
    );
    assert!(!exec_calls[0].cmd.contains("tr -d"));
    assert!(!exec_calls[0].cmd.contains("-delete"));
    assert!(!exec_calls[0].cmd.contains("for path in \"$dir\"/*"));
}

fn capture_restore_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let _capture_guard = RESTORE_SESSION_LOG_CALLSITE_LOCK
        .lock()
        .expect("restore session log callsite lock poisoned");
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = block_on_restore_session(future);
    drop(guard);
    (output, captured.entries())
}

fn run_restore_session<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    let _capture_guard = RESTORE_SESSION_LOG_CALLSITE_LOCK
        .lock()
        .expect("restore session log callsite lock poisoned");
    block_on_restore_session(future)
}

fn block_on_restore_session<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build restore session test runtime")
        .block_on(future)
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}
