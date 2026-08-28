//! Idle-pool lifecycle and status helpers for `runner start`.

use std::ops::Deref;
use std::sync::Arc;
use std::{future::Future, panic::AssertUnwindSafe};

use futures_util::FutureExt;
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::Notify;
use tokio::task::JoinSet;
use tokio_util::task::TaskTracker;
use tracing::{info, warn};

use crate::idle_pool::{
    DestroyOutcome, IdleDestroyJob, IdleDestroyPayload, IdleDestroyResult, IdlePool,
    IdlePoolPressureSelection, IdlePoolSnapshot, ReservedIdleSandbox,
};
use crate::ids::RunId;
use crate::resource_budget::BudgetLease;
use crate::status::{StatusResult, StatusTracker};

pub(super) type SharedIdlePool = Arc<tokio::sync::Mutex<IdlePool>>;

#[derive(Clone)]
pub(super) struct IdleDestroyTracker {
    tasks: TaskTracker,
    reuse_state_notify: Arc<Notify>,
}

impl IdleDestroyTracker {
    pub(super) fn new(reuse_state_notify: Arc<Notify>) -> Self {
        Self {
            tasks: TaskTracker::new(),
            reuse_state_notify,
        }
    }

    fn spawn_job(&self, job: IdleDestroyJob, context: &'static str) {
        let reuse_state_notify = Arc::clone(&self.reuse_state_notify);
        drop(self.tasks.spawn(async move {
            match tokio::spawn(destroy_idle_job(job, context)).await {
                Ok(true) => reuse_state_notify.notify_one(),
                Ok(false) => {}
                Err(error) => warn!(context, %error, "idle entry destroy task panicked"),
            }
        }));
    }

    fn spawn_payload(&self, payload: IdleDestroyPayload, context: &'static str) {
        let reuse_state_notify = Arc::clone(&self.reuse_state_notify);
        drop(self.tasks.spawn(async move {
            let result = destroy_idle_payload_and_wait(payload, context).await;
            if result.workspace_cache_promoted {
                reuse_state_notify.notify_one();
            }
        }));
    }

    pub(super) fn spawn_cleanup(
        &self,
        cleanup: impl Future<Output = ()> + Send + 'static,
        context: &'static str,
    ) {
        drop(self.tasks.spawn(async move {
            if AssertUnwindSafe(cleanup).catch_unwind().await.is_err() {
                warn!(context, "tracked activation cleanup panicked");
            }
        }));
    }

    pub(super) async fn close_and_wait(&self) {
        let _ = self.tasks.close();
        self.tasks.wait().await;
    }
}

/// Drain the idle pool: destroy every entry captured at drain start in parallel
/// and wait for all destroys to complete before returning (budgets released).
/// Called from both Draining mode (soft-drain entry) and teardown.
///
/// A SIGUSR2 resume can reopen parking while a soft-drain destroy is still in
/// progress, so write the current post-destroy pool snapshot rather than
/// blindly clearing `idle_sandboxes`.
///
/// `context` is logged alongside the destroyed count for operator clarity
/// (e.g. "draining" vs "shutdown").
pub(super) async fn drain_idle_pool(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    context: &'static str,
) {
    let jobs = idle_pool.lock().await.drain();
    if !jobs.is_empty() {
        info!(count = jobs.len(), context, "destroying idle sandboxes");
        destroy_idle_jobs_and_wait(jobs, context).await;
    }
    let snapshot = idle_pool.lock().await.status_snapshot();
    set_idle_status_snapshot(status, snapshot).await;
}

pub(super) struct RetiringIdleEntry {
    budget_lease: BudgetLease,
    reuse_key: String,
    profile_name: String,
}

pub(super) struct IdlePressureRequest<'a> {
    pub(super) reuse_key: Option<&'a str>,
    pub(super) profile_name: &'a str,
    pub(super) device_rate_limits: &'a Option<DeviceRateLimits>,
    pub(super) history_generation_run_id: Option<RunId>,
    pub(super) context: &'static str,
}

pub(super) enum IdlePressureSelection {
    Reusable(ReservedIdleActivation),
    Retiring(RetiringIdleEntry),
    Empty,
}

/// A parked sandbox reservation paired with the idle snapshot captured by the
/// same pool mutation. Keeping both together lets claimed activation publish
/// active ownership before unpark without reacquiring the pool.
pub(super) struct ReservedIdleActivation {
    reservation: Box<ReservedIdleSandbox>,
    idle_snapshot: IdlePoolSnapshot,
}

impl ReservedIdleActivation {
    pub(super) fn new(reservation: ReservedIdleSandbox, idle_snapshot: IdlePoolSnapshot) -> Self {
        Self {
            reservation: Box::new(reservation),
            idle_snapshot,
        }
    }

    pub(super) fn into_parts(self) -> (ReservedIdleSandbox, IdlePoolSnapshot) {
        (*self.reservation, self.idle_snapshot)
    }
}

impl Deref for ReservedIdleActivation {
    type Target = ReservedIdleSandbox;

    fn deref(&self) -> &Self::Target {
        &self.reservation
    }
}

impl RetiringIdleEntry {
    pub(super) fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    pub(super) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub(super) fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

    pub(super) fn budget_memory_mb(&self) -> u32 {
        self.budget_lease.memory_mb()
    }

    pub(super) fn into_budget_lease(self) -> BudgetLease {
        self.budget_lease
    }
}

/// Prefer a matching reusable entry; otherwise remove the oldest idle entry.
/// The pool decision is atomic, and an evicted payload obtains durable cleanup
/// ownership before the status write yields or its lease can be handed off.
pub(super) async fn select_idle_entry_for_pressure(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    tracker: &IdleDestroyTracker,
    request: IdlePressureRequest<'_>,
) -> IdlePressureSelection {
    let (selection, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let selection = pool.reserve_reusable_or_evict_oldest(
            request.reuse_key,
            request.profile_name,
            request.device_rate_limits,
            request.history_generation_run_id,
        );
        let snapshot = pool.status_snapshot();
        (selection, snapshot)
    };
    match selection {
        IdlePoolPressureSelection::Reusable(reservation) => {
            IdlePressureSelection::Reusable(ReservedIdleActivation {
                reservation,
                idle_snapshot: snapshot,
            })
        }
        IdlePoolPressureSelection::Evicted(job) => {
            let reuse_key = job.reuse_key().to_owned();
            let profile_name = job.profile_name().to_owned();
            let budget_lease =
                spawn_idle_destroy_job_retaining_lease(tracker, *job, request.context);
            let selection = IdlePressureSelection::Retiring(RetiringIdleEntry {
                budget_lease,
                reuse_key,
                profile_name,
            });
            set_idle_status_snapshot(status, snapshot).await;
            selection
        }
        IdlePoolPressureSelection::Empty => IdlePressureSelection::Empty,
    }
}

pub(super) async fn set_idle_status_snapshot(status: &StatusTracker, snapshot: IdlePoolSnapshot) {
    let result = status
        .set_idle_info_at_revision(snapshot.revision, snapshot.idle_sandboxes)
        .await;
    match result {
        Ok(false) => {
            info!(
                revision = snapshot.revision,
                "ignored stale idle pool status snapshot"
            );
        }
        Ok(true) => {}
        Err(error) => {
            warn!(
                revision = snapshot.revision,
                %error,
                "failed to persist idle pool status snapshot"
            );
        }
    }
}

pub(super) async fn add_running_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) -> StatusResult<()> {
    let applied = status
        .add_running_run_with_idle_info_at_revision(
            run_id,
            sandbox_id,
            snapshot.revision,
            snapshot.idle_sandboxes,
        )
        .await?;
    if !applied {
        info!(
            revision = snapshot.revision,
            "ignored stale idle pool status snapshot while adding active run"
        );
    }
    Ok(())
}

pub(super) async fn add_preparing_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) -> StatusResult<()> {
    let applied = status
        .add_preparing_run_with_idle_info_at_revision(
            run_id,
            sandbox_id,
            snapshot.revision,
            snapshot.idle_sandboxes,
        )
        .await?;
    if !applied {
        info!(
            revision = snapshot.revision,
            "ignored stale idle pool status snapshot while adding preparing run"
        );
    }
    Ok(())
}

pub(super) fn spawn_idle_destroy_job(
    tracker: &IdleDestroyTracker,
    job: IdleDestroyJob,
    context: &'static str,
) {
    tracker.spawn_job(job, context);
}

fn spawn_idle_destroy_job_retaining_lease(
    tracker: &IdleDestroyTracker,
    job: IdleDestroyJob,
    context: &'static str,
) -> BudgetLease {
    let (payload, budget_lease) = job.into_retiring_parts();
    tracker.spawn_payload(payload, context);
    budget_lease
}

/// Destroy idle entries in parallel and wait until their leases are dropped.
pub(super) async fn destroy_idle_jobs_and_wait(
    jobs: Vec<IdleDestroyJob>,
    context: &'static str,
) -> bool {
    // Destroy in parallel -- each `stop_and_destroy` is ~1-3s (FC shutdown +
    // cgroup/NBD/netns teardown). Serial destroy blows past shutdown and
    // budget-pressure recovery budgets on multi-sandbox cleanup.
    let mut set = JoinSet::new();
    for job in jobs {
        set.spawn(destroy_idle_job(job, context));
    }
    let mut workspace_cache_promoted = false;
    while let Some(result) = set.join_next().await {
        match result {
            Ok(promoted) => workspace_cache_promoted |= promoted,
            Err(e) => warn!(context, error = %e, "idle entry destroy task panicked"),
        }
    }
    workspace_cache_promoted
}

/// Destroy an idle sandbox entry. Its budget lease is released by Drop.
async fn destroy_idle_job(job: IdleDestroyJob, context: &'static str) -> bool {
    job.run_with_context(context).await
}

pub(super) async fn destroy_idle_payload_and_wait(
    payload: IdleDestroyPayload,
    context: &'static str,
) -> IdleDestroyResult {
    let handle = tokio::spawn(payload.finalize_workspace_and_destroy(context));
    match handle.await {
        Ok(outcome) => outcome,
        Err(e) => {
            warn!(context, error = %e, "idle payload destroy task panicked");
            IdleDestroyResult {
                outcome: DestroyOutcome::Uncertain,
                workspace_cache_promoted: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory};
    use sandbox_mock::MockSandboxFactory;

    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult,
    };
    use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
    use crate::resource_budget::ResourceBudget;
    use crate::storage_fingerprints::StorageFingerprints;
    use crate::workspace_promotion::test_support::{TEST_COMPLETED_AT, WorkspacePromotionFixture};

    #[tokio::test]
    async fn destroy_idle_jobs_and_wait_empty_returns_false() {
        assert!(!destroy_idle_jobs_and_wait(Vec::new(), "test_empty").await);
    }

    #[tokio::test]
    async fn destroy_idle_jobs_and_wait_reports_workspace_cache_promotion() {
        let fixture = WorkspacePromotionFixture::new("thread:idle-destroy-cache").await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        add_healthy_reuse_preparation_matcher(&overrides);
        let factory: Arc<Box<dyn SandboxFactory>> =
            Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
        let sandbox = factory
            .create(SandboxConfig {
                id: fixture.sandbox_id,
                resources: ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create sandbox");
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let request = IdleParkRequest::new(IdleParkRequestParts {
            run_id: crate::ids::RunId::new_v4(),
            sandbox,
            factory,
            reuse_key: fixture.reuse_key.clone(),
            sandbox_id: fixture.sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            restored_session_identity: None,
            history_generation_run_id: None,
            guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
            workspace_image_size_bytes: b"workspace image".len() as u64,
            workspace_promotion: Some(fixture.promotion),
            handoff: None,
        });
        let candidate = match request.park_for_idle().await {
            Ok(outcome) => outcome
                .expect_reusable()
                .with_last_completed_at(TEST_COMPLETED_AT.into()),
            Err(_) => panic!("park should succeed"),
        };
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));

        let promoted = destroy_idle_jobs_and_wait(pool.drain(), "test_idle_destroy_cache").await;

        assert!(promoted);
        assert_eq!(budget.allocated(), (0, 0, 0));
        let held = fixture.cache.held_workspace_states().await;
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].reuse_key, fixture.reuse_key);
    }
}
