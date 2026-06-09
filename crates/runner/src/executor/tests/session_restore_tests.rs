use sandbox_mock::MockSandbox;

use super::super::session_restore::{is_valid_session_id, restore_session};
use super::support::{minimal_context, sandbox_exec_error, sandbox_write_file_error};
use crate::types::ResumeSession;

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

#[tokio::test]
async fn restore_session_writes_history() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session = ResumeSession {
        session_id: "sess-abc-123".into(),
        session_history: r#"{"type":"init"}"#.into(),
    };
    restore_session(&sandbox, &ctx, &session).await.unwrap();
}

#[tokio::test]
async fn restore_session_rejects_invalid_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let session = ResumeSession {
        session_id: "../../etc/passwd".into(),
        session_history: "data".into(),
    };
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}

#[tokio::test]
async fn restore_session_skips_unknown_framework() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let session = ResumeSession {
        session_id: "sess-1".into(),
        session_history: "data".into(),
    };
    // Unknown frameworks must no-op silently (warn-and-skip) so a typo in
    // CLI_AGENT_TYPE does not block the run. Pushing an exec error detects
    // any accidental fallthrough into either framework's restore path.
    sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
    restore_session(&sandbox, &ctx, &session).await.unwrap();
}

#[tokio::test]
async fn restore_session_allows_empty_agent_type() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = String::new(); // empty defaults to claude-code
    let session = ResumeSession {
        session_id: "sess-1".into(),
        session_history: "{}".into(),
    };
    // Should proceed (empty agent type treated as claude-code).
    restore_session(&sandbox, &ctx, &session).await.unwrap();
}

#[tokio::test]
async fn restore_session_writes_codex_session() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session = ResumeSession {
        session_id: session_id.into(),
        session_history: format!(
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
        ),
    };
    restore_session(&sandbox, &ctx, &session).await.unwrap();
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.ends_with(
            "/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        ),
        "codex resume history must be restored as a canonical rollout jsonl, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, session.session_history.as_bytes());
}

#[tokio::test]
async fn restore_session_writes_codex_session_with_canonical_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "019e9154-c304-70f0-adde-36efb1be1701".into(),
        session_history: "{\"type\":\"thread.started\"}\n{not-json}\n".into(),
    };

    restore_session(&sandbox, &ctx, &session).await.unwrap();

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
    assert_eq!(writes[0].content, session.session_history.as_bytes());
}

#[tokio::test]
async fn restore_session_rejects_invalid_codex_session_id() {
    // Path-traversal validation runs before framework dispatch, so codex
    // shares the same allow-list as claude-code.
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "../../etc/passwd".into(),
        session_history: "{}".into(),
    };
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}

#[tokio::test]
async fn restore_session_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let session = ResumeSession {
        session_id: "sess-abc".into(),
        session_history: r#"{"type":"init"}"#.into(),
    };
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("disk full"), "got: {err}");
}
