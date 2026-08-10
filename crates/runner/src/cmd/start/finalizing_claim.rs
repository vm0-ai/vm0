//! Owned claimed-job waiting before a finalizing predecessor publishes reuse.

use std::panic::AssertUnwindSafe;
use std::time::Instant;

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::{info, warn};

use super::active_runs::ActiveRunReuseState;
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    destroy_idle_jobs_and_wait, evict_expired_idle_entries, evict_oldest_idle_entry,
};
use super::job_discovery::{
    ClaimedJobSetup, FinalizingAdmission, ReadyClaimedResource, ReservedActivation,
    ReservedActivationRequest, activate_reserved_idle, build_spawn_job_request,
    reserve_reusable_idle_for_spawn, rollback_reserved_idle_for_spawn,
};
use super::job_spawn::{SpawnContext, run_job};
#[cfg(test)]
use super::{OuterJobPanicPoint, maybe_panic_outer_job};
use crate::executor::{
    ExecutionFailure, RunnerPreSpawnPhase, RunnerPreSpawnTiming, validate_resume_session_id,
};
use crate::idle_pool::ReservedIdleSandbox;
use crate::ids::RunId;
use crate::provider::ClaimedJob;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::run_cancellation::RunCancellationRegistration;
use crate::types::{CompleteRequest, SandboxReuseResult};

pub(super) struct FinalizingClaimRequest {
    pub(super) claimed: ClaimedJob,
    pub(super) cancellation: RunCancellationRegistration,
    pub(super) admission: FinalizingAdmission,
    pub(super) claim_returned_at: Instant,
    pub(super) profile_name: String,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) workspace_disk_mb: u32,
    pub(super) restore_guest_state: bool,
    pub(super) device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(super) factory: SharedFactory,
}

enum FinalizingWaitOutcome {
    Exact(Box<ReservedIdleSandbox>),
    Fallback(&'static str),
    Cancelled,
}

enum FinalizingResource {
    Exact(Box<ReservedIdleSandbox>),
    Fresh(BudgetLease),
}

struct FinalizingPreparation<'a> {
    claimed: &'a ClaimedJob,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    ctx: &'a SpawnContext,
}

pub(super) fn spawn_finalizing_claim(
    request: FinalizingClaimRequest,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<RunCancellationRegistration>,
) {
    jobs.spawn(run_finalizing_claim(request, ctx.clone()));
}

async fn run_finalizing_claim(
    request: FinalizingClaimRequest,
    ctx: SpawnContext,
) -> RunCancellationRegistration {
    let FinalizingClaimRequest {
        claimed,
        cancellation,
        mut admission,
        claim_returned_at,
        profile_name,
        vcpu,
        memory_mb,
        workspace_disk_mb,
        restore_guest_state,
        device_rate_limits,
        factory,
    } = request;
    let run_id = claimed.context().run_id;
    let mut pre_spawn_timing = RunnerPreSpawnTiming::start_at(claim_returned_at);
    pre_spawn_timing.observe_immediate_successor_intent(
        ctx.immediate_successor_intents.observe_claim(
            claimed.history_generation_run_id(),
            claimed.context().immediate_successor_intent_id,
            claim_returned_at,
        ),
    );
    pre_spawn_timing.mark_task_enqueued();
    let started_at = Instant::now();
    let mut reserved_exact = None;
    let preparation = AssertUnwindSafe(prepare_finalizing_resource(
        FinalizingPreparation {
            claimed: &claimed,
            cancellation: &cancellation,
            admission: &mut admission,
            profile_name: &profile_name,
            vcpu,
            memory_mb,
            device_rate_limits: &device_rate_limits,
            ctx: &ctx,
        },
        &mut reserved_exact,
    ))
    .catch_unwind()
    .await;
    pre_spawn_timing.record_phase_elapsed(RunnerPreSpawnPhase::FinalizingWait, started_at);

    let resource = match preparation {
        Ok(Ok(resource)) => resource,
        Ok(Err(failure)) => {
            if let Some(reservation) = reserved_exact.take() {
                rollback_reserved_idle_for_spawn(*reservation, &ctx).await;
            }
            return complete_claimed_without_sandbox(claimed, cancellation, failure, None, &ctx)
                .await;
        }
        Err(payload) => {
            if let Some(reservation) = reserved_exact.take() {
                rollback_reserved_idle_for_spawn(*reservation, &ctx).await;
            }
            let cancellation = complete_claimed_without_sandbox(
                claimed,
                cancellation,
                ExecutionFailure::from_error(
                    "runner panicked while preparing a claimed finalizing successor",
                ),
                None,
                &ctx,
            )
            .await;
            cancellation.unregister().await;
            std::panic::resume_unwind(payload);
        }
    };

    let active_run_guard = ctx.active_runs.register(
        run_id,
        claimed.context().reuse_key().map(str::to_owned),
        profile_name.clone(),
    );
    let ready = match resource {
        FinalizingResource::Fresh(active_lease) => ReadyClaimedResource {
            reuse_entry: None,
            active_lease,
            reuse_result: SandboxReuseResult::PoolMiss,
            idle_snapshot: None,
        },
        FinalizingResource::Exact(reservation) => {
            match activate_reserved_idle(
                *reservation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    workspace_disk_mb,
                    context: claimed.context(),
                },
                &ctx,
                &mut pre_spawn_timing,
            )
            .await
            {
                ReservedActivation::Ready {
                    reuse_entry,
                    active_lease,
                    reuse_result,
                    idle_snapshot,
                } => ReadyClaimedResource {
                    reuse_entry: reuse_entry.map(|entry| *entry),
                    active_lease,
                    reuse_result,
                    idle_snapshot: Some(idle_snapshot),
                },
                ReservedActivation::CannotStart {
                    budget_lease,
                    reuse_result,
                    error,
                } => {
                    drop(active_run_guard);
                    let cancellation = complete_claimed_without_sandbox(
                        claimed,
                        cancellation,
                        ExecutionFailure::from_error(error),
                        Some(reuse_result),
                        &ctx,
                    )
                    .await;
                    drop(budget_lease);
                    return cancellation;
                }
            }
        }
    };
    let request = build_spawn_job_request(
        ClaimedJobSetup {
            claimed,
            cancellation,
            profile_name,
            vcpu,
            memory_mb,
            workspace_disk_mb,
            restore_guest_state,
            device_rate_limits,
            factory,
            resource: ready,
            pre_spawn_timing,
            active_run_guard,
        },
        &ctx,
    )
    .await;
    run_job(request, ctx).await
}

async fn prepare_finalizing_resource(
    request: FinalizingPreparation<'_>,
    reserved_exact: &mut Option<Box<ReservedIdleSandbox>>,
) -> Result<FinalizingResource, ExecutionFailure> {
    let FinalizingPreparation {
        claimed,
        cancellation,
        admission,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        ctx,
    } = request;
    let run_id = claimed.context().run_id;
    #[cfg(test)]
    maybe_panic_outer_job(
        ctx.outer_job_panic,
        OuterJobPanicPoint::ClaimedWithoutSandbox,
        run_id,
    );
    if let Err(error) = validate_resume_session_id(claimed.context()) {
        return Err(ExecutionFailure::from_error(error));
    }

    info!(
        run_id = %run_id,
        predecessor_run_id = %admission.history_generation_run_id,
        "finalizing successor claimed before sandbox publication"
    );
    match wait_for_finalizing_resource(
        run_id,
        cancellation,
        admission,
        profile_name,
        device_rate_limits,
        ctx,
        reserved_exact,
    )
    .await
    {
        FinalizingWaitOutcome::Exact(reservation) => Ok(FinalizingResource::Exact(reservation)),
        FinalizingWaitOutcome::Fallback(reason) => {
            info!(
                run_id = %run_id,
                finalizing_fallback_reason = reason,
                "finalizing successor entering workspace or cold fallback"
            );
            acquire_fresh_capacity(run_id, cancellation, vcpu, memory_mb, ctx)
                .await
                .map(FinalizingResource::Fresh)
        }
        FinalizingWaitOutcome::Cancelled => Err(ExecutionFailure::cancelled()),
    }
}

async fn wait_for_finalizing_resource(
    run_id: RunId,
    cancellation: &RunCancellationRegistration,
    admission: &mut FinalizingAdmission,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &SpawnContext,
    reserved_exact: &mut Option<Box<ReservedIdleSandbox>>,
) -> FinalizingWaitOutcome {
    let cancel = cancellation.token();
    loop {
        if cancel.is_cancelled() {
            return FinalizingWaitOutcome::Cancelled;
        }
        let state = admission.predecessor.state();
        let missing_exact_reason = match state {
            ActiveRunReuseState::ExactSandboxPublished => Some("published_exact_unavailable"),
            ActiveRunReuseState::Released => Some("predecessor_released_without_exact"),
            ActiveRunReuseState::NoExactSandbox => {
                return FinalizingWaitOutcome::Fallback("predecessor_no_exact");
            }
            ActiveRunReuseState::Pending => None,
        };
        if let Some(missing_exact_reason) = missing_exact_reason {
            *reserved_exact = reserve_reusable_idle_for_spawn(
                &admission.reuse_key,
                profile_name,
                device_rate_limits,
                Some(admission.history_generation_run_id),
                ctx,
            )
            .await
            .map(Box::new);
            if cancel.is_cancelled() {
                if let Some(reservation) = reserved_exact.take() {
                    rollback_reserved_idle_for_spawn(*reservation, ctx).await;
                    ctx.reuse_state_notify.notify_one();
                }
                return FinalizingWaitOutcome::Cancelled;
            }
            if let Some(reservation) = reserved_exact.take() {
                info!(
                    run_id = %run_id,
                    predecessor_run_id = %admission.history_generation_run_id,
                    "finalizing successor reserved exact published sandbox"
                );
                return FinalizingWaitOutcome::Exact(reservation);
            }
            return FinalizingWaitOutcome::Fallback(missing_exact_reason);
        }

        let deadline = tokio::time::Instant::from_std(admission.deadline);
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return FinalizingWaitOutcome::Cancelled;
            }
            _ = admission.predecessor.changed() => {}
            _ = tokio::time::sleep_until(deadline) => {
                if admission.predecessor.state() == ActiveRunReuseState::Pending {
                    return FinalizingWaitOutcome::Fallback("preference_deadline");
                }
            }
        }
    }
}

async fn acquire_fresh_capacity(
    run_id: RunId,
    cancellation: &RunCancellationRegistration,
    vcpu: u32,
    memory_mb: u32,
    ctx: &SpawnContext,
) -> Result<BudgetLease, ExecutionFailure> {
    let mut active_run_changes = ctx.active_runs.subscribe_changes();
    let cancel = cancellation.token();
    loop {
        if let Some(lease) = ResourceBudget::try_reserve_lease(&ctx.budget, vcpu, memory_mb) {
            return Ok(lease);
        }
        let expired = evict_expired_idle_entries(&ctx.idle_pool, &ctx.status).await;
        if !expired.is_empty() {
            info!(
                run_id = %run_id,
                count = expired.len(),
                "reclaiming expired idle VMs for finalizing fallback"
            );
            destroy_idle_jobs_and_wait(expired, "finalizing_fallback_expired").await;
            ctx.reuse_state_notify.notify_one();
            continue;
        }
        if let Some(evicted) = evict_oldest_idle_entry(&ctx.idle_pool, &ctx.status).await {
            info!(
                run_id = %run_id,
                profile = %evicted.profile_name(),
                "evicting idle VM for finalizing fallback"
            );
            destroy_idle_jobs_and_wait(vec![evicted], "finalizing_fallback_oldest").await;
            ctx.reuse_state_notify.notify_one();
            continue;
        }

        info!(run_id = %run_id, "finalizing fallback waiting for fresh capacity");
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(ExecutionFailure::cancelled());
            }
            lease = ResourceBudget::reserve_lease_when_available(&ctx.budget, vcpu, memory_mb) => {
                return Ok(lease);
            }
            changed = active_run_changes.changed() => {
                if changed.is_err() {
                    warn!(run_id = %run_id, "active-run change channel closed");
                }
            }
        }
    }
}

async fn complete_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    failure: ExecutionFailure,
    reuse_result: Option<SandboxReuseResult>,
    ctx: &SpawnContext,
) -> RunCancellationRegistration {
    let (context, completion_auth, active_input_source, pi_standby_source) =
        claimed.into_run_parts();
    drop(active_input_source);
    drop(pi_standby_source);
    ctx.provider
        .complete(
            CompleteRequest {
                run_id: context.run_id,
                exit_code: failure.exit_code,
                error: Some(failure.error),
                sandbox_id: None,
                sandbox_reuse_result: reuse_result,
                workspace_reuse_result: None,
            },
            completion_auth,
        )
        .await;
    cancellation
}
