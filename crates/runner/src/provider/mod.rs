//! Job provider trait and implementations.
//!
//! The [`JobProvider`] trait abstracts job lifecycle (discovery, claiming,
//! completion reporting) so different transports can be plugged in without
//! changing the executor or main loop.

mod api;
mod api_ably_supervisor;
mod local;
pub(crate) mod local_queue;
#[cfg(test)]
pub mod mock;

pub use api::ApiProvider;
pub use local::LocalProvider;
pub(crate) use local::{JobRequest, JobResponse};

use sandbox::SandboxId;
use std::path::{Path, PathBuf};

use crate::ids::RunId;
use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};

/// Discovered work item ready for the non-cancellable claim phase.
#[derive(Clone, Debug)]
pub struct JobCandidate {
    run_id: RunId,
    profile_name: String,
    local_job_path: Option<PathBuf>,
}

impl JobCandidate {
    pub fn new(run_id: RunId, profile_name: String) -> Self {
        Self {
            run_id,
            profile_name,
            local_job_path: None,
        }
    }

    pub(crate) fn local(run_id: RunId, profile_name: String, job_path: PathBuf) -> Self {
        Self {
            run_id,
            profile_name,
            local_job_path: Some(job_path),
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
}

/// Job claim result with the context and auth required for terminal completion.
pub struct ClaimedJob {
    context: ExecutionContext,
    completion_auth: CompletionAuth,
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
        })
    }

    pub(crate) fn local(
        expected_run_id: RunId,
        context: ExecutionContext,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::validate_run_id(expected_run_id, &context)?;
        Ok(Self {
            context,
            completion_auth: CompletionAuth::local(),
        })
    }

    pub(crate) fn into_parts(self) -> (ExecutionContext, CompletionAuth) {
        (self.context, self.completion_auth)
    }

    pub(crate) fn context(&self) -> &ExecutionContext {
        &self.context
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

    /// Update held sessions for poll affinity. Called when the idle-pool view
    /// changes so the provider can include current session state in poll
    /// requests.
    /// Default no-op — only relevant for API-backed providers.
    async fn set_held_session_states(&self, _states: Vec<crate::types::HeldSessionState>) {}

    /// Release discovery resources (subscriptions, background tasks).
    ///
    /// Called once after `discover()` returns `None` and before draining
    /// in-flight jobs. `complete()` calls may still arrive after this.
    async fn shutdown(&self);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_context(run_id: RunId) -> ExecutionContext {
        ExecutionContext {
            run_id,
            prompt: "test".into(),
            append_system_prompt: None,
            _agent_compose_version_id: None,
            vars: None,
            checkpoint_id: None,
            sandbox_token: "sandbox-token".into(),
            storage_manifest: None,
            environment: None,
            resume_session: None,
            secret_values: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            cli_agent_type: String::new(),
            debug_no_mock_claude: None,
            debug_no_mock_codex: None,
            api_start_time: None,
            user_timezone: None,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            disallowed_tools: None,
            tools: None,
            settings: None,
            experimental_profile: None,
            feature_flags: None,
            billable_firewalls: vec![],
            model_usage_provider: None,
        }
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
        let (context, completion_auth) = claimed.into_parts();

        assert_eq!(context.run_id, run_id);
        assert!(completion_auth.matches_sandbox_token_for_test(run_id, "sandbox-token"));
    }
}
