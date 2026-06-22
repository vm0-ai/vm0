//! Claimed job task spawning, completion, and panic cleanup.
//!
//! Discovery and idle reuse decide when a claimed job should start. This module
//! owns the spawned task body: executor orchestration, provider completion,
//! deferred telemetry/network-log uploads, and outer-task panic cleanup.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use agent_diagnostics::{CliTerminationDiagnostic, FailureClass, FailureDiagnostic, FailureReason};
use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::active_sessions::{ActiveCliAgentSessionGuard, ActiveCliAgentSessions};
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::SharedIdlePool;
use super::job_lifecycle::{
    ActiveBudgetLease, CompletionPayload, CompletionReady, RunCleanupDisposition, RunCleanupState,
};
use super::orphan_reap::OrphanedActiveRuns;
use super::ownership::{OwnershipTransitions, RunSandbox};
use super::sandbox_finalization::{FinalizeContext, finalize_sandbox_for_completion};
#[cfg(test)]
use super::{OuterJobPanicPoint, StartLoopTestObserver, maybe_panic_outer_job};
use crate::executor::{self, ExecutionFailureKind, ExecutorConfig};
use crate::idle_pool::{ParkingGate, ReusableIdleSandbox};
use crate::ids::RunId;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_logs;
use crate::provider::{ClaimedJob, CompletionAuth, JobProvider};
use crate::resource_budget::BudgetLease;
use crate::run_cancellation::{RunCancellationHandle, SharedRunCancellationMap};
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
    pub(super) cancel: RunCancellationHandle,
}

/// Shared state passed to each spawned job task.
pub(super) struct SpawnContext {
    pub(super) provider: Arc<dyn JobProvider>,
    pub(super) exec_config: Arc<ExecutorConfig>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) status: Arc<StatusTracker>,
    pub(super) cancel_tokens: SharedRunCancellationMap,
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
                executor::execute_job_reuse_with_active_input_source(
                    idle_entry,
                    context,
                    &exec_config,
                    &params,
                    cancel_for_executor,
                    active_input_source,
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
                        workspace_promotable: false,
                        discovered_cli_agent_session_id: None,
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
            telemetry,
        } = executor_result;
        let executor::ExecuteOutcome {
            failure: _,
            sandbox,
            source_ip,
            network_log_session,
            workspace_image,
            workspace_promotable,
            discovered_cli_agent_session_id,
        } = outcome;

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
                source_ip,
                network_log_session,
                workspace_image,
                workspace_image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
                workspace_promotable,
                storage_fingerprints,
                device_rate_limits,
                factory,
                idle_pool,
                status,
                park_notify,
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

        FinalizedJob {
            completion_ready,
            telemetry,
        }
    }
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
        let needs_session_affinity_refresh = completion_ready.needs_session_affinity_refresh();
        completion_ready
            .complete_and_release(provider.as_ref(), &ownership, &cleanup_state)
            .await;
        drop(active_cli_agent_session_guard);
        if needs_session_affinity_refresh {
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
/// resources in the budget: this function spawns the executor, reports
/// completion via the provider, and releases the budget when done.
///
/// If `reuse_entry` is `Some`, the job reuses an existing idle sandbox.
/// Otherwise it creates a new one via the factory.
///
/// After a successful execution with a CLI agent session id available, the sandbox
/// is parked in the idle pool instead of being destroyed.
pub(super) fn spawn_job(
    request: SpawnJobRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<Option<RunId>>,
) {
    let SpawnJobRequest {
        claimed,
        sandbox_id,
        job_profile,
        reuse_entry,
        reuse_result,
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
    let job_cancel = job_profile.cancel;
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
    let usage_flush_tx = ctx.usage_flush_tx.clone();
    let parking_gate = ctx.parking_gate.clone();
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
    let executor = ExecutorInvocation {
        run_id,
        sandbox_id,
        context,
        exec_config: Arc::clone(&exec_config),
        params,
        factory: Arc::clone(&factory),
        reuse_entry,
        reuse_result,
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

fn log_terminal_job_outcome(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    cancelled: bool,
    failure: Option<&executor::ExecutionFailure>,
) {
    // Single sink for any claimed job's terminal state. Cancellation gets
    // its own info marker; every other failure is represented by a single
    // object carrying the exit code, error, and optional guest-authored diagnostic.
    match (cancelled, failure) {
        (true, _) => info!(run_id = %run_id, exit_code, reused, "job cancelled"),
        (false, Some(failure)) => {
            log_job_execution_failed(run_id, exit_code, reused, failure);
        }
        (false, None) => info!(run_id = %run_id, exit_code, reused, "job finished"),
    }
}

fn signal_usage_flush(run_id: RunId, usage_flush_tx: &mpsc::Sender<()>) {
    match usage_flush_tx.try_send(()) {
        Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {}
        Err(mpsc::error::TrySendError::Closed(())) => {
            warn!(run_id = %run_id, "proxy usage flush signal channel closed before completion");
        }
    }
}

fn log_job_execution_failed(
    run_id: RunId,
    exit_code: i32,
    reused: bool,
    failure: &executor::ExecutionFailure,
) {
    let resource_fields = JobResourceLogFields::from(failure.resource_diagnostics);

    if let ExecutionFailureKind::RunnerJobTimeout {
        timeout_ms,
        elapsed_ms,
        guest_duration_ms,
    } = failure.kind
    {
        if let Some(diagnostic) = failure.diagnostic.as_ref() {
            let failure_detail_source = diagnostic
                .failure_detail_source
                .map(|source| source.as_str());
            let failure_reason = diagnostic.failure_reason.map(|reason| reason.as_str());
            let cli_termination_fields =
                JobCliTerminationLogFields::from(diagnostic.cli_termination.as_ref());
            error!(
                run_id = %run_id,
                exit_code,
                reused,
                error = %failure.error,
                timeout_ms,
                elapsed_ms,
                guest_duration_ms,
                failure_class = diagnostic.failure_class.as_str(),
                failure_framework = diagnostic.framework.as_str(),
                failure_cli_exit_code = diagnostic.cli_exit_code,
                failure_claude_num_turns = diagnostic.claude_num_turns,
                failure_detail_source,
                failure_reason,
                cli_termination_initiator = cli_termination_fields.initiator,
                cli_termination_reason = cli_termination_fields.reason,
                cli_termination_signal_sent = cli_termination_fields.signal_sent,
                cli_termination_signal_pgid = cli_termination_fields.signal_pgid,
                cli_termination_signal_grace_ms = cli_termination_fields.signal_grace_ms,
                cli_termination_escalated = cli_termination_fields.escalated,
                cli_termination_observed_exit_code = cli_termination_fields.observed_exit_code,
                session_history_status = diagnostic.session_history_status.as_str(),
                prompt_shape = diagnostic.prompt_shape.as_str(),
                prompt_bytes = diagnostic.prompt_bytes,
                first_line_bytes = diagnostic.first_line_bytes,
                resource_failure_kind = resource_fields.resource_failure_kind,
                guest_root_fs_used_percent = resource_fields.guest_root_fs_used_percent,
                guest_root_fs_available_kb = resource_fields.guest_root_fs_available_kb,
                guest_workspace_fs_used_percent = resource_fields.guest_workspace_fs_used_percent,
                guest_memory_available_mb = resource_fields.guest_memory_available_mb,
                "runner job timed out"
            );
        } else {
            error!(
                run_id = %run_id,
                exit_code,
                reused,
                error = %failure.error,
                timeout_ms,
                elapsed_ms,
                guest_duration_ms,
                resource_failure_kind = resource_fields.resource_failure_kind,
                guest_root_fs_used_percent = resource_fields.guest_root_fs_used_percent,
                guest_root_fs_available_kb = resource_fields.guest_root_fs_available_kb,
                guest_workspace_fs_used_percent = resource_fields.guest_workspace_fs_used_percent,
                guest_memory_available_mb = resource_fields.guest_memory_available_mb,
                "runner job timed out"
            );
        }
        return;
    }

    if let Some(diagnostic) = failure.diagnostic.as_ref() {
        let failure_detail_source = diagnostic
            .failure_detail_source
            .map(|source| source.as_str());
        let failure_reason = diagnostic.failure_reason.map(|reason| reason.as_str());
        let cli_termination_fields =
            JobCliTerminationLogFields::from(diagnostic.cli_termination.as_ref());
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
                    cli_termination_initiator = cli_termination_fields.initiator,
                    cli_termination_reason = cli_termination_fields.reason,
                    cli_termination_signal_sent = cli_termination_fields.signal_sent,
                    cli_termination_signal_pgid = cli_termination_fields.signal_pgid,
                    cli_termination_signal_grace_ms = cli_termination_fields.signal_grace_ms,
                    cli_termination_escalated = cli_termination_fields.escalated,
                    cli_termination_observed_exit_code = cli_termination_fields.observed_exit_code,
                    session_history_status = diagnostic.session_history_status.as_str(),
                    prompt_shape = diagnostic.prompt_shape.as_str(),
                    prompt_bytes = diagnostic.prompt_bytes,
                    first_line_bytes = diagnostic.first_line_bytes,
                    resource_failure_kind = resource_fields.resource_failure_kind,
                    guest_root_fs_used_percent = resource_fields.guest_root_fs_used_percent,
                    guest_root_fs_available_kb = resource_fields.guest_root_fs_available_kb,
                    guest_workspace_fs_used_percent = resource_fields.guest_workspace_fs_used_percent,
                    guest_memory_available_mb = resource_fields.guest_memory_available_mb,
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
        error!(
            run_id = %run_id,
            exit_code,
            reused,
            error = %failure.error,
            resource_failure_kind = resource_fields.resource_failure_kind,
            guest_root_fs_used_percent = resource_fields.guest_root_fs_used_percent,
            guest_root_fs_available_kb = resource_fields.guest_root_fs_available_kb,
            guest_workspace_fs_used_percent = resource_fields.guest_workspace_fs_used_percent,
            guest_memory_available_mb = resource_fields.guest_memory_available_mb,
            "job execution failed"
        );
    }
}

struct JobResourceLogFields {
    resource_failure_kind: Option<&'static str>,
    guest_root_fs_used_percent: Option<u64>,
    guest_root_fs_available_kb: Option<u64>,
    guest_workspace_fs_used_percent: Option<u64>,
    guest_memory_available_mb: Option<u64>,
}

struct JobCliTerminationLogFields {
    initiator: Option<&'static str>,
    reason: Option<&'static str>,
    signal_sent: Option<&'static str>,
    signal_pgid: Option<i32>,
    signal_grace_ms: Option<u64>,
    escalated: Option<bool>,
    observed_exit_code: Option<i32>,
}

impl From<Option<&CliTerminationDiagnostic>> for JobCliTerminationLogFields {
    fn from(diagnostic: Option<&CliTerminationDiagnostic>) -> Self {
        Self {
            initiator: diagnostic.map(|diagnostic| diagnostic.initiator.as_str()),
            reason: diagnostic.map(|diagnostic| diagnostic.reason.as_str()),
            signal_sent: diagnostic
                .and_then(|diagnostic| diagnostic.signal_sent.map(|signal| signal.as_str())),
            signal_pgid: diagnostic.and_then(|diagnostic| diagnostic.signal_pgid),
            signal_grace_ms: diagnostic.and_then(|diagnostic| diagnostic.signal_grace_ms),
            escalated: diagnostic.map(|diagnostic| diagnostic.escalated),
            observed_exit_code: diagnostic.and_then(|diagnostic| diagnostic.observed_exit_code),
        }
    }
}

impl From<Option<executor::ResourceFailureDiagnostics>> for JobResourceLogFields {
    fn from(diagnostics: Option<executor::ResourceFailureDiagnostics>) -> Self {
        Self {
            resource_failure_kind: diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
                .map(executor::ResourceFailureKind::as_str),
            guest_root_fs_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_used_percent)
                .map(u64::from),
            guest_root_fs_available_kb: diagnostics
                .and_then(|diagnostics| diagnostics.guest_root_fs_available_kb),
            guest_workspace_fs_used_percent: diagnostics
                .and_then(|diagnostics| diagnostics.guest_workspace_fs_used_percent)
                .map(u64::from),
            guest_memory_available_mb: diagnostics
                .and_then(|diagnostics| diagnostics.guest_memory_available_mb),
        }
    }
}

fn is_info_level_job_failure(diagnostic: &FailureDiagnostic) -> bool {
    match diagnostic.failure_class {
        FailureClass::CliNonzero => matches!(
            diagnostic.failure_reason,
            Some(
                FailureReason::InsufficientCredits
                    | FailureReason::InvalidApiKey
                    | FailureReason::InvalidCredentials
                    | FailureReason::ProviderOverloaded
                    | FailureReason::ReconnectRequired
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
    cancel_tokens: SharedRunCancellationMap,
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
    cancel_tokens: &SharedRunCancellationMap,
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
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use agent_diagnostics::{
        AgentFramework, CliTerminationDiagnostic, CliTerminationReason, CliTerminationSignal,
        FailureClass, FailureDetailSource, PromptMetadata, SessionHistoryStatus,
    };
    use sandbox::{SandboxFactory, SandboxId};
    use sandbox_mock::{MockSandbox, MockSandboxFactory};
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

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

    fn post_result_cli_termination() -> CliTerminationDiagnostic {
        CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
            .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
            .with_observed_exit_code(143)
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

    #[test]
    fn expected_cli_failure_reasons_log_job_execution_failed_at_info() {
        for reason in [
            FailureReason::InsufficientCredits,
            FailureReason::InvalidApiKey,
            FailureReason::InvalidCredentials,
            FailureReason::ProviderOverloaded,
            FailureReason::ReconnectRequired,
            FailureReason::UsageLimit,
        ] {
            let diagnostic = job_failure_diagnostic(Some(reason));
            let failure = executor::ExecutionFailure::new(
                1,
                format!("classified failure: {}", reason.as_str()),
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
        for reason in [
            FailureReason::InvalidApiKey,
            FailureReason::InvalidCredentials,
            FailureReason::ProviderOverloaded,
            FailureReason::ReconnectRequired,
            FailureReason::UsageLimit,
        ] {
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
        assert!(!event.fields.contains_key("cli_termination_reason"));
    }

    #[test]
    fn diagnostic_failure_logs_cli_termination_fields() {
        let diagnostic =
            job_failure_diagnostic(None).with_cli_termination(post_result_cli_termination());
        let failure =
            executor::ExecutionFailure::new(143, "Agent exited with code 143", Some(diagnostic));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "cli_termination_initiator", "guest_agent");
        assert_field_eq(&event, "cli_termination_reason", "post_result_reap");
        assert_field_eq(&event, "cli_termination_signal_sent", "sigterm");
        assert_field_eq(&event, "cli_termination_signal_pgid", "1401");
        assert_field_eq(&event, "cli_termination_signal_grace_ms", "10000");
        assert_field_eq(&event, "cli_termination_escalated", "false");
        assert_field_eq(&event, "cli_termination_observed_exit_code", "143");
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

    #[test]
    fn classified_resource_failure_logs_resource_fields() {
        let failure = executor::ExecutionFailure::new(137, "Agent exited with code 137", None)
            .with_resource_diagnostics(Some(executor::ResourceFailureDiagnostics {
                failure_kind: Some(executor::ResourceFailureKind::GuestRootFilesystemFull),
                guest_root_fs_used_percent: Some(100),
                guest_root_fs_available_kb: Some(20),
                guest_workspace_fs_used_percent: Some(1),
                guest_memory_available_mb: Some(624),
            }));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "exit_code", "137");
        assert_field_eq(&event, "reused", "false");
        assert_field_eq(&event, "error", "Agent exited with code 137");
        assert_field_eq(
            &event,
            "resource_failure_kind",
            "guest_root_filesystem_full",
        );
        assert_field_eq(&event, "guest_root_fs_used_percent", "100");
        assert_field_eq(&event, "guest_root_fs_available_kb", "20");
        assert_field_eq(&event, "guest_workspace_fs_used_percent", "1");
        assert_field_eq(&event, "guest_memory_available_mb", "624");
    }

    #[test]
    fn oom_resource_failure_logs_resource_kind() {
        let failure =
            executor::ExecutionFailure::new(1, "Agent process killed by OOM killer", None)
                .with_resource_diagnostics(Some(
                    executor::ResourceFailureDiagnostics::from_failure_kind(
                        executor::ResourceFailureKind::GuestMemoryOomKilled,
                    ),
                ));

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("job execution failed")
        );
        assert_field_eq(&event, "exit_code", "1");
        assert_field_eq(&event, "error", "Agent process killed by OOM killer");
        assert_field_eq(&event, "resource_failure_kind", "guest_memory_oom_killed");
    }

    #[test]
    fn runner_job_timeout_logs_specific_terminal_message_and_fields() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "Timeout",
            None,
            Duration::from_secs(7200),
            Duration::from_millis(7_199_949),
            Some(7_200_084),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("runner job timed out")
        );
        assert_field_eq(&event, "exit_code", "124");
        assert_field_eq(&event, "reused", "false");
        assert_field_eq(&event, "error", "Timeout");
        assert_field_eq(&event, "timeout_ms", "7200000");
        assert_field_eq(&event, "elapsed_ms", "7199949");
        assert_field_eq(&event, "guest_duration_ms", "7200084");
    }

    #[test]
    fn runner_job_timeout_preserves_diagnostic_fields() {
        let diagnostic = job_failure_diagnostic(Some(FailureReason::UsageLimit))
            .with_cli_termination(post_result_cli_termination());
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "Timeout",
            Some(diagnostic),
            Duration::from_secs(7200),
            Duration::from_millis(7_200_100),
            Some(7_200_000),
        );

        let event = capture_job_failure_log(&failure);

        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("runner job timed out")
        );
        assert_field_eq(&event, "timeout_ms", "7200000");
        assert_field_eq(&event, "elapsed_ms", "7200100");
        assert_field_eq(&event, "guest_duration_ms", "7200000");
        assert_field_eq(&event, "failure_reason", "usage_limit");
        assert_field_eq(&event, "failure_class", "cli_nonzero");
        assert_field_eq(&event, "failure_framework", "codex");
        assert_field_eq(&event, "failure_detail_source", "codex_jsonl");
        assert_field_eq(&event, "session_history_status", "not_applicable");
        assert_field_eq(&event, "cli_termination_initiator", "guest_agent");
        assert_field_eq(&event, "cli_termination_reason", "post_result_reap");
        assert_field_eq(&event, "cli_termination_signal_sent", "sigterm");
        assert_field_eq(&event, "cli_termination_signal_pgid", "1401");
        assert_field_eq(&event, "cli_termination_signal_grace_ms", "10000");
        assert_field_eq(&event, "cli_termination_escalated", "false");
        assert_field_eq(&event, "cli_termination_observed_exit_code", "143");
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
        tokens: SharedRunCancellationMap,
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
            let tokens: SharedRunCancellationMap =
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
            .insert(run_id, RunCancellationHandle::new());
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
            .insert(run_id, RunCancellationHandle::new());

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
            .insert(run_id, RunCancellationHandle::new());
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
            .insert(run_id, RunCancellationHandle::new());
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
                cli_agent_session_id: "sess-idle-owned-cleanup".into(),
                sandbox_id,
                profile_name: "vm0/default".into(),
                device_rate_limits: None,
                budget_lease: lease,
                source_ip: "10.0.0.1".into(),
                storage_fingerprints: crate::storage_fingerprints::StorageFingerprints::default(),
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
            .insert(run_id, RunCancellationHandle::new());
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
