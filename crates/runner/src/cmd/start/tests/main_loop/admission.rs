use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, context_with_session, minimal_context, mock_run_config,
    mock_run_config_with_overrides, push_job, seed_idle_pool,
    seed_idle_pool_with_history_generation, seed_idle_pool_with_overrides,
    seed_workspace_cache_state, shutdown, test_profiles, wait_budget_count, wait_cancel_token,
    wait_cancel_token_removed, wait_discover_entered,
};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use std::sync::Arc;

use crate::paths::RunnerPaths;
use crate::types::{SandboxReuseResult, SessionAffinityResource};
use crate::workspace_image_cache::SessionWorkspaceCache;

const FUTURE_AFFINITY_PROTECTED_UNTIL: &str = "2999-01-01T00:00:00Z";

fn affinity_protected_candidate(run_id: RunId, session_id: &str) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, "vm0/default".into()).with_affinity_metadata(
        Some(session_id.to_string()),
        Some(FUTURE_AFFINITY_PROTECTED_UNTIL.to_string()),
    )
}

fn reusable_affinity_protected_candidate(
    run_id: RunId,
    session_id: &str,
) -> crate::provider::JobCandidate {
    affinity_protected_candidate(run_id, session_id)
        .with_session_affinity_resource(Some(SessionAffinityResource::ReusableSandbox))
}

fn workspace_affinity_protected_candidate(
    run_id: RunId,
    session_id: &str,
) -> crate::provider::JobCandidate {
    affinity_protected_candidate(run_id, session_id)
        .with_session_affinity_resource(Some(SessionAffinityResource::WorkspaceCache))
}

fn generation_affinity_protected_candidate(
    run_id: RunId,
    session_id: &str,
    target_generation_run_id: RunId,
) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_affinity_metadata(
            Some(session_id.to_string()),
            Some(FUTURE_AFFINITY_PROTECTED_UNTIL.to_string()),
        )
        .with_history_generation_run_id(Some(target_generation_run_id))
        .with_history_generation_affinity_protected_until(Some(
            FUTURE_AFFINITY_PROTECTED_UNTIL.to_string(),
        ))
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
        .send(generation_affinity_protected_candidate(
            conflict_run_id,
            session_id,
            reserved_generation_run_id,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, conflict_run_id, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_sessions(),
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
            reusable_affinity_protected_candidate(followup_run_id, session_id)
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
async fn reusable_affinity_reservation_is_restored_after_claim_conflict() {
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
        .send(reusable_affinity_protected_candidate(run_id, session_id))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_sessions(),
        vec![session_id.to_string()],
        "lost claim should restore the generic reusable reservation"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

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
        .send(reusable_affinity_protected_candidate(run_id, session_id))
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
        candidate.session_affinity_resource(),
        Some(SessionAffinityResource::ReusableSandbox)
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
        .send(generation_affinity_protected_candidate(
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
    assert_eq!(env.handle.deferred_poll_delays().len(), 1);
    let pool = idle_pool.lock().await;
    assert_eq!(pool.held_sessions(), vec![session_id.to_string()]);
    assert_eq!(
        pool.held_session_states()[0]
            .reusable_sandbox
            .as_ref()
            .and_then(|sandbox| sandbox.history_generation_run_id),
        Some(held_generation_run_id),
        "the different generation must remain available for fallback after expiry"
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn affinity_protected_candidate_without_local_session_defers_before_claim() {
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
        .send(reusable_affinity_protected_candidate(
            run_id,
            "sess-owned-elsewhere",
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    assert!(
        env.handle.claim_candidates().is_empty(),
        "runner must not claim a protected same-session candidate unless it holds the session"
    );
    assert_eq!(
        env.handle.deferred_poll_delays().len(),
        1,
        "runner should schedule a follow-up poll after the affinity protection expires"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn affinity_protected_candidate_without_session_metadata_defers_before_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(minimal_context(run_id)));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_affinity_metadata(None, Some(FUTURE_AFFINITY_PROTECTED_UNTIL.to_string()))
                .with_session_affinity_resource(Some(SessionAffinityResource::ReusableSandbox)),
        )
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "a protected candidate without session metadata must not reach claim"
    );
    assert_eq!(env.handle.deferred_poll_delays().len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn affinity_protected_candidate_without_resource_defers_even_when_session_is_local() {
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
        .send(affinity_protected_candidate(run_id, session_id))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "a protected candidate without a typed resource must not use legacy local admission"
    );
    assert_eq!(env.handle.deferred_poll_delays().len(), 1);
    assert_eq!(
        idle_pool.lock().await.held_sessions(),
        vec![session_id.to_string()]
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_continues_after_affinity_defer() {
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
        .push_ready_candidate(affinity_protected_candidate(
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
        env.handle.deferred_poll_delays().len(),
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
            workspace_affinity_protected_candidate(run_id, "sess-held-local")
                .with_history_generation_run_id(Some(RunId::new_v4()))
                .with_history_generation_affinity_protected_until(Some(
                    "2000-01-01T00:00:00Z".to_string(),
                )),
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
        env.handle.deferred_poll_delays().is_empty(),
        "runner holding the protected session should not defer the claim"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn resource_class_workspace_cache_defers_for_reusable_then_claims_workspace() {
    let session_id = "sess-cache-local";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        session_id,
        "vm0/default",
        image_size_bytes,
    )
    .await;
    let cache_key = crate::paths::scoped_session_workspace_cache_key(
        &config.runner.group,
        "vm0/default",
        session_id,
        CANONICAL_WORKING_DIR,
        image_size_bytes,
    );
    let cache_entry_dir = config
        .paths
        .home
        .workspace_image_cache_dir()
        .join(cache_key);
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reusable_protected_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        reusable_protected_run_id,
        Some(context_with_session(reusable_protected_run_id, session_id)),
    );
    env.handle
        .discover_tx
        .send(reusable_affinity_protected_candidate(
            reusable_protected_run_id,
            session_id,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "workspace-only state must not satisfy reusable-sandbox selection"
    );
    assert_eq!(env.handle.deferred_poll_delays().len(), 1);

    tokio::fs::remove_dir_all(&cache_entry_dir).await.unwrap();
    let generation_protected_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        generation_protected_run_id,
        Some(context_with_session(
            generation_protected_run_id,
            session_id,
        )),
    );
    env.handle
        .discover_tx
        .send(generation_affinity_protected_candidate(
            generation_protected_run_id,
            session_id,
            RunId::new_v4(),
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "workspace-cache state and fresh capacity must not impersonate an exact reusable generation"
    );
    assert_eq!(env.handle.deferred_poll_delays().len(), 2);

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(
            workspace_affinity_protected_candidate(run_id, session_id)
                .with_history_generation_run_id(Some(RunId::new_v4())),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "runner should claim from the startup workspace-cache snapshot even if a later scan would miss"
    );

    let claim_candidates = env.handle.claim_candidates();
    let claimed_candidate = claim_candidates
        .iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("claim should record the protected candidate");
    assert_eq!(
        claimed_candidate.session_affinity_resource(),
        Some(SessionAffinityResource::WorkspaceCache)
    );
    assert_eq!(
        env.handle.deferred_poll_delays().len(),
        2,
        "the workspace-selected candidate should not add another deferral"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn saturated_cache_only_holder_defers_before_reclaiming_unrelated_idle() {
    let session_id = "sess-cache-saturated";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 2, 4096, 1);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        session_id,
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
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(workspace_affinity_protected_candidate(run_id, session_id))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "cache-only affinity must not bypass exhausted fresh admission"
    );
    assert_eq!(
        env.handle.deferred_poll_delays().len(),
        1,
        "workspace-selected work should defer when fresh budget is unavailable"
    );
    assert_eq!(
        idle_pool.lock().await.held_sessions(),
        vec!["sess-unrelated-idle".to_string()],
        "affinity deferral must happen before candidate-aware reclamation"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_batches_session_affinity_heartbeat() {
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
        "direct-candidate drain should batch session-affinity refresh into one heartbeat"
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

    // Push the same run_id again with reusable affinity. The duplicate first
    // owns the idle reservation, then must restore it when the cancellation
    // registry reports that the original run already owns local admission.
    env.handle
        .discover_tx
        .send(reusable_affinity_protected_candidate(run_id, session_id))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_sessions(),
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
