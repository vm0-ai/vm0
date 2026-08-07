use super::super::super::*;
use super::super::support::{
    TEST_HEARTBEAT_GENERATION, TEST_RUNNER_ID, assert_run_exits_within, context_with_session,
    minimal_context, mock_run_config, mock_run_config_with_overrides, push_job, seed_idle_pool,
    seed_idle_pool_with_history_generation, seed_idle_pool_with_overrides,
    seed_workspace_cache_state, shutdown, test_profiles, wait_budget_count, wait_cancel_token,
    wait_cancel_token_removed, wait_discover_entered, wait_idle_pool_len,
    wait_status_idle_reuse_keys_and_active_runs,
};
use std::sync::Arc;

use crate::paths::RunnerPaths;
use crate::provider::{
    ActiveRunnerPreference, RunnerPreference, RunnerPreferenceClaimState, RunnerPreferenceTier,
};
use crate::types::SandboxReuseResult;
use crate::workspace_image_cache::WorkspaceImageCache;

const NON_SELECTED_RUNNER_ID: u128 = 1;

fn ranked_candidate(
    run_id: RunId,
    reuse_key: Option<&str>,
    tier: RunnerPreferenceTier,
    runner_id: &str,
    heartbeat_generation: u64,
) -> crate::provider::JobCandidate {
    ranked_candidate_until(
        run_id,
        reuse_key,
        tier,
        runner_id,
        heartbeat_generation,
        std::time::Instant::now() + Duration::from_secs(30),
    )
}

fn ranked_candidate_until(
    run_id: RunId,
    reuse_key: Option<&str>,
    tier: RunnerPreferenceTier,
    runner_id: &str,
    heartbeat_generation: u64,
    deadline: std::time::Instant,
) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(reuse_key.map(str::to_owned))
        .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
            runner_id.parse().unwrap(),
            heartbeat_generation,
            tier,
            deadline,
        ))
}

fn matching_preference_candidate(run_id: RunId, session_id: &str) -> crate::provider::JobCandidate {
    ranked_candidate(
        run_id,
        Some(session_id),
        RunnerPreferenceTier::ReusableSandbox,
        TEST_RUNNER_ID,
        TEST_HEARTBEAT_GENERATION,
    )
}

fn exact_generation_preference_candidate(
    run_id: RunId,
    session_id: &str,
    target_generation_run_id: RunId,
) -> crate::provider::JobCandidate {
    ranked_candidate(
        run_id,
        Some(session_id),
        RunnerPreferenceTier::ExactSandbox,
        TEST_RUNNER_ID,
        TEST_HEARTBEAT_GENERATION,
    )
    .with_history_generation_run_id(Some(target_generation_run_id))
}

fn finalizing_candidate(
    run_id: RunId,
    reuse_key: &str,
    history_generation_run_id: RunId,
    runner_id: &str,
    heartbeat_generation: u64,
) -> crate::provider::JobCandidate {
    finalizing_candidate_until(
        run_id,
        reuse_key,
        history_generation_run_id,
        runner_id,
        heartbeat_generation,
        std::time::Instant::now() + Duration::from_secs(30),
    )
}

fn finalizing_candidate_until(
    run_id: RunId,
    reuse_key: &str,
    history_generation_run_id: RunId,
    runner_id: &str,
    heartbeat_generation: u64,
    deadline: std::time::Instant,
) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some(reuse_key.to_owned()))
        .with_history_generation_run_id(Some(history_generation_run_id))
        .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
            runner_id.parse().unwrap(),
            heartbeat_generation,
            RunnerPreferenceTier::FinalizingPredecessor,
            deadline,
        ))
}

fn context_with_reuse_key(run_id: RunId, reuse_key: &str) -> crate::types::ExecutionContext {
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    context
}

/// TOCTOU regression: soft drain can arrive after the main loop has selected
/// a discovered candidate but before claim. The candidate is still unowned at
/// that point, so Draining must roll back local admission and skip claim.
#[tokio::test]
async fn claim_after_draining_sent_skips_unclaimed_job() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    assert!(env.parking_gate.soft_drain());
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Draining;
        false
    });

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "draining should skip the discovered unclaimed job and exit",
    )
    .await;

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    let completions = env.handle.completions.lock().unwrap();
    assert!(
        !completions
            .iter()
            .any(|completion| completion.run_id == run_id),
        "draining should not claim or complete a newly discovered job"
    );
}

/// Ordering regression: hard shutdown publishes `Stopping` before entering
/// the cancellation registry's hard-stop barrier. A discovery that registers
/// in that window must observe Stopping and cancel before provider claim. The
/// registry independently covers registrations after the barrier begins; this
/// test isolates the discovery-side mode recheck.
///
/// To reproduce deterministically, we use `send_if_modified` to flip
/// the watch value to `Stopping` **without** waking `mode_rx.changed()`
/// or entering the registry barrier. This is what the pre-barrier window
/// looks like to the main loop: its outer select! is still polling
/// discover_fut, unaware that the value has changed. When discover yields a
/// job, the main loop takes the claim path, registers cancellation, then reads
/// `mode_rx.borrow()` and catches the Stopping value that was silently written.
#[tokio::test]
async fn claim_after_stopping_sent_cancels_new_job() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Deterministic barrier: wait for run()'s main loop to have polled
    // `discover_fut` into its await state. Only then is the Running-mode
    // reactor `select!` provably in place, which is the precondition for the
    // silent `send_if_modified` below to land without waking the loop.
    // A wall-clock sleep here flakes under coverage CI — see #10146.
    // The 2s timeout gives a clear diagnostic if the "loop parks on
    // discover" invariant ever regresses, rather than hanging until
    // the outer test harness kills us.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Flip the watch value to Stopping without firing changed().
    env.parking_gate.close();
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Stopping;
        false
    });

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // `wait_completion` is event-driven (fires on `provider.complete`), so
    // this duration is a diagnostic cap for genuine hangs — not a budget
    // for the run. A large cap absorbs coverage-CI slowdown of the full
    // dispatch→executor→complete chain without flaking (see #10146).
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await;
    assert!(
        c.is_some(),
        "job must report cancellation even when the handler missed the token"
    );
    assert_eq!(c.unwrap().error.as_deref(), Some("cancelled by user"));

    // Let run() exit — fire changed() now so the main loop observes
    // Stopping at loop top and breaks to teardown.
    env.parking_gate.close();
    env.mode_tx.send_modify(|v| {
        *v = RunnerMode::Stopping;
    });
    env.cancel.cancel();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "run should exit within 5s after Stopping notification",
    )
    .await;
}

// -----------------------------------------------------------------------
// Test 4: An unavailable claim rolls back budget
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn claim_failure_rolls_back_budget() {
    // Budget for exactly 1 job (2 vcpu, 4096 MB matches the test profile).
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // First job: claim returns None (unavailable).
    let run_id_1 = RunId::new_v4();
    let target_generation_run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id_1, None);
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id_1, "vm0/default".into())
                .with_history_generation_run_id(Some(target_generation_run_id)),
        )
        .unwrap();

    // Returning to discovery proves the failed claim was processed.
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id_1, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 0);
    // Second job: claim succeeds — budget should have been freed.
    let run_id_2 = RunId::new_v4();
    push_job(
        &env,
        run_id_2,
        "vm0/default",
        Some(minimal_context(run_id_2)),
    );

    let completion = env
        .handle
        .wait_completion(run_id_2, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "second job should complete (budget freed after unavailable claim)"
    );
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn claim_run_id_mismatch_rolls_back_local_state() {
    // Budget for exactly 1 job, so a leaked lease would block the follow-up job.
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let candidate_run_id = RunId::new_v4();
    let context_run_id = RunId::new_v4();
    push_job(
        &env,
        candidate_run_id,
        "vm0/default",
        Some(minimal_context(context_run_id)),
    );

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, candidate_run_id, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 0);
    {
        let completions = env.handle.completions.lock().unwrap();
        assert!(
            !completions
                .iter()
                .any(|completion| completion.run_id == candidate_run_id
                    || completion.run_id == context_run_id),
            "mismatched claim should not produce a completion for either run id"
        );
    }

    let followup_run_id = RunId::new_v4();
    push_job(
        &env,
        followup_run_id,
        "vm0/default",
        Some(minimal_context(followup_run_id)),
    );

    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "follow-up job should complete after mismatched claim is rejected"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn exact_idle_reservation_is_restored_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-conflict-restore";
    let reserved_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &idle_pool,
        &budget,
        session_id,
        "vm0/default",
        2,
        4096,
        reserved_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let conflict_run_id = RunId::new_v4();
    env.provider.set_claim_result(conflict_run_id, None);
    env.handle
        .discover_tx
        .send(
            ranked_candidate(
                conflict_run_id,
                Some(session_id),
                RunnerPreferenceTier::ExactSandbox,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            )
            .with_history_generation_run_id(Some(reserved_generation_run_id)),
        )
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, conflict_run_id, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "claim conflict should restore the exact idle reservation"
    );
    assert_eq!(
        budget.allocated(),
        (2, 4096, 1),
        "restored reservation should retain its original budget lease"
    );
    let followup_run_id = RunId::new_v4();
    let followup_target_generation_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        followup_run_id,
        Some(context_with_session(followup_run_id, session_id)),
    );
    env.handle
        .discover_tx
        .send(
            matching_preference_candidate(followup_run_id, session_id)
                .with_history_generation_run_id(Some(followup_target_generation_run_id)),
        )
        .unwrap();
    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await
        .expect("restored idle reservation should serve the next claim");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn matching_preference_reservation_is_restored_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-generic-conflict-restore";
    seed_idle_pool(&idle_pool, &budget, session_id, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "lost claim should restore the generic reusable reservation"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

    let ordinary_run_id = RunId::new_v4();
    env.provider.set_claim_result(ordinary_run_id, None);
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(ordinary_run_id, "vm0/default".into())
                .with_reuse_key(Some(session_id.to_owned())),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, ordinary_run_id, Duration::from_secs(5)).await;

    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "ordinary lost claim should also restore the reusable reservation"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unselected_reusable_sandbox_preempts_workspace_preference() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:reusable-preempts-workspace";
    seed_idle_pool(&env.idle_pool, &budget, reuse_key, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::WorkspaceCache,
            &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
            1,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("strictly better reusable sandbox should preempt workspace preference");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn equal_unselected_reusable_sandbox_defers() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:equal-reusable-defers";
    seed_idle_pool(&env.idle_pool, &budget, reuse_key, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::ReusableSandbox,
            &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
            1,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);
    assert_eq!(
        env.idle_pool.lock().await.held_reuse_keys(),
        vec![reuse_key.to_string()],
        "equal-tier unselected admission must not reserve the sandbox"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn reusable_claim_without_generation_target_reuses_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-missing-generation-target";
    seed_idle_pool_with_history_generation(
        &idle_pool,
        &budget,
        session_id,
        "vm0/default",
        2,
        4096,
        RunId::new_v4(),
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("missing-target reusable candidate should be claimed");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    let claim_candidates = env.handle.claim_candidates();
    let candidate = claim_candidates
        .iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("missing-target reusable candidate should reach claim");
    assert_eq!(
        candidate
            .runner_preference()
            .map(ActiveRunnerPreference::tier),
        Some(RunnerPreferenceTier::ReusableSandbox)
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn generation_protected_different_idle_sandbox_defers_before_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-different-generation";
    let held_generation_run_id = RunId::new_v4();
    let target_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &idle_pool,
        &budget,
        session_id,
        "vm0/default",
        2,
        4096,
        held_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(exact_generation_preference_candidate(
            run_id,
            session_id,
            target_generation_run_id,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "a different reusable generation must not reach claim during exact protection"
    );
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);
    let pool = idle_pool.lock().await;
    assert_eq!(pool.held_reuse_keys(), vec![session_id.to_string()]);
    assert_eq!(
        pool.held_sandbox_states()[0]
            .reusable_sandbox
            .history_generation_run_id,
        Some(held_generation_run_id),
        "the different generation must remain available for fallback after expiry"
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn matching_preference_without_local_resource_defers_before_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(context_with_session(run_id, "sess-owned-elsewhere")),
    );
    env.handle
        .discover_tx
        .send(matching_preference_candidate(
            run_id,
            "sess-owned-elsewhere",
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    assert!(
        env.handle.claim_candidates().is_empty(),
        "runner must not claim a protected same-reuse-key candidate without local reusable state"
    );
    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "runner should schedule a follow-up poll after the preference expires"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn reusable_active_run_discovery_does_not_bypass_ordinary_capacity_admission() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let occupied = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let active_guard = env.active_runs.register(
        RunId::new_v4(),
        Some("thread:active-capacity-gate".into()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .all(|candidate| candidate.run_id() != run_id),
        "ordinary work must still reserve local capacity before provider claim"
    );

    drop(occupied);
    drop(active_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn selected_finalizing_candidate_claims_while_predecessor_is_running() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let reuse_key = "thread:pending-finalization";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let pending_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        pending_run_id,
        Some(context_with_reuse_key(pending_run_id, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            pending_run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == pending_run_id),
        "selected finalizing candidate should be claimed while the predecessor is active"
    );

    let unrelated_run_id = RunId::new_v4();
    push_job(
        &env,
        unrelated_run_id,
        "vm0/default",
        Some(minimal_context(unrelated_run_id)),
    );
    assert!(
        env.handle
            .wait_completion(unrelated_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "unrelated work should continue while a finalizing candidate is pending"
    );

    drop(predecessor_guard);
    assert!(
        env.handle
            .wait_completion(pending_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "active-key release without a reusable resource should wake ordinary admission"
    );
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == pending_run_id)
        .expect("finalizing candidate should already be claimed");
    let preference_telemetry = claimed
        .runner_preference_claim_telemetry()
        .expect("finalizing observation should be recorded at claim");
    assert!(matches!(
        preference_telemetry.runner_preference,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::FinalizingPredecessor,
            ..
        }
    ));
    assert_eq!(
        preference_telemetry.state,
        Some(RunnerPreferenceClaimState::Active)
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn selected_ranked_finalizing_candidate_falls_back_at_deadline() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:ranked-finalizing-retained";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    let deadline = std::time::Instant::now() + Duration::from_millis(100);
    env.handle
        .discover_tx
        .send(
            ranked_candidate_until(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
                deadline,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id),
        "selected finalizing candidate should be claimed before its deadline"
    );

    tokio::time::advance(Duration::from_millis(101)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("expired finalizing preference should enter ordinary admission");
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("expired candidate should reach claim");
    let telemetry = claimed
        .runner_preference_claim_telemetry()
        .expect("decision observation should survive expiry");
    assert!(matches!(
        telemetry.runner_preference,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::FinalizingPredecessor,
            ..
        }
    ));
    assert_eq!(telemetry.state, Some(RunnerPreferenceClaimState::Active));

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn selected_finalizing_candidate_claims_exact_resource_on_reuse_state_wakeup() {
    let predecessor_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(predecessor_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let reuse_key = "thread:pending-exact-resource";
    let history_generation_run_id = RunId::new_v4();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    push_job(
        &env,
        history_generation_run_id,
        "vm0/default",
        Some(context_with_reuse_key(history_generation_run_id, reuse_key)),
    );
    let _predecessor_cancel = wait_cancel_token(
        &env.cancel_tokens,
        history_generation_run_id,
        Duration::from_secs(5),
    )
    .await;
    predecessor_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("predecessor should still be running when its successor is discovered");

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            ranked_candidate(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[],
        &[history_generation_run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;

    predecessor_gate.release_one();
    env.handle
        .wait_completion(history_generation_run_id, Duration::from_secs(5))
        .await
        .expect("predecessor should complete and publish its sandbox");
    predecessor_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("successor should activate the published sandbox");
    predecessor_gate.release_one();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("predecessor finalization should wake the claimed successor");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_after_finalizing_publication_restores_exact_resource() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:cancel-after-finalization";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_finalization = predecessor_guard.finalization_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    predecessor_finalization.mark_finalized();
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;

    env.cancel_tokens
        .handle(run_id)
        .await
        .expect("claimed finalizing successor should retain cancellation registration")
        .request_hard_cancellation()
        .await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("cancelled finalizing successor should complete");
    assert_eq!(completion.exit_code, 137);
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert!(completion.sandbox_id.is_none());
    wait_idle_pool_len(&env.idle_pool, 1, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn finalizing_release_deadline_restores_exact_before_fallback() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:finalized-release-deadline";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_finalization = predecessor_guard.finalization_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            ranked_candidate_until(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
                std::time::Instant::now() + Duration::from_millis(100),
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    predecessor_finalization.mark_finalized();
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;

    tokio::time::advance(Duration::from_millis(101)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("stuck predecessor release should enter fallback at the original deadline");
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "fallback should retain the original claim"
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn competing_finalizing_successors_reserve_exact_generation_once() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:competing-finalizing-successors";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_finalization = predecessor_guard.finalization_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let first_run_id = RunId::new_v4();
    let second_run_id = RunId::new_v4();
    for run_id in [first_run_id, second_run_id] {
        env.provider
            .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
        env.handle
            .discover_tx
            .send(finalizing_candidate(
                run_id,
                reuse_key,
                history_generation_run_id,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            ))
            .unwrap();
        wait_discover_entered(&env, Duration::from_secs(5)).await;
    }

    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    predecessor_finalization.mark_finalized();
    drop(predecessor_guard);

    let first = env
        .handle
        .wait_completion(first_run_id, Duration::from_secs(5))
        .await
        .expect("first finalizing successor should complete");
    let second = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second finalizing successor should complete");
    assert_eq!(
        [first.reuse_result, second.reuse_result]
            .into_iter()
            .filter(|result| *result == Some(SandboxReuseResult::Reused))
            .count(),
        1,
        "an exact history generation must be reserved by at most one successor"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn hard_stop_cancels_claimed_finalizing_candidate_without_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:hard-stop-finalizing";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    env.trigger_stopping().await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("hard-stopped finalizing successor should complete");
    assert_eq!(completion.exit_code, 137);
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert!(completion.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    drop(predecessor_guard);
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard stop should drain a claimed finalizing successor",
    )
    .await;
    assert_eq!(
        env.handle
            .completions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|record| record.run_id == run_id)
            .count(),
        1
    );
}

#[tokio::test]
async fn pre_sandbox_panic_completes_finalizing_claim_once_without_status() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::ClaimedWithoutSandbox);
    let status_path = env._temp_dir.path().join("status.json");
    let reuse_key = "thread:panic-before-sandbox";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("pre-sandbox panic should complete the claimed run");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(
        completion.error.as_deref(),
        Some("runner panicked while preparing a claimed finalizing successor")
    );
    assert!(completion.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_eq!(
        env.handle
            .completions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|record| record.run_id == run_id)
            .count(),
        1
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unselected_exact_sandbox_preempts_finalizing_preference() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:exact-preempts-finalizing";
    let history_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            ranked_candidate(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
                1,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("strictly better exact sandbox should preempt finalizing preference");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn selected_finalizing_candidate_restores_exact_resource_after_claim_loss() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:finalizing-claim-loss";
    let history_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(
        env.idle_pool.lock().await.held_reuse_keys(),
        vec![reuse_key.to_string()],
        "lost claim should restore the exact reusable resource"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn non_selected_finalizing_candidate_is_not_retained() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:non-selected-finalization";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
            1,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    drop(predecessor_guard);
    tokio::task::yield_now().await;
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn same_run_duplicate_does_not_renew_claimed_finalizing_deadline() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let reuse_key = "thread:pending-duplicate";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    let original_deadline = std::time::Instant::now() + Duration::from_millis(100);
    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            original_deadline,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "the first discovery should claim the finalizing successor"
    );

    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            std::time::Instant::now() + Duration::from_secs(30),
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "a duplicate discovery must not claim the same run again"
    );
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    tokio::time::advance(Duration::from_millis(101)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "the original deadline should start fallback despite a later duplicate"
    );
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("expired pending candidate should reach claim");
    let preference_telemetry = claimed
        .runner_preference_claim_telemetry()
        .expect("finalizing observation should survive expiry");
    assert!(matches!(
        preference_telemetry.runner_preference,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::FinalizingPredecessor,
            ..
        }
    ));
    assert_eq!(
        preference_telemetry.state,
        Some(RunnerPreferenceClaimState::Active)
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn multiple_finalizing_candidates_can_be_claimed_concurrently() {
    let (config, env) = mock_run_config(test_profiles(), 6, 12288, 3);
    let first_reuse_key = "thread:pending-slot-first";
    let second_reuse_key = "thread:pending-slot-second";
    let first_history_generation_run_id = RunId::new_v4();
    let second_history_generation_run_id = RunId::new_v4();
    let first_guard = env.active_runs.register(
        first_history_generation_run_id,
        Some(first_reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let second_guard = env.active_runs.register(
        second_history_generation_run_id,
        Some(second_reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let first_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        first_run_id,
        Some(context_with_reuse_key(first_run_id, first_reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            first_run_id,
            first_reuse_key,
            first_history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let second_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        second_run_id,
        Some(context_with_reuse_key(second_run_id, second_reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            second_run_id,
            second_reuse_key,
            second_history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == first_run_id),
        "the first finalizing successor should be claimed"
    );
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == second_run_id),
        "a second finalizing successor should not be blocked by a process-local pending slot"
    );

    drop(first_guard);
    drop(second_guard);
    assert!(
        env.handle
            .wait_completion(first_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "the first claimed successor should fall back after predecessor release"
    );
    assert!(
        env.handle
            .wait_completion(second_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "the second claimed successor should fall back independently"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn drain_waits_for_claimed_finalizing_candidate() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:pending-drain";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id),
        "the finalizing successor should be claimed before drain"
    );

    env.drain();
    drop(predecessor_guard);
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "drain should finish the already claimed finalizing successor and exit",
    )
    .await;
    assert!(
        env.handle
            .wait_completion(run_id, Duration::ZERO)
            .await
            .is_some()
    );
}

#[tokio::test(start_paused = true)]
async fn preference_without_reuse_key_uses_ordinary_admission() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(minimal_context(run_id)));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            None,
            RunnerPreferenceTier::ReusableSandbox,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "incomplete preference metadata is advisory"
    );
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn selected_finalizing_candidate_without_reuse_key_uses_ordinary_admission() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(minimal_context(run_id)));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_history_generation_run_id(Some(RunId::new_v4()))
                .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
                    TEST_RUNNER_ID.parse().unwrap(),
                    TEST_HEARTBEAT_GENERATION,
                    RunnerPreferenceTier::FinalizingPredecessor,
                    std::time::Instant::now() + Duration::from_secs(30),
                )),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "missing reuse metadata should preserve ordinary admission"
    );
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("candidate with incomplete reuse metadata should reach provider claim");
    assert!(
        claimed.runner_preference().is_none(),
        "ordinary admission should clear the incomplete advisory preference"
    );
    let preference_telemetry = claimed
        .runner_preference_claim_telemetry()
        .expect("incomplete finalizing metadata should preserve its observation");
    assert!(matches!(
        preference_telemetry.runner_preference,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::FinalizingPredecessor,
            ..
        }
    ));
    assert_eq!(
        preference_telemetry.state,
        Some(RunnerPreferenceClaimState::Cleared)
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn matching_preference_uses_actual_local_sandbox_without_resource_class() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-local-without-resource";
    seed_idle_pool(&idle_pool, &budget, session_id, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("actual compatible sandbox should satisfy matching preference");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_continues_after_preference_defer() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let trigger_run_id = RunId::new_v4();
    let protected_run_id = RunId::new_v4();
    let followup_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        protected_run_id,
        Some(context_with_session(
            protected_run_id,
            "sess-owned-elsewhere",
        )),
    );
    env.provider
        .set_claim_result(followup_run_id, Some(minimal_context(followup_run_id)));
    env.handle
        .push_ready_candidate(matching_preference_candidate(
            protected_run_id,
            "sess-owned-elsewhere",
        ));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            followup_run_id,
            "vm0/default".into(),
        ));

    push_job(
        &env,
        trigger_run_id,
        "vm0/default",
        Some(minimal_context(trigger_run_id)),
    );

    let trigger_completion = env
        .handle
        .wait_completion(trigger_run_id, Duration::from_secs(5))
        .await;
    assert!(
        trigger_completion.is_some(),
        "trigger job should complete before ready-candidate drain assertions"
    );
    let followup_completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        followup_completion.is_some(),
        "ready drain should continue to a later candidate after deferring a protected one"
    );
    wait_cancel_token_removed(&env.cancel_tokens, protected_run_id, Duration::from_secs(5)).await;

    let claim_candidates = env.handle.claim_candidates();
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == trigger_run_id),
        "trigger candidate should be claimed"
    );
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == followup_run_id),
        "follow-up ready candidate should be claimed"
    );
    assert!(
        !claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == protected_run_id),
        "protected ready candidate should be deferred before claim"
    );
    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "protected ready candidate should schedule one follow-up poll"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_continues_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let trigger_run_id = RunId::new_v4();
    let conflict_run_id = RunId::new_v4();
    let followup_run_id = RunId::new_v4();
    env.provider.set_claim_result(conflict_run_id, None);
    env.provider
        .set_claim_result(followup_run_id, Some(minimal_context(followup_run_id)));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            conflict_run_id,
            "vm0/default".into(),
        ));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            followup_run_id,
            "vm0/default".into(),
        ));

    push_job(
        &env,
        trigger_run_id,
        "vm0/default",
        Some(minimal_context(trigger_run_id)),
    );

    let trigger_completion = env
        .handle
        .wait_completion(trigger_run_id, Duration::from_secs(5))
        .await;
    assert!(trigger_completion.is_some(), "trigger job should complete");
    let followup_completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        followup_completion.is_some(),
        "ready drain should continue to a later candidate after a claim conflict"
    );
    wait_cancel_token_removed(&env.cancel_tokens, conflict_run_id, Duration::from_secs(5)).await;

    let claim_candidates = env.handle.claim_candidates();
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == conflict_run_id),
        "claim conflict candidate should reach claim"
    );
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == followup_run_id),
        "follow-up ready candidate should still be claimed"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn expired_generation_protection_preserves_local_session_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-held-local",
        "vm0/default",
        2,
        4096,
    )
    .await;
    assert!(
        !budget.can_afford(2, 4096),
        "the parked sandbox should exhaust all fresh admission capacity"
    );

    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(context_with_session(run_id, "sess-held-local")),
    );
    env.handle
        .discover_tx
        .send(
            ranked_candidate_until(
                run_id,
                Some("sess-held-local"),
                RunnerPreferenceTier::ExactSandbox,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
                std::time::Instant::now() - Duration::from_secs(1),
            )
            .with_history_generation_run_id(Some(RunId::new_v4())),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("runner holding the protected session should claim and execute the job");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    let claim_candidates = env.handle.claim_candidates();
    let claimed_candidate = claim_candidates
        .iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("claim should record the protected candidate");
    assert!(
        claimed_candidate
            .main_loop_to_local_admission_elapsed()
            .is_some()
    );
    assert!(
        env.handle.deferred_poll_deadlines().is_empty(),
        "runner holding the protected session should not defer the claim"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn selected_reusable_defers_for_cache_then_selected_workspace_claims_it() {
    let reuse_key = "thread:cache-local";
    let provider_session_id = "provider-session-cache-local";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        image_size_bytes,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reusable_run_id = RunId::new_v4();
    let mut reusable_context = context_with_session(reusable_run_id, provider_session_id);
    reusable_context.reuse_key = Some(reuse_key.into());
    env.provider
        .set_claim_result(reusable_run_id, Some(reusable_context));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            reusable_run_id,
            Some(reuse_key),
            RunnerPreferenceTier::ReusableSandbox,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "workspace-cache state must not satisfy a selected reusable preference"
    );
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);

    let run_id = RunId::new_v4();
    let mut workspace_context = context_with_session(run_id, provider_session_id);
    workspace_context.reuse_key = Some(reuse_key.into());
    env.provider
        .set_claim_result(run_id, Some(workspace_context));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::WorkspaceCache,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "runner should claim from the startup workspace-cache snapshot even if a later scan would miss"
    );

    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "the workspace-selected candidate should not add another deferral"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn saturated_cache_only_holder_defers_before_reclaiming_unrelated_idle() {
    let reuse_key = "thread:cache-saturated";
    let provider_session_id = "provider-session-cache-saturated";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 2, 4096, 1);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        image_size_bytes,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);

    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-unrelated-idle",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, provider_session_id);
    context.reuse_key = Some(reuse_key.into());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::WorkspaceCache,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "a cache-only preference must not bypass exhausted fresh admission"
    );
    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "workspace-selected work should defer when fresh budget is unavailable"
    );
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec!["sess-unrelated-idle".to_string()],
        "preference deferral must happen before candidate-aware reclamation"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_batches_reuse_state_heartbeat() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 12, 49152, 6, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let trigger_session = "sess-batch-trigger";
    let ready_session_1 = "sess-batch-ready-1";
    let ready_session_2 = "sess-batch-ready-2";
    for session_id in [trigger_session, ready_session_1, ready_session_2] {
        seed_idle_pool_with_overrides(
            &env.idle_pool,
            &budget,
            &overrides,
            session_id,
            "vm0/default",
            2,
            4096,
        )
        .await;
    }
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let heartbeat_count = env.handle.heartbeat_count();

    let trigger_run_id = RunId::new_v4();
    let ready_run_id_1 = RunId::new_v4();
    let ready_run_id_2 = RunId::new_v4();
    env.provider.set_claim_result(
        trigger_run_id,
        Some(context_with_session(trigger_run_id, trigger_session)),
    );
    env.provider.set_claim_result(
        ready_run_id_1,
        Some(context_with_session(ready_run_id_1, ready_session_1)),
    );
    env.provider.set_claim_result(
        ready_run_id_2,
        Some(context_with_session(ready_run_id_2, ready_session_2)),
    );
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            ready_run_id_1,
            "vm0/default".into(),
        ));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            ready_run_id_2,
            "vm0/default".into(),
        ));

    push_job(
        &env,
        trigger_run_id,
        "vm0/default",
        Some(context_with_session(trigger_run_id, trigger_session)),
    );

    wait_gate
        .wait_entered(3, Duration::from_secs(5))
        .await
        .expect("all reused jobs should block in wait_process");
    assert!(
        env.handle
            .wait_heartbeat_past(heartbeat_count, Duration::from_secs(5))
            .await,
        "reusing direct-candidate sessions should trigger a prompt heartbeat"
    );
    assert_eq!(
        env.handle.heartbeat_count(),
        heartbeat_count + 1,
        "direct-candidate drain should batch reuse-state refresh into one heartbeat"
    );

    let claimed_run_ids: std::collections::HashSet<RunId> = env
        .handle
        .claim_candidates()
        .into_iter()
        .map(|candidate| candidate.run_id())
        .collect();
    assert_eq!(
        claimed_run_ids,
        std::collections::HashSet::from([trigger_run_id, ready_run_id_1, ready_run_id_2])
    );

    wait_gate.release_many(3);
    for run_id in [trigger_run_id, ready_run_id_1, ready_run_id_2] {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "run {run_id} should complete");
    }

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 6: Unknown profile is skipped without affecting subsequent jobs
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn unknown_profile_skipped() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Push a job with a profile that doesn't exist in the profiles map.
    // The main loop should log a warning and continue without claiming.
    let bad_id = RunId::new_v4();
    push_job(
        &env,
        bad_id,
        "vm0/nonexistent",
        Some(minimal_context(bad_id)),
    );

    // The next discover wait proves the bad job was consumed and skipped.
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Push a valid job — it should succeed despite the earlier bad one.
    let good_id = RunId::new_v4();
    push_job(&env, good_id, "vm0/default", Some(minimal_context(good_id)));

    let completion = env
        .handle
        .wait_completion(good_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "valid job should complete after unknown profile is skipped"
    );

    // The bad job should never have been claimed (no completion recorded).
    {
        let comps = env.handle.completions.lock().unwrap();
        assert!(
            !comps.iter().any(|c| c.run_id == bad_id),
            "unknown-profile job should not produce a completion"
        );
    }

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 7: Duplicate discovery (same run_id) is deduplicated
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn duplicate_discovery_deduplicated() {
    // Budget for the running job plus one reusable idle sandbox.
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-duplicate-reservation";
    seed_idle_pool(&idle_pool, &budget, session_id, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Wait for the original job to be claimed and blocked at the sandbox gate.
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Push the same run_id again with a matching-reuse preference. The duplicate first
    // owns the idle reservation, then must restore it when the cancellation
    // registry reports that the original run already owns local admission.
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "duplicate rejection should restore the reusable reservation"
    );

    // Wait for the original job to complete.
    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "original job should complete");

    // Only one completion should exist for this run_id.
    {
        let comps = env.handle.completions.lock().unwrap();
        let count = comps.iter().filter(|c| c.run_id == run_id).count();
        assert_eq!(
            count, 1,
            "duplicate discovery should not produce a second completion"
        );
    }
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}
