// Each #[tokio::test] spins up an isolated single-thread runtime, so
// tokio::sync::Mutex cannot wake waiters across runtimes.  A std Mutex
// serialises correctly (each runtime owns its own OS thread).
#![allow(clippy::await_holding_lock)]

use base64::Engine;
use bytes::Bytes;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Shared mock server — env vars are set once before any `LazyLock` in the
/// library is accessed, so environment-backed guest-agent state resolves to
/// test values.
static MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(|| {
    let server = MockServer::start();
    unsafe {
        std::env::set_var("VM0_API_URL", server.base_url());
        std::env::set_var("VM0_API_TOKEN", "test-token-abc123");
        std::env::set_var("VM0_RUN_ID", "test-run-001");
        std::env::set_var("VM0_WORKING_DIR", "/tmp/test-workdir");
        std::env::set_var("VM0_PROMPT", "test prompt");
        std::env::set_var("VERCEL_PROTECTION_BYPASS", "test-bypass-value");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
    }
    server
});

/// Serialize all tests — they share one mock server and process-wide env vars.
static TEST_MUTEX: Mutex<()> = Mutex::new(());

macro_rules! http_client {
    () => {
        test_http_client(TEST_HTTP_RETRY_DELAY)
    };
}

const TEST_HTTP_RETRY_DELAY: Duration = Duration::ZERO;
const TEST_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(20);
const MOCK_CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[allow(clippy::expect_used)]
fn test_http_client(retry_delay: Duration) -> guest_agent::http::HttpClient {
    let server = &*MOCK_SERVER;
    guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token-abc123",
        "test-bypass-value",
        retry_delay,
    )
    .expect("build test http client")
}

fn http_status(status: u16) -> HttpMockResponse {
    HttpMockResponse::builder().status(status).build()
}

fn json_http_response(status: u16, body: Value) -> HttpMockResponse {
    HttpMockResponse::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .build()
}

fn retry_then_response(
    failures: usize,
    success_response: HttpMockResponse,
) -> impl Fn(&HttpMockRequest) -> HttpMockResponse {
    let attempts = AtomicUsize::new(0);

    move |_req| {
        if attempts.fetch_add(1, Ordering::SeqCst) < failures {
            return http_status(500);
        }

        success_response.clone()
    }
}

fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
    req.headers_vec()
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
}

fn request_header_absent(req: &HttpMockRequest, name: &str) -> bool {
    !req.headers_vec()
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case(name))
}

fn upload_request_matches(
    req: &HttpMockRequest,
    expected_body: &[u8],
    expected_content_length: &str,
) -> bool {
    request_header_eq(req, "content-length", expected_content_length)
        && request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() == expected_body
}

fn upload_validation_response(
    req: &HttpMockRequest,
    expected_body: &[u8],
    expected_content_length: &str,
) -> HttpMockResponse {
    if upload_request_matches(req, expected_body, expected_content_length) {
        http_status(200)
    } else {
        http_status(400)
    }
}

#[derive(Clone, Default)]
struct MockCallObserver {
    calls: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

impl MockCallObserver {
    fn record(&self) -> usize {
        let calls = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.notify.notify_one();
        calls
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    async fn wait_for(&self, expected: usize, timeout: Duration, context: &str) {
        let result = tokio::time::timeout(timeout, async {
            loop {
                if self.calls() >= expected {
                    return;
                }

                self.notify.notified().await;
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "timed out waiting for {context}: expected at least {expected} mock calls, observed {} after {timeout:?}",
            self.calls(),
        );
    }
}

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &str) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

fn cleanup_session_checkpoint_files() {
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
    let _ = std::fs::remove_file(guest_agent::paths::checkpoint_error_file());
    let _ = std::fs::remove_file(guest_agent::paths::failure_diagnostic_file());
}

struct SessionCheckpointFilesGuard;

impl SessionCheckpointFilesGuard {
    fn new() -> Self {
        cleanup_session_checkpoint_files();
        Self
    }
}

impl Drop for SessionCheckpointFilesGuard {
    fn drop(&mut self) {
        cleanup_session_checkpoint_files();
    }
}

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
    let result = http_client!()
        .post_json(&url, &json!({"key": "val"}), 1)
        .await;

    mock.assert_calls_async(1).await;
    let val = result.unwrap().unwrap();
    assert_eq!(val["status"], "ok");
    mock.delete_async().await;
}

#[tokio::test]
async fn for_current_env_uses_enabled_client_when_api_token_is_set()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/for-current-env")
            .header("Authorization", "Bearer test-token-abc123");
        then.status(200).json_body(json!({"status": "ok"}));
    });

    let url = format!("{}/test/for-current-env", server.base_url());
    let result = guest_agent::http::HttpClient::for_current_env()?
        .post_json(&url, &json!({}), 1)
        .await?;

    mock.assert_calls_async(1).await;
    assert_eq!(result.unwrap()["status"], "ok");
    mock.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn for_current_env_uses_env_api_url_for_webhook_routes()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer test-token-abc123")
            .header("x-vercel-protection-bypass", "test-bypass-value")
            .json_body_includes(r#"{"runId": "test-run-001"}"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let mut event = json!({"type": "test", "data": "env route"});
    guest_agent::events::send_event(
        &guest_agent::http::HttpClient::for_current_env()?,
        &mut event,
        7,
        &masker,
    )
    .await?;

    mock.assert_calls_async(1).await;
    assert_eq!(event["sequenceNumber"], 7);
    mock.delete_async().await;
    Ok(())
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
    let result = http_client!()
        .post_json(&url, &json!({"key": "val"}), 1)
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.unwrap().is_none());
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/retry-succeed");
        then.respond_with(retry_then_response(
            2,
            json_http_response(200, json!({"recovered": true})),
        ));
    });

    let url = format!("{}/test/retry-succeed", server.base_url());
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    let val = result.unwrap().unwrap();
    assert_eq!(val["recovered"], true);
    mock.assert_calls_async(3).await;
    mock.delete_async().await;
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
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(3).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

// =========================================================================
// Group 1b: post_json 4xx handling
// =========================================================================

#[tokio::test]
async fn post_json_4xx_returns_immediately_no_retry() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-400");
        then.status(400);
    });

    let url = format!("{}/test/post-400", server.base_url());
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    // Should fail immediately — only 1 call, no retries.
    mock.assert_calls_async(1).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_429_retries() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-429");
        then.status(429);
    });

    let url = format!("{}/test/post-429", server.base_url());
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    // 429 is retriable — should exhaust all retries.
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
    let result = http_client!().post_json(&url, &json!({}), 1).await;

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
    let result = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_uses_explicit_api_config_without_env_api_url() {
    let server = MockServer::start();
    let http = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "explicit-token",
        "explicit-bypass",
        Duration::ZERO,
    )
    .expect("build explicit API client");

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer explicit-token")
            .header("x-vercel-protection-bypass", "explicit-bypass");
        then.status(200).json_body(json!({}));
    });

    let url = format!("{}/api/webhooks/agent/events", server.base_url());
    let result = http.post_json(&url, &json!({"events": []}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn send_event_uses_explicit_api_config_route_instead_of_env_route()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = TEST_MUTEX.lock().unwrap();
    let env_server = &*MOCK_SERVER;
    let explicit_server = MockServer::start();

    let env_mock = env_server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });
    let explicit_mock = explicit_server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer explicit-token");
        then.respond_with(|req| {
            if request_header_absent(req, "x-vercel-protection-bypass") {
                http_status(200)
            } else {
                http_status(400)
            }
        });
    });

    let http = guest_agent::http::HttpClient::with_api_config(
        explicit_server.base_url(),
        "explicit-token",
        "",
        Duration::ZERO,
    )?;
    let masker = SecretMasker::from_raw("");
    let mut event = json!({"type": "test", "data": "explicit route"});
    guest_agent::events::send_event(&http, &mut event, 3, &masker).await?;

    explicit_mock.assert_calls_async(1).await;
    env_mock.assert_calls_async(0).await;
    assert_eq!(event["sequenceNumber"], 3);
    explicit_mock.delete_async().await;
    env_mock.delete_async().await;
    Ok(())
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
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn transport_only_client_can_send_presigned_upload_without_api_config()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-transport-only");
        then.respond_with(|req| upload_validation_response(req, b"transport-only upload", "21"));
    });

    let url = format!("{}/test/put-transport-only", server.base_url());
    let http = guest_agent::http::HttpClient::new()?;
    http.put_presigned(
        &url,
        Bytes::from_static(b"transport-only upload"),
        "application/octet-stream",
    )
    .await?;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn put_presigned_does_not_send_api_headers() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-no-api-headers");
        then.respond_with(|req| {
            if request_header_absent(req, "authorization")
                && request_header_absent(req, "x-vercel-protection-bypass")
            {
                http_status(200)
            } else {
                http_status(400)
            }
        });
    });

    let url = format!("{}/test/put-no-api-headers", server.base_url());
    let data = Bytes::from_static(b"test data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-retry");
        then.respond_with(retry_then_response(1, http_status(200)));
    });

    let url = format!("{}/test/put-retry", server.base_url());
    let data = Bytes::from_static(b"retry data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

// =========================================================================
// Group 3b: put_presigned 4xx handling
// =========================================================================

#[tokio::test]
async fn put_presigned_4xx_returns_immediately_no_retry() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-403");
        then.status(403);
    });

    let url = format!("{}/test/put-403", server.base_url());
    let data = Bytes::from_static(b"forbidden data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    // Should fail immediately — only 1 call, no retries.
    mock.assert_calls_async(1).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_429_retries() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-429");
        then.status(429);
    });

    let url = format!("{}/test/put-429", server.base_url());
    let data = Bytes::from_static(b"rate limited data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    // 429 is retriable — should exhaust all retries.
    mock.assert_calls_async(3).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

// =========================================================================
// Group 3c: put_presigned_file (streaming upload)
// =========================================================================

#[tokio::test]
async fn put_presigned_file_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("test.bin");
    std::fs::write(&file_path, b"streaming test data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-success")
            .header("Content-Type", "application/gzip")
            .body("streaming test data");
        then.status(200);
    });

    let url = format!("{}/test/put-file-success", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_sets_content_length() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("sized.bin");
    let data = vec![0xABu8; 1024];
    std::fs::write(&file_path, &data).unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-content-length")
            .header("Content-Length", "1024");
        then.status(200);
    });

    let url = format!("{}/test/put-file-content-length", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_fails_if_source_shrinks() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry-shrunk.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();

    let mutation_done = Arc::new(AtomicBool::new(false));
    let mutation_done_for_mock = Arc::clone(&mutation_done);
    let file_path_for_mock = file_path.clone();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry-shrunk");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                mutation_done_for_mock.store(
                    std::fs::write(&file_path_for_mock, b"short").is_ok(),
                    Ordering::SeqCst,
                );
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry-shrunk", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(mutation_done.load(Ordering::SeqCst));
    assert!(result.is_err());
    let calls = mock.calls_async().await;
    assert_eq!(calls, 1);
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_uses_original_length_if_source_grows() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry-grown.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();

    let mutation_done = Arc::new(AtomicBool::new(false));
    let mutation_done_for_mock = Arc::clone(&mutation_done);
    let file_path_for_mock = file_path.clone();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry-grown");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                mutation_done_for_mock.store(
                    std::fs::write(&file_path_for_mock, b"retry file data plus extra").is_ok(),
                    Ordering::SeqCst,
                );
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry-grown", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(mutation_done.load(Ordering::SeqCst));
    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_uses_original_handle_if_path_is_replaced() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry-replaced.bin");
    let replacement_path = dir.path().join("replacement.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();
    std::fs::write(&replacement_path, b"changed content").unwrap();

    let mutation_done = Arc::new(AtomicBool::new(false));
    let mutation_done_for_mock = Arc::clone(&mutation_done);
    let file_path_for_mock = file_path.clone();
    let replacement_path_for_mock = replacement_path.clone();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry-replaced");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                mutation_done_for_mock.store(
                    std::fs::rename(&replacement_path_for_mock, &file_path_for_mock).is_ok(),
                    Ordering::SeqCst,
                );
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry-replaced", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(mutation_done.load(Ordering::SeqCst));
    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_large_multi_chunk() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("large.bin");
    // 600000 bytes — spans multiple 256 KiB streaming chunks.
    let data = vec![0x42u8; 600000];
    std::fs::write(&file_path, &data).unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-large")
            .header("Content-Length", "600000");
        then.status(200);
    });

    let url = format!("{}/test/put-file-large", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_4xx_no_retry() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("forbidden.bin");
    std::fs::write(&file_path, b"forbidden data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-403");
        then.status(403);
    });

    let url = format!("{}/test/put-file-403", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

// =========================================================================
// Group 4: Heartbeat
// =========================================================================

#[tokio::test]
async fn heartbeat_first_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| {
            observer_for_mock.record();
            http_status(200)
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop(http_client!(), shutdown_clone).await
    });

    // Wait for the first heartbeat to land, then shut down.
    observer
        .wait_for(
            1,
            MOCK_CALL_TIMEOUT,
            "heartbeat_first_success initial heartbeat",
        )
        .await;
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
    let result = guest_agent::heartbeat::heartbeat_loop(http_client!(), shutdown).await;

    assert!(result.is_err());
    mock.assert_calls_async(3).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn heartbeat_consecutive_failures_fatal() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| {
            if observer_for_mock.record() == 1 {
                return http_status(200);
            }

            json_http_response(401, json!({"error": {"message": "Run expired"}}))
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_with_interval(
            http_client!(),
            shutdown_clone,
            TEST_HEARTBEAT_INTERVAL,
        )
        .await
    });

    // heartbeat_loop should exit after MAX_CONSECUTIVE_HEARTBEAT_FAILURES.
    let result = tokio::time::timeout(Duration::from_secs(30), handle)
        .await
        .expect("heartbeat_loop should exit within timeout")
        .expect("task should not panic");

    // Clean up mocks before assertions to avoid leaks on panic.
    let heartbeat_calls = observer.calls();
    mock.delete_async().await;
    shutdown.cancel();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("consecutive"),
        "error should mention consecutive failures: {err}"
    );

    // 401 is a 4xx error -> post_json returns immediately (no internal retries),
    // so the sequence is one success followed by the fatal failure window.
    assert_eq!(heartbeat_calls, 4);
}

#[tokio::test]
async fn heartbeat_recovery_resets_counter() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| match observer_for_mock.record() {
            2 | 3 | 5 | 6 => json_http_response(401, json!({"error": {"message": "Run expired"}})),
            _ => http_status(200),
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_with_interval(
            http_client!(),
            shutdown_clone,
            TEST_HEARTBEAT_INTERVAL,
        )
        .await
    });

    // Sequence: success -> 2 failures -> success -> 2 failures -> success.
    // Without recovery resetting the failure counter, the second failure pair
    // would reach the fatal threshold before call 7.
    observer
        .wait_for(
            7,
            MOCK_CALL_TIMEOUT,
            "heartbeat_recovery_resets_counter full sequence",
        )
        .await;

    let heartbeat_calls = observer.calls();

    // The loop should still be running. Stop it before deleting the mock so no
    // background heartbeat can race with mock teardown.
    shutdown.cancel();
    let result = tokio::time::timeout(Duration::from_secs(30), handle)
        .await
        .expect("heartbeat_loop should exit within timeout")
        .expect("task should not panic");
    mock.delete_async().await;

    assert!(
        result.is_ok(),
        "heartbeat_loop should exit Ok after shutdown, not Err"
    );
    assert!(heartbeat_calls >= 7);
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
    let result = guest_agent::events::send_event(&http_client!(), &mut event, 42, &masker).await;

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
    let result = guest_agent::events::send_event(&http_client!(), &mut event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    // The event is mutated in-place; the secret must be replaced.
    assert_eq!(event["data"], "contains *** here");
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
    let mut event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id
    });

    let result = guest_agent::events::send_event(&http_client!(), &mut event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    assert_eq!(
        event["session_id"], "***",
        "send_event should leave the caller's event masked after payload preparation"
    );

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
    let mut event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "ses-prepare-only"
    });
    let payload = guest_agent::events::prepare_event(&mut event, 1, &masker);

    assert_eq!(payload["runId"], "test-run-001");
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
    let mut event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "second-session"
    });
    let result = guest_agent::events::send_event(&http_client!(), &mut event, 1, &masker).await;

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
// Group 6: Session ID extraction
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
    let mut event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "ses-abc-123"
    });
    let result = guest_agent::events::send_event(&http_client!(), &mut event, 1, &masker).await;

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
    let mut event = json!({"type": "assistant", "data": "hello"});
    let result = guest_agent::events::send_event(&http_client!(), &mut event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    assert!(
        !std::path::Path::new(sid_file).exists(),
        "session ID file should NOT be written for non-init events"
    );

    mock.delete_async().await;
}

// =========================================================================
// Group 6b: Recovery checkpoint
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

// =========================================================================
// Group 7: Edge cases
// =========================================================================

#[tokio::test]
async fn put_presigned_retry_exhausted() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-exhaust");
        then.status(500);
    });

    let url = format!("{}/test/put-exhaust", server.base_url());
    let data = Bytes::from_static(b"exhaust data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(3).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

#[tokio::test]
async fn post_json_malformed_json_response() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/malformed");
        then.status(200)
            .header("Content-Type", "application/json")
            .body("not valid json {{{");
    });

    let url = format!("{}/test/malformed", server.base_url());
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_err());
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
    let result = guest_agent::events::send_event(&http_client!(), &mut event, 1, &masker).await;

    assert!(result.is_err());
    assert!(
        std::path::Path::new(flag_path).exists(),
        "event error flag should be written on failure"
    );
    mock.delete_async().await;

    // Clean up
    let _ = std::fs::remove_file(flag_path);
}

// =========================================================================
// Group 8: telemetry flush delta semantics
//
// Backs the parallel-checkpoint-with-catch-up pattern in `main.rs`: the
// first `flush(UploadMode::Live)` runs concurrently with
// `checkpoint::create_checkpoint` and reads the `sandbox_ops` log before
// checkpoint's sub-op records are written; a second
// `flush(UploadMode::Final)` after the join picks up the delta. If the
// uploader ever stopped being incremental — re-reading from offset 0 —
// that pattern would duplicate records; if position-tracking broke in
// the other direction, checkpoint sub-ops would be lost entirely.
// =========================================================================

#[tokio::test]
async fn flush_is_incremental_between_calls() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // Reset per-run telemetry state so this test drives sandbox_ops
    // deterministically (other tests in this file don't record sandbox_ops,
    // but be defensive against cross-test leakage).
    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let pos_file = guest_agent::paths::telemetry_sandbox_ops_pos_file();
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);

    // Two mocks, registered in this order. httpmock matches by ID ascending
    // and returns the first hit, so `first_op_mock` wins when the payload
    // contains that substring; `catchup_mock` catches subsequent POSTs.
    let first_op_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("first_op");
        then.status(200);
    });
    let catchup_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

    // Pre-checkpoint record → first flush captures it.
    guest_common::telemetry::record_sandbox_op("first_op", Duration::from_millis(10), true, None);
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await
        .expect("first flush should succeed");

    // Simulates a checkpoint sub-op written AFTER the parallel pass read
    // the sandbox_ops file. The catch-up flush must pick it up.
    guest_common::telemetry::record_sandbox_op("second_op", Duration::from_millis(20), true, None);
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("catch-up flush should succeed");

    telemetry.shutdown().await;

    // The first upload carried `first_op` and matched `first_op_mock`.
    // The catch-up MUST NOT have carried `first_op` (position tracking
    // advanced past it) — otherwise `first_op_mock` would have matched
    // twice and `catchup_mock` zero times.
    first_op_mock.assert_calls_async(1).await;
    catchup_mock.assert_calls_async(1).await;

    first_op_mock.delete_async().await;
    catchup_mock.delete_async().await;
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);
}

#[tokio::test]
async fn final_flush_uploads_log_emitted_immediately_before_it() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let system_log = guest_agent::paths::system_log_file();
    let pos_file = guest_agent::paths::telemetry_system_log_pos_file();
    let _ = std::fs::remove_file(system_log);
    let _ = std::fs::remove_file(pos_file);

    let marker = "fatal-tail-before-final-telemetry";
    let upload_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes(marker);
        then.status(200);
    });

    let system_log_guard = SystemLogOverrideGuard::set(system_log);
    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

    guest_common::log_warn!("sandbox:guest-agent", "{marker}");
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await
        .expect("final flush should upload just-emitted log");

    telemetry.shutdown().await;
    drop(system_log_guard);

    upload_mock.assert_calls_async(1).await;
    upload_mock.delete_async().await;
    let _ = std::fs::remove_file(system_log);
    let _ = std::fs::remove_file(pos_file);
}

/// Regression for #11008. Combines two distinct guarantees that
/// together produce the "exactly one HTTP POST" assertion:
///
/// 1. **Channel serialization**: every flush goes through the same
///    `tokio::select!` arm in `run()`, so `upload_telemetry` calls are
///    strictly sequential — `save_position` is single-writer.
/// 2. **Empty-delta short-circuit**: the second and third flushes
///    observe `pos == file_len` after the first flush advanced the
///    position, hit the `system_log.is_empty() && metrics.is_empty()
///    && sandbox_ops.is_empty()` early-return in `upload_telemetry`,
///    and skip HTTP entirely.
///
/// Without (1), two flushes could read the same pos and post twice.
/// Without (2), three flushes would all serialize but each would post
/// (the second and third with empty bodies). Asserting `calls == 1`
/// pins both: pos never regresses (1) and empty deltas don't generate
/// HTTP traffic (2).
#[tokio::test]
async fn concurrent_flushes_do_not_regress_pos_file() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let pos_file = guest_agent::paths::telemetry_sandbox_ops_pos_file();
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);

    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200);
    });

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

    // Record one op, then fire several concurrent flushes. Pre-refactor a
    // tick + final could both read the same pos and race on save_position;
    // post-refactor the select serialises them, so only the first sees a
    // non-empty delta and only one HTTP POST happens.
    guest_common::telemetry::record_sandbox_op("only_op", Duration::from_millis(5), true, None);

    let (r1, r2, r3) = tokio::join!(
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
        telemetry.flush(guest_agent::telemetry::UploadMode::Live),
    );
    r1.expect("flush 1 ok");
    r2.expect("flush 2 ok");
    r3.expect("flush 3 ok");

    telemetry.shutdown().await;

    // Pos file points at end of the file — no regression.
    let pos: u64 = std::fs::read_to_string(pos_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let file_len = std::fs::metadata(ops_file).unwrap().len();
    assert_eq!(pos, file_len, "pos must match file length, no regression");

    // Exactly one upload carried the delta — the others saw empty files.
    upload_mock.assert_calls_async(1).await;

    upload_mock.delete_async().await;
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);
}

/// Pins three invariants that have no other test coverage:
/// 1. `flush` propagates the upload's `Err` to the caller (rather than
///    swallowing it via `let _ = reply.send(...)`).
/// 2. The uploader loop **keeps running** after a failed upload — a
///    subsequent `flush` must succeed, not return `TelemetryUnavailable`.
/// 3. A failed upload does **not** advance the pos file, so the deferred
///    delta is re-included in the next attempt (and uploaded once
///    HTTP recovers).
#[tokio::test]
async fn flush_propagates_error_then_loop_recovers() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let pos_file = guest_agent::paths::telemetry_sandbox_ops_pos_file();
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);

    let masker = std::sync::Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(masker, http_client!());

    // Force upload_telemetry to fire HTTP by writing a delta.
    guest_common::telemetry::record_sandbox_op(
        "first_attempt_op",
        Duration::from_millis(5),
        true,
        None,
    );

    // First attempt: server returns 500.
    let fail_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(500);
    });

    let r1 = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert!(r1.is_err(), "flush must propagate the HTTP 500 to caller");
    fail_mock.assert_calls_async(1).await;
    fail_mock.delete_async().await;

    // Second attempt: server returns 200, AND must still see
    // `first_attempt_op` in the body because the failed first upload
    // did not advance the pos file.
    let success_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("first_attempt_op");
        then.status(200);
    });

    let r2 = telemetry
        .flush(guest_agent::telemetry::UploadMode::Live)
        .await;
    assert!(
        r2.is_ok(),
        "loop must keep accepting flushes after a failed upload, got {r2:?}",
    );
    success_mock.assert_calls_async(1).await;

    telemetry.shutdown().await;

    success_mock.delete_async().await;
    let _ = std::fs::remove_file(ops_file);
    let _ = std::fs::remove_file(pos_file);
}

// =========================================================================
// Group 9: Complete webhook
//
// The guest calls /complete right after the checkpoint row lands — the host
// transitions the run to `completed` seconds earlier than waiting for the
// runner's fallback after VM teardown. The runner's POST still fires on VM
// exit and is absorbed by the route's idempotency check.
// =========================================================================

#[tokio::test]
async fn complete_report_success_posts_full_payload_when_metadata_present() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    // VM0_SANDBOX_ID / VM0_SANDBOX_REUSE_RESULT come from MOCK_SERVER init.
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .header("Authorization", "Bearer test-token-abc123")
            .json_body(json!({
                "runId": "test-run-001",
                "exitCode": 0,
                "lastEventSequence": 7,
                "sandboxId": "00000000-0000-4000-8000-000000000abc",
                "sandboxReuseResult": "reused",
            }));
        then.status(200).json_body(json!({
            "success": true,
            "status": "completed",
        }));
    });

    guest_agent::complete::report_success(
        &http_client!(),
        guest_agent::env::sandbox_id(),
        guest_agent::env::sandbox_reuse_result(),
        Some(7),
    )
    .await;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
}

/// Unset runner metadata (guest launched without `VM0_SANDBOX_ID` /
/// `VM0_SANDBOX_REUSE_RESULT`, e.g. a pre-#10787 runner): empty strings
/// must serialize as absent so the payload carries only `runId` +
/// `exitCode`. Matches the `skip_serializing_if = "Option::is_none"`
/// contract end-to-end.
#[tokio::test]
async fn complete_report_success_omits_metadata_when_env_absent() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body(json!({
                "runId": "test-run-001",
                "exitCode": 0,
            }));
        then.status(200).json_body(json!({"success": true}));
    });

    guest_agent::complete::report_success(&http_client!(), "", "", None).await;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn complete_report_success_swallows_server_error() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(500);
    });

    // 1 attempt — no retry, no panic. Fire-and-forget semantics mean the
    // runner fallback is the correctness guarantee.
    guest_agent::complete::report_success(
        &http_client!(),
        guest_agent::env::sandbox_id(),
        guest_agent::env::sandbox_reuse_result(),
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
}

/// 4xx takes a different branch in `post_json` than 5xx: it returns Err
/// immediately without retrying. Production is most likely to hit 401 when
/// the sandbox token has expired by the time /complete fires. Verify the
/// error still swallows cleanly and the runner fallback will be the only
/// call that actually transitions the run.
#[tokio::test]
async fn complete_report_success_swallows_4xx_auth_error() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/complete");
        then.status(401).json_body(json!({
            "error": { "message": "Run expired", "code": "UNAUTHORIZED" }
        }));
    });

    guest_agent::complete::report_success(
        &http_client!(),
        guest_agent::env::sandbox_id(),
        guest_agent::env::sandbox_reuse_result(),
        None,
    )
    .await;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
}
