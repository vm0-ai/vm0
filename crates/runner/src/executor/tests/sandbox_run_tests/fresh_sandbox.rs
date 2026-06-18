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
async fn execute_new_sandbox_notifies_after_successful_prepare() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    let ctx = minimal_context();
    let sandbox_id = SandboxId::new_v4();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let expected_run_id = ctx.run_id;
    let notifier = SandboxPreparedNotifier::new(move |run_id, prepared_sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            assert_eq!(run_id, expected_run_id);
            assert_eq!(prepared_sandbox_id, sandbox_id);
            notifications.fetch_add(1, Ordering::SeqCst);
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: sandbox_id,
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            cancel: tokio_util::sync::CancellationToken::new(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn execute_new_sandbox_does_not_notify_before_start_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let factory = MockSandboxFactory::new();
    let ctx = minimal_context();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let notifier = SandboxPreparedNotifier::new(move |_run_id, _sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            notifications.fetch_add(1, Ordering::SeqCst);
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            cancel: tokio_util::sync::CancellationToken::new(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn execute_new_sandbox_does_not_notify_after_post_start_prepare_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "mount -t ext4".to_string(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"mount denied".to_vec(),
    });
    let factory = MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let notifier = SandboxPreparedNotifier::new(move |_run_id, _sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
            notifications.fetch_add(1, Ordering::SeqCst);
        }
        .boxed()
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        NewSandboxHooks {
            cancel: tokio_util::sync::CancellationToken::new(),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
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
        cli_agent_session_id: "sess-abc-123".into(),
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
