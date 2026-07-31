use super::super::super::*;
use super::super::support::{
    WorkspacePromotionSeedSpec, context_with_session, mock_run_config,
    mock_run_config_with_overrides, push_job, seed_idle_pool,
    seed_idle_pool_with_workspace_promotion, shutdown, test_profiles, wait_budget_count,
    wait_discover_entered, wait_idle_pool_session_states, wait_idle_pool_sessions,
};

use crate::paths::RunnerPaths;
use crate::types::{SandboxReuseResult, SessionAffinityResource};
use crate::workspace_image_cache::SessionWorkspaceCache;

const FUTURE_AFFINITY_PROTECTED_UNTIL: &str = "2999-01-01T00:00:00Z";

fn reusable_candidate(
    run_id: RunId,
    profile_name: &str,
    session_id: &str,
) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, profile_name.to_string())
        .with_affinity_metadata(
            Some(session_id.to_string()),
            Some(session_id.to_string()),
            Some(FUTURE_AFFINITY_PROTECTED_UNTIL.to_string()),
        )
        .with_session_affinity_resource(Some(SessionAffinityResource::ReusableSandbox))
}

async fn wait_heartbeat_with_workspace_after(
    handle: &crate::provider::mock::MockProviderHandle,
    mut cursor: usize,
    reuse_key: &str,
    timeout: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let heartbeats = handle.heartbeats.lock().unwrap_or_else(|e| e.into_inner());
            if heartbeats[cursor..].iter().any(|state| {
                state
                    .held_workspace_states
                    .iter()
                    .any(|state| state.reuse_key == reuse_key)
            }) {
                return true;
            }
            cursor = heartbeats.len();
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() || !handle.wait_heartbeat_past(cursor, remaining).await {
            return false;
        }
    }
}

#[tokio::test]
async fn workspace_cache_promotion_triggers_immediate_heartbeat_without_park() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let runner_paths = crate::paths::RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = crate::workspace_image_cache::SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let before = env.handle.heartbeat_count();

    let run_id = RunId::new_v4();
    let session_id = "sess-cache-heartbeat";
    let ctx = context_with_session(run_id, session_id);
    push_job(&env, run_id, "vm0/default", Some(ctx));

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before test writes active workspace image");
    let sandbox_id = overrides
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    let completion = completion.expect("job should complete");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(
        env.idle_pool.lock().await.len(),
        0,
        "nonzero job should not park a VM",
    );

    assert!(
        wait_heartbeat_with_workspace_after(
            &env.handle,
            before,
            session_id,
            Duration::from_secs(5),
        )
        .await,
        "immediate heartbeat should advertise the promoted workspace cache",
    );

    let second_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(second_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));
    let second_before = env.handle.heartbeat_count();
    let second_run_id = RunId::new_v4();
    push_job(
        &env,
        second_run_id,
        "vm0/default",
        Some(context_with_session(second_run_id, session_id)),
    );
    second_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("second wait_process should enter before heartbeat assertion");
    assert!(
        env.handle
            .wait_heartbeat_past(second_before, Duration::from_secs(5))
            .await,
        "claiming a workspace-cache-only session should trigger an immediate heartbeat",
    );
    let post_claim_heartbeats = {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        heartbeats[second_before..].to_vec()
    };
    assert!(
        post_claim_heartbeats.iter().any(|heartbeat| {
            heartbeat
                .held_workspace_states
                .iter()
                .all(|state| state.reuse_key != session_id)
        }),
        "post-claim heartbeat should stop advertising the active workspace cache; heartbeats: {post_claim_heartbeats:?}",
    );
    overrides.clear_wait_process_lifecycle_gate();
    second_gate.release_one();
    let second_completion = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second job should complete");
    assert_eq!(second_completion.exit_code, 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn workspace_promotion_mismatch_destroys_stale_idle_vm_and_fresh_creates() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let session_id = "sess-workspace-promotion-mismatch";
    let stale_sandbox_id = seed_idle_pool_with_workspace_promotion(
        &idle_pool,
        &budget,
        &workspace_cache,
        &runner_paths,
        WorkspacePromotionSeedSpec {
            session_id,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            image_size_bytes: 16 * 1024 * 1024,
        },
    )
    .await;

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(reusable_candidate(run_id, "vm0/default", session_id))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_ne!(
        completion.sandbox_id,
        Some(stale_sandbox_id),
        "workspace promotion mismatch should force a fresh sandbox"
    );
    wait_idle_pool_sessions(&idle_pool, &[session_id], Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    assert!(
        workspace_cache.held_workspace_states().await.is_empty(),
        "mismatched stale idle VM must be destroyed without publishing its workspace image"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn reuse_take_preserves_cached_workspace_held_session_state() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = SessionWorkspaceCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());

    seed_idle_pool(&idle_pool, &budget, "sess-refresh", "vm0/default", 2, 4096).await;

    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let heartbeat_count = env.handle.heartbeat_count();

    let cache_run_id = RunId::new_v4();
    push_job(
        &env,
        cache_run_id,
        "vm0/default",
        Some(context_with_session(cache_run_id, "sess-cached")),
    );

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before test writes active workspace image");
    let sandbox_id = overrides
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let cache_completion = env
        .handle
        .wait_completion(cache_run_id, Duration::from_secs(5))
        .await
        .expect("cache seed job should complete");
    assert_eq!(cache_completion.exit_code, 1);
    assert!(
        env.handle
            .wait_heartbeat_past(heartbeat_count, Duration::from_secs(5))
            .await,
        "workspace cache promotion should refresh the held-session snapshot before claim"
    );
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-refresh")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    wait_idle_pool_session_states(&idle_pool, &["sess-refresh"], Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}
