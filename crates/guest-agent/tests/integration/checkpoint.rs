use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

fn write_derived_claude_history(session_id: &str, history: &str) -> Result<(), String> {
    guest_agent::paths::write_private(guest_agent::paths::session_id_file(), session_id)
        .map_err(|e| format!("write session id: {e}"))?;
    let project_name = guest_agent::paths::CANONICAL_WORKING_DIR
        .strip_prefix('/')
        .unwrap_or(guest_agent::paths::CANONICAL_WORKING_DIR)
        .replace('/', "-");
    let history_path = std::path::Path::new(guest_agent::env::home_dir())
        .join(".claude")
        .join("projects")
        .join(format!("-{project_name}"))
        .join(format!("{session_id}.jsonl"));
    let parent = history_path
        .parent()
        .ok_or_else(|| format!("history path has no parent: {}", history_path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create history dir {}: {e}", parent.display()))?;
    std::fs::write(&history_path, history)
        .map_err(|e| format!("write history {}: {e}", history_path.display()))?;
    Ok(())
}

// =========================================================================
// Recovery checkpoint
// =========================================================================

#[tokio::test]
async fn recovery_checkpoint_uploads_valid_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("history.jsonl");
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    std::fs::write(&history_path, &history).unwrap();
    guest_agent::paths::write_private(guest_agent::paths::session_id_file(), "recovery-session")
        .unwrap();
    guest_agent::paths::write_private(
        guest_agent::paths::session_history_path_file(),
        history_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/recovery-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/recovery-history-upload")
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"recovery-session"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-recovery"}));
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint(&http_client!()).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
}

async fn assert_recovery_checkpoint_derives_claude_history_marker(
    seed_empty_marker: bool,
    upload_path: &str,
) -> Result<(), String> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = if seed_empty_marker {
        "derived-empty-marker-session"
    } else {
        "derived-missing-marker-session"
    };
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    if seed_empty_marker {
        guest_agent::paths::write_private(guest_agent::paths::session_history_path_file(), "")
            .map_err(|e| format!("write empty history marker: {e}"))?;
    }
    write_derived_claude_history(session_id, &history)?;

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url(upload_path),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path(upload_path)
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{session_id}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-derived-history"}));
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint(&http_client!()).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn recovery_checkpoint_derives_missing_claude_history_marker() {
    assert_recovery_checkpoint_derives_claude_history_marker(
        false,
        "/test/derived-missing-history-upload",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn recovery_checkpoint_derives_empty_claude_history_marker() {
    assert_recovery_checkpoint_derives_claude_history_marker(
        true,
        "/test/derived-empty-history-upload",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn recovery_checkpoint_rejects_partial_jsonl_without_error_file() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("partial.jsonl");
    std::fs::write(
        &history_path,
        r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#,
    )
    .unwrap();
    guest_agent::paths::write_private(guest_agent::paths::session_id_file(), "partial-session")
        .unwrap();
    guest_agent::paths::write_private(
        guest_agent::paths::session_history_path_file(),
        history_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint(&http_client!()).await;

    assert!(result.is_err());
    assert!(
        !std::path::Path::new(guest_agent::paths::checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_session_id_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _files_guard = SessionCheckpointFilesGuard::new();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint(&http_client!()).await;

    assert!(result.is_err());
    assert!(
        !std::path::Path::new(guest_agent::paths::checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_derived_history_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _files_guard = SessionCheckpointFilesGuard::new();
    guest_agent::paths::write_private(guest_agent::paths::session_id_file(), "missing-history")
        .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint(&http_client!()).await;

    assert!(result.is_err());
    assert!(
        !std::path::Path::new(guest_agent::paths::checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_rejects_invalid_session_id_without_marker() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _files_guard = SessionCheckpointFilesGuard::new();
    guest_agent::paths::write_private(guest_agent::paths::session_id_file(), "../unsafe-session")
        .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint(&http_client!()).await;

    assert!(result.is_err());
    assert!(
        !std::path::Path::new(guest_agent::paths::checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}
