use super::super::*;
use super::support::*;

// -----------------------------------------------------------------------
// Test 11: Budget full → job skipped (not claimed) → budget freed → next job succeeds
//
// Different from test 4 (claim failure): here try_reserve returns false
// so claim() is never called. The job stays in the channel but the main
// loop moves on. After the running job completes and frees budget, the
// next discover picks up the waiting job.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn budget_full_skips_then_resumes() {
    // Budget for exactly 1 job (2 vcpu, 4096 MB).
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let run_handle = tokio::spawn(run(config));

    // First job: claims the entire budget.
    let id1 = RunId::new_v4();
    push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));

    // Wait for job 1 to be claimed (budget now full).
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Second job: pushed while budget is full. try_reserve fails →
    // the job is skipped without claim. But it remains in the channel.
    let id2 = RunId::new_v4();
    push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));

    // Job 1 completes (MockSandbox is instant) → budget freed.
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "first job should complete");

    // After budget is freed, the main loop re-enters the normal select!
    // and discovers job 2 from the channel.
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(
        c2.is_some(),
        "second job should complete after budget is freed"
    );

    shutdown(&env, run_handle).await;
}

/// Budget-exhausted mode must not poll discovery. A queued job should
/// remain undiscovered until a running job frees budget, otherwise the
/// runner may claim work it cannot admit.
#[tokio::test(start_paused = true)]
async fn budget_exhausted_buffers_discovery_until_budget_frees() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.budget);
    let run_handle = tokio::spawn(run(config));
    env.handle.discover_entered.notified().await;

    let id1 = RunId::new_v4();
    push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));
    let _token_1 = wait_cancel_token(&env.cancel_tokens, id1, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let id2 = RunId::new_v4();
    push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));
    tokio::time::timeout(
        Duration::from_millis(100),
        env.handle.discover_entered.notified(),
    )
    .await
    .expect_err("discovery must not be polled while budget is exhausted");
    assert!(
        !env.cancel_tokens.lock().await.contains_key(&id2),
        "queued job must not be claimed while budget is exhausted",
    );
    assert!(
        env.handle
            .completions
            .lock()
            .unwrap()
            .iter()
            .all(|c| c.run_id != id2),
        "queued job must not complete before budget frees",
    );

    gate.notify_one();
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "first job should complete");

    let _token_2 = wait_cancel_token(&env.cancel_tokens, id2, Duration::from_secs(5)).await;
    gate.notify_one();
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(
        c2.is_some(),
        "queued job should complete after budget is freed",
    );
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 15: Cleanup tick evicts expired idle entries
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn cleanup_tick_evicts_expired_entries() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);

    // Pre-seed: park an entry that is already expired (400s old, 300s timeout).
    seed_idle_pool_expired(&idle_pool, &budget, "sess-exp", "vm0/default", 2, 4096).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "should have 1 seeded entry"
    );
    assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));

    // Advance past the first cleanup tick (every 10s).
    // The tick interval fires once immediately (at t=0), but the entry
    // was just inserted so it may not be expired yet from Instant::now()'s
    // perspective. Advance 11s to ensure at least one full tick fires.
    tokio::time::sleep(Duration::from_secs(11)).await;

    // Eviction spawns a destroy_task that releases the idle entry lease.
    // Poll until it completes.
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    let pool_len = idle_pool.lock().await.len();
    assert_eq!(pool_len, 0, "expired entry should be evicted");

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 16: Budget exhausted → evict idle VM → admit new job
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn budget_exhausted_evicts_idle_and_admits_job() {
    // Budget: exactly 1 default job (2 vcpu, 4096 MB).
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 2);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);

    // Pre-seed: idle VM fills the entire budget.
    seed_idle_pool(&idle_pool, &budget, "sess-evict", "vm0/default", 2, 4096).await;
    assert!(
        !budget.can_afford(2, 4096),
        "budget should be exhausted after seeding"
    );

    let run_handle = tokio::spawn(run(config));

    // Push new job — budget is full, but idle pool has an entry to evict.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job should complete after idle VM eviction frees budget"
    );
    assert_eq!(completion.unwrap().exit_code, 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn budget_exhausted_reclaims_expired_before_oldest_idle() {
    let (config, env) = mock_run_config(two_profiles(), 6, 12288, 3);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let now = std::time::Instant::now();

    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkCandidateSpec {
            session_id: "sess-old-active",
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            parked_at: now - Duration::from_secs(100),
            idle_timeout: Duration::from_secs(300),
        },
    )
    .await;
    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkCandidateSpec {
            session_id: "sess-expired-newer",
            profile_name: "vm0/large",
            vcpu: 4,
            memory_mb: 8192,
            parked_at: now - Duration::from_secs(10),
            idle_timeout: Duration::from_secs(1),
        },
    )
    .await;
    assert!(
        !budget.can_afford(2, 4096),
        "seeded idle entries should exhaust budget"
    );

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job should complete after expired idle reclaim frees budget"
    );
    assert_eq!(completion.unwrap().exit_code, 0);

    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let sessions = idle_pool.lock().await.held_sessions();
    assert_eq!(
        sessions,
        vec!["sess-old-active".to_string()],
        "expired idle entry should be reclaimed before oldest active entry"
    );
    assert_eq!(
        status_idle_sessions(&status_path).await,
        vec!["sess-old-active".to_string()],
        "status.json should reflect the remaining idle VM"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn budget_exhausted_evicts_oldest_when_expired_reclaim_insufficient() {
    let (config, env) = mock_run_config(two_profiles(), 7, 13312, 3);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let now = std::time::Instant::now();

    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkCandidateSpec {
            session_id: "sess-old-active",
            profile_name: "vm0/large",
            vcpu: 4,
            memory_mb: 8192,
            parked_at: now - Duration::from_secs(100),
            idle_timeout: Duration::from_secs(300),
        },
    )
    .await;
    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkCandidateSpec {
            session_id: "sess-new-active",
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            parked_at: now - Duration::from_secs(50),
            idle_timeout: Duration::from_secs(300),
        },
    )
    .await;
    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkCandidateSpec {
            session_id: "sess-expired-small",
            profile_name: "vm0/default",
            // Intentionally smaller than the current min profile. With
            // only profile-sized entries, releasing one expired VM is
            // already enough to admit the min profile; this pins the
            // fallback loop for stale/non-current idle footprints.
            vcpu: 1,
            memory_mb: 1024,
            parked_at: now - Duration::from_secs(10),
            idle_timeout: Duration::from_secs(1),
        },
    )
    .await;
    assert!(
        !budget.can_afford(2, 4096),
        "seeded idle entries should exhaust budget"
    );

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job should complete after expired reclaim plus oldest eviction"
    );
    assert_eq!(completion.unwrap().exit_code, 0);

    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let sessions = idle_pool.lock().await.held_sessions();
    assert_eq!(
        sessions,
        vec!["sess-new-active".to_string()],
        "expired entry and oldest active entry should be reclaimed"
    );
    assert_eq!(
        status_idle_sessions(&status_path).await,
        vec!["sess-new-active".to_string()],
        "status.json should reflect only the remaining idle VM"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn budget_pressure_eviction_clears_status_json_idle_vms() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 2);
    let idle_pool = Arc::clone(&config.idle_pool);
    let budget = Arc::clone(&config.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-pressure-status")),
    );
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete and park");
    assert_eq!(completion.unwrap().exit_code, 0);

    // The single parked VM fills the whole budget, so the Running loop's
    // pressure path evicts it even without another pending job.
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(idle_pool.lock().await.len(), 0, "idle pool should be empty");
    assert!(
        status_idle_sessions(&status_path).await.is_empty(),
        "status.json should clear the pressure-evicted idle VM"
    );

    shutdown(&env, run_handle).await;
}
