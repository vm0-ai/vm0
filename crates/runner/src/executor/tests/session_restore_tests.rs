use sandbox::ExecResult;
use sandbox_mock::MockSandbox;
use tracing_subscriber::prelude::*;

use super::super::session_restore::{is_valid_session_id, restore_session};
use super::support::{CapturedEvent, CapturedEvents, minimal_context, sandbox_write_file_error};
use crate::paths::diagnostic_session_fingerprint;
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
    let raw_session_id = "../../etc/passwd";
    let session = ResumeSession {
        session_id: raw_session_id.into(),
        session_history: "data".into(),
    };
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    let message = err.to_string();
    assert!(message.contains("invalid session_id"));
    assert!(
        !message.contains(raw_session_id),
        "invalid-session error must not echo raw session id: {message}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn restore_session_logs_fingerprint_without_raw_claude_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let raw_session_id = "sess-sensitive-restore-17975";
    let session = ResumeSession {
        session_id: raw_session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    };

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session)).await;

    result.unwrap();
    assert_captured_events_do_not_contain(&events, raw_session_id);
    let event = captured_event(&events, "restored session history");
    assert_eq!(
        event.fields.get("framework").map(String::as_str),
        Some("claude-code")
    );
    assert_eq!(
        event.fields.get("session_fingerprint").map(String::as_str),
        Some(diagnostic_session_fingerprint(raw_session_id).as_str())
    );
    assert!(
        !event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {event:#?}"
    );
}

#[tokio::test]
async fn restore_session_unknown_framework_uses_claude_fallback() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let session = ResumeSession {
        session_id: "sess-1".into(),
        session_history: "data".into(),
    };

    restore_session(&sandbox, &ctx, &session).await.unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-1.jsonl"
    );
    assert_eq!(writes[0].content, b"data");
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
    assert_eq!(writes[0].content, session.session_history.as_bytes());
}

#[tokio::test(flavor = "current_thread")]
async fn restore_session_logs_fingerprint_without_raw_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let raw_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session = ResumeSession {
        session_id: raw_session_id.into(),
        session_history: "{}\n".into(),
    };

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session)).await;

    result.unwrap();
    assert_captured_events_do_not_contain(&events, raw_session_id);
    let restore_event = captured_event(&events, "restored session history");
    assert_eq!(
        restore_event.fields.get("framework").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        restore_event
            .fields
            .get("session_fingerprint")
            .map(String::as_str),
        Some(diagnostic_session_fingerprint(raw_session_id).as_str())
    );
    assert!(
        !restore_event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {restore_event:#?}"
    );
    let cleanup_event = captured_event(
        &events,
        "cleaned up existing codex session files before restore",
    );
    assert_eq!(
        cleanup_event
            .fields
            .get("session_fingerprint")
            .map(String::as_str),
        Some(diagnostic_session_fingerprint(raw_session_id).as_str())
    );
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
    assert_eq!(writes[0].content, session.session_history.as_bytes());
}

#[tokio::test]
async fn restore_session_canonicalizes_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "019E9154C30470F0ADDE36EFB1BE1701".into(),
        session_history: "{}\n".into(),
    };

    restore_session(&sandbox, &ctx, &session).await.unwrap();

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
    let session = ResumeSession {
        session_id: "../../etc/passwd".into(),
        session_history: "{}".into(),
    };
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}

#[tokio::test]
async fn restore_session_rejects_short_codex_session_id_without_cleanup() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "abc".into(),
        session_history: "{}".into(),
    };

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
async fn restore_session_fails_when_codex_cleanup_fails() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "019e9154-c304-70f0-adde-36efb1be1701".into(),
        session_history: "{}\n".into(),
    };
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
async fn restore_session_redacts_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session_id_no_dashes = session_id.replace('-', "");
    let session_path = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
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
                },
            }),
        ),
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        format!("stdout includes {session_id_no_dashes}").into_bytes(),
        format!("find: {session_path}: Permission denied").into_bytes(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed"));
    assert!(message.contains("[redacted-session-path]"));
    assert!(message.contains("[redacted-session-id]"));
    assert!(
        !message.contains(session_id),
        "cleanup failure must not echo raw session id: {message}"
    );
    assert!(
        !message.contains(&session_id_no_dashes),
        "cleanup failure must not echo no-dash session id: {message}"
    );
    assert!(
        !message.contains(session_path),
        "cleanup failure must not echo raw session path: {message}"
    );
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_redacts_claude_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session_id = "sess-sensitive-write-17975";
    let session_path =
        "/home/user/.claude/projects/-home-user-workspace/sess-sensitive-write-17975.jsonl";
    let session = ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    };
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("[redacted-session-path]"));
    assert!(message.contains("[redacted-session-id]"));
    assert!(
        !message.contains(session_id),
        "write failure must not echo raw session id: {message}"
    );
    assert!(
        !message.contains(session_path),
        "write failure must not echo raw session path: {message}"
    );
}

#[tokio::test]
async fn restore_session_redacts_codex_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session_id_no_dashes = session_id.replace('-', "");
    let session_path = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
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
                },
            }),
        ),
    };
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to rename temp file to {session_path}: thread {session_id_no_dashes}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("[redacted-session-path]"));
    assert!(message.contains("[redacted-session-id]"));
    assert!(
        !message.contains(session_id),
        "write failure must not echo raw session id: {message}"
    );
    assert!(
        !message.contains(&session_id_no_dashes),
        "write failure must not echo no-dash session id: {message}"
    );
    assert!(
        !message.contains(session_path),
        "write failure must not echo raw session path: {message}"
    );
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

fn assert_codex_cleanup_call(sandbox: &MockSandbox) {
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert_eq!(
        exec_calls[0].env_keys,
        [
            "VM0_CODEX_RESTORE_SESSION_ID".to_string(),
            "VM0_CODEX_RESTORE_SESSION_PATH".to_string()
        ]
    );
    assert!(!exec_calls[0].sudo);
    assert!(exec_calls[0].stdin_bytes.is_none());
    assert!(exec_calls[0].cmd.contains("codex_home=/home/user/.codex"));
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
    assert!(
        exec_calls[0]
            .cmd
            .contains("find \"$root\" \\( -type f -o -type l \\)")
    );
    assert!(exec_calls[0].cmd.contains("-iname"));
    assert!(exec_calls[0].cmd.contains(".jsonl.zst"));
    assert!(exec_calls[0].cmd.contains(".jsonl.vm0tmp-*"));
    assert!(exec_calls[0].cmd.contains("id_no_dashes"));
    assert!(exec_calls[0].cmd.contains("-delete"));
}

async fn capture_restore_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
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

fn assert_captured_events_do_not_contain(events: &[CapturedEvent], raw: &str) {
    for event in events {
        for (field, value) in &event.fields {
            assert!(
                !value.contains(raw),
                "captured field {field} leaked raw session id {raw:?}: {event:#?}"
            );
        }
    }
}
