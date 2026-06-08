use std::collections::HashMap;
use std::path::PathBuf;

use agent_diagnostics::{FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FailureDiagnostic};
use sandbox::ProcessOutputChunk;
use sandbox_mock::MockSandbox;

use super::super::diagnostics::{
    AgentStdoutStreamDiagnostics, GuestLogCopyFailureKind, StdoutDrainError,
    append_stdout_stream_diagnostics, build_agent_env_diagnostics, build_agent_env_key_diagnostics,
    copy_guest_logs, dmesg_indicates_oom, drain_stdout_to_file, guest_log_copy_failure_kind,
    host_dmesg_indicates_oom, read_guest_error_file, read_guest_failure_diagnostic_file,
    read_guest_session_id,
};
use super::super::sandbox_run::post_job_cleanup;
use super::super::{
    AGENT_ENV_KEY_DIAGNOSTIC_LIMIT, AGENT_ENV_KEY_MAX_CHARS, GUEST_LOG_COPY_MAX_BYTES,
    SMALL_GUEST_FILE_MAX_BYTES, STDOUT_STREAM_LIMIT_MARKER, STDOUT_STREAM_OVERFLOW_MARKER,
    guest_runtime_path,
};
use super::support::{minimal_context, sandbox_exec_error, test_executor_config};
use crate::ids::RunId;
use crate::paths::LogPaths;

#[test]
fn agent_env_diagnostics_sort_bounds_and_never_include_values() {
    let mut bootstrap_env = HashMap::from([
        ("BASH_ENV".to_string(), "super-secret-bash-env".to_string()),
        ("NORMAL_KEY".to_string(), "normal-secret-value".to_string()),
        ("VM0_RUN_ID".to_string(), "runner-secret-value".to_string()),
        (
            "VM0_SECRET_VALUES".to_string(),
            "stored-secret-value".to_string(),
        ),
    ]);
    for index in 0..AGENT_ENV_KEY_DIAGNOSTIC_LIMIT {
        bootstrap_env.insert(format!("ZZZ_{index:03}"), format!("value-{index}"));
    }
    bootstrap_env.insert(
        format!("AAA_{}", "x".repeat(AGENT_ENV_KEY_MAX_CHARS * 4)),
        "long-secret-value".to_string(),
    );
    let user_env = HashMap::from([("BASH_ENV".to_string(), "user-secret-bash-env".to_string())]);

    let diagnostics = build_agent_env_diagnostics(&bootstrap_env, &user_env);

    assert_eq!(diagnostics.env_count, AGENT_ENV_KEY_DIAGNOSTIC_LIMIT + 5);
    assert_eq!(diagnostics.runner_owned_count, 2);
    assert_eq!(
        diagnostics.external_count,
        AGENT_ENV_KEY_DIAGNOSTIC_LIMIT + 3
    );
    assert_eq!(diagnostics.suspicious_keys, vec!["BASH_ENV".to_string()]);
    let env_pairs: Vec<(String, String)> = bootstrap_env.into_iter().collect();
    let key_diagnostics = build_agent_env_key_diagnostics(&env_pairs);
    assert_eq!(
        key_diagnostics.logged_keys.len(),
        AGENT_ENV_KEY_DIAGNOSTIC_LIMIT
    );
    assert_eq!(key_diagnostics.omitted_key_count, 5);
    let mut sorted_logged_keys = key_diagnostics.logged_keys.clone();
    sorted_logged_keys.sort();
    assert_eq!(key_diagnostics.logged_keys, sorted_logged_keys);
    let long_key = key_diagnostics
        .logged_keys
        .iter()
        .find(|key| key.starts_with("AAA_"))
        .expect("long key should be logged before the ZZZ keys");
    assert_eq!(long_key.chars().count(), AGENT_ENV_KEY_MAX_CHARS + 3);
    assert!(long_key.ends_with("..."));
    let rendered = format!(
        "{} {}",
        diagnostics.suspicious_keys_csv(),
        key_diagnostics.logged_keys_csv()
    );
    assert!(rendered.contains("BASH_ENV"));
    assert!(rendered.contains("VM0_RUN_ID"));
    assert!(!rendered.contains("super-secret-bash-env"));
    assert!(!rendered.contains("user-secret-bash-env"));
    assert!(!rendered.contains("normal-secret-value"));
    assert!(!rendered.contains("runner-secret-value"));
    assert!(!rendered.contains("stored-secret-value"));
    assert!(!rendered.contains("long-secret-value"));
}

#[test]
fn dmesg_oom_positive() {
    assert!(dmesg_indicates_oom(
        "[  12.345] Out of memory: Killed process 1234 (claude)"
    ));
    assert!(dmesg_indicates_oom("oom-kill:constraint=CONSTRAINT_MEMCG"));
    assert!(dmesg_indicates_oom("oom_reaper: reaped process 42"));
}

#[test]
fn dmesg_oom_negative() {
    assert!(!dmesg_indicates_oom(""));
    // "Killed process" alone (without OOM context) should NOT match
    assert!(!dmesg_indicates_oom("Killed process 42 (node)"));
    assert!(!dmesg_indicates_oom("normal kernel log output"));
    assert!(!dmesg_indicates_oom("[  1.000] eth0: link up"));
    assert!(!dmesg_indicates_oom("task killed by signal 15"));
    // substring "oom" in unrelated words should not match
    assert!(!dmesg_indicates_oom("the room is full"));
}

#[test]
fn dmesg_oom_case_insensitive() {
    assert!(dmesg_indicates_oom("Out Of Memory: killed process 99"));
    assert!(!dmesg_indicates_oom("Killed process 99 (agent)"));
    assert!(dmesg_indicates_oom("OOM-kill: constraint=MEMCG"));
}

/// Real `sudo dmesg | grep 'oom-kill'` output captured from prod-3.
const PROD3_OOM_GREP: &str = "\
        [1718300.650867] fc_vcpu 0 invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0\n\
        [1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=vm0-runner-v0.45.6.service,mems_allowed=0,oom_memcg=/system.slice/vm0-runner-v0.45.6.service,task_memcg=/system.slice/vm0-runner-v0.45.6.service,task=firecracker,pid=586629,uid=1000";

#[test]
fn host_oom_matches_real_prod3_output() {
    assert!(host_dmesg_indicates_oom(PROD3_OOM_GREP, 586629));
}

#[test]
fn host_oom_no_match_different_pid() {
    assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 12345));
}

#[test]
fn host_oom_no_match_different_process() {
    // Same structure as prod-3 but task=node instead of task=firecracker
    let dmesg = "[1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,\
            task=node,pid=586629,uid=1000";
    assert!(!host_dmesg_indicates_oom(dmesg, 586629));
}

#[test]
fn host_oom_no_match_empty() {
    assert!(!host_dmesg_indicates_oom("", 12345));
}

#[test]
fn host_oom_no_match_without_oom_kill() {
    // Has the PID pattern but no oom-kill keyword
    let dmesg = "[1718300.651117] task=firecracker,pid=12345,uid=1000 started";
    assert!(!host_dmesg_indicates_oom(dmesg, 12345));
}

#[test]
fn host_oom_no_prefix_match() {
    // pid=58662 must NOT match pid=586629
    assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 58662));
}

#[test]
fn host_oom_pid_at_end_of_line() {
    // PID at end of string (no trailing comma) — edge case
    let dmesg = "[0.0] oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";
    assert!(host_dmesg_indicates_oom(dmesg, 42));
    assert!(!host_dmesg_indicates_oom(dmesg, 4));
}

#[tokio::test]
async fn read_guest_error_file_returns_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"checkpoint error: disk full".to_vec())));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert_eq!(msg.as_deref(), Some("checkpoint error: disk full"));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(RunId::nil(), guest_runtime_paths::checkpoint_error_file).unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_missing_file() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(None));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_empty_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"   \n  ".to_vec())));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Err(sandbox_exec_error("vsock timeout")));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_session_id_returns_trimmed_content_from_runtime_path() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" session-abc \n".to_vec())));

    let session_id = read_guest_session_id(&sandbox, RunId::nil()).await;

    assert_eq!(session_id.as_deref(), Some("session-abc"));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(RunId::nil(), guest_runtime_paths::session_id_file).unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_session_id_returns_none_on_missing_or_empty_file() {
    let missing = MockSandbox::new("test");
    missing.push_read_file_result(Ok(None));
    assert!(
        read_guest_session_id(&missing, RunId::nil())
            .await
            .is_none()
    );

    let empty = MockSandbox::new("test");
    empty.push_read_file_result(Ok(Some(b" \n ".to_vec())));
    assert!(read_guest_session_id(&empty, RunId::nil()).await.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_valid_diagnostic() {
    let sandbox = MockSandbox::new("test");
    let diagnostic = FailureDiagnostic::new(
        agent_diagnostics::FailureClass::CliNonzero,
        agent_diagnostics::AgentFramework::ClaudeCode,
        agent_diagnostics::PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(agent_diagnostics::FailureDetailSource::ClaudeResult)
    .with_session_history_status(agent_diagnostics::SessionHistoryStatus::Present);
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

    let read = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert_eq!(read, Some(diagnostic));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(RunId::nil(), guest_runtime_paths::failure_diagnostic_file).unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_missing_file() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(None));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_empty_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" \n\t".to_vec())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_malformed_json() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"{not-json".to_vec())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_unsupported_schema() {
    let sandbox = MockSandbox::new("test");
    let mut diagnostic = FailureDiagnostic::new(
        agent_diagnostics::FailureClass::CliNonzero,
        agent_diagnostics::AgentFramework::ClaudeCode,
        agent_diagnostics::PromptMetadata::from_prompt("/help"),
    );
    diagnostic.schema_version = FAILURE_DIAGNOSTIC_SCHEMA_VERSION + 1;
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_read_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Err(sandbox_exec_error("vsock timeout")));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_oversized_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(vec![
        b' ';
        SMALL_GUEST_FILE_MAX_BYTES as usize + 1
    ])));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

// -----------------------------------------------------------------------
// copy_guest_logs tests
// -----------------------------------------------------------------------

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
        guest_runtime_path(ctx.run_id, guest_runtime_paths::sandbox_ops_log_file).unwrap()
    );
    assert_eq!(calls[2].host_path, log_paths.sandbox_ops_log(ctx.run_id));
    assert_eq!(calls[0].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    assert_eq!(calls[1].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    assert_eq!(calls[2].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
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

// -----------------------------------------------------------------------
// drain_stdout_to_file tests
// -----------------------------------------------------------------------

#[tokio::test]
async fn drain_stdout_writes_chunks_to_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tx.send(ProcessOutputChunk {
        bytes: b"chunk 1\n".to_vec(),
        truncated: false,
    })
    .await
    .unwrap();
    tx.send(ProcessOutputChunk {
        bytes: b"chunk 2\n".to_vec(),
        truncated: false,
    })
    .await
    .unwrap();
    drop(tx); // close channel

    let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(content, "chunk 1\nchunk 2\n");
    assert!(!report.chunk_truncated);
}

#[tokio::test]
async fn drain_stdout_reports_truncated_chunk_without_changing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tx.send(ProcessOutputChunk {
        bytes: b"partial chunk".to_vec(),
        truncated: true,
    })
    .await
    .unwrap();
    drop(tx);

    let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

    let content = tokio::fs::read(&path).await.unwrap();
    assert_eq!(content, b"partial chunk");
    assert!(report.chunk_truncated);
}

#[tokio::test]
async fn drain_stdout_empty_channel() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.log");

    let (_tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
    drop(_tx);

    let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert!(content.is_empty());
    assert!(!report.chunk_truncated);
}

#[tokio::test]
async fn drain_stdout_invalid_path_returns_error() {
    let (_tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
    drop(_tx);
    let error = drain_stdout_to_file(rx, PathBuf::from("/dev/null/impossible/file"))
        .await
        .unwrap_err();
    assert!(matches!(error, StdoutDrainError::Open { .. }));
}

#[tokio::test]
async fn append_stdout_stream_diagnostics_noops_when_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    append_stdout_stream_diagnostics(&path, AgentStdoutStreamDiagnostics::default())
        .await
        .unwrap();

    assert!(!path.exists());
}

#[tokio::test]
async fn append_stdout_stream_diagnostics_writes_markers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");
    tokio::fs::write(&path, b"guest system log without newline")
        .await
        .unwrap();

    append_stdout_stream_diagnostics(
        &path,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: true,
        },
    )
    .await
    .unwrap();

    let content = tokio::fs::read(&path).await.unwrap();
    let mut expected = b"guest system log without newline\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
    assert_eq!(content, expected);
}
