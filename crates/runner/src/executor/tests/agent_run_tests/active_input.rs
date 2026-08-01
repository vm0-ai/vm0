use std::sync::Arc;

use crate::active_input::ActiveInputSource;
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context, test_executor_config,
    test_telemetry,
};
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::types::SandboxReuseResult;

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
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
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
async fn run_in_sandbox_sets_codex_app_server_backend_for_active_input_source() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let group_dir = dir.path().join("active-inputs");
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
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
    .unwrap();

    assert!(result.failure.is_none());
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    let env = start_calls[0]
        .env
        .iter()
        .cloned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(
        env.get(guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV)
            .unwrap(),
        "1"
    );
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
    LocalQueue::new(group_dir.clone())
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 2,
            message_id: "msg-2".to_string(),
            text: "second".to_string(),
        })
        .unwrap();
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
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
            .wait_for_process_control_calls(3, RUN_IN_SANDBOX_TEST_TIMEOUT)
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
        vec!["msg-1", "msg-1", "msg-2"]
    );
}
