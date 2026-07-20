//! [`JobProvider`] backed by an Ably control plane + HTTP polling + REST API.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use api_contracts::generated::routes;
use reqwest::{Response, StatusCode};
use serde::{Serialize, de::DeserializeOwned};

use super::api_ably_supervisor::{
    AblySupervisor, AblySupervisorConfig, PollDue, PollOutcome, PollReason, PollWakeups,
};
use super::api_direct_candidates::{
    DIRECT_CANDIDATE_STALE_AFTER, DirectCandidateInbox, DirectCandidatePruneSnapshot,
    DirectJobCandidate,
};
use super::builtin_firewall_catalog::{
    BuiltinFirewallCatalog, BuiltinFirewallCatalogRefreshController,
};
use super::network_policy_refresh::NetworkPolicyRefreshHandle;
use super::{
    ClaimedJob, CompletionAuth, CompletionAuthError, JobCandidate, JobDiscoverySource, JobProvider,
};
use crate::duration::duration_ms;
use crate::error::{ApiStatusError, RunnerError, RunnerResult};
use crate::http::{ApiRequestBuilder, HttpClient};
use crate::ids::RunId;
use crate::run_cancellation::SharedRunCancellationMap;
use crate::types::{
    CompleteRequest, ExecutionContext, HeartbeatState, Job, NetworkPolicyRefreshBatchResponse,
    PollResponse, SandboxReuseResult,
};
use sandbox::SandboxId;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequestBody {
    telemetry: ClaimRequestTelemetry,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequestTelemetry {
    #[serde(skip_serializing_if = "Option::is_none")]
    discovery_source: Option<&'static str>,
    job_discovered_to_claim_request_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_admission_to_claim_request_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_candidate_notification_to_enqueue_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_candidate_inbox_wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_discovery_to_main_loop_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    main_loop_to_local_admission_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_due_to_job_discovered_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_http_request_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_reason: Option<String>,
}

const CLAIM_TELEMETRY_DURATION_MS_MAX: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct PollApiResult {
    job: Option<Job>,
    http_request_elapsed: Duration,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Poll interval when Ably is connected (safety net).
const POLL_SLOW: Duration = Duration::from_secs(30);
/// Poll interval when Ably is disconnected or unavailable (primary mechanism).
const POLL_FAST: Duration = Duration::from_secs(5);
/// Retry delay after a job-notification wakeup reaches poll but poll fails.
const POLL_WAKEUP_RETRY: Duration = POLL_FAST;
const DIRECT_CANDIDATE_INBOX_CAPACITY: usize = 128;
const NETWORK_POLICY_REFRESH_TIMEOUT: Duration = Duration::from_secs(3);
const BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

enum DiscoveryWakeup {
    Direct(DirectJobCandidate),
    Poll(PollDue),
}

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
    runner_id: String,
    group: String,
    /// Profile names this runner supports (e.g., ["vm0/default"]).
    /// Sent in poll requests so the server only returns jobs this runner can handle.
    supported_profiles: Vec<String>,
    /// Coalesced poll wakeup state updated by the Ably supervisor.
    poll_wakeups: Arc<PollWakeups>,
    /// Supported direct job candidates delivered by Ably notifications.
    direct_candidates: Arc<DirectCandidateInbox>,
    /// Background Ably control-plane task.
    ably_supervisor: Mutex<Option<AblySupervisor>>,
    cancel_tokens: SharedRunCancellationMap,
    network_policy_refresh: NetworkPolicyRefreshHandle,
    builtin_firewall_catalog_refresh: BuiltinFirewallCatalogRefreshController,
    /// Shutdown signal.
    cancel: CancellationToken,
}

pub struct BuiltinFirewallCatalogCachePaths {
    pub cache_path: PathBuf,
    pub lock_path: PathBuf,
}

pub struct ApiProviderConfig {
    pub runner_id: String,
    pub group: String,
    pub supported_profiles: Vec<String>,
}

impl ApiProvider {
    /// Create a new API-backed provider.
    pub fn new(
        http: HttpClient,
        token: String,
        config: ApiProviderConfig,
        builtin_firewall_catalog_cache_paths: BuiltinFirewallCatalogCachePaths,
        cancel: CancellationToken,
        cancel_tokens: SharedRunCancellationMap,
    ) -> Arc<Self> {
        let ApiProviderConfig {
            runner_id,
            group,
            supported_profiles,
        } = config;
        let api = ApiClient::new(http, token);
        let network_policy_refresh = NetworkPolicyRefreshHandle::new(api.clone());
        let builtin_firewall_catalog_refresh = BuiltinFirewallCatalogRefreshController::new(
            api.clone(),
            builtin_firewall_catalog_cache_paths.cache_path,
            builtin_firewall_catalog_cache_paths.lock_path,
            cancel.clone(),
        );
        let poll_wakeups = Arc::new(PollWakeups::new(false));
        let direct_candidates = DirectCandidateInbox::new(
            DIRECT_CANDIDATE_INBOX_CAPACITY,
            DIRECT_CANDIDATE_STALE_AFTER,
        );

        Arc::new(Self {
            api,
            runner_id,
            group,
            supported_profiles,
            poll_wakeups,
            direct_candidates,
            ably_supervisor: Mutex::new(None),
            cancel_tokens,
            network_policy_refresh,
            builtin_firewall_catalog_refresh,
            cancel,
        })
    }

    pub(crate) fn network_policy_refresh_handle(&self) -> NetworkPolicyRefreshHandle {
        self.network_policy_refresh.clone()
    }

    async fn try_recv_direct_candidate(&self) -> Option<DirectJobCandidate> {
        let outcome = self.direct_candidates.try_pop_with_prune().await;
        if let Some(pruned) = outcome.pruned {
            Self::log_direct_candidate_pruned("pop", pruned);
            if outcome.candidate.is_none() {
                self.poll_wakeups.request_immediate_poll().await;
            }
        }
        outcome.candidate
    }

    async fn wait_for_direct_candidate(&self) -> Option<DirectJobCandidate> {
        loop {
            if let Some(candidate) = self.try_recv_direct_candidate().await {
                return Some(candidate);
            }
            if !self
                .direct_candidates
                .wait_for_notification(&self.cancel)
                .await
            {
                return None;
            }
        }
    }

    fn log_direct_candidate_pruned(source: &'static str, pruned: DirectCandidatePruneSnapshot) {
        info!(
            source,
            pruned_count = pruned.pruned_count,
            depth = pruned.depth,
            capacity = pruned.capacity,
            stale_after_ms = duration_ms(pruned.stale_after),
            oldest_pruned_wait_ms = duration_ms(pruned.oldest_pruned_wait_elapsed),
            "ably: stale direct candidates pruned"
        );
    }

    async fn wait_for_discovery_wakeup(&self) -> Option<DiscoveryWakeup> {
        loop {
            if let Some(candidate) = self.try_recv_direct_candidate().await {
                return Some(DiscoveryWakeup::Direct(candidate));
            }

            tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    return None;
                }
                candidate = self.wait_for_direct_candidate() => {
                    if let Some(candidate) = candidate {
                        return Some(DiscoveryWakeup::Direct(candidate));
                    }
                }
                due = self.poll_wakeups.wait_for_poll_due(&self.cancel, POLL_SLOW, POLL_FAST) => {
                    return due.map(DiscoveryWakeup::Poll);
                }
            }
        }
    }

    async fn ensure_ably_supervisor_started(&self) {
        let mut ably_supervisor = self.ably_supervisor.lock().await;
        if ably_supervisor.is_some() {
            return;
        }

        *ably_supervisor = Some(AblySupervisor::spawn(AblySupervisorConfig {
            api: self.api.clone(),
            group: self.group.clone(),
            profiles: self.supported_profiles.clone(),
            poll_wakeups: Arc::clone(&self.poll_wakeups),
            direct_candidates: Arc::clone(&self.direct_candidates),
            cancel_tokens: Arc::clone(&self.cancel_tokens),
            network_policy_refresh: self.network_policy_refresh.clone(),
            provider_cancel: self.cancel.clone(),
        }));
    }
}

#[async_trait::async_trait]
impl JobProvider for ApiProvider {
    async fn prepare_startup_readiness(&self) -> RunnerResult<()> {
        self.builtin_firewall_catalog_refresh
            .prepare_startup_readiness()
            .await?;
        if self.cancel.is_cancelled() {
            return Err(RunnerError::Internal(
                "provider startup readiness cancelled".to_string(),
            ));
        }
        self.ensure_ably_supervisor_started().await;
        Ok(())
    }

    async fn discover(&self) -> Option<JobCandidate> {
        loop {
            let due = match self.wait_for_discovery_wakeup().await? {
                DiscoveryWakeup::Direct(direct) => {
                    let run_id = direct.run_id();
                    let profile = direct.profile_name().to_owned();
                    info!(
                        run_id = %run_id,
                        profile = %profile,
                        "ably: direct job candidate discovered"
                    );
                    let mut candidate = direct.into_job_candidate();
                    candidate.mark_provider_discovery_returned();
                    return Some(candidate);
                }
                DiscoveryWakeup::Poll(due) => due,
            };
            let reason = due.reason();
            let poll_due_started_at = Instant::now();

            let poll_result = tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    return None;
                }
                direct = self.wait_for_direct_candidate() => {
                    if let Some(direct) = direct {
                        self.poll_wakeups.request_immediate_poll().await;
                        let run_id = direct.run_id();
                        let profile = direct.profile_name().to_owned();
                        info!(
                            run_id = %run_id,
                            profile = %profile,
                            poll_reason = ?reason,
                            "ably: direct job candidate interrupted poll"
                        );
                        let mut candidate = direct.into_job_candidate();
                        candidate.mark_provider_discovery_returned();
                        return Some(candidate);
                    }
                    return None;
                }
                result = self.api.poll(
                    &self.runner_id,
                    &self.group,
                    &self.supported_profiles,
                    reason,
                ) => result,
            };

            match poll_result {
                Ok(PollApiResult {
                    job: Some(job),
                    http_request_elapsed,
                }) => {
                    let record = self
                        .poll_wakeups
                        .record_poll_result(due, PollOutcome::JobFound, POLL_WAKEUP_RETRY)
                        .await;
                    if record.defer_job_return() {
                        info!(
                            run_id = %job.run_id,
                            poll_reason = ?reason,
                            "poll: job found while deferred poll arrived, retrying after defer"
                        );
                        continue;
                    }
                    if self.cancel.is_cancelled() {
                        return None;
                    }
                    // Fall back to default profile when server doesn't send one
                    // (backwards compat with pre-profile API).
                    let run_id = job.run_id;
                    let cli_agent_session_id = job.cli_agent_session_id;
                    let history_generation_run_id = job.history_generation_run_id;
                    let history_generation_affinity_protected_until =
                        job.history_generation_affinity_protected_until;
                    let affinity_protected_until = job.affinity_protected_until;
                    let session_affinity_resource = job.session_affinity_resource;
                    let profile = job
                        .experimental_profile
                        .unwrap_or_else(|| crate::profile::DEFAULT_PROFILE.to_owned());
                    info!(run_id = %run_id, %profile, poll_reason = ?reason, "poll: job found");
                    let mut candidate = JobCandidate::new(run_id, profile)
                        .with_affinity_metadata(cli_agent_session_id, affinity_protected_until)
                        .with_session_affinity_resource(session_affinity_resource)
                        .with_history_generation_run_id(history_generation_run_id)
                        .with_history_generation_affinity_protected_until(
                            history_generation_affinity_protected_until,
                        )
                        .with_discovery_source(JobDiscoverySource::Poll)
                        .with_poll_reason(poll_reason_value(reason))
                        .with_poll_timing(poll_due_started_at.elapsed(), http_request_elapsed);
                    candidate.mark_provider_discovery_returned();
                    return Some(candidate);
                }
                Ok(PollApiResult { job: None, .. }) => {
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

    async fn try_discover_ready(&self) -> Option<JobCandidate> {
        let direct = self.try_recv_direct_candidate().await?;
        let run_id = direct.run_id();
        let profile = direct.profile_name().to_owned();
        info!(
            run_id = %run_id,
            profile = %profile,
            "ably: ready direct job candidate drained"
        );
        let mut candidate = direct.into_job_candidate();
        candidate.mark_provider_discovery_returned();
        Some(candidate)
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        let run_id = candidate.run_id();
        match self.api.claim(&candidate).await {
            Ok(ctx) => {
                let claimed = match ClaimedJob::api(run_id, ctx) {
                    Ok(claimed) => claimed,
                    Err(err) => {
                        error!(
                            run_id = %err.expected_run_id,
                            context_run_id = %err.context_run_id,
                            "claim response run_id mismatch"
                        );
                        return None;
                    }
                };
                info!(run_id = %run_id, "job claimed");
                Some(claimed)
            }
            Err(RunnerError::AlreadyClaimed) => {
                info!(run_id = %run_id, "already claimed, skipping");
                None
            }
            Err(e) => {
                error!(run_id = %run_id, error = %e, "claim failed");
                self.poll_wakeups.request_immediate_poll().await;
                None
            }
        }
    }

    async fn heartbeat(&self, state: &HeartbeatState) {
        if let Err(e) = self.api.heartbeat(state).await {
            log_heartbeat_failure(state, &e);
        }
    }

    async fn defer_poll_after(&self, delay: Duration) {
        self.poll_wakeups.request_deferred_poll_after(delay).await;
    }

    async fn shutdown(&self) {
        let ably_supervisor = self.ably_supervisor.lock().await.take();
        if let Some(ably_supervisor) = ably_supervisor {
            ably_supervisor.shutdown().await;
        }
        self.network_policy_refresh.shutdown().await;
        self.builtin_firewall_catalog_refresh.shutdown().await;
    }

    async fn complete(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        sandbox_id: Option<SandboxId>,
        reuse_result: Option<SandboxReuseResult>,
        completion_auth: CompletionAuth,
    ) {
        let token = match completion_auth.into_sandbox_token(run_id) {
            Ok(token) => token,
            Err(CompletionAuthError::NotSandbox) => {
                error!(run_id = %run_id, "completion auth missing sandbox token");
                return;
            }
            Err(CompletionAuthError::RunIdMismatch { auth_run_id }) => {
                error!(
                    run_id = %run_id,
                    auth_run_id = %auth_run_id,
                    "completion auth run_id mismatch"
                );
                return;
            }
        };

        const MAX_ATTEMPTS: usize = 2;
        const RETRY_DELAY: Duration = Duration::from_secs(2);

        for attempt in 1..=MAX_ATTEMPTS {
            match self
                .api
                .complete(&token, run_id, exit_code, error, sandbox_id, reuse_result)
                .await
            {
                Ok(()) => return,
                Err(e) => {
                    let (retryable, status, failure_kind) = match &e {
                        RunnerError::ApiStatus(api_error) => {
                            let status = api_error.status;
                            (
                                matches!(
                                    status,
                                    StatusCode::REQUEST_TIMEOUT
                                        | StatusCode::MISDIRECTED_REQUEST
                                        | StatusCode::TOO_EARLY
                                        | StatusCode::TOO_MANY_REQUESTS
                                ) || status.is_server_error(),
                                api_error.status.as_str(),
                                "http_status",
                            )
                        }
                        RunnerError::ApiTransport(api_error) => {
                            (true, "", api_error.failure_kind.as_str())
                        }
                        _ => (false, "", "local"),
                    };
                    let will_retry = retryable && attempt < MAX_ATTEMPTS;

                    if will_retry {
                        warn!(
                            run_id = %run_id,
                            error = %e,
                            attempt,
                            max_attempts = MAX_ATTEMPTS,
                            will_retry,
                            status,
                            failure_kind,
                            "completion report failed, retrying"
                        );
                        tokio::time::sleep(RETRY_DELAY).await;
                        continue;
                    }

                    if attempt > 1 {
                        error!(
                            run_id = %run_id,
                            error = %e,
                            attempt,
                            max_attempts = MAX_ATTEMPTS,
                            will_retry,
                            status,
                            failure_kind,
                            "failed to report completion after retry"
                        );
                    } else {
                        error!(
                            run_id = %run_id,
                            error = %e,
                            attempt,
                            max_attempts = MAX_ATTEMPTS,
                            will_retry,
                            status,
                            failure_kind,
                            "failed to report completion"
                        );
                    }
                    return;
                }
            }
        }
    }
}

fn log_heartbeat_failure(state: &HeartbeatState, error: &RunnerError) {
    let sessions = state.held_session_states.len();
    if let RunnerError::ApiTransport(api_error) = error {
        let request = &api_error.request;
        warn!(
            error = %error,
            endpoint = request.endpoint_label,
            method = %request.method,
            host = %request.host,
            path = %request.path,
            client_request_id = %request.client_request_id,
            client_session_id = %request.client_session_id,
            client_version = %request.client_version,
            failure_kind = api_error.failure_kind.as_str(),
            error_summary = %api_error.summary,
            runner_id = %state.runner_id,
            runner_name = %state.runner_name,
            runner_group = %state.group,
            mode = %state.mode,
            running = state.running_count,
            sessions,
            "heartbeat failed"
        );
        return;
    }

    warn!(
        error = %error,
        runner_id = %state.runner_id,
        runner_name = %state.runner_name,
        runner_group = %state.group,
        mode = %state.mode,
        running = state.running_count,
        sessions,
        "heartbeat failed"
    );
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
    pub(super) fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }

    /// Poll for a pending job. The response contains `job: None` when no work is available.
    async fn poll(
        &self,
        runner_id: &str,
        group: &str,
        supported_profiles: &[String],
        reason: PollReason,
    ) -> RunnerResult<PollApiResult> {
        let body = poll_request_body(runner_id, group, supported_profiles, reason);
        let poll_started_at = Instant::now();
        let resp = send_api(
            self.http
                .request_route(routes::runners::poll::POLL, &self.token)
                .json(&body),
            "poll",
        )
        .await?;

        let resp = check_api_status(resp, "poll").await?;
        let poll: PollResponse = decode_api_json(resp, "poll").await?;

        Ok(PollApiResult {
            job: poll.job,
            http_request_elapsed: poll_started_at.elapsed(),
        })
    }

    /// Send a heartbeat with runner state. The short timeout (3s) bounds this
    /// best-effort request and any lifecycle drain waiting for it.
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

    /// Claim a job for execution. Treats the current HTTP 404 unavailable
    /// response and the legacy HTTP 409 conflict response as
    /// [`RunnerError::AlreadyClaimed`] so callers can continue gracefully.
    async fn claim(&self, candidate: &JobCandidate) -> RunnerResult<ExecutionContext> {
        let run_id = candidate.run_id();
        let body = claim_request_body(candidate);
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
                .json(&body),
            "claim",
        )
        .await?;

        if resp.status() == StatusCode::CONFLICT {
            return Err(RunnerError::AlreadyClaimed);
        }

        if resp.status() == StatusCode::NOT_FOUND {
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

        check_api_status(resp, "complete").await?;

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

    pub(super) async fn refresh_network_policies(
        &self,
        run_id: RunId,
        connector_refs: &[String],
    ) -> RunnerResult<NetworkPolicyRefreshBatchResponse> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.network_policy_refresh_request(&run_id, connector_refs),
            "network policy refresh",
        )
        .await?;

        let resp = check_api_status(resp, "network policy refresh").await?;
        decode_api_json(resp, "network policy refresh").await
    }

    fn network_policy_refresh_request(
        &self,
        run_id: &str,
        connector_refs: &[String],
    ) -> ApiRequestBuilder {
        self.http
            .request_resolved_route(
                routes::runners::runs::by_run_id::network_policy_refresh::route(
                    routes::runners::runs::by_run_id::network_policy_refresh::Params { run_id },
                ),
                &self.token,
            )
            .timeout(NETWORK_POLICY_REFRESH_TIMEOUT)
            .json(&serde_json::json!({ "connectorRefs": connector_refs }))
    }

    pub(super) async fn resolve_builtin_firewall_catalog(
        &self,
    ) -> RunnerResult<BuiltinFirewallCatalog> {
        let resp = send_api(
            self.http
                .request_route(
                    routes::runners::builtin_firewalls::resolve::RESOLVE,
                    &self.token,
                )
                .timeout(BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
                .json(&serde_json::json!({})),
            "builtin firewall catalog resolve",
        )
        .await?;

        let resp = check_api_status(resp, "builtin firewall catalog resolve").await?;
        let catalog: BuiltinFirewallCatalog =
            decode_api_json(resp, "builtin firewall catalog resolve").await?;
        catalog.validate_for_api_response().map_err(|e| {
            RunnerError::Api(format!(
                "builtin firewall catalog resolve invalid catalog: {e}"
            ))
        })?;
        Ok(catalog)
    }
}

fn claim_request_body(candidate: &JobCandidate) -> ClaimRequestBody {
    let is_ably_candidate = candidate.discovery_source() == Some(JobDiscoverySource::Ably);
    let (
        direct_candidate_notification_to_enqueue_ms,
        direct_candidate_inbox_wait_ms,
        provider_discovery_to_main_loop_ms,
        main_loop_to_local_admission_ms,
    ) = if is_ably_candidate {
        (
            candidate
                .direct_candidate_notification_to_enqueue_elapsed()
                .map(claim_telemetry_duration_ms),
            candidate
                .direct_candidate_inbox_wait_elapsed()
                .map(claim_telemetry_duration_ms),
            candidate
                .provider_discovery_to_main_loop_elapsed()
                .map(claim_telemetry_duration_ms),
            candidate
                .main_loop_to_local_admission_elapsed()
                .map(claim_telemetry_duration_ms),
        )
    } else {
        (None, None, None, None)
    };

    ClaimRequestBody {
        telemetry: ClaimRequestTelemetry {
            discovery_source: candidate.discovery_source().map(JobDiscoverySource::as_str),
            job_discovered_to_claim_request_ms: claim_telemetry_duration_ms(
                candidate.job_discovered_elapsed(),
            ),
            local_admission_to_claim_request_ms: candidate
                .local_admission_elapsed()
                .map(claim_telemetry_duration_ms),
            direct_candidate_notification_to_enqueue_ms,
            direct_candidate_inbox_wait_ms,
            provider_discovery_to_main_loop_ms,
            main_loop_to_local_admission_ms,
            poll_due_to_job_discovered_ms: candidate
                .poll_due_to_job_discovered_elapsed()
                .map(claim_telemetry_duration_ms),
            poll_http_request_ms: candidate
                .poll_http_request_elapsed()
                .map(claim_telemetry_duration_ms),
            poll_reason: candidate.poll_reason().map(String::from),
        },
    }
}

fn claim_telemetry_duration_ms(duration: Duration) -> u64 {
    // The TypeScript claim route validates these fields with z.number().int(),
    // which rejects values above Number.MAX_SAFE_INTEGER.
    duration_ms(duration).min(CLAIM_TELEMETRY_DURATION_MS_MAX)
}

fn poll_request_body(
    runner_id: &str,
    group: &str,
    supported_profiles: &[String],
    reason: PollReason,
) -> serde_json::Value {
    serde_json::json!({
        "runnerId": runner_id,
        "group": group,
        "supportedProfiles": supported_profiles,
        "telemetry": {
            "pollReason": poll_reason_value(reason),
        },
    })
}

fn poll_reason_value(reason: PollReason) -> &'static str {
    match reason {
        PollReason::Immediate => "immediate",
        PollReason::Deferred => "deferred",
        PollReason::WakeupRetry => "wakeup_retry",
        PollReason::Slow => "slow",
        PollReason::Fast => "fast",
    }
}

async fn send_api(req: ApiRequestBuilder, label: &'static str) -> RunnerResult<Response> {
    match req.send(label).await {
        Ok(resp) => Ok(resp),
        Err(RunnerError::Api(message)) => Err(RunnerError::Api(format!("{label}: {message}"))),
        Err(error) => Err(error),
    }
}

async fn check_api_status(resp: Response, label: &'static str) -> RunnerResult<Response> {
    let status = resp.status();
    if !status.is_success() {
        let (status, body) = read_api_error(resp).await;
        return Err(api_status_error(label, status, &body));
    }
    Ok(resp)
}

async fn decode_api_json<T: DeserializeOwned>(resp: Response, label: &str) -> RunnerResult<T> {
    let body = resp
        .bytes()
        .await
        .map_err(|e| RunnerError::Api(format!("{label} decode read body: {e}")))?;
    decode_api_json_bytes(&body).map_err(|e| RunnerError::Api(format!("{label} decode: {e}")))
}

async fn read_api_error(resp: Response) -> (StatusCode, String) {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    (status, body)
}

fn api_status_error(label: &'static str, status: StatusCode, body: &str) -> RunnerError {
    RunnerError::ApiStatus(Box::new(ApiStatusError {
        endpoint_label: label,
        status,
        body: body.to_string(),
    }))
}

fn decode_api_json_bytes<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let value = serde_path_to_error::deserialize(&mut deserializer)
        .map_err(|e| format_json_decode_error(format_json_decode_path(e.path()), e.inner()))?;
    deserializer
        .end()
        .map_err(|e| format_json_decode_error(".".to_string(), &e))?;
    Ok(value)
}

fn format_json_decode_path(path: &serde_path_to_error::Path) -> String {
    let mut formatted = String::new();
    let mut redact_next_map_key = false;

    for segment in path {
        match segment {
            serde_path_to_error::Segment::Seq { index } => {
                formatted.push('[');
                formatted.push_str(&index.to_string());
                formatted.push(']');
            }
            serde_path_to_error::Segment::Map { key } => {
                push_json_path_map_segment(&mut formatted, key, redact_next_map_key);
                redact_next_map_key = !redact_next_map_key && is_dynamic_json_map_field(key);
            }
            serde_path_to_error::Segment::Enum { .. } => {
                push_json_path_segment(&mut formatted, "<variant>");
                redact_next_map_key = false;
            }
            serde_path_to_error::Segment::Unknown => {
                push_json_path_segment(&mut formatted, "?");
                redact_next_map_key = false;
            }
        }
    }

    if formatted.is_empty() {
        ".".to_string()
    } else {
        formatted
    }
}

fn push_json_path_map_segment(formatted: &mut String, key: &str, redact: bool) {
    let segment = if redact {
        "<map-key>"
    } else if is_static_json_field(key) {
        key
    } else {
        "<field>"
    };
    push_json_path_segment(formatted, segment);
}

fn push_json_path_segment(formatted: &mut String, segment: &str) {
    if !formatted.is_empty() {
        formatted.push('.');
    }
    formatted.push_str(segment);
}

fn is_dynamic_json_map_field(field: &str) -> bool {
    matches!(
        field,
        "vars"
            | "environment"
            | "secretConnectorMap"
            | "secretConnectorMetadataMap"
            | "baseUrlVars"
            | "headers"
            | "query"
            | "networkPolicies"
            | "featureFlags"
    )
}

// serde_path_to_error reports both struct fields and runtime map keys as Map
// segments, so only known response schema fields are safe to print verbatim.
fn is_static_json_field(field: &str) -> bool {
    matches!(
        field,
        "allow"
            | "allowNonDefaultPort"
            | "apiStartTime"
            | "apis"
            | "archiveUrl"
            | "artifacts"
            | "ask"
            | "auth"
            | "accessKeyId"
            | "awsSigv4"
            | "base"
            | "baseUrlVars"
            | "billableFirewalls"
            | "cached"
            | "capability"
            | "catalogDigest"
            | "catalogVersion"
            | "captureNetworkBodies"
            | "checkpointId"
            | "cliAgentType"
            | "cliAgentSessionId"
            | "clientId"
            | "realAgentInPreview"
            | "deny"
            | "description"
            | "disallowedTools"
            | "encodedSize"
            | "encoding"
            | "encryptedSecrets"
            | "environment"
            | "experimentalProfile"
            | "expires"
            | "exactHosts"
            | "featureFlags"
            | "firewall"
            | "firewalls"
            | "headers"
            | "hash"
            | "historyRef"
            | "hostPolicy"
            | "heldSessionStates"
            | "issued"
            | "job"
            | "keyName"
            | "kind"
            | "mac"
            | "metadataKey"
            | "missingRootPolicy"
            | "modelUsageProvider"
            | "mountPath"
            | "name"
            | "networkPolicies"
            | "nonce"
            | "permissions"
            | "prompt"
            | "query"
            | "rawSize"
            | "resumeSession"
            | "rules"
            | "runId"
            | "sandboxToken"
            | "secretConnectorMap"
            | "secretConnectorMetadataMap"
            | "secretAccessKey"
            | "secretValues"
            | "sessionToken"
            | "sessionHistory"
            | "sessionId"
            | "settings"
            | "size"
            | "sourceType"
            | "sourceUserId"
            | "storageManifest"
            | "storages"
            | "suffixes"
            | "timestamp"
            | "token"
            | "lastCompletedAt"
            | "tools"
            | "ttl"
            | "unknownPolicy"
            | "url"
            | "userTimezone"
            | "vars"
            | "vasStorageId"
            | "vasStorageName"
            | "vasVersionId"
    )
}

fn format_json_decode_error(mut path: String, error: &serde_json::Error) -> String {
    let category = match error.classify() {
        serde_json::error::Category::Io => "io",
        serde_json::error::Category::Syntax => "syntax",
        serde_json::error::Category::Data => "data",
        serde_json::error::Category::Eof => "eof",
    };
    let location = format!("line {} column {}", error.line(), error.column());
    let detail = sanitized_json_error_detail(error);
    if detail == "unknown variant" && is_firewall_entry_decode_path(&path) {
        path.push_str(".kind");
    }
    if path == "." {
        format!("failed at <root>: {detail}; {category} error at {location}")
    } else {
        format!("failed at {path}: {detail}; {category} error at {location}")
    }
}

fn is_firewall_entry_decode_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("firewalls[") else {
        return false;
    };
    let Some((index, suffix)) = rest.split_once(']') else {
        return false;
    };
    !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()) && suffix.is_empty()
}

fn sanitized_json_error_detail(error: &serde_json::Error) -> String {
    let message = error.to_string();
    let location_suffix = format!(" at line {} column {}", error.line(), error.column());
    let detail = message
        .strip_suffix(&location_suffix)
        .unwrap_or(message.as_str());
    if detail.starts_with("missing field `") || detail.starts_with("duplicate field `") {
        return detail.to_string();
    }

    if detail.starts_with("unknown field `") {
        return "unknown field".to_string();
    }
    if detail.starts_with("trailing characters") {
        return "trailing characters".to_string();
    }
    if detail.starts_with("invalid type:") {
        return "invalid type".to_string();
    }
    if detail.starts_with("invalid value:") {
        return "invalid value".to_string();
    }
    if detail.starts_with("unknown variant `") {
        return "unknown variant".to_string();
    }
    if detail.starts_with("expected value") {
        return "expected value".to_string();
    }
    if detail.starts_with("EOF while parsing") {
        return "unexpected end of input".to_string();
    }
    "invalid JSON".to_string()
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
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;
    use tracing::{Level, instrument::WithSubscriber};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};
    use uuid::Uuid;

    use crate::http::HttpClientConfig;

    const RUNNER_CLAIM_RESPONSE_FIXTURE: &str = include_str!(
        "../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/runner-claim-response.json"
    );
    const RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID: &str = "00000000-0000-4000-8000-000000020985";

    fn api_client_for_server(server: &MockServer) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url: server.base_url(),
                vercel_bypass: None,
                client_session_id: "runner-session-test".to_string(),
            })
            .unwrap(),
            "runner-token".to_string(),
        )
    }

    #[test]
    fn network_policy_refresh_request_uses_short_timeout() {
        let server = MockServer::start();
        let api = api_client_for_server(&server);

        let request = api
            .network_policy_refresh_request(
                "00000000-0000-0000-0000-000000000001",
                &["slack".to_string()],
            )
            .build()
            .expect("network policy refresh request should build");

        assert_eq!(request.timeout(), Some(&NETWORK_POLICY_REFRESH_TIMEOUT));
        assert_eq!(
            request.url().path(),
            "/api/runners/runs/00000000-0000-0000-0000-000000000001/network-policy-refresh"
        );
        assert_eq!(
            request
                .body()
                .and_then(reqwest::Body::as_bytes)
                .expect("request should include JSON body"),
            br#"{"connectorRefs":["slack"]}"#
        );
    }

    #[test]
    fn builtin_firewall_catalog_resolve_request_uses_bounded_timeout_and_empty_body() {
        let server = MockServer::start();
        let api = api_client_for_server(&server);

        let request = api
            .http
            .request_route(
                routes::runners::builtin_firewalls::resolve::RESOLVE,
                &api.token,
            )
            .timeout(BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
            .json(&serde_json::json!({}))
            .build()
            .expect("builtin firewall catalog resolve request should build");

        assert_eq!(
            request.timeout(),
            Some(&BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
        );
        assert_eq!(
            request.url().path(),
            "/api/runners/builtin-firewalls/resolve"
        );
        assert_eq!(
            request
                .body()
                .and_then(reqwest::Body::as_bytes)
                .expect("request should include JSON body"),
            br#"{}"#
        );
    }

    #[tokio::test]
    async fn api_client_resolves_builtin_firewall_catalog() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::builtin_firewalls::resolve::RESOLVE.path)
                    .json_body(serde_json::json!({}));
                then.status(200).json_body(serde_json::json!({
                    "catalogDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "catalogVersion": "test-catalog",
                    "firewalls": {
                        "aws": {
                            "name": "aws",
                            "apis": [{
                                "base": "https://s3.amazonaws.com",
                                "hostPolicy": {
                                    "kind": "providerOwned",
                                    "exactHosts": ["s3.amazonaws.com"]
                                },
                                "auth": {
                                    "awsSigv4": {
                                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}"
                                    }
                                },
                                "permissions": [{"name": "read", "rules": ["GET /{bucket}"]}]
                            }]
                        }
                    }
                }));
            })
            .await;
        let api = api_client_for_server(&server);

        let catalog = api.resolve_builtin_firewall_catalog().await.unwrap();

        assert_eq!(catalog.catalog_version, "test-catalog");
        assert_eq!(
            catalog.firewalls["aws"].apis[0].base,
            "https://s3.amazonaws.com"
        );
        assert!(catalog.firewalls["aws"].apis[0].host_policy.is_some());
        assert!(catalog.firewalls["aws"].apis[0].auth.aws_sigv4.is_some());
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_rejects_builtin_firewall_catalog_key_name_mismatch() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::builtin_firewalls::resolve::RESOLVE.path);
                then.status(200).json_body(serde_json::json!({
                    "catalogDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "catalogVersion": "test-catalog",
                    "firewalls": {
                        "github": {
                            "name": "slack",
                            "apis": [{
                                "base": "https://slack.com/api",
                                "auth": {"headers": {}},
                                "permissions": []
                            }]
                        }
                    }
                }));
            })
            .await;
        let api = api_client_for_server(&server);

        let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

        match error {
            RunnerError::Api(message) => assert!(
                message.contains("does not match firewall.name"),
                "unexpected error: {message}"
            ),
            other => panic!("expected RunnerError::Api, got {other:?}"),
        }
        mock.assert_async().await;
    }

    fn assert_api_status_error(
        err: RunnerError,
        endpoint_label: &'static str,
        status: StatusCode,
        body: &str,
    ) {
        let display = err.to_string();
        match err {
            RunnerError::ApiStatus(error) => {
                assert_eq!(error.endpoint_label, endpoint_label);
                assert_eq!(error.status, status);
                assert_eq!(error.body, body);
            }
            other => panic!("expected RunnerError::ApiStatus, got {other:?}"),
        }
        assert_eq!(
            display,
            format!("api error: {endpoint_label} {status}: {body}")
        );
    }

    fn api_provider_for_test(
        api_url: String,
        cancel: CancellationToken,
        poll_wakeups: Arc<PollWakeups>,
    ) -> Arc<ApiProvider> {
        let api = ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: "runner-session-test".to_string(),
            })
            .unwrap(),
            "runner-token".to_string(),
        );
        Arc::new(ApiProvider {
            network_policy_refresh: NetworkPolicyRefreshHandle::new(api.clone()),
            builtin_firewall_catalog_refresh: BuiltinFirewallCatalogRefreshController::disabled(),
            api,
            runner_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            group: "default".to_string(),
            supported_profiles: vec![crate::profile::DEFAULT_PROFILE.to_string()],
            poll_wakeups,
            direct_candidates: DirectCandidateInbox::new(
                DIRECT_CANDIDATE_INBOX_CAPACITY,
                DIRECT_CANDIDATE_STALE_AFTER,
            ),
            ably_supervisor: Mutex::new(Some(AblySupervisor::disabled())),
            cancel_tokens: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            cancel,
        })
    }

    async fn capture_api_provider_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let output = future.with_subscriber(subscriber).await;
        (output, captured.entries())
    }

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
    }

    fn event_field<'a>(event: &'a CapturedEvent, field: &str) -> &'a str {
        event
            .fields
            .get(field)
            .map(String::as_str)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"))
    }

    fn heartbeat_state_for_test() -> HeartbeatState {
        HeartbeatState {
            runner_id: "runner-heartbeat-test".to_string(),
            runner_name: "runner test".to_string(),
            group: "vm0/test".to_string(),
            snapshot_generation: 7,
            snapshot_sequence: 42,
            total_vcpu: 8,
            total_memory_mb: 32768,
            max_concurrent: 4,
            allocated_vcpu: 2,
            allocated_memory_mb: 4096,
            running_count: 1,
            admittable_profiles: vec![crate::profile::DEFAULT_PROFILE.to_string()],
            held_session_states: vec![crate::types::HeldSessionState {
                session_id: "held-session-test".to_string(),
                last_completed_at: "2026-07-08T00:00:00.000Z".to_string(),
                reusable_sandbox: None,
                workspace_caches: Vec::new(),
            }],
            mode: "running".to_string(),
        }
    }

    async fn push_direct_candidate_for_test(provider: &ApiProvider, candidate: DirectJobCandidate) {
        provider.direct_candidates.push(candidate).await;
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) {
        let _ = read_http_request_text(socket).await;
    }

    async fn read_http_request_text(socket: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buf = [0_u8; 1024];
        let header_end = loop {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break request.len();
            }
            request.extend_from_slice(&buf[..n]);
            if let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
            {
                break header_end;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let request_len = header_end + content_length;
        loop {
            if request.len() >= request_len {
                break;
            }
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    async fn write_http_status_response(socket: &mut tokio::net::TcpStream, status: u16) {
        let reason = match status {
            200 => "OK",
            500 => "Internal Server Error",
            _ => "Unknown",
        };
        let body = if status == 200 { "ok" } else { "failed" };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn complete_sequence_server(
        statuses: Vec<u16>,
    ) -> (String, mpsc::UnboundedReceiver<String>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let server_task = tokio::spawn(async move {
            for status in statuses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request_text(&mut socket).await;
                write_http_status_response(&mut socket, status).await;
                request_tx.send(request).unwrap();
            }
        });
        (api_url, request_rx, server_task)
    }

    async fn next_request(requests: &mut mpsc::UnboundedReceiver<String>) -> String {
        requests
            .recv()
            .await
            .expect("complete request should reach the server")
    }

    fn assert_complete_authorization(request: &str, token: &str) {
        let expected = format!("authorization: Bearer {token}");
        assert!(
            request
                .lines()
                .any(|line| line.eq_ignore_ascii_case(&expected)),
            "completion request should use sandbox auth; request was:\n{request}",
        );
    }

    #[tokio::test]
    async fn heartbeat_send_failure_logs_transport_and_state_context_without_secrets() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let server_task = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
        });
        let provider = api_provider_for_test(
            api_url.clone(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let state = heartbeat_state_for_test();

        let (_, events) = capture_api_provider_events(provider.heartbeat(&state)).await;
        server_task.abort();
        let _ = server_task.await;
        let event = captured_event(&events, "heartbeat failed");

        assert_eq!(event.level, Level::WARN);
        assert_eq!(event_field(event, "runner_id"), "runner-heartbeat-test");
        assert_eq!(event_field(event, "runner_name"), "runner test");
        assert_eq!(event_field(event, "runner_group"), "vm0/test");
        assert_eq!(event_field(event, "mode"), "running");
        assert_eq!(event_field(event, "running"), "1");
        assert_eq!(event_field(event, "sessions"), "1");
        assert_eq!(event_field(event, "endpoint"), "heartbeat");
        assert_eq!(event_field(event, "method"), "POST");
        assert_eq!(
            event_field(event, "path"),
            routes::runners::heartbeat::HEARTBEAT.path
        );
        assert_eq!(
            event_field(event, "client_session_id"),
            "runner-session-test"
        );
        assert_eq!(
            event_field(event, "client_version"),
            env!("CARGO_PKG_VERSION")
        );
        assert!(!event_field(event, "failure_kind").is_empty());
        assert!(
            event_field(event, "host").starts_with("127.0.0.1:"),
            "host should include only host and port; event={event:#?}"
        );
        Uuid::parse_str(event_field(event, "client_request_id"))
            .expect("client_request_id should be a UUID");

        let event_debug = format!("{event:#?}");
        assert!(
            !event_debug.contains(&api_url),
            "event should not include full URL: {event_debug}"
        );
        assert!(
            !event_debug.contains("runner-token") && !event_debug.contains("held-session-test"),
            "event should not include bearer token or heartbeat body: {event_debug}"
        );
    }

    #[test]
    fn poll_request_body_serializes_poll_reason_telemetry() {
        let profiles = vec![crate::profile::DEFAULT_PROFILE.to_string()];
        let body = poll_request_body(
            "550e8400-e29b-41d4-a716-446655440000",
            "vm0/test",
            &profiles,
            PollReason::Immediate,
        );

        assert_eq!(body["runnerId"], "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(body["group"], "vm0/test");
        assert_eq!(
            body["supportedProfiles"][0],
            crate::profile::DEFAULT_PROFILE
        );
        assert_eq!(body["telemetry"]["pollReason"], "immediate");
        assert!(body.get("heldSessionStates").is_none());
    }

    #[test]
    fn claim_request_body_serializes_runner_timing() {
        let now = std::time::Instant::now();
        let target_generation_run_id: RunId =
            "00000000-0000-0000-0000-000000000099".parse().unwrap();
        let candidate = JobCandidate::new_with_timing_for_test(
            RunId::nil(),
            crate::profile::DEFAULT_PROFILE.to_string(),
            now.checked_sub(Duration::from_millis(25)).unwrap(),
            Some(now.checked_sub(Duration::from_millis(7)).unwrap()),
        )
        .with_discovery_source(JobDiscoverySource::Poll)
        .with_session_affinity_resource(Some(
            crate::types::SessionAffinityResource::ReusableSandbox,
        ))
        .with_history_generation_run_id(Some(target_generation_run_id))
        .with_poll_reason("deferred")
        .with_poll_timing(Duration::from_millis(19), Duration::from_millis(11));

        let body = serde_json::to_value(claim_request_body(&candidate)).unwrap();

        assert_eq!(body["telemetry"]["discoverySource"], "poll");
        assert!(
            body["telemetry"]["jobDiscoveredToClaimRequestMs"]
                .as_u64()
                .is_some_and(|value| value >= 25)
        );
        assert!(
            body["telemetry"]["localAdmissionToClaimRequestMs"]
                .as_u64()
                .is_some_and(|value| value >= 7)
        );
        assert_eq!(body["telemetry"]["pollDueToJobDiscoveredMs"], 19);
        assert_eq!(body["telemetry"]["pollHttpRequestMs"], 11);
        assert_eq!(body["telemetry"]["pollReason"], "deferred");
        assert!(body["telemetry"].get("sessionAffinityResource").is_none());
        assert!(
            body["telemetry"]
                .get("sessionAffinityLocalResource")
                .is_none()
        );
        assert!(body["telemetry"].get("localAdmissionResource").is_none());
        assert!(
            !body
                .to_string()
                .contains(&target_generation_run_id.to_string())
        );
        assert!(!body.to_string().contains("rawSizeBytes"));
        assert!(!body.to_string().contains("sessionId"));
        assert!(!body.to_string().contains("historyHash"));
        assert!(!body.to_string().contains("cacheKey"));
        assert!(!body.to_string().contains("path"));
        assert!(body.get("capabilities").is_none());
    }

    #[test]
    fn claim_request_body_serializes_ably_timing_splits() {
        let mut candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
                .with_discovery_source(JobDiscoverySource::Ably)
                .with_direct_candidate_timing(
                    Some(Duration::from_millis(3)),
                    Some(Duration::from_millis(5)),
                );
        candidate.mark_provider_discovery_returned();
        candidate.mark_main_loop_handling_started();
        candidate.mark_local_admission_started();

        let body = serde_json::to_value(claim_request_body(&candidate)).unwrap();

        assert_eq!(body["telemetry"]["discoverySource"], "ably");
        assert_eq!(
            body["telemetry"]["directCandidateNotificationToEnqueueMs"],
            3
        );
        assert_eq!(body["telemetry"]["directCandidateInboxWaitMs"], 5);
        assert!(
            body["telemetry"]["providerDiscoveryToMainLoopMs"]
                .as_u64()
                .is_some()
        );
        assert!(
            body["telemetry"]["mainLoopToLocalAdmissionMs"]
                .as_u64()
                .is_some()
        );
    }

    #[test]
    fn claim_request_body_omits_ably_only_timing_splits_for_poll_candidates() {
        let mut candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
                .with_discovery_source(JobDiscoverySource::Poll)
                .with_direct_candidate_timing(
                    Some(Duration::from_millis(3)),
                    Some(Duration::from_millis(5)),
                );
        candidate.mark_provider_discovery_returned();
        candidate.mark_main_loop_handling_started();
        candidate.mark_local_admission_started();

        let body = serde_json::to_value(claim_request_body(&candidate)).unwrap();

        assert_eq!(body["telemetry"]["discoverySource"], "poll");
        assert!(
            body["telemetry"]
                .get("directCandidateNotificationToEnqueueMs")
                .is_none()
        );
        assert!(
            body["telemetry"]
                .get("directCandidateInboxWaitMs")
                .is_none()
        );
        assert!(
            body["telemetry"]
                .get("providerDiscoveryToMainLoopMs")
                .is_none()
        );
        assert!(
            body["telemetry"]
                .get("mainLoopToLocalAdmissionMs")
                .is_none()
        );
    }

    #[test]
    fn claim_request_body_saturates_wire_timing_to_js_safe_integer() {
        let candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
                .with_poll_timing(
                    Duration::MAX,
                    Duration::from_millis(CLAIM_TELEMETRY_DURATION_MS_MAX + 1),
                );

        let body = serde_json::to_value(claim_request_body(&candidate)).unwrap();

        assert_eq!(
            body["telemetry"]["pollDueToJobDiscoveredMs"],
            CLAIM_TELEMETRY_DURATION_MS_MAX
        );
        assert_eq!(
            body["telemetry"]["pollHttpRequestMs"],
            CLAIM_TELEMETRY_DURATION_MS_MAX
        );
    }

    #[test]
    fn claim_request_body_omits_missing_local_admission_timing() {
        let now = std::time::Instant::now();
        let candidate = JobCandidate::new_with_timing_for_test(
            RunId::nil(),
            crate::profile::DEFAULT_PROFILE.to_string(),
            now.checked_sub(Duration::from_millis(25)).unwrap(),
            None,
        );

        let body = serde_json::to_value(claim_request_body(&candidate)).unwrap();

        assert!(
            body["telemetry"]["jobDiscoveredToClaimRequestMs"]
                .as_u64()
                .is_some_and(|value| value >= 25)
        );
        assert!(
            body["telemetry"]
                .get("localAdmissionToClaimRequestMs")
                .is_none()
        );
        assert!(body["telemetry"].get("pollDueToJobDiscoveredMs").is_none());
        assert!(body["telemetry"].get("pollHttpRequestMs").is_none());
        assert!(body["telemetry"].get("pollReason").is_none());
        assert!(body["telemetry"].get("sessionAffinityResource").is_none());
        assert!(
            body["telemetry"]
                .get("directCandidateNotificationToEnqueueMs")
                .is_none()
        );
        assert!(
            body["telemetry"]
                .get("directCandidateInboxWaitMs")
                .is_none()
        );
        assert!(
            body["telemetry"]
                .get("providerDiscoveryToMainLoopMs")
                .is_none()
        );
        assert!(
            body["telemetry"]
                .get("mainLoopToLocalAdmissionMs")
                .is_none()
        );
    }

    #[test]
    fn claim_request_body_serializes_ably_discovery_source_without_poll_timing() {
        let candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
                .with_discovery_source(JobDiscoverySource::Ably);

        let body = serde_json::to_value(claim_request_body(&candidate)).unwrap();

        assert_eq!(body["telemetry"]["discoverySource"], "ably");
        assert!(body["telemetry"].get("pollDueToJobDiscoveredMs").is_none());
        assert!(body["telemetry"].get("pollHttpRequestMs").is_none());
        assert!(body["telemetry"].get("pollReason").is_none());
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
        let history_generation_run_id: RunId =
            "00000000-0000-0000-0000-000000000004".parse().unwrap();
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200).json_body(serde_json::json!({
                    "job": {
                        "runId": run_id,
                        "experimentalProfile": "vm0/default",
                        "cliAgentSessionId": "sess-poll",
                        "historyGenerationRunId": history_generation_run_id,
                        "historyGenerationAffinityProtectedUntil": "2999-01-01T00:00:00.000Z",
                        "affinityProtectedUntil": "2999-01-01T00:00:00.000Z",
                        "sessionAffinityResource": "reusableSandbox"
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
        assert_eq!(discovered.cli_agent_session_id(), Some("sess-poll"));
        assert_eq!(
            discovered.history_generation_run_id(),
            Some(history_generation_run_id)
        );
        assert!(discovered.is_affinity_protected());
        assert!(discovered.is_history_generation_affinity_protected());
        assert_eq!(
            discovered.session_affinity_resource(),
            Some(crate::types::SessionAffinityResource::ReusableSandbox)
        );
        assert_eq!(
            discovered.discovery_source(),
            Some(JobDiscoverySource::Poll)
        );
        assert!(discovered.poll_due_to_job_discovered_elapsed().is_some());
        assert!(discovered.poll_http_request_elapsed().is_some());
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn discover_returns_ably_direct_candidate_without_polling() {
        let server = MockServer::start_async().await;
        let run_id: RunId = "00000000-0000-0000-0000-000000000006".parse().unwrap();
        let poll_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200)
                    .json_body(serde_json::json!({ "job": null }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let discovered_at = Instant::now()
            .checked_sub(Duration::from_millis(25))
            .unwrap();
        push_direct_candidate_for_test(
            &provider,
            DirectJobCandidate::new_with_discovered_at(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
                discovered_at,
            ),
        )
        .await;

        let discovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
            .await
            .expect("discover should receive direct candidate")
            .unwrap();

        assert_eq!(discovered.run_id(), run_id);
        assert_eq!(discovered.profile_name(), crate::profile::DEFAULT_PROFILE);
        assert_eq!(
            discovered.discovery_source(),
            Some(JobDiscoverySource::Ably)
        );
        assert!(discovered.job_discovered_elapsed() >= Duration::from_millis(25));
        assert!(
            discovered
                .direct_candidate_notification_to_enqueue_elapsed()
                .is_some()
        );
        assert!(discovered.direct_candidate_inbox_wait_elapsed().is_some());
        assert!(
            discovered
                .provider_discovery_to_main_loop_elapsed()
                .is_none()
        );
        assert!(discovered.poll_due_to_job_discovered_elapsed().is_none());
        assert!(discovered.poll_http_request_elapsed().is_none());
        poll_mock.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn try_discover_ready_returns_buffered_direct_candidate_without_polling() {
        let server = MockServer::start_async().await;
        let run_id: RunId = "00000000-0000-0000-0000-000000000016".parse().unwrap();
        let poll_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200)
                    .json_body(serde_json::json!({ "job": null }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        push_direct_candidate_for_test(
            &provider,
            DirectJobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string()),
        )
        .await;

        let discovered = provider
            .try_discover_ready()
            .await
            .expect("ready candidate should be available");

        assert_eq!(discovered.run_id(), run_id);
        assert_eq!(discovered.profile_name(), crate::profile::DEFAULT_PROFILE);
        assert_eq!(
            discovered.discovery_source(),
            Some(JobDiscoverySource::Ably)
        );
        assert!(provider.try_discover_ready().await.is_none());
        poll_mock.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn discover_prunes_stale_direct_candidate_and_polls_immediately() {
        let server = MockServer::start_async().await;
        let stale_run_id: RunId = "00000000-0000-0000-0000-000000000017".parse().unwrap();
        let poll_run_id: RunId = "00000000-0000-0000-0000-000000000018".parse().unwrap();
        let poll_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::poll::POLL.path)
                    .json_body(serde_json::json!({
                        "runnerId": "550e8400-e29b-41d4-a716-446655440000",
                        "group": "default",
                        "supportedProfiles": [crate::profile::DEFAULT_PROFILE],
                        "telemetry": {
                            "pollReason": "immediate"
                        }
                    }));
                then.status(200).json_body(serde_json::json!({
                    "job": {
                        "runId": poll_run_id,
                        "experimentalProfile": crate::profile::DEFAULT_PROFILE
                    }
                }));
            })
            .await;
        let wakeups = Arc::new(PollWakeups::new(true));
        let initial_poll = wakeups
            .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
            .await
            .unwrap();
        wakeups
            .record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY)
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::clone(&wakeups),
        );
        let stale_enqueued_at = Instant::now() - Duration::from_secs(120);
        push_direct_candidate_for_test(
            &provider,
            DirectJobCandidate::new_with_enqueued_at(
                stale_run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
                stale_enqueued_at,
                stale_enqueued_at,
            ),
        )
        .await;

        let discovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
            .await
            .expect("stale direct pruning should wake immediate poll")
            .unwrap();

        assert_eq!(discovered.run_id(), poll_run_id);
        assert_eq!(
            discovered.discovery_source(),
            Some(JobDiscoverySource::Poll)
        );
        poll_mock.assert_async().await;
    }

    #[tokio::test]
    async fn claim_failure_after_ably_direct_candidate_wakes_poll_fallback() {
        let server = MockServer::start_async().await;
        let run_id: RunId = "00000000-0000-0000-0000-000000000009".parse().unwrap();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(503).body("claim unavailable");
            })
            .await;
        let poll_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::poll::POLL.path)
                    .json_body(serde_json::json!({
                        "runnerId": "550e8400-e29b-41d4-a716-446655440000",
                        "group": "default",
                        "supportedProfiles": [crate::profile::DEFAULT_PROFILE],
                        "telemetry": {
                            "pollReason": "immediate"
                        }
                    }));
                then.status(200).json_body(serde_json::json!({
                    "job": {
                        "runId": run_id,
                        "experimentalProfile": crate::profile::DEFAULT_PROFILE
                    }
                }));
            })
            .await;
        let wakeups = Arc::new(PollWakeups::new(true));
        let initial_poll = wakeups
            .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
            .await
            .unwrap();
        wakeups
            .record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY)
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::clone(&wakeups),
        );
        push_direct_candidate_for_test(
            &provider,
            DirectJobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string()),
        )
        .await;

        let direct = tokio::time::timeout(Duration::from_secs(1), provider.discover())
            .await
            .expect("discover should receive direct candidate")
            .unwrap();
        assert_eq!(direct.discovery_source(), Some(JobDiscoverySource::Ably));
        assert!(provider.claim(direct).await.is_none());
        let rediscovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
            .await
            .expect("claim failure should wake immediate poll")
            .unwrap();

        assert_eq!(rediscovered.run_id(), run_id);
        assert_eq!(
            rediscovered.discovery_source(),
            Some(JobDiscoverySource::Poll)
        );
        claim_mock.assert_async().await;
        poll_mock.assert_async().await;
    }

    #[tokio::test]
    async fn discover_returns_direct_candidate_that_arrives_during_poll() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let direct_run_id: RunId = "00000000-0000-0000-0000-00000000000a".parse().unwrap();
        let poll_run_id: RunId = "00000000-0000-0000-0000-00000000000b".parse().unwrap();
        let (poll_accepted_tx, poll_accepted_rx) = tokio::sync::oneshot::channel();
        let (release_first_poll_tx, release_first_poll_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut first_socket, _) = listener.accept().await.unwrap();
            read_http_request(&mut first_socket).await;
            let _ = poll_accepted_tx.send(());
            release_first_poll_rx.await.unwrap();
            drop(first_socket);

            let (mut second_socket, _) = listener.accept().await.unwrap();
            read_http_request(&mut second_socket).await;
            write_poll_job_response(&mut second_socket, poll_run_id).await;
        });
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let provider_for_discover = Arc::clone(&provider);
        let discover_task = tokio::spawn(async move { provider_for_discover.discover().await });

        tokio::time::timeout(Duration::from_secs(1), poll_accepted_rx)
            .await
            .expect("poll should reach the server")
            .unwrap();
        push_direct_candidate_for_test(
            &provider,
            DirectJobCandidate::new(direct_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
        )
        .await;

        let discovered = tokio::time::timeout(Duration::from_secs(1), discover_task)
            .await
            .expect("direct candidate should interrupt poll")
            .unwrap()
            .unwrap();
        assert_eq!(discovered.run_id(), direct_run_id);
        assert_eq!(
            discovered.discovery_source(),
            Some(JobDiscoverySource::Ably)
        );

        release_first_poll_tx.send(()).unwrap();
        let rediscovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
            .await
            .expect("interrupted poll should be rearmed")
            .unwrap();
        assert_eq!(rediscovered.run_id(), poll_run_id);
        assert_eq!(
            rediscovered.discovery_source(),
            Some(JobDiscoverySource::Poll)
        );
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn discover_defers_job_return_when_deferred_poll_arrives_during_poll() {
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
            .request_deferred_poll_after_for_test(Duration::ZERO)
            .await;
        release_first_tx.send(()).unwrap();

        let discovered = tokio::time::timeout(Duration::from_secs(1), discover_task)
            .await
            .expect("discover should retry after deferred poll")
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

        let err = api
            .poll(
                "550e8400-e29b-41d4-a716-446655440000",
                "default",
                &[],
                PollReason::Immediate,
            )
            .await
            .unwrap_err();

        assert_api_status_error(
            err,
            "poll",
            StatusCode::SERVICE_UNAVAILABLE,
            "poll unavailable",
        );
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

        let err = api
            .poll(
                "550e8400-e29b-41d4-a716-446655440000",
                "default",
                &[],
                PollReason::Immediate,
            )
            .await
            .unwrap_err();

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
    async fn api_client_claim_not_found_or_legacy_conflict_is_already_claimed() {
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

            let candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string());
            let err = api.claim(&candidate).await.unwrap_err();

            assert!(matches!(err, RunnerError::AlreadyClaimed));
            mock.assert_async().await;
        }
    }

    #[tokio::test]
    async fn api_client_claim_decode_error_includes_json_path_without_body_values() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "hello",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "firewalls": [{
                        "kind": "secret-kind-value",
                        "name": "github"
                    }],
                    "billableFirewalls": []
                }));
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api
            .claim(&JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .unwrap_err();

        let RunnerError::Api(message) = err else {
            panic!("expected RunnerError::Api");
        };
        assert!(
            message.contains("claim decode: failed at firewalls[0].kind"),
            "decode error should include JSON path, got: {message}"
        );
        assert!(
            !message.contains("claim-sandbox-token"),
            "decode error must not include response body values, got: {message}"
        );
        assert!(
            !message.contains("secret-kind-value"),
            "decode error must not include invalid field values, got: {message}"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_claim_decode_error_redacts_values_that_look_like_field_errors() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "hello",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "firewalls": [{
                        "kind": "missing field `secret-kind-value`",
                        "name": "github"
                    }],
                    "billableFirewalls": []
                }));
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api
            .claim(&JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .unwrap_err();

        let RunnerError::Api(message) = err else {
            panic!("expected RunnerError::Api");
        };
        assert!(
            message.contains("claim decode: failed at firewalls[0].kind"),
            "decode error should include JSON path, got: {message}"
        );
        assert!(
            !message.contains("claim-sandbox-token"),
            "decode error must not include response body values, got: {message}"
        );
        assert!(
            !message.contains("secret-kind-value"),
            "decode error must not include invalid field values, got: {message}"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_claim_decode_error_includes_missing_field_name() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "hello",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "firewalls": [{
                        "name": "github",
                        "apis": []
                    }],
                    "billableFirewalls": []
                }));
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api
            .claim(&JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .unwrap_err();

        let RunnerError::Api(message) = err else {
            panic!("expected RunnerError::Api");
        };
        assert!(
            message.contains("claim decode: failed at firewalls[0]"),
            "decode error should include JSON path, got: {message}"
        );
        assert!(
            message.contains("missing field `kind`"),
            "decode error should include the missing field name, got: {message}"
        );
        assert!(
            !message.contains("claim-sandbox-token"),
            "decode error must not include response body values, got: {message}"
        );
        assert!(
            !message.contains("github"),
            "decode error must not include response body values, got: {message}"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_claim_decode_error_redacts_dynamic_map_keys() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "hello",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "environment": {
                        "OPENAI_API_KEY": 123
                    },
                    "billableFirewalls": []
                }));
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api
            .claim(&JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .unwrap_err();

        let RunnerError::Api(message) = err else {
            panic!("expected RunnerError::Api");
        };
        assert!(
            message.contains("claim decode: failed at environment.<map-key>"),
            "decode error should include a redacted dynamic map path, got: {message}"
        );
        assert!(
            !message.contains("OPENAI_API_KEY"),
            "decode error must not include dynamic map keys, got: {message}"
        );
        assert!(
            !message.contains("claim-sandbox-token"),
            "decode error must not include response body values, got: {message}"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_poll_decode_rejects_trailing_response_body() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"job":null} trailing-response-value"#);
            })
            .await;
        let api = api_client_for_server(&server);

        let err = api
            .poll(
                "550e8400-e29b-41d4-a716-446655440000",
                "default",
                &[crate::profile::DEFAULT_PROFILE.to_string()],
                PollReason::Immediate,
            )
            .await
            .unwrap_err();

        let RunnerError::Api(message) = err else {
            panic!("expected RunnerError::Api");
        };
        assert!(
            message.contains("poll decode: failed at <root>: trailing characters"),
            "decode error should reject trailing response content, got: {message}"
        );
        assert!(
            !message.contains("trailing-response-value"),
            "decode error must not include trailing response values, got: {message}"
        );
        mock.assert_async().await;
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

        assert_api_status_error(
            err,
            "complete",
            StatusCode::INTERNAL_SERVER_ERROR,
            "complete failed",
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_provider_claim_accepts_shared_current_response_fixture() {
        let server = MockServer::start_async().await;
        let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(200)
                    .header("content-type", "application/json")
                    .body(RUNNER_CLAIM_RESPONSE_FIXTURE);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("shared current claim response should decode");
        let context = claimed.context();

        assert_eq!(context.run_id, run_id);
        assert_eq!(context.prompt, "Inspect the fixture repository");
        assert_eq!(
            context.append_system_prompt.as_deref(),
            Some("Use the shared contract fixture")
        );
        assert_eq!(
            context.vars.as_ref().unwrap()["FIXTURE_REGION"],
            "test-region"
        );
        assert_eq!(context.storage_manifest.as_ref().unwrap().storages.len(), 1);
        assert_eq!(context.cli_agent_session_id(), Some("fixture-session-id"));
        assert_eq!(
            context.environment.as_ref().unwrap()["FIXTURE_MODEL"],
            "fixture-model"
        );
        assert_eq!(
            context.secret_values.as_deref(),
            Some(["fixture-secret-value-not-real".to_string()].as_slice())
        );
        assert!(context.local_secret_env_keys.is_none());
        assert_eq!(
            context.secret_connector_metadata_map.as_ref().unwrap()["FIXTURE_API_KEY"]
                .source_user_id
                .as_deref(),
            Some("fixture-user-id")
        );
        assert_eq!(context.capture_network_bodies, Some(true));
        assert_eq!(context.user_timezone.as_deref(), Some("UTC"));
        assert_eq!(
            context.network_policies.as_ref().unwrap()["model-provider:fixture"].unknown_policy,
            "deny"
        );
        assert_eq!(
            context.billable_firewalls,
            ["model-provider:fixture".to_string()]
        );
        assert_eq!(
            context.codex_runtime_config.as_ref().unwrap().provider_id,
            "fixture_provider"
        );
        claim_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_claim_accepts_previous_minimal_response() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "previous response",
                    "sandboxToken": "previous-sandbox-token",
                    "cliAgentType": "claude_code"
                }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("previous minimal claim response should remain compatible");
        let context = claimed.context();

        assert_eq!(context.prompt, "previous response");
        assert!(context.append_system_prompt.is_none());
        assert!(context.billable_firewalls.is_empty());
        claim_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_claim_ignores_additive_unknown_top_level_fields() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "response with additive field",
                    "sandboxToken": "additive-sandbox-token",
                    "cliAgentType": "claude_code",
                    "futureClaimMetadata": {"version": 2}
                }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("additive unknown claim fields should be ignored");

        assert_eq!(claimed.context().prompt, "response with additive field");
        claim_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_claim_ignores_api_local_secret_env_keys() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "attempt local secret trust",
                    "sandboxToken": "local-secret-sandbox-token",
                    "cliAgentType": "claude_code",
                    "localSecretEnvKeys": ["ANTHROPIC_API_KEY"]
                }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("API local secret metadata should be ignored");

        assert!(claimed.context().local_secret_env_keys.is_none());
        claim_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_claim_rejects_run_id_mismatch() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let context_run_id = RunId::new_v4();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": context_run_id,
                    "prompt": "hello",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "billableFirewalls": []
                }));
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await;

        assert!(claimed.is_none());
        claim_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_claim_carries_sandbox_token_to_completion() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "hello",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "billableFirewalls": []
                }));
            })
            .await;
        let complete_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path)
                    .header("authorization", "Bearer claim-sandbox-token");
                then.status(200);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed = provider
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("claim should succeed");
        let (context, completion_auth, active_input_source) = claimed.into_parts();
        assert_eq!(context.sandbox_token, "claim-sandbox-token");
        assert!(active_input_source.is_none());

        provider
            .complete(run_id, 0, None, None, None, completion_auth)
            .await;

        claim_mock.assert_calls_async(1).await;
        complete_mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_claimed_jobs_complete_out_of_order_with_their_own_tokens() {
        let server = MockServer::start_async().await;
        let run_id_a: RunId = "00000000-0000-0000-0000-000000000101".parse().unwrap();
        let run_id_b: RunId = "00000000-0000-0000-0000-000000000102".parse().unwrap();
        let claim_path_a = format!("/api/runners/jobs/{run_id_a}/claim");
        let claim_path_b = format!("/api/runners/jobs/{run_id_b}/claim");
        let claim_mock_a = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path_a.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id_a,
                    "prompt": "first",
                    "sandboxToken": "sandbox-token-a",
                    "cliAgentType": "claude_code",
                    "billableFirewalls": []
                }));
            })
            .await;
        let claim_mock_b = server
            .mock_async(|when, then| {
                when.method(POST).path(claim_path_b.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id_b,
                    "prompt": "second",
                    "sandboxToken": "sandbox-token-b",
                    "cliAgentType": "claude_code",
                    "billableFirewalls": []
                }));
            })
            .await;
        let complete_mock_a = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path)
                    .header("authorization", "Bearer sandbox-token-a")
                    .json_body(serde_json::json!({
                        "runId": run_id_a,
                        "exitCode": 0
                    }));
                then.status(200);
            })
            .await;
        let complete_mock_b = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path)
                    .header("authorization", "Bearer sandbox-token-b")
                    .json_body(serde_json::json!({
                        "runId": run_id_b,
                        "exitCode": 0
                    }));
                then.status(200);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let claimed_a = provider
            .claim(JobCandidate::new(
                run_id_a,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("first claim should succeed");
        let claimed_b = provider
            .claim(JobCandidate::new(
                run_id_b,
                crate::profile::DEFAULT_PROFILE.to_string(),
            ))
            .await
            .expect("second claim should succeed");
        let (context_a, completion_auth_a, active_input_source_a) = claimed_a.into_parts();
        let (context_b, completion_auth_b, active_input_source_b) = claimed_b.into_parts();
        assert!(active_input_source_a.is_none());
        assert!(active_input_source_b.is_none());

        provider
            .complete(context_b.run_id, 0, None, None, None, completion_auth_b)
            .await;
        provider
            .complete(context_a.run_id, 0, None, None, None, completion_auth_a)
            .await;

        claim_mock_a.assert_calls_async(1).await;
        claim_mock_b.assert_calls_async(1).await;
        complete_mock_a.assert_calls_async(1).await;
        complete_mock_b.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_complete_uses_sandbox_token_from_completion_auth() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path)
                    .header("authorization", "Bearer sandbox-token");
                then.status(200);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        provider
            .complete(
                run_id,
                0,
                None,
                None,
                None,
                CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
            )
            .await;

        mock.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn api_provider_complete_with_local_auth_does_not_send_request() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path);
                then.status(200);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        provider
            .complete(RunId::nil(), 0, None, None, None, CompletionAuth::local())
            .await;

        mock.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn api_provider_complete_with_mismatched_auth_does_not_send_request() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path);
                then.status(200);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        provider
            .complete(
                RunId::nil(),
                0,
                None,
                None,
                None,
                CompletionAuth::sandbox_token(RunId::new_v4(), "sandbox-token".to_string()),
            )
            .await;

        mock.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn api_provider_complete_does_not_retry_permanent_http_failure() {
        let (api_url, mut requests, server_task) = complete_sequence_server(vec![400]).await;
        let run_id = RunId::nil();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let ((), events) = tokio::time::timeout(
            Duration::from_secs(1),
            capture_api_provider_events(async move {
                provider
                    .complete(
                        run_id,
                        0,
                        None,
                        None,
                        None,
                        CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                    )
                    .await;
            }),
        )
        .await
        .expect("permanent completion failure should not wait for the retry delay");

        let request = next_request(&mut requests).await;
        assert_complete_authorization(&request, "sandbox-token");
        server_task.await.unwrap();
        assert!(
            requests.recv().await.is_none(),
            "permanent completion failure should send one request"
        );

        let run_id = run_id.to_string();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.fields.get("run_id") == Some(&run_id))
                .count(),
            1,
            "one failed request should produce one provider event: {events:#?}"
        );
        let event = captured_event(&events, "failed to report completion");
        assert_eq!(event.level, Level::ERROR);
        assert_eq!(event_field(event, "attempt"), "1");
        assert_eq!(event_field(event, "max_attempts"), "2");
        assert_eq!(event_field(event, "will_retry"), "false");
        assert_eq!(event_field(event, "status"), "400");
        assert_eq!(event_field(event, "failure_kind"), "http_status");
    }

    #[tokio::test(start_paused = true)]
    async fn api_provider_complete_retries_transient_http_failures() {
        for status in [
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::MISDIRECTED_REQUEST,
            StatusCode::TOO_EARLY,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let (api_url, mut requests, server_task) =
                complete_sequence_server(vec![status.as_u16(), 200]).await;
            let run_id = RunId::nil();
            let provider = api_provider_for_test(
                api_url,
                CancellationToken::new(),
                Arc::new(PollWakeups::new(false)),
            );
            let complete_task = tokio::spawn(async move {
                provider
                    .complete(
                        run_id,
                        0,
                        None,
                        None,
                        None,
                        CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                    )
                    .await;
            });

            let first_request = next_request(&mut requests).await;
            assert_complete_authorization(&first_request, "sandbox-token");
            tokio::task::yield_now().await;
            assert!(
                requests.try_recv().is_err(),
                "status {status} should wait before the retry"
            );
            tokio::time::advance(Duration::from_secs(2)).await;
            let second_request = next_request(&mut requests).await;
            assert_complete_authorization(&second_request, "sandbox-token");

            complete_task.await.unwrap();
            server_task.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn api_provider_complete_retries_transport_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, mut requests) = mpsc::unbounded_channel();
        let server_task = tokio::spawn(async move {
            let (mut first_socket, _) = listener.accept().await.unwrap();
            let first_request = read_http_request_text(&mut first_socket).await;
            drop(first_socket);
            request_tx.send(first_request).unwrap();

            let (mut second_socket, _) = listener.accept().await.unwrap();
            let second_request = read_http_request_text(&mut second_socket).await;
            write_http_status_response(&mut second_socket, 200).await;
            request_tx.send(second_request).unwrap();
        });
        let run_id = RunId::nil();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let complete_task = tokio::spawn(async move {
            provider
                .complete(
                    run_id,
                    0,
                    None,
                    None,
                    None,
                    CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                )
                .await;
        });

        let first_request = next_request(&mut requests).await;
        assert_complete_authorization(&first_request, "sandbox-token");
        tokio::task::yield_now().await;
        assert!(
            requests.try_recv().is_err(),
            "transport failure should wait before the retry"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        let second_request = next_request(&mut requests).await;
        assert_complete_authorization(&second_request, "sandbox-token");

        complete_task.await.unwrap();
        server_task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn api_provider_complete_does_not_retry_local_request_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let run_id = RunId::nil();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let ((), events) = capture_api_provider_events(provider.complete(
            run_id,
            0,
            None,
            None,
            None,
            CompletionAuth::sandbox_token(run_id, "invalid\nheader".to_string()),
        ))
        .await;

        let event = captured_event(&events, "failed to report completion");
        assert_eq!(event.level, Level::ERROR);
        assert_eq!(event_field(event, "attempt"), "1");
        assert_eq!(event_field(event, "will_retry"), "false");
        assert_eq!(event_field(event, "status"), "");
        assert_eq!(event_field(event, "failure_kind"), "local");
        assert!(event_field(event, "error").contains("build API request"));
    }

    #[tokio::test(start_paused = true)]
    async fn api_provider_complete_stops_after_two_transient_failures() {
        let (api_url, mut requests, server_task) = complete_sequence_server(vec![500, 500]).await;
        let run_id = RunId::nil();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let complete_task = tokio::spawn(async move {
            capture_api_provider_events(provider.complete(
                run_id,
                1,
                Some("boom"),
                None,
                None,
                CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
            ))
            .await
        });

        let first_request = next_request(&mut requests).await;
        assert_complete_authorization(&first_request, "sandbox-token");
        tokio::time::advance(Duration::from_secs(2)).await;
        let second_request = next_request(&mut requests).await;
        assert_complete_authorization(&second_request, "sandbox-token");

        let ((), events) = complete_task.await.unwrap();
        server_task.await.unwrap();
        assert!(
            requests.recv().await.is_none(),
            "completion should stop after the retry"
        );

        let run_id = run_id.to_string();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.fields.get("run_id") == Some(&run_id))
                .count(),
            2,
            "two failed requests should produce two provider events: {events:#?}"
        );
        let retry_event = captured_event(&events, "completion report failed, retrying");
        assert_eq!(retry_event.level, Level::WARN);
        assert_eq!(event_field(retry_event, "attempt"), "1");
        assert_eq!(event_field(retry_event, "will_retry"), "true");
        assert_eq!(event_field(retry_event, "status"), "500");
        assert_eq!(event_field(retry_event, "failure_kind"), "http_status");

        let final_event = captured_event(&events, "failed to report completion after retry");
        assert_eq!(final_event.level, Level::ERROR);
        assert_eq!(event_field(final_event, "attempt"), "2");
        assert_eq!(event_field(final_event, "will_retry"), "false");
        assert_eq!(event_field(final_event, "status"), "500");
        assert_eq!(event_field(final_event, "failure_kind"), "http_status");
    }
}
