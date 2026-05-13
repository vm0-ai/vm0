use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides, publish_idle_status, push_job,
    seed_idle_pool_with_overrides, shutdown, status_idle_sessions, test_profiles,
    wait_budget_count, wait_idle_pool_len, wait_status_idle_empty_with_active_run,
};

use crate::types::SandboxReuseResult;

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
