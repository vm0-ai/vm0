use crate::support::*;
use base64::Engine;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;

// =========================================================================
// Events
// =========================================================================

#[tokio::test]
async fn send_event_correct_payload() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .json_body_includes(r#"{"runId": "test-run-001"}"#)
            .body_includes(r#""sequenceNumber":42"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "test", "data": "hello"});
    let result = guest_agent::events::send_event(&http_client!(), event, 42, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn send_event_masks_secrets() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""data":"contains *** here""#);
        then.status(200);
    });

    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_secret = engine.encode("super-secret-value");
    let masker = SecretMasker::from_raw(&encoded_secret);

    let event = json!({"type": "test", "data": "contains super-secret-value here"});
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn send_event_captures_session_metadata_before_masking() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = guest_agent::paths::session_id_file();
    let hist_file = guest_agent::paths::session_history_path_file();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""session_id":"***""#);
        then.status(200);
    });

    let session_id = "ses-secret-123";
    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_session_id = engine.encode(session_id);
    let masker = SecretMasker::from_raw(&encoded_session_id);
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id
    });

    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    let stored = std::fs::read_to_string(sid_file).unwrap();
    assert_eq!(
        stored, session_id,
        "checkpoint metadata should capture the unmasked session id"
    );
    let history = std::fs::read_to_string(hist_file).unwrap();
    assert!(
        history.contains(session_id),
        "history path should contain the unmasked session id, got: {history}"
    );
    assert!(
        !history.contains("***"),
        "history path must not be built from masked metadata, got: {history}"
    );

    mock.delete_async().await;
}

#[tokio::test]
async fn prepare_event_does_not_capture_session_metadata() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _server = &*MOCK_SERVER;
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = guest_agent::paths::session_id_file();
    let hist_file = guest_agent::paths::session_history_path_file();

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "ses-prepare-only"
    });
    let payload = guest_agent::events::prepare_event_payload(event, 1, &masker);

    assert_eq!(payload["runId"], "test-run-001");
    assert_eq!(payload["events"][0]["sequenceNumber"], 1);
    assert!(
        !std::path::Path::new(sid_file).exists(),
        "prepare_event must not write the session ID file"
    );
    assert!(
        !std::path::Path::new(hist_file).exists(),
        "prepare_event must not write the session history path file"
    );
}

#[tokio::test]
async fn send_event_keeps_existing_session_metadata() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = guest_agent::paths::session_id_file();
    let hist_file = guest_agent::paths::session_history_path_file();
    std::fs::write(sid_file, "first-session").unwrap();
    std::fs::write(hist_file, "/tmp/first-session.jsonl").unwrap();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "second-session"
    });
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    assert_eq!(
        std::fs::read_to_string(sid_file).unwrap(),
        "first-session",
        "later id-bearing events must not replace checkpoint session metadata"
    );
    assert_eq!(
        std::fs::read_to_string(hist_file).unwrap(),
        "/tmp/first-session.jsonl",
        "later id-bearing events must not replace checkpoint history metadata"
    );

    mock.delete_async().await;
}

// =========================================================================
// Session ID extraction
// =========================================================================

#[tokio::test]
async fn send_event_extracts_claude_session_id() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // Clean up session files from any prior run
    let sid_file = guest_agent::paths::session_id_file();
    let hist_file = guest_agent::paths::session_history_path_file();
    let _ = std::fs::remove_file(sid_file);
    let _ = std::fs::remove_file(hist_file);

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    // CLI_AGENT_TYPE defaults to "claude-code", so the Claude path is taken:
    // type == "system" && subtype == "init" → reads session_id field.
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "ses-abc-123"
    });
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    // Session ID persisted
    let stored = std::fs::read_to_string(sid_file).unwrap();
    assert_eq!(stored, "ses-abc-123");

    // Session history path written and contains the session ID
    let history = std::fs::read_to_string(hist_file).unwrap();
    assert!(
        history.contains("ses-abc-123"),
        "history path should contain the session ID, got: {history}"
    );
    assert!(
        history.ends_with(".jsonl"),
        "claude-code history path should end with .jsonl, got: {history}"
    );

    mock.delete_async().await;
    let _ = std::fs::remove_file(sid_file);
    let _ = std::fs::remove_file(hist_file);
}

#[tokio::test]
async fn send_event_skips_session_id_for_non_init() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // Ensure no leftover session file
    let sid_file = guest_agent::paths::session_id_file();
    let _ = std::fs::remove_file(sid_file);

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "assistant", "data": "hello"});
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    assert!(
        !std::path::Path::new(sid_file).exists(),
        "session ID file should NOT be written for non-init events"
    );

    mock.delete_async().await;
}

// =========================================================================
// Edge cases
// =========================================================================

#[tokio::test]
async fn send_event_failure_writes_error_flag() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let flag_path = guest_agent::paths::event_error_flag();
    let _ = std::fs::remove_file(flag_path);

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(500);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "test"});
    let result = guest_agent::events::send_event(&http_client!(), event, 1, &masker).await;

    assert!(result.is_err());
    assert!(
        std::path::Path::new(flag_path).exists(),
        "event error flag should be written on failure"
    );
    mock.delete_async().await;

    // Clean up
    let _ = std::fs::remove_file(flag_path);
}
