//! Owned claimed-job waiting before a finalizing predecessor publishes reuse.

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use tokio::task::JoinSet;
use tracing::info;

use super::active_runs::{ActiveRunHandoffRequest, ActiveRunReuseState};
use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    IdlePressureRequest, IdlePressureSelection, select_idle_entry_for_pressure,
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
    ExecutionFailure, FinalizingHandoffOutcome, RunnerPreSpawnPhase, RunnerPreSpawnTiming,
    validate_resume_session_id,
};
use crate::idle_pool::{FinalizingHandoffCandidate, ReservedIdleSandbox};
use crate::ids::RunId;
use crate::provider::ClaimedJob;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::run_cancellation::RunCancellationRegistration;
use crate::types::{CompleteRequest, SandboxReuseResult};

pub(super) const FINALIZING_HANDOFF_ACCEPTANCE_GRACE: Duration = Duration::from_millis(1500);

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
    Handoff(Box<FinalizingHandoffCandidate>),
    Exact(Box<ReservedIdleSandbox>),
    Fallback {
        reason: &'static str,
        handoff_outcome: FinalizingHandoffOutcome,
    },
    Cancelled,
}

impl FinalizingWaitOutcome {
    fn no_exact(reason: &'static str) -> Self {
        Self::Fallback {
            reason,
            handoff_outcome: FinalizingHandoffOutcome::NoExact,
        }
    }

    fn deadline(reason: &'static str) -> Self {
        Self::Fallback {
            reason,
            handoff_outcome: FinalizingHandoffOutcome::NotAcceptedBeforeDeadline,
        }
    }
}

enum FinalizingResource {
    Handoff(Box<FinalizingHandoffCandidate>),
    Exact(Box<ReservedIdleSandbox>),
    Fresh(BudgetLease),
}

struct FinalizingPreparation<'a> {
    claimed: &'a ClaimedJob,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    claim_returned_at: Instant,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    pre_spawn_timing: &'a mut RunnerPreSpawnTiming,
    ctx: &'a SpawnContext,
}

struct FinalizingWait<'a> {
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    admission: &'a mut FinalizingAdmission,
    claim_returned_at: Instant,
    profile_name: &'a str,
    device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
    ctx: &'a SpawnContext,
}

struct FinalizingFallback<'a> {
    run_id: RunId,
    cancellation: &'a RunCancellationRegistration,
    reuse_key: &'a str,
    history_generation_run_id: RunId,
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
    let mut pre_spawn_timing =
        RunnerPreSpawnTiming::start_at(claim_returned_at, claimed.api_claim_request_elapsed());
    pre_spawn_timing.mark_task_enqueued();
    let started_at = Instant::now();
    let mut reserved_exact = None;
    let preparation = AssertUnwindSafe(prepare_finalizing_resource(
        FinalizingPreparation {
            claimed: &claimed,
            cancellation: &cancellation,
            admission: &mut admission,
            claim_returned_at,
            profile_name: &profile_name,
            vcpu,
            memory_mb,
            device_rate_limits: &device_rate_limits,
            pre_spawn_timing: &mut pre_spawn_timing,
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
                    device_rate_limits: &device_rate_limits,
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
        FinalizingResource::Handoff(candidate) => {
            let reservation =
                match candidate.into_reservation(run_id, admission.history_generation_run_id) {
                    Ok(reservation) => reservation,
                    Err(candidate) => {
                        drop(active_run_guard);
                        candidate
                            .into_destroy_job()
                            .run_with_context("finalizing_handoff_identity_mismatch")
                            .await;
                        ctx.reuse_state_notify.notify_one();
                        return complete_claimed_without_sandbox(
                            claimed,
                            cancellation,
                            ExecutionFailure::from_error(
                                "finalizing handoff identity did not match claimed successor",
                            ),
                            None,
                            &ctx,
                        )
                        .await;
                    }
                };
            match activate_reserved_idle(
                reservation,
                ReservedActivationRequest {
                    run_id,
                    profile_name: &profile_name,
                    device_rate_limits: &device_rate_limits,
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
        claim_returned_at,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        pre_spawn_timing,
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
        FinalizingWait {
            run_id,
            cancellation,
            admission,
            claim_returned_at,
            profile_name,
            device_rate_limits,
            ctx,
        },
        reserved_exact,
    )
    .await
    {
        FinalizingWaitOutcome::Handoff(candidate) => {
            pre_spawn_timing.record_finalizing_handoff_outcome(FinalizingHandoffOutcome::Accepted);
            Ok(FinalizingResource::Handoff(candidate))
        }
        FinalizingWaitOutcome::Exact(reservation) => {
            pre_spawn_timing
                .record_finalizing_handoff_outcome(FinalizingHandoffOutcome::PublishedExact);
            Ok(FinalizingResource::Exact(reservation))
        }
        FinalizingWaitOutcome::Fallback {
            reason,
            handoff_outcome,
        } => {
            pre_spawn_timing.record_finalizing_handoff_outcome(handoff_outcome);
            info!(
                run_id = %run_id,
                finalizing_fallback_reason = reason,
                "finalizing successor entering workspace or cold fallback"
            );
            acquire_fallback_resource(FinalizingFallback {
                run_id,
                cancellation,
                reuse_key: &admission.reuse_key,
                history_generation_run_id: admission.history_generation_run_id,
                profile_name,
                vcpu,
                memory_mb,
                device_rate_limits,
                ctx,
            })
            .await
        }
        FinalizingWaitOutcome::Cancelled => {
            pre_spawn_timing.record_finalizing_handoff_outcome(FinalizingHandoffOutcome::Cancelled);
            Err(ExecutionFailure::cancelled())
        }
    }
}

async fn wait_for_finalizing_resource(
    request: FinalizingWait<'_>,
    reserved_exact: &mut Option<Box<ReservedIdleSandbox>>,
) -> FinalizingWaitOutcome {
    let FinalizingWait {
        run_id,
        cancellation,
        admission,
        claim_returned_at,
        profile_name,
        device_rate_limits,
        ctx,
    } = request;
    let cancel = cancellation.token();
    let mut handoff = admission.predecessor.request_handoff(run_id);
    let pre_acceptance_deadline = if handoff.is_some() {
        admission
            .deadline
            .max(claim_returned_at + FINALIZING_HANDOFF_ACCEPTANCE_GRACE)
    } else {
        admission.deadline
    };
    loop {
        if cancel.is_cancelled() {
            return FinalizingWaitOutcome::Cancelled;
        }
        let state = admission.predecessor.state();
        if state != ActiveRunReuseState::Pending
            && let Some(request) = handoff.as_mut()
        {
            if request.accepted().await {
                return receive_finalizing_handoff(
                    request,
                    run_id,
                    admission.history_generation_run_id,
                    cancellation,
                    ctx,
                )
                .await;
            }
            handoff = None;
        }
        let missing_exact_reason = match state {
            ActiveRunReuseState::ExactSandboxPublished => Some("published_exact_unavailable"),
            ActiveRunReuseState::ExactSandboxHandedOff => {
                return FinalizingWaitOutcome::no_exact("exact_handoff_unavailable");
            }
            ActiveRunReuseState::Released => Some("predecessor_released_without_exact"),
            ActiveRunReuseState::NoExactSandbox => {
                return FinalizingWaitOutcome::no_exact("predecessor_no_exact");
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
            return FinalizingWaitOutcome::no_exact(missing_exact_reason);
        }

        let deadline = tokio::time::Instant::from_std(pre_acceptance_deadline);
        if let Some(request) = handoff.as_mut() {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    return FinalizingWaitOutcome::Cancelled;
                }
                accepted = request.accepted() => {
                    if accepted {
                        return receive_finalizing_handoff(
                            request,
                            run_id,
                            admission.history_generation_run_id,
                            cancellation,
                            ctx,
                        )
                        .await;
                    }
                    handoff = None;
                }
                _ = admission.predecessor.changed() => {}
                _ = tokio::time::sleep_until(deadline) => {
                    if admission.predecessor.state() == ActiveRunReuseState::Pending {
                        return FinalizingWaitOutcome::deadline("handoff_acceptance_deadline");
                    }
                }
            }
        } else {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    return FinalizingWaitOutcome::Cancelled;
                }
                _ = admission.predecessor.changed() => {}
                _ = tokio::time::sleep_until(deadline) => {
                    if admission.predecessor.state() == ActiveRunReuseState::Pending {
                        return FinalizingWaitOutcome::no_exact("handoff_request_unavailable");
                    }
                }
            }
        }
    }
}

async fn receive_finalizing_handoff(
    request: &mut ActiveRunHandoffRequest,
    run_id: RunId,
    predecessor_run_id: RunId,
    cancellation: &RunCancellationRegistration,
    ctx: &SpawnContext,
) -> FinalizingWaitOutcome {
    let cancel = cancellation.token();
    let candidate = tokio::select! {
        biased;
        candidate = request.receive() => candidate,
        () = cancel.cancelled() => {
            if let Some(candidate) = request.cancel_and_recover_delivery() {
                candidate
                    .into_destroy_job()
                    .run_with_context("cancelled_finalizing_handoff")
                    .await;
                ctx.reuse_state_notify.notify_one();
            }
            return FinalizingWaitOutcome::Cancelled;
        }
    };
    let Ok(candidate) = candidate else {
        return FinalizingWaitOutcome::no_exact("exact_handoff_closed");
    };
    if cancel.is_cancelled() {
        candidate
            .into_destroy_job()
            .run_with_context("cancelled_finalizing_handoff")
            .await;
        ctx.reuse_state_notify.notify_one();
        return FinalizingWaitOutcome::Cancelled;
    }
    info!(
        run_id = %run_id,
        predecessor_run_id = %predecessor_run_id,
        "finalizing successor received direct parked sandbox handoff"
    );
    FinalizingWaitOutcome::Handoff(candidate)
}

async fn acquire_fallback_resource(
    request: FinalizingFallback<'_>,
) -> Result<FinalizingResource, ExecutionFailure> {
    let FinalizingFallback {
        run_id,
        cancellation,
        reuse_key,
        history_generation_run_id,
        profile_name,
        vcpu,
        memory_mb,
        device_rate_limits,
        ctx,
    } = request;
    let mut idle_pool_changes = ctx.idle_pool.lock().await.subscribe_changes();
    let cancel = cancellation.token();
    let mut retiring_leases = Vec::new();
    loop {
        if let Some(reservation) = reserve_fallback_exact(
            cancellation,
            reuse_key,
            profile_name,
            device_rate_limits,
            history_generation_run_id,
            ctx,
        )
        .await?
        {
            return Ok(FinalizingResource::Exact(reservation));
        }
        match ResourceBudget::try_substitute_leases(
            &ctx.budget,
            std::mem::take(&mut retiring_leases),
            vcpu,
            memory_mb,
        ) {
            Ok(lease) => {
                if let Some(reservation) = reserve_fallback_exact(
                    cancellation,
                    reuse_key,
                    profile_name,
                    device_rate_limits,
                    history_generation_run_id,
                    ctx,
                )
                .await?
                {
                    drop(lease);
                    return Ok(FinalizingResource::Exact(reservation));
                }
                return Ok(FinalizingResource::Fresh(lease));
            }
            Err(retained) => retiring_leases = retained,
        }
        match select_idle_entry_for_pressure(
            &ctx.idle_pool,
            &ctx.status,
            &ctx.idle_destroy_tracker,
            IdlePressureRequest {
                reuse_key: Some(reuse_key),
                profile_name,
                device_rate_limits,
                history_generation_run_id: Some(history_generation_run_id),
                context: "finalizing_fallback_oldest",
            },
        )
        .await
        {
            IdlePressureSelection::Reusable(reservation) => {
                let reservation = accept_fallback_exact(cancellation, reservation, ctx).await?;
                return Ok(FinalizingResource::Exact(reservation));
            }
            IdlePressureSelection::Retiring(retiring) => {
                info!(
                    run_id = %run_id,
                    profile = %retiring.profile_name(),
                    "evicting idle VM for finalizing fallback"
                );
                retiring_leases.push(retiring.into_budget_lease());
                ctx.reuse_state_notify.notify_one();
                continue;
            }
            IdlePressureSelection::Empty => {}
        }

        info!(run_id = %run_id, "finalizing fallback waiting for fresh capacity");
        #[cfg(test)]
        ctx.test_observer
            .notify_finalizing_capacity_wait_entered(run_id);
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(ExecutionFailure::cancelled());
            }
            lease = ResourceBudget::substitute_leases_when_available(
                &ctx.budget,
                &mut retiring_leases,
                vcpu,
                memory_mb,
            ) => {
                if let Some(reservation) = reserve_fallback_exact(
                    cancellation,
                    reuse_key,
                    profile_name,
                    device_rate_limits,
                    history_generation_run_id,
                    ctx,
                ).await? {
                    drop(lease);
                    return Ok(FinalizingResource::Exact(reservation));
                }
                return Ok(FinalizingResource::Fresh(lease));
            }
            _ = idle_pool_changes.changed() => {}
        }
    }
}

async fn reserve_fallback_exact(
    cancellation: &RunCancellationRegistration,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    history_generation_run_id: RunId,
    ctx: &SpawnContext,
) -> Result<Option<Box<ReservedIdleSandbox>>, ExecutionFailure> {
    let Some(reservation) = reserve_reusable_idle_for_spawn(
        reuse_key,
        profile_name,
        device_rate_limits,
        Some(history_generation_run_id),
        ctx,
    )
    .await
    else {
        return Ok(None);
    };
    accept_fallback_exact(cancellation, Box::new(reservation), ctx)
        .await
        .map(Some)
}

async fn accept_fallback_exact(
    cancellation: &RunCancellationRegistration,
    reservation: Box<ReservedIdleSandbox>,
    ctx: &SpawnContext,
) -> Result<Box<ReservedIdleSandbox>, ExecutionFailure> {
    if cancellation.token().is_cancelled() {
        rollback_reserved_idle_for_spawn(*reservation, ctx).await;
        ctx.reuse_state_notify.notify_one();
        return Err(ExecutionFailure::cancelled());
    }
    Ok(reservation)
}

async fn complete_claimed_without_sandbox(
    claimed: ClaimedJob,
    cancellation: RunCancellationRegistration,
    failure: ExecutionFailure,
    reuse_result: Option<SandboxReuseResult>,
    ctx: &SpawnContext,
) -> RunCancellationRegistration {
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    drop(active_input_source);
    ctx.provider
        .complete(
            CompleteRequest {
                run_id: context.run_id,
                exit_code: failure.exit_code,
                error: Some(failure.error),
                sandbox_id: None,
                sandbox_reuse_result: reuse_result,
                workspace_reuse_result: None,
                active_input_delivery_ids: Vec::new(),
            },
            completion_auth,
        )
        .await;
    cancellation
}
