use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

// =========================================================================
// Recovery checkpoint
// =========================================================================

#[tokio::test]
async fn recovery_checkpoint_uploads_valid_session_history() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("history.jsonl");
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    std::fs::write(&history_path, &history).unwrap();
    std::fs::write(guest_agent::paths::session_id_file(), "recovery-session").unwrap();
    std::fs::write(
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
    prepare_mock.delete_async().await;
    upload_mock.delete_async().await;
    checkpoint_mock.delete_async().await;
}

#[tokio::test]
async fn recovery_checkpoint_rejects_partial_jsonl_without_error_file() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("partial.jsonl");
    std::fs::write(
        &history_path,
        r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#,
    )
    .unwrap();
    std::fs::write(guest_agent::paths::session_id_file(), "partial-session").unwrap();
    std::fs::write(
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
    prepare_mock.delete_async().await;
    checkpoint_mock.delete_async().await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_session_id_is_missing() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

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
    prepare_mock.delete_async().await;
    checkpoint_mock.delete_async().await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_history_marker_is_missing() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let _files_guard = SessionCheckpointFilesGuard::new();
    std::fs::write(guest_agent::paths::session_id_file(), "missing-history").unwrap();

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
    prepare_mock.delete_async().await;
    checkpoint_mock.delete_async().await;
}
