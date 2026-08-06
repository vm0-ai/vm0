//! Job discovery branch handling and idle-reuse admission.
//!
//! `run()` owns the provider discovery future and reactor scheduling. This
//! module owns the body that turns a discovered job into a claimed spawned job.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio::sync::OwnedMutexGuard;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::active_reuse_keys::{ActiveReuseKeyGuard, contains_active_reuse_key};
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    SharedIdlePool, add_preparing_run_with_idle_status_snapshot,
    add_running_run_with_idle_status_snapshot, destroy_idle_jobs_and_wait,
    evict_expired_idle_entries, evict_oldest_idle_entry, set_idle_status_snapshot,
    spawn_idle_destroy_job,
};
use super::job_spawn::{JobProfile, SpawnContext, SpawnJobRequest, spawn_job};
use super::pre_park_handoff_observation::{
    CandidateOutcome, CandidateReason, is_selected_finalizing_candidate,
    record_candidate_observation,
};
use crate::config::ProfileConfig;
use crate::executor::{
    ExactReuseSpeculationTiming, RunnerPreSpawnOperationTiming, RunnerPreSpawnPhase,
    RunnerPreSpawnTiming, SessionHistoryRestorePlanInput, build_session_history_restore_plan,
    restore_guest_state_with_intent, try_sync_guest_timezone_intent, validate_resume_session_id,
};
use crate::guest_timezone::{GuestTimezoneAssumption, GuestTimezoneIntent};
use crate::idle_pool::{
    DestroyOutcome, IdlePoolSnapshot, IdleUnparkResult, ReservedIdleSandbox,
    RestoreReservedIdleResult, ReusableIdleSandbox, SpeculativeIdleSandbox,
    SpeculativeIdleUnparkResult, SpeculativeReparkResult,
};
use crate::ids::RunId;
use crate::lifecycle::RunnerMode;
use crate::paths::short_digest;
use crate::provider::{ClaimedJob, JobCandidate, RunnerPreferenceReason};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::run_cancellation::{
    RunCancellationHandle, RunCancellationRegistration, RunCancellationRegistry,
};
use crate::status::StatusTracker;
use crate::types::{
    ExecutionContext, HeldWorkspaceState, SandboxReuseResult, WORKSPACE_AFFINITY_VERSION,
    reuse_key_kind,
};

pub(super) struct DiscoveredJob {
    pub(super) candidate: JobCandidate,
}

pub(super) struct DiscoveredJobContext<'a> {
    pub(super) runner_id: &'a str,
    pub(super) heartbeat_generation: u64,
    pub(super) profiles: &'a BTreeMap<String, ProfileConfig>,
    pub(super) factories: &'a BTreeMap<String, (SharedFactory, bool)>,
    pub(super) budget: &'a Arc<ResourceBudget>,
    pub(super) idle_pool: &'a SharedIdlePool,
    pub(super) status: &'a StatusTracker,
    pub(super) mode_rx: &'a tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) cancel_tokens: &'a RunCancellationRegistry,
    pub(super) spawn_ctx: &'a SpawnContext,
    pub(super) destroy_tasks: &'a mut JoinSet<bool>,
    pub(super) jobs: &'a mut JoinSet<RunCancellationRegistration>,
}

pub(super) struct DiscoveredJobResult {
    pub(super) needs_reuse_state_refresh: bool,
    pub(super) pending_candidate: Option<JobCandidate>,
}

impl DiscoveredJobResult {
    fn completed(needs_reuse_state_refresh: bool) -> Self {
        Self {
            needs_reuse_state_refresh,
            pending_candidate: None,
        }
    }

    fn pending(candidate: JobCandidate) -> Self {
        Self {
            needs_reuse_state_refresh: false,
            pending_candidate: Some(candidate),
        }
    }
}

struct LocalAdmission {
    resource: LocalAdmissionResource,
    cancellation: RunCancellationRegistration,
}

enum LocalAdmissionResource {
    Fresh(BudgetLease),
    Reusable(Box<ReservedIdleSandbox>),
    ExactSpeculative(Box<ReservedIdleSandbox>),
}

enum AdmittedResource {
    Fresh(BudgetLease),
    Reusable(Box<ReservedIdleSandbox>),
    ExactSpeculation(ExactSpeculation),
}

struct ExactSpeculation {
    outcome: ExactSpeculationOutcome,
    preparation_started_at: Instant,
    preparation_completed_at: Instant,
    claim_started_at: Instant,
    claim_returned_at: Instant,
    unpark: RunnerPreSpawnOperationTiming,
    guest_restore: Option<RunnerPreSpawnOperationTiming>,
}

struct ExactSpeculationPreparation {
    outcome: ExactSpeculationOutcome,
    started_at: Instant,
    completed_at: Instant,
    unpark: RunnerPreSpawnOperationTiming,
    guest_restore: Option<RunnerPreSpawnOperationTiming>,
}

enum ExactSpeculationOutcome {
    Prepared(Box<SpeculativeIdleSandbox>),
    Failed {
        destroy_job: Box<crate::idle_pool::IdleDestroyJob>,
        error: String,
    },
}

struct AdmittedClaim {
    claimed: ClaimedJob,
    resource: AdmittedResource,
    cancellation: RunCancellationRegistration,
    claim_returned_at: Instant,
}

struct PreparedCandidate {
    candidate: JobCandidate,
    resource: Option<LocalAdmissionResource>,
}

enum PreferencePreparation {
    Ready(PreparedCandidate),
    Pending(JobCandidate),
    Deferred,
}

struct ReuseAdmissionRequest<'a> {
    profile_name: &'a str,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    workspace_disk_mb: u32,
    context: &'a ExecutionContext,
    job_lease: BudgetLease,
}

struct ClaimAdmissionRequest<'a> {
    prepared: PreparedCandidate,
    run_id: RunId,
    profile_name: &'a str,
    job_vcpu: u32,
    job_memory: u32,
    workspace_disk_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
}

struct ReservedActivationRequest<'a> {
    run_id: RunId,
    profile_name: &'a str,
    workspace_disk_mb: u32,
    context: &'a ExecutionContext,
}

impl LocalAdmission {
    async fn rollback(self, ctx: &mut DiscoveredJobContext<'_>) {
        let Self {
            resource,
            cancellation,
        } = self;
        cancellation.unregister().await;
        rollback_untracked_resource(resource, ctx).await;
    }
}

pub(super) async fn handle_discovered_job(
    job: DiscoveredJob,
    mut ctx: DiscoveredJobContext<'_>,
) -> DiscoveredJobResult {
    let DiscoveredJob { mut candidate } = job;
    candidate.mark_main_loop_handling_started();
    let run_id = candidate.run_id();
    let profile_name = candidate.profile_name().to_owned();
    // Look up profile config for resource requirements.
    let Some(profile_config) = ctx.profiles.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
        return DiscoveredJobResult::completed(false);
    };
    let job_vcpu = profile_config.vcpu;
    let job_memory = profile_config.memory_mb;
    let job_workspace_disk_mb = profile_config.workspace_disk_mb;
    let device_rate_limits = ctx.spawn_ctx.device_rate_limits.clone();
    // Look up factory for this profile.
    let Some((factory, restore_guest_state)) = ctx.factories.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "no factory for profile, skipping");
        return DiscoveredJobResult::completed(false);
    };

    let prepared = match prepare_preference_candidate(
        candidate,
        &profile_name,
        job_vcpu,
        job_memory,
        &device_rate_limits,
        &ctx,
    )
    .await
    {
        PreferencePreparation::Ready(prepared) => prepared,
        PreferencePreparation::Pending(candidate) => {
            return DiscoveredJobResult::pending(candidate);
        }
        PreferencePreparation::Deferred => return DiscoveredJobResult::completed(false),
    };
    let Some(admission) = claim_with_local_admission(
        ClaimAdmissionRequest {
            prepared,
            run_id,
            profile_name: &profile_name,
            job_vcpu,
            job_memory,
            workspace_disk_mb: job_workspace_disk_mb,
            device_rate_limits: &device_rate_limits,
        },
        &mut ctx,
    )
    .await
    else {
        return DiscoveredJobResult::completed(false);
    };
    let AdmittedClaim {
        claimed,
        resource,
        cancellation,
        claim_returned_at,
    } = admission;
    if cancellation.handle().is_cancelled()
        && matches!(&resource, AdmittedResource::ExactSpeculation(_))
    {
        complete_claimed_without_sandbox(
            claimed,
            cancellation,
            resource,
            job_workspace_disk_mb,
            None,
            crate::executor::ExecutionFailure::cancelled(),
            &mut ctx,
        )
        .await;
        return DiscoveredJobResult::completed(true);
    }
    let mut pre_spawn_timing = RunnerPreSpawnTiming::start_at(claim_returned_at);
    let started_at = Instant::now();
    let resume_session_error = validate_resume_session_id(claimed.context()).err();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ResumeSessionValidation, started_at);
    if let Some(error) = resume_session_error {
        let needs_reuse_state_refresh = matches!(
            &resource,
            AdmittedResource::Reusable(_) | AdmittedResource::ExactSpeculation(_)
        );
        complete_claimed_without_sandbox(
            claimed,
            cancellation,
            resource,
            job_workspace_disk_mb,
            None,
            crate::executor::ExecutionFailure::from_error(error),
            &mut ctx,
        )
        .await;
        return DiscoveredJobResult::completed(needs_reuse_state_refresh);
    }
    info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");
    let started_at = Instant::now();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::DeviceRateLimits, started_at);

    // Hide the claimed reuse key from heartbeats before unpark or fallback
    // cleanup can yield. Otherwise a concurrent heartbeat could briefly
    // advertise stale workspace-cache state for an active run.
    let active_reuse_key_guard = ActiveReuseKeyGuard::new(
        ctx.spawn_ctx.active_reuse_keys.clone(),
        Arc::clone(&ctx.spawn_ctx.reuse_state_notify),
        claimed.context().reuse_key().map(str::to_owned),
    );

    let (
        reuse_entry,
        active_lease,
        reuse_result,
        idle_snapshot,
        needs_reuse_state_refresh,
        activation_transfer_guard,
    ) = match resource {
        AdmittedResource::Fresh(job_lease) => {
            let (reuse_entry, active_lease, reuse_result, idle_snapshot, refresh) =
                try_reuse_from_pool(
                    run_id,
                    ReuseAdmissionRequest {
                        profile_name: &profile_name,
                        device_rate_limits: &device_rate_limits,
                        workspace_disk_mb: job_workspace_disk_mb,
                        context: claimed.context(),
                        job_lease,
                    },
                    &mut ctx,
                    &mut pre_spawn_timing,
                )
                .await;
            (
                reuse_entry,
                active_lease,
                reuse_result,
                idle_snapshot,
                refresh,
                None,
            )
        }
        AdmittedResource::Reusable(reservation) => {
            match activate_reserved_idle(
                *reservation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    workspace_disk_mb: job_workspace_disk_mb,
                    context: claimed.context(),
                },
                &mut ctx,
                &mut pre_spawn_timing,
            )
            .await
            {
                ReservedActivation::Ready {
                    reuse_entry,
                    active_lease,
                    reuse_result,
                    idle_snapshot,
                } => (
                    reuse_entry.map(|entry| *entry),
                    active_lease,
                    reuse_result,
                    Some(idle_snapshot),
                    true,
                    None,
                ),
                ReservedActivation::CannotStart {
                    budget_lease,
                    reuse_result,
                    error,
                } => {
                    complete_claimed_without_sandbox(
                        claimed,
                        cancellation,
                        AdmittedResource::Fresh(budget_lease),
                        job_workspace_disk_mb,
                        Some(reuse_result),
                        crate::executor::ExecutionFailure::from_error(error),
                        &mut ctx,
                    )
                    .await;
                    return DiscoveredJobResult::completed(true);
                }
            }
        }
        AdmittedResource::ExactSpeculation(speculation) => {
            let pending = activate_speculated_exact(
                speculation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    workspace_disk_mb: job_workspace_disk_mb,
                    context: claimed.context(),
                },
                &ctx,
                &mut pre_spawn_timing,
            )
            .await;
            match finish_exact_activation(pending, &cancellation.handle(), run_id, &ctx).await {
                ExactActivation::Ready {
                    reuse_entry,
                    active_lease,
                    reuse_result,
                    idle_snapshot,
                    transfer_guard,
                } => (
                    reuse_entry.map(|entry| *entry),
                    active_lease,
                    reuse_result,
                    Some(idle_snapshot),
                    true,
                    Some(transfer_guard),
                ),
                ExactActivation::Cancelled {
                    resource,
                    reuse_result,
                } => {
                    let run_id = complete_claimed_failure(
                        claimed,
                        cancellation,
                        reuse_result,
                        crate::executor::ExecutionFailure::cancelled(),
                        &ctx,
                    )
                    .await;
                    match resource {
                        CancelledExactResource::Prepared(sandbox) => {
                            rollback_exact_speculation_outcome(
                                ExactSpeculationOutcome::Prepared(sandbox),
                                run_id,
                                job_workspace_disk_mb,
                                &mut ctx,
                            )
                            .await;
                        }
                        CancelledExactResource::Fresh(budget_lease) => drop(budget_lease),
                    }
                    return DiscoveredJobResult::completed(true);
                }
                ExactActivation::CannotStart {
                    budget_lease,
                    reuse_result,
                    error,
                } => {
                    complete_claimed_without_sandbox(
                        claimed,
                        cancellation,
                        AdmittedResource::Fresh(budget_lease),
                        job_workspace_disk_mb,
                        Some(reuse_result),
                        crate::executor::ExecutionFailure::from_error(error),
                        &mut ctx,
                    )
                    .await;
                    return DiscoveredJobResult::completed(true);
                }
            }
        }
    };

    let session_history_restore_plan =
        build_session_history_restore_plan(SessionHistoryRestorePlanInput {
            http: &ctx.spawn_ctx.exec_config.http,
            cpu: &ctx.spawn_ctx.exec_config.session_history_cpu,
            context: claimed.context(),
            cancel: cancellation.token(),
            reuse_result,
            restored_identity: reuse_entry
                .as_ref()
                .and_then(ReusableIdleSandbox::restored_session_identity),
            pre_spawn_timing: &mut pre_spawn_timing,
            probe: Some(&ctx.spawn_ctx.exec_config.session_history_probe),
        });

    // Determine sandbox_id after the reuse decision. On reuse, the sandbox keeps
    // its original identity; on a fresh create, allocate a new UUID for the
    // executor's SandboxConfig. This is the join key for doctor and kill.
    let sandbox_id = match &reuse_entry {
        Some(entry) => entry.sandbox_id(),
        None => SandboxId::new_v4(),
    };
    let started_at = Instant::now();
    publish_active_run_status(
        ctx.status,
        run_id,
        sandbox_id,
        reuse_entry.is_some(),
        idle_snapshot,
    )
    .await;
    #[cfg(test)]
    ctx.spawn_ctx
        .test_observer
        .notify_active_run_status_published(run_id);
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ActiveStatusPublish, started_at);

    let job_profile = JobProfile {
        profile_name,
        vcpu: job_vcpu,
        memory_mb: job_memory,
        workspace_disk_mb: job_workspace_disk_mb,
        budget_lease: active_lease,
        restore_guest_state: *restore_guest_state,
        device_rate_limits,
        factory: Arc::clone(factory),
        cancellation,
    };
    spawn_job(
        SpawnJobRequest {
            claimed,
            sandbox_id,
            job_profile,
            reuse_entry,
            reuse_result,
            pre_spawn_timing,
            session_history_restore_plan,
            active_reuse_key_guard,
        },
        ctx.spawn_ctx,
        ctx.jobs,
    );
    drop(activation_transfer_guard);
    DiscoveredJobResult::completed(needs_reuse_state_refresh)
}

async fn publish_active_run_status(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    reused_idle: bool,
    idle_snapshot: Option<IdlePoolSnapshot>,
) {
    if let Some(snapshot) = idle_snapshot {
        if reused_idle {
            add_running_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await;
        } else {
            add_preparing_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await;
        }
    } else {
        status.add_preparing_run(run_id, sandbox_id).await;
    }
}

async fn claim_with_local_admission(
    request: ClaimAdmissionRequest<'_>,
    ctx: &mut DiscoveredJobContext<'_>,
) -> Option<AdmittedClaim> {
    let ClaimAdmissionRequest {
        prepared,
        run_id,
        profile_name,
        job_vcpu,
        job_memory,
        workspace_disk_mb,
        device_rate_limits,
    } = request;
    let PreparedCandidate {
        mut candidate,
        resource,
    } = prepared;
    candidate.mark_local_admission_started();

    // Reserve either the exact reusable sandbox or fresh capacity before
    // claiming so a losing claim can restore all local ownership.
    let resource = match resource {
        Some(resource) => resource,
        None => {
            acquire_local_admission_resource(
                &candidate,
                profile_name,
                job_vcpu,
                job_memory,
                device_rate_limits,
                ctx,
            )
            .await?
        }
    };
    // Register cancellation before claiming so provider-side cancel channels
    // (Ably supervisor for ApiProvider, `.cancel` scan for LocalProvider) can
    // find the active job. Skip duplicate discoveries; overwriting would break
    // cancel delivery for the executor.
    let cancellation = match ctx.cancel_tokens.register(run_id).await {
        Ok(registration) => registration,
        Err(_) => {
            record_candidate_observation(
                &candidate,
                ctx.runner_id,
                ctx.heartbeat_generation,
                CandidateOutcome::ClaimLost,
                Some(CandidateReason::CancellationRegistrationConflict),
            );
            rollback_untracked_resource(resource, ctx).await;
            return None;
        }
    };

    let admission = LocalAdmission {
        resource,
        cancellation,
    };

    // This is the last reversible point before provider-side ownership.
    // Soft drain must stop new claims, while hard stop still claims and
    // cancels so provider state is completed deterministically.
    let mode = *ctx.mode_rx.borrow();
    match mode {
        RunnerMode::Running => {}
        RunnerMode::Starting => {
            record_candidate_observation(
                &candidate,
                ctx.runner_id,
                ctx.heartbeat_generation,
                CandidateOutcome::Cancelled,
                Some(CandidateReason::RunnerModeChanged),
            );
            admission.rollback(ctx).await;
            return None;
        }
        RunnerMode::Draining => {
            record_candidate_observation(
                &candidate,
                ctx.runner_id,
                ctx.heartbeat_generation,
                CandidateOutcome::Cancelled,
                Some(CandidateReason::RunnerModeChanged),
            );
            admission.rollback(ctx).await;
            return None;
        }
        RunnerMode::Stopping => {
            admission.cancellation.request_hard_cancellation().await;
        }
        RunnerMode::Stopped => {
            record_candidate_observation(
                &candidate,
                ctx.runner_id,
                ctx.heartbeat_generation,
                CandidateOutcome::Cancelled,
                Some(CandidateReason::RunnerModeChanged),
            );
            admission.rollback(ctx).await;
            return None;
        }
    }
    // claim() runs in the branch handler: non-interruptible, so a valid
    // successful claim is always paired with complete().
    let observed_candidate =
        is_selected_finalizing_candidate(&candidate, ctx.runner_id, ctx.heartbeat_generation)
            .then(|| candidate.clone());
    let LocalAdmission {
        resource,
        cancellation,
    } = admission;
    let claim_started_at = Instant::now();
    let (claimed, admitted_resource, claim_returned_at) = match resource {
        LocalAdmissionResource::Fresh(budget_lease) => {
            let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
            (
                claimed,
                AdmittedResource::Fresh(budget_lease),
                Instant::now(),
            )
        }
        LocalAdmissionResource::Reusable(reservation) => {
            let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
            (
                claimed,
                AdmittedResource::Reusable(reservation),
                Instant::now(),
            )
        }
        LocalAdmissionResource::ExactSpeculative(reservation) => {
            let claim = async {
                let claimed = ctx.spawn_ctx.provider.claim(candidate).await;
                (claimed, Instant::now())
            };
            let preparation = prepare_exact_speculation(*reservation, run_id);
            let ((claimed, claim_returned_at), preparation) = tokio::join!(claim, preparation);
            let speculation = ExactSpeculation {
                outcome: preparation.outcome,
                preparation_started_at: preparation.started_at,
                preparation_completed_at: preparation.completed_at,
                claim_started_at,
                claim_returned_at,
                unpark: preparation.unpark,
                guest_restore: preparation.guest_restore,
            };
            (
                claimed,
                AdmittedResource::ExactSpeculation(speculation),
                claim_returned_at,
            )
        }
    };
    let Some(claimed) = claimed else {
        // None means the job won't run here: either lost the race to another
        // runner, or the provider rejected the job. Release the reservation and
        // cancellation registration so the runner can continue.
        if let Some(candidate) = observed_candidate.as_ref() {
            record_candidate_observation(
                candidate,
                ctx.runner_id,
                ctx.heartbeat_generation,
                CandidateOutcome::ClaimLost,
                Some(CandidateReason::ProviderRejected),
            );
        }
        cancellation.unregister().await;
        rollback_admitted_resource(admitted_resource, run_id, workspace_disk_mb, ctx).await;
        return None;
    };
    if claimed.context().run_id != run_id {
        if let Some(candidate) = observed_candidate.as_ref() {
            record_candidate_observation(
                candidate,
                ctx.runner_id,
                ctx.heartbeat_generation,
                CandidateOutcome::ClaimLost,
                Some(CandidateReason::ProviderRunIdMismatch),
            );
        }
        warn!(
            run_id = %run_id,
            context_run_id = %claimed.context().run_id,
            "provider returned claimed job with mismatched run_id"
        );
        cancellation.unregister().await;
        rollback_admitted_resource(admitted_resource, run_id, workspace_disk_mb, ctx).await;
        return None;
    }

    if let Some(candidate) = observed_candidate.as_ref() {
        record_candidate_observation(
            candidate,
            ctx.runner_id,
            ctx.heartbeat_generation,
            CandidateOutcome::Claimed,
            None,
        );
    }

    Some(AdmittedClaim {
        claimed,
        resource: admitted_resource,
        cancellation,
        claim_returned_at,
    })
}

async fn prepare_exact_speculation(
    reservation: ReservedIdleSandbox,
    run_id: RunId,
) -> ExactSpeculationPreparation {
    let preparation_started_at = Instant::now();
    let predicted_timezone = reservation.guest_timezone_intent().clone();
    let unpark_started_at = Instant::now();
    let unpark_result = reservation.try_unpark_for_speculation(run_id).await;
    let unpark_duration = unpark_started_at.elapsed();
    let (outcome, unpark_succeeded, guest_restore) = match unpark_result {
        SpeculativeIdleUnparkResult::Ready(sandbox) => {
            let restore_started_at = Instant::now();
            let restored = AssertUnwindSafe(restore_guest_state_with_intent(
                sandbox.sandbox(),
                run_id,
                &predicted_timezone,
            ))
            .catch_unwind()
            .await;
            let restore_duration = restore_started_at.elapsed();
            let (outcome, restore_succeeded) = match restored {
                Ok(Ok(())) => (ExactSpeculationOutcome::Prepared(sandbox), true),
                Ok(Err(error)) => (
                    ExactSpeculationOutcome::Failed {
                        destroy_job: Box::new(
                            sandbox.into_destroy_job("speculative_guest_restore_failed"),
                        ),
                        error: error.to_string(),
                    },
                    false,
                ),
                Err(_) => (
                    ExactSpeculationOutcome::Failed {
                        destroy_job: Box::new(
                            sandbox.into_destroy_job("speculative_guest_restore_panicked"),
                        ),
                        error: "speculative guest restore panicked".into(),
                    },
                    false,
                ),
            };
            (
                outcome,
                true,
                Some(RunnerPreSpawnOperationTiming {
                    duration: restore_duration,
                    succeeded: restore_succeeded,
                }),
            )
        }
        SpeculativeIdleUnparkResult::Failed { destroy_job, error } => (
            ExactSpeculationOutcome::Failed { destroy_job, error },
            false,
            None,
        ),
    };
    let preparation_completed_at = Instant::now();
    ExactSpeculationPreparation {
        outcome,
        started_at: preparation_started_at,
        completed_at: preparation_completed_at,
        unpark: RunnerPreSpawnOperationTiming {
            duration: unpark_duration,
            succeeded: unpark_succeeded,
        },
        guest_restore,
    }
}

async fn prepare_preference_candidate(
    candidate: JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &DiscoveredJobContext<'_>,
) -> PreferencePreparation {
    let Some(preference) = candidate.runner_preference().cloned() else {
        return ordinary_preparation(candidate);
    };
    if preference.is_expired() {
        record_candidate_observation(
            &candidate,
            ctx.runner_id,
            ctx.heartbeat_generation,
            CandidateOutcome::Expired,
            None,
        );
        return ordinary_preparation(candidate.without_runner_preference());
    }
    let Some(reuse_key) = candidate.reuse_key().map(str::to_owned) else {
        record_candidate_observation(
            &candidate,
            ctx.runner_id,
            ctx.heartbeat_generation,
            CandidateOutcome::Mismatched,
            Some(CandidateReason::MissingReuseKey),
        );
        return ordinary_preparation(candidate.without_runner_preference());
    };

    match preference.reason() {
        RunnerPreferenceReason::ExactHistoryGeneration => {
            let Some(history_generation_run_id) = candidate.history_generation_run_id() else {
                return ordinary_preparation(candidate.without_runner_preference());
            };
            if let Some(reservation) = reserve_reusable_idle(
                &reuse_key,
                profile_name,
                device_rate_limits,
                Some(history_generation_run_id),
                ctx,
            )
            .await
            {
                return if reservation.guest_timezone_intent().is_usable_prediction() {
                    exact_speculative_preparation(candidate, reservation)
                } else {
                    reusable_preparation(candidate, reservation)
                };
            }
        }
        RunnerPreferenceReason::MatchingReuseKey => {
            if let Some(reservation) =
                reserve_reusable_idle(&reuse_key, profile_name, device_rate_limits, None, ctx).await
            {
                return reusable_preparation(candidate, reservation);
            }

            let held_workspace_states = current_local_held_workspace_states(ctx);
            let has_capable_workspace = held_workspace_states
                .iter()
                .filter(|state| state.reuse_key == reuse_key)
                .flat_map(|state| &state.workspace_caches)
                .any(|workspace| {
                    workspace.profile == profile_name
                        && workspace.workspace_affinity_version == WORKSPACE_AFFINITY_VERSION
                });
            if has_capable_workspace
                && let Some(lease) =
                    ResourceBudget::try_reserve_lease(ctx.budget, job_vcpu, job_memory)
            {
                return PreferencePreparation::Ready(PreparedCandidate {
                    candidate,
                    resource: Some(LocalAdmissionResource::Fresh(lease)),
                });
            }
        }
        RunnerPreferenceReason::FinalizingPredecessor => {
            let Some(history_generation_run_id) = candidate.history_generation_run_id() else {
                record_candidate_observation(
                    &candidate,
                    ctx.runner_id,
                    ctx.heartbeat_generation,
                    CandidateOutcome::Mismatched,
                    Some(CandidateReason::MissingHistoryGeneration),
                );
                return ordinary_preparation(candidate.without_runner_preference());
            };
            if let Some(reservation) = reserve_reusable_idle(
                &reuse_key,
                profile_name,
                device_rate_limits,
                Some(history_generation_run_id),
                ctx,
            )
            .await
            {
                return reusable_preparation(candidate, reservation);
            }

            if preference.targets(ctx.runner_id, ctx.heartbeat_generation) {
                if !contains_active_reuse_key(&ctx.spawn_ctx.active_reuse_keys, &reuse_key) {
                    record_candidate_observation(
                        &candidate,
                        ctx.runner_id,
                        ctx.heartbeat_generation,
                        CandidateOutcome::Mismatched,
                        Some(CandidateReason::InactivePredecessor),
                    );
                    return ordinary_preparation(candidate.without_runner_preference());
                }
                return defer_preference_candidate(candidate, &preference, &reuse_key, ctx, true)
                    .await;
            }
        }
    }

    defer_preference_candidate(candidate, &preference, &reuse_key, ctx, false).await
}

fn ordinary_preparation(candidate: JobCandidate) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: None,
    })
}

fn reusable_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleSandbox,
) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: Some(LocalAdmissionResource::Reusable(Box::new(reservation))),
    })
}

fn exact_speculative_preparation(
    candidate: JobCandidate,
    reservation: ReservedIdleSandbox,
) -> PreferencePreparation {
    PreferencePreparation::Ready(PreparedCandidate {
        candidate,
        resource: Some(LocalAdmissionResource::ExactSpeculative(Box::new(
            reservation,
        ))),
    })
}

async fn defer_preference_candidate(
    candidate: JobCandidate,
    preference: &crate::provider::RunnerPreference,
    reuse_key: &str,
    ctx: &DiscoveredJobContext<'_>,
    retain: bool,
) -> PreferencePreparation {
    if preference.is_expired() {
        record_candidate_observation(
            &candidate,
            ctx.runner_id,
            ctx.heartbeat_generation,
            CandidateOutcome::Expired,
            None,
        );
        return ordinary_preparation(candidate.without_runner_preference());
    }
    let delay = preference.remaining();
    info!(
        run_id = %candidate.run_id(),
        reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
        reuse_key_kind = reuse_key_kind(reuse_key),
        preference_reason = ?preference.reason(),
        delay_ms = delay.as_millis(),
        retained = retain,
        "runner preference has no qualifying local resource, deferring claim"
    );
    ctx.spawn_ctx
        .provider
        .defer_poll_until(preference.deadline())
        .await;
    if retain {
        PreferencePreparation::Pending(candidate)
    } else {
        PreferencePreparation::Deferred
    }
}

fn diagnostic_reuse_key_fingerprint(reuse_key: &str) -> String {
    short_digest(reuse_key)
}

fn current_local_held_workspace_states(ctx: &DiscoveredJobContext<'_>) -> Vec<HeldWorkspaceState> {
    ctx.spawn_ctx
        .workspace_cache_snapshot
        .current_held_workspace_states(&ctx.spawn_ctx.active_reuse_keys, None)
}

async fn acquire_local_admission_resource(
    candidate: &JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &mut DiscoveredJobContext<'_>,
) -> Option<LocalAdmissionResource> {
    loop {
        if let Some(reuse_key) = candidate.reuse_key()
            && let Some(reservation) =
                reserve_reusable_idle(reuse_key, profile_name, device_rate_limits, None, ctx).await
        {
            return Some(LocalAdmissionResource::Reusable(Box::new(reservation)));
        }

        if let Some(lease) = ResourceBudget::try_reserve_lease(ctx.budget, job_vcpu, job_memory) {
            return Some(LocalAdmissionResource::Fresh(lease));
        }

        let expired = evict_expired_idle_entries(ctx.idle_pool, ctx.status).await;
        if !expired.is_empty() {
            info!(
                run_id = %candidate.run_id(),
                count = expired.len(),
                "reclaiming expired idle VMs for candidate admission"
            );
            destroy_idle_jobs_and_wait(expired, "candidate_admission_expired").await;
            ctx.spawn_ctx.reuse_state_notify.notify_one();
            continue;
        }

        let evicted = evict_oldest_idle_entry(ctx.idle_pool, ctx.status).await?;
        info!(
            run_id = %candidate.run_id(),
            reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(evicted.reuse_key()),
            reuse_key_kind = reuse_key_kind(evicted.reuse_key()),
            profile = %evicted.profile_name(),
            vcpu = evicted.budget_vcpu(),
            memory_mb = evicted.budget_memory_mb(),
            "evicting idle VM for candidate admission"
        );
        destroy_idle_jobs_and_wait(vec![evicted], "candidate_admission_oldest").await;
        ctx.spawn_ctx.reuse_state_notify.notify_one();
    }
}

async fn reserve_reusable_idle(
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: Option<RunId>,
    ctx: &DiscoveredJobContext<'_>,
) -> Option<ReservedIdleSandbox> {
    let (reservation, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let reservation = match history_generation_run_id {
            Some(history_generation_run_id) => pool.reserve_reusable_generation(
                reuse_key,
                profile_name,
                device_rate_limits,
                history_generation_run_id,
            )?,
            None => pool.reserve_reusable(reuse_key, profile_name, device_rate_limits)?,
        };
        let snapshot = pool.status_snapshot();
        (reservation, snapshot)
    };
    set_idle_status_snapshot(ctx.status, snapshot).await;
    Some(reservation)
}

async fn rollback_untracked_resource(
    resource: LocalAdmissionResource,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    match resource {
        LocalAdmissionResource::Fresh(budget_lease) => drop(budget_lease),
        LocalAdmissionResource::Reusable(reservation)
        | LocalAdmissionResource::ExactSpeculative(reservation) => {
            let (restore_result, snapshot) = {
                let mut pool = ctx.idle_pool.lock().await;
                let restore_result = pool.restore_reserved(*reservation);
                let snapshot = pool.status_snapshot();
                (restore_result, snapshot)
            };
            set_idle_status_snapshot(ctx.status, snapshot).await;
            if let RestoreReservedIdleResult::Rejected(destroy_job) = restore_result {
                spawn_idle_destroy_job(
                    ctx.destroy_tasks,
                    *destroy_job,
                    "reserved_idle_rollback_rejected",
                );
                ctx.spawn_ctx.reuse_state_notify.notify_one();
            }
        }
    }
}

async fn rollback_admitted_resource(
    resource: AdmittedResource,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    match resource {
        AdmittedResource::Fresh(budget_lease) => drop(budget_lease),
        AdmittedResource::Reusable(reservation) => {
            rollback_untracked_resource(LocalAdmissionResource::Reusable(reservation), ctx).await;
        }
        AdmittedResource::ExactSpeculation(speculation) => {
            rollback_exact_speculation(speculation, run_id, workspace_disk_mb, ctx).await;
        }
    }
}

async fn rollback_exact_speculation(
    speculation: ExactSpeculation,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    rollback_exact_speculation_outcome(speculation.outcome, run_id, workspace_disk_mb, ctx).await;
}

async fn rollback_exact_speculation_outcome(
    outcome: ExactSpeculationOutcome,
    run_id: RunId,
    workspace_disk_mb: u32,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    let destroy_job = match outcome {
        ExactSpeculationOutcome::Prepared(sandbox) => {
            match sandbox
                .repark_for_claim_rollback(run_id, u64::from(workspace_disk_mb) * 1024 * 1024)
                .await
            {
                SpeculativeReparkResult::Reparked(reservation) => {
                    let (restore_result, snapshot) = {
                        let mut pool = ctx.idle_pool.lock().await;
                        let restore_result = pool.restore_reserved(*reservation);
                        let snapshot = pool.status_snapshot();
                        (restore_result, snapshot)
                    };
                    set_idle_status_snapshot(ctx.status, snapshot).await;
                    ctx.spawn_ctx.reuse_state_notify.notify_one();
                    match restore_result {
                        RestoreReservedIdleResult::Restored => None,
                        RestoreReservedIdleResult::Rejected(destroy_job) => Some(destroy_job),
                    }
                }
                SpeculativeReparkResult::Destroy {
                    destroy_job,
                    reason,
                    error,
                } => {
                    warn!(
                        run_id = %run_id,
                        reason,
                        error,
                        "speculative exact-reuse rollback could not restore idle ownership"
                    );
                    Some(destroy_job)
                }
            }
        }
        ExactSpeculationOutcome::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                error,
                "speculative exact-reuse preparation failed before claim resolved"
            );
            Some(destroy_job)
        }
    };
    if let Some(destroy_job) = destroy_job {
        destroy_idle_jobs_and_wait(vec![*destroy_job], "speculative_exact_reuse_claim_rollback")
            .await;
        ctx.spawn_ctx.reuse_state_notify.notify_one();
    }
}

enum ReservedActivation {
    Ready {
        reuse_entry: Option<Box<ReusableIdleSandbox>>,
        active_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        idle_snapshot: IdlePoolSnapshot,
    },
    CannotStart {
        budget_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        error: String,
    },
}

enum FreshFallbackActivation {
    Ready {
        active_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        idle_snapshot: IdlePoolSnapshot,
    },
    CannotStart {
        budget_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        error: String,
    },
}

impl From<FreshFallbackActivation> for ReservedActivation {
    fn from(activation: FreshFallbackActivation) -> Self {
        match activation {
            FreshFallbackActivation::Ready {
                active_lease,
                reuse_result,
                idle_snapshot,
            } => Self::Ready {
                reuse_entry: None,
                active_lease,
                reuse_result,
                idle_snapshot,
            },
            FreshFallbackActivation::CannotStart {
                budget_lease,
                reuse_result,
                error,
            } => Self::CannotStart {
                budget_lease,
                reuse_result,
                error,
            },
        }
    }
}

enum PendingExactActivation {
    Prepared {
        sandbox: Box<SpeculativeIdleSandbox>,
        guest_state_prepared: bool,
    },
    FreshFallback(FreshFallbackActivation),
}

impl From<FreshFallbackActivation> for PendingExactActivation {
    fn from(activation: FreshFallbackActivation) -> Self {
        Self::FreshFallback(activation)
    }
}

enum CancelledExactResource {
    Prepared(Box<SpeculativeIdleSandbox>),
    Fresh(BudgetLease),
}

enum ExactActivation {
    Ready {
        reuse_entry: Option<Box<ReusableIdleSandbox>>,
        active_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        idle_snapshot: IdlePoolSnapshot,
        transfer_guard: OwnedMutexGuard<()>,
    },
    Cancelled {
        resource: CancelledExactResource,
        reuse_result: Option<SandboxReuseResult>,
    },
    CannotStart {
        budget_lease: BudgetLease,
        reuse_result: SandboxReuseResult,
        error: String,
    },
}

async fn activate_speculated_exact(
    speculation: ExactSpeculation,
    request: ReservedActivationRequest<'_>,
    ctx: &DiscoveredJobContext<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> PendingExactActivation {
    let ReservedActivationRequest {
        run_id,
        profile_name,
        workspace_disk_mb,
        context,
    } = request;
    let ExactSpeculation {
        outcome,
        preparation_started_at,
        preparation_completed_at,
        claim_started_at,
        claim_returned_at,
        unpark,
        guest_restore,
    } = speculation;
    let overlap_started_at = preparation_started_at.max(claim_started_at);
    let overlap_completed_at = preparation_completed_at.min(claim_returned_at);
    let claim_overlap = overlap_completed_at.saturating_duration_since(overlap_started_at);
    let post_claim_remainder =
        preparation_completed_at.saturating_duration_since(claim_returned_at);
    let mut speculation_timing = ExactReuseSpeculationTiming {
        unpark,
        guest_restore,
        claim_overlap,
        post_claim_remainder,
        timezone_correction: None,
        timezone_assumption: None,
    };
    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);
    let sandbox = match outcome {
        ExactSpeculationOutcome::Prepared(sandbox) => sandbox,
        ExactSpeculationOutcome::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                error,
                "speculative exact-reuse preparation failed, destroying before fresh fallback"
            );
            return cleanup_reserved_for_fresh_fallback(
                *destroy_job,
                SandboxReuseResult::UnparkFailed,
                "speculative_exact_reuse_prepare_failed",
                ctx,
            )
            .await
            .into();
        }
    };

    let reserved_reuse_key = sandbox.reuse_key().to_owned();
    let requested_reuse_key = context.reuse_key();
    if requested_reuse_key != Some(reserved_reuse_key.as_str()) {
        warn!(
            run_id = %run_id,
            reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(&reserved_reuse_key),
            reuse_key_kind = reuse_key_kind(&reserved_reuse_key),
            "claimed reuse key does not match speculatively prepared idle VM"
        );
        return cleanup_reserved_for_fresh_fallback(
            sandbox.into_destroy_job("speculative_reuse_session_mismatch"),
            if requested_reuse_key.is_none() {
                SandboxReuseResult::NoReuseKey
            } else {
                SandboxReuseResult::PoolMiss
            },
            "speculative_reuse_session_mismatch",
            ctx,
        )
        .await
        .into();
    }

    if let Some(cache) = ctx.spawn_ctx.exec_config.workspace_cache.as_ref() {
        let started_at = Instant::now();
        let validation = sandbox.validate_workspace_promotion_identity(
            cache,
            CANONICAL_WORKING_DIR,
            u64::from(workspace_disk_mb) * 1024 * 1024,
        );
        pre_spawn_timing.record_phase_elapsed(
            RunnerPreSpawnPhase::WorkspacePromotionValidation,
            started_at,
        );
        if let Err(mismatch) = validation {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(&reserved_reuse_key),
                reuse_key_kind = reuse_key_kind(&reserved_reuse_key),
                profile = %profile_name,
                mismatch = mismatch.as_str(),
                "workspace promotion identity mismatch after speculative preparation"
            );
            return cleanup_reserved_for_fresh_fallback(
                sandbox.into_destroy_job("speculative_workspace_promotion_mismatch"),
                SandboxReuseResult::PoolMiss,
                "speculative_workspace_promotion_mismatch",
                ctx,
            )
            .await
            .into();
        }
    }

    let claimed_timezone = GuestTimezoneIntent::from_context(context);
    let assumption = sandbox.guest_timezone_intent().compare(&claimed_timezone);
    let mut correction_duration = None;
    let guest_state_prepared = match assumption {
        GuestTimezoneAssumption::Match => true,
        GuestTimezoneAssumption::Mismatch => {
            let correction_started_at = Instant::now();
            let corrected = AssertUnwindSafe(try_sync_guest_timezone_intent(
                sandbox.sandbox(),
                run_id,
                &claimed_timezone,
            ))
            .catch_unwind()
            .await;
            correction_duration = Some(correction_started_at.elapsed());
            match corrected {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    speculation_timing.timezone_correction =
                        correction_duration.map(|duration| RunnerPreSpawnOperationTiming {
                            duration,
                            succeeded: false,
                        });
                    speculation_timing.timezone_assumption = Some(assumption);
                    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);
                    warn!(
                        run_id = %run_id,
                        error = %error,
                        "speculative exact-reuse timezone correction transport failed"
                    );
                    return cleanup_reserved_for_fresh_fallback(
                        sandbox.into_destroy_job("speculative_timezone_correction_failed"),
                        SandboxReuseResult::UnparkFailed,
                        "speculative_timezone_correction_failed",
                        ctx,
                    )
                    .await
                    .into();
                }
                Err(_) => {
                    speculation_timing.timezone_correction =
                        correction_duration.map(|duration| RunnerPreSpawnOperationTiming {
                            duration,
                            succeeded: false,
                        });
                    speculation_timing.timezone_assumption = Some(assumption);
                    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);
                    warn!(
                        run_id = %run_id,
                        "speculative exact-reuse timezone correction panicked"
                    );
                    return cleanup_reserved_for_fresh_fallback(
                        sandbox.into_destroy_job("speculative_timezone_correction_panicked"),
                        SandboxReuseResult::UnparkFailed,
                        "speculative_timezone_correction_panicked",
                        ctx,
                    )
                    .await
                    .into();
                }
            }
            true
        }
        GuestTimezoneAssumption::Unknown => false,
    };
    speculation_timing.timezone_correction =
        correction_duration.map(|duration| RunnerPreSpawnOperationTiming {
            duration,
            succeeded: true,
        });
    speculation_timing.timezone_assumption = Some(assumption);
    pre_spawn_timing.record_exact_reuse_speculation(speculation_timing);

    PendingExactActivation::Prepared {
        sandbox,
        guest_state_prepared,
    }
}

async fn finish_exact_activation(
    activation: PendingExactActivation,
    cancellation: &RunCancellationHandle,
    run_id: RunId,
    ctx: &DiscoveredJobContext<'_>,
) -> ExactActivation {
    match activation {
        PendingExactActivation::Prepared {
            sandbox,
            guest_state_prepared,
        } => {
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                return ExactActivation::Cancelled {
                    resource: CancelledExactResource::Prepared(sandbox),
                    reuse_result: None,
                };
            }

            let reuse_key = sandbox.reuse_key().to_owned();
            let (reuse_entry, active_lease) = sandbox.commit(guest_state_prepared);
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(&reuse_key),
                reuse_key_kind = reuse_key_kind(&reuse_key),
                "committing speculatively prepared exact-reuse VM"
            );
            ExactActivation::Ready {
                reuse_entry: Some(Box::new(reuse_entry)),
                active_lease,
                reuse_result: SandboxReuseResult::Reused,
                idle_snapshot: ctx.idle_pool.lock().await.status_snapshot(),
                transfer_guard,
            }
        }
        PendingExactActivation::FreshFallback(FreshFallbackActivation::Ready {
            active_lease,
            reuse_result,
            idle_snapshot,
        }) => {
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                return ExactActivation::Cancelled {
                    resource: CancelledExactResource::Fresh(active_lease),
                    reuse_result: Some(reuse_result),
                };
            }
            ExactActivation::Ready {
                reuse_entry: None,
                active_lease,
                reuse_result,
                idle_snapshot,
                transfer_guard,
            }
        }
        PendingExactActivation::FreshFallback(FreshFallbackActivation::CannotStart {
            budget_lease,
            reuse_result,
            error,
        }) => {
            let transfer_guard = cancellation.transfer_guard().await;
            if cancellation.is_cancelled() {
                drop(transfer_guard);
                return ExactActivation::Cancelled {
                    resource: CancelledExactResource::Fresh(budget_lease),
                    reuse_result: Some(reuse_result),
                };
            }
            drop(transfer_guard);
            ExactActivation::CannotStart {
                budget_lease,
                reuse_result,
                error,
            }
        }
    }
}

async fn activate_reserved_idle(
    reservation: ReservedIdleSandbox,
    request: ReservedActivationRequest<'_>,
    ctx: &mut DiscoveredJobContext<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> ReservedActivation {
    let ReservedActivationRequest {
        run_id,
        profile_name,
        workspace_disk_mb,
        context,
    } = request;
    let started_at = Instant::now();
    let requested_reuse_key = context.reuse_key();
    let reserved_reuse_key = reservation.reuse_key().to_owned();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);

    if requested_reuse_key != Some(reserved_reuse_key.as_str()) {
        let reuse_result = if requested_reuse_key.is_none() {
            SandboxReuseResult::NoReuseKey
        } else {
            SandboxReuseResult::PoolMiss
        };
        let reuse_key_fingerprint = diagnostic_reuse_key_fingerprint(&reserved_reuse_key);
        warn!(
            run_id = %run_id,
            reuse_key_fingerprint = %reuse_key_fingerprint,
            reuse_key_kind = reuse_key_kind(&reserved_reuse_key),
            "claimed reuse key does not match reserved idle VM, destroying before fresh fallback"
        );
        return cleanup_reserved_for_fresh_fallback(
            reservation.into_destroy_job(),
            reuse_result,
            "reserved_reuse_session_mismatch",
            ctx,
        )
        .await
        .into();
    }

    if let Some(cache) = ctx.spawn_ctx.exec_config.workspace_cache.as_ref() {
        let started_at = Instant::now();
        let validation = reservation.validate_workspace_promotion_identity(
            cache,
            CANONICAL_WORKING_DIR,
            u64::from(workspace_disk_mb) * 1024 * 1024,
        );
        pre_spawn_timing.record_phase_elapsed(
            RunnerPreSpawnPhase::WorkspacePromotionValidation,
            started_at,
        );
        if let Err(mismatch) = validation {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(&reserved_reuse_key),
                reuse_key_kind = reuse_key_kind(&reserved_reuse_key),
                profile = %profile_name,
                mismatch = mismatch.as_str(),
                "workspace promotion identity mismatch, destroying reserved idle VM before fresh fallback"
            );
            return cleanup_reserved_for_fresh_fallback(
                reservation.into_destroy_job_without_workspace_promotion_for_mismatch(),
                SandboxReuseResult::PoolMiss,
                "reserved_reuse_workspace_promotion_mismatch",
                ctx,
            )
            .await
            .into();
        }
    }

    let started_at = Instant::now();
    let unpark_result = reservation.try_unpark_for_run(run_id).await;
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
    match unpark_result {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => {
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(&reserved_reuse_key),
                reuse_key_kind = reuse_key_kind(&reserved_reuse_key),
                "reusing pre-claim reserved idle VM for reuse key"
            );
            let idle_snapshot = ctx.idle_pool.lock().await.status_snapshot();
            ReservedActivation::Ready {
                reuse_entry: Some(sandbox),
                active_lease: budget_lease,
                reuse_result: SandboxReuseResult::Reused,
                idle_snapshot,
            }
        }
        IdleUnparkResult::Failed { destroy_job, error } => {
            warn!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(&reserved_reuse_key),
                reuse_key_kind = reuse_key_kind(&reserved_reuse_key),
                error = %error,
                "reserved idle VM unpark failed, destroying before fresh fallback"
            );
            cleanup_reserved_for_fresh_fallback(
                *destroy_job,
                SandboxReuseResult::UnparkFailed,
                "reserved_reuse_unpark_failed",
                ctx,
            )
            .await
            .into()
        }
    }
}

async fn cleanup_reserved_for_fresh_fallback(
    destroy_job: crate::idle_pool::IdleDestroyJob,
    reuse_result: SandboxReuseResult,
    cleanup_context: &'static str,
    ctx: &DiscoveredJobContext<'_>,
) -> FreshFallbackActivation {
    let cleanup = destroy_job.run_retaining_lease(cleanup_context).await;
    match cleanup.outcome {
        DestroyOutcome::Completed => FreshFallbackActivation::Ready {
            active_lease: cleanup.budget_lease,
            reuse_result,
            idle_snapshot: ctx.idle_pool.lock().await.status_snapshot(),
        },
        DestroyOutcome::Uncertain => FreshFallbackActivation::CannotStart {
            budget_lease: cleanup.budget_lease,
            reuse_result,
            error: "reserved idle sandbox cleanup was uncertain; fresh replacement was not started"
                .to_string(),
        },
    }
}

async fn complete_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    resource: AdmittedResource,
    workspace_disk_mb: u32,
    reuse_result: Option<SandboxReuseResult>,
    failure: crate::executor::ExecutionFailure,
    ctx: &mut DiscoveredJobContext<'_>,
) {
    let run_id = complete_claimed_failure(claimed, cancellation, reuse_result, failure, ctx).await;
    rollback_admitted_resource(resource, run_id, workspace_disk_mb, ctx).await;
}

async fn complete_claimed_failure(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    reuse_result: Option<SandboxReuseResult>,
    failure: crate::executor::ExecutionFailure,
    ctx: &DiscoveredJobContext<'_>,
) -> RunId {
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    drop(active_input_source);
    ctx.spawn_ctx
        .provider
        .complete(
            run_id,
            failure.exit_code,
            Some(&failure.error),
            None,
            reuse_result,
            completion_auth,
        )
        .await;
    cancellation.unregister().await;
    run_id
}

async fn try_reuse_from_pool(
    run_id: RunId,
    request: ReuseAdmissionRequest<'_>,
    ctx: &mut DiscoveredJobContext<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
) -> (
    Option<ReusableIdleSandbox>,
    BudgetLease,
    SandboxReuseResult,
    Option<IdlePoolSnapshot>,
    bool,
) {
    let ReuseAdmissionRequest {
        profile_name,
        device_rate_limits,
        workspace_disk_mb,
        context,
        job_lease,
    } = request;

    let started_at = Instant::now();
    let Some(reuse_key) = context.reuse_key() else {
        pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
        return (None, job_lease, SandboxReuseResult::NoReuseKey, None, false);
    };
    // Take the entry under the pool lock, then drop the lock before any awaits
    // so unpark does not block other take/park operations.
    let (taken, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let taken = pool.take(reuse_key);
        let snapshot = taken.as_ref().map(|_| pool.status_snapshot());
        (taken, snapshot)
    };
    let took_idle_session = taken.is_some();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
    let started_at = Instant::now();
    let claimed_workspace_cache_reuse_key = ctx.spawn_ctx.exec_config.workspace_cache.is_some()
        && ctx
            .spawn_ctx
            .workspace_cache_snapshot
            .might_contain_workspace_cache_reuse_key(reuse_key);
    pre_spawn_timing
        .record_phase_elapsed(RunnerPreSpawnPhase::WorkspaceCacheStateLookup, started_at);
    let needs_reuse_state_refresh = took_idle_session || claimed_workspace_cache_reuse_key;
    match taken {
        Some(entry)
            if entry.profile_name() == profile_name
                && entry.device_rate_limits() == device_rate_limits =>
        {
            if let Some(cache) = ctx.spawn_ctx.exec_config.workspace_cache.as_ref() {
                let started_at = Instant::now();
                let validation = entry.validate_workspace_promotion_identity(
                    cache,
                    CANONICAL_WORKING_DIR,
                    u64::from(workspace_disk_mb) * 1024 * 1024,
                );
                pre_spawn_timing.record_phase_elapsed(
                    RunnerPreSpawnPhase::WorkspacePromotionValidation,
                    started_at,
                );
                if let Err(mismatch) = validation {
                    warn!(
                        run_id = %run_id,
                        reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                        reuse_key_kind = reuse_key_kind(reuse_key),
                        profile = %profile_name,
                        mismatch = mismatch.as_str(),
                        "workspace promotion identity mismatch, destroying idle VM and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(
                        ctx.destroy_tasks,
                        entry.into_destroy_job_without_workspace_promotion_for_mismatch(),
                        "reuse_workspace_promotion_mismatch",
                    );
                    return (
                        None,
                        job_lease,
                        SandboxReuseResult::PoolMiss,
                        snapshot,
                        needs_reuse_state_refresh,
                    );
                }
            }
            let started_at = Instant::now();
            let unpark_result = entry.try_unpark_for_run(run_id).await;
            pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
            match unpark_result {
                IdleUnparkResult::Reused {
                    sandbox,
                    budget_lease,
                } => {
                    info!(
                        run_id = %run_id,
                        reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                        reuse_key_kind = reuse_key_kind(reuse_key),
                        "reusing idle VM for reuse key"
                    );
                    // Idle entry already holds budget. Drop the speculative
                    // fresh-job lease and move the idle lease to the outer job
                    // task before handing the sandbox to the executor.
                    drop(job_lease);
                    (
                        Some(*sandbox),
                        budget_lease,
                        SandboxReuseResult::Reused,
                        snapshot,
                        needs_reuse_state_refresh,
                    )
                }
                IdleUnparkResult::Failed { destroy_job, error } => {
                    warn!(
                        run_id = %run_id,
                        reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                        reuse_key_kind = reuse_key_kind(reuse_key),
                        error = %error,
                        "unpark failed, destroying idle VM and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(ctx.destroy_tasks, *destroy_job, "reuse_unpark_failed");
                    (
                        None,
                        job_lease,
                        SandboxReuseResult::UnparkFailed,
                        snapshot,
                        needs_reuse_state_refresh,
                    )
                }
            }
        }
        Some(stale) if stale.profile_name() == profile_name => {
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                reuse_key_kind = reuse_key_kind(reuse_key),
                profile = %profile_name,
                "idle VM device rate limiter mismatch, destroying"
            );
            spawn_idle_destroy_job(
                ctx.destroy_tasks,
                stale.into_destroy_job(),
                "reuse_device_limit_mismatch",
            );
            (
                None,
                job_lease,
                SandboxReuseResult::DeviceLimitMismatch,
                snapshot,
                needs_reuse_state_refresh,
            )
        }
        Some(stale) => {
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                reuse_key_kind = reuse_key_kind(reuse_key),
                old_profile = %stale.profile_name(),
                new_profile = %profile_name,
                "idle VM profile mismatch, destroying"
            );
            spawn_idle_destroy_job(
                ctx.destroy_tasks,
                stale.into_destroy_job(),
                "reuse_profile_mismatch",
            );
            (
                None,
                job_lease,
                SandboxReuseResult::ProfileMismatch,
                snapshot,
                needs_reuse_state_refresh,
            )
        }
        None => {
            info!(
                run_id = %run_id,
                reuse_key_fingerprint = %diagnostic_reuse_key_fingerprint(reuse_key),
                reuse_key_kind = reuse_key_kind(reuse_key),
                "no idle VM found for reuse key"
            );
            (
                None,
                job_lease,
                SandboxReuseResult::PoolMiss,
                None,
                needs_reuse_state_refresh,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::status::IdleVm;

    fn read_active_run_phase(path: &std::path::Path) -> String {
        let raw = std::fs::read_to_string(path).unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        status["active_runs"][0]["phase"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn idle_snapshot() -> IdlePoolSnapshot {
        IdlePoolSnapshot {
            revision: 1,
            idle_vms: vec![IdleVm {
                reuse_key: "sess-removed-from-pool".into(),
                sandbox_id: SandboxId::new_v4(),
            }],
        }
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_preparing_after_reuse_miss_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);

        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            false,
            Some(idle_snapshot()),
        )
        .await;

        assert_eq!(read_active_run_phase(&status_path), "preparing");
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_running_for_reused_idle_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);

        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            true,
            Some(idle_snapshot()),
        )
        .await;

        assert_eq!(read_active_run_phase(&status_path), "running");
    }
}
