//! [`JobProvider`] backed by an Ably control plane + HTTP polling + REST API.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use api_contracts::generated::routes;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;

use super::api_ably_supervisor::{AblySupervisor, PollOutcome, PollWakeups};
use super::{JobCandidate, JobProvider};
use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::ids::RunId;
use crate::types::{
    CompleteRequest, ExecutionContext, HeartbeatState, Job, PollResponse, SandboxReuseResult,
};
use sandbox::SandboxId;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Poll interval when Ably is connected (safety net).
const POLL_SLOW: Duration = Duration::from_secs(30);
/// Poll interval when Ably is disconnected or unavailable (primary mechanism).
const POLL_FAST: Duration = Duration::from_secs(5);
/// Retry delay after a job-notification wakeup reaches poll but poll fails.
const POLL_WAKEUP_RETRY: Duration = POLL_FAST;

// ---------------------------------------------------------------------------
// ApiProvider
// ---------------------------------------------------------------------------

/// [`JobProvider`] backed by Ably control-plane notifications + HTTP polling + REST API.
///
/// This wraps the current production job lifecycle:
/// - **Control plane**: Ably supervisor for reconnect visibility, cancel notifications,
///   and poll wakeups
/// - **Discovery**: HTTP poll fallback (adaptive interval)
/// - **Claim**: `POST /api/runners/jobs/{id}/claim`
/// - **Complete**: `POST /api/webhooks/agent/complete` with per-job sandbox token
pub struct ApiProvider {
    api: ApiClient,
    group: String,
    /// Profile names this runner supports (e.g., ["vm0/default"]).
    /// Sent in poll requests so the server only returns jobs this runner can handle.
    profiles: Vec<String>,
    /// Coalesced poll wakeup state updated by the Ably supervisor.
    poll_wakeups: Arc<PollWakeups>,
    /// Background Ably control-plane task.
    ably_supervisor: AblySupervisor,
    /// Per-job sandbox tokens for completion auth.
    tokens: tokio::sync::Mutex<HashMap<RunId, String>>,
    /// Session IDs held in the idle pool, sent in poll requests for affinity ordering.
    held_sessions: tokio::sync::Mutex<Vec<String>>,
    /// Shutdown signal.
    cancel: CancellationToken,
}

impl ApiProvider {
    /// Create a new API-backed provider and start the Ably supervisor.
    pub async fn new(
        http: HttpClient,
        token: String,
        group: String,
        profiles: Vec<String>,
        runner_id: String,
        cancel: CancellationToken,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) -> Arc<Self> {
        let api = ApiClient::new(http, token);
        let poll_wakeups = Arc::new(PollWakeups::new(false));
        let ably_supervisor = AblySupervisor::spawn(
            api.clone(),
            group.clone(),
            runner_id,
            Arc::clone(&poll_wakeups),
            cancel_tokens,
            cancel.clone(),
        );

        Arc::new(Self {
            api,
            group,
            profiles,
            poll_wakeups,
            ably_supervisor,
            tokens: tokio::sync::Mutex::new(HashMap::new()),
            held_sessions: tokio::sync::Mutex::new(Vec::new()),
            cancel,
        })
    }
}

#[async_trait::async_trait]
impl JobProvider for ApiProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        loop {
            let due = self
                .poll_wakeups
                .wait_for_poll_due(&self.cancel, POLL_SLOW, POLL_FAST)
                .await?;
            let reason = due.reason();

            let sessions = self.held_sessions.lock().await.clone();
            let poll_result = tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    return None;
                }
                result = self.api.poll(&self.group, &self.profiles, &sessions) => result,
            };

            match poll_result {
                Ok(Some(job)) => {
                    let record = self
                        .poll_wakeups
                        .record_poll_result(due, PollOutcome::JobFound, POLL_WAKEUP_RETRY)
                        .await;
                    if record.defer_job_return() {
                        info!(
                            run_id = %job.run_id,
                            poll_reason = ?reason,
                            "poll: job found while target-other defer arrived, retrying after defer"
                        );
                        continue;
                    }
                    if self.cancel.is_cancelled() {
                        return None;
                    }
                    // Fall back to default profile when server doesn't send one
                    // (backwards compat with pre-profile API).
                    let profile = job
                        .experimental_profile
                        .unwrap_or_else(|| crate::profile::DEFAULT_PROFILE.to_owned());
                    info!(run_id = %job.run_id, %profile, poll_reason = ?reason, "poll: job found");
                    return Some(JobCandidate::new(job.run_id, profile));
                }
                Ok(None) => {
                    self.poll_wakeups
                        .record_poll_result(due, PollOutcome::Empty, POLL_WAKEUP_RETRY)
                        .await;
                }
                Err(e) => {
                    self.poll_wakeups
                        .record_poll_result(due, PollOutcome::Failure, POLL_WAKEUP_RETRY)
                        .await;
                    error!(error = %e, poll_reason = ?reason, "poll failed");
                }
            }
        }
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ExecutionContext> {
        let run_id = candidate.run_id();
        match self.api.claim(run_id).await {
            Ok(ctx) => {
                info!(run_id = %run_id, "job claimed");
                self.tokens
                    .lock()
                    .await
                    .insert(run_id, ctx.sandbox_token.clone());
                Some(ctx)
            }
            Err(RunnerError::AlreadyClaimed) => {
                info!(run_id = %run_id, "already claimed, skipping");
                None
            }
            Err(e) => {
                error!(run_id = %run_id, error = %e, "claim failed");
                None
            }
        }
    }

    async fn heartbeat(&self, state: &HeartbeatState) {
        if let Err(e) = self.api.heartbeat(state).await {
            warn!(error = %e, "heartbeat failed");
        }
    }

    async fn set_held_sessions(&self, sessions: Vec<String>) {
        *self.held_sessions.lock().await = sessions;
    }

    async fn shutdown(&self) {
        self.ably_supervisor.shutdown().await;
    }

    async fn complete(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        sandbox_id: Option<SandboxId>,
        reuse_result: Option<SandboxReuseResult>,
    ) {
        let token = self.tokens.lock().await.remove(&run_id);
        let token = match token {
            Some(t) => t,
            None => {
                error!(
                    run_id = %run_id,
                    "no sandbox token for completion, falling back to runner token"
                );
                self.api.token.clone()
            }
        };

        if let Err(e) = self
            .api
            .complete(&token, run_id, exit_code, error, sandbox_id, reuse_result)
            .await
        {
            warn!(run_id = %run_id, error = %e, "completion report failed, retrying");
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Err(e) = self
                .api
                .complete(&token, run_id, exit_code, error, sandbox_id, reuse_result)
                .await
            {
                error!(run_id = %run_id, error = %e, "failed to report completion after retry");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ApiClient (HTTP transport)
// ---------------------------------------------------------------------------

/// Low-level HTTP client for the vm0 runner API endpoints.
#[derive(Clone)]
pub(super) struct ApiClient {
    http: HttpClient,
    token: String,
}

impl ApiClient {
    fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }

    /// Poll for a pending job. Returns `Ok(None)` when no work is available.
    async fn poll(
        &self,
        group: &str,
        profiles: &[String],
        held_sessions: &[String],
    ) -> RunnerResult<Option<Job>> {
        let mut body = serde_json::json!({ "group": group, "profiles": profiles });
        if !held_sessions.is_empty()
            && let Some(obj) = body.as_object_mut()
        {
            obj.insert("heldSessions".to_string(), serde_json::json!(held_sessions));
        }
        let resp = send_api(
            self.http
                .request_route(routes::runners::poll::POLL, &self.token)
                .json(&body),
            "poll",
        )
        .await?;

        let resp = check_api_status(resp, "poll").await?;
        let poll: PollResponse = decode_api_json(resp, "poll").await?;

        Ok(poll.job)
    }

    /// Send a heartbeat with runner state. Uses a short timeout (3s) to
    /// avoid blocking the main loop.
    async fn heartbeat(&self, state: &HeartbeatState) -> RunnerResult<()> {
        let resp = send_api(
            self.http
                .request_route(routes::runners::heartbeat::HEARTBEAT, &self.token)
                .timeout(Duration::from_secs(3))
                .json(state),
            "heartbeat",
        )
        .await?;

        check_api_status(resp, "heartbeat").await?;

        Ok(())
    }

    /// Claim a job for execution. Returns [`RunnerError::AlreadyClaimed`] on
    /// HTTP 409 (job row still present, already claimed) and HTTP 404 (job
    /// row already dequeued by the winner) so callers can continue gracefully.
    /// Both outcomes are normal contention signals when multiple runners race
    /// for the same job.
    async fn claim(&self, run_id: RunId) -> RunnerResult<ExecutionContext> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.http
                .request_resolved_route(
                    routes::runners::jobs::by_id::claim::route(
                        routes::runners::jobs::by_id::claim::Params {
                            id: run_id.as_str(),
                        },
                    ),
                    &self.token,
                )
                .json(&serde_json::json!({})),
            "claim",
        )
        .await?;

        if matches!(resp.status(), StatusCode::CONFLICT | StatusCode::NOT_FOUND) {
            return Err(RunnerError::AlreadyClaimed);
        }

        let resp = check_api_status(resp, "claim").await?;
        let ctx: ExecutionContext = decode_api_json(resp, "claim").await?;

        Ok(ctx)
    }

    /// Report job completion. Uses the per-job **sandbox token** for auth.
    async fn complete(
        &self,
        sandbox_token: &str,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        sandbox_id: Option<SandboxId>,
        reuse_result: Option<SandboxReuseResult>,
    ) -> RunnerResult<()> {
        let body = CompleteRequest {
            run_id,
            exit_code,
            error: error.map(String::from),
            sandbox_id,
            sandbox_reuse_result: reuse_result,
        };

        let resp = send_api(
            self.http
                .request_route(routes::webhooks::agent::complete::COMPLETE, sandbox_token)
                .json(&body),
            "complete",
        )
        .await?;

        if !resp.status().is_success() {
            let (status, body) = read_api_error(resp).await;
            warn!(status = %status, "complete request failed: {body}");
            return Err(api_status_error("complete", status, &body));
        }

        Ok(())
    }

    /// Fetch an Ably token for subscribing to runner group notifications.
    pub(super) async fn realtime_token(
        &self,
        group: &str,
    ) -> RunnerResult<ably_subscriber::TokenRequest> {
        let resp = send_api(
            self.http
                .request_route(routes::runners::realtime::token::CREATE, &self.token)
                .json(&serde_json::json!({ "group": group })),
            "realtime token",
        )
        .await?;

        let resp = check_api_status(resp, "realtime token").await?;
        decode_api_json(resp, "realtime token").await
    }
}

async fn send_api(req: RequestBuilder, label: &str) -> RunnerResult<Response> {
    req.send()
        .await
        .map_err(|e| RunnerError::Api(format!("{label}: {e}")))
}

async fn check_api_status(resp: Response, label: &str) -> RunnerResult<Response> {
    let status = resp.status();
    if !status.is_success() {
        let (status, body) = read_api_error(resp).await;
        return Err(api_status_error(label, status, &body));
    }
    Ok(resp)
}

async fn decode_api_json<T: DeserializeOwned>(resp: Response, label: &str) -> RunnerResult<T> {
    resp.json()
        .await
        .map_err(|e| RunnerError::Api(format!("{label} decode: {e}")))
}

async fn read_api_error(resp: Response) -> (StatusCode, String) {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    (status, body)
}

fn api_status_error(label: &str, status: StatusCode, body: &str) -> RunnerError {
    RunnerError::Api(format!("{label} {status}: {body}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::Method::POST;
    use httpmock::MockServer;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn api_client_for_server(server: &MockServer) -> ApiClient {
        ApiClient::new(
            HttpClient::new(server.base_url()).unwrap(),
            "runner-token".to_string(),
        )
    }

    fn assert_api_error(err: RunnerError, expected: &str) {
        match err {
            RunnerError::Api(message) => assert_eq!(message, expected),
            other => panic!("expected RunnerError::Api, got {other:?}"),
        }
    }

    fn api_provider_for_test(
        api_url: String,
        cancel: CancellationToken,
        poll_wakeups: Arc<PollWakeups>,
    ) -> Arc<ApiProvider> {
        Arc::new(ApiProvider {
            api: ApiClient::new(
                HttpClient::new(api_url).unwrap(),
                "runner-token".to_string(),
            ),
            group: "default".to_string(),
            profiles: Vec::new(),
            poll_wakeups,
            ably_supervisor: AblySupervisor::disabled(),
            tokens: tokio::sync::Mutex::new(HashMap::new()),
            held_sessions: tokio::sync::Mutex::new(Vec::new()),
            cancel,
        })
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) {
        let mut buf = [0_u8; 4096];
        let _ = socket.read(&mut buf).await.unwrap();
    }

    async fn write_poll_job_response(socket: &mut tokio::net::TcpStream, run_id: RunId) {
        let body = serde_json::json!({
            "job": {
                "runId": run_id,
                "experimentalProfile": "vm0/default"
            }
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn discover_cancel_aborts_in_flight_poll() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0_u8; 1024];
            let _ = socket.read(&mut buf).await;
            let _ = accepted_tx.send(());
            std::future::pending::<()>().await;
        });

        let cancel = CancellationToken::new();
        let provider =
            api_provider_for_test(api_url, cancel.clone(), Arc::new(PollWakeups::new(false)));

        let provider_for_discover = Arc::clone(&provider);
        let discover_task = tokio::spawn(async move { provider_for_discover.discover().await });

        tokio::time::timeout(Duration::from_secs(1), accepted_rx)
            .await
            .expect("poll request should reach the server")
            .unwrap();

        cancel.cancel();

        let result = tokio::time::timeout(Duration::from_secs(1), discover_task)
            .await
            .expect("discover should not wait for the HTTP poll timeout")
            .unwrap();
        assert!(result.is_none());

        server_task.abort();
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn discover_returns_http_poll_job_after_wakeup() {
        let server = MockServer::start_async().await;
        let run_id: RunId = "00000000-0000-0000-0000-000000000003".parse().unwrap();
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200).json_body(serde_json::json!({
                    "job": {
                        "runId": run_id,
                        "experimentalProfile": "vm0/default"
                    }
                }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let discovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
            .await
            .expect("discover should poll after wakeup")
            .unwrap();

        assert_eq!(discovered.run_id(), run_id);
        assert_eq!(discovered.profile_name(), "vm0/default");
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn discover_defers_job_return_when_target_other_wakeup_arrives_during_poll() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let first_run_id: RunId = "00000000-0000-0000-0000-000000000004".parse().unwrap();
        let second_run_id: RunId = "00000000-0000-0000-0000-000000000005".parse().unwrap();
        let (first_accepted_tx, first_accepted_rx) = tokio::sync::oneshot::channel();
        let (release_first_tx, release_first_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut first_socket, _) = listener.accept().await.unwrap();
            read_http_request(&mut first_socket).await;
            let _ = first_accepted_tx.send(());
            release_first_rx.await.unwrap();
            write_poll_job_response(&mut first_socket, first_run_id).await;
            drop(first_socket);

            let (mut second_socket, _) = listener.accept().await.unwrap();
            read_http_request(&mut second_socket).await;
            write_poll_job_response(&mut second_socket, second_run_id).await;
        });
        let wakeups = Arc::new(PollWakeups::new(false));
        let provider =
            api_provider_for_test(api_url, CancellationToken::new(), Arc::clone(&wakeups));
        let provider_for_discover = Arc::clone(&provider);
        let discover_task = tokio::spawn(async move { provider_for_discover.discover().await });

        tokio::time::timeout(Duration::from_secs(1), first_accepted_rx)
            .await
            .expect("first poll should reach the server")
            .unwrap();
        wakeups
            .request_deferred_poll_after_for_test(Duration::from_millis(10))
            .await;
        release_first_tx.send(()).unwrap();
        tokio::task::yield_now().await;

        tokio::time::sleep(Duration::from_millis(10)).await;
        let discovered = tokio::time::timeout(Duration::from_secs(1), discover_task)
            .await
            .expect("discover should retry after target-other defer")
            .unwrap()
            .unwrap();

        assert_eq!(discovered.run_id(), second_run_id);
        assert_eq!(discovered.profile_name(), "vm0/default");
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn api_client_poll_non_success_includes_status_and_body() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(503).body("poll unavailable");
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api.poll("default", &[], &[]).await.unwrap_err();

        assert_api_error(err, "poll 503 Service Unavailable: poll unavailable");
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_poll_decode_error_keeps_operation_label() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200).body("not json");
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api.poll("default", &[], &[]).await.unwrap_err();

        match err {
            RunnerError::Api(message) => assert!(
                message.starts_with("poll decode: "),
                "unexpected error: {message}"
            ),
            other => panic!("expected RunnerError::Api, got {other:?}"),
        }
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_claim_conflict_or_not_found_is_already_claimed() {
        for status in [409_u16, 404] {
            let server = MockServer::start_async().await;
            let run_id = RunId::nil();
            let path = format!("/api/runners/jobs/{run_id}/claim");
            let mock = server
                .mock_async(|when, then| {
                    when.method(POST).path(path.as_str());
                    then.status(status);
                })
                .await;
            let api = api_client_for_server(&server);

            let err = api.claim(run_id).await.unwrap_err();

            assert!(matches!(err, RunnerError::AlreadyClaimed));
            mock.assert_async().await;
        }
    }

    #[tokio::test]
    async fn api_client_complete_non_success_includes_status_and_body() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path);
                then.status(500).body("complete failed");
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api
            .complete("sandbox-token", RunId::nil(), 1, Some("boom"), None, None)
            .await
            .unwrap_err();

        assert_api_error(err, "complete 500 Internal Server Error: complete failed");
        mock.assert_async().await;
    }
}
