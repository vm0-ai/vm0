//! Job provider trait and implementations.
//!
//! The [`JobProvider`] trait abstracts job lifecycle (discovery, claiming,
//! completion reporting) so different transports can be plugged in without
//! changing the executor or main loop.

mod api;
mod api_ably_supervisor;
mod api_direct_candidates;
mod connector_policy_refresh;
mod local;
#[cfg(test)]
pub mod mock;

pub use api::ApiProvider;
pub(crate) use connector_policy_refresh::{
    ConnectorPolicyRefreshHandle, ConnectorPolicyRefreshRegistration,
};
pub use local::LocalProvider;

use chrono::{DateTime, Utc};
use sandbox::SandboxId;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::active_input::ActiveInputSource;
use crate::ids::RunId;
use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};

/// Low-cardinality source that first discovered a job candidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JobDiscoverySource {
    Ably,
    Poll,
}

impl JobDiscoverySource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ably => "ably",
            Self::Poll => "poll",
        }
    }
}

/// Discovered work item ready for the non-cancellable claim phase.
#[derive(Clone, Debug)]
pub struct JobCandidate {
    run_id: RunId,
    profile_name: String,
    local_job_path: Option<PathBuf>,
    discovered_at: Instant,
    local_admission_started_at: Option<Instant>,
    discovery_source: Option<JobDiscoverySource>,
    poll_reason: Option<String>,
    poll_due_to_job_discovered_elapsed: Option<Duration>,
    poll_http_request_elapsed: Option<Duration>,
    cli_agent_session_id: Option<String>,
    affinity_protected_until: Option<DateTime<Utc>>,
}

impl JobCandidate {
    pub fn new(run_id: RunId, profile_name: String) -> Self {
        Self::new_with_discovered_at(run_id, profile_name, Instant::now())
    }

    pub(crate) fn new_with_discovered_at(
        run_id: RunId,
        profile_name: String,
        discovered_at: Instant,
    ) -> Self {
        Self {
            run_id,
            profile_name,
            local_job_path: None,
            discovered_at,
            local_admission_started_at: None,
            discovery_source: None,
            poll_reason: None,
            poll_due_to_job_discovered_elapsed: None,
            poll_http_request_elapsed: None,
            cli_agent_session_id: None,
            affinity_protected_until: None,
        }
    }

    pub(crate) fn local(run_id: RunId, profile_name: String, job_path: PathBuf) -> Self {
        Self {
            local_job_path: Some(job_path),
            ..Self::new(run_id, profile_name)
        }
    }

    pub fn run_id(&self) -> RunId {
        self.run_id
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub(crate) fn local_job_path(&self) -> Option<&Path> {
        self.local_job_path.as_deref()
    }

    pub(crate) fn mark_local_admission_started(&mut self) {
        self.local_admission_started_at = Some(Instant::now());
    }

    pub(crate) fn job_discovered_elapsed(&self) -> Duration {
        self.discovered_at.elapsed()
    }

    pub(crate) fn local_admission_elapsed(&self) -> Option<Duration> {
        self.local_admission_started_at
            .map(|started| started.elapsed())
    }

    pub(crate) fn discovery_source(&self) -> Option<JobDiscoverySource> {
        self.discovery_source
    }

    pub(crate) fn poll_reason(&self) -> Option<&str> {
        self.poll_reason.as_deref()
    }

    pub(crate) fn poll_due_to_job_discovered_elapsed(&self) -> Option<Duration> {
        self.poll_due_to_job_discovered_elapsed
    }

    pub(crate) fn poll_http_request_elapsed(&self) -> Option<Duration> {
        self.poll_http_request_elapsed
    }

    pub(crate) fn cli_agent_session_id(&self) -> Option<&str> {
        self.cli_agent_session_id.as_deref()
    }

    pub(crate) fn affinity_protection_remaining(&self) -> Option<Duration> {
        let protected_until = self.affinity_protected_until?;
        let now = Utc::now();
        if protected_until <= now {
            return None;
        }
        (protected_until - now).to_std().ok()
    }

    pub(crate) fn is_affinity_protected(&self) -> bool {
        self.affinity_protection_remaining()
            .is_some_and(|remaining| !remaining.is_zero())
    }

    pub(crate) fn with_affinity_metadata(
        mut self,
        cli_agent_session_id: Option<String>,
        affinity_protected_until: Option<String>,
    ) -> Self {
        self.cli_agent_session_id =
            cli_agent_session_id.filter(|session_id| !session_id.is_empty());
        self.affinity_protected_until = affinity_protected_until
            .as_deref()
            .and_then(parse_affinity_protected_until);
        self
    }

    pub(crate) fn with_discovery_source(mut self, source: JobDiscoverySource) -> Self {
        self.discovery_source = Some(source);
        self
    }

    pub(crate) fn with_poll_reason(mut self, poll_reason: impl Into<String>) -> Self {
        self.poll_reason = Some(poll_reason.into());
        self
    }

    pub(crate) fn with_poll_timing(
        mut self,
        poll_due_to_job_discovered_elapsed: Duration,
        poll_http_request_elapsed: Duration,
    ) -> Self {
        self.poll_due_to_job_discovered_elapsed = Some(poll_due_to_job_discovered_elapsed);
        self.poll_http_request_elapsed = Some(poll_http_request_elapsed);
        self
    }

    #[cfg(test)]
    pub(crate) fn new_with_timing_for_test(
        run_id: RunId,
        profile_name: String,
        discovered_at: Instant,
        local_admission_started_at: Option<Instant>,
    ) -> Self {
        Self {
            local_admission_started_at,
            ..Self::new_with_discovered_at(run_id, profile_name, discovered_at)
        }
    }
}

fn parse_affinity_protected_until(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// Job claim result with the context and auth required for terminal completion.
pub struct ClaimedJob {
    context: ExecutionContext,
    completion_auth: CompletionAuth,
    active_input_source: Option<ActiveInputSource>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ClaimedJobRunIdMismatch {
    pub(crate) expected_run_id: RunId,
    pub(crate) context_run_id: RunId,
}

impl ClaimedJob {
    fn validate_run_id(
        expected_run_id: RunId,
        context: &ExecutionContext,
    ) -> Result<(), ClaimedJobRunIdMismatch> {
        if context.run_id == expected_run_id {
            Ok(())
        } else {
            Err(ClaimedJobRunIdMismatch {
                expected_run_id,
                context_run_id: context.run_id,
            })
        }
    }

    pub(crate) fn api(
        expected_run_id: RunId,
        context: ExecutionContext,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::validate_run_id(expected_run_id, &context)?;
        let completion_auth =
            CompletionAuth::sandbox_token(context.run_id, context.sandbox_token.clone());
        Ok(Self {
            context,
            completion_auth,
            active_input_source: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn local(
        expected_run_id: RunId,
        context: ExecutionContext,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::local_with_active_input_source(expected_run_id, context, None)
    }

    pub(crate) fn local_with_active_input_source(
        expected_run_id: RunId,
        context: ExecutionContext,
        active_input_source: Option<ActiveInputSource>,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::validate_run_id(expected_run_id, &context)?;
        Ok(Self {
            context,
            completion_auth: CompletionAuth::local(),
            active_input_source,
        })
    }

    pub(crate) fn into_parts(
        self,
    ) -> (ExecutionContext, CompletionAuth, Option<ActiveInputSource>) {
        (self.context, self.completion_auth, self.active_input_source)
    }

    pub(crate) fn context(&self) -> &ExecutionContext {
        &self.context
    }

    #[cfg(test)]
    pub(crate) fn active_input_source(&self) -> Option<&ActiveInputSource> {
        self.active_input_source.as_ref()
    }
}

/// Auth material needed by a provider to report terminal completion.
pub struct CompletionAuth {
    kind: CompletionAuthKind,
}

enum CompletionAuthKind {
    Sandbox { run_id: RunId, token: String },
    Local,
}

#[derive(Debug)]
enum CompletionAuthError {
    NotSandbox,
    RunIdMismatch { auth_run_id: RunId },
}

impl CompletionAuth {
    pub(crate) fn sandbox_token(run_id: RunId, token: String) -> Self {
        Self {
            kind: CompletionAuthKind::Sandbox { run_id, token },
        }
    }

    pub(crate) fn local() -> Self {
        Self {
            kind: CompletionAuthKind::Local,
        }
    }

    fn into_sandbox_token(self, expected_run_id: RunId) -> Result<String, CompletionAuthError> {
        match self.kind {
            CompletionAuthKind::Sandbox { run_id, token } if run_id == expected_run_id => Ok(token),
            CompletionAuthKind::Sandbox { run_id, .. } => Err(CompletionAuthError::RunIdMismatch {
                auth_run_id: run_id,
            }),
            CompletionAuthKind::Local => Err(CompletionAuthError::NotSandbox),
        }
    }

    #[cfg(test)]
    pub(crate) fn matches_sandbox_token_for_test(
        &self,
        expected_run_id: RunId,
        expected_token: &str,
    ) -> bool {
        matches!(
            &self.kind,
            CompletionAuthKind::Sandbox { run_id, token }
                if *run_id == expected_run_id && token == expected_token
        )
    }
}

/// Abstraction over job lifecycle — discovery, claiming, and completion reporting.
///
/// The runner main loop calls [`discover()`](JobProvider::discover) to find work,
/// [`claim()`](JobProvider::claim) to claim it, and
/// [`complete()`](JobProvider::complete) to report results. All transport
/// details (Ably control-plane notifications, HTTP poll, WebSocket, etc.) are
/// hidden behind this trait.
///
/// `discover()` and `claim()` are deliberately separate so that `discover()`
/// can live as a cancellable `select!` branch future while `claim()` runs
/// inside the branch handler where it cannot be interrupted.
#[async_trait::async_trait]
pub trait JobProvider: Send + Sync {
    /// Wait for the next job candidate. Returns `None` on shutdown signal.
    ///
    /// Implementations handle discovery (push/poll) internally. The returned
    /// candidate contains the `run_id` and profile name (e.g. `"vm0/default"`)
    /// for resource-budget pre-checking before
    /// [`claim()`](JobProvider::claim).
    ///
    /// This method has **no server-side side effects** and can be safely
    /// dropped (cancelled) at any `.await` point.
    async fn discover(&self) -> Option<JobCandidate>;

    /// Return one already-buffered job candidate without waiting or polling.
    ///
    /// Default no-op for providers that do not have a local push-delivery
    /// inbox. Implementations must not perform network I/O here; the runner
    /// main loop uses this only for bounded catch-up after a normal discovery.
    async fn try_discover_ready(&self) -> Option<JobCandidate> {
        None
    }

    /// Claim a discovered job. Returns `None` if the job was already claimed
    /// by another runner or an error occurred. A returned claim must carry an
    /// execution context whose `run_id` matches the discovered candidate.
    ///
    /// Callers **must** invoke this from a non-cancellable context (e.g.
    /// inside a `select!` branch handler) to guarantee that a successful
    /// claim is always paired with a later [`complete()`](JobProvider::complete).
    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob>;

    /// Report job completion. Called concurrently from spawned executor tasks.
    ///
    /// `sandbox_id` is the VM the run executed against (reused or freshly
    /// allocated). `reuse_result` describes the sandbox-reuse decision made
    /// before the run started. Both are `Option` so non-runner callers
    /// (tests, future transports) can omit them.
    ///
    /// `completion_auth` is returned by [`claim()`](JobProvider::claim) and
    /// carried by the claimed job lifecycle until completion.
    async fn complete(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        sandbox_id: Option<SandboxId>,
        reuse_result: Option<SandboxReuseResult>,
        completion_auth: CompletionAuth,
    );

    /// Report runner state to the server. Fire-and-forget — failures are
    /// logged but do not affect runner operation.
    async fn heartbeat(&self, state: &HeartbeatState);

    /// Delay the next API-backed poll until a protected same-session job can
    /// fall back to normal compatible-runner claiming.
    /// Default no-op — only relevant for API-backed providers.
    async fn defer_poll_after(&self, _delay: Duration) {}

    /// Release discovery resources (subscriptions, background tasks).
    ///
    /// Called once after `discover()` returns `None` and before draining
    /// in-flight jobs. `complete()` calls may still arrive after this.
    async fn shutdown(&self);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::execution_context_for_test;

    fn minimal_context(run_id: RunId) -> ExecutionContext {
        let mut ctx = execution_context_for_test(run_id);
        ctx.sandbox_token = "sandbox-token".into();
        ctx
    }

    #[test]
    fn claimed_job_rejects_mismatched_api_context() {
        let expected_run_id = RunId::nil();
        let context_run_id = RunId::new_v4();

        let Err(err) = ClaimedJob::api(expected_run_id, minimal_context(context_run_id)) else {
            panic!("mismatched context must be rejected");
        };

        assert_eq!(
            err,
            ClaimedJobRunIdMismatch {
                expected_run_id,
                context_run_id,
            }
        );
    }

    #[test]
    fn claimed_job_accepts_matching_api_context() {
        let run_id = RunId::nil();

        let claimed =
            ClaimedJob::api(run_id, minimal_context(run_id)).expect("matching context is valid");
        let (context, completion_auth, active_input_source) = claimed.into_parts();

        assert_eq!(context.run_id, run_id);
        assert!(active_input_source.is_none());
        assert!(completion_auth.matches_sandbox_token_for_test(run_id, "sandbox-token"));
    }
}
