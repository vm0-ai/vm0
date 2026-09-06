//! Best-effort, capacity-scaled preparation of tenant-free parked sandboxes.

use std::collections::BTreeMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use sandbox::{Sandbox, SandboxConfig, SandboxId, SandboxParkOutcome};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    IdleDestroyTracker, SharedIdlePool, set_idle_status_snapshot, spawn_idle_destroy_job,
};
use crate::config::ProfileConfig;
use crate::idle_pool::{ParkResult, ParkedIdleCandidate};
use crate::lifecycle::RunnerMode;
use crate::pre_spawn_admission::{BackgroundPreSpawnAdmissionLease, PreSpawnAdmission};
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::status::StatusTracker;
use crate::workspace_mount::ensure_workspace_drive_mounted;

const TARGET_PERCENT: usize = 10;

struct BlankPoolPlan {
    profile_name: String,
    profile: ProfileConfig,
    factory: SharedFactory,
    target: usize,
    max_idle: usize,
    headroom_vcpu: u32,
    headroom_memory_mb: u32,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

pub(super) struct BlankPoolReplenisher {
    plan: Option<BlankPoolPlan>,
    task: Option<JoinHandle<BlankPrepareResult>>,
    task_cancel: Option<CancellationToken>,
    attempt_requested: bool,
}

struct BlankPrepareInput {
    profile_name: String,
    profile: ProfileConfig,
    factory: SharedFactory,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    budget_lease: BudgetLease,
    pre_spawn_lease: BackgroundPreSpawnAdmissionLease,
}

enum BackgroundStageResult<T, E> {
    Completed(Result<T, E>),
    CancelledBeforeStart,
    CancelledAfterStart(Result<T, E>),
    Panicked,
}

pub(super) enum BlankPrepareResult {
    Ready(Box<ParkedIdleCandidate>),
    Failed(BlankPrepareFailure),
}

pub(super) struct BlankPrepareFailure {
    stage: &'static str,
    error: Option<String>,
}

impl BlankPoolReplenisher {
    pub(super) fn new(
        profiles: &BTreeMap<String, ProfileConfig>,
        factories: &BTreeMap<String, (SharedFactory, bool)>,
        budget: &Arc<ResourceBudget>,
        max_idle: usize,
        device_rate_limits: Option<sandbox::DeviceRateLimits>,
    ) -> Self {
        let plan = select_plan(profiles, factories, budget, max_idle, device_rate_limits);
        if let Some(plan) = plan.as_ref() {
            info!(
                profile = %plan.profile_name,
                target = plan.target,
                "blank sandbox pool initialized"
            );
        } else {
            info!(
                target = 0,
                "blank sandbox pool disabled by effective capacity"
            );
        }
        Self {
            plan,
            task: None,
            task_cancel: None,
            attempt_requested: true,
        }
    }

    pub(super) fn request_attempt(&mut self) {
        self.attempt_requested = true;
    }

    pub(super) fn cancel_if_inactive(&self, mode: RunnerMode) {
        if mode != RunnerMode::Running
            && let Some(cancel) = self.task_cancel.as_ref()
        {
            cancel.cancel();
        }
    }

    pub(super) async fn maybe_start(
        &mut self,
        mode: RunnerMode,
        idle_pool: &SharedIdlePool,
        budget: &Arc<ResourceBudget>,
        admission: &PreSpawnAdmission,
    ) {
        if !self.attempt_requested || self.task.is_some() || mode != RunnerMode::Running {
            return;
        }
        self.attempt_requested = false;
        let Some(plan) = self.plan.as_ref() else {
            return;
        };
        let (inventory, total_idle) = {
            let pool = idle_pool.lock().await;
            (pool.blank_len(), pool.len())
        };
        if inventory >= plan.target {
            return;
        }
        if plan.max_idle > 0 && total_idle >= plan.max_idle {
            info!(
                target = plan.target,
                inventory,
                total_idle,
                outcome = "idle_pool_full",
                "blank sandbox refill suppressed"
            );
            return;
        }

        let pre_spawn_lease = match admission.try_acquire_background(plan.profile.vcpu) {
            Ok(Some(lease)) => lease,
            Ok(None) => {
                info!(
                    target = plan.target,
                    inventory,
                    outcome = "pre_spawn_unavailable",
                    "blank sandbox refill suppressed"
                );
                return;
            }
            Err(error) => {
                warn!(
                    target = plan.target,
                    inventory,
                    outcome = "pre_spawn_error",
                    error = %error,
                    "blank sandbox refill suppressed"
                );
                return;
            }
        };
        let Some(budget_lease) =
            ResourceBudget::try_reserve_lease(budget, plan.profile.vcpu, plan.profile.memory_mb)
        else {
            info!(
                target = plan.target,
                inventory,
                outcome = "resource_unavailable",
                "blank sandbox refill suppressed"
            );
            return;
        };
        if !budget.can_afford(plan.headroom_vcpu, plan.headroom_memory_mb) {
            info!(
                target = plan.target,
                inventory,
                outcome = "headroom_reserved",
                "blank sandbox refill suppressed"
            );
            return;
        }

        let task_cancel = pre_spawn_lease.cancellation_token();
        let input = BlankPrepareInput {
            profile_name: plan.profile_name.clone(),
            profile: plan.profile.clone(),
            factory: Arc::clone(&plan.factory),
            device_rate_limits: plan.device_rate_limits.clone(),
            budget_lease,
            pre_spawn_lease,
        };
        info!(
            profile = %input.profile_name,
            target = plan.target,
            inventory,
            "preparing blank sandbox"
        );
        self.task_cancel = Some(task_cancel.clone());
        self.task = Some(tokio::spawn(prepare_blank_sandbox(input, task_cancel)));
    }

    pub(super) fn is_preparing(&self) -> bool {
        self.task.is_some()
    }

    pub(super) async fn wait_for_preparation(&mut self) -> Option<BlankPrepareResult> {
        let task = self.task.as_mut()?;
        let result = task.await;
        self.task = None;
        self.task_cancel = None;
        Some(match result {
            Ok(result) => result,
            Err(error) => BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "task",
                error: Some(error.to_string()),
            }),
        })
    }

    pub(super) async fn finish_preparation(
        &mut self,
        result: BlankPrepareResult,
        idle_pool: &SharedIdlePool,
        status: &StatusTracker,
        idle_destroy_tracker: &IdleDestroyTracker,
    ) {
        let Some(plan) = self.plan.as_ref() else {
            if let BlankPrepareResult::Ready(candidate) = result {
                destroy_candidate(*candidate, "blank_pool_disabled").await;
            }
            return;
        };
        match result {
            BlankPrepareResult::Ready(candidate) => {
                let (park_result, snapshot, inventory) = {
                    let mut pool = idle_pool.lock().await;
                    let result = pool.park(*candidate);
                    let snapshot = matches!(result, ParkResult::Parked | ParkResult::Replaced(_))
                        .then(|| pool.status_snapshot());
                    (result, snapshot, pool.blank_len())
                };
                if let Some(snapshot) = snapshot {
                    set_idle_status_snapshot(status, snapshot).await;
                }
                match park_result {
                    ParkResult::Parked => {
                        info!(
                            target = plan.target,
                            inventory,
                            outcome = "parked",
                            "blank sandbox refill completed"
                        );
                        if inventory < plan.target {
                            self.attempt_requested = true;
                        }
                    }
                    ParkResult::Replaced(evicted) => {
                        info!(
                            target = plan.target,
                            inventory,
                            outcome = "replaced",
                            "blank sandbox refill completed"
                        );
                        spawn_idle_destroy_job(
                            idle_destroy_tracker,
                            evicted,
                            "blank_pool_replaced",
                        );
                    }
                    ParkResult::Rejected(rejected) => {
                        info!(
                            target = plan.target,
                            inventory,
                            outcome = "pool_rejected",
                            "blank sandbox refill suppressed"
                        );
                        let (payload, lease) = rejected.into_active_destroy_parts();
                        idle_destroy_tracker.spawn_cleanup(
                            async move {
                                payload
                                    .finalize_workspace_and_destroy("blank_pool_rejected")
                                    .await;
                                drop(lease);
                            },
                            "blank_pool_rejected",
                        );
                    }
                }
            }
            BlankPrepareResult::Failed(failure) => {
                if let Some(error) = failure.error {
                    warn!(
                        target = plan.target,
                        stage = failure.stage,
                        outcome = "failed",
                        error = %error,
                        "blank sandbox refill failed"
                    );
                } else {
                    info!(
                        target = plan.target,
                        stage = failure.stage,
                        outcome = "cancelled",
                        "blank sandbox refill cancelled"
                    );
                }
            }
        }
    }

    pub(super) async fn shutdown(mut self) {
        if let Some(cancel) = self.task_cancel.as_ref() {
            cancel.cancel();
        }
        if let Some(result) = self.wait_for_preparation().await
            && let BlankPrepareResult::Ready(candidate) = result
        {
            destroy_candidate(*candidate, "blank_pool_shutdown").await;
        }
    }
}

fn select_plan(
    profiles: &BTreeMap<String, ProfileConfig>,
    factories: &BTreeMap<String, (SharedFactory, bool)>,
    budget: &ResourceBudget,
    max_idle: usize,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
) -> Option<BlankPoolPlan> {
    let headroom_vcpu = profiles.values().map(|profile| profile.vcpu).max()?;
    let headroom_memory_mb = profiles.values().map(|profile| profile.memory_mb).max()?;
    let (profile_name, profile, capacity) = profiles
        .iter()
        .filter_map(|(name, profile)| {
            let capacity = profile_capacity(profile, budget);
            factories
                .contains_key(name)
                .then_some((name, profile, capacity))
        })
        .max_by(|left, right| left.2.cmp(&right.2).then_with(|| right.0.cmp(left.0)))?;
    let target = blank_pool_target(capacity, max_idle);
    if target == 0 {
        return None;
    }
    let (factory, _) = factories.get(profile_name)?;
    Some(BlankPoolPlan {
        profile_name: profile_name.clone(),
        profile: profile.clone(),
        factory: Arc::clone(factory),
        target,
        max_idle,
        headroom_vcpu,
        headroom_memory_mb,
        device_rate_limits,
    })
}

fn profile_capacity(profile: &ProfileConfig, budget: &ResourceBudget) -> usize {
    let resource_capacity = std::cmp::min(
        budget.effective_vcpu() as usize / profile.vcpu as usize,
        budget.effective_memory_mb() as usize / profile.memory_mb as usize,
    );
    if budget.max_concurrent() == 0 {
        resource_capacity
    } else {
        resource_capacity.min(budget.max_concurrent())
    }
}

fn blank_pool_target(capacity: usize, max_idle: usize) -> usize {
    if capacity < 2 {
        return 0;
    }
    let target = ((capacity + TARGET_PERCENT / 2) / TARGET_PERCENT).min(capacity - 1);
    if max_idle == 0 {
        target
    } else {
        target.min(max_idle)
    }
}

async fn prepare_blank_sandbox(
    input: BlankPrepareInput,
    cancel: CancellationToken,
) -> BlankPrepareResult {
    let BlankPrepareInput {
        profile_name,
        profile,
        factory,
        device_rate_limits,
        budget_lease,
        pre_spawn_lease,
    } = input;
    let mut pre_spawn_lease = Some(pre_spawn_lease);
    let sandbox_id = SandboxId::new_v4();
    let config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: profile.vcpu,
            memory_mb: profile.memory_mb,
        },
        device_rate_limits: device_rate_limits.clone(),
        workspace_drive: Some(sandbox::WorkspaceDriveConfig {
            size_mb: profile.workspace_disk_mb,
            seed_image: None,
        }),
    };
    let mut sandbox = match create_or_cancel(&factory, config, &cancel, &mut pre_spawn_lease).await
    {
        Some(Ok(sandbox)) => sandbox,
        Some(Err(error)) => {
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "create",
                error: Some(error.to_string()),
            });
        }
        None => {
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "create",
                error: None,
            });
        }
    };

    match run_background_stage(sandbox.start(), &cancel, &mut pre_spawn_lease).await {
        BackgroundStageResult::Completed(Ok(())) => {}
        BackgroundStageResult::Completed(Err(error)) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "start",
                error: Some(error.to_string()),
            });
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "start",
                error: None,
            });
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "start",
                error: Some("sandbox start panicked".into()),
            });
        }
    }

    match run_background_stage(
        ensure_workspace_drive_mounted(sandbox.as_ref(), sandbox_id),
        &cancel,
        &mut pre_spawn_lease,
    )
    .await
    {
        BackgroundStageResult::Completed(Ok(_)) => {}
        BackgroundStageResult::Completed(Err(error)) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "workspace_mount",
                error: Some(error.error.to_string()),
            });
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "workspace_mount",
                error: None,
            });
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "workspace_mount",
                error: Some("workspace drive mount panicked".into()),
            });
        }
    }

    match run_background_stage(sandbox.park(), &cancel, &mut pre_spawn_lease).await {
        BackgroundStageResult::Completed(Ok(SandboxParkOutcome::Reusable)) => {
            drop(pre_spawn_lease.take());
            BlankPrepareResult::Ready(Box::new(ParkedIdleCandidate::blank(
                sandbox,
                factory,
                budget_lease,
                sandbox_id,
                profile_name,
                device_rate_limits,
            )))
        }
        BackgroundStageResult::Completed(Ok(SandboxParkOutcome::NonReusable(reason))) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park_non_reusable",
                error: Some(reason.as_str().to_owned()),
            })
        }
        BackgroundStageResult::Completed(Err(error)) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park",
                error: Some(error.to_string()),
            })
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park",
                error: None,
            })
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park",
                error: Some("sandbox park panicked".into()),
            })
        }
    }
}

async fn create_or_cancel(
    factory: &SharedFactory,
    config: SandboxConfig,
    cancel: &CancellationToken,
    pre_spawn_lease: &mut Option<BackgroundPreSpawnAdmissionLease>,
) -> Option<sandbox::Result<Box<dyn Sandbox>>> {
    if cancel.is_cancelled() {
        drop(pre_spawn_lease.take());
        return None;
    }
    // Firecracker factory creation owns a cancellation-safe transaction. Do
    // not drain a cancelled create: it may be waiting on the same COW or netns
    // resources needed by the foreground request that triggered cancellation.
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            drop(pre_spawn_lease.take());
            None
        }
        result = factory.create(config) => Some(result),
    }
}

async fn run_background_stage<T, E>(
    stage: impl Future<Output = Result<T, E>>,
    cancel: &CancellationToken,
    pre_spawn_lease: &mut Option<BackgroundPreSpawnAdmissionLease>,
) -> BackgroundStageResult<T, E> {
    if cancel.is_cancelled() {
        drop(pre_spawn_lease.take());
        return BackgroundStageResult::CancelledBeforeStart;
    }
    let stage = AssertUnwindSafe(stage).catch_unwind();
    tokio::pin!(stage);
    tokio::select! {
        biased;
        result = &mut stage => {
            match result {
                Ok(result) if cancel.is_cancelled() => {
                    drop(pre_spawn_lease.take());
                    BackgroundStageResult::CancelledAfterStart(result)
                }
                Ok(result) => BackgroundStageResult::Completed(result),
                Err(_) => BackgroundStageResult::Panicked,
            }
        }
        _ = cancel.cancelled() => {
            drop(pre_spawn_lease.take());
            match stage.await {
                Ok(result) => BackgroundStageResult::CancelledAfterStart(result),
                Err(_) => BackgroundStageResult::Panicked,
            }
        }
    }
}

async fn destroy_sandbox(factory: &SharedFactory, mut sandbox: Box<dyn Sandbox>) {
    match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(error = %error, "failed to stop blank sandbox"),
        Err(_) => warn!("blank sandbox stop panicked"),
    }
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("blank sandbox destroy panicked");
    }
}

async fn destroy_candidate(candidate: ParkedIdleCandidate, context: &'static str) {
    let (payload, lease) = candidate.into_active_destroy_parts();
    payload.finalize_workspace_and_destroy(context).await;
    drop(lease);
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};

    fn profile(vcpu: u32, memory_mb: u32) -> ProfileConfig {
        ProfileConfig {
            rootfs_hash: "rootfs".into(),
            snapshot_hash: "snapshot".into(),
            vcpu,
            memory_mb,
            rootfs_disk_mb: 8192,
            workspace_disk_mb: 10240,
        }
    }

    #[test]
    fn target_scales_with_capacity_and_operator_cap() {
        assert_eq!(blank_pool_target(0, 0), 0);
        assert_eq!(blank_pool_target(1, 0), 0);
        assert_eq!(blank_pool_target(2, 0), 0);
        assert_eq!(blank_pool_target(5, 0), 1);
        assert_eq!(blank_pool_target(62, 0), 6);
        assert_eq!(blank_pool_target(62, 4), 4);
    }

    #[tokio::test]
    async fn replenisher_creates_parks_and_publishes_one_blank_sandbox() {
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/default".to_owned(), profile(2, 4096));
        let factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/default".to_owned(), (factory, true));
        let budget = Arc::new(ResourceBudget::new(16, 32_768, 1.0, 0));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
            IdlePoolConfig { max_idle: 0 },
            ParkingGate::new_open(),
        )));
        let temp = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(temp.path().join("status.json"), 7, None, None);
        let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
        let admission = PreSpawnAdmission::new(4).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);

        replenisher
            .maybe_start(RunnerMode::Running, &idle_pool, &budget, &admission)
            .await;
        assert!(replenisher.is_preparing());
        let result = replenisher
            .wait_for_preparation()
            .await
            .expect("preparation should be active");
        replenisher
            .finish_preparation(result, &idle_pool, &status, &idle_destroy_tracker)
            .await;

        let mut pool = idle_pool.lock().await;
        assert_eq!(pool.blank_len(), 1);
        assert_eq!(pool.status_snapshot().idle_sandboxes.len(), 1);
        assert!(pool.held_sandbox_states().is_empty());
        let destroy = pool.drain();
        drop(pool);
        for job in destroy {
            job.run().await;
        }
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert!(admission.try_acquire_background(4).unwrap().is_some());
        replenisher.shutdown().await;
        idle_destroy_tracker.close_and_wait().await;
    }
}
