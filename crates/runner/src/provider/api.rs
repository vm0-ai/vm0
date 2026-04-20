//! [`JobProvider`] backed by Ably push notifications + HTTP polling + REST API.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use reqwest::StatusCode;

use super::JobProvider;
use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::ids::RunId;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::types::{CompleteRequest, ExecutionContext, HeartbeatState, Job, PollResponse};

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
    /// Profile names this runner supports (e.g., ["vm0/default"]).
    /// Sent in poll requests so the server only returns jobs this runner can handle.
    profiles: Vec<String>,
    /// Unique runner identity (UUID). Used to filter targeted Ably notifications.
    runner_id: String,
    /// Mutable discovery state, behind Mutex for `&self` compatibility.
    /// Only one caller (main loop) — never contended in practice.
    discovery: tokio::sync::Mutex<DiscoveryState>,
    /// Per-job sandbox tokens for completion auth.
    tokens: tokio::sync::Mutex<HashMap<RunId, String>>,
    /// Shared map of per-job cancel tokens. When a `"cancel"` event arrives
    /// via Ably, `discover()` looks up the run and cancels it directly.
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    /// Session IDs held in the idle pool, sent in poll requests for affinity ordering.
    held_sessions: tokio::sync::Mutex<Vec<String>>,
    /// Shutdown signal.
    cancel: CancellationToken,
}

struct DiscoveryState {
    ably: Option<ably_subscriber::Subscription>,
    ably_retry: RetryState<AblyReconnectHandle>,
    ably_connected: bool,
    poll_now: bool,
    /// When set, schedules a deferred poll so non-targeted runners can pick up
    /// jobs that the targeted runner may not have claimed.
    deferred_poll_at: Option<tokio::time::Instant>,
}

type AblyReconnectHandle =
    tokio::task::JoinHandle<Result<ably_subscriber::Subscription, ably_subscriber::Error>>;

impl ApiProvider {
    /// Create a new API-backed provider with initial Ably connection attempt.
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
            profiles,
            runner_id,
            discovery: tokio::sync::Mutex::new(DiscoveryState {
                ably,
                ably_retry,
                ably_connected,
                poll_now: true, // immediate first poll
                deferred_poll_at: None,
            }),
            tokens: tokio::sync::Mutex::new(HashMap::new()),
            cancel_tokens,
            held_sessions: tokio::sync::Mutex::new(Vec::new()),
            cancel,
        })
    }
}

#[async_trait::async_trait]
impl JobProvider for ApiProvider {
    async fn discover(&self) -> Option<(RunId, String)> {
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
                ref mut deferred_poll_at,
            } = *state;

            // Spawn Ably reconnection when timer fires
            maybe_spawn_ably_reconnect(ably, &self.api, &self.group, ably_retry);

            let sleep_dur = if *poll_now {
                Duration::ZERO
            } else if let Some(at) = *deferred_poll_at {
                at.saturating_duration_since(tokio::time::Instant::now())
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
                            if let Some(run_id) = parse_cancel_notification(&msg) {
                                if let Some(token) = self.cancel_tokens.lock().await.get(&run_id) {
                                    info!(run_id = %run_id, "ably: cancel notification, killing job");
                                    token.cancel();
                                }
                                continue;
                            }
                            if let Some(notif) = parse_job_notification(&msg) {
                                // Targeted to another runner: defer poll instead of
                                // claiming immediately, giving the target a 2s head start.
                                if notif.target_runner_id.as_deref().is_some_and(|t| t != self.runner_id) {
                                    info!(
                                        run_id = %notif.run_id,
                                        target = notif.target_runner_id.as_deref().unwrap_or(""),
                                        "ably: job targeted to another runner, deferring poll"
                                    );
                                    // Only set if no deferred poll is already pending,
                                    // to avoid pushing the deadline further on rapid bursts.
                                    if deferred_poll_at.is_none() {
                                        *deferred_poll_at = Some(
                                            tokio::time::Instant::now() + Duration::from_secs(2)
                                        );
                                    }
                                    continue;
                                }
                                // Fall back to default profile when server doesn't send one
                                // (backwards compat with pre-profile API).
                                let profile = notif.profile.unwrap_or_else(|| crate::profile::DEFAULT_PROFILE.to_owned());
                                let targeted = notif.target_runner_id.as_deref().is_some_and(|t| t == self.runner_id);
                                info!(run_id = %notif.run_id, %profile, targeted, "ably: job notification");
                                return Some((notif.run_id, profile));
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
                    *deferred_poll_at = None;
                    let sessions = self.held_sessions.lock().await.clone();
                    match self.api.poll(&self.group, &self.profiles, &sessions).await {
                        Ok(Some(job)) => {
                            // Fall back to default profile when server doesn't send one
                            // (backwards compat with pre-profile API).
                            let profile = job.experimental_profile.unwrap_or_else(|| crate::profile::DEFAULT_PROFILE.to_owned());
                            info!(run_id = %job.run_id, %profile, "poll: job found");
                            *poll_now = true;
                            return Some((job.run_id, profile));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            error!(error = %e, "poll failed");
                        }
                    }
                }
                // Ably reconnection result
                result = recv_retry(&mut ably_retry.handle) => {
                    handle_ably_reconnect_result(result, ably, ably_connected, ably_retry);
                }
                // Ably retry timer
                () = sleep_until_retry(&ably_retry.restart_at) => {}
            }
        }
    }

    async fn claim(&self, run_id: RunId) -> Option<ExecutionContext> {
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

    /// # Ordering requirement
    ///
    /// `discover()` holds the discovery Mutex for its entire loop.
    /// The caller must ensure the `discover()` future is no longer
    /// alive before calling `shutdown()`. Two paths accomplish this:
    ///
    /// 1. `discover()` observes the cancelled token and returns `None`,
    ///    releasing the lock naturally.
    /// 2. The main loop breaks (e.g. on `Draining` mode) and explicitly
    ///    drops the pinned future, which releases the lock.
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

    async fn complete(&self, run_id: RunId, exit_code: i32, error: Option<&str>) {
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

/// Parsed job notification from Ably.
struct JobNotification {
    run_id: RunId,
    profile: Option<String>,
    target_runner_id: Option<String>,
}

fn parse_cancel_notification(msg: &ably_subscriber::Message) -> Option<RunId> {
    if msg.name.as_deref() != Some("cancel") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str())?;
    match raw.parse() {
        Ok(id) => Some(id),
        Err(e) => {
            warn!(value = %raw, error = %e, "ably: invalid cancel runId");
            None
        }
    }
}

fn parse_job_notification(msg: &ably_subscriber::Message) -> Option<JobNotification> {
    if msg.name.as_deref() != Some("job") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str());
    let run_id = match raw {
        Some(s) => match s.parse() {
            Ok(id) => id,
            Err(e) => {
                warn!(value = %s, error = %e, "ably: invalid runId");
                return None;
            }
        },
        None => {
            warn!(data = %msg.data, "ably: job message missing runId");
            return None;
        }
    };
    let profile = msg
        .data
        .get("profile")
        .and_then(|v| v.as_str())
        .map(String::from);
    let target_runner_id = msg
        .data
        .get("targetRunnerId")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(JobNotification {
        run_id,
        profile,
        target_runner_id,
    })
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
        let resp = self
            .http
            .request(reqwest::Method::POST, "/api/runners/poll", &self.token)
            .json(&body)
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

    /// Send a heartbeat with runner state. Uses a short timeout (3s) to
    /// avoid blocking the main loop.
    async fn heartbeat(&self, state: &HeartbeatState) -> RunnerResult<()> {
        let resp = self
            .http
            .request(reqwest::Method::POST, "/api/runners/heartbeat", &self.token)
            .timeout(Duration::from_secs(3))
            .json(state)
            .send()
            .await
            .map_err(|e| RunnerError::Api(format!("heartbeat: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(RunnerError::Api(format!("heartbeat {status}: {body}")));
        }

        Ok(())
    }

    /// Claim a job for execution. Returns [`RunnerError::AlreadyClaimed`] on
    /// HTTP 409 so callers can continue gracefully.
    async fn claim(&self, run_id: RunId) -> RunnerResult<ExecutionContext> {
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let resp = self
            .http
            .request(reqwest::Method::POST, &path, &self.token)
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
        run_id: RunId,
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
                reqwest::Method::POST,
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
                reqwest::Method::POST,
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
    fn parse_job_notification_valid() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        let notif = parse_job_notification(&msg).unwrap();
        assert_eq!(
            notif.run_id.to_string(),
            "00000000-0000-0000-0000-000000000001"
        );
        assert!(notif.profile.is_none());
    }

    #[test]
    fn parse_job_notification_with_profile() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001", "profile": "vm0/default" }),
        );
        let notif = parse_job_notification(&msg).unwrap();
        assert_eq!(
            notif.run_id.to_string(),
            "00000000-0000-0000-0000-000000000001"
        );
        assert_eq!(notif.profile.as_deref(), Some("vm0/default"));
    }

    #[test]
    fn parse_job_notification_wrong_event_name() {
        let msg = make_message(
            Some("status"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        assert!(parse_job_notification(&msg).is_none());
    }

    #[test]
    fn parse_job_notification_missing_name() {
        let msg = make_message(
            None,
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        assert!(parse_job_notification(&msg).is_none());
    }

    #[test]
    fn parse_job_notification_invalid_uuid() {
        let msg = make_message(Some("job"), serde_json::json!({ "runId": "not-a-uuid" }));
        assert!(parse_job_notification(&msg).is_none());
    }

    #[test]
    fn parse_job_notification_missing_field() {
        let msg = make_message(Some("job"), serde_json::json!({ "other": "data" }));
        assert!(parse_job_notification(&msg).is_none());
    }

    #[test]
    fn parse_cancel_notification_valid() {
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000002" }),
        );
        let run_id = parse_cancel_notification(&msg).unwrap();
        assert_eq!(run_id.to_string(), "00000000-0000-0000-0000-000000000002");
    }

    #[test]
    fn parse_cancel_notification_wrong_event_name() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000002" }),
        );
        assert!(parse_cancel_notification(&msg).is_none());
    }

    #[test]
    fn parse_cancel_notification_missing_name() {
        let msg = make_message(
            None,
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000002" }),
        );
        assert!(parse_cancel_notification(&msg).is_none());
    }

    #[test]
    fn parse_cancel_notification_invalid_uuid() {
        let msg = make_message(Some("cancel"), serde_json::json!({ "runId": "not-a-uuid" }));
        assert!(parse_cancel_notification(&msg).is_none());
    }

    #[test]
    fn parse_cancel_notification_missing_field() {
        let msg = make_message(Some("cancel"), serde_json::json!({ "other": "data" }));
        assert!(parse_cancel_notification(&msg).is_none());
    }

    #[test]
    fn parse_job_notification_with_target_runner_id() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/default",
                "targetRunnerId": "00000000-0000-0000-0000-000000000099"
            }),
        );
        let notif = parse_job_notification(&msg).unwrap();
        assert_eq!(
            notif.target_runner_id.as_deref(),
            Some("00000000-0000-0000-0000-000000000099")
        );
    }

    #[test]
    fn parse_job_notification_without_target_runner_id() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        let notif = parse_job_notification(&msg).unwrap();
        assert!(notif.target_runner_id.is_none());
    }
}
