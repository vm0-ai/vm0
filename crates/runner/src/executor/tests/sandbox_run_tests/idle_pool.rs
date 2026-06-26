use super::*;

#[tokio::test]
async fn idle_pool_park_and_reuse_cycle() {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, test_support::ParkedIdleCandidateBuilder,
    };

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // Execute first job
    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox alive");

    // Park in idle pool
    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });

    let entry = ParkedIdleCandidateBuilder::new("test-session", test_budget_lease())
        .with_sandbox(sandbox)
        .with_source_ip(outcome.source_ip)
        .build();

    let result = pool.park(entry);
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);

    // Take from pool for reuse
    let reuse_entry = pool.take("test-session").expect("should find session");
    assert_eq!(pool.len(), 0);
    assert_eq!(reuse_entry.profile_name(), "vm0/default");

    // Execute reuse
    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) = match reuse_entry.try_unpark().await {
        crate::idle_pool::IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        crate::idle_pool::IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };
    let (reuse_outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn idle_pool_profile_mismatch_returns_none() {
    use crate::idle_pool::{IdlePool, IdlePoolConfig, test_support::ParkedIdleCandidateBuilder};

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });

    // Park with profile "vm0/default"
    let entry = ParkedIdleCandidateBuilder::new("test-session", test_budget_lease())
        .with_mock_sandbox_name("test")
        .build();
    let _ = pool.park(entry);

    // Take and verify profile
    let taken = pool.take("test-session").expect("should find");
    assert_eq!(taken.profile_name(), "vm0/default");

    // Simulate caller checking profile mismatch
    let matches_browser = taken.profile_name() == "vm0/browser";
    assert!(!matches_browser, "should not match different profile");
}
