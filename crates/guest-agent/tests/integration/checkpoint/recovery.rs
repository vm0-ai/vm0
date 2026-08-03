use super::support::*;
use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

#[tokio::test]
async fn recovery_checkpoint_uploads_valid_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("history.jsonl");
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    std::fs::write(&history_path, &history).unwrap();
    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "recovery-session").unwrap();
    guest_agent::paths::write_private(
        &session_history_path_file,
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

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert!(
        !std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists(),
        "recovery checkpoint must not write final session history identity metadata"
    );
}

#[tokio::test]
async fn recovery_checkpoint_does_not_prune_eligible_claude_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_claude_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, _) = write_prunable_claude_history(session_id).unwrap();
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let error = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Session history line 1 is not valid JSON"),
        "recovery checkpoint should validate the original history: {error}"
    );
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_does_not_prune_eligible_codex_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, _) = write_prunable_codex_history(session_id).unwrap();
    runtime.config.home_dir = history_dir.path().to_string_lossy().into_owned();
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let error = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Session history exceeds maximum size"),
        "recovery checkpoint must retain the original Codex hard-limit behavior: {error}"
    );
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

async fn assert_recovery_checkpoint_derives_claude_history_marker(
    seed_empty_marker: bool,
    upload_path: &str,
) -> Result<(), String> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env()?;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = if seed_empty_marker {
        "derived-empty-marker-session"
    } else {
        "derived-missing-marker-session"
    };
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    if seed_empty_marker {
        let (_, session_history_path_file) = session_file_paths();
        guest_agent::paths::write_private(&session_history_path_file, "")
            .map_err(|e| format!("write empty history marker: {e}"))?;
    }
    write_derived_claude_history(&runtime.config.home_dir, session_id, &history)?;

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

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

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

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("partial.jsonl");
    std::fs::write(
        &history_path,
        r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#,
    )
    .unwrap();
    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "partial-session").unwrap();
    guest_agent::paths::write_private(
        &session_history_path_file,
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

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Session history line 2 is not valid JSON"),
        "expected recovery checkpoint to fail on partial JSONL history, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_rejects_non_utf8_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let _history_dir = write_literal_session_history(
        "recovery-non-utf8-session",
        b"{\"type\":\"system\"}\nnon-utf8:\xC3(\n",
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

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Session history is not valid UTF-8"),
        "expected recovery checkpoint to fail on invalid UTF-8 history, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_session_id_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
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

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("No session ID found"),
        "expected recovery checkpoint to fail on missing session ID, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_derived_history_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "missing-history").unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("Failed to read session history"),
        "expected recovery checkpoint to fail on missing derived history, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_rejects_invalid_session_id_without_marker() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "../unsafe-session").unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Failed to derive session history marker from session ID"),
        "expected recovery checkpoint to fail on invalid session ID, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}
