use std::sync::Arc;
use std::time::Duration;

use reqeast::Client;
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
        let client = reqeast::builder()
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

    /// Build an authenticated request with bearer token and Vercel bypass.
    ///
    /// `path` is appended to the base URL (e.g. `/api/runners/poll`).
    pub fn request(
        &self,
        method: reqeast::Method,
        path: &str,
        token: &str,
    ) -> reqeast::RequestBuilder {
        let url = format!("{}{path}", self.inner.api_url);
        let mut req = self.inner.client.request(method, url).bearer_auth(token);

        if let Some(bypass) = &self.inner.vercel_bypass {
            req = req.header("x-vercel-protection-bypass", bypass);
        }

        req
    }
}
