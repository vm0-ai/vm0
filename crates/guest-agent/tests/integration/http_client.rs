use crate::support::*;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

// =========================================================================
// post_json core
// =========================================================================

#[tokio::test]
async fn post_json_success_json_response() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/success");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"status": "ok"}));
    });

    let url = api.url("/test/success");
    let result = http_client!()
        .post_json(&url, &json!({"key": "val"}), 1)
        .await;

    mock.assert_calls_async(1).await;
    let val = result.unwrap().unwrap();
    assert_eq!(val["status"], "ok");
}

#[tokio::test]
async fn for_current_env_uses_enabled_client_when_api_token_is_set()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/for-current-env")
            .header("Authorization", "Bearer test-token-abc123");
        then.status(200).json_body(json!({"status": "ok"}));
    });

    let url = api.url("/test/for-current-env");
    let result = guest_agent::http::HttpClient::for_current_env()?
        .post_json(&url, &json!({}), 1)
        .await?;

    mock.assert_calls_async(1).await;
    assert_eq!(result.unwrap()["status"], "ok");
    Ok(())
}

#[tokio::test]
async fn for_current_env_uses_env_api_url_for_webhook_routes()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer test-token-abc123")
            .header("x-vercel-protection-bypass", "test-bypass-value")
            .json_body_includes(r#"{"runId": "test-run-001"}"#)
            .body_includes(r#""sequenceNumber":7"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "test", "data": "env route"});
    guest_agent::events::send_event(
        &guest_agent::http::HttpClient::for_current_env()?,
        event,
        7,
        &masker,
    )
    .await?;

    mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn post_json_success_empty_response() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/empty");
        then.status(200);
    });

    let url = api.url("/test/empty");
    let result = http_client!()
        .post_json(&url, &json!({"key": "val"}), 1)
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.unwrap().is_none());
}

#[tokio::test]
async fn post_json_retry_then_succeed() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/retry-succeed");
        then.respond_with(retry_then_response(
            2,
            json_http_response(200, json!({"recovered": true})),
        ));
    });

    let url = api.url("/test/retry-succeed");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    let val = result.unwrap().unwrap();
    assert_eq!(val["recovered"], true);
    mock.assert_calls_async(3).await;
}

#[tokio::test]
async fn post_json_retry_exhausted() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/exhaust");
        then.status(500);
    });

    let url = api.url("/test/exhaust");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(3).await;
    assert!(result.is_err());
}

// =========================================================================
// post_json 4xx handling
// =========================================================================

#[tokio::test]
async fn post_json_4xx_returns_immediately_no_retry() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-400");
        then.status(400);
    });

    let url = api.url("/test/post-400");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    // Should fail immediately — only 1 call, no retries.
    mock.assert_calls_async(1).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn post_json_429_retries() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-429");
        then.status(429);
    });

    let url = api.url("/test/post-429");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    // 429 is retriable — should exhaust all retries.
    mock.assert_calls_async(3).await;
    assert!(result.is_err());
}

// =========================================================================
// Auth headers
// =========================================================================

#[tokio::test]
async fn post_json_sends_bearer_token() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/auth")
            .header("Authorization", "Bearer test-token-abc123");
        then.status(200);
    });

    let url = api.url("/test/auth");
    let result = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn post_json_sends_vercel_bypass_header() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/bypass")
            .header("x-vercel-protection-bypass", "test-bypass-value");
        then.status(200);
    });

    let url = api.url("/test/bypass");
    let result = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
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
    let api = SharedApiMock::new().await;
    let env_server = api.server();
    let explicit_server = MockServer::start();

    let env_mock = env_server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });
    let explicit_mock = explicit_server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer explicit-token")
            .body_includes(r#""sequenceNumber":3"#);
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
    let event = json!({"type": "test", "data": "explicit route"});
    guest_agent::events::send_event(&http, event, 3, &masker).await?;

    explicit_mock.assert_calls_async(1).await;
    env_mock.assert_calls_async(0).await;
    explicit_mock.delete_async().await;
    Ok(())
}

// =========================================================================
// Edge cases
// =========================================================================

#[tokio::test]
async fn post_json_malformed_json_response() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/malformed");
        then.status(200)
            .header("Content-Type", "application/json")
            .body("not valid json {{{");
    });

    let url = api.url("/test/malformed");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_err());
}
