use super::super::super::*;
use super::super::support::{
    MockRunEnv, context_with_session, mock_run_config_with_overrides, push_job, seed_idle_pool,
    shutdown, test_profiles, wait_budget_count, wait_cancel_handle, wait_cancel_token_removed,
    wait_workspace_cache_sessions,
};
use super::support::assert_no_completion_for_run;

use crate::idle_pool::ParkingState;
use crate::paths::RunnerPaths;
use crate::workspace_image_cache::SessionWorkspaceCache;
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

#[tokio::test]
async fn park_failure_promotes_workspace_cache_before_destroy() {
    assert_workspace_cache_after_failed_park(
        "sess-park-fail-cache",
        |overrides| {
            overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
                transition: sandbox::SandboxIdleTransition::Park,
                message: "simulated balloon failure".into(),
            }));
        },
        true,
    )
    .await;
}

#[tokio::test]
async fn park_panic_skips_workspace_cache_before_destroy() {
    assert_workspace_cache_after_failed_park(
        "sess-park-panic-cache",
        |overrides| overrides.push_park_panic("simulated park panic"),
        false,
    )
    .await;
}

async fn assert_workspace_cache_after_failed_park(
    session_id: &str,
    configure_park: impl FnOnce(&sandbox_mock::MockSandboxOverrides),
    expect_cache: bool,
) {
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    configure_park(&overrides);
    let counter = Arc::clone(&overrides);

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let context = context_with_session(run_id, session_id);
    push_job(&env, run_id, "vm0/default", Some(context));

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before the active workspace image is written");
    let sandbox_id = counter
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    counter.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete normally after park failure destroy");
    assert_eq!(completion.exit_code, 0);

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(counter.destroy_call_count(), 1);
    if expect_cache {
        wait_workspace_cache_sessions(&workspace_cache, &[session_id], Duration::from_secs(2))
            .await;
    } else {
        let held = workspace_cache.held_session_states().await;
        assert!(held.is_empty());
    }

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_during_sandbox_park_promotes_workspace_cache_before_destroy() {
    assert_workspace_cache_after_late_cancellation(
        "sess-cancel-during-park-cache",
        LateCancellationPoint::DuringPark,
    )
    .await;
}

#[tokio::test]
async fn cancellation_before_idle_pool_transfer_promotes_workspace_cache_before_destroy() {
    assert_workspace_cache_after_late_cancellation(
        "sess-cancel-before-pool-cache",
        LateCancellationPoint::BeforeIdlePoolTransfer,
    )
    .await;
}

enum LateCancellationPoint {
    DuringPark,
    BeforeIdlePoolTransfer,
}

async fn wait_lifecycle_gate_entered(gate: &MockLifecycleGate, message: &str) {
    assert_eq!(
        gate.wait_entered(1, Duration::from_secs(5))
            .await
            .expect(message),
        1
    );
}

fn assert_destroy_in_flight(
    counter: &sandbox_mock::MockSandboxOverrides,
    budget: &ResourceBudget,
    expected_budget_count: usize,
    destroy_message: &str,
    budget_message: &str,
) {
    assert_eq!(counter.destroy_call_count(), 1, "{destroy_message}");
    assert_eq!(
        budget.allocated().2,
        expected_budget_count,
        "{budget_message}"
    );
}

async fn assert_idle_pool_len(idle_pool: &SharedIdlePool, expected_len: usize, message: &str) {
    assert_eq!(idle_pool.lock().await.len(), expected_len, "{message}");
}

async fn release_destroy_and_wait_for_successful_completion(
    env: &MockRunEnv,
    destroy_gate: &MockLifecycleGate,
    run_id: RunId,
    completion_message: &str,
    no_error_message: Option<&str>,
) {
    destroy_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect(completion_message);
    assert_eq!(completion.exit_code, 0);
    if let Some(message) = no_error_message {
        assert!(completion.error.is_none(), "{message}");
    }
}

async fn assert_post_destroy_cleanup(
    budget: &ResourceBudget,
    idle_pool: &SharedIdlePool,
    cancel_tokens: Option<&SharedRunCancellationMap>,
    run_id: RunId,
    expected_budget_count: usize,
    expected_idle_len: usize,
) {
    wait_budget_count(budget, expected_budget_count, Duration::from_secs(2)).await;
    if let Some(cancel_tokens) = cancel_tokens {
        wait_cancel_token_removed(cancel_tokens, run_id, Duration::from_secs(2)).await;
    }
    assert_eq!(idle_pool.lock().await.len(), expected_idle_len);
}

async fn assert_workspace_cache_after_late_cancellation(
    session_id: &str,
    cancellation_point: LateCancellationPoint,
) {
    let wait_gate = MockLifecycleGate::new();
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let counter = Arc::clone(&overrides);

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = Arc::clone(&config.provider.cancel_tokens);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let context = context_with_session(run_id, session_id);
    push_job(&env, run_id, "vm0/default", Some(context));
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before the active workspace image is written");
    let sandbox_id = counter
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    counter.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;

    match cancellation_point {
        LateCancellationPoint::DuringPark => {
            cancel_handle.cancel().await;
            park_gate.release_one();
        }
        LateCancellationPoint::BeforeIdlePoolTransfer => {
            let pool_guard = idle_pool.lock().await;
            park_gate.release_one();
            env.start_observer
                .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
                .await;
            cancel_handle.cancel().await;
            drop(pool_guard);
        }
    }

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "cancelled parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "cancelled VM should be sent to destroy exactly once",
        "cancelled VM must retain budget while destroy is in-flight",
    );
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until cancelled VM destroy finishes",
    );

    release_destroy_and_wait_for_successful_completion(
        &env,
        &destroy_gate,
        run_id,
        "job should complete after destroy finishes",
        Some("late cleanup cancellation should not rewrite job result"),
    )
    .await;

    assert_post_destroy_cleanup(&budget, &idle_pool, Some(&cancel_tokens), run_id, 0, 0).await;
    wait_workspace_cache_sessions(&workspace_cache, &[session_id], Duration::from_secs(2)).await;

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

    wait_lifecycle_gate_entered(&destroy_gate, "pool-full destroy should enter gate").await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        2,
        "rejected VM should be sent to destroy",
        "rejected active VM must retain its budget while destroy is in-flight",
    );
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until rejected VM destroy finishes",
    );

    release_destroy_and_wait_for_successful_completion(
        &env,
        &destroy_gate,
        run_id,
        "job should complete after rejected VM destroy",
        None,
    )
    .await;

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

    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(env.parking_gate.state(), ParkingState::Open);

    env.drain();
    assert_eq!(env.parking_gate.state(), ParkingState::SoftDraining);

    park_gate.release_one();
    wait_lifecycle_gate_entered(
        &destroy_gate,
        "rejected parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "rejected VM should be sent to destroy exactly once",
        "rejected VM must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "closed gate must reject the candidate instead of parking it",
    )
    .await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until rejected VM destroy finishes",
    );

    release_destroy_and_wait_for_successful_completion(
        &env,
        &destroy_gate,
        run_id,
        "job should complete after destroy finishes",
        None,
    )
    .await;

    assert_post_destroy_cleanup(&budget, &idle_pool, None, run_id, 0, 0).await;

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
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;
    let pool_guard = idle_pool.lock().await;
    park_gate.release_one();
    env.start_observer
        .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
        .await;
    cancel_handle.cancel().await;
    drop(pool_guard);

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "cancelled lock-waiting sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "cancelled VM should be sent to destroy exactly once",
        "cancelled VM must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "cancelled VM must not enter the idle pool after waiting for the lock",
    )
    .await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until cancelled VM destroy finishes",
    );

    release_destroy_and_wait_for_successful_completion(
        &env,
        &destroy_gate,
        run_id,
        "job should complete after destroy finishes",
        Some("late cleanup cancellation should not rewrite job result"),
    )
    .await;

    assert_post_destroy_cleanup(&budget, &idle_pool, Some(&cancel_tokens), run_id, 0, 0).await;

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
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;
    assert_eq!(counter.park_call_count(), 1);

    cancel_handle.cancel().await;
    park_gate.release_one();

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "cancelled parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "cancelled VM should be sent to destroy exactly once",
        "cancelled VM must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "cancelled VM must not enter the idle pool after park returns",
    )
    .await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "provider.complete must wait until cancelled VM destroy finishes",
    );

    release_destroy_and_wait_for_successful_completion(
        &env,
        &destroy_gate,
        run_id,
        "job should complete after destroy finishes",
        Some("late cleanup cancellation should not rewrite job result"),
    )
    .await;

    assert_post_destroy_cleanup(&budget, &idle_pool, Some(&cancel_tokens), run_id, 0, 0).await;

    shutdown(&env, run_handle).await;
}
