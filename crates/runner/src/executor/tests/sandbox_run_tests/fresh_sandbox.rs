use super::*;

use async_trait::async_trait;
use sandbox::SandboxConfig;

struct CreateGateFactory {
    inner: MockSandboxFactory,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl CreateGateFactory {
    fn new() -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        }
    }
}

#[async_trait]
impl SandboxFactory for CreateGateFactory {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.entered.notify_one();
        self.release.notified().await;
        self.inner.create(config).await
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

fn guest_dns_readiness_failure(message: &str) -> SandboxError {
    SandboxError::GuestDnsReadiness {
        message: message.to_string(),
    }
}

#[tokio::test]
async fn execute_inner_happy_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn fresh_archive_download_overlaps_blocked_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = Arc::new(CreateGateFactory::new());
    let server = httpmock::MockServer::start_async().await;
    let body = b"fresh archive".to_vec();
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/fresh-overlap.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "fresh-overlap",
        "/data",
        "v1",
        &server.url("/fresh-overlap.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });

    let task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            let mut telemetry = test_telemetry(&config, &ctx);
            let outcome = execute_new_sandbox(
                factory.as_ref(),
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
            .await;
            (outcome, telemetry)
        }
    });

    tokio::time::timeout(Duration::from_secs(5), factory.entered.notified())
        .await
        .expect("sandbox create should start");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if full_get.calls_async().await == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("runner archive GET should start while sandbox create is blocked");
    assert!(
        !task.is_finished(),
        "sandbox create gate should keep the run from reaching guest download"
    );

    factory.release.notify_one();
    let (outcome, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("run should finish after sandbox create is released")
        .expect("run task should not panic");
    assert_eq!(outcome.unwrap().exit_code(), 0);
    full_get.assert_calls_async(1).await;
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_staged",
        true,
        None,
    );
}

#[tokio::test]
async fn fresh_archive_planning_failure_records_apply_and_prepare_failures() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let mut artifact = api_artifact(
        "memory",
        "/home/user/.claude/projects/project",
        "storage-id-1",
        "version-2",
        "https://storage.example/artifact.tar.gz",
    );
    artifact.archive_url = None;
    ctx.storage_manifest = Some(StorageManifest {
        storages: Vec::new(),
        artifacts: vec![artifact],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

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
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("invalid fresh storage plan should fail"),
        Err(error) => error,
    };
    let error = error.to_string();
    assert!(
        error.contains("storage manifest artifact memory version version-2 is missing archiveUrl"),
        "got: {error}"
    );
    assert!(
        overrides.create_configs().is_empty(),
        "invalid fresh storage plan should fail before sandbox creation"
    );
    assert_telemetry_action(
        &telemetry,
        "runner_storage_manifest_apply",
        false,
        Some(&error),
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_prepare",
        false,
        Some(&error),
    );
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
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn execute_new_sandbox_replaces_one_dns_unready_attachment_before_workload() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure("first attachment failed")));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let sandbox_id = SandboxId::new_v4();
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_callback = Arc::clone(&notifications);
    let notifier = SandboxPreparedNotifier::new(move |_run_id, prepared_sandbox_id| {
        let notifications = Arc::clone(&notifications_for_callback);
        async move {
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
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            sandbox_prepared: Some(&notifier),
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
    assert_proxy_registry_empty(dir.path()).await;
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
}

#[tokio::test]
async fn dns_readiness_retry_keeps_one_fresh_archive_owner() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure("first attachment failed")));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let server = httpmock::MockServer::start_async().await;
    let body = b"fresh archive across DNS retry".to_vec();
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/fresh-dns-retry.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "fresh-dns-retry",
        "/data",
        "v1",
        &server.url("/fresh-dns-retry.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
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

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    full_get.assert_calls_async(1).await;
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_single_request",
        true,
        None,
    );
}

#[tokio::test]
async fn execute_new_sandbox_stops_after_two_dns_unready_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure("first attachment failed")));
    overrides.push_start_result(Err(guest_dns_readiness_failure("second attachment failed")));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

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
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result.err().expect("second DNS failure must be returned");
    assert!(error.to_string().contains("second attachment failed"));
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 2);
    assert!(overrides.start_process_calls().is_empty());
    assert_proxy_registry_empty(dir.path()).await;
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        false,
        Some("replacement_prepare_failed"),
    );
}

#[tokio::test]
async fn execute_new_sandbox_does_not_retry_an_unrelated_start_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "boot failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

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
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("ordinary start failure must be returned");
    assert!(error.to_string().contains("boot failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_no_telemetry_action(&telemetry, "runner_fresh_sandbox_dns_readiness_retry");
}

#[tokio::test]
async fn execute_new_sandbox_suppresses_dns_retry_after_uncertain_destroy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure("attachment failed")));
    overrides.push_destroy_panic("simulated destroy panic");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

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
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("uncertain cleanup must preserve the readiness error");
    assert!(error.to_string().contains("attachment failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_process_calls().is_empty());
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        false,
        Some("cleanup_uncertain"),
    );
}

#[tokio::test]
async fn execute_new_sandbox_waits_for_destroy_before_dns_retry_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(guest_dns_readiness_failure("attachment failed")));
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let ctx = minimal_context();
    let sandbox_id = SandboxId::new_v4();
    let task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            let mut telemetry = test_telemetry(&config, &ctx);
            let result = execute_new_sandbox(
                factory.as_ref(),
                &ctx,
                NewSandboxDispatch {
                    id: sandbox_id,
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &default_params(),
                &mut telemetry,
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
            (result, telemetry)
        }
    });

    gate.wait_entered(1, Duration::from_secs(5))
        .await
        .expect("first failed sandbox should enter explicit destroy");
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "replacement create must wait for failed-sandbox destroy"
    );

    gate.release_one();
    let (result, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("replacement should finish after destroy release")
        .expect("replacement task should not panic");
    assert_eq!(result.unwrap().exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
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
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
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
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
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

    let (exit_code, error_msg) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    let start_env: BTreeMap<String, String> = start_calls[0].env.iter().cloned().collect();
    let expected_user_env_file = guest_user_env_file_path(ctx.run_id).unwrap();
    let expected_run_payload_file = guest_run_payload_file_path(ctx.run_id).unwrap();
    assert_eq!(start_env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert_eq!(start_env.get("VM0_STUCK_TOOL_TIMEOUT_SECS").unwrap(), "3");
    assert_eq!(
        start_env.get(USER_ENV_FILE_ENV_KEY).map(String::as_str),
        Some(expected_user_env_file.as_str())
    );
    assert_eq!(
        start_env
            .get(guest_contracts::env::RUN_PAYLOAD_FILE_ENV)
            .map(String::as_str),
        Some(expected_run_payload_file.as_str())
    );
    for key in [
        guest_contracts::env::PROMPT_ENV,
        guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV,
        guest_contracts::env::SECRET_VALUES_ENV,
        guest_contracts::env::DISALLOWED_TOOLS_ENV,
        guest_contracts::env::TOOLS_ENV,
        guest_contracts::env::SETTINGS_ENV,
        guest_contracts::env::ARTIFACTS_ENV,
        guest_contracts::env::FEATURE_FLAGS_ENV,
    ] {
        assert!(
            !start_env.contains_key(key),
            "{key} should be passed through the run payload file"
        );
    }
    for key in ["CUSTOM_USER_ENV", "BASH_ENV", "NODE_OPTIONS", "TZ"] {
        assert!(
            !start_env.contains_key(key),
            "{key} should not be passed to guest-agent bootstrap"
        );
    }

    assert!(overrides.write_file_calls().is_empty());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains(&expected_user_env_file)),
        "user env file should not be written through shell exec"
    );
    let private_writes = overrides.private_write_file_calls();
    assert_eq!(private_writes.len(), 2);
    let user_env_write = private_writes
        .iter()
        .find(|write| write.path == expected_user_env_file)
        .unwrap();
    let run_payload_write = private_writes
        .iter()
        .find(|write| write.path == expected_run_payload_file)
        .unwrap();
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
    let run_payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&run_payload_write.content).unwrap();
    assert_eq!(run_payload.prompt, ctx.prompt);
}

#[tokio::test]
async fn execute_inner_run_payload_enospc_collects_resources_without_starting_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_file_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout: b"VM0_DF_BLOCKS_V1\n/dev/root 8388608 8388608 0 100% /\nVM0_DF_INODES_V1\n/dev/root 524288 524280 8 100% /\n".to_vec(),
        stderr: Vec::new(),
    });
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    let failure = outcome.failure.as_ref().expect("expected failure");
    assert!(
        failure
            .error
            .contains("No space left on device (os error 28)"),
        "got: {failure:?}"
    );
    assert_eq!(
        failure
            .resource_diagnostics
            .expect("expected resource diagnostics")
            .failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    let private_writes = overrides.private_write_file_calls();
    assert_eq!(private_writes.len(), 1);
    assert!(
        private_writes[0]
            .path
            .ends_with("/run-payload/payload.json"),
        "got: {}",
        private_writes[0].path
    );
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start after run payload write failure"
    );
    assert_eq!(
        overrides
            .exec_calls()
            .iter()
            .filter(|call| call.cmd.contains("guest-agent-binary"))
            .count(),
        1
    );
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

    let (exit_code, error_msg) =
        run_new_sandbox_status(&factory, &minimal_context(), &config, &params)
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
        run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let calls = overrides.start_process_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].output,
        ProcessOutputMode::stream_with_stderr_capture(64 * 1024)
    );
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
    let (exit_code, _) = run_new_sandbox_status(&factory, &minimal_context(), &config, &params)
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
    let (exit_code, _) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
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
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-abc-123".into(),
        r#"{"type":"init"}"#.into(),
    ));
    let (exit_code, _) = run_new_sandbox_status(&factory, &ctx, &config, &default_params())
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

    let err = run_new_sandbox_status(&factory, &minimal_context(), &config, &default_params())
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
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_start",
        false,
        Some("sandbox_start_failed"),
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
