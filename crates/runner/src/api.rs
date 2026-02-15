use std::time::Duration;

use reqwest::{Client, StatusCode};
use tracing::{debug, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::types::{CompleteRequest, ExecutionContext, Job, PollResponse};

/// Timeout for API requests (covers large claim payloads).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Async HTTP client for the vm0 API.
#[derive(Clone)]
pub struct ApiClient {
    client: Client,
    api_url: String,
    token: String,
    vercel_bypass: Option<String>,
}

impl ApiClient {
    pub fn new(api_url: String, token: String) -> RunnerResult<Self> {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| RunnerError::Internal(format!("http client: {e}")))?;

        let vercel_bypass = std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok();

        Ok(Self {
            client,
            api_url,
            token,
            vercel_bypass,
        })
    }

    /// Poll for a pending job. Returns `Ok(None)` when no work is available.
    pub async fn poll(&self, group: &str) -> RunnerResult<Option<Job>> {
        let url = format!("{}/api/runners/poll", self.api_url);
        debug!(url = %url, "polling for jobs");

        let resp = self
            .auth_request(reqwest::Method::POST, &url, &self.token)
            .json(&serde_json::json!({ "group": group }))
            .send()
            .await
            .map_err(|e| RunnerError::Api(format!("poll: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(RunnerError::Api(format!("poll {status}: {body}")));
        }

        let poll: PollResponse = resp
            .json()
            .await
            .map_err(|e| RunnerError::Api(format!("poll decode: {e}")))?;

        Ok(poll.job)
    }

    /// Claim a job for execution. Returns [`RunnerError::AlreadyClaimed`] on
    /// HTTP 409 so callers can continue gracefully.
    pub async fn claim(&self, run_id: uuid::Uuid) -> RunnerResult<ExecutionContext> {
        let url = format!("{}/api/runners/jobs/{}/claim", self.api_url, run_id);
        debug!(url = %url, "claiming job");

        let resp = self
            .auth_request(reqwest::Method::POST, &url, &self.token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| RunnerError::Api(format!("claim: {e}")))?;

        if resp.status() == StatusCode::CONFLICT {
            return Err(RunnerError::AlreadyClaimed);
        }

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(RunnerError::Api(format!("claim {status}: {body}")));
        }

        let ctx: ExecutionContext = resp
            .json()
            .await
            .map_err(|e| RunnerError::Api(format!("claim decode: {e}")))?;

        Ok(ctx)
    }

    /// Report job completion. Uses the per-job **sandbox token** for auth.
    pub async fn complete(
        &self,
        sandbox_token: &str,
        run_id: uuid::Uuid,
        exit_code: i32,
        error: Option<&str>,
    ) -> RunnerResult<()> {
        let url = format!("{}/api/webhooks/agent/complete", self.api_url);
        debug!(url = %url, "completing job");

        let body = CompleteRequest {
            run_id,
            exit_code,
            error: error.map(String::from),
        };

        let resp = self
            .auth_request(reqwest::Method::POST, &url, sandbox_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| RunnerError::Api(format!("complete: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            warn!(status = %status, "complete request failed: {body}");
            return Err(RunnerError::Api(format!("complete {status}: {body}")));
        }

        Ok(())
    }

    /// Fetch an Ably token for subscribing to runner group notifications.
    pub async fn realtime_token(&self, group: &str) -> RunnerResult<ably_subscriber::TokenRequest> {
        let url = format!("{}/api/runners/realtime/token", self.api_url);
        debug!(url = %url, "fetching realtime token");

        let resp = self
            .auth_request(reqwest::Method::POST, &url, &self.token)
            .json(&serde_json::json!({ "group": group }))
            .send()
            .await
            .map_err(|e| RunnerError::Api(format!("realtime token: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(RunnerError::Api(format!("realtime token {status}: {body}")));
        }

        resp.json()
            .await
            .map_err(|e| RunnerError::Api(format!("realtime token decode: {e}")))
    }

    /// Build an authenticated request with common headers.
    fn auth_request(
        &self,
        method: reqwest::Method,
        url: &str,
        token: &str,
    ) -> reqwest::RequestBuilder {
        let mut req = self.client.request(method, url).bearer_auth(token);

        if let Some(bypass) = &self.vercel_bypass {
            req = req.header("x-vercel-protection-bypass", bypass);
        }

        req
    }
}
