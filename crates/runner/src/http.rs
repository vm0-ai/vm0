use std::sync::Arc;
use std::time::Duration;

use api_contracts::{Method, ResolvedRoute, Route};
use reqwest::Client;
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::platform_api_url::validate_platform_api_url;

/// Default timeout for API requests (covers large claim payloads).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const VERCEL_BYPASS_HEADER: &str = "x-vercel-protection-bypass";

/// Configuration for the shared runner API HTTP client.
pub struct HttpClientConfig {
    pub api_url: String,
    pub vercel_bypass: Option<String>,
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
}

impl HttpClient {
    /// Create a shared API HTTP client using `config.api_url` as the base URL for generated routes.
    ///
    /// The client uses the runner's default request timeout. When
    /// `config.vercel_bypass` is present, that value is attached as
    /// `x-vercel-protection-bypass` on authenticated requests.
    ///
    /// Returns an error if the base API URL is invalid or the underlying HTTP client cannot be built.
    pub fn new(config: HttpClientConfig) -> RunnerResult<Self> {
        let HttpClientConfig {
            api_url,
            vercel_bypass,
        } = config;
        validate_platform_api_url(&api_url)?;

        let client = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
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
            }),
        })
    }

    /// Build an authenticated request from a generated API route.
    pub fn request_route(&self, route: Route, token: &str) -> reqwest::RequestBuilder {
        self.authenticated_request(
            reqwest_method(route.method),
            route.url(&self.inner.api_url),
            token,
        )
    }

    /// Build an authenticated request from a generated route with params applied.
    pub fn request_resolved_route(
        &self,
        route: ResolvedRoute,
        token: &str,
    ) -> reqwest::RequestBuilder {
        self.authenticated_request(
            reqwest_method(route.method),
            route.url(&self.inner.api_url),
            token,
        )
    }

    fn authenticated_request(
        &self,
        method: reqwest::Method,
        url: String,
        token: &str,
    ) -> reqwest::RequestBuilder {
        let mut req = self.inner.client.request(method, url).bearer_auth(token);

        if let Some(bypass) = &self.inner.vercel_bypass {
            req = req.header(VERCEL_BYPASS_HEADER, bypass);
        }

        req
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn http_client(api_url: &str) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
        })
        .unwrap()
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
    fn rejects_non_loopback_http_platform_api_url() {
        let err = match HttpClient::new(HttpClientConfig {
            api_url: "http://api.vm0.dev".to_string(),
            vercel_bypass: None,
        }) {
            Ok(_) => panic!("expected non-loopback http platform API URL to be rejected"),
            Err(err) => err,
        };

        assert!(err.to_string().contains("platform API URL must use https"));
    }

    #[test]
    fn request_route_builds_request_from_loopback_http_base_url() {
        let http = http_client("http://127.0.0.1:3000");

        let request = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .build()
            .unwrap();

        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:3000/api/webhooks/agent/telemetry"
        );
    }

    #[tokio::test]
    async fn authenticated_requests_do_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 1024];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/redirected\r\nContent-Length: 0\r\n\r\n",
                )
                .await
                .unwrap();
            request
        });

        let http = http_client(&format!("http://{addr}"));
        let response = http
            .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
    }
}
