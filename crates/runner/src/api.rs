use reqeast::StatusCode;
use tracing::warn;

use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::types::{CompleteRequest, ExecutionContext, Job, PollResponse};

/// Async HTTP client for the vm0 runner API.
#[derive(Clone)]
pub struct ApiClient {
    http: HttpClient,
    token: String,
}

impl ApiClient {
    pub fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }

    /// Poll for a pending job. Returns `Ok(None)` when no work is available.
    pub async fn poll(&self, group: &str) -> RunnerResult<Option<Job>> {
        let resp = self
            .http
            .request(reqeast::Method::POST, "/api/runners/poll", &self.token)
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
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let resp = self
            .http
            .request(reqeast::Method::POST, &path, &self.token)
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
        let body = CompleteRequest {
            run_id,
            exit_code,
            error: error.map(String::from),
        };

        let resp = self
            .http
            .request(
                reqeast::Method::POST,
                "/api/webhooks/agent/complete",
                sandbox_token,
            )
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
        let resp = self
            .http
            .request(
                reqeast::Method::POST,
                "/api/runners/realtime/token",
                &self.token,
            )
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
}
