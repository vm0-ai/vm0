use super::*;

#[tokio::test]
async fn execute_inner_happy_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let (exit_code, error_msg) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_proxy_register_failure_destroys_fresh_sandbox_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("register VM in proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_none());
    assert!(outcome.network_log_session.is_none());
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
}

#[tokio::test]
async fn execute_reused_sandbox_proxy_register_failure_returns_sandbox_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let prev_storage = crate::idle_pool::StorageFingerprints::default();

    let outcome = execute_reused_sandbox(
        sandbox,
        &source_ip,
        &ctx,
        &config,
        &prev_storage,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("register VM in proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_some());
    assert!(outcome.network_log_session.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start an agent when proxy registration fails"
    );
}

#[tokio::test]
async fn execute_job_workspace_mount_failure_destroys_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "mount -t ext4".to_string(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"mount denied".to_vec(),
    });
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("mount workspace drive failed"),
        "got: {error}"
    );
    assert!(error.contains("mount denied"), "got: {error}");
    assert!(
        outcome.sandbox.is_none(),
        "fresh mount failure should be destroyed inline"
    );
    assert!(
        outcome.network_log_session.is_none(),
        "network log session should be closed before returning"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start after workspace mount failure"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_appends_stream_overflow_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    assert_eq!(system_stream_log, STDOUT_STREAM_OVERFLOW_MARKER);
}

#[tokio::test]
async fn execute_inner_writes_user_env_file_and_starts_agent_with_bootstrap_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_USER_ENV".into(), "visible-to-cli".into()),
        ("BASH_ENV".into(), "/tmp/user-bash-env".into()),
        ("NODE_OPTIONS".into(), "--require /tmp/user-node.js".into()),
        ("VM0_API_TOKEN".into(), "stolen-token".into()),
        (USER_ENV_FILE_ENV_KEY.into(), "/tmp/evil-env.json".into()),
        ("VM0_STUCK_TOOL_TIMEOUT_SECS".into(), "3".into()),
    ]));

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    let start_env: BTreeMap<String, String> = start_calls[0].env.iter().cloned().collect();
    let expected_user_env_dir = guest_user_env_dir_path(ctx.run_id).unwrap();
    let expected_user_env_file = guest_user_env_file_path(ctx.run_id).unwrap();
    assert_eq!(start_env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert_eq!(start_env.get("VM0_STUCK_TOOL_TIMEOUT_SECS").unwrap(), "3");
    assert_eq!(
        start_env.get(USER_ENV_FILE_ENV_KEY).map(String::as_str),
        Some(expected_user_env_file.as_str())
    );
    for key in ["CUSTOM_USER_ENV", "BASH_ENV", "NODE_OPTIONS", "TZ"] {
        assert!(
            !start_env.contains_key(key),
            "{key} should not be passed to guest-agent bootstrap"
        );
    }

    let mkdir_call = overrides
        .exec_calls()
        .into_iter()
        .find(|call| call.cmd.contains(&expected_user_env_dir))
        .expect("user env directory should be created before agent start");
    assert!(mkdir_call.cmd.starts_with("mkdir -p -m 700 "));
    assert!(mkdir_call.cmd.contains(" && chmod 700 "));
    assert!(mkdir_call.env_keys.is_empty());
    assert!(!mkdir_call.sudo);
    let chmod_call = overrides
        .exec_calls()
        .into_iter()
        .find(|call| call.cmd == format!("chmod 600 {expected_user_env_file}"))
        .expect("user env file mode should be tightened after write");
    assert!(chmod_call.env_keys.is_empty());
    assert!(!chmod_call.sudo);

    let writes = overrides.write_file_calls();
    let user_env_write = writes
        .iter()
        .find(|call| call.path == expected_user_env_file)
        .expect("user env JSON should be written");
    let user_env: HashMap<String, String> =
        serde_json::from_slice(&user_env_write.content).unwrap();
    assert_eq!(user_env.get("CUSTOM_USER_ENV").unwrap(), "visible-to-cli");
    assert_eq!(user_env.get("BASH_ENV").unwrap(), "/tmp/user-bash-env");
    assert_eq!(
        user_env.get("NODE_OPTIONS").unwrap(),
        "--require /tmp/user-node.js"
    );
    assert_eq!(user_env.get("TZ").unwrap(), "Asia/Shanghai");
    assert!(!user_env.contains_key("VM0_API_TOKEN"));
    assert!(!user_env.contains_key(USER_ENV_FILE_ENV_KEY));
    assert!(!user_env.contains_key("VM0_STUCK_TOOL_TIMEOUT_SECS"));
}

#[tokio::test]
async fn execute_inner_appends_stream_limit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_inner_appends_stream_limit_marker_after_oom_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    overrides.push_wait_process_exit(ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new()));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "dmesg".to_string(),
        exit_code: 0,
        stdout: b"Out of memory: Killed process 1234".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 1);
    assert_eq!(
        error_msg.as_deref(),
        Some("Agent process killed by OOM killer")
    );
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_inner_preserves_system_stream_log_after_nonzero_exit_guest_copy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"bootstrap diagnostic\n".to_vec(),
        truncated: false,
    }]);
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let sandbox: Box<dyn Sandbox> = Box::new(QueuedCopyFileSandbox::new(
        sandbox,
        vec![b"guest system log\n".to_vec()],
    ));
    let system_log_path = config.log_paths.system_log(ctx.run_id);
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 126);
    assert_eq!(outcome.error(), Some("Agent exited with code 126"));
    assert!(outcome.sandbox.is_some());
    assert_proxy_registry_empty(dir.path()).await;
    let system_log = tokio::fs::read(&system_log_path).await.unwrap();
    assert_eq!(system_log, b"guest system log\n");
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    assert_eq!(system_stream_log, b"bootstrap diagnostic\n");
}

#[tokio::test]
async fn execute_inner_proxy_unregister_failure_marks_successful_run_failed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let sandbox: Box<dyn Sandbox> = Box::new(
        QueuedCopyFileSandbox::new(sandbox, vec![b"guest system log\n".to_vec()])
            .with_remove_path_before_copy(dir.path().join("proxy-registry.json")),
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("post-job proxy cleanup failed"),
        "got: {error}"
    );
    assert!(
        error.contains("unregister VM from proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_some());
    assert!(outcome.network_log_session.is_some());
    assert!(outcome.guest_session_id.is_none());
}

#[tokio::test]
async fn execute_inner_passes_device_rate_limits_to_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let limits = test_device_rate_limits();
    let params = JobParams {
        workspace_disk_mb: 512,
        device_rate_limits: Some(limits.clone()),
        ..default_params()
    };

    let (exit_code, error_msg) = run_execute_inner(&factory, &minimal_context(), &config, &params)
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].device_rate_limits, Some(limits));
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 512,
            seed_image: None,
        })
    );
}

#[tokio::test]
async fn execute_inner_launches_agent_stream_only_without_guest_log_tee() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides.clone());

    let (exit_code, error_msg) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let calls = overrides.start_process_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].output, ProcessOutputMode::stream());
    assert_eq!(calls[0].control, ProcessControlMode::Enabled);
}

#[tokio::test]
async fn execute_inner_with_snapshot_runs_clock_fix_and_reseed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let params = JobParams {
        restore_guest_state: true,
        ..default_params()
    };
    let (exit_code, _) = run_execute_inner(&factory, &minimal_context(), &config, &params)
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_with_storage_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "data",
            "/data",
            "v1",
            "https://example.com/data.tar.gz",
        )],
        artifacts: vec![],
    });
    let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_with_resume_session() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-abc-123".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_create_failure_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(sandbox_create_error("no free devices")));

    let err = run_execute_inner(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no free devices"), "got: {err}");
}

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
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-cache-hit".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);
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
    assert!(!outcome.workspace_promotable);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(expected_seed.clone()),
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
}

#[tokio::test]
async fn execute_inner_ignores_workspace_cache_when_feature_flag_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-cache-disabled".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, false);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-disabled", 16).await;
    let other_size_seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-disabled", 32).await;
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
    assert!(!outcome.workspace_promotable);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(
        !seeded_cache.exists(),
        "disabled feature flag should invalidate stale workspace cache baseline"
    );
    assert!(
        !other_size_seeded_cache.exists(),
        "disabled feature flag should invalidate every stale baseline for the session"
    );
    assert!(
        cache.held_session_states().await.is_empty(),
        "disabled feature flag should stop advertising stale workspace cache affinity"
    );
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
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-register-fail".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);
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
}

#[tokio::test]
async fn execute_inner_aborts_drain_task_on_wait_process_error() {
    // Simulate wait_process timeout: stdout channel stays open (sender held
    // alive by MockSandbox), wait_process returns error.
    // Without the fix, task.await blocks forever → test times out.
    // With the fix, task is aborted immediately → test completes.
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_error(
        "wait timeout",
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("wait timeout"), "got: {error}");
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on post-start execution failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned on post-start execution failure"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_nonzero_without_guest_error_returns_failure_message() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("Agent exited with code 7"));
}

#[tokio::test]
async fn execute_inner_abnormal_exit_collects_guest_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    let calls = overrides.exec_calls();
    let diagnostic_calls: Vec<&sandbox_mock::ExecCall> = calls
        .iter()
        .filter(|call| call.cmd.contains("guest-agent-binary"))
        .collect();
    assert_eq!(diagnostic_calls.len(), 1);
    let call = diagnostic_calls[0];
    assert!(call.cmd.contains("guest-agent-binary"));
    let active_diagnostic_cmd = call
        .cmd
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["environ", "printenv", "ps aux", "ps -ef", "ps e"] {
        assert!(
            !active_diagnostic_cmd.contains(forbidden),
            "diagnostic command must not collect environment values via {forbidden}"
        );
    }
    assert!(
        !active_diagnostic_cmd
            .lines()
            .any(|line| line == "env" || line.starts_with("env ")),
        "diagnostic command must not collect raw environment output"
    );
    assert_eq!(call.timeout, AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT);
    assert!(call.env_keys.is_empty());
    assert!(call.sudo);
    assert!(call.stdin_bytes.is_none());
    assert_eq!(call.output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
}

#[tokio::test]
async fn execute_inner_success_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error.is_none());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_stderr_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 7, Vec::new(), b"guest stderr".to_vec()));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("guest stderr"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_process_diagnostic_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 126, Vec::new(), Vec::new());
    exit.diagnostic = "guest-agent bootstrap diagnostic".to_string();
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_failure_diagnostic_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let diagnostic = FailureDiagnostic::new(
        agent_diagnostics::FailureClass::CliNonzero,
        agent_diagnostics::AgentFramework::ClaudeCode,
        agent_diagnostics::PromptMetadata::from_prompt("/help"),
    );
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(None));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_records_agent_execute_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let cancel = tokio_util::sync::CancellationToken::new();

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        cancel,
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 7);
    let ops = telemetry.pending_ops_snapshot();
    let agent_execute = ops
        .iter()
        .find(|op| op.0 == "agent_execute")
        .expect("agent_execute telemetry should be recorded");
    assert!(!agent_execute.1);
    assert_eq!(agent_execute.2.as_deref(), Some("Agent exited with code 7"));
}

#[tokio::test]
async fn execute_inner_start_failure_destroy_panic_returns_start_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "boot failed".into(),
    }));
    let factory = DestroyPanicFactory {
        inner: MockSandboxFactory::with_overrides(overrides),
    };

    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let cancel = tokio_util::sync::CancellationToken::new();
    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        cancel,
    )
    .await;

    assert!(result.is_err(), "start failure must return an error");
    let err = result.err().unwrap();
    assert!(err.to_string().contains("boot failed"), "got: {err}");
    assert_proxy_registry_empty(dir.path()).await;
    assert!(
        !config
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"after-start-failure.test"})
            )
            .await,
        "start failure should close inline network-log attribution",
    );
}

#[tokio::test]
async fn execute_job_wraps_execute_inner() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
}

#[tokio::test]
async fn execute_job_create_failure_returns_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(sandbox_create_error("boom")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("boom"));
    assert!(outcome.sandbox.is_none());
}

#[tokio::test]
async fn execute_job_model_provider_env_validation_failure_returns_run_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let secret = "sk-proj-real-openai-secret";
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
    assert!(outcome.sandbox.is_none());
    assert!(
        overrides.create_configs().is_empty(),
        "fresh sandbox must not be created after env validation failure"
    );
}

#[tokio::test]
async fn execute_job_claude_tool_validation_failure_skips_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash,Read".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("VM0_TOOLS"));
    assert!(error.contains("must not contain commas"));
    assert!(outcome.sandbox.is_none());
    assert!(
        overrides.create_configs().is_empty(),
        "fresh sandbox must not be created after tool validation failure"
    );
}

#[tokio::test]
async fn execute_job_codex_ignores_claude_tool_validation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.disallowed_tools = Some(vec!["".into()]);
    ctx.tools = Some(vec!["Bash,Read".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
    assert_eq!(overrides.create_configs().len(), 1);
}

// -----------------------------------------------------------------------
// Keep-alive VM reuse integration tests
// -----------------------------------------------------------------------

#[tokio::test]
async fn execute_job_reuse_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // First: create a sandbox via normal execute_job
    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    // Reuse the sandbox for a second turn
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.error().is_none());
    assert!(reuse_outcome.sandbox.is_some());
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
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn execute_job_reuse_with_workspace_cache_flag_disabled_invalidates_held_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-disabled-reuse";
    let (idle_sandbox, _current_image, _overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;
    let other_size_seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, session_id, 32).await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, false);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.workspace_image.is_none());
    assert!(!reuse_outcome.workspace_promotable);

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(
        !other_size_seeded_cache.exists(),
        "disabled reuse should invalidate every stale baseline for the session"
    );
    assert!(
        cache.held_session_states().await.is_empty(),
        "disabled reuse should stop advertising stale workspace cache affinity"
    );
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
    let (idle_sandbox, current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;
    tokio::fs::remove_file(&current_image).await.unwrap();
    tokio::fs::create_dir(&current_image).await.unwrap();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);

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
        overrides.exec_calls().is_empty(),
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
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);

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
        overrides.exec_calls().is_empty(),
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
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);
    ctx.environment = Some(HashMap::from([(
        "OPENAI_API_KEY".into(),
        "sk-proj-real-openai-secret".into(),
    )]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_promotable);
    assert!(reuse_outcome.workspace_image.is_some());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "pre-run validation failure must not release the hidden cache baseline before finalization can promote or invalidate the live workspace"
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
        ParkResult, StorageFingerprints,
    };

    let current_image =
        seed_workspace_image_cache(cache, runner_paths, session_id, params.workspace_disk_mb).await;

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert!(lease.is_cache_hit());
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
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
        sandbox,
        factory,
        session_id: session_id.to_owned(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        workspace_promotion: Some(promotion),
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_active_parts().error;
        panic!("test sandbox should park: {error}");
    })
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
        ParkResult, StorageFingerprints,
    };

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: &params.profile_name,
            session_id: None,
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
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
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
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
        sandbox,
        factory,
        session_id: session_id.to_owned(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        workspace_promotion: Some(promotion),
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_active_parts().error;
        panic!("test sandbox should park: {error}");
    })
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

#[tokio::test]
async fn execute_job_reuse_model_provider_env_validation_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let secret = "sk-proj-real-openai-secret";
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_claude_tool_validation_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["   ".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("VM0_DISALLOWED_TOOLS"));
    assert!(error.contains("must not be empty"));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after tool validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_appends_stream_limit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"reuse partial stdout".to_vec(),
        truncated: true,
    }]);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.error().is_none());
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_some());
    assert_proxy_registry_empty(dir.path()).await;
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"reuse partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_job_reuse_with_session_context() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // First turn: execute with resume_session
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "test-session-abc".into(),
        session_history: r#"{"type":"human","text":"hello"}"#.into(),
    });
    assert_eq!(ctx.session_id(), Some("test-session-abc"));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    // Second turn: reuse with new session history
    let mut ctx2 = minimal_context();
    ctx2.resume_session = Some(ResumeSession {
        session_id: "test-session-abc".into(),
        session_history: r#"{"type":"human","text":"hello"}
{"type":"assistant","text":"hi"}
{"type":"human","text":"do something"}"#
            .into(),
    });

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx2, &config, &default_params(), cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn idle_pool_park_and_reuse_cycle() {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate,
        SyntheticParkedIdleCandidateParts,
    };

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // Execute first job
    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox alive");

    // Park in idle pool
    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });

    let entry = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
        sandbox,
        factory: std::sync::Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
        session_id: "test-session".into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: test_budget_lease(),
        source_ip: outcome.source_ip,
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    });

    let result = pool.park(entry);
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);

    // Take from pool for reuse
    let reuse_entry = pool.take("test-session").expect("should find session");
    assert_eq!(pool.len(), 0);
    assert_eq!(reuse_entry.profile_name(), "vm0/default");

    // Execute reuse
    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) = match reuse_entry.try_unpark().await {
        crate::idle_pool::IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        crate::idle_pool::IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };
    let (reuse_outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn idle_pool_profile_mismatch_returns_none() {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkedIdleCandidate, SyntheticParkedIdleCandidateParts,
    };

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });

    // Park with profile "vm0/default"
    let entry = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
        sandbox: Box::new(sandbox_mock::MockSandbox::new("test")),
        factory: std::sync::Arc::new(
            Box::new(sandbox_mock::MockSandboxFactory::new()) as Box<dyn SandboxFactory>
        ),
        session_id: "test-session".into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: test_budget_lease(),
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    });
    let _ = pool.park(entry);

    // Take and verify profile
    let taken = pool.take("test-session").expect("should find");
    assert_eq!(taken.profile_name(), "vm0/default");

    // Simulate caller checking profile mismatch
    let matches_browser = taken.profile_name() == "vm0/browser";
    assert!(!matches_browser, "should not match different profile");
}

#[tokio::test]
async fn execute_job_reuse_clock_fix_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    // First exec mounts the workspace drive, second exec fixes the clock.
    let sandbox = MockSandbox::new("reuse-clock-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock broken")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("vsock broken"));
    // Critical: sandbox must be returned so caller can stop + destroy it
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on clock fix failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned so finalization can close it"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_reuse_reseed_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    // Workspace mount and clock fix succeed, then reseed_guest_entropy fails.
    let sandbox = MockSandbox::new("reuse-reseed-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Err(sandbox_exec_error("reseed timeout")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("reseed timeout"));
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on reseed failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_workspace_mount_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    let sandbox = MockSandbox::new("reuse-mount-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"mount denied".to_vec(),
    )));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("mount workspace drive failed"),
        "got: {error}"
    );
    assert!(error.contains("mount denied"), "got: {error}");
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on workspace mount failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned so finalization can close it"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

/// Verify that session restore failure during reuse still returns the sandbox.
#[tokio::test]
async fn execute_job_reuse_session_restore_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    let sandbox = MockSandbox::new("reuse-session-fail");
    // clock fix and reseed succeed (default), but write_file for session
    // history fails.
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-abc".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-abc").await;
    let (outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("disk full"));
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on session restore failure"
    );
}

#[tokio::test]
async fn execute_job_nonzero_exit_still_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    // Sandbox should be alive regardless of exit code (caller decides fate)
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned for caller to stop+destroy or park"
    );
}
