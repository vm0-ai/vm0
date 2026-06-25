use super::super::super::*;
use super::TEST_SESSION_LAST_COMPLETED_AT;

use crate::idle_pool::{ParkResult, ParkedIdleCandidate, test_support::ParkedIdleCandidateBuilder};
use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::resource_budget::BudgetLease;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheTerminalStatus, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest, WorkspaceImagePromotionRequest,
};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;

fn make_synthetic_parked_candidate(
    session_id: &str,
    profile_name: &str,
    budget_lease: BudgetLease,
) -> ParkedIdleCandidate {
    ParkedIdleCandidateBuilder::new(session_id, budget_lease)
        .with_profile_name(profile_name)
        .build()
}

/// Pre-populate idle pool with an entry and reserve its budget. Returns
/// the entry's sandbox id so reuse tests can assert it propagates through
/// to the completion payload.
pub(in super::super) async fn seed_idle_pool(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) -> SandboxId {
    let budget_lease = ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).unwrap();
    let candidate = make_synthetic_parked_candidate(session_id, profile_name, budget_lease)
        .with_last_completed_at(TEST_SESSION_LAST_COMPLETED_AT.to_string());
    let sandbox_id = candidate.sandbox_id();
    let mut guard = pool.lock().await;
    let result = guard.park(candidate);
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

pub(in super::super) async fn seed_idle_pool_with_overrides(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    overrides: &Arc<sandbox_mock::MockSandboxOverrides>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) -> SandboxId {
    let runtime = sandbox_mock::MockSandboxRuntime::with_overrides(Arc::clone(overrides));
    let factory = runtime
        .create_factory(sandbox::FactoryConfig {
            profile: profile_name.into(),
            binary_path: PathBuf::new(),
            kernel_path: PathBuf::new(),
            rootfs_path: PathBuf::new(),
            base_dir: PathBuf::new(),
            snapshot: None,
        })
        .await
        .expect("create factory");
    let factory_arc: Arc<Box<dyn sandbox::SandboxFactory>> = Arc::new(factory);
    let sandbox_id = SandboxId::new_v4();
    let sandbox = factory_arc
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: vcpu,
                memory_mb,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).expect("reserve budget");

    let mut guard = pool.lock().await;
    let result = guard.park(
        ParkedIdleCandidateBuilder::new(session_id, budget_lease)
            .with_sandbox(sandbox)
            .with_factory(factory_arc)
            .with_sandbox_id(sandbox_id)
            .with_profile_name(profile_name)
            .with_last_completed_at(TEST_SESSION_LAST_COMPLETED_AT)
            .build(),
    );
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

pub(in super::super) struct WorkspacePromotionSeedSpec<'a> {
    pub(in super::super) session_id: &'a str,
    pub(in super::super) profile_name: &'a str,
    pub(in super::super) vcpu: u32,
    pub(in super::super) memory_mb: u32,
    pub(in super::super) image_size_bytes: u64,
}

pub(in super::super) async fn seed_idle_pool_with_workspace_promotion(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    cache: &SessionWorkspaceCache,
    paths: &RunnerPaths,
    spec: WorkspacePromotionSeedSpec<'_>,
) -> SandboxId {
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: spec.profile_name,
                cli_agent_session_id: Some(spec.session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: spec.image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(spec.image_size_bytes).await.unwrap();
    drop(file);
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(spec.session_id),
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: TEST_SESSION_LAST_COMPLETED_AT.into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .expect("workspace image should be promotable");
    let budget_lease = ResourceBudget::try_reserve_lease(budget, spec.vcpu, spec.memory_mb)
        .expect("reserve budget");
    let candidate = ParkedIdleCandidateBuilder::new(spec.session_id, budget_lease)
        .with_mock_sandbox_name("idle-workspace-promotion-test")
        .with_sandbox_id(sandbox_id)
        .with_profile_name(spec.profile_name)
        .with_workspace_promotion(promotion)
        .with_last_completed_at(TEST_SESSION_LAST_COMPLETED_AT)
        .build();
    let mut guard = pool.lock().await;
    let result = guard.park(candidate);
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

pub(in super::super) async fn seed_idle_pool_expired(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) {
    let budget_lease = ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).unwrap();
    let candidate = make_synthetic_parked_candidate(session_id, profile_name, budget_lease);
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(
        candidate,
        std::time::Instant::now() - Duration::from_secs(400),
        Duration::from_secs(300),
    );
    assert!(matches!(result, ParkResult::Parked));
}

pub(in super::super) struct TestParkedIdleCandidateSpec<'a> {
    pub(in super::super) session_id: &'a str,
    pub(in super::super) profile_name: &'a str,
    pub(in super::super) vcpu: u32,
    pub(in super::super) memory_mb: u32,
    pub(in super::super) parked_at: std::time::Instant,
    pub(in super::super) idle_timeout: Duration,
}

pub(in super::super) async fn seed_idle_pool_with_timing(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    spec: TestParkedIdleCandidateSpec<'_>,
) {
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, spec.vcpu, spec.memory_mb).unwrap();
    let candidate =
        make_synthetic_parked_candidate(spec.session_id, spec.profile_name, budget_lease);
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(candidate, spec.parked_at, spec.idle_timeout);
    assert!(matches!(result, ParkResult::Parked));
}
