//! [`JobProvider`] backed by Ably push notifications + HTTP polling + REST API.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use uuid::Uuid;

use reqeast::StatusCode;

use super::JobProvider;
use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::retry::RetryState;
use crate::types::{CompleteRequest, ExecutionContext, Job, PollResponse};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Poll interval when Ably is connected (safety net).
const POLL_SLOW: Duration = Duration::from_secs(30);
/// Poll interval when Ably is disconnected or unavailable (primary mechanism).
const POLL_FAST: Duration = Duration::from_secs(5);
/// Initial backoff before retrying Ably connection.
const ABLY_BACKOFF_INITIAL: Duration = Duration::from_secs(5);
/// Maximum backoff between Ably reconnection attempts.
const ABLY_BACKOFF_MAX: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// ApiProvider
// ---------------------------------------------------------------------------

/// [`JobProvider`] backed by Ably push notifications + HTTP polling + REST API.
///
/// This wraps the current production job lifecycle:
/// - **Discovery**: Ably push + HTTP poll fallback (adaptive interval)
/// - **Claim**: `POST /api/runners/jobs/{id}/claim`
/// - **Complete**: `POST /api/webhooks/agent/complete` with per-job sandbox token
pub struct ApiProvider {
    api: ApiClient,
    group: String,
    /// Mutable discovery state, behind Mutex for `&self` compatibility.
    /// Only one caller (main loop) — never contended in practice.
    discovery: tokio::sync::Mutex<DiscoveryState>,
    /// Per-job sandbox tokens for completion auth.
    tokens: tokio::sync::Mutex<HashMap<Uuid, String>>,
    /// Shutdown signal.
    cancel: CancellationToken,
}

struct DiscoveryState {
    ably: Option<ably_subscriber::Subscription>,
    ably_retry: RetryState<AblyReconnectHandle>,
    ably_connected: bool,
    poll_now: bool,
}

type AblyReconnectHandle =
    tokio::task::JoinHandle<Result<ably_subscriber::Subscription, ably_subscriber::Error>>;

impl ApiProvider {
    /// Create a new API-backed provider with initial Ably connection attempt.
    pub async fn new(
        http: HttpClient,
        token: String,
        group: String,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        let api = ApiClient::new(http, token);
        let mut ably_retry: RetryState<AblyReconnectHandle> =
            RetryState::new(ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX, None);

        let ably_config = make_ably_config(&api, &group);
        let (ably, ably_connected) = match ably_subscriber::subscribe(ably_config).await {
            Ok(sub) => {
                info!("ably connected");
                (Some(sub), true)
            }
            Err(e) => {
                warn!(error = %e, "ably unavailable, will retry");
                ably_retry.record_initial_failure();
                (None, false)
            }
        };

        Arc::new(Self {
            api,
            group,
            discovery: tokio::sync::Mutex::new(DiscoveryState {
                ably,
                ably_retry,
                ably_connected,
                poll_now: true, // immediate first poll
            }),
            tokens: tokio::sync::Mutex::new(HashMap::new()),
            cancel,
        })
    }
}

#[async_trait::async_trait]
impl JobProvider for ApiProvider {
    async fn discover(&self) -> Option<Uuid> {
        let mut state = self.discovery.lock().await;
        loop {
            // Check shutdown
            if self.cancel.is_cancelled() {
                return None;
            }

            // Destructure to get disjoint borrows for tokio::select!
            let DiscoveryState {
                ref mut ably,
                ref mut ably_retry,
                ref mut ably_connected,
                ref mut poll_now,
            } = *state;

            // Spawn Ably reconnection when timer fires
            maybe_spawn_ably_reconnect(ably, &self.api, &self.group, ably_retry);

            let sleep_dur = if *poll_now {
                Duration::ZERO
            } else if *ably_connected {
                POLL_SLOW
            } else {
                POLL_FAST
            };

            tokio::select! {
                // Shutdown
                () = self.cancel.cancelled() => {
                    return None;
                }
                // Ably push notification
                event = recv_ably(ably) => {
                    match event {
                        Some(ably_subscriber::Event::Message(msg)) => {
                            if let Some(run_id) = parse_job_run_id(&msg) {
                                info!(run_id = %run_id, "ably: job notification");
                                return Some(run_id);
                            }
                        }
                        Some(ably_subscriber::Event::Connected) => {
                            if !*ably_connected {
                                *ably_connected = true;
                                info!("ably reconnected");
                            }
                        }
                        Some(ably_subscriber::Event::Disconnected { reason }) => {
                            *ably_connected = false;
                            warn!(
                                reason = reason.as_deref().unwrap_or("unknown"),
                                "ably disconnected, switching to fast poll"
                            );
                        }
                        Some(ably_subscriber::Event::Error { code, message }) => {
                            error!(code, message = %message, "ably fatal error, will reconnect");
                            *ably = None;
                            *ably_connected = false;
                            ably_retry.schedule();
                        }
                        None => {
                            warn!("ably subscription closed, will reconnect");
                            *ably = None;
                            *ably_connected = false;
                            ably_retry.schedule();
                        }
                    }
                    continue;
                }
                // Poll fallback (adaptive interval)
                () = tokio::time::sleep(sleep_dur) => {
                    *poll_now = false;
                    match self.api.poll(&self.group).await {
                        Ok(Some(job)) => {
                            info!(run_id = %job.run_id, "poll: job found");
                            *poll_now = true;
                            return Some(job.run_id);
                        }
                        Ok(None) => {}
                        Err(e) => {
                            error!(error = %e, "poll failed");
                        }
                    }
                }
                // Ably reconnection result
                result = crate::retry::recv_retry(&mut ably_retry.handle) => {
                    handle_ably_reconnect_result(result, ably, ably_connected, ably_retry);
                }
                // Ably retry timer
                () = crate::retry::sleep_until_retry(&ably_retry.restart_at) => {}
            }
        }
    }

    async fn claim(&self, run_id: Uuid) -> Option<ExecutionContext> {
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

    /// # Ordering requirement
    ///
    /// `discover()` holds the discovery Mutex for its entire loop.
    /// Callers must cancel the `CancellationToken` *before* calling
    /// `shutdown()` so that `discover()` observes the cancellation,
    /// returns `None`, and releases the lock. The main loop in
    /// `start.rs` guarantees this: the signal handler cancels the
    /// token, `discover()` returns `None` breaking the loop, and
    /// then `shutdown()` is called.
    async fn shutdown(&self) {
        let mut state = self.discovery.lock().await;
        // Drop Ably subscription to close WebSocket
        state.ably = None;
        state.ably_connected = false;
        // Abort in-flight reconnection task
        if let Some(h) = state.ably_retry.handle.take() {
            h.abort();
        }
    }

    async fn complete(&self, run_id: Uuid, exit_code: i32, error: Option<&str>) {
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

        if let Err(e) = self.api.complete(&token, run_id, exit_code, error).await {
            warn!(run_id = %run_id, error = %e, "completion report failed, retrying");
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Err(e) = self.api.complete(&token, run_id, exit_code, error).await {
                error!(run_id = %run_id, error = %e, "failed to report completion after retry");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Ably helpers (private)
// ---------------------------------------------------------------------------

/// Parse `run_id` from an Ably job notification message.
fn parse_job_run_id(msg: &ably_subscriber::Message) -> Option<Uuid> {
    if msg.name.as_deref() != Some("job") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str());
    match raw {
        Some(s) => match s.parse() {
            Ok(id) => Some(id),
            Err(e) => {
                warn!(value = %s, error = %e, "ably: invalid runId");
                None
            }
        },
        None => {
            warn!(data = %msg.data, "ably: job message missing runId");
            None
        }
    }
}

/// Receive from Ably subscription, or pend forever if not connected.
async fn recv_ably(
    ably: &mut Option<ably_subscriber::Subscription>,
) -> Option<ably_subscriber::Event> {
    match ably {
        Some(sub) => sub.next().await,
        None => std::future::pending().await,
    }
}

/// Create a fresh `SubscribeConfig` for Ably connection.
///
/// `SubscribeConfig` is consumed by `subscribe()` and is not `Clone`,
/// so we recreate it for each connection attempt.
fn make_ably_config(api: &ApiClient, group: &str) -> ably_subscriber::SubscribeConfig {
    let api = api.clone();
    let channel = format!("runner-group:{group}");
    let group = group.to_owned();
    let get_token: Box<dyn Fn() -> ably_subscriber::TokenFuture + Send + Sync> =
        Box::new(move || {
            let api = api.clone();
            let group = group.clone();
            Box::pin(async move {
                api.realtime_token(&group)
                    .await
                    .map_err(|e| Box::new(e) as ably_subscriber::BoxError)
            })
        });
    ably_subscriber::SubscribeConfig::new(get_token, channel)
}

/// Handle the result of a background Ably reconnection task.
fn handle_ably_reconnect_result(
    result: Result<ably_subscriber::Subscription, String>,
    ably: &mut Option<ably_subscriber::Subscription>,
    ably_connected: &mut bool,
    retry: &mut RetryState<AblyReconnectHandle>,
) {
    match result {
        Ok(sub) => {
            if retry.consecutive_failures() > 0 {
                info!(
                    attempts = retry.consecutive_failures(),
                    "ably reconnected after failures"
                );
            } else {
                info!("ably reconnected");
            }
            *ably = Some(sub);
            *ably_connected = true;
            retry.on_success();
        }
        Err(e) => {
            // Capture before on_failure() — matches the delay actually scheduled.
            let next_secs = retry.backoff().as_secs();
            // Ably retries forever (max_failures = None), so this always returns true.
            let _ = retry.on_failure();
            if retry.consecutive_failures() >= 10 {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    next_attempt_secs = next_secs,
                    "ably reconnection failing persistently"
                );
            } else {
                warn!(error = %e, next_attempt_secs = next_secs, "ably reconnect failed");
            }
        }
    }
}

/// Spawn a background Ably reconnection task when the timer fires.
fn maybe_spawn_ably_reconnect(
    ably: &mut Option<ably_subscriber::Subscription>,
    api: &ApiClient,
    group: &str,
    retry: &mut RetryState<AblyReconnectHandle>,
) {
    if ably.is_some() || !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    let ably_config = make_ably_config(api, group);
    retry.handle = Some(tokio::spawn(ably_subscriber::subscribe(ably_config)));
}

// ---------------------------------------------------------------------------
// ApiClient (HTTP transport)
// ---------------------------------------------------------------------------

/// Low-level HTTP client for the vm0 runner API endpoints.
#[derive(Clone)]
struct ApiClient {
    http: HttpClient,
    token: String,
}

impl ApiClient {
    fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }

    /// Poll for a pending job. Returns `Ok(None)` when no work is available.
    async fn poll(&self, group: &str) -> RunnerResult<Option<Job>> {
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
    async fn claim(&self, run_id: Uuid) -> RunnerResult<ExecutionContext> {
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
    async fn complete(
        &self,
        sandbox_token: &str,
        run_id: Uuid,
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
    async fn realtime_token(&self, group: &str) -> RunnerResult<ably_subscriber::TokenRequest> {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_message(name: Option<&str>, data: serde_json::Value) -> ably_subscriber::Message {
        ably_subscriber::Message {
            name: name.map(String::from),
            data,
            id: None,
            client_id: None,
            timestamp: None,
        }
    }

    #[test]
    fn parse_job_run_id_valid() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        let id = parse_job_run_id(&msg).unwrap();
        assert_eq!(id.to_string(), "00000000-0000-0000-0000-000000000001");
    }

    #[test]
    fn parse_job_run_id_wrong_event_name() {
        let msg = make_message(
            Some("status"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        assert!(parse_job_run_id(&msg).is_none());
    }

    #[test]
    fn parse_job_run_id_missing_name() {
        let msg = make_message(
            None,
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        assert!(parse_job_run_id(&msg).is_none());
    }

    #[test]
    fn parse_job_run_id_invalid_uuid() {
        let msg = make_message(Some("job"), serde_json::json!({ "runId": "not-a-uuid" }));
        assert!(parse_job_run_id(&msg).is_none());
    }

    #[test]
    fn parse_job_run_id_missing_field() {
        let msg = make_message(Some("job"), serde_json::json!({ "other": "data" }));
        assert!(parse_job_run_id(&msg).is_none());
    }
}
