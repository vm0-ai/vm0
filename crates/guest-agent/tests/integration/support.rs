use httpmock::prelude::*;
use serde_json::Value;
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;

/// Shared mock server - env vars are set once before any `LazyLock` in the
/// library is accessed, so environment-backed guest-agent state resolves to
/// test values.
pub(crate) static MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(|| {
    let server = MockServer::start();
    unsafe {
        std::env::set_var("VM0_API_URL", server.base_url());
        std::env::set_var("VM0_API_TOKEN", "test-token-abc123");
        std::env::set_var("VM0_RUN_ID", "test-run-001");
        std::env::set_var("VM0_PROMPT", "test prompt");
        std::env::set_var("VERCEL_PROTECTION_BYPASS", "test-bypass-value");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
    }
    server
});

/// Serialize all tests - they share one mock server and process-wide env vars.
pub(crate) static TEST_MUTEX: Mutex<()> = Mutex::new(());

macro_rules! http_client {
    () => {
        crate::support::test_http_client(crate::support::TEST_HTTP_RETRY_DELAY)
    };
}

pub(crate) const TEST_HTTP_RETRY_DELAY: Duration = Duration::ZERO;
pub(crate) const TEST_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(20);
pub(crate) const MOCK_CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[allow(clippy::expect_used)]
pub(crate) fn test_http_client(retry_delay: Duration) -> guest_agent::http::HttpClient {
    let server = &*MOCK_SERVER;
    guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token-abc123",
        "test-bypass-value",
        retry_delay,
    )
    .expect("build test http client")
}

pub(crate) fn http_status(status: u16) -> HttpMockResponse {
    HttpMockResponse::builder().status(status).build()
}

pub(crate) fn json_http_response(status: u16, body: Value) -> HttpMockResponse {
    HttpMockResponse::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .build()
}

pub(crate) fn retry_then_response(
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

pub(crate) fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
    req.headers_vec()
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
}

pub(crate) fn request_header_absent(req: &HttpMockRequest, name: &str) -> bool {
    !req.headers_vec()
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case(name))
}

pub(crate) fn upload_request_matches(
    req: &HttpMockRequest,
    expected_body: &[u8],
    expected_content_length: &str,
) -> bool {
    request_header_eq(req, "content-length", expected_content_length)
        && request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() == expected_body
}

pub(crate) fn upload_validation_response(
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
pub(crate) struct MockCallObserver {
    calls: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

impl MockCallObserver {
    pub(crate) fn record(&self) -> usize {
        let calls = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.notify.notify_one();
        calls
    }

    pub(crate) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub(crate) async fn wait_for(&self, expected: usize, timeout: Duration, context: &str) {
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

pub(crate) struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    pub(crate) fn set(path: &str) -> Self {
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

pub(crate) struct SessionCheckpointFilesGuard;

impl SessionCheckpointFilesGuard {
    pub(crate) fn new() -> Self {
        cleanup_session_checkpoint_files();
        Self
    }
}

impl Drop for SessionCheckpointFilesGuard {
    fn drop(&mut self) {
        cleanup_session_checkpoint_files();
    }
}
