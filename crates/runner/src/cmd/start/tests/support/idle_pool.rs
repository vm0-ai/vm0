use super::super::super::*;
use super::TEST_SESSION_LAST_COMPLETED_AT;

use crate::idle_pool::{ParkResult, ParkedIdleCandidate, test_support::ParkedIdleCandidateBuilder};
use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::{RestoredSessionFramework, RestoredSessionIdentity};
use crate::storage_fingerprints::StorageFingerprints;
use crate::types::ResumeSessionHistoryRefKind;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheTerminalStatus, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest, WorkspaceImagePromotionOutcome, WorkspaceImagePromotionRequest,
    WorkspaceSessionHistorySidecarRepresentation,
};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;
use sha2::{Digest, Sha256};

fn make_synthetic_parked_candidate(
    session_id: &str,
    profile_name: &str,
    budget_lease: BudgetLease,
) -> ParkedIdleCandidate {
    ParkedIdleCandidateBuilder::new(session_id, budget_lease)
        .with_profile_name(profile_name)
        .build()
}

struct IdlePoolSeedSpec<'a> {
    session_id: &'a str,
    profile_name: &'a str,
    vcpu: u32,
    memory_mb: u32,
    history_generation_run_id: Option<RunId>,
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
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        &overrides,
        IdlePoolSeedSpec {
            session_id,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: None,
        },
    )
    .await
}

pub(in super::super) async fn seed_idle_pool_with_history_generation(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
    history_generation_run_id: RunId,
) -> SandboxId {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        &overrides,
        IdlePoolSeedSpec {
            session_id,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: Some(history_generation_run_id),
        },
    )
    .await
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
    seed_idle_pool_with_overrides_and_generation(
        pool,
        budget,
        overrides,
        IdlePoolSeedSpec {
            session_id,
            profile_name,
            vcpu,
            memory_mb,
            history_generation_run_id: None,
        },
    )
    .await
}

async fn seed_idle_pool_with_overrides_and_generation(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    overrides: &Arc<sandbox_mock::MockSandboxOverrides>,
    spec: IdlePoolSeedSpec<'_>,
) -> SandboxId {
    let IdlePoolSeedSpec {
        session_id,
        profile_name,
        vcpu,
        memory_mb,
        history_generation_run_id,
    } = spec;
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

    let builder = ParkedIdleCandidateBuilder::new(session_id, budget_lease)
        .with_sandbox(sandbox)
        .with_factory(factory_arc)
        .with_sandbox_id(sandbox_id)
        .with_profile_name(profile_name)
        .with_last_completed_at(TEST_SESSION_LAST_COMPLETED_AT);
    let candidate = match history_generation_run_id {
        Some(run_id) => builder.with_history_generation_run_id(run_id).build(),
        None => builder.build(),
    };
    let mut guard = pool.lock().await;
    let result = guard.park(candidate);
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
            restored_session_identity: None,
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

pub(in super::super) async fn seed_workspace_cache_state(
    cache: &SessionWorkspaceCache,
    paths: &RunnerPaths,
    session_id: &str,
    profile_name: &str,
    image_size_bytes: u64,
    sidecar: Option<TestWorkspaceSidecar>,
) {
    let run_id = match sidecar {
        Some(TestWorkspaceSidecar::Attributed(run_id)) => run_id,
        Some(TestWorkspaceSidecar::Legacy) | None => RunId::new_v4(),
    };
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(image_size_bytes).await.unwrap();
    drop(file);
    let Some(sidecar) = sidecar else {
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    TEST_SESSION_LAST_COMPLETED_AT.into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        return;
    };

    let history = br#"{"type":"message","content":"main-loop-sidecar"}"#;
    let restored_session_identity = RestoredSessionIdentity::new(
        RestoredSessionFramework::ClaudeCode,
        session_id,
        ResumeSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        Some(history.len() as u64),
    );
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: None,
            restored_session_identity: Some(&restored_session_identity),
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: TEST_SESSION_LAST_COMPLETED_AT.into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .expect("workspace image should be promotable");
    let guard = promotion
        .try_acquire_session_history_sidecar_entry_guard()
        .await
        .expect("sidecar entry guard should be available");
    let tmp_path = guard.session_history_sidecar_tmp_path();
    let entry_dir = tmp_path
        .parent()
        .expect("sidecar temporary path should have a cache entry parent")
        .to_path_buf();
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    tokio::fs::write(&tmp_path, history).await.unwrap();
    let source = guard.session_history_sidecar_source(
        tmp_path,
        WorkspaceSessionHistorySidecarRepresentation::Raw,
        history.len() as u64,
    );
    assert_eq!(
        guard
            .promote_with_session_history_sidecar(&promotion, &source)
            .await
            .unwrap(),
        WorkspaceImagePromotionOutcome::Promoted
    );

    if sidecar == TestWorkspaceSidecar::Legacy {
        let metadata_path = entry_dir.join("session-history.metadata.json");
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
        metadata
            .as_object_mut()
            .unwrap()
            .remove("historyGenerationRunId");
        tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
            .await
            .unwrap();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in super::super) enum TestWorkspaceSidecar {
    Attributed(RunId),
    Legacy,
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
    pub(in super::super) history_generation_run_id: Option<RunId>,
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
    let builder = ParkedIdleCandidateBuilder::new(spec.session_id, budget_lease)
        .with_profile_name(spec.profile_name);
    let candidate = match spec.history_generation_run_id {
        Some(run_id) => builder.with_history_generation_run_id(run_id).build(),
        None => builder.build(),
    };
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(candidate, spec.parked_at, spec.idle_timeout);
    assert!(matches!(result, ParkResult::Parked));
}
