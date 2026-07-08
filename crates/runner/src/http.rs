use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_RUNNER;
use api_contracts::{Method, ResolvedRoute, Route};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, Request, Response};
use serde::Serialize;
use tracing::info;
use uuid::Uuid;

use crate::config::normalize_api_base_url;
use crate::error::{RunnerError, RunnerResult};

/// Default timeout for API requests (covers large claim payloads).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const VERCEL_BYPASS_HEADER: &str = "x-vercel-protection-bypass";
const RUNNER_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Configuration for the shared runner API HTTP client.
pub struct HttpClientConfig {
    pub api_url: String,
    pub vercel_bypass: Option<String>,
    pub client_session_id: String,
}

/// Shared HTTP client for the vm0 API. Owns the connection pool, base URL,
/// and Vercel bypass header. Clone is a cheap Arc refcount bump.
#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    api_url: String,
    vercel_bypass: Option<String>,
    client_headers: ClientHeaders,
}

#[derive(Clone)]
struct ClientHeaders {
    client_type: HeaderValue,
    client_version: HeaderValue,
    client_session_id: HeaderValue,
}

/// Request builder for generated vm0 API routes.
///
/// Generated client headers are finalized in `send`/`build` so caller-side
/// request customization cannot accidentally override them.
pub struct ApiRequestBuilder {
    client: Client,
    builder: reqwest::RequestBuilder,
    client_headers: ClientHeaders,
}

impl ApiRequestBuilder {
    pub fn json<T: Serialize + ?Sized>(self, json: &T) -> Self {
        let Self {
            client,
            builder,
            client_headers,
        } = self;
        Self {
            client,
            builder: builder.json(json),
            client_headers,
        }
    }

    pub fn timeout(self, timeout: Duration) -> Self {
        let Self {
            client,
            builder,
            client_headers,
        } = self;
        Self {
            client,
            builder: builder.timeout(timeout),
            client_headers,
        }
    }

    pub async fn send(self) -> RunnerResult<Response> {
        let client = self.client.clone();
        let request = self.finalize()?;
        client
            .execute(request)
            .await
            .map_err(|e| RunnerError::Api(format!("send API request: {e}")))
    }

    #[cfg(test)]
    pub fn build(self) -> RunnerResult<Request> {
        self.finalize()
    }

    fn finalize(self) -> RunnerResult<Request> {
        let mut request = self
            .builder
            .build()
            .map_err(|e| RunnerError::Api(format!("build API request: {e}")))?;
        self.client_headers.apply(request.headers_mut())?;
        Ok(request)
    }

    #[cfg(test)]
    fn header_for_test(self, name: &'static str, value: &'static str) -> Self {
        let Self {
            client,
            builder,
            client_headers,
        } = self;
        Self {
            client,
            builder: builder.header(name, value),
            client_headers,
        }
    }
}

impl ClientHeaders {
    fn new(client_session_id: String) -> RunnerResult<Self> {
        let client_session_id = HeaderValue::from_str(&client_session_id)
            .map_err(|e| RunnerError::Internal(format!("invalid client session id: {e}")))?;

        Ok(Self {
            client_type: HeaderValue::from_static(CLIENT_TYPE_RUNNER),
            client_version: HeaderValue::from_static(RUNNER_CLIENT_VERSION),
            client_session_id,
        })
    }

    fn apply(&self, headers: &mut HeaderMap) -> RunnerResult<()> {
        let request_id = Uuid::new_v4().to_string();
        let request_id = match HeaderValue::from_str(&request_id) {
            Ok(value) => value,
            Err(error) => {
                return Err(RunnerError::Internal(format!(
                    "invalid client request id: {error}"
                )));
            }
        };
        headers.insert(CLIENT_VERSION_HEADER, self.client_version.clone());
        headers.insert(CLIENT_TYPE_HEADER, self.client_type.clone());
        headers.insert(CLIENT_SESSION_ID_HEADER, self.client_session_id.clone());
        headers.insert(CLIENT_REQUEST_ID_HEADER, request_id);
        Ok(())
    }
}

impl HttpClient {
    /// Create a shared API HTTP client using `config.api_url` as the base URL for generated routes.
    ///
    /// The client uses the runner's default request timeout. When
    /// `config.vercel_bypass` is present, that value is attached as
    /// `x-vercel-protection-bypass` on authenticated requests.
    ///
    /// Returns an error if the underlying HTTP client cannot be built.
    pub fn new(config: HttpClientConfig) -> RunnerResult<Self> {
        let HttpClientConfig {
            api_url: raw_api_url,
            vercel_bypass,
            client_session_id,
        } = config;
        let api_url = normalize_api_base_url(&raw_api_url)?;

        let client = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| RunnerError::Internal(format!("http client: {e}")))?;

        info!(
            api_url = %api_url,
            vercel_bypass = vercel_bypass.is_some(),
            "http client initialized"
        );

        Ok(Self {
            inner: Arc::new(Inner {
                client,
                api_url,
                vercel_bypass,
                client_headers: ClientHeaders::new(client_session_id)?,
            }),
        })
    }

    /// Build an authenticated request from a generated API route.
    pub fn request_route(&self, route: Route, token: &str) -> ApiRequestBuilder {
        self.authenticated_request(
            reqwest_method(route.method),
            route.url(&self.inner.api_url),
            token,
        )
    }

    /// Build an authenticated request from a generated route with params applied.
    pub fn request_resolved_route(&self, route: ResolvedRoute, token: &str) -> ApiRequestBuilder {
        self.authenticated_request(
            reqwest_method(route.method),
            route.url(&self.inner.api_url),
            token,
        )
    }

    pub fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.inner.client.get(url)
    }

    fn authenticated_request(
        &self,
        method: reqwest::Method,
        url: String,
        token: &str,
    ) -> ApiRequestBuilder {
        let mut req = self.inner.client.request(method, url).bearer_auth(token);

        if let Some(bypass) = &self.inner.vercel_bypass {
            req = req.header(VERCEL_BYPASS_HEADER, bypass);
        }

        ApiRequestBuilder {
            client: self.inner.client.clone(),
            builder: req,
            client_headers: self.inner.client_headers.clone(),
        }
    }
}

fn reqwest_method(method: Method) -> reqwest::Method {
    match method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
        Method::Put => reqwest::Method::PUT,
        Method::Patch => reqwest::Method::PATCH,
        Method::Delete => reqwest::Method::DELETE,
        Method::Head => reqwest::Method::HEAD,
        Method::Options => reqwest::Method::OPTIONS,
    }
}

#[cfg(test)]
mod tests {
    use api_contracts::generated::routes;
    use reqwest::header::AUTHORIZATION;

    use super::*;

    fn http_client(api_url: &str) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn header_value(request: &reqwest::Request, name: &str) -> String {
        request
            .headers()
            .get(name)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn request_route_builds_request_from_generated_route() {
        let http = http_client("https://api.vm0.dev/");

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://api.vm0.dev/api/webhooks/agent/telemetry"
        );
        assert_eq!(
            request
                .headers()
                .get(AUTHORIZATION)
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer sandbox-token"
        );
    }

    #[test]
    fn new_normalizes_api_url_before_building_routes() {
        let http = http_client("https://api.vm0.dev/prefix/");

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert_eq!(
            request.url().as_str(),
            "https://api.vm0.dev/prefix/api/webhooks/agent/telemetry"
        );
    }

    #[test]
    fn new_rejects_api_url_with_sensitive_components() {
        let result = HttpClient::new(HttpClientConfig {
            api_url: "https://user:pass@api.vm0.dev?token=secret".to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        });
        let error = match result {
            Ok(_) => panic!("expected invalid API URL to be rejected"),
            Err(error) => error,
        };
        let message = error.to_string();

        assert!(message.contains("server.url"), "got: {message}");
        assert!(message.contains("credentials"), "got: {message}");
        assert!(
            !message.contains("user:pass") && !message.contains("token=secret"),
            "error should not echo sensitive URL components: {message}"
        );
    }

    #[test]
    fn request_resolved_route_builds_request_from_generated_route() {
        let http = http_client("https://api.vm0.dev/");

        let request = http
            .request_resolved_route(
                routes::runners::jobs::by_id::claim::route(
                    routes::runners::jobs::by_id::claim::Params {
                        id: "550e8400-e29b-41d4-a716-446655440000",
                    },
                ),
                "runner-token",
            )
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://api.vm0.dev/api/runners/jobs/550e8400-e29b-41d4-a716-446655440000/claim"
        );
    }

    #[test]
    fn request_includes_vercel_bypass_header_when_configured() {
        let http = HttpClient::new(HttpClientConfig {
            api_url: "https://api.vm0.dev/".to_string(),
            vercel_bypass: Some("bypass-secret".to_string()),
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap();

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert_eq!(
            request
                .headers()
                .get(VERCEL_BYPASS_HEADER)
                .unwrap()
                .to_str()
                .unwrap(),
            "bypass-secret"
        );
    }

    #[test]
    fn request_excludes_vercel_bypass_header_when_not_configured() {
        let http = http_client("https://api.vm0.dev/");

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert!(request.headers().get(VERCEL_BYPASS_HEADER).is_none());
    }

    #[test]
    fn request_includes_client_headers() {
        let http = http_client("https://api.vm0.dev/");

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert_eq!(
            header_value(&request, CLIENT_VERSION_HEADER),
            RUNNER_CLIENT_VERSION
        );
        assert_eq!(
            header_value(&request, CLIENT_TYPE_HEADER),
            CLIENT_TYPE_RUNNER
        );
        assert_eq!(
            header_value(&request, CLIENT_SESSION_ID_HEADER),
            "runner-session-test"
        );
        Uuid::parse_str(&header_value(&request, CLIENT_REQUEST_ID_HEADER)).unwrap();
    }

    #[test]
    fn request_reuses_session_id_and_generates_fresh_request_id() {
        let http = http_client("https://api.vm0.dev/");

        let first = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();
        let second = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert_eq!(
            header_value(&first, CLIENT_SESSION_ID_HEADER),
            header_value(&second, CLIENT_SESSION_ID_HEADER)
        );
        assert_ne!(
            header_value(&first, CLIENT_REQUEST_ID_HEADER),
            header_value(&second, CLIENT_REQUEST_ID_HEADER)
        );
    }

    #[test]
    fn generated_client_headers_override_caller_headers() {
        let http = http_client("https://api.vm0.dev/");

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .header_for_test(CLIENT_VERSION_HEADER, "caller-version")
            .header_for_test(CLIENT_TYPE_HEADER, "caller-type")
            .header_for_test(CLIENT_SESSION_ID_HEADER, "caller-session")
            .header_for_test(CLIENT_REQUEST_ID_HEADER, "caller-request")
            .build()
            .unwrap();

        assert_eq!(
            header_value(&request, CLIENT_VERSION_HEADER),
            RUNNER_CLIENT_VERSION
        );
        assert_eq!(
            header_value(&request, CLIENT_TYPE_HEADER),
            CLIENT_TYPE_RUNNER
        );
        assert_eq!(
            header_value(&request, CLIENT_SESSION_ID_HEADER),
            "runner-session-test"
        );
        assert_ne!(
            header_value(&request, CLIENT_REQUEST_ID_HEADER),
            "caller-request"
        );
    }

    #[test]
    fn external_get_excludes_client_headers() {
        let http = http_client("https://api.vm0.dev/");

        let request = http.get("https://blob.example/history").build().unwrap();

        assert!(request.headers().get(CLIENT_VERSION_HEADER).is_none());
        assert!(request.headers().get(CLIENT_TYPE_HEADER).is_none());
        assert!(request.headers().get(CLIENT_SESSION_ID_HEADER).is_none());
        assert!(request.headers().get(CLIENT_REQUEST_ID_HEADER).is_none());
    }
}
