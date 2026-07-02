use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use api_contracts::generated::types::runners::storage::StorageManifest;
use flate2::{Compression, write::GzEncoder};
use guest_contracts::session_history_identity::{
    FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES, FinalSessionHistoryFramework,
    FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
};
use httpmock::prelude::*;
use sandbox::{
    ExecResult, ExecTermination, ProcessExit, ProcessOutputChunk, SandboxConfig, SandboxFactory,
    SandboxId,
};
use sandbox_mock::MockSandboxFactory;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot};

use super::super::agent_run::{
    ProcessCancelTimeouts, RunControls, RunStart, build_agent_start_command, run_in_sandbox,
};
use super::super::diagnostics::AgentStdoutStreamDiagnostics;
use super::super::storage::guest_download_stdin_command;
use super::super::{
    EXIT_SIGKILL, PROCESS_CANCEL_WRITE_TIMEOUT, RestoredSessionIdentity,
    SessionHistoryMaterializer, SessionHistoryRestoreFallback, SessionHistoryRestorePlan,
};
use super::support::{
    CancelAfterWaitSandbox, RUN_IN_SANDBOX_TEST_TIMEOUT, api_storage, create_overridden_sandbox,
    minimal_context, sandbox_exec_error, spawn_run_in_sandbox_test,
    spawn_run_in_sandbox_test_with_timeouts, test_executor_config, test_telemetry,
};
use crate::active_input::ActiveInputSource;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::restored_session_identity::RestoredSessionIdentityMismatchReason;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::types::{
    ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind, SandboxReuseResult,
};

const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;

fn gzip_bytes(raw: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(raw).unwrap();
    encoder.finish().unwrap()
}

async fn serve_history_once(body: &'static [u8]) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    });
    format!("http://{address}/history.blob?token=secret")
}

async fn serve_history_once_after_request(
    body: &'static [u8],
    request_received: oneshot::Sender<()>,
    release_response: Arc<Notify>,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request).await;
        let _ = request_received.send(());
        release_response.notified().await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    });
    format!("http://{address}/history.blob?token=secret")
}

fn claude_history_path(session_id: &str) -> String {
    format!("/home/user/.claude/projects/-home-user-workspace/{session_id}.jsonl")
}

fn final_identity_runtime_paths(ctx: &crate::types::ExecutionContext) -> (String, String) {
    let run_dir = guest_contracts::runtime_paths::run_dir_for_home(
        CANONICAL_GUEST_HOME_DIR,
        &ctx.run_id.to_string(),
    )
    .unwrap();
    let metadata_path =
        guest_contracts::runtime_paths::final_session_history_identity_file(&run_dir)
            .to_string_lossy()
            .into_owned();
    (metadata_path, run_dir.to_string_lossy().into_owned())
}

fn final_identity_metadata_bytes(
    session_id: &str,
    history: &[u8],
    history_marker_payload: impl Into<String>,
) -> Vec<u8> {
    FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        history_marker_payload,
    )
    .unwrap()
    .to_json_vec()
    .unwrap()
}

fn assert_successful_action(ops: &[(String, bool, Option<String>)], action: &str) {
    assert!(
        ops.iter().any(|op| op.0 == action && op.1),
        "expected {action} telemetry, got: {ops:?}"
    );
}

fn assert_successful_action_once(ops: &[(String, bool, Option<String>)], action: &str) {
    let matches = ops.iter().filter(|op| op.0 == action && op.1).count();
    assert_eq!(
        matches, 1,
        "expected exactly one successful {action} telemetry, got: {ops:?}"
    );
}

fn assert_failed_action_error_once(
    ops: &[(String, bool, Option<String>)],
    action: &str,
    error: &str,
) {
    let matches = ops
        .iter()
        .filter(|op| op.0 == action && !op.1 && op.2.as_deref() == Some(error))
        .count();
    assert_eq!(
        matches, 1,
        "expected exactly one failed {action} telemetry with {error:?}, got: {ops:?}"
    );
}

fn assert_successful_action_with_encoding(
    ops: &[(String, bool, Option<String>, Option<String>)],
    action: &str,
    encoding: &str,
) {
    assert!(
        ops.iter()
            .any(|op| op.0 == action && op.1 && op.3.as_deref() == Some(encoding)),
        "expected {action} telemetry with {encoding} encoding, got: {ops:?}"
    );
}

fn assert_no_action(ops: &[(String, bool, Option<String>)], action: &str) {
    assert!(
        ops.iter().all(|op| op.0 != action),
        "expected no {action} telemetry, got: {ops:?}"
    );
}

async fn assert_checkpointed_final_identity_helper_failure_falls_back(
    session_id: &str,
    helper_result: ExecResult,
    expected_reason_action: &str,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let metadata = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_path(session_id),
    )
    .unwrap();
    let idle_identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
            .expect("checkpointed identity");
    sandbox.push_exec_result(Ok(helper_result));
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    assert_eq!(sandbox.exec_calls().len(), 1);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(&ops, expected_reason_action);
    assert_successful_action(&ops, "session_history_restore_fallback_stale_idle_identity");
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "helper failure should not record skip telemetry, got: {ops:?}"
    );
}

#[test]
fn agent_start_command_reports_missing_agent_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("missing-agent");

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(127));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "agent bootstrap failed: guest-agent is missing\n"
    );
}

#[test]
fn agent_start_command_reports_non_executable_agent_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("guest-agent");
    fs::write(&agent_path, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&agent_path, fs::Permissions::from_mode(0o644)).unwrap();

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(126));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "agent bootstrap failed: guest-agent is not executable\n"
    );
}

#[test]
fn agent_start_command_reports_non_file_agent_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("guest-agent");
    fs::create_dir(&agent_path).unwrap();

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(126));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "agent bootstrap failed: guest-agent is not a regular file\n"
    );
}

#[test]
fn agent_start_command_keeps_agent_stderr_merged_into_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("guest-agent");
    fs::write(
        &agent_path,
        "#!/bin/sh\nprintf 'agent stdout\\n'\nprintf 'agent stderr\\n' >&2\n",
    )
    .unwrap();
    fs::set_permissions(&agent_path, fs::Permissions::from_mode(0o755)).unwrap();

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "agent stdout\nagent stderr\n"
    );
    assert!(output.stderr.is_empty());
}

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
            bytes_written: 14,
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
async fn run_in_sandbox_materializes_resume_session_history_ref_before_restore() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: serve_history_once(history).await,
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
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
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-ref-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
}

#[tokio::test]
async fn run_in_sandbox_records_gzip_session_history_download_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let compressed = Box::leak(gzip_bytes(history).into_boxed_slice());
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-gzip-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: serve_history_once(compressed).await,
                encoding: Some(ResumeSessionHistoryEncoding::Gzip),
                raw_size: history.len() as u64,
                encoded_size: compressed.len() as u64,
            },
        },
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
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-gzip-ref-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_with_encoding_snapshot();
    assert_successful_action_with_encoding(&ops, "session_history_download", "gzip");
    assert_successful_action_with_encoding(&ops, "session_history_download_request_status", "gzip");
    assert_successful_action_with_encoding(&ops, "session_history_download_body_read", "gzip");
    assert_successful_action_with_encoding(&ops, "session_history_download_validation", "gzip");
    assert_successful_action_with_encoding(
        &ops,
        "session_history_download_hash_verification",
        "gzip",
    );
}

#[tokio::test]
async fn run_in_sandbox_uses_prestarted_session_history_materializer() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let (request_received_tx, request_received_rx) = oneshot::channel();
    let release_response = Arc::new(Notify::new());
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-prestarted-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: serve_history_once_after_request(
                    history,
                    request_received_tx,
                    Arc::clone(&release_response),
                )
                .await,
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });

    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        ctx.resume_session.as_ref(),
        tokio_util::sync::CancellationToken::new(),
    );
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_received_rx)
        .await
        .unwrap()
        .unwrap();
    release_response.notify_one();
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        while !materializer.is_download_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: None,
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-prestarted-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_materializer_completed_before_restore",
    );
    assert_successful_action(&ops, "session_history_materialization_wait");
    assert_successful_action(&ops, "session_history_download");
    assert_successful_action(&ops, "session_history_download_request_status");
    assert_successful_action(&ops, "session_history_download_body_read");
    assert_successful_action(&ops, "session_history_download_validation");
    assert_successful_action(&ops, "session_history_download_hash_verification");
}

#[tokio::test]
async fn run_in_sandbox_records_completed_prestarted_materializer_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-prestarted-failed-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(b"different")),
                url: serve_history_once(history).await,
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });

    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        ctx.resume_session.as_ref(),
        tokio_util::sync::CancellationToken::new(),
    );
    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        while !materializer.is_download_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

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
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: None,
            }),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("expected completed prestarted materializer failure"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("hash mismatch"));
    let ops = telemetry.pending_ops_snapshot();
    assert_failed_action_error_once(
        &ops,
        "session_history_materializer_completed_before_restore",
        "session history materialization failed",
    );
    assert_failed_action_error_once(
        &ops,
        "session_history_download",
        "session history download failed",
    );
    assert_failed_action_error_once(
        &ops,
        "session_history_download_hash_verification",
        "session history download phase failed",
    );
}

#[tokio::test]
async fn run_in_sandbox_skips_checkpointed_final_session_history_restore() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-skip-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(&history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let previous_metadata_path =
        "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
    let previous_runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
    let metadata = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(&history)),
        history.len() as u64,
        claude_history_path(session_id),
    )
    .unwrap();
    let idle_identity = RestoredSessionIdentity::from_final_metadata(
        metadata.clone(),
        previous_metadata_path,
        previous_runtime_dir,
    )
    .expect("checkpointed identity");
    let final_identity = RestoredSessionIdentity::from_final_metadata(
        metadata.clone(),
        metadata_path.clone(),
        runtime_dir,
    )
    .expect("final identity");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_read_file_result(Ok(Some(metadata.to_json_vec().unwrap())));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert_eq!(result.restored_session_identity, Some(final_identity));
    assert_eq!(
        result
            .restored_session_identity
            .as_ref()
            .and_then(RestoredSessionIdentity::final_metadata_path),
        Some(metadata_path.as_str())
    );
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    assert_eq!(
        read_calls[0].max_bytes,
        FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1
    );
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    for call in exec_calls {
        assert!(call.cmd.contains("verify-session-history-identity"));
        assert!(call.cmd.contains(previous_metadata_path));
        assert!(call.cmd.contains(metadata.framework.as_str()));
        assert!(call.cmd.contains(&metadata.session_id_hash));
        assert!(call.cmd.contains(metadata.history_ref_kind.as_str()));
        assert!(call.cmd.contains(&metadata.history_hash));
        assert!(call.cmd.contains(&metadata.history_size_bytes.to_string()));
        assert_eq!(
            call.env_keys,
            vec![guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV]
        );
        assert!(!call.sudo);
        assert!(call.stdin_bytes.is_none());
    }
    history_mock.assert_calls_async(0).await;
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_reuse_hit" && op.1),
        "expected checkpointed identity reuse hit telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_skip" && op.1),
        "expected checkpointed skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_reports_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-helper-mismatch-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let metadata = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_path(session_id),
    )
    .unwrap();
    let idle_identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path.clone(), runtime_dir)
            .expect("checkpointed identity");
    sandbox.push_exec_result(Ok(ExecResult::new(
        SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
        Vec::new(),
        Vec::new(),
    )));
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(exec_calls[0].cmd.contains(&metadata_path));
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, claude_history_path(session_id));
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_identity_verify_helper_history_mismatch",
    );
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_fallback_stale_idle_identity" && op.1),
        "expected helper failure stale fallback telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "helper failure should not record skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_exec_errors() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-helper-exec-errors-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let (metadata_path, runtime_dir) = final_identity_runtime_paths(&ctx);
    let metadata = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        claude_history_path(session_id),
    )
    .unwrap();
    let idle_identity =
        RestoredSessionIdentity::from_final_metadata(metadata, metadata_path.clone(), runtime_dir)
            .expect("checkpointed identity");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock exec failed")));
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    assert_eq!(sandbox.exec_calls().len(), 1);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(&ops, "session_history_identity_verify_helper_exec_error");
    assert_successful_action(&ops, "session_history_restore_fallback_stale_idle_identity");
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "helper exec error should not record skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_times_out() {
    assert_checkpointed_final_identity_helper_failure_falls_back(
        "sess-final-helper-timeout-123",
        ExecResult {
            termination: ExecTermination::TimedOut,
            stdout: Vec::new(),
            stderr: Vec::new(),
            diagnostic: "session history identity helper timed out".to_string(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
        "session_history_identity_verify_helper_timed_out",
    )
    .await;
}

#[tokio::test]
async fn run_in_sandbox_restores_when_checkpointed_final_identity_helper_is_over_budget() {
    assert_checkpointed_final_identity_helper_failure_falls_back(
        "sess-final-helper-too-large-123",
        ExecResult::new(
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
            Vec::new(),
            Vec::new(),
        ),
        "session_history_identity_verify_helper_history_too_large",
    )
    .await;
}

#[tokio::test]
async fn run_in_sandbox_restores_when_skip_verified_identity_mismatches_request() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-mismatch-skip-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let mut mismatched_ctx = minimal_context();
    mismatched_ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-other-skip-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/other-history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let idle_identity = RestoredSessionIdentity::from_context(&mismatched_ctx).expect("identity");
    sandbox.push_read_file_result(Ok(None));
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::SkipVerified(
                idle_identity,
            )),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-mismatch-skip-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(&ops, "session_history_identity_verify_request_mismatch");
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_fallback_stale_idle_identity" && op.1),
        "expected mismatch fallback telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter().all(|op| op.0 != "session_history_restore_skip"),
        "mismatched identity should not record skip telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_fallback_and_restores_prestarted_history() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-fallback-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    sandbox.push_read_file_result(Ok(None));
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        ctx.resume_session.as_ref(),
        tokio_util::sync::CancellationToken::new(),
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                    RestoredSessionIdentityMismatchReason::HistoryHash,
                ))),
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-fallback-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_restore_fallback_identity_mismatch" && op.1),
        "expected fallback telemetry, got: {ops:?}"
    );
    assert_successful_action(&ops, "session_history_identity_mismatch_history_hash");
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_download" && op.1),
        "expected download telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter().any(|op| op.0 == "session_restore" && op.1),
        "expected restore telemetry, got: {ops:?}"
    );
    assert_successful_action(&ops, "session_history_identity_finalize_missing_metadata");
}

#[tokio::test]
async fn run_in_sandbox_records_missing_idle_identity_reuse_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let server = MockServer::start_async().await;
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-missing-identity-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    sandbox.push_read_file_result(Ok(None));
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        ctx.resume_session.as_ref(),
        tokio_util::sync::CancellationToken::new(),
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    history_mock.assert_calls_async(1).await;
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-missing-identity-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_identity_reuse_missing_no_idle_identity",
    );
    assert_successful_action(&ops, "session_history_identity_finalize_missing_metadata");
    assert!(
        ops.iter()
            .any(|op| { op.0 == "session_history_restore_fallback_missing_idle_identity" && op.1 }),
        "expected missing identity fallback telemetry, got: {ops:?}"
    );
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_reuse_missing" && op.1),
        "expected identity reuse missing telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_uses_final_identity_when_restored_history_changes_before_parking() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let final_history = br#"{"type":"done"}"#;
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/history.blob");
            then.status(200).body(history);
        })
        .await;
    let mut ctx = minimal_context();
    let session_id = "sess-final-mutated-123";
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: hex::encode(Sha256::digest(history)),
                url: server.url("/history.blob?token=secret"),
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
    });
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    sandbox.push_read_file_result(Ok(Some(final_identity_metadata_bytes(
        session_id,
        final_history,
        claude_history_path(session_id),
    ))));
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        ctx.resume_session.as_ref(),
        tokio_util::sync::CancellationToken::new(),
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None)
            .with_session_history_restore_plan(SessionHistoryRestorePlan::Prestarted {
                materializer,
                fallback: None,
            }),
    )
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let identity = result
        .restored_session_identity
        .as_ref()
        .expect("final identity");
    assert_eq!(
        identity.history_hash(),
        hex::encode(Sha256::digest(final_history))
    );
    assert_eq!(
        identity.history_size_bytes(),
        Some(final_history.len() as u64)
    );
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    assert_eq!(
        read_calls[0].max_bytes,
        FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES + 1
    );
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_finalized" && op.1),
        "expected final identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_uses_final_identity_without_resume_request() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let ctx = minimal_context();
    let session_id = "sess-first-turn-final-123";
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    sandbox.push_read_file_result(Ok(Some(final_identity_metadata_bytes(
        session_id,
        history,
        claude_history_path(session_id),
    ))));
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
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let identity = result
        .restored_session_identity
        .as_ref()
        .expect("final identity");
    assert_eq!(
        identity.history_hash(),
        hex::encode(Sha256::digest(history))
    );
    assert_eq!(identity.history_size_bytes(), Some(history.len() as u64));
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    let read_calls = sandbox.read_file_calls();
    assert_eq!(read_calls.len(), 1);
    assert_eq!(read_calls[0].path, metadata_path);
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_finalized" && op.1),
        "expected first-turn final identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_invalid_final_identity_metadata_reason() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    sandbox.push_read_file_result(Ok(Some(b"{not-json".to_vec())));
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
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(&ops, "session_history_identity_finalize_invalid_metadata");
    assert!(
        ops.iter()
            .all(|op| op.0 != "session_history_identity_finalized"),
        "invalid metadata should not record finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_large_final_identity_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    let (metadata_path, _) = final_identity_runtime_paths(&ctx);
    let metadata = serde_json::json!({
        "version": 1,
        "framework": "claude-code",
        "sessionIdHash": "a".repeat(64),
        "historyRefKind": "blob",
        "historyHash": "b".repeat(64),
        "historySizeBytes": LARGE_SESSION_HISTORY_SIZE_BYTES,
        "historyMarkerPayload": "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
    });
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&metadata).unwrap())));
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
    .await
    .unwrap();

    assert!(result.failure.is_none());
    let identity = result
        .restored_session_identity
        .as_ref()
        .expect("large final identity");
    assert_eq!(
        identity.history_size_bytes(),
        Some(LARGE_SESSION_HISTORY_SIZE_BYTES as u64)
    );
    assert_eq!(identity.final_metadata_path(), Some(metadata_path.as_str()));
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == "session_history_identity_finalized" && op.1),
        "large metadata should record finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_records_final_identity_metadata_read_failure_reason() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let ctx = minimal_context();
    sandbox.push_read_file_result(Err(sandbox_exec_error("vsock read failed")));
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
    .await
    .unwrap();

    assert!(result.failure.is_none());
    assert!(result.restored_session_identity.is_none());
    let ops = telemetry.pending_ops_snapshot();
    assert_successful_action(
        &ops,
        "session_history_identity_finalize_metadata_read_failed",
    );
    assert!(
        ops.iter()
            .all(|op| op.0 != "session_history_identity_finalized"),
        "metadata read failure should not record finalized identity telemetry, got: {ops:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_redacts_session_history_download_details_from_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let history = br#"{"type":"init"}"#;
    let expected_hash = hex::encode(Sha256::digest(b"different"));
    let actual_hash = hex::encode(Sha256::digest(history));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        cli_agent_session_id: "sess-ref-123".into(),
        history: ResumeSessionHistory::Ref {
            history_ref: ResumeSessionHistoryRef {
                kind: ResumeSessionHistoryRefKind::Blob,
                hash: expected_hash.clone(),
                url: serve_history_once(history).await,
                encoding: None,
                raw_size: history.len() as u64,
                encoded_size: history.len() as u64,
            },
        },
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
        Ok(_) => panic!("expected session history hash mismatch error"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("hash mismatch"));
    assert!(!error.to_string().contains(&expected_hash));
    assert!(!error.to_string().contains(&actual_hash));
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|op| {
            op.0 == "session_history_materialization_wait"
                && !op.1
                && op.2.as_deref() == Some("session history materialization failed")
        }),
        "expected redacted session history wait telemetry, got: {ops:?}"
    );
    assert_failed_action_error_once(
        &ops,
        "session_history_materializer_waited_at_restore",
        "session history materialization failed",
    );
    assert!(
        ops.iter().any(|op| {
            op.0 == "session_history_download"
                && !op.1
                && op.2.as_deref() == Some("session history download failed")
        }),
        "expected redacted session history download telemetry, got: {ops:?}"
    );
    assert_successful_action(&ops, "session_history_download_request_status");
    assert_successful_action(&ops, "session_history_download_body_read");
    assert_successful_action(&ops, "session_history_download_validation");
    assert_failed_action_error_once(
        &ops,
        "session_history_download_hash_verification",
        "session history download phase failed",
    );
    let telemetry_debug = format!("{ops:?}");
    assert!(!telemetry_debug.contains(&expected_hash));
    assert!(!telemetry_debug.contains(&actual_hash));
}

#[tokio::test]
async fn run_in_sandbox_folds_timezone_sync_into_restore_exec() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    let exec_calls = sandbox.exec_calls();
    let restore_calls = exec_calls
        .iter()
        .filter(|call| call.cmd.contains("guest-reseed"))
        .collect::<Vec<_>>();
    assert_eq!(
        restore_calls.len(),
        1,
        "restore should run once; calls: {exec_calls:?}"
    );
    let restore_command = &restore_calls[0].cmd;
    assert!(
        restore_command.contains("if test -f /usr/share/zoneinfo/Asia/Shanghai"),
        "restore should include timezone sync; command: {restore_command}"
    );
    assert!(
        restore_command.contains("guest timezone sync failed"),
        "timezone sync should remain best-effort; command: {restore_command}"
    );
    let standalone_timezone_calls = exec_calls
        .iter()
        .filter(|call| {
            call.cmd
                .starts_with("if test -f /usr/share/zoneinfo/Asia/Shanghai")
        })
        .collect::<Vec<_>>();
    assert!(
        standalone_timezone_calls.is_empty(),
        "restore path should not run a separate timezone exec; calls: {exec_calls:?}"
    );
    assert_eq!(
        exec_calls
            .iter()
            .filter(|call| call.cmd.contains("/usr/share/zoneinfo/Asia/Shanghai"))
            .count(),
        1,
        "timezone sync should appear in exactly one exec; calls: {exec_calls:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_runs_standalone_timezone_sync_without_restore_exec() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
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
    .await
    .unwrap();

    let exec_calls = sandbox.exec_calls();
    assert!(
        exec_calls.iter().any(|call| call
            .cmd
            .starts_with("if test -f /usr/share/zoneinfo/Asia/Shanghai")),
        "fresh path should keep standalone timezone sync; calls: {exec_calls:?}"
    );
    assert!(
        exec_calls
            .iter()
            .all(|call| !call.cmd.contains("guest-reseed")),
        "fresh path should not run guest state restore; calls: {exec_calls:?}"
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
async fn run_in_sandbox_sets_codex_app_server_backend_for_active_input_source() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let group_dir = dir.path().join("active-inputs");
    let source = ActiveInputSource::local_queue(group_dir, ctx.run_id);
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
            bytes_written: 14,
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
