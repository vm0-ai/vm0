use std::os::unix::fs::symlink;

use sandbox_mock::MockSandbox;

use super::super::super::diagnostics::{
    AgentStdoutStreamDiagnostics, GuestLogCopyFailureKind, copy_guest_logs,
    guest_log_copy_failure_kind,
};
use super::super::super::sandbox_run::post_job_cleanup;
use super::super::super::{
    GUEST_LOG_COPY_MAX_BYTES, STDOUT_STREAM_LIMIT_MARKER, STDOUT_STREAM_OVERFLOW_MARKER,
    guest_runtime_path,
};
use super::super::support::{minimal_context, sandbox_exec_error, test_executor_config};
use crate::paths::LogPaths;

#[test]
fn guest_log_copy_failure_kind_tracks_cancellation() {
    assert_eq!(
        guest_log_copy_failure_kind(false),
        GuestLogCopyFailureKind::Failed
    );
    assert_eq!(
        guest_log_copy_failure_kind(true),
        GuestLogCopyFailureKind::SkippedAfterCancellation
    );
}

#[tokio::test]
async fn copy_guest_logs_writes_files_to_host() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    let system_stream_log_path = log_paths.system_stream_log(ctx.run_id);
    tokio::fs::write(&system_stream_log_path, b"transient host-streamed stdout\n")
        .await
        .unwrap();

    // Queue guest-copy results: system log + metrics log + sandbox ops log.
    sandbox.push_copy_file_result(Ok(b"system log line 1\nsystem log line 2\n".to_vec()));
    sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));
    sandbox.push_copy_file_result(Ok(
        b"{\"action_type\":\"final_telemetry_upload\",\"duration_ms\":10,\"success\":true}\n"
            .to_vec(),
    ));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(system_log, "system log line 1\nsystem log line 2\n");
    let system_stream_log = tokio::fs::read_to_string(system_stream_log_path)
        .await
        .unwrap();
    assert_eq!(system_stream_log, "transient host-streamed stdout\n");

    let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(metrics_log, "{\"cpu\":0.5}\n");

    let sandbox_ops_log = tokio::fs::read_to_string(log_paths.sandbox_ops_log(ctx.run_id))
        .await
        .unwrap();
    assert!(sandbox_ops_log.contains("final_telemetry_upload"));

    let calls = sandbox.copy_file_calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls[2].path,
        guest_runtime_path(
            ctx.run_id,
            guest_contracts::runtime_paths::sandbox_ops_log_file
        )
        .unwrap()
    );
    assert_eq!(calls[2].host_path, log_paths.sandbox_ops_log(ctx.run_id));
    assert_eq!(calls[0].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    assert_eq!(calls[1].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    assert_eq!(calls[2].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
}

#[tokio::test]
async fn copy_guest_logs_skips_unsafe_destination_and_continues_other_logs() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let unsafe_target = dir.path().join("unsafe-target.log");
    symlink(&unsafe_target, log_paths.system_log(ctx.run_id)).unwrap();

    sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));
    sandbox.push_copy_file_result(Ok(b"{\"action_type\":\"cleanup\"}\n".to_vec()));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    assert!(!unsafe_target.exists());
    assert_eq!(
        tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
            .await
            .unwrap(),
        "{\"cpu\":0.5}\n"
    );
    assert_eq!(
        tokio::fs::read_to_string(log_paths.sandbox_ops_log(ctx.run_id))
            .await
            .unwrap(),
        "{\"action_type\":\"cleanup\"}\n"
    );

    let calls = sandbox.copy_file_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].host_path, log_paths.metrics_log(ctx.run_id));
    assert_eq!(calls[1].host_path, log_paths.sandbox_ops_log(ctx.run_id));
}

#[tokio::test]
async fn copy_guest_logs_keeps_existing_logs_when_sandbox_ops_missing() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    sandbox.push_copy_file_result(Ok(b"system log\n".to_vec()));
    sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(system_log, "system log\n");

    let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(metrics_log, "{\"cpu\":0.5}\n");
    assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());

    let calls = sandbox.copy_file_calls();
    assert_eq!(calls.len(), 3);
    assert!(
        calls[2].missing_ok,
        "missing sandbox ops log should be a best-effort no-op"
    );
}

#[tokio::test]
async fn copy_guest_logs_skips_on_nonzero_exit() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    // Copy fails (file doesn't exist in guest).
    sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    // Host files should not be created
    assert!(!log_paths.system_log(ctx.run_id).exists());
    assert!(!log_paths.metrics_log(ctx.run_id).exists());
    assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());
}

#[tokio::test]
async fn copy_guest_logs_skips_on_exec_error() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    assert!(!log_paths.system_log(ctx.run_id).exists());
    assert!(!log_paths.metrics_log(ctx.run_id).exists());
    assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());
}

#[tokio::test]
async fn post_job_cleanup_appends_stream_markers_after_guest_log_copy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let system_log_path = config.log_paths.system_log(ctx.run_id);
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    tokio::fs::write(&system_stream_log_path, b"transient host-streamed stdout\n")
        .await
        .unwrap();
    sandbox.push_copy_file_result(Ok(b"guest system log".to_vec()));

    post_job_cleanup(
        &sandbox,
        &config,
        &ctx,
        "10.0.0.1",
        false,
        AgentStdoutStreamDiagnostics {
            bytes_written: 0,
            chunk_truncated: true,
            stream_overflowed: true,
        },
    )
    .await
    .unwrap();

    let system_log = tokio::fs::read(&system_log_path).await.unwrap();
    assert_eq!(system_log, b"guest system log");
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected_stream_log = b"transient host-streamed stdout\n".to_vec();
    expected_stream_log.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected_stream_log.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
    assert_eq!(system_stream_log, expected_stream_log);
}
