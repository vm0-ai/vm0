//! Job discovery branch handling and idle-reuse admission.
//!
//! `run()` owns the provider discovery future and reactor scheduling. This
//! module owns the body that turns a discovered job into a claimed spawned job.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use sandbox::SandboxId;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    SharedIdlePool, add_run_with_idle_status_snapshot, spawn_idle_destroy_job,
};
use super::job_spawn::{JobProfile, SpawnContext, spawn_job};
use crate::config::ProfileConfig;
use crate::idle_pool::{IdlePoolSnapshot, IdleUnparkResult, ReusableIdleSandbox};
use crate::ids::RunId;
use crate::provider::{ClaimedJob, JobCandidate};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::status::{RunnerMode, StatusTracker};
use crate::types::{ExecutionContext, SandboxReuseResult};

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
    pub(super) cancel_tokens: &'a Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    pub(super) spawn_ctx: &'a SpawnContext,
    pub(super) destroy_tasks: &'a mut JoinSet<()>,
    pub(super) jobs: &'a mut JoinSet<Option<RunId>>,
}

struct LocalAdmission {
    run_id: RunId,
    budget_lease: BudgetLease,
    cancel: CancellationToken,
}

struct AdmittedClaim {
    claimed: ClaimedJob,
    budget_lease: BudgetLease,
    cancel: CancellationToken,
}

impl LocalAdmission {
    async fn rollback(
        self,
        cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) {
        let Self {
            run_id,
            budget_lease,
            cancel: _,
        } = self;
        cancel_tokens.lock().await.remove(&run_id);
        drop(budget_lease);
    }

    fn into_admitted(self, claimed: ClaimedJob) -> AdmittedClaim {
        AdmittedClaim {
            claimed,
            budget_lease: self.budget_lease,
            cancel: self.cancel,
        }
    }
}

pub(super) async fn handle_discovered_job(job: DiscoveredJob, mut ctx: DiscoveredJobContext<'_>) {
    let DiscoveredJob { candidate } = job;
    let run_id = candidate.run_id();
    let profile_name = candidate.profile_name().to_owned();
    // Look up profile config for resource requirements.
    let Some(profile_config) = ctx.profiles.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
        return;
    };
    let job_vcpu = profile_config.vcpu;
    let job_memory = profile_config.memory_mb;
    let job_workspace_disk_mb = profile_config.workspace_disk_mb;
    // Look up factory for this profile.
    let Some((factory, restore_guest_state)) = ctx.factories.get(&profile_name) else {
        warn!(run_id = %run_id, profile = %profile_name, "no factory for profile, skipping");
        return;
    };

    let Some(admission) =
        claim_with_local_admission(candidate, run_id, job_vcpu, job_memory, &ctx).await
    else {
        return;
    };
    let AdmittedClaim {
        claimed,
        budget_lease: job_lease,
        cancel: job_cancel,
    } = admission;

    info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");
    let device_rate_limits = crate::io_limits::device_rate_limits_for_context(
        ctx.spawn_ctx.device_rate_limits.as_ref(),
        claimed.context(),
    );

    let (reuse_entry, active_lease, reuse_result, idle_snapshot) = try_reuse_from_pool(
        run_id,
        &profile_name,
        &device_rate_limits,
        claimed.context(),
        job_lease,
        &mut ctx,
    )
    .await;

    // Determine sandbox_id after the reuse decision. On reuse, the sandbox keeps
    // its original identity; on a fresh create, allocate a new UUID for the
    // executor's SandboxConfig. This is the join key for doctor and kill.
    let sandbox_id = match &reuse_entry {
        Some(entry) => entry.sandbox_id(),
        None => SandboxId::new_v4(),
    };
    if let Some(snapshot) = idle_snapshot {
        add_run_with_idle_status_snapshot(ctx.status, run_id, sandbox_id, snapshot).await;
    } else {
        ctx.status.add_run(run_id, sandbox_id).await;
    }

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
        claimed,
        sandbox_id,
        job_profile,
        reuse_entry,
        reuse_result,
        ctx.spawn_ctx,
        ctx.jobs,
    );
}

async fn claim_with_local_admission(
    candidate: JobCandidate,
    run_id: RunId,
    job_vcpu: u32,
    job_memory: u32,
    ctx: &DiscoveredJobContext<'_>,
) -> Option<AdmittedClaim> {
    // Reserve resources before claiming so we don't waste a job that another
    // runner could handle.
    let job_lease = ResourceBudget::try_reserve_lease(ctx.budget, job_vcpu, job_memory)?;

    // Insert cancel token before claiming so provider-side cancel channels
    // (Ably supervisor for ApiProvider, `.cancel` scan for LocalProvider) can
    // find the active job. Skip duplicate discoveries; overwriting would break
    // cancel delivery for the executor.
    let job_cancel = CancellationToken::new();
    {
        let mut tokens = ctx.cancel_tokens.lock().await;
        match tokens.entry(run_id) {
            Entry::Occupied(_) => return None,
            Entry::Vacant(entry) => {
                entry.insert(job_cancel.clone());
            }
        }
    }

    let admission = LocalAdmission {
        run_id,
        budget_lease: job_lease,
        cancel: job_cancel,
    };

    // This is the last reversible point before provider-side ownership.
    // Soft drain must stop new claims, while hard stop still claims and
    // cancels so provider state is completed deterministically.
    let mode = *ctx.mode_rx.borrow();
    match mode {
        RunnerMode::Running => {}
        RunnerMode::Draining => {
            admission.rollback(ctx.cancel_tokens).await;
            return None;
        }
        RunnerMode::Stopping => {
            admission.cancel.cancel();
        }
        RunnerMode::Stopped => {
            admission.rollback(ctx.cancel_tokens).await;
            return None;
        }
    }
    // claim() runs in the branch handler: non-interruptible, so a valid
    // successful claim is always paired with complete().
    let Some(claimed) = ctx.spawn_ctx.provider.claim(candidate).await else {
        // None means the job won't run here: either lost the race to another
        // runner, or the provider rejected the job. Release the reservation and
        // cancel token so the runner can continue.
        admission.rollback(ctx.cancel_tokens).await;
        return None;
    };
    if claimed.context().run_id != run_id {
        warn!(
            run_id = %run_id,
            context_run_id = %claimed.context().run_id,
            "provider returned claimed job with mismatched run_id"
        );
        admission.rollback(ctx.cancel_tokens).await;
        return None;
    }

    Some(admission.into_admitted(claimed))
}

async fn try_reuse_from_pool(
    run_id: RunId,
    profile_name: &str,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    context: &ExecutionContext,
    job_lease: BudgetLease,
    ctx: &mut DiscoveredJobContext<'_>,
) -> (
    Option<ReusableIdleSandbox>,
    BudgetLease,
    SandboxReuseResult,
    Option<IdlePoolSnapshot>,
) {
    let Some(session_id) = context.session_id() else {
        return (None, job_lease, SandboxReuseResult::NoSessionId, None);
    };

    // Take the entry under the pool lock, then drop the lock before any awaits
    // so unpark does not block other take/park operations.
    let (taken, snapshot, held_session_states) = {
        let mut pool = ctx.idle_pool.lock().await;
        let taken = pool.take(session_id);
        let snapshot = taken.as_ref().map(|_| pool.status_snapshot());
        let held_session_states = pool.held_session_states();
        (taken, snapshot, held_session_states)
    };
    ctx.spawn_ctx
        .provider
        .set_held_session_states(held_session_states)
        .await;
    match taken {
        Some(entry)
            if entry.profile_name() == profile_name
                && entry.device_rate_limits() == device_rate_limits =>
        {
            match entry.try_unpark().await {
                IdleUnparkResult::Reused {
                    sandbox,
                    budget_lease,
                } => {
                    info!(
                        run_id = %run_id,
                        session_id,
                        "reusing idle VM for session"
                    );
                    // Idle entry already holds budget. Drop the speculative
                    // fresh-job lease and move the idle lease to the outer job
                    // task before handing the sandbox to the executor.
                    drop(job_lease);
                    (
                        Some(sandbox),
                        budget_lease,
                        SandboxReuseResult::Reused,
                        snapshot,
                    )
                }
                IdleUnparkResult::Failed { destroy_job, error } => {
                    warn!(
                        run_id = %run_id,
                        session_id,
                        error = %error,
                        "unpark failed, destroying idle VM and falling through to fresh create"
                    );
                    spawn_idle_destroy_job(ctx.destroy_tasks, destroy_job, "reuse_unpark_failed");
                    (None, job_lease, SandboxReuseResult::UnparkFailed, snapshot)
                }
            }
        }
        Some(stale) if stale.profile_name() == profile_name => {
            info!(
                run_id = %run_id,
                session_id,
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
            )
        }
        Some(stale) => {
            info!(
                run_id = %run_id,
                session_id,
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
            )
        }
        None => {
            info!(
                run_id = %run_id,
                session_id,
                "no idle VM found for session"
            );
            (None, job_lease, SandboxReuseResult::PoolMiss, None)
        }
    }
}
