// Each #[tokio::test] spins up an isolated single-thread runtime, so
// tokio::sync::Mutex cannot wake waiters across runtimes.  A std Mutex
// serialises correctly (each runtime owns its own OS thread).
#![allow(clippy::await_holding_lock)]

use base64::Engine;
use bytes::Bytes;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Shared mock server — env vars are set once before any `LazyLock` in the
/// library is accessed, so `env::api_url()`, `urls::*`, etc. all resolve to
/// the mock server's address.
static MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(|| {
    let server = MockServer::start();
    unsafe {
        std::env::set_var("VM0_API_URL", server.base_url());
        std::env::set_var("VM0_API_TOKEN", "test-token-abc123");
        std::env::set_var("VM0_RUN_ID", "test-run-001");
        std::env::set_var("VM0_WORKING_DIR", "/tmp/test-workdir");
        std::env::set_var("VM0_PROMPT", "test prompt");
        std::env::set_var("VERCEL_PROTECTION_BYPASS", "test-bypass-value");
    }
    server
});

/// Serialize all tests — they share one mock server and process-wide env vars.
static TEST_MUTEX: Mutex<()> = Mutex::new(());

// =========================================================================
// Group 1: post_json core
// =========================================================================

#[tokio::test]
async fn post_json_success_json_response() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/success");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"status": "ok"}));
    });

    let url = format!("{}/test/success", server.base_url());
    let result = guest_agent::http::post_json(&url, &json!({"key": "val"}), 1).await;

    mock.assert_calls_async(1).await;
    let val = result.unwrap().unwrap();
    assert_eq!(val["status"], "ok");
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_success_empty_response() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/empty");
        then.status(200);
    });

    let url = format!("{}/test/empty", server.base_url());
    let result = guest_agent::http::post_json(&url, &json!({"key": "val"}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.unwrap().is_none());
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // Register failure mock first (lower ID = matched first by BTreeMap iteration).
    let fail_mock = server.mock(|when, then| {
        when.method(POST).path("/test/retry-succeed");
        then.status(500);
    });
    // Success mock registered second — becomes active after fail_mock is deleted.
    let success_mock = server.mock(|when, then| {
        when.method(POST).path("/test/retry-succeed");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"recovered": true}));
    });

    let url = format!("{}/test/retry-succeed", server.base_url());
    let handle =
        tokio::spawn(async move { guest_agent::http::post_json(&url, &json!({}), 3).await });

    // Wait until the failure mock has been hit twice, then remove it so
    // the third attempt falls through to the success mock.
    loop {
        if fail_mock.calls_async().await >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    fail_mock.delete_async().await;

    let result = handle.await.unwrap();
    let val = result.unwrap().unwrap();
    assert_eq!(val["recovered"], true);
    success_mock.assert_calls_async(1).await;
    success_mock.delete_async().await;
}

#[tokio::test]
async fn post_json_retry_exhausted() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/exhaust");
        then.status(500);
    });

    let url = format!("{}/test/exhaust", server.base_url());
    let result = guest_agent::http::post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(3).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

// =========================================================================
// Group 2: Auth headers
// =========================================================================

#[tokio::test]
async fn post_json_sends_bearer_token() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/auth")
            .header("Authorization", "Bearer test-token-abc123");
        then.status(200);
    });

    let url = format!("{}/test/auth", server.base_url());
    let result = guest_agent::http::post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_sends_vercel_bypass_header() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/bypass")
            .header("x-vercel-protection-bypass", "test-bypass-value");
        then.status(200);
    });

    let url = format!("{}/test/bypass", server.base_url());
    let result = guest_agent::http::post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

// =========================================================================
// Group 3: put_presigned
// =========================================================================

#[tokio::test]
async fn put_presigned_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-success")
            .header("Content-Type", "application/octet-stream");
        then.status(200);
    });

    let url = format!("{}/test/put-success", server.base_url());
    let data = Bytes::from_static(b"test data");
    let result = guest_agent::http::put_presigned(&url, data, "application/octet-stream").await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // Failure mock first (lower ID = matched first by BTreeMap).
    let fail_mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-retry");
        then.status(500);
    });
    let success_mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-retry");
        then.status(200);
    });

    let url = format!("{}/test/put-retry", server.base_url());
    let data = Bytes::from_static(b"retry data");
    let handle = tokio::spawn(async move {
        guest_agent::http::put_presigned(&url, data, "application/octet-stream").await
    });

    loop {
        if fail_mock.calls_async().await >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    fail_mock.delete_async().await;

    let result = handle.await.unwrap();
    assert!(result.is_ok());
    success_mock.assert_calls_async(1).await;
    success_mock.delete_async().await;
}

// =========================================================================
// Group 4: Heartbeat
// =========================================================================

#[tokio::test]
async fn heartbeat_first_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(200);
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle =
        tokio::spawn(async move { guest_agent::heartbeat::heartbeat_loop(shutdown_clone).await });

    // Wait for the first heartbeat to land, then shut down.
    loop {
        if mock.calls_async().await >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    shutdown.cancel();

    let result = handle.await.unwrap();
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn heartbeat_first_failure_fatal() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(500);
    });

    let shutdown = CancellationToken::new();
    let result = guest_agent::heartbeat::heartbeat_loop(shutdown).await;

    assert!(result.is_err());
    mock.assert_calls_async(3).await;
    mock.delete_async().await;
}

// =========================================================================
// Group 5: Events
// =========================================================================

#[tokio::test]
async fn send_event_correct_payload() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .json_body_includes(r#"{"runId": "test-run-001"}"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let mut event = json!({"type": "test", "data": "hello"});
    let result = guest_agent::events::send_event(&mut event, 42, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    assert_eq!(event["sequenceNumber"], 42);
    mock.delete_async().await;
}

#[tokio::test]
async fn send_event_masks_secrets() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_secret = engine.encode("super-secret-value");
    let masker = SecretMasker::from_raw(&encoded_secret);

    let mut event = json!({"type": "test", "data": "contains super-secret-value here"});
    let result = guest_agent::events::send_event(&mut event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    // The event is mutated in-place; the secret must be replaced.
    assert_eq!(event["data"], "contains *** here");
    mock.delete_async().await;
}

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
    let mut event = json!({"type": "test"});
    let result = guest_agent::events::send_event(&mut event, 1, &masker).await;

    assert!(result.is_err());
    assert!(
        std::path::Path::new(flag_path).exists(),
        "event error flag should be written on failure"
    );
    mock.delete_async().await;

    // Clean up
    let _ = std::fs::remove_file(flag_path);
}
