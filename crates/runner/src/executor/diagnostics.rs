use std::collections::HashMap;
use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_diagnostics::{FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FailureDiagnostic};
use sandbox::{
    CopyFileOptions, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ProcessOutputReceiver, Sandbox,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tracing::{info, warn};

use super::env::RUNNER_OWNED_ENV_KEYS;
use super::{
    AGENT_ABNORMAL_EXIT_DIAGNOSTIC_SCRIPT, AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT,
    AGENT_ENV_KEY_DIAGNOSTIC_LIMIT, AGENT_ENV_KEY_MAX_CHARS, BOOTSTRAP_SENSITIVE_ENV_KEYS,
    DEFAULT_EXEC_TIMEOUT, GUEST_LOG_COPY_MAX_BYTES, SMALL_GUEST_FILE_MAX_BYTES,
    STDOUT_STREAM_LIMIT_MARKER, STDOUT_STREAM_OVERFLOW_MARKER, SandboxReuseResult,
    guest_runtime_path,
};
use crate::ids::RunId;
use crate::paths::LogPaths;
use crate::types::ExecutionContext;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct AgentStdoutStreamDiagnostics {
    pub(super) chunk_truncated: bool,
    pub(super) stream_overflowed: bool,
}

impl AgentStdoutStreamDiagnostics {
    pub(super) fn is_empty(self) -> bool {
        !self.chunk_truncated && !self.stream_overflowed
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AgentEnvDiagnostics {
    pub(super) env_count: usize,
    pub(super) runner_owned_count: usize,
    pub(super) external_count: usize,
    pub(super) suspicious_keys: Vec<String>,
}

impl AgentEnvDiagnostics {
    pub(super) fn suspicious_keys_csv(&self) -> String {
        self.suspicious_keys.join(",")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AgentEnvKeyDiagnostics {
    pub(super) logged_keys: Vec<String>,
    pub(super) omitted_key_count: usize,
}

impl AgentEnvKeyDiagnostics {
    pub(super) fn logged_keys_csv(&self) -> String {
        self.logged_keys.join(",")
    }
}

pub(super) fn build_agent_env_diagnostics(
    env: &HashMap<String, String>,
    user_env: &HashMap<String, String>,
) -> AgentEnvDiagnostics {
    let mut suspicious_keys: Vec<String> = BOOTSTRAP_SENSITIVE_ENV_KEYS
        .iter()
        .copied()
        .filter(|key| user_env.contains_key(*key))
        .map(sanitize_env_key_for_diagnostic)
        .collect();
    suspicious_keys.sort();

    let runner_owned_count = env
        .keys()
        .filter(|key| is_runner_owned_env_key(key))
        .count();

    AgentEnvDiagnostics {
        env_count: env.len(),
        runner_owned_count,
        external_count: env.len().saturating_sub(runner_owned_count),
        suspicious_keys,
    }
}

pub(super) fn build_agent_env_key_diagnostics(env: &[(String, String)]) -> AgentEnvKeyDiagnostics {
    let mut keys: Vec<String> = env
        .iter()
        .map(|(key, _)| sanitize_env_key_for_diagnostic(key))
        .collect();
    keys.sort();

    let logged_keys: Vec<String> = keys
        .iter()
        .take(AGENT_ENV_KEY_DIAGNOSTIC_LIMIT)
        .cloned()
        .collect();
    let omitted_key_count = keys.len().saturating_sub(logged_keys.len());

    AgentEnvKeyDiagnostics {
        logged_keys,
        omitted_key_count,
    }
}

pub(super) fn sanitize_env_key_for_diagnostic(key: &str) -> String {
    let mut chars = key.escape_debug();
    let mut truncated = String::new();
    for _ in 0..AGENT_ENV_KEY_MAX_CHARS {
        let Some(ch) = chars.next() else {
            return truncated;
        };
        truncated.push(ch);
    }
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}

pub(super) fn is_runner_owned_env_key(key: &str) -> bool {
    key.starts_with("VM0_") || RUNNER_OWNED_ENV_KEYS.contains(&key)
}

pub(super) fn should_collect_agent_abnormal_exit_diagnostics(
    wait_cancelled: bool,
    exit: &sandbox::ProcessExit,
    stderr: &str,
    failure_diagnostic: Option<&FailureDiagnostic>,
    guest_error: Option<&str>,
) -> bool {
    !wait_cancelled
        && exit.exit_code != 0
        && exit.diagnostic.is_empty()
        && stderr.is_empty()
        && failure_diagnostic.is_none()
        && guest_error.is_none()
}

pub(super) fn log_agent_process_exit_summary(
    run_id: RunId,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    exit: &sandbox::ProcessExit,
    env_diagnostics: &AgentEnvDiagnostics,
) {
    info!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        sandbox_reuse_result = reuse_result.as_wire(),
        exit_code = exit.exit_code,
        stdout_len = exit.stdout.len(),
        stderr_len = exit.stderr.len(),
        stdout_truncated = exit.stdout_truncated,
        stderr_truncated = exit.stderr_truncated,
        diagnostic_present = !exit.diagnostic.is_empty(),
        stream_overflowed = exit.stream_overflowed,
        env_count = env_diagnostics.env_count,
        suspicious_env_keys = %env_diagnostics.suspicious_keys_csv(),
        "agent process exit summary"
    );
}

pub(super) fn log_agent_abnormal_exit_env_diagnostics(
    run_id: RunId,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    exit: &sandbox::ProcessExit,
    env_diagnostics: &AgentEnvDiagnostics,
    env_key_diagnostics: &AgentEnvKeyDiagnostics,
) {
    warn!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        sandbox_reuse_result = reuse_result.as_wire(),
        exit_code = exit.exit_code,
        env_count = env_diagnostics.env_count,
        runner_owned_env_count = env_diagnostics.runner_owned_count,
        external_env_count = env_diagnostics.external_count,
        suspicious_env_keys = %env_diagnostics.suspicious_keys_csv(),
        env_keys = %env_key_diagnostics.logged_keys_csv(),
        omitted_env_key_count = env_key_diagnostics.omitted_key_count,
        "agent abnormal exit env diagnostics"
    );
}

pub(super) async fn collect_agent_abnormal_exit_diagnostics(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    exit_code: i32,
) {
    let request = ExecRequest {
        cmd: AGENT_ABNORMAL_EXIT_DIAGNOSTIC_SCRIPT,
        timeout: AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT,
        env: &[],
        sudo: true,
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
    };

    match sandbox.exec(&request).await {
        Ok(result) => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                sandbox_reuse_result = reuse_result.as_wire(),
                exit_code,
                diagnostic_exit_code = result.exit_code,
                diagnostic_stdout_len = result.stdout.len(),
                diagnostic_stderr_len = result.stderr.len(),
                diagnostic_stdout_truncated = result.stdout_truncated,
                diagnostic_stderr_truncated = result.stderr_truncated,
                diagnostic_stdout = %stdout,
                diagnostic_stderr = %stderr,
                "agent abnormal exit in-vm diagnostics"
            );
        }
        Err(error) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                sandbox_reuse_result = reuse_result.as_wire(),
                exit_code,
                error = %error,
                "failed to collect agent abnormal exit in-vm diagnostics"
            );
        }
    }
}
pub(super) async fn read_guest_error_file(sandbox: &dyn Sandbox, run_id: RunId) -> Option<String> {
    let error_path = match guest_runtime_path(run_id, guest_runtime_paths::checkpoint_error_file) {
        Ok(path) => path,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest error file path");
            return None;
        }
    };
    match sandbox
        .read_file(&error_path, SMALL_GUEST_FILE_MAX_BYTES)
        .await
    {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            let msg = String::from_utf8_lossy(&bytes).trim().to_string();
            Some(msg).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Read structured guest failure diagnostics from the guest filesystem.
///
/// Diagnostics are optional and best-effort. They must never change the
/// user-visible completion error or mask the original exit status.
pub(super) async fn read_guest_failure_diagnostic_file(
    sandbox: &dyn Sandbox,
    run_id: RunId,
) -> Option<FailureDiagnostic> {
    let path = match guest_runtime_path(run_id, guest_runtime_paths::failure_diagnostic_file) {
        Ok(path) => path,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest failure diagnostic path");
            return None;
        }
    };
    match sandbox.read_file(&path, SMALL_GUEST_FILE_MAX_BYTES).await {
        Ok(Some(bytes)) if !bytes.iter().all(|byte| byte.is_ascii_whitespace()) => {
            match serde_json::from_slice::<FailureDiagnostic>(&bytes) {
                Ok(diagnostic)
                    if diagnostic.schema_version == FAILURE_DIAGNOSTIC_SCHEMA_VERSION =>
                {
                    Some(diagnostic)
                }
                Ok(diagnostic) => {
                    warn!(
                        run_id = %run_id,
                        schema_version = diagnostic.schema_version,
                        "ignoring guest failure diagnostic with unsupported schema version"
                    );
                    None
                }
                Err(e) => {
                    warn!(run_id = %run_id, error = %e, "failed to parse guest failure diagnostic");
                    None
                }
            }
        }
        Ok(_) => None,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to read guest failure diagnostic");
            None
        }
    }
}

/// Read the CLI-generated session ID from the guest filesystem.
///
/// The guest-agent writes the session ID to the guest runtime directory
/// after the CLI emits its `system/init` event. On first runs (no
/// `resume_session`), the runner uses this to park the VM for keep-alive.
pub(super) async fn read_guest_session_id(sandbox: &dyn Sandbox, run_id: RunId) -> Option<String> {
    let path = match guest_runtime_path(run_id, guest_runtime_paths::session_id_file) {
        Ok(path) => path,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest session id path");
            return None;
        }
    };
    match sandbox.read_file(&path, SMALL_GUEST_FILE_MAX_BYTES).await {
        Ok(Some(bytes)) if !bytes.is_empty() => {
            let id = String::from_utf8_lossy(&bytes).trim().to_string();
            Some(id).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Returns true if dmesg output indicates an OOM kill.
pub(super) fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Check host dmesg for a cgroup OOM kill of a specific firecracker process.
/// Reads the entire ring buffer (~512KB) directly — no shell wrapper needed
/// since the pure function handles filtering.  Times out after 5s to avoid
/// blocking if sudo hangs.
pub(super) async fn check_host_oom(pid: u32) -> bool {
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::process::Command::new("dmesg").output().await
    })
    .await;
    match result {
        Ok(Ok(out)) if out.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&out.stdout), pid)
        }
        Ok(Ok(out)) => {
            warn!(pid, exit_code = out.status.code(), "dmesg failed");
            false
        }
        Ok(Err(e)) => {
            warn!(pid, error = %e, "failed to run dmesg for OOM check");
            false
        }
        Err(_) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
    }
}

/// Returns true if host dmesg output contains an OOM kill record for the
/// given firecracker PID.  Checks that the character after the PID is not
/// a digit to avoid prefix matches (e.g. pid=1234 must not match pid=12345).
pub(super) fn host_dmesg_indicates_oom(dmesg: &str, pid: u32) -> bool {
    if !dmesg.contains("oom-kill") {
        return false;
    }
    let needle = format!("task=firecracker,pid={pid}");
    let mut start = 0;
    while let Some(pos) = dmesg[start..].find(&needle) {
        let abs = start + pos + needle.len();
        // Accept if needle is at end of string or next char is not a digit.
        match dmesg.as_bytes().get(abs) {
            Some(c) if c.is_ascii_digit() => {
                // Prefix match (e.g. pid=1234 inside pid=12345) — keep searching.
                start = abs;
            }
            _ => return true,
        }
    }
    false
}

#[derive(Debug, thiserror::Error)]
pub(super) enum StdoutDrainError {
    #[error("failed to open host log file {path}: {source}")]
    Open { path: PathBuf, source: io::Error },
    #[error("failed to write stdout chunk to host log {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("failed to flush stdout log {path}: {source}")]
    Flush { path: PathBuf, source: io::Error },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct StdoutDrainReport {
    pub(super) chunk_truncated: bool,
}

/// Drain stdout chunks from the process receiver and write them to a host file.
pub(super) async fn drain_stdout_to_file(
    mut rx: ProcessOutputReceiver,
    path: PathBuf,
) -> Result<StdoutDrainReport, StdoutDrainError> {
    let file = crate::log_file::open_append(&path, false).map(tokio::fs::File::from_std);
    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            return Err(StdoutDrainError::Open { path, source: e });
        }
    };
    let mut report = StdoutDrainReport::default();
    while let Some(chunk) = rx.recv().await {
        if chunk.truncated {
            report.chunk_truncated = true;
            warn!(path = %path.display(), "stdout stream chunk was truncated before host log write");
        }
        if let Err(e) = file.write_all(&chunk.bytes).await {
            return Err(StdoutDrainError::Write { path, source: e });
        }
    }
    // Flush to ensure the last blocking write completes before we return.
    // tokio::fs::File::poll_write returns Ready before the blocking write finishes,
    // so without flush the caller may observe incomplete file contents.
    if let Err(e) = file.flush().await {
        return Err(StdoutDrainError::Flush { path, source: e });
    }
    Ok(report)
}

pub(super) async fn append_stdout_stream_diagnostics_to_stream_log(
    run_id: RunId,
    path: &Path,
    diagnostics: AgentStdoutStreamDiagnostics,
) {
    if diagnostics.is_empty() {
        return;
    }

    if let Err(e) = append_stdout_stream_diagnostics(path, diagnostics).await {
        warn!(
            run_id = %run_id,
            path = %path.display(),
            error = %e,
            "failed to append stdout stream diagnostic marker to host stream log"
        );
    }
}

pub(super) async fn append_stdout_stream_diagnostics(
    path: &Path,
    diagnostics: AgentStdoutStreamDiagnostics,
) -> io::Result<()> {
    if diagnostics.is_empty() {
        return Ok(());
    }

    let mut file = tokio::fs::File::from_std(crate::log_file::open_append(path, true)?);

    if file.metadata().await?.len() > 0 {
        file.seek(SeekFrom::End(-1)).await?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last).await?;
        if last[0] != b'\n' {
            file.write_all(b"\n").await?;
        }
    }
    if diagnostics.chunk_truncated {
        file.write_all(STDOUT_STREAM_LIMIT_MARKER).await?;
    }
    if diagnostics.stream_overflowed {
        file.write_all(STDOUT_STREAM_OVERFLOW_MARKER).await?;
    }
    file.flush().await
}

/// Copy guest log files to host (best-effort, post-job).
///
/// The final system log copy keeps `system-*` as the guest-authored log. The
/// supervised process stdout/stderr stream is written separately to
/// `system-stream-*` in real time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GuestLogCopyFailureKind {
    Failed,
    SkippedAfterCancellation,
}

pub(super) fn guest_log_copy_failure_kind(cancelled: bool) -> GuestLogCopyFailureKind {
    if cancelled {
        GuestLogCopyFailureKind::SkippedAfterCancellation
    } else {
        GuestLogCopyFailureKind::Failed
    }
}

pub(super) async fn copy_guest_logs(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    log_paths: &LogPaths,
    cancelled: bool,
) {
    let run_id = context.run_id;
    let files = match [
        guest_runtime_path(run_id, guest_runtime_paths::system_log_file)
            .map(|path| (path, log_paths.system_log(run_id))),
        guest_runtime_path(run_id, guest_runtime_paths::metrics_log_file)
            .map(|path| (path, log_paths.metrics_log(run_id))),
        guest_runtime_path(run_id, guest_runtime_paths::sandbox_ops_log_file)
            .map(|path| (path, log_paths.sandbox_ops_log(run_id))),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    {
        Ok(files) => files,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest log paths");
            return;
        }
    };

    for (guest_path, host_path) in &files {
        if let Err(e) = crate::log_file::validate_copy_destination(host_path) {
            warn!(
                run_id = %run_id,
                error = %e,
                guest_path = %guest_path,
                host_path = %host_path.display(),
                "skipping unsafe guest log destination"
            );
            continue;
        }

        if let Err(e) = sandbox
            .copy_file(
                guest_path,
                host_path,
                CopyFileOptions {
                    max_bytes: GUEST_LOG_COPY_MAX_BYTES,
                    timeout: DEFAULT_EXEC_TIMEOUT,
                    missing_ok: true,
                },
            )
            .await
        {
            match guest_log_copy_failure_kind(cancelled) {
                GuestLogCopyFailureKind::SkippedAfterCancellation => {
                    info!(run_id = %run_id, error = %e, guest_path = %guest_path, host_path = %host_path.display(), "guest log copy skipped after cancellation");
                }
                GuestLogCopyFailureKind::Failed => {
                    warn!(run_id = %run_id, error = %e, guest_path = %guest_path, host_path = %host_path.display(), "failed to copy guest log");
                }
            }
        }
    }
}
