use std::collections::BTreeMap;

use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_CLI;
use api_contracts::generated::routes::runners::heartbeat::HEARTBEAT;
use httpmock::prelude::*;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue};
use serde_json::json;
use uuid::Uuid;
use zero_cli::build::BuildInfo;
use zero_cli::config::{RuntimeConfig, RuntimeEnvironment};
use zero_cli::error::CliError;
use zero_cli::http::ApiClient;

const TOKEN: &str = "sensitive-zero-token-value";
const VERCEL_BYPASS: &str = "sensitive-vercel-bypass-value";

fn config(api_url: &str) -> RuntimeConfig {
    RuntimeConfig::from_environment(RuntimeEnvironment {
        zero_token: Some(TOKEN.into()),
        api_backend_url: Some(api_url.into()),
        vercel_automation_bypass_secret: Some(VERCEL_BYPASS.into()),
        ..RuntimeEnvironment::default()
    })
    .unwrap()
}

fn header_name(value: &str) -> HeaderName {
    HeaderName::from_bytes(value.as_bytes()).unwrap()
}

fn required_header<'a>(request: &'a reqwest::Request, name: &str) -> &'a HeaderValue {
    request
        .headers()
        .get(name)
        .unwrap_or_else(|| panic!("missing header {name}"))
}

#[test]
fn client_finalizes_auth_and_contract_headers_after_caller_customization() {
    let client = ApiClient::from_config(&config("https://api.example.test")).unwrap();
    let first = client
        .request_route(HEARTBEAT)
        .header(AUTHORIZATION, HeaderValue::from_static("Bearer spoofed"))
        .header(
            header_name(CLIENT_VERSION_HEADER),
            HeaderValue::from_static("spoofed-version"),
        )
        .header(
            header_name(CLIENT_SESSION_ID_HEADER),
            HeaderValue::from_static("spoofed-session"),
        )
        .header(
            header_name(CLIENT_REQUEST_ID_HEADER),
            HeaderValue::from_static("spoofed-request"),
        )
        .build()
        .unwrap();
    let second = client.request_route(HEARTBEAT).build().unwrap();

    assert_eq!(first.method(), reqwest::Method::POST);
    assert_eq!(
        first.url().as_str(),
        "https://api.example.test/api/runners/heartbeat"
    );
    assert_eq!(
        required_header(&first, AUTHORIZATION.as_str())
            .to_str()
            .unwrap(),
        format!("Bearer {TOKEN}")
    );
    assert!(required_header(&first, AUTHORIZATION.as_str()).is_sensitive());
    assert_eq!(
        required_header(&first, "x-vercel-protection-bypass")
            .to_str()
            .unwrap(),
        VERCEL_BYPASS
    );
    assert!(required_header(&first, "x-vercel-protection-bypass").is_sensitive());
    assert_eq!(
        required_header(&first, CLIENT_VERSION_HEADER)
            .to_str()
            .unwrap(),
        BuildInfo::current().version
    );
    assert_eq!(
        required_header(&first, CLIENT_TYPE_HEADER)
            .to_str()
            .unwrap(),
        CLIENT_TYPE_CLI
    );
    let first_session = required_header(&first, CLIENT_SESSION_ID_HEADER)
        .to_str()
        .unwrap();
    let second_session = required_header(&second, CLIENT_SESSION_ID_HEADER)
        .to_str()
        .unwrap();
    let first_request = required_header(&first, CLIENT_REQUEST_ID_HEADER)
        .to_str()
        .unwrap();
    let second_request = required_header(&second, CLIENT_REQUEST_ID_HEADER)
        .to_str()
        .unwrap();
    assert_eq!(first_session, second_session);
    assert_ne!(first_request, second_request);
    assert!(Uuid::parse_str(first_session).is_ok());
    assert!(Uuid::parse_str(first_request).is_ok());
    assert!(Uuid::parse_str(second_request).is_ok());
    assert!(first.headers().get(CONTENT_TYPE).is_none());

    let debug = format!("{first:?}");
    assert!(!debug.contains(TOKEN));
    assert!(!debug.contains(VERCEL_BYPASS));
}

#[test]
fn client_adds_content_type_only_for_json_and_serializes_query_parameters() {
    let client = ApiClient::from_config(&config("https://api.example.test")).unwrap();
    let request = client
        .request_route(HEARTBEAT)
        .query(&BTreeMap::from([("cursor", "next page")]))
        .json(&json!({ "ok": true }))
        .build()
        .unwrap();

    assert_eq!(
        required_header(&request, CONTENT_TYPE.as_str())
            .to_str()
            .unwrap(),
        "application/json"
    );
    assert_eq!(request.url().query(), Some("cursor=next+page"));
}

#[tokio::test]
async fn client_parses_api_errors_and_redacts_known_secrets() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/runners/heartbeat");
        then.status(403).json_body(json!({
            "error": {
                "code": "FORBIDDEN",
                "message": format!("request rejected for {TOKEN} using {VERCEL_BYPASS}")
            }
        }));
    });
    let client = ApiClient::from_config(&config(&server.base_url())).unwrap();

    let error = client
        .request_route(HEARTBEAT)
        .send("fallback error")
        .await
        .unwrap_err();

    mock.assert_calls_async(1).await;
    let CliError::Api(api_error) = &error else {
        panic!("expected API error, received {error:?}");
    };
    assert_eq!(api_error.status(), 403);
    assert_eq!(api_error.code(), "FORBIDDEN");
    assert_eq!(
        api_error.message(),
        "request rejected for [REDACTED] using [REDACTED]"
    );
    let debug = format!("{error:?} {error}");
    assert!(!debug.contains(TOKEN));
    assert!(!debug.contains(VERCEL_BYPASS));
}

#[tokio::test]
async fn client_uses_a_sanitized_default_for_unparseable_error_bodies() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/runners/heartbeat");
        then.status(502).body("not-json");
    });
    let client = ApiClient::from_config(&config(&server.base_url())).unwrap();

    let error = client
        .request_route(HEARTBEAT)
        .send(&format!("upstream failed for {TOKEN}"))
        .await
        .unwrap_err();

    mock.assert_calls_async(1).await;
    let CliError::Api(api_error) = error else {
        panic!("expected API error");
    };
    assert_eq!(api_error.status(), 502);
    assert_eq!(api_error.code(), "UNKNOWN");
    assert_eq!(api_error.message(), "upstream failed for [REDACTED]");
}

#[test]
fn client_requires_zero_token_authentication() {
    let config = RuntimeConfig::from_environment(RuntimeEnvironment::default()).unwrap();
    let error = match ApiClient::from_config(&config) {
        Ok(_) => panic!("client unexpectedly accepted missing auth"),
        Err(error) => error,
    };

    assert!(matches!(error, CliError::NotAuthenticated));
}

#[test]
fn invalid_proxy_configuration_does_not_expose_proxy_credentials() {
    let sensitive_proxy = "http://proxy-user:proxy-password@";
    let config = RuntimeConfig::from_environment(RuntimeEnvironment {
        zero_token: Some(TOKEN.into()),
        http_proxy: Some(sensitive_proxy.into()),
        ..RuntimeEnvironment::default()
    })
    .unwrap();
    let error = match ApiClient::from_config(&config) {
        Ok(_) => panic!("client unexpectedly accepted an invalid proxy"),
        Err(error) => error,
    };
    let rendered = format!("{error:?} {error}");

    assert!(matches!(error, CliError::HttpClient));
    assert!(!rendered.contains("proxy-user"));
    assert!(!rendered.contains("proxy-password"));
}
