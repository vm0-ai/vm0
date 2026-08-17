use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config, mock_run_config_with_overrides, publish_idle_status,
    push_job, seed_idle_pool, seed_idle_pool_expired_with_overrides, seed_idle_pool_with_overrides,
    shutdown, status_idle_reuse_keys, test_profiles, two_profiles, wait_budget_count,
    wait_discover_entered, wait_idle_pool_len, wait_status_idle_empty_with_active_run,
};

use crate::types::SandboxReuseResult;

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

#[tokio::test(start_paused = true)]
async fn reuse_take_clears_idle_status_while_job_is_active() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let status = Arc::clone(&config.shared.status);
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
        status_idle_reuse_keys(&status_path).await,
        vec!["sess-reuse-status".to_string()],
        "pre-run status should list the seeded idle VM",
    );

    let run_handle = tokio::spawn(run(config));
    let heartbeat_count = env.handle.heartbeat_count();
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-reuse-status")),
    );

    wait_idle_pool_len(&idle_pool, 0, Duration::from_secs(5)).await;
    wait_status_idle_empty_with_active_run(&status_path, run_id, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(heartbeat_count, Duration::from_secs(5))
            .await,
        "idle take should trigger an immediate heartbeat while the reused job is active"
    );
    let post_take_heartbeats = {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        heartbeats[heartbeat_count..].to_vec()
    };
    assert!(
        post_take_heartbeats.iter().any(|heartbeat| {
            heartbeat
                .held_sandbox_states
                .iter()
                .all(|state| state.reuse_key != "sess-reuse-status")
        }),
        "post-take heartbeat should stop advertising the active reuse key; heartbeats: {post_take_heartbeats:?}"
    );

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

#[tokio::test(start_paused = true)]
async fn expired_post_claim_idle_entry_falls_back_to_fresh() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 4, 8192, 2, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let status = Arc::clone(&config.shared.status);
    let status_path = env._temp_dir.path().join("status.json");
    let reuse_key = "thread:expired-post-claim";

    let expired_sandbox_id = seed_idle_pool_expired_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    publish_idle_status(&idle_pool, &status).await;
    assert_eq!(
        status_idle_reuse_keys(&status_path).await,
        vec![reuse_key.to_string()],
        "pre-run status should list the expired idle VM",
    );

    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let run_id = RunId::new_v4();
    let mut claimed_context = context_with_session(run_id, "provider-session-expired");
    claimed_context.reuse_key = Some(reuse_key.to_string());
    env.provider.set_claim_result(run_id, Some(claimed_context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_string())),
        )
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await,
        "claim should start with fresh capacity while the expired entry remains pooled",
    );
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![reuse_key.to_string()],
        "pre-claim admission must leave the expired entry in the pool",
    );
    assert_eq!(
        budget.allocated().2,
        2,
        "expired and fresh admission leases should both be held during claim",
    );

    env.handle.unblock_claims();
    wait_status_idle_empty_with_active_run(&status_path, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("fresh sandbox process should start");
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    assert_eq!(overrides.unpark_call_count(), 0);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(
        overrides.create_configs().len(),
        2,
        "the run should create a fresh sandbox after the seeded expired sandbox",
    );

    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh fallback job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_ne!(completion.sandbox_id, Some(expired_sandbox_id));
    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn profile_mismatch_status_switches_from_idle_to_active_while_job_runs() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(two_profiles(), 16, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let status = Arc::clone(&config.shared.status);
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
        status_idle_reuse_keys(&status_path).await,
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
