use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_api_url, push_job, seed_idle_pool, shutdown,
    test_profiles,
};

#[tokio::test]
async fn telemetry_flush_includes_start_loop_claim_phase_spans() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_to_executor_start")
                .body_includes("runner_claim_resume_session_validation")
                .body_includes("runner_claim_device_rate_limits")
                .body_includes("runner_claim_idle_reuse_lookup")
                .body_includes("runner_claim_held_session_state_refresh")
                .body_includes("runner_claim_active_status_publish")
                .body_includes("runner_claim_spawn_job_setup")
                .body_includes("runner_claim_task_schedule_wait");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-claim-timing")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn telemetry_flush_includes_reuse_hit_claim_phase_spans() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("sandbox_reuse_hit")
                .body_includes("runner_claim_idle_reuse_lookup")
                .body_includes("runner_claim_held_session_state_refresh")
                .body_includes("runner_claim_idle_unpark")
                .body_includes("runner_claim_task_schedule_wait");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let idle_pool = config.shared.idle_pool.clone();
    let budget = config.capacity.budget.clone();
    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-reuse-claim-timing",
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
        Some(context_with_session(run_id, "sess-reuse-claim-timing")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(
        completion.reuse_result,
        Some(crate::types::SandboxReuseResult::Reused)
    );

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}
