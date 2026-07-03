use super::*;

fn capture_proxy_register_events(action: impl FnOnce()) -> Vec<CapturedEvent> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, action);
    captured.entries()
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}
#[test]
fn proxy_register_fast_success_logs_info() {
    let events = capture_proxy_register_events(|| {
        log_proxy_register_success(
            RunId::nil(),
            SandboxId::from(uuid::Uuid::nil()),
            "vm0/default",
            Duration::from_secs(1),
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "message", "proxy register timing");
    assert_event_field(event, "stage", "proxy_register");
    assert_event_field(event, "elapsed_ms", "1000");
    assert_event_field(event, "threshold_ms", "3000");
    assert_event_field(event, "success", "true");
    assert_event_field(event, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "sandbox_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "profile", "vm0/default");
}

#[test]
fn proxy_register_slow_success_warns_with_stable_fields() {
    let events = capture_proxy_register_events(|| {
        log_proxy_register_success(
            RunId::nil(),
            SandboxId::from(uuid::Uuid::nil()),
            "vm0/default",
            Duration::from_secs(3),
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "message", "slow proxy register");
    assert_event_field(event, "stage", "proxy_register");
    assert_event_field(event, "elapsed_ms", "3000");
    assert_event_field(event, "threshold_ms", "3000");
    assert_event_field(event, "success", "true");
    assert_event_field(event, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "sandbox_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "profile", "vm0/default");
}

#[test]
fn proxy_register_failure_warns_with_error() {
    let events = capture_proxy_register_events(|| {
        log_proxy_register_failure(
            RunId::nil(),
            SandboxId::from(uuid::Uuid::nil()),
            "vm0/default",
            Duration::from_millis(25),
            "registry failed",
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "message", "proxy register failed");
    assert_event_field(event, "stage", "proxy_register");
    assert_event_field(event, "elapsed_ms", "25");
    assert_event_field(event, "success", "false");
    assert_event_field(event, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "sandbox_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "profile", "vm0/default");
    assert_event_field(event, "error", "registry failed");
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
    let prev_storage = crate::storage_fingerprints::StorageFingerprints::default();

    let outcome = execute_reused_sandbox(
        sandbox,
        &source_ip,
        &ctx,
        &config,
        &prev_storage,
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
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
    assert!(outcome.discovered_cli_agent_session_id.is_none());
}
