use super::super::super::*;

use crate::idle_pool::{ParkCandidate, ParkCandidateParts, ParkResult};
use crate::resource_budget::BudgetLease;
use sandbox::{SandboxFactory, SandboxId};
use sandbox_mock::{MockSandbox, MockSandboxFactory};

fn make_test_park_candidate(
    session_id: &str,
    profile_name: &str,
    budget_lease: BudgetLease,
) -> ParkCandidate {
    ParkCandidate::from_parked_parts(ParkCandidateParts {
        sandbox: Box::new(MockSandbox::new("idle-test")),
        factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
        session_id: session_id.into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: profile_name.into(),
        budget_lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    })
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
    let candidate = make_test_park_candidate(session_id, profile_name, budget_lease);
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
    let mut factory = runtime
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
    factory.startup().await.expect("startup");
    let factory_arc: Arc<Box<dyn sandbox::SandboxFactory>> = Arc::new(factory);
    let sandbox_id = SandboxId::new_v4();
    let sandbox = factory_arc
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: vcpu,
                memory_mb,
            },
        })
        .await
        .expect("create sandbox");
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).expect("reserve budget");

    let mut guard = pool.lock().await;
    let result = guard.park(ParkCandidate::from_parked_parts(ParkCandidateParts {
        sandbox,
        factory: factory_arc,
        session_id: session_id.to_string(),
        sandbox_id,
        profile_name: profile_name.into(),
        budget_lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    }));
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
    let candidate = make_test_park_candidate(session_id, profile_name, budget_lease);
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(
        candidate,
        std::time::Instant::now() - Duration::from_secs(400),
        Duration::from_secs(300),
    );
    assert!(matches!(result, ParkResult::Parked));
}

pub(in super::super) struct TestParkCandidateSpec<'a> {
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
    spec: TestParkCandidateSpec<'_>,
) {
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, spec.vcpu, spec.memory_mb).unwrap();
    let candidate = make_test_park_candidate(spec.session_id, spec.profile_name, budget_lease);
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(candidate, spec.parked_at, spec.idle_timeout);
    assert!(matches!(result, ParkResult::Parked));
}
