use super::*;

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
async fn execute_job_reuse_invalid_resume_session_does_not_lease_workspace_image() {
    let dir = tempfile::tempdir().unwrap();
    let cache = SessionWorkspaceCache::new(RunnerPaths::new(dir.path().join("runner")));
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "bad-session").await;
    let raw_session_id = "../bad-session";
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: raw_session_id.into(),
        session_history: "{}".into(),
    });

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(reuse_outcome.workspace_image.is_none());
    assert!(!reuse_outcome.workspace_promotable);
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
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
        cli_agent_session_id: "test-session-abc".into(),
        session_history: r#"{"type":"human","text":"hello"}"#.into(),
    });
    assert_eq!(ctx.cli_agent_session_id(), Some("test-session-abc"));

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
        cli_agent_session_id: "test-session-abc".into(),
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
        cli_agent_session_id: "sess-abc".into(),
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
