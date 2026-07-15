//! Job discovery branch handling and idle-reuse admission.
//!
//! `run()` owns the provider discovery future and reactor scheduling. This
//! module owns the body that turns a discovered job into a claimed spawned job.

use std::collections::BTreeMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::active_sessions::ActiveCliAgentSessionGuard;
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    SharedIdlePool, add_preparing_run_with_idle_status_snapshot,
    add_running_run_with_idle_status_snapshot, destroy_idle_jobs_and_wait,
    evict_expired_idle_entries, evict_oldest_idle_entry, set_idle_status_snapshot,
    spawn_idle_destroy_job,
};
use super::job_spawn::{JobProfile, SpawnContext, SpawnJobRequest, spawn_job};
use crate::config::ProfileConfig;
use crate::executor::{
    RunnerPreSpawnPhase, RunnerPreSpawnTiming, SessionHistoryCpuPool, SessionHistoryMaterializer,
    SessionHistoryProbe, SessionHistoryRestoreFallback, SessionHistoryRestorePlan,
    effective_cli_framework, validate_resume_session_id,
};
use crate::http::HttpClient;
use crate::idle_pool::{
    DestroyOutcome, IdlePoolSnapshot, IdleUnparkResult, ReservedIdleSandbox,
    RestoreReservedIdleResult, ReusableIdleSandbox,
};
use crate::ids::RunId;
use crate::paths::short_digest;
use crate::provider::{
    ClaimedJob, JobCandidate, PreLocalAdmissionOutcome, SessionHistoryGenerationRelationship,
};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::restored_session_identity::{
    RestoredSessionIdentity, RestoredSessionIdentityMismatchReason,
};
use crate::run_cancellation::{RunCancellationHandle, SharedRunCancellationMap};
use crate::status::{RunnerMode, StatusTracker};
use crate::types::{ExecutionContext, HeldSessionState, SandboxReuseResult};

pub(super) struct DiscoveredJob {
    pub(super) candidate: JobCandidate,
}

pub(super) struct DiscoveredJobContext<'a> {
    pub(super) profiles: &'a BTreeMap<String, ProfileConfig>,
    pub(super) factories: &'a BTreeMap<String, (SharedFactory, bool)>,
    pub(super) budget: &'a Arc<ResourceBudget>,
    pub(super) idle_pool: &'a SharedIdlePool,
    pub(super) status: &'a StatusTracker,
    pub(super) mode_rx: &'a tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) cancel_tokens: &'a SharedRunCancellationMap,
    pub(super) spawn_ctx: &'a SpawnContext,
    pub(super) destroy_tasks: &'a mut JoinSet<bool>,
    pub(super) jobs: &'a mut JoinSet<Option<RunId>>,
}

struct LocalAdmission {
    run_id: RunId,
    resource: LocalAdmissionResource,
    cancel: RunCancellationHandle,
}

enum LocalAdmissionResource {
    Fresh(BudgetLease),
    Reusable(Box<ReservedIdleSandbox>),
}

impl LocalAdmissionResource {
    fn session_history_generation_relationship(
        &self,
        target_generation_run_id: Option<RunId>,
    ) -> SessionHistoryGenerationRelationship {
        let Some(target_generation_run_id) = target_generation_run_id else {
            return SessionHistoryGenerationRelationship::UnknownTarget;
        };
        match self {
            Self::Fresh(_) => SessionHistoryGenerationRelationship::Fresh,
            Self::Reusable(reservation) => match reservation.history_generation_run_id() {
                Some(reserved_generation_run_id)
                    if reserved_generation_run_id == target_generation_run_id =>
                {
                    SessionHistoryGenerationRelationship::Exact
                }
                Some(_) => SessionHistoryGenerationRelationship::Different,
                None => SessionHistoryGenerationRelationship::UnknownReserved,
            },
        }
    }
}

struct AdmittedClaim {
    claimed: ClaimedJob,
    resource: LocalAdmissionResource,
    cancel: RunCancellationHandle,
}

struct PreparedAffinityCandidate {
    candidate: JobCandidate,
    exact_generation_reservation: Option<Box<ReservedIdleSandbox>>,
}

struct ReuseAdmissionRequest<'a> {
    profile_name: &'a str,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    workspace_disk_mb: u32,
    context: &'a ExecutionContext,
    resume_session_valid: bool,
    job_lease: BudgetLease,
}

struct ReservedActivationRequest<'a> {
    run_id: RunId,
    profile_name: &'a str,
    workspace_disk_mb: u32,
    context: &'a ExecutionContext,
    resume_session_valid: bool,
}

impl LocalAdmission {
    async fn rollback(self, ctx: &mut DiscoveredJobContext<'_>) {
        let Self {
            run_id,
            resource,
            cancel: _,
        } = self;
        ctx.cancel_tokens.lock().await.remove(&run_id);
        rollback_untracked_resource(resource, ctx).await;
    }

    fn into_admitted(self, claimed: ClaimedJob) -> AdmittedClaim {
        AdmittedClaim {
            claimed,
            resource: self.resource,
            cancel: self.cancel,
        }
    }
}

pub(super) async fn handle_discovered_job(
    job: DiscoveredJob,
    mut ctx: DiscoveredJobContext<'_>,
) -> bool {
    let DiscoveredJob { mut candidate } = job;
    candidate.mark_main_loop_handling_started();
    let run_id = candidate.run_id();
    let profile_name = candidate.profile_name().to_owned();
    // Look up profile config for resource requirements.
    let Some(profile_config) = ctx.profiles.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
        return false;
    };
    let job_vcpu = profile_config.vcpu;
    let job_memory = profile_config.memory_mb;
    let job_workspace_disk_mb = profile_config.workspace_disk_mb;
    let device_rate_limits = ctx.spawn_ctx.device_rate_limits.clone();
    // Look up factory for this profile.
    let Some((factory, restore_guest_state)) = ctx.factories.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "no factory for profile, skipping");
        return false;
    };

    let Some(admission) = claim_with_local_admission(
        candidate,
        run_id,
        &profile_name,
        job_vcpu,
        job_memory,
        &device_rate_limits,
        &mut ctx,
    )
    .await
    else {
        return false;
    };
    let AdmittedClaim {
        claimed,
        resource,
        cancel: job_cancel,
    } = admission;
    let mut pre_spawn_timing = RunnerPreSpawnTiming::start_after_claim();
    let started_at = Instant::now();
    let resume_session_valid = validate_resume_session_id(claimed.context()).is_ok();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::ResumeSessionValidation, started_at);
    info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");
    let started_at = Instant::now();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::DeviceRateLimits, started_at);

    // Hide the claimed session from heartbeat affinity before unpark or
    // fallback cleanup can yield. Otherwise a concurrent heartbeat could
    // briefly advertise stale workspace-cache affinity for an active session.
    let active_cli_agent_session_guard = ActiveCliAgentSessionGuard::new(
        ctx.spawn_ctx.active_cli_agent_sessions.clone(),
        if resume_session_valid {
            claimed.context().cli_agent_session_id().map(str::to_owned)
        } else {
            None
        },
    );

    let (reuse_entry, active_lease, reuse_result, idle_snapshot, needs_session_affinity_refresh) =
        match resource {
            LocalAdmissionResource::Fresh(job_lease) => {
                try_reuse_from_pool(
                    run_id,
                    ReuseAdmissionRequest {
                        profile_name: &profile_name,
                        device_rate_limits: &device_rate_limits,
                        workspace_disk_mb: job_workspace_disk_mb,
                        context: claimed.context(),
                        resume_session_valid,
                        job_lease,
                    },
                    &mut ctx,
                    &mut pre_spawn_timing,
                )
                .await
            }
            LocalAdmissionResource::Reusable(reservation) => {
                match activate_reserved_idle(
                    *reservation,
                    ReservedActivationRequest {
                        run_id,
                        profile_name: &profile_name,
                        workspace_disk_mb: job_workspace_disk_mb,
                        context: claimed.context(),
                        resume_session_valid,
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
                    ),
                    ReservedActivation::CannotStart {
                        budget_lease,
                        reuse_result,
                        error,
                    } => {
                        fail_claimed_without_sandbox(
                            claimed,
                            job_cancel,
                            budget_lease,
                            reuse_result,
                            error,
                            &ctx,
                        )
                        .await;
                        return true;
                    }
                }
            }
        };

    let session_history_restore_plan = if resume_session_valid {
        build_session_history_restore_plan(
            &ctx.spawn_ctx.exec_config.http,
            &ctx.spawn_ctx.exec_config.session_history_cpu,
            claimed.context(),
            &job_cancel,
            SessionHistoryRestoreReuse {
                entry: reuse_entry.as_ref(),
                result: reuse_result,
            },
            &mut pre_spawn_timing,
            Some(&ctx.spawn_ctx.exec_config.session_history_probe),
        )
    } else {
        SessionHistoryRestorePlan::Default
    };

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
        cancel: job_cancel,
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
            active_cli_agent_session_guard,
        },
        ctx.spawn_ctx,
        ctx.jobs,
    );
    needs_session_affinity_refresh
}

struct SessionHistoryRestoreReuse<'a> {
    entry: Option<&'a ReusableIdleSandbox>,
    result: SandboxReuseResult,
}

fn build_session_history_restore_plan(
    http: &HttpClient,
    cpu: &SessionHistoryCpuPool,
    context: &ExecutionContext,
    cancel: &RunCancellationHandle,
    reuse: SessionHistoryRestoreReuse<'_>,
    pre_spawn_timing: &mut RunnerPreSpawnTiming,
    probe: Option<&SessionHistoryProbe>,
) -> SessionHistoryRestorePlan {
    let Some(resume_session) = context.resume_session.as_ref() else {
        return SessionHistoryRestorePlan::Default;
    };
    if resume_session.history_ref().is_none() {
        return SessionHistoryRestorePlan::Default;
    }

    let mut prefix_attribution = None;
    let fallback = match reuse.result {
        SandboxReuseResult::Reused => {
            let requested_identity = RestoredSessionIdentity::from_context(context);
            if let Some(requested_identity) = requested_identity {
                match reuse
                    .entry
                    .and_then(ReusableIdleSandbox::restored_session_identity)
                {
                    Some(restored_identity)
                        if restored_identity.is_verified_match_for_request(&requested_identity) =>
                    {
                        return SessionHistoryRestorePlan::SkipVerified(restored_identity.clone());
                    }
                    Some(restored_identity) if restored_identity == &requested_identity => {
                        if restored_identity.has_final_metadata_verification() {
                            Some(SessionHistoryRestoreFallback::IdentityMismatch(
                                restored_identity.mismatch_reason_for_request(&requested_identity),
                            ))
                        } else {
                            Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                        }
                    }
                    Some(restored_identity) => {
                        let (mismatch_reason, attribution) = restored_identity
                            .mismatch_reason_and_prefix_attribution(&requested_identity);
                        prefix_attribution = attribution;
                        Some(SessionHistoryRestoreFallback::IdentityMismatch(
                            mismatch_reason,
                        ))
                    }
                    None => Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
                }
            } else {
                Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                    RestoredSessionIdentityMismatchReason::MissingRequestedIdentity,
                )))
            }
        }
        SandboxReuseResult::NoSessionId
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => Some(SessionHistoryRestoreFallback::NonReuse),
    };

    if reuse.result != SandboxReuseResult::Reused {
        return SessionHistoryRestorePlan::DeferredHashBacked { fallback };
    }

    let started_at = Instant::now();
    let materializer = match prefix_attribution {
        Some(prefix_attribution) => {
            SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
                http,
                cpu,
                Some(resume_session),
                effective_cli_framework(&context.cli_agent_type),
                cancel.token(),
                probe,
                prefix_attribution,
            )
        }
        None => SessionHistoryMaterializer::start_cancellable(
            http,
            cpu,
            Some(resume_session),
            effective_cli_framework(&context.cli_agent_type),
            cancel.token(),
            probe,
        ),
    };
    pre_spawn_timing.record_phase_elapsed(
        RunnerPreSpawnPhase::SessionHistoryMaterializerStart,
        started_at,
    );
    SessionHistoryRestorePlan::Prestarted {
        materializer,
        fallback,
    }
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
    candidate: JobCandidate,
    run_id: RunId,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &mut DiscoveredJobContext<'_>,
) -> Option<AdmittedClaim> {
    let PreparedAffinityCandidate {
        mut candidate,
        exact_generation_reservation,
    } = prepare_affinity_protected_candidate(
        candidate,
        profile_name,
        job_vcpu,
        job_memory,
        device_rate_limits,
        ctx,
    )
    .await?;
    candidate.mark_local_admission_started();

    // Reserve either the exact reusable sandbox or fresh capacity before
    // claiming so a losing claim can restore all local ownership.
    let resource = match exact_generation_reservation {
        Some(reservation) => LocalAdmissionResource::Reusable(reservation),
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

    // Insert cancel token before claiming so provider-side cancel channels
    // (Ably supervisor for ApiProvider, `.cancel` scan for LocalProvider) can
    // find the active job. Skip duplicate discoveries; overwriting would break
    // cancel delivery for the executor.
    let job_cancel = RunCancellationHandle::new();
    {
        let mut tokens = ctx.cancel_tokens.lock().await;
        match tokens.entry(run_id) {
            Entry::Occupied(_) => {
                drop(tokens);
                rollback_untracked_resource(resource, ctx).await;
                return None;
            }
            Entry::Vacant(entry) => {
                entry.insert(job_cancel.clone());
            }
        }
    }

    let admission = LocalAdmission {
        run_id,
        resource,
        cancel: job_cancel,
    };

    // This is the last reversible point before provider-side ownership.
    // Soft drain must stop new claims, while hard stop still claims and
    // cancels so provider state is completed deterministically.
    let mode = *ctx.mode_rx.borrow();
    match mode {
        RunnerMode::Running => {}
        RunnerMode::Starting => {
            admission.rollback(ctx).await;
            return None;
        }
        RunnerMode::Draining => {
            admission.rollback(ctx).await;
            return None;
        }
        RunnerMode::Stopping => {
            admission.cancel.cancel().await;
        }
        RunnerMode::Stopped => {
            admission.rollback(ctx).await;
            return None;
        }
    }
    let relationship = admission
        .resource
        .session_history_generation_relationship(candidate.history_generation_run_id());
    candidate.set_session_history_generation_relationship(relationship);
    // claim() runs in the branch handler: non-interruptible, so a valid
    // successful claim is always paired with complete().
    let Some(claimed) = ctx.spawn_ctx.provider.claim(candidate).await else {
        // None means the job won't run here: either lost the race to another
        // runner, or the provider rejected the job. Release the reservation and
        // cancel token so the runner can continue.
        admission.rollback(ctx).await;
        return None;
    };
    if claimed.context().run_id != run_id {
        warn!(
            run_id = %run_id,
            context_run_id = %claimed.context().run_id,
            "provider returned claimed job with mismatched run_id"
        );
        admission.rollback(ctx).await;
        return None;
    }

    Some(admission.into_admitted(claimed))
}

async fn prepare_affinity_protected_candidate(
    candidate: JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &DiscoveredJobContext<'_>,
) -> Option<PreparedAffinityCandidate> {
    if candidate.is_history_generation_affinity_protected()
        && let (Some(cli_agent_session_id), Some(history_generation_run_id)) = (
            candidate.cli_agent_session_id().map(str::to_owned),
            candidate.history_generation_run_id(),
        )
    {
        if let Some(reservation) = reserve_reusable_idle(
            &cli_agent_session_id,
            profile_name,
            device_rate_limits,
            Some(history_generation_run_id),
            ctx,
        )
        .await
        {
            return Some(PreparedAffinityCandidate {
                candidate: candidate
                    .with_pre_local_admission_outcome(PreLocalAdmissionOutcome::LocalHolder),
                exact_generation_reservation: Some(Box::new(reservation)),
            });
        }

        let delay = candidate
            .history_generation_affinity_protection_remaining()
            .unwrap_or_default();
        let session_fingerprint = diagnostic_session_fingerprint(&cli_agent_session_id);
        info!(
            run_id = %candidate.run_id(),
            session_fingerprint = %session_fingerprint,
            delay_ms = delay.as_millis(),
            "exact session-history generation protected by another runner, deferring claim"
        );
        ctx.spawn_ctx.provider.defer_poll_after(delay).await;
        return None;
    }

    if !candidate.is_affinity_protected() {
        return Some(PreparedAffinityCandidate {
            candidate: candidate
                .with_pre_local_admission_outcome(PreLocalAdmissionOutcome::NotProtected),
            exact_generation_reservation: None,
        });
    }
    let Some(cli_agent_session_id) = candidate.cli_agent_session_id().map(str::to_owned) else {
        return Some(PreparedAffinityCandidate {
            candidate: candidate
                .with_pre_local_admission_outcome(PreLocalAdmissionOutcome::MissingSessionMetadata),
            exact_generation_reservation: None,
        });
    };

    let has_reusable = ctx.idle_pool.lock().await.has_reusable(
        &cli_agent_session_id,
        profile_name,
        device_rate_limits,
    );
    let held_session_states = current_local_held_session_states(ctx).await;
    let has_fresh_affinity = ctx.budget.can_afford(job_vcpu, job_memory)
        && held_session_states
            .iter()
            .any(|state| state.session_id == cli_agent_session_id);
    if has_reusable || has_fresh_affinity {
        return Some(PreparedAffinityCandidate {
            candidate: candidate
                .with_pre_local_admission_outcome(PreLocalAdmissionOutcome::LocalHolder),
            exact_generation_reservation: None,
        });
    }

    let delay = candidate
        .affinity_protection_remaining()
        .unwrap_or_default();
    let session_fingerprint = diagnostic_session_fingerprint(&cli_agent_session_id);
    info!(
        run_id = %candidate.run_id(),
        session_fingerprint = %session_fingerprint,
        delay_ms = delay.as_millis(),
        "same-session affinity protected by another runner, deferring claim"
    );
    ctx.spawn_ctx.provider.defer_poll_after(delay).await;
    None
}

fn diagnostic_session_fingerprint(session_id: &str) -> String {
    short_digest(session_id)
}

async fn current_local_held_session_states(
    ctx: &DiscoveredJobContext<'_>,
) -> Vec<HeldSessionState> {
    let idle_states = {
        let pool = ctx.idle_pool.lock().await;
        pool.held_session_states()
    };
    ctx.spawn_ctx
        .held_session_snapshot
        .current_held_session_states(idle_states, &ctx.spawn_ctx.active_cli_agent_sessions, None)
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
        if let Some(session_id) = candidate.cli_agent_session_id()
            && let Some(reservation) =
                reserve_reusable_idle(session_id, profile_name, device_rate_limits, None, ctx).await
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
            ctx.spawn_ctx.park_notify.notify_one();
            continue;
        }

        let evicted = evict_oldest_idle_entry(ctx.idle_pool, ctx.status).await?;
        info!(
            run_id = %candidate.run_id(),
            session_id = %evicted.cli_agent_session_id(),
            profile = %evicted.profile_name(),
            vcpu = evicted.budget_vcpu(),
            memory_mb = evicted.budget_memory_mb(),
            "evicting idle VM for candidate admission"
        );
        destroy_idle_jobs_and_wait(vec![evicted], "candidate_admission_oldest").await;
        ctx.spawn_ctx.park_notify.notify_one();
    }
}

async fn reserve_reusable_idle(
    session_id: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: Option<RunId>,
    ctx: &DiscoveredJobContext<'_>,
) -> Option<ReservedIdleSandbox> {
    let (reservation, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let reservation = match history_generation_run_id {
            Some(history_generation_run_id) => pool.reserve_reusable_generation(
                session_id,
                profile_name,
                device_rate_limits,
                history_generation_run_id,
            )?,
            None => pool.reserve_reusable(session_id, profile_name, device_rate_limits)?,
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
        LocalAdmissionResource::Reusable(reservation) => {
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
                ctx.spawn_ctx.park_notify.notify_one();
            }
        }
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
        resume_session_valid,
    } = request;
    let started_at = Instant::now();
    let requested_session_id = context.cli_agent_session_id();
    let reserved_session_id = reservation.cli_agent_session_id().to_owned();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);

    if !resume_session_valid || requested_session_id != Some(reserved_session_id.as_str()) {
        let reuse_result = if requested_session_id.is_none() || !resume_session_valid {
            SandboxReuseResult::NoSessionId
        } else {
            SandboxReuseResult::PoolMiss
        };
        warn!(
            run_id = %run_id,
            reserved_session_id = %reserved_session_id,
            claimed_session_id = ?requested_session_id,
            "claimed session does not match reserved idle VM, destroying before fresh fallback"
        );
        return cleanup_reserved_for_fresh_fallback(
            reservation.into_destroy_job(),
            reuse_result,
            "reserved_reuse_session_mismatch",
            ctx,
        )
        .await;
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
                session_id = %reserved_session_id,
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
            .await;
        }
    }

    let started_at = Instant::now();
    let unpark_result = reservation.try_unpark().await;
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
    match unpark_result {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => {
            info!(
                run_id = %run_id,
                session_id = %reserved_session_id,
                "reusing pre-claim reserved idle VM for session"
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
                session_id = %reserved_session_id,
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
        }
    }
}

async fn cleanup_reserved_for_fresh_fallback(
    destroy_job: crate::idle_pool::IdleDestroyJob,
    reuse_result: SandboxReuseResult,
    cleanup_context: &'static str,
    ctx: &DiscoveredJobContext<'_>,
) -> ReservedActivation {
    let cleanup = destroy_job.run_retaining_lease(cleanup_context).await;
    match cleanup.outcome {
        DestroyOutcome::Completed => ReservedActivation::Ready {
            reuse_entry: None,
            active_lease: cleanup.budget_lease,
            reuse_result,
            idle_snapshot: ctx.idle_pool.lock().await.status_snapshot(),
        },
        DestroyOutcome::Uncertain => ReservedActivation::CannotStart {
            budget_lease: cleanup.budget_lease,
            reuse_result,
            error: "reserved idle sandbox cleanup was uncertain; fresh replacement was not started"
                .to_string(),
        },
    }
}

async fn fail_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancel: RunCancellationHandle,
    budget_lease: BudgetLease,
    reuse_result: SandboxReuseResult,
    error: String,
    ctx: &DiscoveredJobContext<'_>,
) {
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    let failure = crate::executor::ExecutionFailure::from_error(error);
    drop(active_input_source);
    ctx.spawn_ctx
        .provider
        .complete(
            run_id,
            failure.exit_code,
            Some(&failure.error),
            None,
            Some(reuse_result),
            completion_auth,
        )
        .await;
    ctx.cancel_tokens.lock().await.remove(&run_id);
    drop(cancel);
    drop(budget_lease);
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
        resume_session_valid,
        job_lease,
    } = request;

    let started_at = Instant::now();
    if !resume_session_valid {
        pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
        return (
            None,
            job_lease,
            SandboxReuseResult::NoSessionId,
            None,
            false,
        );
    }
    let Some(cli_agent_session_id) = context.cli_agent_session_id() else {
        pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
        return (
            None,
            job_lease,
            SandboxReuseResult::NoSessionId,
            None,
            false,
        );
    };
    // Take the entry under the pool lock, then drop the lock before any awaits
    // so unpark does not block other take/park operations.
    let (taken, snapshot) = {
        let mut pool = ctx.idle_pool.lock().await;
        let taken = pool.take(cli_agent_session_id);
        let snapshot = taken.as_ref().map(|_| pool.status_snapshot());
        (taken, snapshot)
    };
    let took_idle_session = taken.is_some();
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleReuseLookup, started_at);
    let started_at = Instant::now();
    let claimed_workspace_cache_session = ctx.spawn_ctx.exec_config.workspace_cache.is_some()
        && ctx
            .spawn_ctx
            .held_session_snapshot
            .might_contain_workspace_cache_session(cli_agent_session_id);
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::HeldSessionStateRefresh, started_at);
    let needs_session_affinity_refresh = took_idle_session || claimed_workspace_cache_session;
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
                        session_id = %cli_agent_session_id,
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
                        needs_session_affinity_refresh,
                    );
                }
            }
            let started_at = Instant::now();
            let unpark_result = entry.try_unpark().await;
            pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::IdleUnpark, started_at);
            match unpark_result {
                IdleUnparkResult::Reused {
                    sandbox,
                    budget_lease,
                } => {
                    info!(
                        run_id = %run_id,
                        session_id = %cli_agent_session_id,
                        "reusing idle VM for session"
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
                        needs_session_affinity_refresh,
                    )
                }
                IdleUnparkResult::Failed { destroy_job, error } => {
                    warn!(
                        run_id = %run_id,
                        session_id = %cli_agent_session_id,
                        error = %error,
                        "unpark failed, destroying idle VM and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(ctx.destroy_tasks, *destroy_job, "reuse_unpark_failed");
                    (
                        None,
                        job_lease,
                        SandboxReuseResult::UnparkFailed,
                        snapshot,
                        needs_session_affinity_refresh,
                    )
                }
            }
        }
        Some(stale) if stale.profile_name() == profile_name => {
            info!(
                run_id = %run_id,
                session_id = %cli_agent_session_id,
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
                needs_session_affinity_refresh,
            )
        }
        Some(stale) => {
            info!(
                run_id = %run_id,
                session_id = %cli_agent_session_id,
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
                needs_session_affinity_refresh,
            )
        }
        None => {
            info!(
                run_id = %run_id,
                session_id = %cli_agent_session_id,
                "no idle VM found for session"
            );
            (
                None,
                job_lease,
                SandboxReuseResult::PoolMiss,
                None,
                needs_session_affinity_refresh,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::StartLoopTestObserver;
    use super::super::job_lifecycle::{ActiveBudgetLease, CompletionPayload, RunCleanupState};
    use super::super::sandbox_finalization::{FinalizeContext, finalize_sandbox_for_completion};
    use crate::http::HttpClientConfig;
    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
    use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkResult, ParkingGate};
    use crate::network_log_drain::NetworkLogDrainCoordinator;
    use crate::provider::CompletionAuth;
    use crate::resource_budget::ResourceBudget;
    use crate::restored_session_identity::{
        RestoredSessionFramework, RestoredSessionHistoryHashSizeRelationship,
    };
    use crate::status::IdleVm;
    use crate::test_fixtures::execution_context_for_test;
    use crate::types::{ResumeSession, ResumeSessionHistory, ResumeSessionHistoryRef};
    use guest_contracts::{
        codex_thread_id::canonical_codex_thread_id,
        session_history_identity::{
            FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
        },
    };
    use sandbox::SandboxFactory;
    use sandbox_mock::{MockSandbox, MockSandboxFactory};
    use sha2::{Digest, Sha256};

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
                session_id: "sess-removed-from-pool".into(),
                sandbox_id: SandboxId::new_v4(),
            }],
        }
    }

    fn test_http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn context_with_history_ref(history_hash: &str) -> ExecutionContext {
        context_with_history_ref_and_size(history_hash, 12)
    }

    fn context_with_history_ref_and_size(history_hash: &str, size: u64) -> ExecutionContext {
        let mut context = execution_context_for_test(RunId::new_v4());
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-restore-plan".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: crate::types::ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.into(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    encoding: None,
                    raw_size: size,
                    encoded_size: size,
                    download_source: None,
                },
            },
        });
        context
    }

    fn final_metadata_identity(history_hash: String, size: u64) -> RestoredSessionIdentity {
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            size,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity")
    }

    async fn reusable_sandbox_with_identity(
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ReusableIdleSandbox {
        let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 1, 1).unwrap();
        let builder = ParkedIdleCandidateBuilder::new("sess-restore-plan", lease);
        let builder = if let Some(restored_session_identity) = restored_session_identity {
            builder.with_restored_session_identity(restored_session_identity)
        } else {
            builder
        };
        let candidate = builder.build();
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let entry = pool
            .take("sess-restore-plan")
            .expect("idle entry should exist");
        let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark().await else {
            panic!("idle entry should unpark");
        };
        *sandbox
    }

    async fn reusable_sandbox_parked_by_finalizer(
        restored_session_identity: Option<RestoredSessionIdentity>,
    ) -> ReusableIdleSandbox {
        let dir = tempfile::tempdir().unwrap();
        let status = Arc::new(StatusTracker::new(
            dir.path().join("status.json"),
            4,
            None,
            None,
        ));
        status.write_initial().await;
        let parking_gate = ParkingGate::new_open();
        let idle_pool: SharedIdlePool =
            Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
                IdlePoolConfig {
                    default_timeout: std::time::Duration::from_secs(300),
                    max_idle: 10,
                },
                parking_gate.clone(),
            )));
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let _completion_ready = finalize_sandbox_for_completion(
            Some(Box::new(MockSandbox::new("restore-plan-finalizer"))),
            ActiveBudgetLease::new(lease),
            CompletionPayload::new(
                run_id,
                0,
                None,
                sandbox_id,
                SandboxReuseResult::PoolMiss,
                CompletionAuth::local(),
            ),
            FinalizeContext {
                run_id,
                sandbox_id,
                profile_name: "vm0/default".into(),
                cli_agent_session_id: Some("sess-restore-plan".into()),
                discovered_cli_agent_session_id: None,
                restored_session_identity,
                source_ip: "10.0.0.1".into(),
                network_log_session: None,
                workspace_image: None,
                workspace_image_size_bytes: 0,
                storage_fingerprints: crate::storage_fingerprints::StorageFingerprints::default(),
                device_rate_limits: None,
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                idle_pool: Arc::clone(&idle_pool),
                status,
                park_notify: Arc::new(tokio::sync::Notify::new()),
                held_session_snapshot: super::super::heartbeat::HeldSessionStateSnapshot::new(),
                parking_gate,
                network_log_drain: NetworkLogDrainCoordinator::noop(),
                exit_code: 0,
                cancel: RunCancellationHandle::new(),
                cleanup_state: RunCleanupState::new(),
                outer_job_panic: None,
                test_observer: StartLoopTestObserver::default(),
            },
        )
        .await;

        let entry = idle_pool
            .lock()
            .await
            .take("sess-restore-plan")
            .expect("finalizer should park reusable sandbox");
        let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark().await else {
            panic!("finalized idle entry should unpark");
        };
        *sandbox
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

    #[tokio::test]
    async fn restore_plan_skips_matching_checkpointed_final_identity() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref_and_size(&history_hash, 12);
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity =
            RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
                .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_with_identity(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching checkpointed final identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_skips_matching_codex_checkpointed_final_identity() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let mut context = execution_context_for_test(RunId::new_v4());
        context.cli_agent_type = "codex".into();
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "019E9154C30470F0ADDE36EFB1BE1701".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: crate::types::ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.clone(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    encoding: None,
                    raw_size: 12,
                    encoded_size: 12,
                    download_source: None,
                },
            },
        });
        let canonical_thread_id =
            canonical_codex_thread_id("019E9154C30470F0ADDE36EFB1BE1701").unwrap();
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::Codex,
            hex::encode(Sha256::digest(canonical_thread_id.as_bytes())),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            format!("CODEX_SEARCH:26:/home/user/.codex/sessions:{canonical_thread_id}"),
        )
        .unwrap();
        let restored_identity =
            RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
                .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_with_identity(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching Codex checkpointed final identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_skips_identity_parked_by_finalizer() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity = RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity");
        let reusable_sandbox =
            reusable_sandbox_parked_by_finalizer(Some(restored_identity.clone())).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
            }
            _ => panic!("finalizer-parked restored identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_is_unverified() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::from_context(&context).unwrap();
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                );
            }
            _ => panic!("unverified reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_size_mismatches() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            13,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        let restored_identity = RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity");
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistorySize
                    )))
                );
            }
            _ => panic!("reused identity with mismatched size should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_reused_identity_is_missing() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let reusable_sandbox = reusable_sandbox_with_identity(None).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::MissingIdleIdentity)
                );
            }
            _ => panic!("missing reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_finalizer_parked_without_identity() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let reusable_sandbox = reusable_sandbox_parked_by_finalizer(None).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::MissingIdleIdentity)
                );
            }
            _ => panic!("finalizer-parked missing identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_history_hash_size_relationships() {
        let http = test_http_client();
        let requested_hash = "a".repeat(64);
        let restored_hash = "b".repeat(64);
        let cases = [
            (
                11,
                RestoredSessionHistoryHashSizeRelationship::RequestedSmaller,
            ),
            (
                12,
                RestoredSessionHistoryHashSizeRelationship::RequestedEqual,
            ),
            (
                13,
                RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
            ),
            (0, RestoredSessionHistoryHashSizeRelationship::SizeUnknown),
            (
                api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES + 1,
                RestoredSessionHistoryHashSizeRelationship::SizeUnknown,
            ),
        ];

        for (requested_size, expected_relationship) in cases {
            let context = context_with_history_ref_and_size(&requested_hash, requested_size);
            let restored_identity = final_metadata_identity(restored_hash.clone(), 12);
            let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
            let cancel = RunCancellationHandle::new();
            let mut timing = RunnerPreSpawnTiming::start_after_claim();

            let plan = build_session_history_restore_plan(
                &http,
                &SessionHistoryCpuPool::with_capacity(1),
                &context,
                &cancel,
                SessionHistoryRestoreReuse {
                    entry: Some(&reusable_sandbox),
                    result: SandboxReuseResult::Reused,
                },
                &mut timing,
                None,
            );

            match plan {
                SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                    assert_eq!(
                        fallback,
                        Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                            RestoredSessionIdentityMismatchReason::HistoryHash(
                                expected_relationship
                            )
                        )))
                    );
                }
                _ => panic!("history hash mismatch should keep the prestarted restore plan"),
            }
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_unverified_history_hash_size_as_unknown() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::claude_code_for_test("history-hash-b");
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistoryHash(
                            RestoredSessionHistoryHashSizeRelationship::SizeUnknown
                        )
                    )))
                );
            }
            _ => panic!("unverified history hash mismatch should fall back to restore"),
        }
    }

    #[test]
    fn restore_plan_defers_hash_backed_history_for_non_reuse() {
        let http = test_http_client();
        let context = context_with_history_ref("history-hash-a");
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: None,
                result: SandboxReuseResult::PoolMiss,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::DeferredHashBacked { fallback } => {
                assert_eq!(fallback, Some(SessionHistoryRestoreFallback::NonReuse));
            }
            _ => panic!("non-reuse hash-backed history should defer materialization"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_session_identity_mismatch() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = RestoredSessionIdentity::new(
            RestoredSessionFramework::ClaudeCode,
            "sess-other",
            crate::types::ResumeSessionHistoryRefKind::Blob,
            history_hash,
            Some(12),
        );
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::SessionIdentity
                    )))
                );
            }
            _ => panic!("mismatched session identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_framework_mismatch() {
        let http = test_http_client();
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = RestoredSessionIdentity::new(
            RestoredSessionFramework::Codex,
            "sess-restore-plan",
            crate::types::ResumeSessionHistoryRefKind::Blob,
            history_hash,
            Some(12),
        );
        let reusable_sandbox = reusable_sandbox_with_identity(Some(restored_identity)).await;
        let cancel = RunCancellationHandle::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();

        let plan = build_session_history_restore_plan(
            &http,
            &SessionHistoryCpuPool::with_capacity(1),
            &context,
            &cancel,
            SessionHistoryRestoreReuse {
                entry: Some(&reusable_sandbox),
                result: SandboxReuseResult::Reused,
            },
            &mut timing,
            None,
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::Framework
                    )))
                );
            }
            _ => panic!("mismatched framework should fall back to restore"),
        }
    }
}
