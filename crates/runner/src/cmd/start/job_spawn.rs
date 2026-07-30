//! Claimed job task spawning, completion, and panic cleanup.
//!
//! Discovery and idle reuse decide when a claimed job should start. This module
//! owns the spawned task body: executor orchestration, provider completion,
//! deferred telemetry/network-log uploads, and outer-task panic cleanup.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use super::active_sessions::{ActiveCliAgentSessionGuard, ActiveCliAgentSessions};
use super::factory_lifecycle::SharedFactory;
use super::heartbeat::HeldSessionStateSnapshot;
use super::idle_lifecycle::SharedIdlePool;
use super::job_lifecycle::{
    ActiveBudgetLease, CompletionPayload, CompletionReady, RunCleanupDisposition, RunCleanupState,
};
use super::job_terminal_log::log_terminal_job_outcome;
use super::orphan_reap::OrphanedActiveRuns;
use super::ownership::{OwnershipTransitions, RunSandbox};
use super::sandbox_finalization::{FinalizeContext, finalize_sandbox_for_completion};
#[cfg(test)]
use super::{OuterJobPanicPoint, StartLoopTestObserver, maybe_panic_outer_job};
use crate::executor::{
    self, ExecutorConfig, RunnerPreSpawnPhase, RunnerPreSpawnTiming, SessionHistoryRestorePlan,
};
use crate::idle_pool::{ParkingGate, ReusableIdleSandbox};
use crate::ids::RunId;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_logs;
use crate::provider::{ClaimedJob, CompletionAuth, JobProvider};
use crate::resource_budget::BudgetLease;
use crate::run_cancellation::{RunCancellationHandle, RunCancellationRegistration};
use crate::status::StatusTracker;
use crate::storage_fingerprints::StorageFingerprints;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, SandboxReuseResult};

/// Per-job profile parameters resolved from the profile config.
pub(super) struct JobProfile {
    pub(super) profile_name: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) workspace_disk_mb: u32,
    pub(super) budget_lease: BudgetLease,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: SharedFactory,
    pub(super) cancellation: RunCancellationRegistration,
}

/// Shared state passed to each spawned job task.
pub(super) struct SpawnContext {
    pub(super) provider: Arc<dyn JobProvider>,
    pub(super) exec_config: Arc<ExecutorConfig>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) status: Arc<StatusTracker>,
    pub(super) orphaned_active_runs: OrphanedActiveRuns,
    /// Current lifecycle parking permission. This is checked at job
    /// completion so soft-drain/resume races do not depend on a stale
    /// spawn-time mode snapshot.
    pub(super) parking_gate: ParkingGate,
    /// Notifies the main loop to send an immediate heartbeat after session
    /// affinity state changes. This eliminates the up-to-10s blind spot where
    /// the server does not know which runner holds a session VM or workspace
    /// image cache.
    pub(super) park_notify: Arc<tokio::sync::Notify>,
    /// Best-effort signal for the main loop to ask mitmproxy to flush usage.
    pub(super) usage_flush_tx: mpsc::Sender<()>,
    pub(super) active_cli_agent_sessions: ActiveCliAgentSessions,
    pub(super) held_session_snapshot: HeldSessionStateSnapshot,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    #[cfg(test)]
    pub(super) outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    pub(super) test_observer: StartLoopTestObserver,
}

pub(super) struct SpawnJobRequest {
    pub(super) claimed: ClaimedJob,
    pub(super) sandbox_id: SandboxId,
    pub(super) job_profile: JobProfile,
    pub(super) reuse_entry: Option<ReusableIdleSandbox>,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) pre_spawn_timing: RunnerPreSpawnTiming,
    pub(super) session_history_restore_plan: SessionHistoryRestorePlan,
    pub(super) active_cli_agent_session_guard: ActiveCliAgentSessionGuard,
}

struct ExecutorInvocation {
    run_id: RunId,
    sandbox_id: SandboxId,
    context: ExecutionContext,
    exec_config: Arc<ExecutorConfig>,
    params: executor::JobParams,
    factory: SharedFactory,
    reuse_entry: Option<ReusableIdleSandbox>,
    reuse_result: SandboxReuseResult,
    pre_spawn_timing: RunnerPreSpawnTiming,
    session_history_restore_plan: SessionHistoryRestorePlan,
    cancel: CancellationToken,
    sandbox_token: String,
    sandbox_prepared: Option<executor::SandboxPreparedNotifier>,
    active_input_source: Option<crate::active_input::ActiveInputSource>,
}

struct ExecutorPhaseOutcome {
    outcome: executor::ExecuteOutcome,
    exit_code: i32,
    err: Option<String>,
    telemetry: JobTelemetry,
}

impl ExecutorInvocation {
    async fn execute(self) -> ExecutorPhaseOutcome {
        let Self {
            run_id,
            sandbox_id,
            context,
            exec_config,
            params,
            factory,
            reuse_entry,
            reuse_result,
            pre_spawn_timing,
            session_history_restore_plan,
            cancel,
            sandbox_token,
            sandbox_prepared,
            active_input_source,
        } = self;
        let exec_config_for_panic = Arc::clone(&exec_config);
        let cancel_for_executor = cancel.clone();

        // Inner spawn isolates panics: if execute_job panics, the outer task
        // still reports completion and releases budget.
        let inner = tokio::spawn(async move {
            if let Some(idle_entry) = reuse_entry {
                executor::execute_job_reuse_with_hooks(
                    idle_entry,
                    context,
                    &exec_config,
                    &params,
                    cancel_for_executor,
                    executor::ExecutionHooks {
                        sandbox_prepared: None,
                        active_input_source,
                        pre_spawn_timing: Some(pre_spawn_timing),
                        session_history_restore_plan,
                    },
                )
                .await
            } else {
                executor::execute_job_with_prepared_notifier(
                    &**factory,
                    context,
                    executor::NewSandboxDispatch {
                        id: sandbox_id,
                        reuse_result,
                    },
                    &exec_config,
                    &params,
                    cancel_for_executor,
                    executor::ExecutionHooks {
                        sandbox_prepared,
                        active_input_source,
                        pre_spawn_timing: Some(pre_spawn_timing),
                        session_history_restore_plan,
                    },
                )
                .await
            }
        });

        match inner.await {
            Ok((mut outcome, telemetry)) => {
                if cancel.is_cancelled() {
                    outcome.mark_cancelled();
                }
                let exit_code = outcome.exit_code();
                let err = outcome.error().map(ToOwned::to_owned);
                ExecutorPhaseOutcome {
                    outcome,
                    exit_code,
                    err,
                    telemetry,
                }
            }
            Err(e) => {
                if let Some(refresh) = exec_config_for_panic.network_policy_refresh.as_ref() {
                    refresh.unregister_run(run_id).await;
                }
                // Panic lost the in-flight telemetry buffer; substitute an
                // empty collector so the post-complete flush path stays
                // unconditional. `flush` early-returns on empty pending_ops.
                let telemetry =
                    JobTelemetry::new(exec_config_for_panic.http.clone(), run_id, sandbox_token);
                let failure =
                    executor::ExecutionFailure::from_error(format!("executor task panicked: {e}"));
                let exit_code = failure.exit_code;
                let err = Some(failure.error.clone());
                ExecutorPhaseOutcome {
                    outcome: executor::ExecuteOutcome {
                        failure: Some(failure),
                        sandbox: None,
                        source_ip: String::new(),
                        network_log_session: None,
                        workspace_image: None,
                        discovered_cli_agent_session_id: None,
                        restored_session_identity: None,
                    },
                    exit_code,
                    err,
                    telemetry,
                }
            }
        }
    }
}

struct FinalizationPhase {
    run_id: RunId,
    sandbox_id: SandboxId,
    completion_auth: CompletionAuth,
    active_lease: BudgetLease,
    reuse_result: SandboxReuseResult,
    workspace_disk_mb: u32,
    profile_name: String,
    cli_agent_session_id: Option<String>,
    storage_fingerprints: StorageFingerprints,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    factory: SharedFactory,
    idle_pool: SharedIdlePool,
    status: Arc<StatusTracker>,
    park_notify: Arc<tokio::sync::Notify>,
    held_session_snapshot: HeldSessionStateSnapshot,
    parking_gate: ParkingGate,
    network_log_drain: NetworkLogDrainCoordinator,
    cancel: RunCancellationHandle,
    cleanup_state: RunCleanupState,
    #[cfg(test)]
    outer_job_panic: Option<OuterJobPanicPoint>,
    #[cfg(test)]
    test_observer: StartLoopTestObserver,
}

struct FinalizedJob {
    completion_ready: CompletionReady,
    telemetry: JobTelemetry,
}

impl FinalizationPhase {
    async fn finalize(self, executor_result: ExecutorPhaseOutcome) -> FinalizedJob {
        let Self {
            run_id,
            sandbox_id,
            completion_auth,
            active_lease,
            reuse_result,
            workspace_disk_mb,
            profile_name,
            cli_agent_session_id,
            storage_fingerprints,
            device_rate_limits,
            factory,
            idle_pool,
            status,
            park_notify,
            held_session_snapshot,
            parking_gate,
            network_log_drain,
            cancel,
            cleanup_state,
            #[cfg(test)]
            outer_job_panic,
            #[cfg(test)]
            test_observer,
        } = self;
        let ExecutorPhaseOutcome {
            outcome,
            exit_code,
            err,
            mut telemetry,
        } = executor_result;
        let executor::ExecuteOutcome {
            failure: _,
            sandbox,
            source_ip,
            network_log_session,
            workspace_image,
            discovered_cli_agent_session_id,
            restored_session_identity,
        } = outcome;
        let has_restored_session_identity = restored_session_identity.is_some();
        let cleanup_state_after_finalize = cleanup_state.clone();

        let completion_payload = CompletionPayload::new(
            run_id,
            exit_code,
            err,
            sandbox_id,
            reuse_result,
            completion_auth,
        );
        // Cancellation can arrive after terminal logging or while
        // `sandbox.park()` is in flight. Pass the live handle so finalization
        // can synchronize the final idle-pool ownership transfer.
        let completion_ready = finalize_sandbox_for_completion(
            sandbox,
            ActiveBudgetLease::new(active_lease),
            completion_payload,
            FinalizeContext {
                run_id,
                sandbox_id,
                profile_name,
                cli_agent_session_id,
                discovered_cli_agent_session_id,
                restored_session_identity,
                source_ip,
                network_log_session,
                workspace_image,
                workspace_image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
                storage_fingerprints,
                device_rate_limits,
                factory,
                idle_pool,
                status,
                park_notify,
                held_session_snapshot,
                parking_gate,
                network_log_drain,
                exit_code,
                cancel,
                cleanup_state,
                #[cfg(test)]
                outer_job_panic,
                #[cfg(test)]
                test_observer,
            },
        )
        .await;
        record_session_history_identity_park_telemetry(
            &mut telemetry,
            cleanup_state_after_finalize.disposition(),
            has_restored_session_identity,
        );

        FinalizedJob {
            completion_ready,
            telemetry,
        }
    }
}

fn record_session_history_identity_park_telemetry(
    telemetry: &mut JobTelemetry,
    disposition: RunCleanupDisposition,
    has_restored_session_identity: bool,
) {
    if !matches!(disposition, RunCleanupDisposition::IdlePoolOwned) {
        return;
    }
    let action_type = if has_restored_session_identity {
        "session_history_identity_parked"
    } else {
        "session_history_identity_park_missing"
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

struct CompletionPhase {
    run_id: RunId,
    provider: Arc<dyn JobProvider>,
    status: Arc<StatusTracker>,
    usage_flush_tx: mpsc::Sender<()>,
    park_notify: Arc<tokio::sync::Notify>,
    active_cli_agent_session_guard: ActiveCliAgentSessionGuard,
    cleanup_state: RunCleanupState,
}

impl CompletionPhase {
    async fn complete(self, completion_ready: CompletionReady) {
        let Self {
            run_id,
            provider,
            status,
            usage_flush_tx,
            park_notify,
            active_cli_agent_session_guard,
            cleanup_state,
        } = self;

        // Structural guarantee: claim (in provider) is always paired with complete.
        signal_usage_flush(run_id, &usage_flush_tx);
        let ownership = OwnershipTransitions::new(status.as_ref());
        let session_affinity_changed = completion_ready.session_affinity_changed();
        completion_ready
            .complete_and_release(provider.as_ref(), &ownership, &cleanup_state)
            .await;
        drop(active_cli_agent_session_guard);
        if session_affinity_changed {
            park_notify.notify_one();
        }
    }
}

struct DeferredUploadPhase {
    run_id: RunId,
    sandbox_token: String,
    exec_config: Arc<ExecutorConfig>,
}

impl DeferredUploadPhase {
    async fn flush(self, telemetry: JobTelemetry) {
        let Self {
            run_id,
            sandbox_token,
            exec_config,
        } = self;

        // Best-effort telemetry, deferred past `provider.complete` so the
        // user-visible run-complete signal isn't blocked on these uploads.
        // They're still awaited (not spawned) so the surrounding `jobs`
        // JoinSet drains them on graceful shutdown: no data loss on SIGTERM.
        // Telemetry flush runs concurrently with best-effort network-log upload.
        // The job finalizer already closed the local Rust-side DNS/kmsg
        // session before sandbox reuse/release. Keep this flush as a
        // defensive no-op for any accepted writes still finishing.
        let network_log_path = exec_config.log_paths.network_log(run_id);
        let network_log_upload = async {
            exec_config
                .network_log_manager
                .flush_path(&network_log_path)
                .await;
            if let Some(mitm_jsonl_flush) = exec_config.mitm_jsonl_flush.as_ref() {
                let flushed = mitm_jsonl_flush.flush_path(&network_log_path).await;
                if !flushed {
                    warn!(
                        run_id = %run_id,
                        path = %network_log_path.display(),
                        "proxy network log flush did not complete before upload"
                    );
                }
            }
            network_logs::upload_network_logs(
                &exec_config.http,
                run_id,
                &sandbox_token,
                &network_log_path,
            )
            .await;
        };
        tokio::join!(telemetry.flush(), network_log_upload,);
    }
}

/// Spawn a job executor task.
///
/// The provider has already claimed the job and the caller has reserved
/// resources in the budget. The spawned task runs the executor, reports
/// completion through the provider, and delegates the post-executor
/// park-or-destroy decision to [`finalize_sandbox_for_completion`].
///
/// If `reuse_entry` is `Some`, the job reuses an existing idle sandbox.
/// Otherwise it creates a new one via the factory.
///
/// A sandbox is considered for idle parking only after a successful, uncancelled
/// execution while parking is open and a validated supplied or discovered CLI
/// agent session id is available. Park failure, cancellation before idle-pool
/// transfer, or pool rejection falls back to destruction.
///
/// The completion state returned by finalization carries
/// [`BudgetOwnership`](super::job_lifecycle::BudgetOwnership). Non-accepted paths
/// keep the active lease through provider completion and active-status removal,
/// then release it. An accepted idle entry owns and retains the lease until reuse
/// or destruction.
pub(super) fn spawn_job(
    request: SpawnJobRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<RunCancellationRegistration>,
) {
    let started_at = Instant::now();
    let SpawnJobRequest {
        claimed,
        sandbox_id,
        job_profile,
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        session_history_restore_plan,
        active_cli_agent_session_guard,
    } = request;
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    let cli_agent_session_id = if executor::validate_resume_session_id(&context).is_ok() {
        context.cli_agent_session_id().map(String::from)
    } else {
        None
    };
    let vcpu = job_profile.vcpu;
    let memory_mb = job_profile.memory_mb;
    let workspace_disk_mb = job_profile.workspace_disk_mb;
    let active_lease = job_profile.budget_lease;
    let profile_name = job_profile.profile_name;
    let factory = job_profile.factory;
    let cancellation = job_profile.cancellation;
    let job_cancel = cancellation.handle();
    let params = executor::JobParams {
        profile_name: profile_name.clone(),
        vcpu,
        memory_mb,
        workspace_disk_mb,
        restore_guest_state: job_profile.restore_guest_state,
        device_rate_limits: job_profile.device_rate_limits.clone(),
    };
    let job_device_rate_limits = params.device_rate_limits.clone();

    let storage_fingerprints = context
        .storage_manifest
        .as_ref()
        .map(crate::storage_fingerprints::StorageFingerprints::from_manifest)
        .unwrap_or_default();

    let provider = Arc::clone(&ctx.provider);
    let exec_config = Arc::clone(&ctx.exec_config);
    let status = Arc::clone(&ctx.status);
    let idle_pool = Arc::clone(&ctx.idle_pool);
    let park_notify = Arc::clone(&ctx.park_notify);
    let held_session_snapshot = ctx.held_session_snapshot.clone();
    let usage_flush_tx = ctx.usage_flush_tx.clone();
    let parking_gate = ctx.parking_gate.clone();
    let cleanup_state = RunCleanupState::new();
    let cleanup_state_for_body = cleanup_state.clone();
    let cleanup_state_for_panic = cleanup_state.clone();
    let status_for_panic = Arc::clone(&status);
    let idle_pool_for_panic = Arc::clone(&idle_pool);
    let orphaned_active_runs_for_panic = ctx.orphaned_active_runs.clone();
    #[cfg(test)]
    let outer_job_panic = ctx.outer_job_panic;
    #[cfg(test)]
    let test_observer = ctx.test_observer.clone();

    // Captured for the executor panic-arm empty `JobTelemetry`, the final
    // `telemetry.flush()`, and the network-log upload. `context` gets moved
    // into the executor phase, so snapshot the token before spawning.
    let sandbox_token = context.sandbox_token.clone();
    let reused = reuse_entry.is_some();
    let sandbox_prepared = if reused {
        None
    } else {
        let status_for_prepared = Arc::clone(&status);
        Some(executor::SandboxPreparedNotifier::new(
            move |run_id, sandbox_id| {
                let status = Arc::clone(&status_for_prepared);
                async move {
                    if !status
                        .mark_run_running_if_matching(run_id, sandbox_id)
                        .await
                    {
                        warn!(
                            run_id = %run_id,
                            sandbox_id = %sandbox_id,
                            "sandbox prepared after active run status changed"
                        );
                    }
                }
                .boxed()
            },
        ))
    };
    let mut executor = ExecutorInvocation {
        run_id,
        sandbox_id,
        context,
        exec_config: Arc::clone(&exec_config),
        params,
        factory: Arc::clone(&factory),
        reuse_entry,
        reuse_result,
        pre_spawn_timing,
        session_history_restore_plan,
        cancel: job_cancel.token(),
        sandbox_token: sandbox_token.clone(),
        sandbox_prepared,
        active_input_source,
    };
    let finalization = FinalizationPhase {
        run_id,
        sandbox_id,
        completion_auth,
        active_lease,
        reuse_result,
        workspace_disk_mb,
        profile_name,
        cli_agent_session_id,
        storage_fingerprints,
        device_rate_limits: job_device_rate_limits,
        factory,
        idle_pool: Arc::clone(&idle_pool),
        status: Arc::clone(&status),
        park_notify: Arc::clone(&park_notify),
        held_session_snapshot,
        parking_gate,
        network_log_drain: exec_config.network_log_drain.clone(),
        cancel: job_cancel.clone(),
        cleanup_state: cleanup_state_for_body.clone(),
        #[cfg(test)]
        outer_job_panic,
        #[cfg(test)]
        test_observer,
    };
    let deferred_upload = DeferredUploadPhase {
        run_id,
        sandbox_token,
        exec_config: Arc::clone(&exec_config),
    };

    executor
        .pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::SpawnJobSetup, started_at);
    executor.pre_spawn_timing.mark_task_enqueued();
    jobs.spawn(async move {
        let mut active_cli_agent_session_guard = active_cli_agent_session_guard;
        let body = async move {
            #[cfg(test)]
            maybe_panic_outer_job(outer_job_panic, OuterJobPanicPoint::ActiveOrUnknown, run_id);

            let executor_result = executor.execute().await;
            if let Some(discovered_cli_agent_session_id) = executor_result
                .outcome
                .discovered_cli_agent_session_id
                .as_deref()
            {
                active_cli_agent_session_guard.activate_late(discovered_cli_agent_session_id);
            }
            let cancelled_for_log = job_cancel.is_cancelled();
            log_terminal_job_outcome(
                run_id,
                executor_result.exit_code,
                reused,
                cancelled_for_log,
                executor_result.outcome.failure.as_ref(),
            );

            let FinalizedJob {
                completion_ready,
                telemetry,
            } = finalization.finalize(executor_result).await;
            CompletionPhase {
                run_id,
                provider,
                status,
                usage_flush_tx,
                park_notify,
                active_cli_agent_session_guard,
                cleanup_state: cleanup_state_for_body,
            }
            .complete(completion_ready)
            .await;
            deferred_upload.flush(telemetry).await;
        };

        match AssertUnwindSafe(body).catch_unwind().await {
            Ok(()) => cancellation,
            Err(payload) => {
                let cleanup = cleanup_panicked_job(
                    run_id,
                    sandbox_id,
                    cancellation,
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

fn signal_usage_flush(run_id: RunId, usage_flush_tx: &mpsc::Sender<()>) {
    match usage_flush_tx.try_send(()) {
        Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {}
        Err(mpsc::error::TrySendError::Closed(())) => {
            warn!(run_id = %run_id, "proxy usage flush signal channel closed before completion");
        }
    }
}

pub(super) async fn cleanup_panicked_job(
    run_id: RunId,
    sandbox_id: SandboxId,
    cancellation: RunCancellationRegistration,
    status: Arc<StatusTracker>,
    idle_pool: SharedIdlePool,
    cleanup_state: RunCleanupState,
    orphaned_active_runs: OrphanedActiveRuns,
) {
    cancellation.unregister().await;
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

/// Handle a completed job from the JoinSet, removing its cancellation registration.
pub(super) async fn handle_job_result(
    result: Option<Result<RunCancellationRegistration, tokio::task::JoinError>>,
) {
    match result {
        Some(Ok(cancellation)) => {
            cancellation.unregister().await;
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
    use std::sync::Arc;
    use std::time::Duration;

    use sandbox::SandboxId;

    use super::super::idle_lifecycle::SharedIdlePool;
    use super::super::job_lifecycle::RunCleanupState;
    use super::super::orphan_reap::OrphanedActiveRuns;
    use crate::http::{HttpClient, HttpClientConfig};
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult,
        test_support::ParkedIdleCandidateBuilder,
    };
    use crate::idle_reuse_preparation::mock_sandbox_ready_for_idle_reuse;
    use crate::ids::RunId;
    use crate::provider::JobCandidate;
    use crate::resource_budget::ResourceBudget;
    use crate::restored_session_identity::RestoredSessionIdentity;
    use crate::run_cancellation::RunCancellationRegistry;
    use crate::status::StatusTracker;
    use crate::types::HeartbeatState;

    struct NoopCompletionProvider;

    #[async_trait::async_trait]
    impl JobProvider for NoopCompletionProvider {
        async fn discover(&self) -> Option<JobCandidate> {
            None
        }

        async fn claim(&self, _candidate: JobCandidate) -> Option<ClaimedJob> {
            None
        }

        async fn complete(
            &self,
            _run_id: RunId,
            _exit_code: i32,
            _error: Option<&str>,
            _sandbox_id: Option<SandboxId>,
            _reuse_result: Option<SandboxReuseResult>,
            _completion_auth: CompletionAuth,
        ) {
        }

        async fn heartbeat(&self, _state: &HeartbeatState) {}

        async fn shutdown(&self) {}
    }

    fn test_http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        (budget, lease)
    }

    fn assert_telemetry_action(telemetry: &JobTelemetry, action: &str) {
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|op| op.0 == action && op.1),
            "expected telemetry action {action}, got: {ops:?}"
        );
    }

    struct FinalizationTelemetryFixture {
        _dir: tempfile::TempDir,
        status: Arc<StatusTracker>,
        idle_pool: SharedIdlePool,
        parking_gate: ParkingGate,
        park_notify: Arc<tokio::sync::Notify>,
    }

    impl FinalizationTelemetryFixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status = Arc::new(StatusTracker::new(
                dir.path().join("status.json"),
                4,
                None,
                None,
            ));
            status.write_initial().await;
            let parking_gate = ParkingGate::new_open();
            let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
                IdlePoolConfig {
                    default_timeout: Duration::from_secs(300),
                    max_idle: 10,
                },
                parking_gate.clone(),
            )));

            Self {
                _dir: dir,
                status,
                idle_pool,
                parking_gate,
                park_notify: Arc::new(tokio::sync::Notify::new()),
            }
        }

        fn finalization_phase(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            session_id: &str,
            active_lease: BudgetLease,
            cleanup_state: RunCleanupState,
        ) -> FinalizationPhase {
            FinalizationPhase {
                run_id,
                sandbox_id,
                completion_auth: CompletionAuth::local(),
                active_lease,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_disk_mb: 0,
                profile_name: "vm0/default".into(),
                cli_agent_session_id: Some(session_id.into()),
                storage_fingerprints: StorageFingerprints::default(),
                device_rate_limits: None,
                factory: Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
                idle_pool: Arc::clone(&self.idle_pool),
                status: Arc::clone(&self.status),
                park_notify: Arc::clone(&self.park_notify),
                held_session_snapshot: HeldSessionStateSnapshot::new(),
                parking_gate: self.parking_gate.clone(),
                network_log_drain: NetworkLogDrainCoordinator::noop(),
                cancel: RunCancellationHandle::new(),
                cleanup_state,
                outer_job_panic: None,
                test_observer: StartLoopTestObserver::default(),
            }
        }
    }

    fn executor_phase_outcome(
        run_id: RunId,
        sandbox_name: &str,
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ExecutorPhaseOutcome {
        ExecutorPhaseOutcome {
            outcome: executor::ExecuteOutcome {
                failure: None,
                sandbox: Some(Box::new(mock_sandbox_ready_for_idle_reuse(sandbox_name))),
                source_ip: "10.0.0.1".into(),
                network_log_session: None,
                workspace_image: None,
                discovered_cli_agent_session_id: None,
                restored_session_identity,
            },
            exit_code: 0,
            err: None,
            telemetry: JobTelemetry::new(test_http_client(), run_id, "sandbox-token".into()),
        }
    }

    #[test]
    fn generic_zero_exit_code_normalizes_to_generic_failure() {
        let failure = executor::ExecutionFailure::new(0, "", None);

        assert_eq!(failure.exit_code, 1);
        assert_eq!(failure.error, "Agent exited with code 1");
        assert_eq!(failure.kind, executor::ExecutionFailureKind::Generic);
    }

    #[test]
    fn runner_job_timeout_zero_exit_code_normalizes_to_timeout_failure() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            0,
            "",
            None,
            Duration::from_secs(7200),
            Duration::from_secs(7201),
            None,
        );

        assert_eq!(failure.exit_code, 124);
        assert_eq!(failure.error, "Agent exited with code 124");
        match failure.kind {
            executor::ExecutionFailureKind::RunnerJobTimeout {
                timeout_ms,
                elapsed_ms,
                guest_duration_ms,
            } => {
                assert_eq!(timeout_ms, 7_200_000);
                assert_eq!(elapsed_ms, 7_201_000);
                assert_eq!(guest_duration_ms, None);
            }
            executor::ExecutionFailureKind::Generic => {
                panic!("expected runner job timeout failure kind")
            }
        }
    }

    #[tokio::test]
    async fn finalization_records_identity_parked_when_idle_pool_receives_restored_identity() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let identity = RestoredSessionIdentity::claude_code_for_test("history-hash-a");
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            "sess-restore-plan",
            lease,
            cleanup_state.clone(),
        );

        let finalized = finalization
            .finalize(executor_phase_outcome(
                run_id,
                "identity-parked",
                Some(identity.clone()),
            ))
            .await;

        assert_telemetry_action(&finalized.telemetry, "session_history_identity_parked");
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
        let entry = fixture
            .idle_pool
            .lock()
            .await
            .take("sess-restore-plan")
            .expect("parked sandbox should be in idle pool");
        let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark().await else {
            panic!("parked sandbox should unpark");
        };
        assert_eq!(sandbox.restored_session_identity(), Some(&identity));
    }

    #[tokio::test]
    async fn finalization_records_identity_park_missing_when_parked_without_restored_identity() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let cleanup_state = RunCleanupState::new();
        let session_id = "sess-park-missing";
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            session_id,
            lease,
            cleanup_state.clone(),
        );

        let finalized = finalization
            .finalize(executor_phase_outcome(
                run_id,
                "identity-park-missing",
                None,
            ))
            .await;

        assert_telemetry_action(
            &finalized.telemetry,
            "session_history_identity_park_missing",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::IdlePoolOwned,
        );
        let entry = fixture
            .idle_pool
            .lock()
            .await
            .take(session_id)
            .expect("parked sandbox should be in idle pool");
        let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark().await else {
            panic!("parked sandbox should unpark");
        };
        assert!(sandbox.restored_session_identity().is_none());
    }

    #[tokio::test]
    async fn completion_notifies_again_after_releasing_active_session_guard() {
        let fixture = FinalizationTelemetryFixture::new().await;
        let (_budget, lease) = test_budget_lease();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let session_id = "sess-post-complete-refresh";
        fixture.status.add_run(run_id, sandbox_id).await;
        let finalization = fixture.finalization_phase(
            run_id,
            sandbox_id,
            session_id,
            lease,
            RunCleanupState::new(),
        );
        let finalized = finalization
            .finalize(executor_phase_outcome(
                run_id,
                "post-complete-refresh",
                None,
            ))
            .await;
        assert!(
            fixture.park_notify.notified().now_or_never().is_some(),
            "finalizer should send the early park refresh"
        );

        let active_sessions = super::super::active_sessions::new_active_cli_agent_sessions();
        let active_cli_agent_session_guard = ActiveCliAgentSessionGuard::new(
            Arc::clone(&active_sessions),
            Some(session_id.to_owned()),
        );
        let (usage_flush_tx, _usage_flush_rx) = mpsc::channel(1);

        CompletionPhase {
            run_id,
            provider: Arc::new(NoopCompletionProvider),
            status: Arc::clone(&fixture.status),
            usage_flush_tx,
            park_notify: Arc::clone(&fixture.park_notify),
            active_cli_agent_session_guard,
            cleanup_state: RunCleanupState::new(),
        }
        .complete(finalized.completion_ready)
        .await;

        assert!(
            super::super::active_sessions::active_cli_agent_session_ids(&active_sessions)
                .is_empty(),
            "completion should release the active session guard before notifying"
        );
        assert!(
            fixture.park_notify.notified().now_or_never().is_some(),
            "completion should send a post-guard-release refresh"
        );
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
        tokens: RunCancellationRegistry,
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
            let tokens = RunCancellationRegistry::new();
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
            let cancellation = self.tokens.register(run_id).await.unwrap();
            self.cleanup_with_registration(run_id, sandbox_id, cleanup_state, cancellation)
                .await;
        }

        async fn cleanup_with_registration(
            &self,
            run_id: RunId,
            sandbox_id: SandboxId,
            cleanup_state: RunCleanupState,
            cancellation: RunCancellationRegistration,
        ) {
            cleanup_panicked_job(
                run_id,
                sandbox_id,
                cancellation,
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
        cleanup_state.mark_status_removed();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.contains(run_id).await);
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
            .cleanup(run_id, sandbox_id, RunCleanupState::new())
            .await;

        assert!(!fixture.tokens.contains(run_id).await);
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
        cleanup_state.mark_destroy_completed();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.contains(run_id).await);
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
        let stale_cancellation = fixture.tokens.register(run_id).await.unwrap();
        assert!(stale_cancellation.unregister().await);
        let replacement_cancellation = fixture.tokens.register(run_id).await.unwrap();
        cleanup_state.mark_destroy_completed();

        fixture
            .cleanup_with_registration(
                run_id,
                completed_sandbox_id,
                cleanup_state,
                stale_cancellation,
            )
            .await;

        assert!(
            fixture.tokens.contains(run_id).await,
            "stale panic cleanup must preserve the replacement registration",
        );
        assert_eq!(
            status_active_run_records(&fixture.status_path).await,
            vec![(run_id.to_string(), current_sandbox_id.to_string())],
        );
        assert_eq!(fixture.orphans.len(), 0);
        assert!(replacement_cancellation.unregister().await);
    }

    #[tokio::test]
    async fn panic_cleanup_idle_pool_owned_refreshes_idle_status_before_removing_active() {
        let fixture = CleanupPanickedJobFixture::new();
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("sess-idle-owned-cleanup", lease)
            .with_mock_sandbox_name("idle-owned-cleanup")
            .with_sandbox_id(sandbox_id)
            .build();
        assert!(matches!(
            fixture.idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        fixture.status.add_run(run_id, sandbox_id).await;
        cleanup_state.mark_idle_pool_owned();

        fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

        assert!(!fixture.tokens.contains(run_id).await);
        let (idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&fixture.status_path).await;
        assert_eq!(idle_sessions, vec!["sess-idle-owned-cleanup"]);
        assert!(active_runs.is_empty());
        assert_eq!(fixture.orphans.len(), 0);
    }
}
