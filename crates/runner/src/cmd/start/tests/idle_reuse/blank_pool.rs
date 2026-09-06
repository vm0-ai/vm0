use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config, push_job, seed_workspace_cache_state,
    shutdown, test_profiles, two_profiles, wait_idle_pool_len,
};

use crate::paths::RunnerPaths;
use crate::types::{SandboxReuseResult, WorkspaceReuseResult};
use crate::workspace_image_cache::WorkspaceImageCache;

#[tokio::test(start_paused = true)]
async fn blank_pool_prepares_and_serves_a_job_without_changing_reuse_attribution() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey)
    );
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::NotConfigured)
    );
    assert_eq!(completion.sandbox_id, Some(blank_sandbox_id));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn blank_backed_run_becomes_exact_reuse_and_wins_over_refilled_blank() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id;
    let reuse_key = "session-blank-to-exact";

    let first_run_id = RunId::new_v4();
    push_job(
        &env,
        first_run_id,
        "vm0/default",
        Some(context_with_session(first_run_id, reuse_key)),
    );
    let first = env
        .handle
        .wait_completion(first_run_id, Duration::from_secs(5))
        .await
        .expect("blank-backed job should complete");

    assert_eq!(first.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(first.sandbox_id, Some(blank_sandbox_id));
    wait_idle_pool_len(&idle_pool, 2, Duration::from_secs(5)).await;
    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.blank_len(), 1);
        assert!(pool.has_reusable(reuse_key, "vm0/default", &None));
    }

    let second_run_id = RunId::new_v4();
    push_job(
        &env,
        second_run_id,
        "vm0/default",
        Some(context_with_session(second_run_id, reuse_key)),
    );
    let second = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("exact-reuse job should complete");

    assert_eq!(second.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(second.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn incompatible_profile_fresh_creates_without_consuming_blank_inventory() {
    let (config, env) = mock_run_config(two_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/large", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey)
    );
    assert_ne!(completion.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn workspace_cache_hit_takes_priority_over_compatible_blank_inventory() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    let reuse_key = "thread:blank-pool-workspace-priority";
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, "workspace-priority-session");
    context.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, "vm0/default", Some(context));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused)
    );
    assert_ne!(completion.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}
