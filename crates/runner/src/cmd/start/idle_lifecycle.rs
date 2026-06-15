//! Idle-pool lifecycle and status helpers for `runner start`.

use std::sync::Arc;

use sandbox::SandboxId;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::idle_pool::{
    DestroyOutcome, IdleDestroyJob, IdleDestroyPayload, IdleDestroyResult, IdlePool,
    IdlePoolSnapshot,
};
use crate::ids::RunId;
use crate::status::StatusTracker;

pub(super) type SharedIdlePool = Arc<tokio::sync::Mutex<IdlePool>>;

/// Drain the idle pool: destroy every entry captured at drain start in parallel
/// and wait for all destroys to complete before returning (budgets released).
/// Called from both Draining mode (soft-drain entry) and teardown.
///
/// A SIGUSR2 resume can reopen parking while a soft-drain destroy is still in
/// progress, so write the current post-destroy pool snapshot rather than
/// blindly clearing `idle_vms`.
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
        info!(count = jobs.len(), context, "destroying idle VMs");
        destroy_idle_jobs_and_wait(jobs, context).await;
    }
    let snapshot = idle_pool.lock().await.status_snapshot();
    set_idle_status_snapshot(status, snapshot).await;
}

/// Remove expired idle entries and update status to match the new pool state.
pub(super) async fn evict_expired_idle_entries(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
) -> Vec<IdleDestroyJob> {
    let mut pool = idle_pool.lock().await;
    let expired = pool.evict_expired();
    if expired.is_empty() {
        return expired;
    }
    let snapshot = pool.status_snapshot();
    drop(pool);
    set_idle_status_snapshot(status, snapshot).await;
    expired
}

/// Remove expired idle entries during the periodic cleanup tick.
///
/// Unlike budget-pressure eviction, the periodic tick refreshes status even
/// when no entries expired. Preserve that behavior so status.json can be
/// reconciled from the current pool snapshot on every cleanup pass.
pub(super) async fn cleanup_expired_idle_entries(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
) -> Vec<IdleDestroyJob> {
    let mut pool = idle_pool.lock().await;
    let expired = pool.evict_expired();
    for entry in &expired {
        info!(
            profile = %entry.profile_name(),
            "idle VM expired, destroying"
        );
    }
    let snapshot = pool.status_snapshot();
    drop(pool);
    set_idle_status_snapshot(status, snapshot).await;
    expired
}

/// Remove the oldest idle entry and update status to match the new pool state.
pub(super) async fn evict_oldest_idle_entry(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
) -> Option<IdleDestroyJob> {
    let mut pool = idle_pool.lock().await;
    let evicted = pool.evict_oldest()?;
    let snapshot = pool.status_snapshot();
    drop(pool);
    set_idle_status_snapshot(status, snapshot).await;
    Some(evicted)
}

pub(super) async fn set_idle_status_snapshot(status: &StatusTracker, snapshot: IdlePoolSnapshot) {
    let applied = status
        .set_idle_info_at_revision(snapshot.revision, snapshot.idle_vms)
        .await;
    if !applied {
        info!(
            revision = snapshot.revision,
            "ignored stale idle pool status snapshot"
        );
    }
}

pub(super) async fn add_running_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) {
    let applied = status
        .add_running_run_with_idle_info_at_revision(
            run_id,
            sandbox_id,
            snapshot.revision,
            snapshot.idle_vms,
        )
        .await;
    if !applied {
        info!(
            revision = snapshot.revision,
            "ignored stale idle pool status snapshot while adding active run"
        );
    }
}

pub(super) async fn add_preparing_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) {
    let applied = status
        .add_preparing_run_with_idle_info_at_revision(
            run_id,
            sandbox_id,
            snapshot.revision,
            snapshot.idle_vms,
        )
        .await;
    if !applied {
        info!(
            revision = snapshot.revision,
            "ignored stale idle pool status snapshot while adding preparing run"
        );
    }
}

pub(super) fn spawn_idle_destroy_job(
    destroy_tasks: &mut JoinSet<bool>,
    job: IdleDestroyJob,
    context: &'static str,
) {
    destroy_tasks.spawn(destroy_idle_job(job, context));
}

/// Destroy idle entries in parallel and wait until their leases are dropped.
pub(super) async fn destroy_idle_jobs_and_wait(
    jobs: Vec<IdleDestroyJob>,
    context: &'static str,
) -> bool {
    // Destroy in parallel -- each `stop_and_destroy` is ~1-3s (FC shutdown +
    // cgroup/NBD/netns teardown). Serial destroy blows past shutdown and
    // budget-pressure recovery budgets on multi-VM cleanup.
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
    let handle = tokio::spawn(payload.promote_then_stop_and_destroy(context));
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

    use std::time::Duration;

    use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory};
    use sandbox_mock::MockSandboxFactory;

    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult,
    };
    use crate::resource_budget::ResourceBudget;
    use crate::storage_fingerprints::StorageFingerprints;
    use crate::workspace_promotion::test_support::{TEST_COMPLETED_AT, WorkspacePromotionFixture};

    #[tokio::test]
    async fn destroy_idle_jobs_and_wait_empty_returns_false() {
        assert!(!destroy_idle_jobs_and_wait(Vec::new(), "test_empty").await);
    }

    #[tokio::test]
    async fn destroy_idle_jobs_and_wait_reports_workspace_cache_promotion() {
        let fixture = WorkspacePromotionFixture::new("sess-idle-destroy-cache").await;
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(MockSandboxFactory::new()));
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
            sandbox,
            factory,
            session_id: fixture.session_id.clone(),
            sandbox_id: fixture.sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            workspace_promotion: Some(fixture.promotion),
        });
        let candidate = match request.park_for_idle().await {
            Ok(candidate) => candidate.with_last_completed_at(TEST_COMPLETED_AT.into()),
            Err(_) => panic!("park should succeed"),
        };
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));

        let promoted = destroy_idle_jobs_and_wait(pool.drain(), "test_idle_destroy_cache").await;

        assert!(promoted);
        assert_eq!(budget.allocated(), (0, 0, 0));
        let held = fixture.cache.held_session_states().await;
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].session_id, fixture.session_id);
    }
}
