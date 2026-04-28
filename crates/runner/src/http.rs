use std::sync::Arc;
use std::time::Duration;

use api_contracts::{Method, ResolvedRoute, Route};
use reqwest::Client;
use tracing::info;

use crate::error::{RunnerError, RunnerResult};

/// Default timeout for API requests (covers large claim payloads).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

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
    pub fn new(api_url: String) -> RunnerResult<Self> {
        let client = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| RunnerError::Internal(format!("http client: {e}")))?;

        let vercel_bypass = std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok();

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
            req = req.header("x-vercel-protection-bypass", bypass);
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

    use super::*;

    #[test]
    fn request_route_builds_request_from_generated_route() {
        let http = HttpClient::new("https://api.vm0.dev/".to_string()).unwrap();

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
        let http = HttpClient::new("https://api.vm0.dev/".to_string()).unwrap();

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
}
