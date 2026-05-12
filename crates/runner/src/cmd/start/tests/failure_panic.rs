use super::super::*;
use super::support::*;

use crate::idle_pool::ParkingState;
use crate::types::SandboxReuseResult;
use sandbox_mock::MockLifecycleGate;

fn assert_no_completion_for_run(env: &MockRunEnv, run_id: RunId, reason: &str) {
    let completions = env.handle.completions.lock().unwrap();
    assert!(
        !completions
            .iter()
            .any(|completion| completion.run_id == run_id),
        "{reason}"
    );
}

#[tokio::test(start_paused = true)]
async fn active_destroy_panic_still_reports_completion_and_releases_budget() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_destroy_panic("simulated destroy panic");
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "destroy panic must not skip provider.complete"
    );
    assert_eq!(completion.unwrap().exit_code, 0);

    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

/// Test 20: Failed job with session context is not parked.
///
/// When `wait_exit` returns a non-zero exit code, `spawn_job()` skips
/// parking (because `exit_code == 0` is false) and destroys the sandbox.
#[tokio::test(start_paused = true)]
async fn failed_job_with_session_not_parked() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_code(1));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 4, 8192, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-fail")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 1);

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0, "failed job must not park");

    shutdown(&env, run_handle).await;
}

/// Test 21: Cancelled job is not parked.
///
/// `wait_exit_gate` blocks the agent execution. The test cancels the job
/// via the cancel token, causing `select!` in the executor to take the
/// cancellation branch. `job_cancel.is_cancelled()` is true, so
/// `parkable_session` is `None` → sandbox destroyed.
#[tokio::test(start_paused = true)]
async fn cancelled_job_not_parked() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        gate,
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 4, 8192, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-cancel")),
    );

    // Wait for the job to be claimed (cancel token inserted).
    let token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    // Cancel the job — executor's select! takes the cancelled branch.
    token.cancel();

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "cancelled job should still complete");
    let c = c.unwrap();
    assert_eq!(c.exit_code, 137, "cancellation yields synthetic SIGKILL");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "cancelled job must not park"
    );

    shutdown(&env, run_handle).await;
}

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
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
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
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
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
async fn create_failure_completes_and_cleans_run_state() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox::SandboxError::Initialization {
        phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
        message: "create failed".into(),
    }));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("create failure should still report completion");
    assert_eq!(c.exit_code, 1);
    let error = c.error.expect("create failure should report an error");
    assert!(error.contains("create failed"), "got: {error}");

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    let (_idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&status_path).await;
    assert!(
        active_runs.is_empty(),
        "create failure should remove active run from status"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_idle_pool_owned_cleans_token_and_active_status() {
    let (mut config, env) = mock_run_config_with_overrides(
        test_profiles(),
        8,
        16384,
        4,
        Arc::new(sandbox_mock::MockSandboxOverrides::new()),
    );
    config.outer_job_panic = Some(OuterJobPanicPoint::IdlePoolOwned);
    let idle_pool = Arc::clone(&config.idle_pool);
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-outer-panic-idle")),
    );

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_sessions_and_active_runs(
        &status_path,
        &["sess-outer-panic-idle"],
        &[],
        Duration::from_secs(5),
    )
    .await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "outer job panic must not synthesize provider completion",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_active_unknown_reconciles_on_shutdown_final_scan() {
    let (mut config, env) = mock_run_config_with_overrides(
        test_profiles(),
        8,
        16384,
        4,
        Arc::new(sandbox_mock::MockSandboxOverrides::new()),
    );
    config.outer_job_panic = Some(OuterJobPanicPoint::ActiveOrUnknown);
    config.orphan_reap_process_discovery = Some(OrphanReapProcessDiscovery {
        firecrackers: Arc::new(Vec::new()),
        incomplete_for_current_runner: false,
    });
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_sessions_and_active_runs(
        &status_path,
        &[],
        &[run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;

    shutdown(&env, run_handle).await;
    wait_status_idle_sessions_and_active_runs(&status_path, &[], &[], Duration::from_secs(5)).await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "outer job panic must not synthesize provider completion",
    );
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_destroy_completed_cleans_token_and_active_status() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    config.outer_job_panic = Some(OuterJobPanicPoint::DestroyCompleted);
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("active destroy should enter gate"),
        1
    );
    let _token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    destroy_gate.release_one();

    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_sessions_and_active_runs(&status_path, &[], &[], Duration::from_secs(5)).await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "outer job panic must not synthesize provider completion",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn pool_full_rejected_vm_keeps_budget_until_destroy_and_completion() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
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
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
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
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
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
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
    let cancel_tokens = Arc::clone(&config.cancel_tokens);
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

/// When the runner takes a sandbox out of the idle pool for reuse and
/// `Sandbox::unpark()` returns an error, the idle entry is destroyed
/// and the runner falls through to a fresh sandbox create.
#[tokio::test(start_paused = true)]
async fn unpark_failure_destroys_idle_entry_and_falls_through() {
    // Both the pre-seeded sandbox and the fresh-create sandbox share
    // the same MockSandboxOverrides set, so the unpark error queued
    // here is consumed by the FIRST unpark call — which is the take
    // path's call against the pre-seeded sandbox.
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);

    // Pre-seed via the factory so the seeded MockSandbox shares the
    // override set (and consumes the queued unpark error).
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &counter,
        "sess-unpark-fail",
        "vm0/default",
        2,
        4096,
    )
    .await;
    assert_eq!(idle_pool.lock().await.len(), 1, "pool seeded");

    let run_handle = tokio::spawn(run(config));

    // Push a job for the same session — runner will try to reuse,
    // unpark() will fail, idle entry gets destroyed, fresh create runs.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-unpark-fail")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    let c = c.expect("fresh-create job should still complete");
    assert_eq!(c.exit_code, 0);
    assert_eq!(
        c.reuse_result,
        Some(SandboxReuseResult::UnparkFailed),
        "completion must tag the unpark-failure branch",
    );

    // Wait for resource ownership to settle: the failed idle entry has been
    // destroyed and the fresh-create VM is parked as the single idle lease.
    // `idle_pool.len() == 1` is true before the job starts, so budget must be
    // the first terminal-state probe.
    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(2)).await;
    assert_eq!(
        counter.unpark_call_count(),
        1,
        "expected exactly one unpark attempt"
    );
    assert_eq!(
        counter.park_call_count(),
        1,
        "expected exactly one park (the fresh-create's)"
    );
    assert_eq!(
        counter.destroy_call_count(),
        1,
        "expected failed idle entry to be destroyed"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unpark_failure_status_switches_from_idle_to_active_while_job_runs() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        Arc::clone(&gate),
    ));
    let counter = Arc::clone(&overrides);
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);
    let status = Arc::clone(&config.status);
    let status_path = env._temp_dir.path().join("status.json");

    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &counter,
        "sess-unpark-status",
        "vm0/default",
        2,
        4096,
    )
    .await;
    publish_idle_status(&idle_pool, &status).await;
    assert_eq!(
        status_idle_sessions(&status_path).await,
        vec!["sess-unpark-status".to_string()],
        "pre-run status should list the idle VM",
    );

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-unpark-status")),
    );

    wait_idle_pool_len(&idle_pool, 0, Duration::from_secs(5)).await;
    wait_status_idle_empty_with_active_run(&status_path, run_id, Duration::from_secs(5)).await;

    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh-create job should still complete");
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::UnparkFailed),
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unpark_panic_destroys_idle_entry_and_falls_through() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    overrides.push_unpark_panic("simulated unpark panic");
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);

    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &counter,
        "sess-unpark-panic",
        "vm0/default",
        2,
        4096,
    )
    .await;

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-unpark-panic")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh-create job should still complete");
    assert_eq!(c.exit_code, 0);
    assert_eq!(c.reuse_result, Some(SandboxReuseResult::UnparkFailed));

    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    assert_eq!(counter.unpark_call_count(), 1);
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(idle_pool.lock().await.len(), 1);

    shutdown(&env, run_handle).await;
}
