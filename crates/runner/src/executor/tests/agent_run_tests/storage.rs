use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sandbox::{ProcessOutputChunk, ProcessOutputMode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot};

use super::support::{
    assert_failed_action_error_once, assert_no_action, assert_successful_action_once,
};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::storage::guest_download_stdin_command;
use crate::executor::telemetry::RunnerSpawnTiming;
use crate::executor::tests::support::{
    OperationGateSandbox, RUN_IN_SANDBOX_TEST_TIMEOUT, SandboxGatePoint, api_artifact, api_storage,
    create_overridden_sandbox, minimal_context, sandbox_exec_error, test_executor_config,
    test_telemetry,
};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::storage_manifest::StorageManifest;
use crate::types::SandboxReuseResult;

async fn serve_storage_archive_for_cache(
    body: &'static [u8],
) -> (String, tokio::task::JoinHandle<()>, oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, request_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let probe_response = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
            body.len()
        )
        .into_bytes();
        let mut full_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        full_response.extend_from_slice(body);

        let mut request_tx = Some(request_tx);
        for response in [probe_response, full_response] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            if let Some(request_tx) = request_tx.take() {
                let _ = request_tx.send(());
            }
            stream.write_all(&response).await.unwrap();
        }
    });
    (
        format!("http://{address}/archive.tar.gz"),
        handle,
        request_rx,
    )
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
            .any(|call| call.cmd == guest_download_stdin_command()),
        "cached instruction storage should still invoke guest-download; calls: {exec_calls:?}"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_fingerprint_reuse");
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_cache_populate");
    assert_successful_action_once(&ops, "runner_storage_manifest_guest_download");
    assert_successful_action_once(&ops, "runner_storage_manifest_apply");
    assert!(
        ops.iter()
            .all(|(action, _, _)| action != "storage_download"),
        "runner telemetry should not use the guest-download per-entry metric name: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_starts_deferred_cache_fill_after_agent_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start_process_entered = Arc::new(Notify::new());
    let start_process_release = Arc::new(Notify::new());
    let sandbox = OperationGateSandbox {
        inner: create_overridden_sandbox(Arc::clone(&overrides)).await,
        point: SandboxGatePoint::StartProcess,
        entered: Arc::clone(&start_process_entered),
        release: Arc::clone(&start_process_release),
    };
    let mut ctx = minimal_context();
    let (archive_url, archive_server, mut archive_request) =
        serve_storage_archive_for_cache(b"cache-archive").await;
    let storage = api_storage("instructions", "/home/user/.codex", "v1", &archive_url);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: vec![],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    {
        let run = run_in_sandbox(
            &sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None)
                .with_spawn_timing(RunnerSpawnTiming::start(None)),
        );
        tokio::pin!(run);

        tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
            tokio::select! {
                result = &mut run => {
                    let _ = result;
                    panic!("run finished before the start-process barrier");
                },
                () = start_process_entered.notified() => {}
            }
        })
        .await
        .expect("run should reach the start-process barrier");

        assert!(matches!(
            archive_request.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let exec_calls = overrides.exec_calls();
        assert!(
            exec_calls
                .iter()
                .any(|call| call.cmd == guest_download_stdin_command()),
            "cache miss passthrough should reach guest-download before process spawn; calls: {exec_calls:?}"
        );

        start_process_release.notify_one();
        run.await.unwrap();
    }

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut archive_request)
        .await
        .expect("deferred cache fill should contact the archive after spawn")
        .expect("archive server should report its first request");
    tokio::time::timeout(Duration::from_secs(5), archive_server)
        .await
        .expect("background cache fill should fetch archive")
        .expect("background cache fill server task should not panic");
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_cache_populate");
    assert_successful_action_once(&ops, "runner_storage_manifest_guest_download");
    assert_successful_action_once(&ops, "runner_storage_manifest_apply");
    assert_successful_action_once(&ops, "storage_cache_miss_passthrough");
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_count_1");
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_delay");
    assert_successful_action_once(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_successful_action_once(&ops, "runner_agent_start_process");
    assert_successful_action_once(&ops, "runner_executor_start_to_spawn");
    assert_no_action(&ops, "storage_cache_miss");
    assert_no_action(&ops, "storage_cache_download");

    let spawn_index = ops
        .iter()
        .position(|op| op.0 == "runner_executor_start_to_spawn")
        .unwrap();
    let deferred_start_index = ops
        .iter()
        .position(|op| op.0 == "storage_cache_background_fill_deferred_delay")
        .unwrap();
    let scheduled_index = ops
        .iter()
        .position(|op| op.0 == "storage_cache_background_fill_scheduled_count_1")
        .unwrap();
    assert!(spawn_index < deferred_start_index);
    assert!(deferred_start_index < scheduled_index);
}

#[tokio::test]
async fn run_in_sandbox_drops_deferred_cache_fill_when_agent_spawn_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(
        (0..=ProcessOutputMode::DEFAULT_QUEUE_CAPACITY)
            .map(|_| ProcessOutputChunk {
                bytes: Vec::new(),
                truncated: false,
            })
            .collect(),
    );
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    let (archive_url, archive_server, mut archive_request) =
        serve_storage_archive_for_cache(b"cache-archive").await;
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "instructions",
            "/home/user/.codex",
            "v1",
            &archive_url,
        )],
        artifacts: vec![],
    });
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        sandbox.as_ref(),
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_spawn_timing(RunnerSpawnTiming::start(None)),
    )
    .await;
    assert!(result.is_err());
    tokio::task::yield_now().await;

    assert!(matches!(
        archive_request.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_count_1");
    assert!(
        ops.iter()
            .any(|op| op.0 == "runner_agent_start_process" && !op.1),
        "expected failed process spawn telemetry, got: {ops:?}"
    );
    assert_no_action(&ops, "storage_cache_background_fill_deferred_delay");
    assert_no_action(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_no_action(&ops, "runner_executor_start_to_spawn");

    archive_server.abort();
    let _ = archive_server.await;
}

#[tokio::test]
async fn run_in_sandbox_drops_deferred_cache_fill_when_guest_download_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    let mut ctx = minimal_context();
    let (archive_url, archive_server, mut archive_request) =
        serve_storage_archive_for_cache(b"cache-archive").await;
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "instructions",
            "/home/user/.codex",
            "v1",
            &archive_url,
        )],
        artifacts: vec![],
    });
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await;
    assert!(result.is_err());
    tokio::task::yield_now().await;

    assert!(matches!(
        archive_request.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "storage_cache_background_fill_deferred_count_1");
    assert_no_action(&ops, "storage_cache_background_fill_deferred_delay");
    assert_no_action(&ops, "storage_cache_background_fill_scheduled_count_1");
    assert_no_action(&ops, "runner_agent_start_process");
    assert_failed_action_error_once(
        &ops,
        "runner_storage_manifest_guest_download",
        "storage-download-failed",
    );

    archive_server.abort();
    let _ = archive_server.await;
}

#[tokio::test]
async fn run_in_sandbox_records_storage_manifest_no_work_timing_without_guest_download() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "instructions",
            "/home/user/.codex",
            "v1",
            "https://example.com/instructions.tar.gz",
        )],
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
            .all(|call| call.cmd != guest_download_stdin_command()),
        "fully cached storage without cleanup or instruction normalization should skip guest-download; calls: {exec_calls:?}"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_fingerprint_reuse");
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_apply");
    assert_no_action(&ops, "runner_storage_manifest_cache_populate");
    assert_no_action(&ops, "runner_storage_manifest_guest_download");
}

#[tokio::test]
async fn run_in_sandbox_records_storage_manifest_guest_download_failure_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
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

    let result = run_in_sandbox(
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
    .await;

    assert!(
        result.is_err(),
        "guest-download failure should still fail the storage manifest phase"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action_once(&ops, "runner_storage_manifest_fingerprint_reuse");
    assert_successful_action_once(&ops, "runner_storage_manifest_has_work");
    assert_successful_action_once(&ops, "runner_storage_manifest_cache_populate");
    assert_failed_action_error_once(
        &ops,
        "runner_storage_manifest_guest_download",
        "storage-download-failed",
    );
    let apply_failures = ops
        .iter()
        .filter(|op| op.0 == "runner_storage_manifest_apply" && !op.1)
        .count();
    assert_eq!(
        apply_failures, 1,
        "top-level storage manifest apply failure should still be recorded once, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_rejects_non_empty_artifact_without_archive_url() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
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
        storages: vec![],
        artifacts: vec![artifact],
    });
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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("invalid storage manifest should fail"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("storage manifest artifact memory version version-2 is missing archiveUrl"),
        "got: {error}"
    );
    let exec_calls = sandbox.exec_calls();
    assert!(
        exec_calls
            .iter()
            .all(|call| call.cmd != guest_download_stdin_command()),
        "invalid storage manifest should fail before guest-download; calls: {exec_calls:?}"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "runner_storage_manifest_apply",
        "internal error: storage manifest artifact memory version version-2 is missing archiveUrl",
    );
    assert_no_action(&ops, "runner_storage_manifest_has_work");
    assert_no_action(&ops, "runner_storage_manifest_guest_download");
}
