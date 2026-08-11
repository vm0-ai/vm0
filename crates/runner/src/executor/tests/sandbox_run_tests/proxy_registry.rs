use super::*;
use crate::executor::tests::support::RUN_IN_SANDBOX_TEST_TIMEOUT;
use crate::executor::{SandboxReuseDisposition, SandboxReuseRejection};

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
async fn proxy_registration_accepts_rollout_candidates_and_canonical_targets() {
    let candidate_dir = tempfile::tempdir().unwrap();
    let candidate_config = test_executor_config(candidate_dir.path()).await;
    let mut candidate_context = minimal_context();
    candidate_context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "model-provider:anthropic-api-key".to_string(),
        base_url_vars: None,
    }]);
    candidate_context.connector_runtime_targets = Vec::new();
    candidate_context.connector_runtime_candidate_targets =
        Some(vec![ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "zendesk".to_string(),
            base_url_vars: Some(HashMap::from([(
                "ZENDESK_SUBDOMAIN".to_string(),
                "xn--mnich-kva".to_string(),
            )])),
        }]);
    candidate_context.vars = Some(HashMap::from([(
        "ZENDESK_SUBDOMAIN".to_string(),
        "münich".to_string(),
    )]));

    let _candidate_session = register_proxy(&candidate_config, &candidate_context, "10.200.0.2")
        .await
        .unwrap();
    let candidate_registry: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(candidate_dir.path().join("proxy-registry.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let candidate_vm = &candidate_registry["vms"]["10.200.0.2"];
    assert_eq!(
        candidate_vm["firewalls"],
        serde_json::json!([
            {
                "kind": "builtin",
                "name": "model-provider:anthropic-api-key"
            },
            {
                "kind": "builtin",
                "name": "zendesk",
                "baseUrlVars": {
                    "ZENDESK_SUBDOMAIN": "xn--mnich-kva"
                }
            }
        ])
    );
    assert_eq!(
        candidate_vm["connectorRuntimeTargets"],
        serde_json::json!([{
            "kind": "builtin",
            "connectorSlug": "zendesk"
        }])
    );
    assert_eq!(
        candidate_vm["connectorRoutingVariables"]["builtin:zendesk"],
        serde_json::json!({"ZENDESK_SUBDOMAIN": "münich"})
    );

    let canonical_dir = tempfile::tempdir().unwrap();
    let canonical_config = test_executor_config(canonical_dir.path()).await;
    let mut canonical_context = minimal_context();
    let canonical_routing_variables =
        HashMap::from([("ZENDESK_SUBDOMAIN".to_string(), "xn--mnich-kva".to_string())]);
    canonical_context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "zendesk".to_string(),
        base_url_vars: Some(canonical_routing_variables.clone()),
    }]);
    canonical_context.connector_runtime_targets =
        vec![ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "zendesk".to_string(),
            base_url_vars: Some(canonical_routing_variables),
        }];
    canonical_context.connector_runtime_candidate_targets = None;
    canonical_context.vars = Some(HashMap::from([(
        "ZENDESK_SUBDOMAIN".to_string(),
        "münich".to_string(),
    )]));

    let _canonical_session = register_proxy(&canonical_config, &canonical_context, "10.200.0.3")
        .await
        .unwrap();
    let canonical_registry: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(canonical_dir.path().join("proxy-registry.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let canonical_vm = &canonical_registry["vms"]["10.200.0.3"];
    assert_eq!(
        canonical_vm["firewalls"],
        serde_json::json!([{
            "kind": "builtin",
            "name": "zendesk",
            "baseUrlVars": {
                "ZENDESK_SUBDOMAIN": "xn--mnich-kva"
            }
        }])
    );
    assert_eq!(
        canonical_vm["connectorRuntimeTargets"],
        serde_json::json!([{
            "kind": "builtin",
            "connectorSlug": "zendesk"
        }])
    );
    assert_eq!(
        canonical_vm["connectorRoutingVariables"]["builtin:zendesk"],
        serde_json::json!({"ZENDESK_SUBDOMAIN": "münich"})
    );
}

#[tokio::test]
async fn proxy_registration_rejects_conflicting_builtin_candidate_sources() {
    let routing_variables =
        HashMap::from([("ZENDESK_SUBDOMAIN".to_string(), "xn--mnich-kva".to_string())]);

    let routing_dir = tempfile::tempdir().unwrap();
    let routing_config = test_executor_config(routing_dir.path()).await;
    let mut routing_context = minimal_context();
    routing_context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "zendesk".to_string(),
        base_url_vars: None,
    }]);
    routing_context.connector_runtime_candidate_targets =
        Some(vec![ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "zendesk".to_string(),
            base_url_vars: Some(routing_variables),
        }]);

    let routing_error = match register_proxy(&routing_config, &routing_context, "10.200.0.4").await
    {
        Ok(_) => panic!("conflicting pinned routing variables must fail registration"),
        Err(error) => error,
    };
    assert!(
        routing_error
            .to_string()
            .contains("zendesk has conflicting pinned routing variables"),
        "unexpected error: {routing_error}"
    );

    let ownership_dir = tempfile::tempdir().unwrap();
    let ownership_config = test_executor_config(ownership_dir.path()).await;
    let mut ownership_context = minimal_context();
    ownership_context.firewalls = Some(vec![FirewallEntry::Inline {
        firewall: Firewall {
            name: "zendesk".to_string(),
            apis: vec![FirewallApi {
                id: "custom-zendesk:0".to_string(),
                base: "https://custom.example.test/".to_string(),
                auth: FirewallAuth {
                    headers: HashMap::new(),
                    base: None,
                    query: None,
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: None,
            }],
        },
        custom_connector_id: None,
    }]);
    ownership_context.connector_runtime_candidate_targets =
        Some(vec![ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "zendesk".to_string(),
            base_url_vars: None,
        }]);

    let ownership_error =
        match register_proxy(&ownership_config, &ownership_context, "10.200.0.5").await {
            Ok(_) => panic!("inline ownership conflicts must fail registration"),
            Err(error) => error,
        };
    assert!(
        ownership_error
            .to_string()
            .contains("zendesk conflicts with an inline firewall"),
        "unexpected error: {ownership_error}"
    );
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
    overrides.push_copy_file_result(Ok(b"guest system log\n".to_vec()));
    let copy_gate = MockLifecycleGate::new();
    overrides.set_copy_file_lifecycle_gate(copy_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    );
    tokio::pin!(run);

    tokio::select! {
        outcome = &mut run => {
            let _ = outcome;
            panic!("run finished before the diagnostic copy gate");
        }
        entered = copy_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => {
            entered.expect("run should reach the diagnostic copy gate");
        }
    }
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    overrides.clear_copy_file_lifecycle_gate();
    copy_gate.release_many(overrides.copy_file_calls().len());

    let outcome = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut run)
        .await
        .expect("post-gate proxy cleanup and finalization should complete");

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
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::PostJobCleanupFailure),
    );
}
