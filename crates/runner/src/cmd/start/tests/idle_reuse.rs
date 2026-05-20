use super::super::*;
use super::support::{
    assert_run_exits_within, context_with_session, minimal_context, mock_run_config,
    mock_run_config_with_overrides, publish_idle_status, push_job, seed_idle_pool,
    seed_idle_pool_with_overrides, shutdown, status_idle_sessions, test_profiles, two_profiles,
    wait_budget_count, wait_cancel_token, wait_discover_entered, wait_idle_pool_len,
    wait_idle_pool_sessions, wait_parking_state, wait_sandbox_lifecycle_counts,
    wait_status_idle_empty_with_active_run, wait_status_idle_sessions_and_active_runs,
};

use crate::idle_pool::ParkingState;
use crate::types::SandboxReuseResult;

// -----------------------------------------------------------------------
// Test 9: idle pool park/take is gated on session ID availability
//
// With a session ID, the VM is parked after execution; without one,
// the VM is destroyed (no key to re-find it under).
// -----------------------------------------------------------------------

fn context_with_session_opt(
    run_id: RunId,
    session_id: Option<&str>,
) -> crate::types::ExecutionContext {
    let mut ctx = minimal_context(run_id);
    if let Some(sid) = session_id {
        ctx.resume_session = Some(crate::types::ResumeSession {
            session_id: sid.to_string(),
            session_history: String::new(),
        });
    }
    ctx
}

fn context_with_io_limiter_flag_value(
    run_id: RunId,
    session_id: &str,
    enabled: bool,
) -> crate::types::ExecutionContext {
    let mut ctx = context_with_session(run_id, session_id);
    ctx.feature_flags = Some(std::collections::HashMap::from([(
        crate::io_limits::SANDBOX_IO_LIMITERS_FEATURE_FLAG.to_string(),
        enabled,
    )]));
    ctx
}

fn context_with_io_limiter_flag(run_id: RunId, session_id: &str) -> crate::types::ExecutionContext {
    context_with_io_limiter_flag_value(run_id, session_id, true)
}

fn device_rate_limits() -> sandbox::DeviceRateLimits {
    sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    }
}

#[tokio::test(start_paused = true)]
async fn job_with_session_parks_vm() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let ctx = context_with_session_opt(run_id, Some("sess-1"));
    push_job(&env, run_id, "vm0/default", Some(ctx));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    let pool = env.idle_pool.lock().await;
    assert_eq!(pool.len(), 1, "VM should be parked when session is present");
    assert!(pool.held_sessions().contains(&"sess-1".to_string()));
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn job_without_session_does_not_park() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    // No session — parking requires a session ID.
    let ctx = context_with_session_opt(run_id, None);
    push_job(&env, run_id, "vm0/default", Some(ctx));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    let pool = env.idle_pool.lock().await;
    assert_eq!(
        pool.len(),
        0,
        "VM should NOT be parked without a session ID"
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 10: Successful job parks VM in idle pool
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn successful_job_parks_in_idle_pool() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    assert_eq!(completion.unwrap().exit_code, 0);

    // VM should be parked in idle pool, holding budget.
    wait_idle_pool_sessions(&idle_pool, &["sess-park"], Duration::from_secs(5)).await;
    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "VM should be parked");
        assert!(
            pool.held_sessions().contains(&"sess-park".to_string()),
            "parked session should be sess-park"
        );
    }
    let (_, _, count) = budget.allocated();
    assert_eq!(count, 1, "parked VM should hold budget");

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 11: Job without session destroys sandbox (no parking)
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn job_without_session_destroys_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    // No resume_session → no session_id → no parking.
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    assert_eq!(completion.unwrap().exit_code, 0);

    // The active budget lease is dropped after provider.complete() in the
    // spawned task, so wait_completion returning doesn't guarantee it has
    // executed yet.
    // Poll until budget is fully released rather than using a fixed sleep.
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    // No parking — pool empty, budget fully released.
    assert_eq!(idle_pool.lock().await.len(), 0, "pool should be empty");

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 12: Park notification triggers immediate heartbeat
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn park_triggers_immediate_heartbeat() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Snapshot the heartbeat count once the provider is parked in discovery.
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let before = env.handle.heartbeat_count();

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-hb")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "park should trigger at least one heartbeat after baseline={before}",
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 13: Session affinity reuses idle VM
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn session_affinity_reuses_idle_vm() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);

    // Pre-seed: park a VM for session "sess-reuse" with matching profile.
    let seeded_sandbox_id =
        seed_idle_pool(&idle_pool, &budget, "sess-reuse", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));

    // Push job for same session — should reuse the idle VM.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-reuse")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let completion = completion.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::Reused),
        "reuse_result should be Reused"
    );
    assert_eq!(
        completion.sandbox_id,
        Some(seeded_sandbox_id),
        "reused completion should carry the seeded sandbox id"
    );

    // After reuse + re-park: pool should still have 1 entry, budget count=1.
    wait_idle_pool_sessions(&idle_pool, &["sess-reuse"], Duration::from_secs(5)).await;
    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "VM should be re-parked after reuse");
    }
    assert_eq!(
        budget.allocated().2,
        1,
        "budget should remain at 1 (reused, not additive)"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn disabled_io_limiter_feature_omits_limits_on_fresh_create() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    config.device_rate_limits = Some(device_rate_limits());

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_io_limiter_flag_value(
            run_id,
            "sess-disabled-io-limit",
            false,
        )),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));

    let create_configs = overrides.create_configs();
    assert_eq!(create_configs.len(), 1);
    assert_eq!(create_configs[0].device_rate_limits, None);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn disabled_io_limiter_feature_reuses_unlimited_idle_vm() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    config.device_rate_limits = Some(device_rate_limits());

    let seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-disabled-io-reuse",
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
        Some(context_with_io_limiter_flag_value(
            run_id,
            "sess-disabled-io-reuse",
            false,
        )),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(completion.sandbox_id, Some(seeded_sandbox_id));
    assert!(
        overrides
            .create_configs()
            .iter()
            .all(|config| config.device_rate_limits.is_none()),
        "disabled feature should never pass limiter config to sandbox create"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn missing_io_limiter_feature_reuses_unlimited_idle_vm() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    config.device_rate_limits = Some(device_rate_limits());

    let seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-missing-io-flag",
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
        Some(context_with_session(run_id, "sess-missing-io-flag")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(completion.sandbox_id, Some(seeded_sandbox_id));
    assert!(
        overrides
            .create_configs()
            .iter()
            .all(|config| config.device_rate_limits.is_none()),
        "missing feature flag should never pass limiter config to sandbox create"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn enabled_io_limiter_feature_without_host_capacity_reuses_unlimited_idle_vm() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);

    let seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-enabled-io-no-capacity",
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
        Some(context_with_io_limiter_flag(
            run_id,
            "sess-enabled-io-no-capacity",
        )),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(completion.sandbox_id, Some(seeded_sandbox_id));
    assert!(
        overrides
            .create_configs()
            .iter()
            .all(|config| config.device_rate_limits.is_none()),
        "enabled feature without host capacity should not apply limiter config"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn device_limit_mismatch_destroys_idle_vm_and_fresh_creates() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let limits = device_rate_limits();
    config.device_rate_limits = Some(limits.clone());

    let seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-io-limit",
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
        Some(context_with_io_limiter_flag(run_id, "sess-io-limit")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::DeviceLimitMismatch),
    );
    assert_ne!(
        completion.sandbox_id,
        Some(seeded_sandbox_id),
        "limiter mismatch should force a fresh sandbox"
    );
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let create_configs = overrides.create_configs();
    assert!(
        create_configs
            .iter()
            .any(|config| config.device_rate_limits == Some(limits.clone())),
        "fresh create should receive the enabled limiter config"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn reuse_take_clears_idle_status_while_job_is_active() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        Arc::clone(&gate),
    ));
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let status = Arc::clone(&config.status);
    let status_path = env._temp_dir.path().join("status.json");

    let _seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-reuse-status",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let snapshot = idle_pool.lock().await.status_snapshot();
    assert!(
        status
            .set_idle_info_at_revision(snapshot.revision, snapshot.idle_vms)
            .await
    );
    assert_eq!(
        status_idle_sessions(&status_path).await,
        vec!["sess-reuse-status".to_string()],
        "pre-run status should list the seeded idle VM",
    );

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-reuse-status")),
    );

    wait_idle_pool_len(&idle_pool, 0, Duration::from_secs(5)).await;
    wait_status_idle_empty_with_active_run(&status_path, run_id, Duration::from_secs(5)).await;

    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "reused job should complete");
    assert_eq!(
        completion.unwrap().reuse_result,
        Some(SandboxReuseResult::Reused),
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 13b: Job with no session reports NoSessionId
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn job_without_session_reports_no_session_id() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);

    let run_handle = tokio::spawn(run(config));

    // No resume_session → NoSessionId branch.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let completion = completion.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoSessionId),
    );
    assert!(
        completion.sandbox_id.is_some(),
        "fresh create still allocates a sandbox id",
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 14: Profile mismatch destroys stale and creates new
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn profile_mismatch_destroys_stale_vm() {
    let (config, env) = mock_run_config(two_profiles(), 16, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);

    // Pre-seed: park a "vm0/default" (2vcpu) VM for session "sess-mm".
    seed_idle_pool(&idle_pool, &budget, "sess-mm", "vm0/default", 2, 4096).await;

    let run_handle = tokio::spawn(run(config));

    // Push job for "vm0/large" (4vcpu) with same session — profile mismatch.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/large",
        Some(context_with_session(run_id, "sess-mm")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let completion = completion.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::ProfileMismatch),
        "reuse_result should be ProfileMismatch when profile differs"
    );
    assert!(
        completion.sandbox_id.is_some(),
        "freshly created sandbox still reports its id"
    );

    // Stale VM destruction runs in a background destroy_task. Poll until
    // its budget is released rather than using a fixed sleep.
    // Expected: stale 2vcpu released, new 4vcpu held → count=1.
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "new VM should be parked");
    }
    let (alloc_vcpu, alloc_mem, alloc_count) = budget.allocated();
    assert_eq!(alloc_count, 1, "only new VM should hold budget");
    assert_eq!(alloc_vcpu, 4, "new VM is vm0/large (4 vcpu)");
    assert_eq!(alloc_mem, 8192, "new VM is vm0/large (8192 MB)");

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn profile_mismatch_status_switches_from_idle_to_active_while_job_runs() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(two_profiles(), 16, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let status = Arc::clone(&config.status);
    let status_path = env._temp_dir.path().join("status.json");

    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-mm-status",
        "vm0/default",
        2,
        4096,
    )
    .await;
    publish_idle_status(&idle_pool, &status).await;
    assert_eq!(
        status_idle_sessions(&status_path).await,
        vec!["sess-mm-status".to_string()],
        "pre-run status should list the stale idle VM",
    );

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/large",
        Some(context_with_session(run_id, "sess-mm-status")),
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
        Some(SandboxReuseResult::ProfileMismatch),
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 17: Shutdown drains idle pool and releases budget
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn shutdown_drains_idle_pool() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);

    // Pre-seed: two idle entries holding budget.
    seed_idle_pool(&idle_pool, &budget, "sess-drain-1", "vm0/default", 2, 4096).await;
    seed_idle_pool(&idle_pool, &budget, "sess-drain-2", "vm0/default", 2, 4096).await;
    assert_eq!(idle_pool.lock().await.len(), 2);
    assert_eq!(budget.allocated().2, 2);

    let run_handle = tokio::spawn(run(config));

    // Immediately shutdown — drain should destroy all idle entries.
    shutdown(&env, run_handle).await;

    // After shutdown: pool empty, budget fully released.
    assert_eq!(idle_pool.lock().await.len(), 0, "pool should be drained");
    let (_, _, count) = budget.allocated();
    assert_eq!(count, 0, "all budget should be released after drain");
}

/// Active soft drain closes parking for successful jobs that complete
/// before SIGUSR2 resume. The sandbox is destroyed and budget is released
/// instead of late-parking into an already-drained pool.
#[tokio::test]
async fn job_completing_during_active_draining_is_not_parked() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));

    // Claim a gated job with a reusable session while Running.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-late-park")),
    );
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Enter Draining. The Draining path drains an empty pool and waits for the
    // gated job.
    env.drain();
    wait_parking_state(
        &idle_pool,
        ParkingState::SoftDraining,
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "Draining mode should have drained an empty pool",
    );

    // Release the gate while still Draining: parking is closed, so the
    // successful job destroys its sandbox instead of parking it.
    gate.notify_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "active draining must reject post-job parking",
    );

    // Draining mode observes jobs.is_empty → auto-Stop → teardown.
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "natural drain should exit within 5s",
    )
    .await;

    // Leak proof: pool empty, budget fully released.
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "teardown must leave no idle VM",
    );
    assert_eq!(
        budget.allocated().2,
        0,
        "budget must be fully released (no held entries, no stray reservations)",
    );
}

/// Regression for #11162: once SIGUSR2 has logically resumed the runner,
/// parking is open even if the main loop has not yet processed the Running
/// tick. The silent mode flip keeps the main loop in the pre-ack window
/// deterministically.
#[tokio::test]
async fn soft_drain_resume_opens_parking_before_running_ack() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-soft-resume-race")),
    );
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    env.drain();
    wait_parking_state(
        &idle_pool,
        ParkingState::SoftDraining,
        Duration::from_secs(5),
    )
    .await;

    // Simulate SIGUSR2's ordering while suppressing the watch wake: open
    // parking first, then make Running visible without letting the main
    // loop run its top-of-loop Running branch.
    env.parking_gate.open_after_soft_drain();
    env.mode_tx.send_if_modified(|mode| {
        *mode = RunnerMode::Running;
        false
    });
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Running);

    gate.notify_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete after logical resume");
    assert_eq!(c.unwrap().exit_code, 0);

    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "job should park even before the main loop acknowledges Running",
    );
    assert_eq!(
        budget.allocated().2,
        1,
        "parked VM should retain its budget lease",
    );

    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s",
    )
    .await;
}

/// Regression (G2): on SIGTERM from Running, teardown's
/// `drain_idle_pool` is the *only* site that clears `idle_vms` in
/// `status.json` — Draining mode is skipped entirely. Pre-fix, the
/// stale list leaked into the final `"stopped"` snapshot.
#[tokio::test(start_paused = true)]
async fn shutdown_clears_idle_vms_in_status_json() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    let idle_pool = Arc::clone(&config.idle_pool);
    let run_handle = tokio::spawn(run(config));

    // Park a VM via a normal job → status.json records the idle VM.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-status-clean")),
    );
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    wait_idle_pool_sessions(&idle_pool, &["sess-status-clean"], Duration::from_secs(5)).await;
    assert_eq!(idle_pool.lock().await.len(), 1, "VM parked");

    // Pre-shutdown sanity: status.json lists the idle VM.
    wait_status_idle_sessions_and_active_runs(
        &status_path,
        &["sess-status-clean"],
        &[],
        Duration::from_secs(5),
    )
    .await;
    let pre: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    let pre_len = pre
        .get("idle_vms")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(pre_len, 1, "pre-shutdown status.json should list the VM");

    // SIGTERM path: Draining mode is bypassed, so teardown's
    // drain_idle_pool is the only site that can clear idle_vms.
    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s",
    )
    .await;

    // Post-shutdown: mode=stopped, idle_vms empty/absent.
    let post: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    assert_eq!(post["mode"], "stopped");
    let post_len = post
        .get("idle_vms")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(
        post_len, 0,
        "status.json idle_vms must be cleared after shutdown: {post}",
    );
}

// -----------------------------------------------------------------------
// Test 19: Two sequential jobs for same session → take + reuse + re-park
//
// Exercises the full session affinity cycle: park → take → reuse → park.
// After two jobs the pool should have exactly 1 entry (the second job's
// VM) and the budget count should be 1.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn sequential_same_session_reuse_cycle() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));

    // Job 1: parks VM for session "sess-seq".
    let id1 = RunId::new_v4();
    push_job(
        &env,
        id1,
        "vm0/default",
        Some(context_with_session(id1, "sess-seq")),
    );
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "job 1 should complete");
    wait_idle_pool_sessions(&idle_pool, &["sess-seq"], Duration::from_secs(5)).await;
    assert_eq!(idle_pool.lock().await.len(), 1, "job 1 VM should be parked");

    // Job 2: same session → take → reuse → re-park.
    let id2 = RunId::new_v4();
    push_job(
        &env,
        id2,
        "vm0/default",
        Some(context_with_session(id2, "sess-seq")),
    );
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(c2.is_some(), "job 2 should complete");
    assert_eq!(
        c2.unwrap().reuse_result,
        Some(SandboxReuseResult::Reused),
        "job 2 should reuse the first job's parked VM",
    );
    wait_idle_pool_sessions(&idle_pool, &["sess-seq"], Duration::from_secs(5)).await;

    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "pool should have 1 entry after two sequential jobs"
    );
    assert_eq!(budget.allocated().2, 1, "only one VM should hold budget");

    shutdown(&env, run_handle).await;
}

/// Test 22: `ParkResult::Replaced` via `guest_session_id`.
///
/// A first-run job (no `resume_session`) reads a CLI-generated session ID
/// from the guest filesystem. When that session already has an entry in
/// the idle pool, `pool.park()` returns `Replaced(old)`, the old VM is
/// destroyed, and the new VM takes its place.
#[tokio::test(start_paused = true)]
async fn park_evicts_via_guest_session_id() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "cat /tmp/vm0-session-".into(),
        exit_code: 0,
        stdout: b"sess-evict".to_vec(),
        stderr: Vec::new(),
    });
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.budget);
    let idle_pool = Arc::clone(&config.idle_pool);

    // Pre-seed idle pool with session "sess-evict".
    seed_idle_pool(&idle_pool, &budget, "sess-evict", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "pre-seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));

    // Push job WITHOUT resume_session — first run, no session context.
    // read_guest_session_id() will be called and return "sess-evict"
    // via the exec matcher.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    // After eviction: old entry destroyed + old budget released,
    // new entry parked + new budget held → net count = 1.
    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    let pool = idle_pool.lock().await;
    assert_eq!(pool.len(), 1, "pool should have the newly parked entry");
    assert_eq!(
        pool.held_sessions(),
        vec!["sess-evict"],
        "parked session should match guest_session_id"
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Tests 23-25: park / unpark idle-transition orchestration (#9102)
// -----------------------------------------------------------------------

/// Two sequential jobs on the same session produce park=2 / unpark=1:
/// the first job's post-exit park, plus the second job's take (unpark)
/// and post-exit re-park. Verifies the full reuse cycle drives the
/// new trait hooks symmetrically.
#[tokio::test(start_paused = true)]
async fn reuse_cycle_invokes_park_and_unpark_symmetrically() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.idle_pool);
    let run_handle = tokio::spawn(run(config));

    // Job 1: fresh create → run → park.
    let id1 = RunId::new_v4();
    push_job(
        &env,
        id1,
        "vm0/default",
        Some(context_with_session(id1, "sess-reuse-cycle")),
    );
    assert!(
        env.handle
            .wait_completion(id1, Duration::from_secs(5))
            .await
            .is_some()
    );
    wait_sandbox_lifecycle_counts(&counter, 1, 0, Duration::from_secs(5)).await;

    // Job 2: same session → take (unpark) → run → re-park.
    let id2 = RunId::new_v4();
    push_job(
        &env,
        id2,
        "vm0/default",
        Some(context_with_session(id2, "sess-reuse-cycle")),
    );
    assert!(
        env.handle
            .wait_completion(id2, Duration::from_secs(5))
            .await
            .is_some()
    );
    wait_sandbox_lifecycle_counts(&counter, 2, 1, Duration::from_secs(5)).await;
    assert_eq!(
        counter.park_call_count(),
        2,
        "park() should fire once per job"
    );
    assert_eq!(
        counter.unpark_call_count(),
        1,
        "unpark() should fire only for the reused job"
    );
    assert_eq!(idle_pool.lock().await.len(), 1);

    shutdown(&env, run_handle).await;
}

/// A successful job with a session triggers `Sandbox::park()` exactly once
/// when the VM is handed off to the idle pool.
#[tokio::test(start_paused = true)]
async fn park_called_when_vm_enters_idle_pool() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let idle_pool = Arc::clone(&config.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park-hook")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");

    wait_sandbox_lifecycle_counts(&counter, 1, 0, Duration::from_secs(5)).await;
    wait_idle_pool_sessions(&idle_pool, &["sess-park-hook"], Duration::from_secs(5)).await;
    assert_eq!(
        counter.park_call_count(),
        1,
        "park() should have been called exactly once"
    );
    assert_eq!(
        counter.unpark_call_count(),
        0,
        "unpark() must not be called for a fresh park"
    );
    assert_eq!(idle_pool.lock().await.len(), 1, "VM should be parked");

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Reuse-enabled job whose session has no idle entry reports PoolMiss
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn reuse_enabled_empty_pool_reports_pool_miss() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);

    let run_handle = tokio::spawn(run(config));

    // Empty pool + resume_session set + feature on → PoolMiss branch.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-missing")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::PoolMiss),
        "empty-pool reuse attempt must tag PoolMiss",
    );
    assert!(
        completion.sandbox_id.is_some(),
        "fresh create still allocates a sandbox id",
    );
    // Sanity: no one was in the pool to begin with.
    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "fresh-create sandbox re-parks into the pool",
    );

    shutdown(&env, run_handle).await;
}
