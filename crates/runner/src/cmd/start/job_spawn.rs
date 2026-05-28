//! Claimed job task spawning, completion, and panic cleanup.
//!
//! Discovery and idle reuse decide when a claimed job should start. This module
//! owns the spawned task body: executor orchestration, provider completion,
//! deferred telemetry/network-log uploads, and outer-task panic cleanup.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use agent_diagnostics::{FailureClass, FailureDiagnostic, FailureReason};
use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::SharedIdlePool;
use super::job_lifecycle::{
    ActiveBudgetLease, CompletionPayload, RunCleanupDisposition, RunCleanupState,
};
use super::orphan_reap::OrphanedActiveRuns;
use super::ownership::{OwnershipTransitions, RunSandbox};
use super::sandbox_finalization::{FinalizeContext, finalize_sandbox_for_completion};
#[cfg(test)]
use super::{OuterJobPanicPoint, StartLoopTestObserver, maybe_panic_outer_job};
use crate::executor::{self, ExecutorConfig};
use crate::idle_pool::{ParkingGate, ReusableIdleSandbox};
use crate::ids::RunId;
use crate::network_logs;
use crate::provider::{ClaimedJob, JobProvider};
use crate::resource_budget::BudgetLease;
use crate::status::StatusTracker;
use crate::telemetry::JobTelemetry;
use crate::types::SandboxReuseResult;

/// Per-job profile parameters resolved from the profile config.
pub(super) struct JobProfile {
    pub(super) profile_name: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) budget_lease: BudgetLease,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: SharedFactory,
    pub(super) cancel: CancellationToken,
}

/// Shared state passed to each spawned job task.
pub(super) struct SpawnContext {
    pub(super) provider: Arc<dyn JobProvider>,
    pub(super) exec_config: Arc<ExecutorConfig>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) status: Arc<StatusTracker>,
    pub(super) cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    pub(super) orphaned_active_runs: OrphanedActiveRuns,
    /// Current lifecycle parking permission. This is checked at job
    /// completion so soft-drain/resume races do not depend on a stale
    /// spawn-time mode snapshot.
    pub(super) parking_gate: ParkingGate,
    /// Notifies the main loop to send an immediate heartbeat after parking a VM.
    /// This eliminates the up-to-10s blind spot where the server doesn't know
    /// which runner holds a newly-parked session.
    pub(super) park_notify: Arc<tokio::sync::Notify>,
    /// Best-effort signal for the main loop to ask mitmproxy to flush usage.
    pub(super) usage_flush_tx: mpsc::Sender<()>,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    #[cfg(test)]
    pub(super) outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    pub(super) test_observer: StartLoopTestObserver,
}

/// Spawn a job executor task.
///
/// The provider has already claimed the job and the caller has reserved
/// resources in the budget: this function spawns the executor, reports
/// completion via the provider, and releases the budget when done.
///
/// If `reuse_entry` is `Some`, the job reuses an existing idle sandbox.
/// Otherwise it creates a new one via the factory.
///
/// After a successful execution with a session ID available, the sandbox
/// is parked in the idle pool instead of being destroyed.
pub(super) fn spawn_job(
    claimed: ClaimedJob,
    sandbox_id: SandboxId,
    job_profile: JobProfile,
    reuse_entry: Option<ReusableIdleSandbox>,
    reuse_result: SandboxReuseResult,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<Option<RunId>>,
) {
    let (context, completion_auth) = claimed.into_parts();
    let run_id = context.run_id;
    let session_id = context.session_id().map(String::from);
    let vcpu = job_profile.vcpu;
    let memory_mb = job_profile.memory_mb;
    let active_lease = job_profile.budget_lease;
    let profile_name = job_profile.profile_name;
    let factory = job_profile.factory;
    let job_cancel = job_profile.cancel;
    let params = executor::JobParams {
        vcpu,
        memory_mb,
        restore_guest_state: job_profile.restore_guest_state,
        device_rate_limits: job_profile.device_rate_limits.clone(),
    };
    let job_device_rate_limits = params.device_rate_limits.clone();

    let storage_fingerprints = context
        .storage_manifest
        .as_ref()
        .map(crate::idle_pool::StorageFingerprints::from_manifest)
        .unwrap_or_default();

    let provider = Arc::clone(&ctx.provider);
    let exec_config = Arc::clone(&ctx.exec_config);
    let status = Arc::clone(&ctx.status);
    let idle_pool = Arc::clone(&ctx.idle_pool);
    let park_notify = Arc::clone(&ctx.park_notify);
    let usage_flush_tx = ctx.usage_flush_tx.clone();
    let parking_gate = ctx.parking_gate.clone();
    let factory_for_cleanup = Arc::clone(&factory);
    let cleanup_state = RunCleanupState::new();
    let cleanup_state_for_body = cleanup_state.clone();
    let cleanup_state_for_panic = cleanup_state.clone();
    let cancel_tokens_for_panic = Arc::clone(&ctx.cancel_tokens);
    let status_for_panic = Arc::clone(&status);
    let idle_pool_for_panic = Arc::clone(&idle_pool);
    let orphaned_active_runs_for_panic = ctx.orphaned_active_runs.clone();
    #[cfg(test)]
    let outer_job_panic = ctx.outer_job_panic;
    #[cfg(test)]
    let test_observer = ctx.test_observer.clone();

    // Captured for the post-complete deferred work below: the panic-arm
    // empty `JobTelemetry` construction, the final `telemetry.flush()`, and
    // the network-log upload. `context` gets moved into the inner executor
    // task and `exec_config` with it, so we snapshot the token and bump the
    // Arc before spawning.
    let sandbox_token = context.sandbox_token.clone();
    let exec_config_for_deferred = Arc::clone(&exec_config);

    let reused = reuse_entry.is_some();

    jobs.spawn(async move {
        let body = async move {
            #[cfg(test)]
            maybe_panic_outer_job(outer_job_panic, OuterJobPanicPoint::ActiveOrUnknown, run_id);

            // Inner spawn isolates panics: if execute_job panics, the outer task
            // still reports completion and releases budget.
            let cancel = job_cancel.clone();

            let inner = tokio::spawn(async move {
                if let Some(idle_entry) = reuse_entry {
                    executor::execute_job_reuse(idle_entry, context, &exec_config, cancel).await
                } else {
                    executor::execute_job(
                        &**factory,
                        context,
                        executor::NewSandboxDispatch {
                            id: sandbox_id,
                            reuse_result,
                        },
                        &exec_config,
                        &params,
                        cancel,
                    )
                    .await
                }
            });

            let (
                exit_code,
                err,
                failure,
                sandbox,
                source_ip,
                network_log_session,
                guest_session_id,
                telemetry,
            ) = match inner.await {
                Ok((mut outcome, telemetry)) => {
                    if job_cancel.is_cancelled() {
                        outcome.mark_cancelled();
                    }
                    let exit_code = outcome.exit_code();
                    let err = outcome.error().map(ToOwned::to_owned);
                    (
                        exit_code,
                        err,
                        outcome.failure,
                        outcome.sandbox,
                        outcome.source_ip,
                        outcome.network_log_session,
                        outcome.guest_session_id,
                        telemetry,
                    )
                }
                Err(e) => {
                    // Panic lost the in-flight telemetry buffer; substitute an
                    // empty collector so the post-complete flush path stays
                    // unconditional. `flush` early-returns on empty pending_ops.
                    let empty_telemetry = JobTelemetry::new(
                        exec_config_for_deferred.http.clone(),
                        run_id,
                        sandbox_token.clone(),
                    );
                    let failure = executor::ExecutionFailure::from_error(format!(
                        "executor task panicked: {e}"
                    ));
                    let exit_code = failure.exit_code;
                    let err = Some(failure.error.clone());
                    (
                        exit_code,
                        err,
                        Some(failure),
                        None,
                        String::new(),
                        None,
                        None,
                        empty_telemetry,
                    )
                }
            };

            // Single sink for any claimed job's terminal state. Cancellation gets
            // its own info marker; every other failure is represented by a
            // single object carrying the exit code, error, and optional
            // guest-authored diagnostic.
            let cancelled_for_log = job_cancel.is_cancelled();
            match (cancelled_for_log, failure.as_ref()) {
                (true, _) => info!(run_id = %run_id, exit_code, reused, "job cancelled"),
                (false, Some(failure)) => {
                    log_job_execution_failed(run_id, exit_code, reused, failure);
                }
                (false, None) => info!(run_id = %run_id, exit_code, reused, "job finished"),
            }

            let completion_payload = CompletionPayload::new(
                run_id,
                exit_code,
                err,
                sandbox_id,
                reuse_result,
                completion_auth,
            );
            // Cancellation can arrive after terminal logging or while
            // `sandbox.park()` is in flight. Pass the live token so finalization
            // can re-check immediately before idle-pool ownership transfer.
            let completion_ready = finalize_sandbox_for_completion(
                sandbox,
                ActiveBudgetLease::new(active_lease),
                completion_payload,
                FinalizeContext {
                    run_id,
                    sandbox_id,
                    profile_name,
                    session_id,
                    guest_session_id,
                    source_ip,
                    network_log_session,
                    storage_fingerprints,
                    device_rate_limits: job_device_rate_limits,
                    factory: factory_for_cleanup,
                    idle_pool,
                    status: Arc::clone(&status),
                    park_notify,
                    parking_gate,
                    network_log_drain: exec_config_for_deferred.network_log_drain.clone(),
                    exit_code,
                    cancel: job_cancel,
                    cleanup_state: cleanup_state_for_body.clone(),
                    #[cfg(test)]
                    outer_job_panic,
                    #[cfg(test)]
                    test_observer,
                },
            )
            .await;

            // Structural guarantee: claim (in provider) is always paired with complete.
            match usage_flush_tx.try_send(()) {
                Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {}
                Err(mpsc::error::TrySendError::Closed(())) => {
                    warn!(run_id = %run_id, "proxy usage flush signal channel closed before completion");
                }
            }
            let ownership = OwnershipTransitions::new(status.as_ref());
            completion_ready
                .complete_and_release(provider.as_ref(), &ownership, &cleanup_state_for_body)
                .await;

            // Best-effort telemetry, deferred past `provider.complete` so the
            // user-visible run-complete signal isn't blocked on these uploads.
            // They're still awaited (not spawned) so the surrounding `jobs`
            // JoinSet drains them on graceful shutdown: no data loss on SIGTERM.
            // Telemetry flush runs concurrently with best-effort network-log upload.
            // The job finalizer already closed the local Rust-side DNS/kmsg
            // session before sandbox reuse/release. Keep this flush as a
            // defensive no-op for any accepted writes still finishing.
            let network_log_path = exec_config_for_deferred.log_paths.network_log(run_id);
            let network_log_upload = async {
                exec_config_for_deferred
                    .network_log_manager
                    .flush_path(&network_log_path)
                    .await;
                network_logs::upload_network_logs(
                    &exec_config_for_deferred.http,
                    run_id,
                    &sandbox_token,
                    &network_log_path,
                )
                .await;
            };
            tokio::join!(telemetry.flush(), network_log_upload,);

            Some(run_id)
        };

        match AssertUnwindSafe(body).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => {
                let cleanup = cleanup_panicked_job(
                    run_id,
                    sandbox_id,
                    cancel_tokens_for_panic,
                    status_for_panic,
                    idle_pool_for_panic,
                    cleanup_state_for_panic,
                    orphaned_active_runs_for_panic,
                );
                if AssertUnwindSafe(cleanup).catch_unwind().await.is_err() {
                    error!(
                        run_id = %run_id,
                        sandbox_id = %sandbox_id,
                        "outer job panic cleanup panicked"
                    );
                }
                std::panic::resume_unwind(payload);
            }
        }
    });
}

fn log_job_execution_failed(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    failure: &executor::ExecutionFailure,
) {
    if let Some(diagnostic) = failure.diagnostic.as_ref() {
        let failure_detail_source = diagnostic
            .failure_detail_source
            .map(|source| source.as_str());
        let failure_reason = diagnostic.failure_reason.map(|reason| reason.as_str());
        macro_rules! log_with_diagnostic {
            ($level:ident) => {
                $level!(
                    run_id = %run_id,
                    exit_code,
                    reused,
                    error = %failure.error,
                    failure_class = diagnostic.failure_class.as_str(),
                    failure_framework = diagnostic.framework.as_str(),
                    failure_cli_exit_code = diagnostic.cli_exit_code,
                    failure_claude_num_turns = diagnostic.claude_num_turns,
                    failure_detail_source,
                    failure_reason,
                    session_history_status = diagnostic.session_history_status.as_str(),
                    prompt_shape = diagnostic.prompt_shape.as_str(),
                    prompt_bytes = diagnostic.prompt_bytes,
                    first_line_bytes = diagnostic.first_line_bytes,
                    "job execution failed"
                )
            };
        }
        if is_info_level_job_failure(diagnostic) {
            log_with_diagnostic!(info);
        } else {
            log_with_diagnostic!(error);
        }
    } else {
        error!(run_id = %run_id, exit_code, reused, error = %failure.error, "job execution failed");
    }
}

fn is_info_level_job_failure(diagnostic: &FailureDiagnostic) -> bool {
    match diagnostic.failure_class {
        FailureClass::CliNonzero => matches!(
            diagnostic.failure_reason,
            Some(
                FailureReason::InsufficientCredits
                    | FailureReason::InvalidApiKey
                    | FailureReason::UsageLimit
            )
        ),
        FailureClass::ClaudeZeroTurnNoHistory => true,
        _ => false,
    }
}

pub(super) async fn cleanup_panicked_job(
    run_id: RunId,
    sandbox_id: SandboxId,
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    status: Arc<StatusTracker>,
    idle_pool: SharedIdlePool,
    cleanup_state: RunCleanupState,
    orphaned_active_runs: OrphanedActiveRuns,
) {
    cancel_tokens.lock().await.remove(&run_id);
    let ownership = OwnershipTransitions::new(status.as_ref());
    let run = RunSandbox::new(run_id, sandbox_id);

    match cleanup_state.disposition() {
        RunCleanupDisposition::StatusRemoved => {}
        RunCleanupDisposition::DestroyCompleted => {
            ownership.active_destroy_completed(run).await;
        }
        RunCleanupDisposition::IdlePoolOwned => {
            let snapshot = idle_pool.lock().await.status_snapshot();
            ownership.active_idle_pool_owned(run, snapshot).await;
        }
        RunCleanupDisposition::ActiveOrUnknown => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                "outer job task panicked before sandbox ownership was proven; leaving active run visible for orphan reconciliation"
            );
            ownership.active_ownership_unknown(&orphaned_active_runs, run);
        }
    }
}

/// Handle a completed job from the JoinSet, cleaning up cancel tokens.
pub(super) async fn handle_job_result(
    result: Option<Result<Option<RunId>, tokio::task::JoinError>>,
    cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
) {
    match result {
        Some(Ok(Some(run_id))) => {
            cancel_tokens.lock().await.remove(&run_id);
        }
        Some(Err(e)) => {
            error!(error = %e, "job task panicked");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap};
    use std::fmt;
    use std::sync::Arc;
    use std::time::Duration;

    use agent_diagnostics::{
        AgentFramework, FailureClass, FailureDetailSource, PromptMetadata, SessionHistoryStatus,
    };
    use sandbox::{SandboxFactory, SandboxId};
    use sandbox_mock::{MockSandbox, MockSandboxFactory};
    use tokio_util::sync::CancellationToken;
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Subscriber};
    use tracing_subscriber::layer::{Context, Layer};
    use tracing_subscriber::prelude::*;

    use super::super::idle_lifecycle::SharedIdlePool;
    use super::super::job_lifecycle::RunCleanupState;
    use super::super::orphan_reap::OrphanedActiveRuns;
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate,
        SyntheticParkedIdleCandidateParts,
    };
    use crate::ids::RunId;
    use crate::resource_budget::ResourceBudget;
    use crate::status::StatusTracker;

    #[derive(Clone, Debug)]
    struct CapturedEvent {
        level: Level,
        fields: BTreeMap<String, String>,
    }

    #[derive(Clone, Default)]
    struct CapturedEvents {
        events: Arc<std::sync::Mutex<Vec<CapturedEvent>>>,
    }

    impl CapturedEvents {
        fn entries(&self) -> Vec<CapturedEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl<S> Layer<S> for CapturedEvents
    where
        S: Subscriber,
    {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = CapturedFields::default();
            event.record(&mut visitor);
            self.events.lock().unwrap().push(CapturedEvent {
                level: *event.metadata().level(),
                fields: visitor.fields,
            });
        }
    }

    #[derive(Default)]
    struct CapturedFields {
        fields: BTreeMap<String, String>,
    }

    impl Visit for CapturedFields {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_i64(&mut self, field: &Field, value: i64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_u64(&mut self, field: &Field, value: u64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_bool(&mut self, field: &Field, value: bool) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
            self.fields
                .insert(field.name().to_string(), format!("{value:?}"));
        }
    }

    fn job_failure_diagnostic(failure_reason: Option<FailureReason>) -> FailureDiagnostic {
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::CodexJsonl)
        .with_session_history_status(SessionHistoryStatus::NotApplicable);
        if let Some(reason) = failure_reason {
            diagnostic = diagnostic.with_failure_reason(reason);
        }
        diagnostic
    }

    fn capture_job_failure_log(failure: &executor::ExecutionFailure) -> CapturedEvent {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            log_job_execution_failed(RunId::nil(), failure.exit_code, false, failure);
        });
        let events = captured.entries();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        events[0].clone()
    }

    fn assert_field_eq(event: &CapturedEvent, field: &str, expected: &str) {
        let value = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(value, expected, "field {field} mismatch; event={event:#?}");
    }

    #[test]
    fn expected_cli_failure_reasons_log_job_execution_failed_at_info() {
        for reason in [
            FailureReason::InsufficientCredits,
            FailureReason::InvalidApiKey,
            FailureReason::UsageLimit,
        ] {
            let diagnostic = job_failure_diagnostic(Some(reason));
            let failure = executor::ExecutionFailure::new(
                1,
                format!("quota failure: {}", reason.as_str()),
                Some(diagnostic),
            );

            let event = capture_job_failure_log(&failure);

            assert_eq!(event.level, Level::INFO);
            assert_eq!(
                event.fields.get("message").map(String::as_str),
                Some("job execution failed")
            );
            assert_field_eq(&event, "failure_reason", reason.as_str());
            assert_field_eq(&event, "failure_class", "cli_nonzero");
            assert_field_eq(&event, "failure_detail_source", "codex_jsonl");
        }
    }

    #[test]
    fn claude_zero_turn_no_history_logs_job_execution_failed_at_info() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::ClaudeZeroTurnNoHistory,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("/help"),
        )
        .with_cli_exit_code(0)
        .with_claude_num_turns(Some(0))
        .with_session_history_status(SessionHistoryStatus::Missing);
        let failure = executor::ExecutionFailure::new(
            1,
            "Claude Code emitted a zero-turn result without creating session history; skipping checkpoint",
            Some(diagnostic),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::INFO);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "failure_class", "claude_zero_turn_no_history");
        assert_field_eq(&event, "session_history_status", "missing");
    }

    #[test]
    fn info_level_reason_on_non_cli_failure_logs_job_execution_failed_at_error() {
        for reason in [FailureReason::InvalidApiKey, FailureReason::UsageLimit] {
            let diagnostic = FailureDiagnostic::new(
                FailureClass::CheckpointFailed,
                AgentFramework::Codex,
                PromptMetadata::from_prompt("plain prompt"),
            )
            .with_failure_reason(reason);
            let failure = executor::ExecutionFailure::new(
                1,
                format!("checkpoint upload failed after {} event", reason.as_str()),
                Some(diagnostic),
            );

            let event = capture_job_failure_log(&failure);

            assert_eq!(event.level, Level::ERROR);
            assert_eq!(
                event.fields.get("message").map(String::as_str),
                Some("job execution failed")
            );
            assert_field_eq(&event, "failure_reason", reason.as_str());
            assert_field_eq(&event, "failure_class", "checkpoint_failed");
        }
    }

    #[test]
    fn unclassified_diagnostic_failure_logs_job_execution_failed_at_error() {
        let diagnostic = job_failure_diagnostic(None);
        let failure = executor::ExecutionFailure::new(1, "permission denied", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert!(!event.fields.contains_key("failure_reason"));
    }

    #[test]
    fn failure_without_diagnostic_logs_job_execution_failed_at_error() {
        let failure = executor::ExecutionFailure::new(1, "executor task panicked", None);

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert!(!event.fields.contains_key("failure_reason"));
    }

    async fn status_idle_sessions_and_active_runs(
        status_path: &std::path::Path,
    ) -> (Vec<String>, Vec<String>) {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut sessions: Vec<String> = status
            .get("idle_vms")
            .and_then(|v| v.as_array())
            .map(|idle_vms| {
                idle_vms
                    .iter()
                    .filter_map(|vm| {
                        vm.get("session_id")
                            .and_then(|session| session.as_str())
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        sessions.sort_unstable();
        let mut run_ids: Vec<String> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|run| {
                run.get("run_id")
                    .and_then(|run_id| run_id.as_str())
                    .map(str::to_string)
            })
            .collect();
        run_ids.sort_unstable();
        (sessions, run_ids)
    }
    async fn status_active_run_records(status_path: &std::path::Path) -> Vec<(String, String)> {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut records: Vec<(String, String)> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| {
                (
                    run["run_id"].as_str().unwrap().to_string(),
                    run["sandbox_id"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        records.sort_unstable();
        records
    }

    struct CleanupPanickedJobFixture {
        status_path: std::path::PathBuf,
        status: Arc<StatusTracker>,
        idle_pool: SharedIdlePool,
        tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        orphans: OrphanedActiveRuns,
        _dir: tempfile::TempDir,
    }

    impl CleanupPanickedJobFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status_path = dir.path().join("status.json");
            let status = Arc::new(StatusTracker::new(status_path.clone(), 4, None, None));
            let idle_pool: SharedIdlePool =
                Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                    default_timeout: Duration::from_secs(300),
                    max_idle: 10,
                })));
            let tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> =
                Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            let orphans = OrphanedActiveRuns::new();

            Self {
                status_path,
                status,
                idle_pool,
                tokens,
                orphans,
                _dir: dir,
            }
        }

        async fn cleanup(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            cleanup_state: RunCleanupState,
        ) {
            cleanup_panicked_job(
                run_id,
                sandbox_id,
                Arc::clone(&self.tokens),
                Arc::clone(&self.status),
                Arc::clone(&self.idle_pool),
                cleanup_state,
                self.orphans.clone(),
            )
            .await;
        }
    }

    #[tokio::test]
    async fn panic_cleanup_status_removed_only_clears_cancel_token() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, sandbox_id).await;
        fixture
            .status
            .remove_run_if_matching(run_id, sandbox_id)
            .await;
        fixture
            .tokens
            .lock()
            .await
            .insert(run_id, CancellationToken::new());
        cleanup_state.mark_status_removed();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.lock().await.contains_key(&run_id));
        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&fixture.status_path).await;
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }

    #[tokio::test]
    async fn panic_cleanup_active_unknown_keeps_active_and_registers_orphan() {
        let fixture = CleanupPanickedJobFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, sandbox_id).await;
        fixture
            .tokens
            .lock()
            .await
            .insert(run_id, CancellationToken::new());

        fixture
            .cleanup(run_id, sandbox_id, RunCleanupState::new())
            .await;

        assert!(!fixture.tokens.lock().await.contains_key(&run_id));
        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&fixture.status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        assert_eq!(fixture.orphans.len(), 1);
    }

    #[tokio::test]
    async fn panic_cleanup_destroy_completed_removes_active_run() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, sandbox_id).await;
        fixture
            .tokens
            .lock()
            .await
            .insert(run_id, CancellationToken::new());
        cleanup_state.mark_destroy_completed();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.lock().await.contains_key(&run_id));
        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&fixture.status_path).await;
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }

    #[tokio::test]
    async fn panic_cleanup_destroy_completed_does_not_remove_reinserted_active_run() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let completed_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        fixture.status.add_run(run_id, completed_sandbox_id).await;
        fixture.status.add_run(run_id, current_sandbox_id).await;
        fixture
            .tokens
            .lock()
            .await
            .insert(run_id, CancellationToken::new());
        cleanup_state.mark_destroy_completed();

        fixture
            .cleanup(run_id, completed_sandbox_id, cleanup_state)
            .await;

        assert!(!fixture.tokens.lock().await.contains_key(&run_id));
        assert_eq!(
            status_active_run_records(&fixture.status_path).await,
            vec![(run_id.to_string(), current_sandbox_id.to_string())],
        );
        assert_eq!(fixture.orphans.len(), 0);
    }

    #[tokio::test]
    async fn panic_cleanup_idle_pool_owned_refreshes_idle_status_before_removing_active() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox: Box::new(MockSandbox::new("idle-owned-cleanup")),
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                session_id: "sess-idle-owned-cleanup".into(),
                sandbox_id,
                profile_name: "vm0/default".into(),
                device_rate_limits: None,
                budget_lease: lease,
                source_ip: "10.0.0.1".into(),
                storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
            });
        assert!(matches!(
            fixture.idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        fixture.status.add_run(run_id, sandbox_id).await;
        fixture
            .tokens
            .lock()
            .await
            .insert(run_id, CancellationToken::new());
        cleanup_state.mark_idle_pool_owned();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.lock().await.contains_key(&run_id));
        let (idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&fixture.status_path).await;
        assert_eq!(idle_sessions, vec!["sess-idle-owned-cleanup"]);
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }
}
