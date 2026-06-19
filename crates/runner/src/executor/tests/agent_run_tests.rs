use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::types::runners::storage::StorageManifest;
use sandbox::{ProcessExit, ProcessOutputChunk, SandboxConfig, SandboxFactory, SandboxId};
use sandbox_mock::MockSandboxFactory;

use super::super::agent_run::{ProcessCancelTimeouts, RunControls, RunStart, run_in_sandbox};
use super::super::diagnostics::AgentStdoutStreamDiagnostics;
use super::super::storage::guest_download_command;
use super::super::{EXIT_SIGKILL, PROCESS_CANCEL_WRITE_TIMEOUT};
use super::support::{
    CancelAfterWaitSandbox, RUN_IN_SANDBOX_TEST_TIMEOUT, api_storage, create_overridden_sandbox,
    minimal_context, spawn_run_in_sandbox_test, spawn_run_in_sandbox_test_with_timeouts,
    test_executor_config, test_telemetry,
};
use crate::active_input::ActiveInputSource;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
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
        RunControls::new(cancel.clone(), None),
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
async fn run_in_sandbox_runs_guest_download_for_cached_instruction_normalization() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "instructions",
        "/home/user/.codex",
        "v1",
        "https://example.com/instructions.tar.gz",
    );
    storage.instructions_target_filename = Some("AGENTS.md".into());
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: vec![],
    });
    let prev_storage = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("instructions", "v1"),
        )]),
        artifacts: HashMap::new(),
    };
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: Some(&prev_storage),
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    let exec_calls = sandbox.exec_calls();
    assert!(
        exec_calls
            .iter()
            .any(|call| call.cmd == guest_download_command()),
        "cached instruction storage should still invoke guest-download; calls: {exec_calls:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_forwards_local_active_inputs_in_order_and_dedupes() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    let queue = LocalQueue::new(group_dir.clone());
    for entry in [
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            message_id: "msg-dup".to_string(),
            text: "first".to_string(),
        },
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 2,
            message_id: "msg-dup".to_string(),
            text: "duplicate".to_string(),
        },
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 3,
            message_id: "msg-3".to_string(),
            text: "third".to_string(),
        },
    ] {
        queue.write_active_input_sync(&entry).unwrap();
    }
    let source = ActiveInputSource::local_queue(group_dir, ctx.run_id);
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    let calls = overrides.process_control_calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["msg-dup", "msg-3"]
    );
    let payloads = calls
        .iter()
        .map(|call| serde_json::from_slice::<serde_json::Value>(&call.payload).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(payloads[0]["text"], "first");
    assert_eq!(payloads[1]["text"], "third");
}

#[tokio::test]
async fn run_in_sandbox_retries_active_input_after_control_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_io_error(
        std::io::ErrorKind::TimedOut,
        "simulated transient control error",
    );
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    LocalQueue::new(group_dir.clone())
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            message_id: "msg-1".to_string(),
            text: "first".to_string(),
        })
        .unwrap();
    let source = ActiveInputSource::local_queue(group_dir, ctx.run_id);
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert!(result.failure.is_none());
    assert_eq!(
        overrides
            .process_control_calls()
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["msg-1", "msg-1"]
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
