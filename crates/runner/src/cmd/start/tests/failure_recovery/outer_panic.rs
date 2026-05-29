use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config_with_overrides, push_job, shutdown,
    test_profiles, wait_cancel_token, wait_cancel_token_removed, wait_idle_pool_len,
    wait_status_idle_sessions_and_active_runs,
};
use super::support::assert_no_completion_for_run;

use sandbox_mock::MockLifecycleGate;

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_idle_pool_owned_cleans_token_and_active_status() {
    let (mut config, env) = mock_run_config_with_overrides(
        test_profiles(),
        8,
        16384,
        4,
        Arc::new(sandbox_mock::MockSandboxOverrides::new()),
    );
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::IdlePoolOwned);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = Arc::clone(&config.provider.cancel_tokens);
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
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::ActiveOrUnknown);
    config.orphan_reap.process_discovery = Some(OrphanReapProcessDiscovery {
        firecrackers: Arc::new(Vec::new()),
        incomplete_for_current_runner: false,
    });
    let cancel_tokens = Arc::clone(&config.provider.cancel_tokens);
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
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::DestroyCompleted);
    let cancel_tokens = Arc::clone(&config.provider.cancel_tokens);
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
