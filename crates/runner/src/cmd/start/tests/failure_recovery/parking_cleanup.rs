use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides, push_job, seed_idle_pool, shutdown,
    test_profiles, wait_budget_count, wait_cancel_token, wait_cancel_token_removed,
};
use super::support::assert_no_completion_for_run;

use crate::idle_pool::ParkingState;
use sandbox_mock::MockLifecycleGate;

/// When `Sandbox::park()` returns an error, the runner falls back to
/// `stop_and_destroy_sandbox` and does NOT insert into the idle pool.
#[tokio::test(start_paused = true)]
async fn park_failure_destroys_sandbox_and_skips_pool() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Park,
        message: "simulated balloon failure".into(),
    }));
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park-fail")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete normally");
    assert_eq!(c.unwrap().exit_code, 0);

    // park failure → destroy → budget fully released, pool empty.
    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "park failure must NOT insert into pool"
    );
    assert_eq!(
        counter.park_call_count(),
        1,
        "park() should have been attempted exactly once"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn park_panic_destroys_sandbox_reports_completion_and_releases_budget() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_panic("simulated park panic");
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park-panic")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "park panic must not skip provider.complete");
    assert_eq!(c.unwrap().exit_code, 0);

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(counter.park_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn pool_full_rejected_vm_keeps_budget_until_destroy_and_completion() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    {
        let mut pool = idle_pool.lock().await;
        *pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 1,
        });
    }
    seed_idle_pool(&idle_pool, &budget, "sess-existing", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "seeded idle entry holds budget");

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-rejected")),
    );

    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("pool-full destroy should enter gate"),
        1
    );
    assert_eq!(
        counter.destroy_call_count(),
        1,
        "rejected VM should be sent to destroy"
    );
    assert_eq!(
        budget.allocated().2,
        2,
        "rejected active VM must retain its budget while destroy is in-flight"
    );
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until rejected VM destroy finishes",
    );

    destroy_gate.release_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete after rejected VM destroy");
    assert_eq!(c.unwrap().exit_code, 0);

    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    let pool = idle_pool.lock().await;
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.held_sessions(), vec!["sess-existing"]);
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn parking_gate_closing_after_sandbox_park_rejects_and_waits_for_destroy() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-race-rejected")),
    );

    assert_eq!(
        park_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("sandbox park should enter gate"),
        1
    );
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(env.parking_gate.state(), ParkingState::Open);

    env.drain();
    assert_eq!(env.parking_gate.state(), ParkingState::SoftDraining);

    park_gate.release_one();
    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("rejected parked sandbox should enter destroy gate"),
        1
    );
    assert_eq!(
        counter.destroy_call_count(),
        1,
        "rejected VM should be sent to destroy exactly once"
    );
    assert_eq!(
        budget.allocated().2,
        1,
        "rejected VM must retain budget while destroy is in-flight"
    );
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "closed gate must reject the candidate instead of parking it"
    );
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until rejected VM destroy finishes",
    );

    destroy_gate.release_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete after destroy finishes");
    assert_eq!(c.unwrap().exit_code, 0);

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_while_waiting_for_idle_pool_lock_destroys_instead_of_parking() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = Arc::clone(&config.provider.cancel_tokens);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-cancel-while-locking")),
    );
    let token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    assert_eq!(
        park_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("sandbox park should enter gate"),
        1
    );
    let pool_guard = idle_pool.lock().await;
    park_gate.release_one();
    env.start_observer
        .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
        .await;
    token.cancel();
    drop(pool_guard);

    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("cancelled lock-waiting sandbox should enter destroy gate"),
        1
    );
    assert_eq!(
        counter.destroy_call_count(),
        1,
        "cancelled VM should be sent to destroy exactly once"
    );
    assert_eq!(
        budget.allocated().2,
        1,
        "cancelled VM must retain budget while destroy is in-flight"
    );
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "cancelled VM must not enter the idle pool after waiting for the lock"
    );

    destroy_gate.release_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete after destroy finishes");
    assert_eq!(c.exit_code, 0);
    assert!(c.error.is_none());

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_during_sandbox_park_destroys_instead_of_parking() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = Arc::clone(&config.provider.cancel_tokens);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-cancel-while-parking")),
    );
    let token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    assert_eq!(
        park_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("sandbox park should enter gate"),
        1
    );
    assert_eq!(counter.park_call_count(), 1);

    token.cancel();
    park_gate.release_one();

    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("cancelled parked sandbox should enter destroy gate"),
        1
    );
    assert_eq!(
        counter.destroy_call_count(),
        1,
        "cancelled VM should be sent to destroy exactly once"
    );
    assert_eq!(
        budget.allocated().2,
        1,
        "cancelled VM must retain budget while destroy is in-flight"
    );
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "cancelled VM must not enter the idle pool after park returns"
    );
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until cancelled VM destroy finishes",
    );

    destroy_gate.release_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    let c = c.expect("job should complete after destroy finishes");
    assert_eq!(c.exit_code, 0);
    assert!(
        c.error.is_none(),
        "late cleanup cancellation should not rewrite job result"
    );

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);

    shutdown(&env, run_handle).await;
}
