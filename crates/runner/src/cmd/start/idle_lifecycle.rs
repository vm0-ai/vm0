//! Idle-pool lifecycle and status helpers for `runner start`.

use std::sync::Arc;

use sandbox::SandboxId;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::idle_pool::{
    DestroyOutcome, IdleDestroyJob, IdleDestroyPayload, IdlePool, IdlePoolSnapshot,
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

pub(super) async fn add_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) {
    let applied = status
        .add_run_with_idle_info_at_revision(
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

pub(super) fn spawn_idle_destroy_job(
    destroy_tasks: &mut JoinSet<()>,
    job: IdleDestroyJob,
    context: &'static str,
) {
    destroy_tasks.spawn(destroy_idle_job(job, context));
}

/// Destroy idle entries in parallel and wait until their leases are dropped.
pub(super) async fn destroy_idle_jobs_and_wait(jobs: Vec<IdleDestroyJob>, context: &'static str) {
    // Destroy in parallel -- each `stop_and_destroy` is ~1-3s (FC shutdown +
    // cgroup/NBD/netns teardown). Serial destroy blows past shutdown and
    // budget-pressure recovery budgets on multi-VM cleanup.
    let mut set = JoinSet::new();
    for job in jobs {
        set.spawn(destroy_idle_job(job, context));
    }
    while let Some(result) = set.join_next().await {
        if let Err(e) = result {
            warn!(context, error = %e, "idle entry destroy task panicked");
        }
    }
}

/// Destroy an idle sandbox entry. Its budget lease is released by Drop.
async fn destroy_idle_job(job: IdleDestroyJob, _context: &'static str) {
    job.run().await;
}

pub(super) async fn destroy_idle_payload_and_wait(
    payload: IdleDestroyPayload,
    context: &'static str,
) -> DestroyOutcome {
    let handle = tokio::spawn(payload.stop_and_destroy());
    match handle.await {
        Ok(outcome) => outcome,
        Err(e) => {
            warn!(context, error = %e, "idle payload destroy task panicked");
            DestroyOutcome::Uncertain
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;
    use sandbox::{Sandbox, SandboxFactory, SandboxId};
    use sandbox_mock::{MockSandbox, MockSandboxFactory};

    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate,
        SyntheticParkedIdleCandidateParts,
    };
    use crate::resource_budget::ResourceBudget;

    struct PanickingDestroyFactory;

    #[async_trait]
    impl SandboxFactory for PanickingDestroyFactory {
        fn name(&self) -> &str {
            "panic-destroy"
        }

        fn config_hash(&self) -> String {
            "panic-destroy".into()
        }

        async fn create(
            &self,
            config: sandbox::SandboxConfig,
        ) -> sandbox::Result<Box<dyn Sandbox>> {
            Ok(Box::new(MockSandbox::new(config.id.to_string())))
        }

        async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
            panic!("simulated destroy panic");
        }

        async fn shutdown(&mut self) {}
    }

    struct RecordingDestroyFactory {
        destroy_count: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl SandboxFactory for RecordingDestroyFactory {
        fn name(&self) -> &str {
            "recording-destroy"
        }

        fn config_hash(&self) -> String {
            "recording-destroy".into()
        }

        async fn create(
            &self,
            config: sandbox::SandboxConfig,
        ) -> sandbox::Result<Box<dyn Sandbox>> {
            Ok(Box::new(MockSandbox::new(config.id.to_string())))
        }

        async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
            self.destroy_count.fetch_add(1, Ordering::SeqCst);
        }

        async fn shutdown(&mut self) {}
    }

    #[tokio::test]
    async fn idle_destroy_panic_releases_budget_lease() {
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox: Box::new(MockSandbox::new("panic-destroy")),
                factory: Arc::new(Box::new(PanickingDestroyFactory) as Box<dyn SandboxFactory>),
                session_id: "sess-panic".into(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default".into(),
                device_rate_limits: None,
                budget_lease: lease,
                source_ip: "10.0.0.1".into(),
                storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
            });
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let jobs = pool.drain();

        destroy_idle_jobs_and_wait(jobs, "test_destroy_panic").await;

        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn idle_stop_panic_still_attempts_destroy_and_releases_budget_lease() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_stop_panic("simulated idle stop panic");
        let sandbox_factory = MockSandboxFactory::with_overrides(overrides);
        let sandbox = sandbox_factory
            .create(sandbox::SandboxConfig {
                id: SandboxId::new_v4(),
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
            })
            .await
            .expect("create sandbox");

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let destroy_count = Arc::new(AtomicUsize::new(0));
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox,
                factory: Arc::new(Box::new(RecordingDestroyFactory {
                    destroy_count: Arc::clone(&destroy_count),
                }) as Box<dyn SandboxFactory>),
                session_id: "sess-stop-panic".into(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default".into(),
                device_rate_limits: None,
                budget_lease: lease,
                source_ip: "10.0.0.1".into(),
                storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
            });
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let mut jobs = pool.drain();
        assert_eq!(jobs.len(), 1);

        jobs.pop().unwrap().run().await;

        assert_eq!(destroy_count.load(Ordering::SeqCst), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }
}
