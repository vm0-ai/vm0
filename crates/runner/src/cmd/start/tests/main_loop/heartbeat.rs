use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, minimal_context, mock_run_config, mock_run_config_with_delay,
    mock_run_config_with_overrides, push_job, shutdown, test_profiles, wait_budget_count,
    wait_budget_exhausted_reactor, wait_cancel_token, wait_discover_entered, wait_status_mode,
};
use std::sync::Arc;

// -----------------------------------------------------------------------
// Test 2: Discover survives heartbeat ticks (regression #8783)
//
// ApiProvider's discover() has an internal poll timer (30s) that must
// survive heartbeat ticks (10s). Without pinning, `select!` cancels
// and recreates discover() each tick, restarting the timer from scratch.
//
// We use poll_delay=20s to simulate this: if the future is pinned, the
// delay completes at t=20s and the job is discovered. If not pinned,
// heartbeat at t=10s restarts the delay → it won't complete until t=30s.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn discover_survives_heartbeat_ticks() {
    let (config, env) = mock_run_config_with_delay(
        test_profiles(),
        8,
        32768,
        4,
        Duration::from_secs(20), // poll delay: 20s
    );
    let run_handle = tokio::spawn(run(config));
    assert!(
        env.handle
            .wait_discover_poll_started(Duration::from_secs(5))
            .await,
        "discover poll delay should start before virtual time advances"
    );

    // Push job immediately — it's in the channel, waiting for
    // discover to finish its poll delay and read it.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Advance to the first heartbeat while the 20s discover delay is still
    // pending, then let the runner task observe the ready timer.
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    tokio::task::yield_now().await;
    assert!(
        env.handle
            .wait_heartbeat_past(0, Duration::from_secs(1))
            .await,
        "heartbeat should fire while discover poll delay is running"
    );

    // Advance past the rest of the 20s poll delay. If discover was cancelled
    // and recreated at t=10s, the delay restarts and this is still too early.
    tokio::time::advance(Duration::from_secs(15)).await;

    // Job should have been discovered and completed.
    // If discover was cancelled and recreated at t=10s, the 20s delay
    // restarts → at t=25s only 15s of the second delay has elapsed →
    // job not discovered yet → this assertion fails.
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(10))
        .await;
    assert!(
        completion.is_some(),
        "job should complete — discover must survive heartbeat ticks (regression #8783)"
    );

    shutdown(&env, run_handle).await;
}

/// Invariant: heartbeat ticks must fire while the unified reactor is
/// parked in Draining mode. Silently dropping its `heartbeat_tick` branch
/// would leave a draining runner looking dead to the server until it exits.
///
/// Drain before the first tick (t >= 10s) so the runner transitions to
/// Draining mode first; the tick observed after the time advance therefore
/// had to be handled by the Draining-mode heartbeat branch.
#[tokio::test(start_paused = true)]
async fn heartbeat_fires_while_draining() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    // Claim a gated job so Draining mode has an active job to wait
    // on — otherwise `jobs.is_empty()` auto-transitions straight to
    // Stopping before the Draining wait path is exercised.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Enter Draining before the first heartbeat tick fires. `status.json`
    // is updated only after the main loop observes the mode transition.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);
    let before = env.handle.heartbeat_count();

    // Advance past the first tick while Draining mode is active.
    // A broken Draining path that dropped its `heartbeat_tick.tick()`
    // branch would leave the count unchanged; `wait_heartbeat_past`
    // returns false on timeout.
    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "Draining mode must handle heartbeat_tick (baseline={before})",
    );

    // Tear down hard — the gate would block natural completion.
    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s after Draining heartbeat check",
    )
    .await;
}

/// Invariant: heartbeat ticks must fire while the unified reactor is
/// parked with budget exhausted. Dropping its `heartbeat_tick` branch would
/// make a runner that's at resource capacity look dead to the server until
/// budget frees.
///
/// A 1-slot budget + a gated job pins the runner in the budget-exhausted
/// state for the duration of the time advance.
#[tokio::test(start_paused = true)]
async fn heartbeat_fires_while_budget_exhausted() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    // Budget sized for exactly one `test_profiles()` slot (vcpu=2, mem=4096).
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    // Wait for the reservation — after this, the next loop iteration
    // enters the budget-exhausted wait state at the can_afford check.
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    wait_budget_exhausted_reactor(&env, Duration::from_secs(5)).await;
    let before = env.handle.heartbeat_count();

    // Advance past the first tick while the runner is budget-exhausted.
    // Removing the `heartbeat_tick.tick()` branch from the reactor `select!`
    // leaves the count unchanged; `wait_heartbeat_past` returns false
    // on timeout.
    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "budget-exhausted arm must handle heartbeat_tick (baseline={before})",
    );

    // Release the gate so the job completes, budget frees, and the
    // standard `shutdown()` helper (Draining → auto-Stop) terminates
    // the runner cleanly — same pattern as `budget_full_skips_then_resumes`.
    gate.notify_one();
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    shutdown(&env, run_handle).await;
}

/// Regression for #10146 / #10223: the main-loop `idle_cleanup` and
/// `heartbeat_tick` intervals must defer their first tick past the
/// configured period, so neither tick branch is Ready on the first `select!`
/// poll. Otherwise they pre-empt `discover_fut` (which parks on
/// `rx.recv()` → Pending) and any silent `mode_tx` flip during the
/// tick body breaks the loop before the pending job is ever claimed.
///
/// The behavioral test `claim_after_stopping_sent_cancels_new_job`
/// only triggers the underlying race under `cargo llvm-cov`, so a
/// silent revert of `interval_at` → `interval` would not fail it on
/// the default CI path. This test pins the invariant directly: a
/// job pushed immediately at startup is processed without any tick
/// having fired, observable via `heartbeat_count == 0`.
#[tokio::test(start_paused = true)]
async fn heartbeat_tick_defers_past_first_select_poll() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // `minimal_context` → no session → completion path does not trigger
    // `park_notify`, so any heartbeat observed here came from the
    // interval tick (the path we want to prove did NOT fire).
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job must complete");

    assert_eq!(
        env.handle.heartbeat_count(),
        0,
        "heartbeat tick fired before the startup job was processed — \
             is the main-loop interval `interval_at(now + period, period)` \
             instead of `interval(period)`?"
    );

    shutdown(&env, run_handle).await;
}
