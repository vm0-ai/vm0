use std::sync::Arc;
use std::time::Duration;

use sandbox::ProcessOutputMode;
use sandbox_mock::MockLifecycleGate;
use tokio::sync::Notify;

use crate::executor::EXIT_SIGKILL;
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::codex_model_catalog_prefetch::PREFETCH_HOST_START_TIMEOUT;
use crate::executor::tests::support::{
    OperationGateSandbox, RUN_IN_SANDBOX_TEST_TIMEOUT, SandboxGatePoint, create_overridden_sandbox,
    minimal_context, sandbox_exec_error, spawn_run_in_sandbox_test, test_executor_config,
    test_telemetry,
};
use crate::types::{CodexRuntimeConfig, ExecutionContext, FirewallEntry, SandboxReuseResult};

fn codex_oauth_context() -> ExecutionContext {
    let mut context = minimal_context();
    context.cli_agent_type = "codex".into();
    context.encrypted_secrets = Some("encrypted".into());
    context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "model-provider:codex-oauth-token".into(),
        base_url_vars: None,
    }]);
    context
}
#[tokio::test]
async fn codex_catalog_prefetch_waits_for_guest_state_restore() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let inner = sandbox_mock::MockSandbox::new("test");
    inner.push_exec_result(Err(sandbox_exec_error("restore failed")));
    let prefetch_started = Arc::new(Notify::new());
    let sandbox = OperationGateSandbox {
        inner: Box::new(inner),
        point: SandboxGatePoint::StartProcess,
        entered: Arc::clone(&prefetch_started),
        release: Arc::new(Notify::new()),
    };
    let ctx = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        run_in_sandbox(
            &sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: true,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        ),
    )
    .await
    .unwrap();

    assert!(result.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(10), prefetch_started.notified())
            .await
            .is_err(),
        "prefetch must not start before guest state restoration succeeds",
    );
}

#[tokio::test]
async fn codex_catalog_prefetch_start_observes_run_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let prefetch_started = Arc::new(Notify::new());
    let sandbox = OperationGateSandbox {
        inner: create_overridden_sandbox(Arc::clone(&overrides)).await,
        point: SandboxGatePoint::StartProcess,
        entered: Arc::clone(&prefetch_started),
        release: Arc::new(Notify::new()),
    };
    let ctx = codex_oauth_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(Box::new(sandbox), ctx, config, cancel.clone());

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, prefetch_started.notified())
        .await
        .expect("prefetch should enter process start");
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("cancelled prefetch start should not hold the run open")
        .unwrap()
        .unwrap();

    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert!(overrides.start_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
    assert!(overrides.process_cancel_calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn codex_catalog_prefetch_start_timeout_does_not_delay_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let process_start_entered = Arc::new(Notify::new());
    let process_start_release = Arc::new(Notify::new());
    let sandbox = OperationGateSandbox {
        inner: create_overridden_sandbox(Arc::clone(&overrides)).await,
        point: SandboxGatePoint::StartProcess,
        entered: Arc::clone(&process_start_entered),
        release: Arc::clone(&process_start_release),
    };
    let run_task = spawn_run_in_sandbox_test(
        Box::new(sandbox),
        codex_oauth_context(),
        config,
        tokio_util::sync::CancellationToken::new(),
    );

    process_start_entered.notified().await;
    tokio::time::advance(PREFETCH_HOST_START_TIMEOUT).await;
    tokio::task::yield_now().await;
    process_start_release.notify_one();

    let result = run_task.await.unwrap().unwrap();
    assert!(result.failure.is_none());
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    assert!(!start_calls[0].cmd.contains("codex --version"));
}

async fn assert_codex_catalog_prefetch_skipped(
    context: ExecutionContext,
    reuse_result: SandboxReuseResult,
    scenario: &str,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut telemetry = test_telemetry(&config, &context);

    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        run_in_sandbox(
            &*sandbox,
            &context,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        ),
    )
    .await
    .unwrap()
    .unwrap();

    assert!(result.failure.is_none(), "{scenario}");
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1, "{scenario}");
    assert!(
        !start_calls[0].cmd.contains("codex --version"),
        "{scenario}"
    );
}

#[tokio::test]
async fn codex_catalog_prefetch_skips_ineligible_runs() {
    let mut unrelated_framework = codex_oauth_context();
    unrelated_framework.cli_agent_type = "claude-code".into();

    let mut missing_secrets = codex_oauth_context();
    missing_secrets.encrypted_secrets = None;

    let mut missing_firewall = codex_oauth_context();
    missing_firewall.firewalls = None;

    let mut custom_runtime = codex_oauth_context();
    custom_runtime.codex_runtime_config = Some(CodexRuntimeConfig {
        provider_id: "provider".into(),
        name: "custom".into(),
        base_url: "https://provider.example".into(),
        env_key: "TOKEN".into(),
        http_headers: None,
        requires_openai_auth: None,
        wire_api: "responses".into(),
        supports_websockets: false,
        model_catalog: None,
    });

    let scenarios = [
        (
            unrelated_framework,
            SandboxReuseResult::PoolMiss,
            "unrelated framework",
        ),
        (
            missing_secrets,
            SandboxReuseResult::PoolMiss,
            "missing encrypted secrets",
        ),
        (
            missing_firewall,
            SandboxReuseResult::PoolMiss,
            "missing Codex OAuth firewall",
        ),
        (
            custom_runtime,
            SandboxReuseResult::PoolMiss,
            "custom Codex runtime",
        ),
        (
            codex_oauth_context(),
            SandboxReuseResult::Reused,
            "reused sandbox",
        ),
    ];

    for (context, reuse_result, scenario) in scenarios {
        assert_codex_catalog_prefetch_skipped(context, reuse_result, scenario).await;
    }
}

#[tokio::test]
async fn codex_catalog_prefetch_is_cancelled_on_pre_spawn_exit() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let private_write_started = Arc::new(Notify::new());
    let sandbox = OperationGateSandbox {
        inner: create_overridden_sandbox(Arc::clone(&overrides)).await,
        point: SandboxGatePoint::WritePrivateFile,
        entered: Arc::clone(&private_write_started),
        release: Arc::new(Notify::new()),
    };
    let ctx = codex_oauth_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(Box::new(sandbox), ctx, config, cancel.clone());

    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("prefetch should enter process wait");
    tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        private_write_started.notified(),
    )
    .await
    .expect("run should enter private-file preparation");
    cancel.cancel();

    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("prefetch cleanup should be bounded")
        .unwrap()
        .unwrap();

    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert_eq!(overrides.wait_process_calls().len(), 1);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
}

#[tokio::test]
async fn fresh_codex_oauth_run_prefetches_catalog_while_agent_prepares() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = codex_oauth_context();
    let run_task = spawn_run_in_sandbox_test(
        sandbox,
        ctx,
        config,
        tokio_util::sync::CancellationToken::new(),
    );

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        loop {
            if overrides.start_process_calls().len() == 2
                && overrides.wait_process_calls().len() == 2
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let start_calls = overrides.start_process_calls();
    assert!(start_calls[0].cmd.contains("codex --version"));
    assert!(
        start_calls[0]
            .cmd
            .contains("X-VM0-Codex-Model-Catalog-Prefetch: 1")
    );
    assert_eq!(start_calls[0].control, sandbox::ProcessControlMode::None);
    assert!(matches!(
        start_calls[0].output,
        ProcessOutputMode::Buffered { .. }
    ));
    assert_eq!(start_calls[1].control, sandbox::ProcessControlMode::Enabled);
    assert!(!start_calls[1].cmd.contains("codex --version"));

    wait_gate.notify_waiters();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
}
