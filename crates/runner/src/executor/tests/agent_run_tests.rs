use std::sync::Arc;
use std::time::Duration;

use sandbox::{ProcessExit, ProcessOutputChunk, SandboxConfig, SandboxFactory, SandboxId};
use sandbox_mock::MockSandboxFactory;

use super::super::agent_run::{ProcessCancelTimeouts, RunStart, run_in_sandbox};
use super::super::diagnostics::AgentStdoutStreamDiagnostics;
use super::super::{EXIT_SIGKILL, PROCESS_CANCEL_WRITE_TIMEOUT};
use super::support::{
    CancelAfterWaitSandbox, RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox,
    minimal_context, spawn_run_in_sandbox_test, spawn_run_in_sandbox_test_with_timeouts,
    test_executor_config, test_telemetry,
};
use crate::types::SandboxReuseResult;

#[tokio::test]
async fn run_in_sandbox_preserves_wait_result_when_cancel_arrives_after_wait() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let cancel = tokio_util::sync::CancellationToken::new();
    let factory = MockSandboxFactory::with_overrides(overrides);
    let sandbox = CancelAfterWaitSandbox {
        inner: factory
            .create(SandboxConfig {
                id: SandboxId::new_v4(),
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 2048,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .unwrap(),
        cancel: cancel.clone(),
    };
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        cancel.clone(),
    )
    .await
    .unwrap();

    assert!(cancel.is_cancelled());
    assert!(result.failure.is_none());
    assert_eq!(
        result.stdout_stream_diagnostics,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: false,
        }
    );
}

#[tokio::test]
async fn run_in_sandbox_cancels_guest_process_and_waits_for_terminal_status() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(
        result.stdout_stream_diagnostics,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: true,
        }
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_cancel_handle_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        wait_gate,
    ));
    overrides.set_process_cancel_supported(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert!(overrides.process_cancel_calls().is_empty());
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_process_cancel_send_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        wait_gate,
    ));
    overrides.push_process_cancel_error("cancel write failed");
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_wait_fails_after_process_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let mut overrides = sandbox_mock::MockSandboxOverrides::with_wait_process_gate(wait_gate);
    overrides.set_wait_process_error("wait failed after cancel");
    let overrides = Arc::new(overrides);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_terminal_grace_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        wait_gate,
    ));
    overrides.set_process_cancel_releases_wait_gate(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test_with_timeouts(
        sandbox,
        ctx,
        config,
        cancel.clone(),
        ProcessCancelTimeouts {
            write: PROCESS_CANCEL_WRITE_TIMEOUT,
            terminal_grace: Duration::ZERO,
        },
    );
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}
