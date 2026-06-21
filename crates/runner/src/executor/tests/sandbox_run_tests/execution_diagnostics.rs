use super::*;

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

    let failure = outcome.failure.as_ref().expect("expected OOM failure");
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(failure.error.as_str(), "Agent process killed by OOM killer");
    assert_eq!(
        failure
            .resource_diagnostics
            .expect("expected OOM resource diagnostics")
            .failure_kind,
        Some(ResourceFailureKind::GuestMemoryOomKilled)
    );
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_inner_ignores_non_exited_dmesg_oom_output() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new()));
    overrides.add_exec_result_matcher(
        "dmesg",
        SandboxExecResult {
            termination: SandboxExecTermination::TimedOut,
            stdout: b"Out of memory: Killed process 1234".to_vec(),
            stderr: b"Timeout".to_vec(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    );
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

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(outcome.exit_code(), EXIT_SIGKILL);
    assert_eq!(failure.error.as_str(), "Agent exited with code 137");
    assert!(failure.resource_diagnostics.is_none());
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
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

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_logs_guest_session_fingerprint_without_raw_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "sess-sensitive-first-run-17975";
    overrides.push_wait_process_exit(ProcessExit::new(1, 0, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.discovered_cli_agent_session_id.as_deref(),
        Some(raw_session_id)
    );
    assert_captured_events_do_not_contain(&events, raw_session_id);
    let event = captured_event(&events, "read guest session ID for parking");
    assert_eq!(
        event.fields.get("session_fingerprint").map(String::as_str),
        Some(crate::paths::diagnostic_session_fingerprint(raw_session_id).as_str())
    );
    assert!(
        !event.fields.contains_key("session_id"),
        "guest session read diagnostic must not include raw session_id field: {event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_canonicalizes_codex_discovered_cli_agent_session_id_for_parking()
 {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "019E9154C30470F0ADDE36EFB1BE1701";
    let canonical_session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    overrides.push_wait_process_exit(ProcessExit::new(1, 0, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.discovered_cli_agent_session_id.as_deref(),
        Some(canonical_session_id)
    );
    assert_captured_events_do_not_contain(&events, raw_session_id);
    let event = captured_event(&events, "read guest session ID for parking");
    assert_eq!(
        event.fields.get("session_fingerprint").map(String::as_str),
        Some(crate::paths::diagnostic_session_fingerprint(canonical_session_id).as_str())
    );
}

#[tokio::test(flavor = "current_thread")]
async fn execute_prepared_sandbox_run_ignores_non_uuid_codex_discovered_cli_agent_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let raw_session_id = "codex-safe-but-not-uuid";
    overrides.push_wait_process_exit(ProcessExit::new(1, 0, Vec::new(), Vec::new()));
    overrides.push_read_file_result(Ok(Some(raw_session_id.as_bytes().to_vec())));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_async_events(execute_prepared_sandbox_run(
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    ))
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.discovered_cli_agent_session_id.is_none());
    assert_captured_events_do_not_contain(&events, raw_session_id);
    let event = captured_event(&events, "ignoring invalid guest session ID for framework");
    assert_eq!(
        event.fields.get("framework").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        event.fields.get("session_fingerprint").map(String::as_str),
        Some(crate::paths::diagnostic_session_fingerprint(raw_session_id).as_str())
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

    assert_eq!(outcome.exit_code(), 124);
    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 124);
    assert!(failure.error.contains("wait timeout"), "got: {failure:?}");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(guest_duration_ms, None);
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
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

async fn capture_async_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}

fn assert_captured_events_do_not_contain(events: &[CapturedEvent], raw: &str) {
    for event in events {
        for (field, value) in &event.fields {
            assert!(
                !value.contains(raw),
                "captured field {field} leaked raw session id {raw:?}: {event:#?}"
            );
        }
    }
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
async fn execute_inner_non_exited_zero_code_is_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.termination = SandboxExecTermination::WaitFailed;
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
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

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(failure.exit_code, 1);
    assert_eq!(failure.error, "Agent exited with code 1");
    assert_eq!(failure.kind, ExecutionFailureKind::Generic);
    assert!(outcome.discovered_cli_agent_session_id.is_none());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .any(|call| call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_guest_process_timeout_marks_failure_kind() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 124, Vec::new(), b"Timeout".to_vec());
    exit.termination = SandboxExecTermination::TimedOut;
    exit.guest_duration_ms = Some(7_200_084);
    overrides.push_wait_process_exit(exit);
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

    let failure = outcome.failure.as_ref().expect("expected timeout failure");
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Timeout");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(guest_duration_ms, Some(7_200_084));
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
}

#[tokio::test]
async fn execute_inner_guest_process_timeout_waits_for_terminal_grace_and_copies_logs() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 124, Vec::new(), b"Timeout".to_vec());
    exit.termination = SandboxExecTermination::TimedOut;
    exit.guest_duration_ms = Some(7_200_084);
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
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

    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    assert_eq!(start_calls[0].timeout, JOB_TIMEOUT);

    let wait_calls = overrides.wait_process_calls();
    assert_eq!(wait_calls.len(), 1);
    assert_eq!(wait_calls[0].timeout, job_terminal_wait_timeout());

    let failure = outcome.failure.as_ref().expect("expected timeout failure");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, JOB_TIMEOUT.as_millis());
            assert_eq!(guest_duration_ms, Some(7_200_084));
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }

    let copy_calls = overrides.copy_file_calls();
    assert_eq!(copy_calls.len(), 3);
    assert!(
        copy_calls[0].path.ends_with("/system.log"),
        "unexpected copy calls: {copy_calls:#?}"
    );
    assert!(
        copy_calls[1].path.ends_with("/metrics.jsonl"),
        "unexpected copy calls: {copy_calls:#?}"
    );
    assert!(
        copy_calls[2].path.ends_with("/sandbox-ops.jsonl"),
        "unexpected copy calls: {copy_calls:#?}"
    );
}

#[tokio::test]
async fn execute_inner_timeout_without_stderr_uses_timeout_message() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.termination = SandboxExecTermination::TimedOut;
    exit.guest_duration_ms = Some(7_200_084);
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
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

    let failure = outcome.failure.as_ref().expect("expected timeout failure");
    assert_eq!(outcome.exit_code(), 124);
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Timeout");
    match failure.kind {
        ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms: _,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(guest_duration_ms, Some(7_200_084));
        }
        ExecutionFailureKind::Generic => panic!("expected runner job timeout failure kind"),
    }
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_ordinary_124_timeout_text_is_generic_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 124, Vec::new(), b"Timeout".to_vec()));
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

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Timeout");
    assert_eq!(failure.kind, ExecutionFailureKind::Generic);
}

#[tokio::test]
async fn execute_inner_abnormal_exit_collects_guest_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".to_string(),
        exit_code: 0,
        stdout: b"/dev/root       7.8G  7.4G   20K 100% /\n/dev/vdb         16G   24K   15G   1% /home/user/workspace\nMem:            3934        3310         255           0         552         624\n".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
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

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 126);
    assert_eq!(failure.error, "Agent exited with code 126");
    let resource_diagnostics = failure
        .resource_diagnostics
        .expect("expected resource diagnostics");
    assert_eq!(
        resource_diagnostics.failure_kind,
        Some(ResourceFailureKind::GuestRootFilesystemFull)
    );
    assert_eq!(resource_diagnostics.guest_root_fs_used_percent, Some(100));
    assert_eq!(resource_diagnostics.guest_root_fs_available_kb, Some(20));
    assert_eq!(
        resource_diagnostics.guest_workspace_fs_used_percent,
        Some(1)
    );
    assert_eq!(resource_diagnostics.guest_memory_available_mb, Some(624));
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
    assert!(active_diagnostic_cmd.contains("df -P -k / /home/user/workspace"));
    assert!(active_diagnostic_cmd.contains("section rootfs-usage"));
    assert!(active_diagnostic_cmd.contains("timeout 1s du -sxh -- \"$target_path\""));
    assert!(active_diagnostic_cmd.contains("du -sxh -- \"$target_path\""));
    assert!(active_diagnostic_cmd.contains("2>/dev/null"));
    assert!(!active_diagnostic_cmd.contains("  /home/user/workspace \\"));
    assert_eq!(call.timeout, AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT);
    assert!(call.env_keys.is_empty());
    assert!(call.sudo);
    assert!(call.stdin_bytes.is_none());
    assert_eq!(call.output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
}

#[tokio::test]
async fn execute_inner_ignores_non_exited_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    overrides.add_exec_result_matcher(
        "guest-agent-binary",
        SandboxExecResult {
            termination: SandboxExecTermination::WaitFailed,
            stdout: b"/dev/root       7.8G  7.4G   20K 100% /\n/dev/vdb         16G   24K   15G   1% /home/user/workspace\nMem:            3934        3310         255           0         552         624\n".to_vec(),
            stderr: b"wait failed".to_vec(),
            diagnostic: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    );
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

    let failure = outcome.failure.as_ref().expect("expected failure");
    assert_eq!(failure.exit_code, 126);
    assert_eq!(failure.error, "Agent exited with code 126");
    assert!(failure.resource_diagnostics.is_none());
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
