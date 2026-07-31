use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, seed_idle_pool, shutdown, test_profiles, wait_budget_count,
    wait_idle_pool_session_states, wait_idle_pool_sessions, wait_sandbox_lifecycle_counts,
};

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
        ctx.reuse_key = Some(format!("session:{sid}"));
        ctx.resume_session = Some(crate::types::ResumeSession::inline(
            sid.to_string(),
            String::new(),
        ));
    }
    ctx
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
    assert!(pool.held_sessions().contains(&"session:sess-1".to_string()));
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
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
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
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
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
// Test 19: Two sequential jobs for same session → take + reuse + re-park
//
// Exercises the full session affinity cycle: park → take → reuse → park.
// After two jobs the pool should have exactly 1 entry (the second job's
// VM) and the budget count should be 1.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn sequential_same_session_reuse_cycle() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
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
    wait_idle_pool_session_states(&idle_pool, &["sess-seq"], Duration::from_secs(5)).await;
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

#[tokio::test(start_paused = true)]
async fn same_thread_reuses_vm_across_provider_session_change() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));
    let reuse_key = "thread:chat-thread";

    let first_run_id = RunId::new_v4();
    let mut first_context = context_with_session(first_run_id, "provider-session-a");
    first_context.reuse_key = Some(reuse_key.into());
    push_job(&env, first_run_id, "vm0/default", Some(first_context));
    assert!(
        env.handle
            .wait_completion(first_run_id, Duration::from_secs(5))
            .await
            .is_some()
    );
    wait_idle_pool_session_states(&idle_pool, &["provider-session-a"], Duration::from_secs(5))
        .await;

    let second_run_id = RunId::new_v4();
    let mut second_context = context_with_session(second_run_id, "provider-session-b");
    second_context.reuse_key = Some(reuse_key.into());
    push_job(&env, second_run_id, "vm0/default", Some(second_context));
    let completion = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second job should complete");
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::Reused),
        "the thread reuse key should select the first job's parked VM"
    );
    wait_idle_pool_session_states(&idle_pool, &["provider-session-b"], Duration::from_secs(5))
        .await;
    wait_idle_pool_sessions(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

/// Test 22: `ParkResult::Replaced` via `discovered_cli_agent_session_id`.
///
/// A first-run job (no `resume_session`) reads a CLI-generated session ID
/// from the guest filesystem. When that session already has an entry in
/// the idle pool, `pool.park()` returns `Replaced(old)`, the old VM is
/// destroyed, and the new VM takes its place.
#[tokio::test(start_paused = true)]
async fn park_evicts_via_discovered_cli_agent_session_id() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "/.vm0/guest-agent/runs/".into(),
        exit_code: 0,
        stdout: b"sess-evict".to_vec(),
        stderr: Vec::new(),
    });
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);

    // Pre-seed idle pool with session "sess-evict".
    seed_idle_pool(&idle_pool, &budget, "sess-evict", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "pre-seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));

    // Push job WITHOUT resume_session — first run, no session context.
    // read_guest_cli_agent_session_id() will be called and return "sess-evict"
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
        "parked session should match discovered_cli_agent_session_id"
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
    let idle_pool = Arc::clone(&config.shared.idle_pool);
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
    wait_idle_pool_session_states(&idle_pool, &["sess-reuse-cycle"], Duration::from_secs(5)).await;

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
    let idle_pool = Arc::clone(&config.shared.idle_pool);
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
