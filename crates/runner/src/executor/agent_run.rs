use std::time::{Duration, Instant};

use agent_diagnostics::FailureDiagnostic;
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ProcessControlMode, ProcessOutputMode, Sandbox,
    StartProcessRequest,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::diagnostics::{
    AgentStdoutStreamDiagnostics, StdoutDrainReport, build_agent_env_diagnostics,
    build_agent_env_key_diagnostics, check_host_oom, collect_agent_abnormal_exit_diagnostics,
    dmesg_indicates_oom, drain_stdout_to_file, log_agent_abnormal_exit_env_diagnostics,
    log_agent_process_exit_summary, read_guest_error_file, read_guest_failure_diagnostic_file,
    should_collect_agent_abnormal_exit_diagnostics,
};
use super::env::{build_env_json, build_user_env_json, write_user_env_file};
use super::guest_state::{fix_guest_clock, reseed_guest_entropy, sync_guest_timezone};
use super::session_restore::restore_session;
use super::storage::{download_storages, filter_unchanged_storages};
use super::telemetry::record_api_latency;
use super::{
    EXIT_SIGKILL, EXIT_SIGNAL_KILL, ExecutionFailure, ExecutorConfig, JOB_TIMEOUT,
    PROCESS_CANCEL_TIMEOUTS, RunnerResult, SandboxReuseResult, USER_ENV_FILE_ENV_KEY,
    agent_exit_failure_message,
};
use crate::paths::guest;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, GuestDownloadManifest};

pub(super) struct ProcessCancelTimeouts {
    pub(super) write: Duration,
    pub(super) terminal_grace: Duration,
}

pub(super) struct AgentExecutionResult {
    pub(super) failure: Option<ExecutionFailure>,
    pub(super) stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
}

impl AgentExecutionResult {
    pub(super) fn success() -> Self {
        Self {
            failure: None,
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
        }
    }

    pub(super) fn failure(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        Self {
            failure: Some(ExecutionFailure::new(exit_code, error, diagnostic)),
            stdout_stream_diagnostics: AgentStdoutStreamDiagnostics::default(),
        }
    }

    pub(super) fn failure_from_error(error: impl Into<String>) -> Self {
        Self::failure(1, error, None)
    }

    pub(super) fn exit_code(&self) -> i32 {
        self.failure.as_ref().map_or(0, |failure| failure.exit_code)
    }

    pub(super) fn with_stdout_stream_diagnostics(
        mut self,
        diagnostics: AgentStdoutStreamDiagnostics,
    ) -> Self {
        self.stdout_stream_diagnostics = diagnostics;
        self
    }
}
pub(super) fn cancelled_agent_process_exit(
    pid: u32,
    stream_overflowed: bool,
) -> sandbox::ProcessExit {
    let mut exit = sandbox::ProcessExit::new(pid, EXIT_SIGKILL, Vec::new(), Vec::new());
    exit.stream_overflowed = stream_overflowed;
    exit
}

/// How this run is entering its sandbox. Each field feeds a distinct step:
/// `restore_guest_state` gates clock/entropy repair, `prev_storage` enables
/// the download-skip optimization on reuse, and `reuse_result` is forwarded
/// to the guest for /complete metadata.
pub(super) struct RunStart<'a> {
    pub(super) restore_guest_state: bool,
    pub(super) reuse_result: SandboxReuseResult,
    pub(super) prev_storage: Option<&'a crate::idle_pool::StorageFingerprints>,
}

pub(super) async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> RunnerResult<AgentExecutionResult> {
    run_in_sandbox_with_process_cancel_timeouts(
        sandbox,
        context,
        config,
        start,
        telemetry,
        cancel,
        PROCESS_CANCEL_TIMEOUTS,
    )
    .await
}

pub(super) async fn run_in_sandbox_with_process_cancel_timeouts(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> RunnerResult<AgentExecutionResult> {
    // 1. Fix guest clock and reseed entropy (must happen before HTTPS calls).
    //    Needed after snapshot restore (frozen clock) and after idle reuse (drifted clock).
    if start.restore_guest_state {
        fix_guest_clock(sandbox).await?;
        reseed_guest_entropy(sandbox).await?;
    }

    // 2. Set guest timezone from user preference (best-effort, never fails).
    sync_guest_timezone(sandbox, context).await;

    // 3. Download storages (skipping entries unchanged since the previous turn)
    if let Some(manifest) = &context.storage_manifest {
        let guest_manifest = GuestDownloadManifest::from(manifest);
        let mut effective: GuestDownloadManifest = match start.prev_storage {
            Some(prev) => filter_unchanged_storages(&guest_manifest, prev),
            None => guest_manifest,
        };
        // Short-circuit: skip the vsock exec if every entry was filtered out
        // and there are no paths to clean up.
        let has_work = effective.storages.iter().any(|s| s.archive_url.is_some())
            || effective.artifacts.iter().any(|a| a.archive_url.is_some())
            || !effective.cleanup_paths.is_empty();
        if !has_work {
            info!(run_id = %context.run_id, "all storages unchanged, skipping download");
        }
        let t = Instant::now();
        let result = if has_work {
            // Populate the runner-side cache first, rewriting eligible entries'
            // `archive_url` to `file:///tmp/vm0-storage-cache/...` so the guest
            // reads from its tmpfs instead of hitting R2 per turn.
            async {
                crate::storage_cache::populate_cache(
                    &mut effective,
                    sandbox,
                    &config.home,
                    telemetry,
                )
                .await?;
                download_storages(sandbox, context, &effective).await
            }
            .await
        } else {
            Ok(())
        };
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "storage_download",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 4. Restore session history
    if let Some(session) = &context.resume_session {
        let t = Instant::now();
        let result = restore_session(sandbox, context, session).await;
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "session_restore",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 5. Build env vars. The guest-agent bootstrap env is runner-owned only;
    // user-provided env is passed through a private guest file and injected
    // into the CLI child after guest-agent has started.
    let user_env_map = build_user_env_json(context);
    let user_env_file = write_user_env_file(sandbox, context.run_id, &user_env_map).await?;
    let mut env_map = build_env_json(context, &config.api_url, sandbox.id(), start.reuse_result)?;
    if let Some(path) = user_env_file {
        env_map.insert(USER_ENV_FILE_ENV_KEY.into(), path);
    }
    let env_diagnostics = build_agent_env_diagnostics(&env_map, &user_env_map);
    let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

    // 6. Spawn agent — stdout streamed to host via vsock, stderr merged into stdout.
    //    guest-agent owns the guest-side system log for telemetry; the runner
    //    separately writes streamed chunks to a host stream log in real time.
    let agent_cmd = format!("{} 2>&1", guest::RUN_AGENT);
    info!(run_id = %context.run_id, "spawning agent");

    // JOB_TIMEOUT configures both the guest-side process timeout and the
    // host-side wait watchdog. They remain separate protocol mechanisms.
    let t = Instant::now();
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: &agent_cmd,
            timeout: JOB_TIMEOUT,
            env: &env_refs,
            sudo: false,
            output: ProcessOutputMode::stream(),
            control: ProcessControlMode::Enabled,
        })
        .await;

    let mut handle = match handle {
        Ok(h) => h,
        Err(e) => {
            telemetry.record("agent_execute", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

    // Claude Code process has a PID now — record end-to-end startup latency.
    record_api_latency("api_to_spawn", context, telemetry);

    // Spawn background task to drain stdout chunks and write to the host stream log file.
    let host_log_path = config.log_paths.system_stream_log(context.run_id);
    let stream_task = handle
        .take_stdout_receiver()
        .map(|stdout_rx| tokio::spawn(drain_stdout_to_file(stdout_rx, host_log_path)));

    // 6. Wait for exit (or cancellation). On cancel, ask the guest to cancel the
    // supervised process and briefly wait for its terminal status so the vsock
    // operation can be removed before sandbox cleanup closes the connection.
    let process_pid = handle.pid;
    let process_cancel = handle.take_cancel_handle();
    let wait_process = sandbox.wait_process(handle, JOB_TIMEOUT);
    tokio::pin!(wait_process);
    let (result, wait_cancelled, abort_stdout_drain) = tokio::select! {
        biased;
        result = &mut wait_process => {
            let abort_stdout_drain = result.is_err();
            (result, false, abort_stdout_drain)
        }
        () = cancel.cancelled() => {
            info!(run_id = %context.run_id, "cancel received, cancelling guest process");
            let cancelled_exit = || -> sandbox::Result<sandbox::ProcessExit> {
                Ok(cancelled_agent_process_exit(process_pid, false))
            };
            match process_cancel {
                Some(process_cancel) => match process_cancel.cancel(process_cancel_timeouts.write).await {
                    Ok(()) => {
                        match tokio::time::timeout(
                            process_cancel_timeouts.terminal_grace,
                            &mut wait_process,
                        )
                        .await
                        {
                            Ok(Ok(exit)) => {
                                info!(
                                    run_id = %context.run_id,
                                    pid = process_pid,
                                    "cancelled guest process reached terminal status"
                                );
                                (
                                    Ok(cancelled_agent_process_exit(
                                        process_pid,
                                        exit.stream_overflowed,
                                    )),
                                    true,
                                    false,
                                )
                            }
                            Ok(Err(error)) => {
                                warn!(
                                    run_id = %context.run_id,
                                    pid = process_pid,
                                    error = %error,
                                    "guest process wait failed after cancellation"
                                );
                                (cancelled_exit(), true, true)
                            }
                            Err(_) => {
                                warn!(
                                    run_id = %context.run_id,
                                    pid = process_pid,
                                    timeout_ms = process_cancel_timeouts.terminal_grace.as_millis(),
                                    "timed out waiting for cancelled guest process"
                                );
                                (cancelled_exit(), true, true)
                            }
                        }
                    }
                    Err(error) => {
                        warn!(
                            run_id = %context.run_id,
                            pid = process_pid,
                            error = %error,
                            "failed to send guest process cancellation"
                        );
                        (cancelled_exit(), true, true)
                    }
                },
                None => {
                    warn!(
                        run_id = %context.run_id,
                        pid = process_pid,
                        "sandbox does not support guest process cancellation"
                    );
                    (cancelled_exit(), true, true)
                }
            }
        }
    };

    // Wait for streaming to finish (channel closes when process exits).
    // On cancel/timeout/crash the stream channel may not close — abort to
    // prevent blocking indefinitely on the drain task.
    let mut stdout_drain_report = StdoutDrainReport::default();
    if let Some(task) = stream_task {
        if abort_stdout_drain || result.is_err() {
            task.abort();
            let _ = task.await;
        } else {
            match task.await {
                Ok(Ok(report)) => {
                    stdout_drain_report = report;
                }
                Ok(Err(e)) => {
                    warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
                }
                Err(e) => {
                    warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
                }
            }
        }
    }
    let exit = match result {
        Ok(exit) => exit,
        Err(e) => {
            // Sandbox crashed — check host dmesg for cgroup OOM kill of the
            // firecracker process before propagating a generic error.
            if let Some(pid) = sandbox.process_pid()
                && check_host_oom(pid).await
            {
                warn!(run_id = %context.run_id, pid, "host OOM kill detected for firecracker");
                let error = "Firecracker VM killed by host OOM killer \
                             (cgroup memory limit exceeded)"
                    .to_string();
                telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
                return Ok(AgentExecutionResult::failure(1, error, None));
            }
            let error = e.to_string();
            telemetry.record("agent_execute", t.elapsed(), false, Some(&error));
            return Err(e.into());
        }
    };
    if exit.stream_overflowed {
        warn!(run_id = %context.run_id, "agent stdout stream overflowed before process exit");
    }
    let stdout_stream_diagnostics = AgentStdoutStreamDiagnostics {
        chunk_truncated: stdout_drain_report.chunk_truncated,
        stream_overflowed: exit.stream_overflowed,
    };
    if !exit.diagnostic.is_empty() {
        warn!(
            run_id = %context.run_id,
            diagnostic = %exit.diagnostic,
            "agent process reported diagnostic"
        );
    }

    info!(
        run_id = %context.run_id,
        exit_code = exit.exit_code,
        "agent exited"
    );
    log_agent_process_exit_summary(
        context.run_id,
        sandbox.id(),
        start.reuse_result,
        &exit,
        &env_diagnostics,
    );

    // Check for OOM kill when process was terminated by SIGKILL.
    // Skip when cancelled — the SIGKILL exit code is synthetic and dmesg
    // would run against a sandbox that hasn't been stopped yet.
    if !wait_cancelled && (exit.exit_code == EXIT_SIGKILL || exit.exit_code == EXIT_SIGNAL_KILL) {
        let dmesg_req = ExecRequest {
            cmd: "dmesg | tail -20 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        };
        match sandbox.exec(&dmesg_req).await {
            Ok(dmesg) if dmesg_indicates_oom(&String::from_utf8_lossy(&dmesg.stdout)) => {
                warn!(run_id = %context.run_id, "OOM kill detected via dmesg");
                // Return exit code 1 with descriptive message instead of raw 137,
                // so callers see a clear error rather than an opaque signal code.
                let error = "Agent process killed by OOM killer";
                telemetry.record("agent_execute", t.elapsed(), false, Some(error));
                return Ok(AgentExecutionResult::failure(1, error, None)
                    .with_stdout_stream_diagnostics(stdout_stream_diagnostics));
            }
            Err(e) => {
                warn!(run_id = %context.run_id, error = %e, "failed to exec dmesg for OOM check");
            }
            _ => {}
        }
    }

    let failure = if wait_cancelled {
        // Skip guest file reads — sandbox hasn't been stopped yet.
        Some(ExecutionFailure::cancelled())
    } else if exit.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&exit.stderr).to_string();
        let failure_diagnostic = read_guest_failure_diagnostic_file(sandbox, context.run_id).await;
        let guest_error = if stderr.is_empty() {
            read_guest_error_file(sandbox, context.run_id).await
        } else {
            None
        };
        if should_collect_agent_abnormal_exit_diagnostics(
            wait_cancelled,
            &exit,
            &stderr,
            failure_diagnostic.as_ref(),
            guest_error.as_deref(),
        ) {
            let env_key_diagnostics = build_agent_env_key_diagnostics(&env_pairs);
            log_agent_abnormal_exit_env_diagnostics(
                context.run_id,
                sandbox.id(),
                start.reuse_result,
                &exit,
                &env_diagnostics,
                &env_key_diagnostics,
            );
            collect_agent_abnormal_exit_diagnostics(
                sandbox,
                context.run_id,
                sandbox.id(),
                start.reuse_result,
                exit.exit_code,
            )
            .await;
        }
        let error = if !stderr.is_empty() {
            stderr
        } else {
            // Stderr is empty (redirected to log file). Check for a structured
            // error file written by the guest-agent for final failure
            // handoff.
            guest_error.unwrap_or_else(|| agent_exit_failure_message(exit.exit_code))
        };
        Some(ExecutionFailure::new(
            exit.exit_code,
            error,
            failure_diagnostic,
        ))
    } else {
        None
    };

    let agent_result = match failure {
        Some(failure) => AgentExecutionResult {
            failure: Some(failure),
            stdout_stream_diagnostics,
        },
        None => AgentExecutionResult::success()
            .with_stdout_stream_diagnostics(stdout_stream_diagnostics),
    };
    telemetry.record(
        "agent_execute",
        t.elapsed(),
        agent_result.failure.is_none(),
        agent_result
            .failure
            .as_ref()
            .map(|failure| failure.error.as_str()),
    );
    Ok(agent_result)
}
