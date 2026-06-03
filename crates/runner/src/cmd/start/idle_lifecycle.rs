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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;
    use sandbox::{
        CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessHandle, ProcessExit,
        Sandbox, SandboxFactory, SandboxId, StartProcessRequest,
    };
    use sandbox_mock::{MockSandbox, MockSandboxFactory};

    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult,
        ParkedIdleCandidate, StorageFingerprints, SyntheticParkedIdleCandidateParts,
    };
    use crate::ids::RunId;
    use crate::paths::RunnerPaths;
    use crate::resource_budget::ResourceBudget;
    use crate::workspace_image_cache::{
        SessionWorkspaceCache, WorkspaceCacheTerminalStatus, WorkspaceImagePrepareRequest,
        WorkspaceImagePromotionRequest,
    };
    use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

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

    struct PanicExecSandbox {
        id: String,
    }

    impl PanicExecSandbox {
        fn new(id: impl Into<String>) -> Self {
            Self { id: id.into() }
        }
    }

    #[async_trait]
    impl Sandbox for PanicExecSandbox {
        fn id(&self) -> &str {
            &self.id
        }

        fn source_ip(&self) -> &str {
            "10.0.0.1"
        }

        async fn start(&mut self) -> sandbox::Result<()> {
            Ok(())
        }

        async fn stop(&mut self) -> sandbox::Result<()> {
            Ok(())
        }

        async fn kill(&mut self) -> sandbox::Result<()> {
            Ok(())
        }

        async fn exec(&self, _request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
            panic!("simulated exec panic");
        }

        async fn read_file(
            &self,
            _path: &str,
            _max_bytes: u64,
        ) -> sandbox::Result<Option<Vec<u8>>> {
            Ok(None)
        }

        async fn copy_file(
            &self,
            _path: &str,
            _host_path: &std::path::Path,
            _options: CopyFileOptions,
        ) -> sandbox::Result<CopyFileResult> {
            panic!("unused copy_file");
        }

        async fn write_file(&self, _path: &str, _content: &[u8]) -> sandbox::Result<()> {
            Ok(())
        }

        async fn start_process(
            &self,
            _request: &StartProcessRequest<'_>,
        ) -> sandbox::Result<GuestProcessHandle> {
            panic!("unused start_process");
        }

        async fn wait_process(
            &self,
            _handle: GuestProcessHandle,
            _timeout: Duration,
        ) -> sandbox::Result<ProcessExit> {
            panic!("unused wait_process");
        }
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
                workspace_drive: None,
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

    #[tokio::test]
    async fn idle_stop_error_still_attempts_destroy_and_releases_budget_lease() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_stop_result(Err(sandbox::SandboxError::Start {
            message: "simulated idle stop failure".into(),
        }));
        let sandbox_factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = sandbox_factory
            .create(sandbox::SandboxConfig {
                id: SandboxId::new_v4(),
                resources: sandbox::ResourceLimits {
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
        assert_eq!(budget.allocated(), (2, 4096, 1));
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox,
                factory: Arc::new(Box::new(sandbox_factory) as Box<dyn SandboxFactory>),
                session_id: "sess-stop-error".into(),
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

        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn idle_destroy_reports_workspace_cache_promotion() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let session_id = "sess-idle-destroy-cache";
        let image = b"workspace image";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: image.len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), image)
            .await
            .unwrap();
        let workspace_promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-03T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .expect("workspace image should be promotable");

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let request = IdleParkRequest::new(IdleParkRequestParts {
            sandbox: Box::new(MockSandbox::new("idle-destroy-cache")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: session_id.into(),
            sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            workspace_promotion: Some(workspace_promotion),
        });
        let candidate = match request.park_for_idle().await {
            Ok(candidate) => candidate.with_last_completed_at("2026-06-03T00:00:00.000Z".into()),
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
        let held = cache.held_session_states().await;
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].session_id, session_id);
    }

    #[tokio::test]
    async fn idle_destroy_unpark_error_skips_workspace_cache_and_still_destroys() {
        assert_idle_destroy_unpark_failure_skips_workspace_cache_and_still_destroys(
            "sess-idle-destroy-unpark-error",
            |overrides| {
                overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
                    transition: sandbox::SandboxIdleTransition::Unpark,
                    message: "simulated unpark failure".into(),
                }));
            },
        )
        .await;
    }

    #[tokio::test]
    async fn idle_destroy_unpark_panic_skips_workspace_cache_and_still_destroys() {
        assert_idle_destroy_unpark_failure_skips_workspace_cache_and_still_destroys(
            "sess-idle-destroy-unpark-panic",
            |overrides| overrides.push_unpark_panic("simulated unpark panic"),
        )
        .await;
    }

    async fn assert_idle_destroy_unpark_failure_skips_workspace_cache_and_still_destroys(
        session_id: &str,
        configure_overrides: impl FnOnce(&sandbox_mock::MockSandboxOverrides),
    ) {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let image = b"workspace image";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: image.len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), image)
            .await
            .unwrap();
        let workspace_promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-03T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .expect("workspace image should be promotable");

        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        configure_overrides(&overrides);
        let sandbox_factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = sandbox_factory
            .create(sandbox::SandboxConfig {
                id: sandbox_id,
                resources: sandbox::ResourceLimits {
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
            factory: Arc::new(Box::new(sandbox_factory) as Box<dyn SandboxFactory>),
            session_id: session_id.into(),
            sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            workspace_promotion: Some(workspace_promotion),
        });
        let candidate = match request.park_for_idle().await {
            Ok(candidate) => candidate.with_last_completed_at("2026-06-03T00:00:00.000Z".into()),
            Err(_) => panic!("park should succeed"),
        };
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));

        let promoted =
            destroy_idle_jobs_and_wait(pool.drain(), "test_idle_destroy_unpark_error").await;

        assert!(!promoted);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert!(cache.held_session_states().await.is_empty());
    }

    #[tokio::test]
    async fn idle_destroy_exec_panic_skips_workspace_cache_and_still_destroys() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let session_id = "sess-idle-destroy-exec-panic";
        let image = b"workspace image";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: image.len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), image)
            .await
            .unwrap();
        let workspace_promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-03T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .expect("workspace image should be promotable");

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let destroy_count = Arc::new(AtomicUsize::new(0));
        let request = IdleParkRequest::new(IdleParkRequestParts {
            sandbox: Box::new(PanicExecSandbox::new("idle-destroy-exec-panic")),
            factory: Arc::new(Box::new(RecordingDestroyFactory {
                destroy_count: Arc::clone(&destroy_count),
            }) as Box<dyn SandboxFactory>),
            session_id: session_id.into(),
            sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            workspace_promotion: Some(workspace_promotion),
        });
        let candidate = match request.park_for_idle().await {
            Ok(candidate) => candidate.with_last_completed_at("2026-06-03T00:00:00.000Z".into()),
            Err(_) => panic!("park should succeed"),
        };
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));

        let promoted =
            destroy_idle_jobs_and_wait(pool.drain(), "test_idle_destroy_exec_panic").await;

        assert!(!promoted);
        assert_eq!(destroy_count.load(Ordering::SeqCst), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert!(cache.held_session_states().await.is_empty());
    }
}
