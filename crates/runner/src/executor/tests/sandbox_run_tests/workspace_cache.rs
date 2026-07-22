use super::*;

#[tokio::test]
async fn execute_inner_retries_fresh_after_workspace_cache_hit_create_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox_create_error("bad seed image")));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let server = httpmock::MockServer::start_async().await;
    let body = b"workspace retry archive".to_vec();
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/workspace-retry.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "workspace-retry",
        "/data",
        "v1",
        &server.url("/workspace-retry.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-cache-hit".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-hit", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(
                expected_seed.clone(),
            )),
        })
    );
    assert_eq!(
        configs[1].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(
        !expected_seed.exists(),
        "failed cache hit should invalidate the unusable baseline"
    );

    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_hit", true, None);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        true,
        None,
    );
    let factory_create_outcomes =
        telemetry_action_outcomes(&telemetry, "runner_fresh_sandbox_factory_create");
    assert_eq!(
        factory_create_outcomes,
        vec![
            (false, Some("sandbox_factory_create_failed".into())),
            (true, None)
        ]
    );
    assert!(
        (1..=2).contains(&full_get.calls_async().await),
        "the cancelled owner may be stopped before its request reaches the fixture"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(
        ops.iter()
            .filter(|(action, _, _)| action == "storage_cache_fresh_delivery_single_request")
            .count(),
        2,
        "workspace fallback must replace, not retain, the old owner: {ops:?}"
    );
    assert!(ops.iter().any(|(action, success, _)| {
        action == "storage_cache_fresh_delivery_drained" && *success
    }));
}

#[tokio::test]
async fn execute_inner_dns_readiness_retry_replaces_consumed_workspace_cache_hit() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        message: "first attachment failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-cache-dns-retry".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-dns-retry", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(
                expected_seed.clone(),
            )),
        })
    );
    assert_eq!(
        configs[1].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(!expected_seed.exists());
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        true,
        None,
    );
}

#[tokio::test]
async fn execute_inner_cache_hit_retry_requires_completed_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "start failed".into(),
    }));
    overrides.push_destroy_panic("simulated destroy panic");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-cache-cleanup-uncertain".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let _seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-cleanup-uncertain", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("uncertain cleanup must preserve the first preparation failure");
    assert!(error.to_string().contains("start failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
        false,
        Some("cleanup_uncertain"),
    );
}

#[tokio::test]
async fn execute_inner_uses_workspace_cache_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-cache-default".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-default", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_some());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(sandbox::WorkspaceDriveSeedImage::Move(seeded_cache)),
        })
    );

    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_hit", true, None);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_proxy_register",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "runner_fresh_sandbox_start", true, None);
}

#[tokio::test]
async fn execute_inner_records_workspace_cache_lock_busy_prepare_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-lock-busy-prepare";
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let cache_key = scoped_session_workspace_cache_key(
        "",
        &params.profile_name,
        session_id,
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let _held_lock = crate::lock::acquire(crate::paths::workspace_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_workspace_image_prepare",
        false,
        Some("workspace_image_prepare_lock_busy"),
    );
    assert_telemetry_action(&telemetry, "workspace_image_cache_lock_busy", true, None);
}

#[tokio::test]
async fn execute_inner_does_not_retry_workspace_cache_hit_after_proxy_register_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-register-fail".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-register-fail", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert!(
        result.is_err(),
        "proxy registration failure must return an error"
    );
    let err = result.err().unwrap();
    assert!(
        err.to_string().contains("register VM in proxy registry"),
        "got: {err}"
    );
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "proxy registration failure must not retry with a fresh workspace image"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
    assert!(
        expected_seed.exists(),
        "proxy registration failure must not invalidate the unrelated workspace cache hit"
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_proxy_register",
        false,
        Some("sandbox_proxy_register_failed"),
    );
    assert_no_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_retry_without_workspace_image",
    );
}

#[tokio::test]
async fn execute_job_reuse_uses_workspace_cache_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths);
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-default";
    let factory = MockSandboxFactory::new();
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let (idle_sandbox, _lease) = make_reusable_idle_sandbox(sandbox, source_ip, session_id).await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.workspace_image.is_some());

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::LockBusy);
}

#[tokio::test]
async fn cached_reuse_workspace_promotion_identity_mismatch_stops_before_agent() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let promotion_params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let current_params = JobParams {
        workspace_disk_mb: 32,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-identity-mismatch";
    let (idle_sandbox, current_image, overrides) = reusable_idle_sandbox_with_workspace_promotion(
        &cache,
        &runner_paths,
        &promotion_params,
        session_id,
    )
    .await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &current_params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_none());
    let error = reuse_outcome.error().expect("error should be set");
    assert!(error.contains("workspace promotion identity mismatch"));
    assert!(!error.contains(session_id));
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start after workspace promotion identity mismatch"
    );
    assert!(
        !current_image.exists(),
        "identity mismatch must explicitly abandon the consumed cache hit"
    );
    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &promotion_params.profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(promotion_params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn execute_job_reuse_without_workspace_cache_config_invalidates_held_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse";
    let (idle_sandbox, _current_image, _overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn unconfigured_cache_reuse_stops_when_cache_invalidation_fails() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse-invalidate-error";
    let (idle_sandbox, overrides) = reusable_idle_sandbox_with_unlocked_workspace_promotion(
        &cache,
        &runner_paths,
        &params,
        session_id,
    )
    .await;
    let cache_key = scoped_session_workspace_cache_key(
        "",
        &params.profile_name,
        session_id,
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let current_image = runner_paths.session_workspace_cache_current_image(&cache_key);
    tokio::fs::create_dir_all(current_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir(&current_image).await.unwrap();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(
        reuse_outcome
            .error()
            .unwrap()
            .contains("failed to invalidate workspace image cache before unconfigured-cache reuse")
    );
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| call.cmd.contains("prepare-for-reuse")),
        "reused sandbox must not run after stale cache invalidation fails"
    );
}

#[tokio::test]
async fn unconfigured_cache_reuse_stops_when_required_cache_invalidation_lock_is_busy() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse-lock-busy";
    let current_image =
        seed_workspace_image_cache(&cache, &runner_paths, session_id, params.workspace_disk_mb)
            .await;
    let (idle_sandbox, overrides) = reusable_idle_sandbox_with_unlocked_workspace_promotion(
        &cache,
        &runner_paths,
        &params,
        session_id,
    )
    .await;
    let cache_key = crate::paths::scoped_session_workspace_cache_key(
        "",
        &params.profile_name,
        session_id,
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let _held_lock = crate::lock::acquire(crate::paths::workspace_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    let error = reuse_outcome.error().unwrap();
    assert!(
        error
            .contains("failed to invalidate workspace image cache before unconfigured-cache reuse"),
        "got: {error}"
    );
    assert!(
        error.contains("lock unavailable"),
        "lock contention should be surfaced, got: {error}"
    );
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| call.cmd.contains("prepare-for-reuse")),
        "reused sandbox must not run when required stale cache invalidation cannot get the entry lock"
    );
    assert!(
        current_image.exists(),
        "lock-busy invalidation must not remove a cache image it could not lock"
    );
}

#[tokio::test]
async fn cached_reuse_validation_failure_keeps_workspace_cache_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-validation-failure";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));
    ctx.environment = Some(HashMap::from([(
        "OPENAI_API_KEY".into(),
        "sk-proj-real-openai-secret".into(),
    )]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_some());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "pre-run validation failure must not release the hidden cache baseline before finalization can promote or invalidate the live workspace"
    );
}

#[tokio::test]
async fn cached_reuse_invalid_resume_session_keeps_existing_workspace_cache_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-invalid-resume";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let raw_session_id = "../invalid-resume";
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        raw_session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_some());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "invalid resume sessions must not release the hidden cache baseline before finalization can promote or invalidate the live workspace"
    );
}

#[tokio::test]
async fn cached_reuse_invalid_resume_session_without_promotion_skips_workspace_lease() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths);
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-invalid-resume-no-promotion";
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let (idle_sandbox, _lease) = make_reusable_idle_sandbox(sandbox, source_ip, session_id).await;

    let raw_session_id = "../invalid-resume";
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        raw_session_id.into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_image.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );
}

async fn reusable_idle_sandbox_with_workspace_promotion(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    PathBuf,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult,
    };
    use crate::storage_fingerprints::StorageFingerprints;

    let current_image =
        seed_workspace_image_cache(cache, runner_paths, session_id, params.workspace_disk_mb).await;

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: &params.profile_name,
                cli_agent_session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert!(lease.is_cache_hit());
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                cli_agent_session_id_override: Some(session_id),
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        run_id,
        sandbox,
        factory,
        cli_agent_session_id: session_id.to_owned(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        history_generation_run_id: None,
        workspace_image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
        workspace_promotion: Some(promotion),
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_active_parts().error;
        panic!("test sandbox should park: {error}");
    })
    .expect_reusable()
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    let idle_sandbox = match entry.try_unpark().await {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, current_image, overrides)
}

async fn reusable_idle_sandbox_with_unlocked_workspace_promotion(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult,
    };
    use crate::storage_fingerprints::StorageFingerprints;

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: &params.profile_name,
                cli_agent_session_id: None,
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"active image")
        .await
        .unwrap();
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                cli_agent_session_id_override: Some(session_id),
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        run_id,
        sandbox,
        factory,
        cli_agent_session_id: session_id.to_owned(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        history_generation_run_id: None,
        workspace_image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
        workspace_promotion: Some(promotion),
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_active_parts().error;
        panic!("test sandbox should park: {error}");
    })
    .expect_reusable()
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    let idle_sandbox = match entry.try_unpark().await {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, overrides)
}
