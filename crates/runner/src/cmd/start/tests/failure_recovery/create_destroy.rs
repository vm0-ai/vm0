use super::super::super::*;
use super::super::support::*;

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
