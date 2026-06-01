//! Public facade for CLI setup and execution.
//!
//! This module keeps the external `guest_agent::cli` boundary stable while
//! private submodules own focused execution policies:
//!
//! - `codex_setup`: pre-exec Codex auth/bootstrap.
//! - `command`: Claude Code and Codex command construction.
//! - `diagnostics`: bounded stderr tail collection.
//! - `event_delivery`: event sender watermark state.
//! - `framework`: Claude-vs-Codex behavior switches.
//! - `termination`: process-group termination FSM.
//!
//! `execute_cli` intentionally remains the orchestration owner for process
//! spawn, stdout JSONL reading, event sender shutdown, heartbeat races, and
//! child reaping. Branch ordering and deadline reset timing in that control
//! flow are part of the runtime contract.

mod codex_setup;
mod command;
mod diagnostics;
mod event_delivery;
mod framework;
mod termination;

pub use codex_setup::setup_codex;
pub use command::build_cli_command;
pub use framework::ClaudeResultSummary;

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use crate::timing;
use agent_diagnostics::{FailureDetailSource, FailureReason};
use event_delivery::{AckedEventPrefix, PreparedEvent};
use framework::CliFrameworkBehavior;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};
use termination::{TerminationReason, TerminationState};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const LOG_TAG: &str = "sandbox:guest-agent";

async fn tick_optional_interval(interval: &mut Option<tokio::time::Interval>) {
    match interval {
        Some(interval) => {
            interval.tick().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// Bounded terminal failure detail extracted from CLI stdout JSONL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliFailureDiagnostic {
    pub message: String,
    pub source: FailureDetailSource,
    pub failure_reason: Option<FailureReason>,
}

/// Result returned after the configured CLI process exits.
///
/// The guest agent uses this summary to report final run status and to persist
/// the event-drain watermark consumed by host/API clients.
#[derive(Debug, Clone)]
pub struct CliExecutionResult {
    /// Process exit code for the CLI.
    ///
    /// On Unix, signal termination is mapped to `128 + signal`, matching shell
    /// convention, so SIGKILL is reported as `137`.
    pub exit_code: i32,

    /// Best-effort, secret-masked stderr tail captured from the CLI.
    ///
    /// The guest agent keeps at most the last 200 stderr lines for failure
    /// diagnostics. Stderr lines longer than 16 KiB after CRLF normalization,
    /// or after lossy UTF-8 decoding, are replaced with an omission marker
    /// rather than partially returned, so secret masking never has to process a
    /// truncated secret. Invalid UTF-8 is decoded lossily into a valid string
    /// when the decoded diagnostic still fits the limit. It may be empty if the
    /// CLI wrote no stderr or stderr draining timed out after process exit, and
    /// it may be incomplete if stderr reading fails.
    pub stderr_lines: Vec<String>,

    /// Highest contiguous agent event sequence whose webhook POST succeeded.
    ///
    /// This is a terminal event-drain watermark, not merely the last event read
    /// from stdout. `None` means no contiguous event prefix was acknowledged,
    /// such as no-API mode, no emitted events, or failure before the first event
    /// was successfully posted.
    pub last_event_sequence: Option<u32>,

    /// Claude Code's final result metadata, when a terminal result event was
    /// observed. Codex uses its own event schema and leaves this unset.
    pub claude_result: Option<ClaudeResultSummary>,

    /// Best-effort, secret-masked terminal failure diagnostic parsed from CLI
    /// stdout JSONL.
    ///
    /// Some frameworks report terminal failures as JSONL events on stdout, not
    /// stderr. Keeping the diagnostic here lets the guest-agent surface the
    /// actual failure reason in its final run error.
    pub failure_diagnostic: Option<CliFailureDiagnostic>,
}

/// Execute the CLI process, streaming JSONL events and racing against heartbeat.
pub async fn execute_cli(
    masker: &SecretMasker,
    mut heartbeat_handle: tokio::task::JoinHandle<Result<(), AgentError>>,
    http: HttpClient,
) -> Result<CliExecutionResult, AgentError> {
    let framework = env::Framework::from_env();
    let behavior = CliFrameworkBehavior::new(framework);
    log_info!(LOG_TAG, "Starting {} execution...", behavior.agent_type());

    let cmd = command::build_cli_command_for_framework(framework)?;
    let (bin, args) = cmd
        .split_first()
        .ok_or_else(|| AgentError::Execution("empty command".into()))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove(process_control_ipc::BOOTSTRAP_ENV)
        .process_group(0)
        // If a future setup step fails after spawn, dropping `Child` must not
        // leave a CLI process running in the VM.
        .kill_on_drop(true);
    // Set the child cwd explicitly at spawn time so the CLI observes the
    // current canonical workspace mount instead of relying on inherited cwd.
    set_cli_current_dir(&mut cmd, paths::CANONICAL_WORKING_DIR)?;

    match framework {
        env::Framework::ClaudeCode => {
            // Suppress Claude CLI features that are unnecessary or harmful in a
            // sandbox: startup network calls (statsig, Datadog, Segment, GCS
            // update check, GitHub) add ~2s latency, background tasks can keep
            // a one-shot run alive after its final result, telemetry has no
            // receiver, and the CLI version is baked into the rootfs image.
            cmd.env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1");
            cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
            cmd.env("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1");
            cmd.env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1");
            cmd.env("DISABLE_AUTOUPDATER", "1");
            cmd.env("DISABLE_ERROR_REPORTING", "1");
            cmd.env("DISABLE_INSTALLATION_CHECKS", "1");
            cmd.env("DISABLE_TELEMETRY", "1");
        }
        env::Framework::Codex => {
            // `codex login` and `codex exec` both honor CODEX_HOME; pin
            // it to $HOME/.codex so the login state from setup_codex
            // is visible to exec.
            cmd.env("CODEX_HOME", format!("{}/.codex", env::home_dir()));
            if env::is_codex_oauth_mode() {
                cmd.env(
                    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
                    crate::codex_auth::REFRESH_TOKEN_NOOP_URL,
                );
            }
        }
    }

    // Open the run log before spawning the CLI. If the run-id-scoped path is
    // invalid or unavailable, fail without starting a child process.
    let mut log_file = tokio::fs::File::create(paths::agent_log_file()).await?;

    let mut child = cmd.spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Execution("no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::Execution("no stderr".into()))?;

    // Stderr collector
    let mut stderr_handle =
        tokio::spawn(async move { diagnostics::collect_stderr_result_tail(stderr).await });

    // Stream stdout JSONL, racing against heartbeat and process exit.
    //
    // Event sending is decoupled from stdout reading via an mpsc channel
    // to prevent a deadlock: Bun (Claude CLI runtime) uses blocking stdout
    // writes, so if the agent's HTTP POSTs are slow and the pipe buffer
    // fills, the CLI's entire event loop blocks — including TCP I/O.
    // See: https://github.com/vm0-ai/vm0/issues/3645
    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let mut seq = 0u32;
    let mut stdout_eof = false;

    // Capture the process group ID before wait() reaps the child, since
    // child.id() returns None after the process has been reaped.
    let pgid = child.id().map(|pid| pid as i32);

    let mut cli_status: Option<std::process::ExitStatus> = None;

    // Drain deadline: after child.wait() fires, allow up to N seconds for
    // stdout EOF before breaking the loop.  Prevents indefinite hangs when
    // orphaned child processes hold the stdout fd open.
    let drain_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(drain_deadline);

    // Forced termination: some conditions require reaping the CLI process
    // group before returning. For Claude Code --print mode, post-result
    // reap arms a delayed SIGTERM after `type=result`; fatal watchdog /
    // heartbeat paths send SIGTERM immediately. Both paths share the same
    // SIGKILL escalation deadline so no forced termination can fall through
    // to an unbounded child.wait().
    // See: https://github.com/vm0-ai/vm0/issues/10879
    // See: https://github.com/vm0-ai/vm0/issues/11667
    let termination_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(termination_deadline);
    let mut termination_state = TerminationState::Idle;
    let mut termination_error: Option<AgentError> = None;

    // Stuck-tool watchdog: workaround for Claude Code bug where
    // WebSearch/WebFetch hang indefinitely. Track all in-flight tool calls;
    // if a network tool exceeds STUCK_TOOL_TIMEOUT_SECS without producing
    // a tool_result, kill the process. Keyed by tool_use_id to handle
    // parallel tool calls correctly.
    // See: https://github.com/anthropics/claude-code/issues/11650
    let mut stuck_tool_tracker: HashMap<String, (String, Instant)> = HashMap::new();
    let mut stuck_tool_check = if behavior.uses_claude_tool_watchdog() {
        let stuck_tool_interval = Duration::from_secs(constants::STUCK_TOOL_CHECK_INTERVAL_SECS);
        Some(tokio::time::interval_at(
            tokio::time::Instant::now() + stuck_tool_interval,
            stuck_tool_interval,
        ))
    } else {
        None
    };
    // MAINTENANCE: update if Claude Code adds new network tools that can hang.
    const STUCK_TOOL_NAMES: &[&str] = &["WebSearch", "WebFetch"];

    // Background event sender: HTTP POSTs happen here, never in the
    // stdout reading loop.  Unbounded channel because events are small
    // and CLI lifetime is bounded by JOB_TIMEOUT.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<PreparedEvent>();
    let should_send_events = http.has_api();
    let event_http = http.clone();
    let event_sender = tokio::spawn(async move {
        let mut acked_prefix = AckedEventPrefix::default();
        while let Some(event) = event_rx.recv().await {
            match events::post_event(&event_http, &event.payload).await {
                Ok(()) => {
                    acked_prefix.record_success(event.sequence);
                }
                Err(e) => {
                    acked_prefix.record_failure(event.sequence);
                    log_warn!(LOG_TAG, "Event send failed: {e}");
                }
            }
        }
        acked_prefix.last_contiguous()
    });

    let mut heartbeat_done = false;
    let mut last_read_event_at: Option<Instant> = None;
    let mut cli_exit_at: Option<Instant> = None;
    let mut claude_result = None;
    let mut failure_diagnostic = None;
    let event_result: Result<(), AgentError> = loop {
        tokio::select! {
            line_result = reader.next_line(), if !stdout_eof => {
                match line_result {
                    Ok(Some(line)) => {
                        // Write to log
                        let _ = log_file.write_all(line.as_bytes()).await;
                        let _ = log_file.write_all(b"\n").await;

                        let stripped = line.trim();
                        if stripped.is_empty() {
                            continue;
                        }

                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(stripped) {
                            last_read_event_at = Some(Instant::now());
                            // First event is the CLI init (system/init or thread.started)
                            if seq == 0 {
                                timing::record_e2e_from_api("api_to_cli_init");
                            }
                            // Print Claude Code final result to stdout if applicable.
                            if behavior.handles_claude_result_event(&event) {
                                claude_result = Some(ClaudeResultSummary::from_event(&event));
                                if let Some(diagnostic) =
                                    events::masked_claude_failure_diagnostic(&event, masker)
                                {
                                    let subtype = diagnostic.subtype.unwrap_or("unknown");
                                    let candidate = CliFailureDiagnostic {
                                        message: diagnostic.message,
                                        source: FailureDetailSource::ClaudeResult,
                                        failure_reason: None,
                                    };
                                    log_warn!(
                                        LOG_TAG,
                                        "Claude JSONL failure result seq={seq} subtype={subtype}: {}",
                                        candidate.message
                                    );
                                    failure_diagnostic = Some(candidate);
                                }
                                if let Some(result) = event.get("result").and_then(|v| v.as_str())
                                {
                                    println!("{result}");
                                }
                                // Arm the post-result reap deadline once per
                                // run — see `TerminationState::should_arm_post_result`.
                                if termination_state.should_arm_post_result(cli_status.is_some()) {
                                    termination_state = TerminationState::SigtermPending {
                                        reason: TerminationReason::PostResult,
                                    };
                                    termination_deadline.as_mut().reset(
                                        tokio::time::Instant::now()
                                            + Duration::from_secs(
                                                env::post_result_sigterm_grace_secs(),
                                            ),
                                    );
                                }
                            }
                            // Extract tool info BEFORE masking (masker may replace tool names).
                            behavior.track_claude_tool_events(&event, &mut stuck_tool_tracker);
                            if behavior.logs_codex_failure_diagnostics()
                                && let Some(diagnostic) =
                                    events::masked_codex_failure_diagnostic(&event, masker)
                            {
                                let candidate = CliFailureDiagnostic {
                                    message: diagnostic.message,
                                    source: FailureDetailSource::CodexJsonl,
                                    failure_reason: diagnostic.failure_reason,
                                };
                                log_warn!(
                                    LOG_TAG,
                                    "Codex JSONL failure event seq={seq} type={}: {}",
                                    diagnostic.event_type,
                                    candidate.message
                                );
                                if let Some(selected) = select_failure_diagnostic(
                                    failure_diagnostic.as_ref(),
                                    candidate,
                                ) {
                                    failure_diagnostic = Some(selected);
                                }
                            }
                            // Capture checkpoint metadata before event payload preparation
                            // consumes and masks the event.
                            events::capture_session_metadata(&event);

                            // Prepare event payload (mask secrets, add seq) and enqueue
                            // for background sending. Network I/O stays off the reading loop.
                            if should_send_events {
                                let payload = events::prepare_event_payload(event, seq, masker);
                                if event_tx
                                    .send(PreparedEvent {
                                        sequence: seq,
                                        payload,
                                    })
                                    .is_err()
                                {
                                    log_warn!(
                                        LOG_TAG,
                                        "Event channel closed, dropping event seq={seq}"
                                    );
                                }
                            }
                            seq += 1;
                        }
                    }
                    Ok(None) => {
                        stdout_eof = true;
                        if cli_status.is_some() {
                            break Ok(());
                        }
                    }
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            status = child.wait(), if cli_status.is_none() => {
                match status {
                    Ok(s) => {
                        cli_exit_at = Some(Instant::now());
                        log_info!(LOG_TAG, "CLI process exited (status: {s}), draining stdout");
                        cli_status = Some(s);
                        // CLI exited on its own (possibly in response to our
                        // SIGTERM). Park the termination FSM so it can't
                        // re-arm on any late `type=result` event.
                        termination_state = TerminationState::Done;
                        if stdout_eof {
                            break Ok(());
                        }
                        drain_deadline.as_mut().reset(
                            tokio::time::Instant::now()
                                + Duration::from_secs(constants::STDOUT_DRAIN_DEADLINE_SECS),
                        );
                    }
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            () = &mut termination_deadline, if termination_state.is_pending() && cli_status.is_none() => {
                // `libc::kill` return value is intentionally discarded in
                // both arms: ESRCH (child reaped since the is_pending()
                // / is_none() check) is racy-but-harmless, and every
                // other error would be unrecoverable from userspace.
                // The sigkill_grace deadline is the escalation path if
                // the signal fails to take effect in time.
                match termination_state {
                    TerminationState::SigtermPending { reason } => {
                        let grace = env::post_result_sigterm_grace_secs();
                        if let Some(pid) = pgid {
                            if reason == TerminationReason::PostResult {
                                log_warn!(
                                    LOG_TAG,
                                    "CLI still running {grace}s after type=result, SIGTERM pgid={pid} (likely a leaked backgrounded Bash task)"
                                );
                            } else {
                                log_warn!(
                                    LOG_TAG,
                                    "CLI still running after {} sigterm grace {grace}s, SIGTERM pgid={pid}",
                                    reason.label()
                                );
                            }
                            unsafe { libc::kill(-pid, libc::SIGTERM); }
                        }
                        termination_state = TerminationState::SigkillPending { reason };
                        termination_deadline.as_mut().reset(
                            tokio::time::Instant::now()
                                + Duration::from_secs(env::post_result_sigkill_grace_secs()),
                        );
                    }
                    TerminationState::SigkillPending { reason } => {
                        let grace = env::post_result_sigkill_grace_secs();
                        if let Some(pid) = pgid {
                            log_warn!(
                                LOG_TAG,
                                "CLI did not exit after {} SIGTERM+{grace}s, SIGKILL pgid={pid}",
                                reason.label()
                            );
                            unsafe { libc::kill(-pid, libc::SIGKILL); }
                        }
                        termination_state = TerminationState::Done;
                    }
                    // Unreachable by the is_pending() guard. Log in
                    // every build so any future FSM regression surfaces
                    // in production runner logs; debug_assert adds a
                    // fail-fast panic under cfg(debug_assertions) so
                    // CI / dev tests abort on the same condition.
                    TerminationState::Idle | TerminationState::Done => {
                        log_warn!(
                            LOG_TAG,
                            "termination_deadline fired in non-pending state {termination_state:?}"
                        );
                        debug_assert!(
                            false,
                            "termination_deadline fired in non-pending state {termination_state:?}"
                        );
                    }
                }
            }
            () = &mut drain_deadline, if cli_status.is_some() => {
                log_warn!(
                    LOG_TAG,
                    "Stdout drain deadline reached after {}s, possible orphaned child process",
                    constants::STDOUT_DRAIN_DEADLINE_SECS,
                );
                break Ok(());
            }
            _ = tick_optional_interval(&mut stuck_tool_check) => {
                let timeout_secs = env::stuck_tool_timeout_secs();
                // Find the oldest network tool that has exceeded the timeout.
                let stuck = stuck_tool_tracker
                    .values()
                    .filter(|(name, started)| {
                        started.elapsed().as_secs() >= timeout_secs
                            && STUCK_TOOL_NAMES.contains(&name.as_str())
                    })
                    .min_by_key(|(_, started)| *started)
                    .map(|(name, started)| (name.clone(), started.elapsed().as_secs()));
                if let Some((name, elapsed)) = stuck
                    && termination_error.is_none()
                {
                    let timeout_error = AgentError::Execution(format!(
                        "Tool timeout: {name} exceeded {timeout_secs}s without returning a result"
                    ));
                    log_warn!(
                        LOG_TAG,
                        "Tool timeout: {name} stuck for {elapsed}s, SIGTERM pgid={}",
                        pgid.map_or_else(|| "unknown".to_string(), |pid| pid.to_string())
                    );
                    if let Some(pid) = pgid {
                        unsafe { libc::kill(-pid, libc::SIGTERM); }
                    }
                    termination_error = Some(timeout_error);
                    termination_state = TerminationState::SigkillPending {
                        reason: TerminationReason::StuckTool,
                    };
                    termination_deadline.as_mut().reset(
                        tokio::time::Instant::now()
                            + Duration::from_secs(env::post_result_sigkill_grace_secs()),
                    );
                }
            }
            hb_result = &mut heartbeat_handle, if !heartbeat_done => {
                heartbeat_done = true;
                match hb_result {
                    Ok(Err(e)) => {
                        // Heartbeat failed — kill process group
                        if termination_error.is_none() {
                            log_warn!(
                                LOG_TAG,
                                "Heartbeat failed, SIGTERM pgid={}",
                                pgid.map_or_else(|| "unknown".to_string(), |pid| pid.to_string())
                            );
                            if let Some(pid) = pgid {
                                unsafe { libc::kill(-pid, libc::SIGTERM); }
                            }
                            termination_error = Some(e);
                            termination_state = TerminationState::SigkillPending {
                                reason: TerminationReason::HeartbeatError,
                            };
                            termination_deadline.as_mut().reset(
                                tokio::time::Instant::now()
                                    + Duration::from_secs(env::post_result_sigkill_grace_secs()),
                            );
                        }
                    }
                    Ok(Ok(())) => {
                        // Heartbeat shutdown (should not happen before CLI exits)
                        break Ok(());
                    }
                    Err(e) => {
                        let error = AgentError::Execution(format!("heartbeat task panicked: {e}"));
                        if termination_error.is_none() {
                            log_warn!(
                                LOG_TAG,
                                "Heartbeat task panicked, SIGTERM pgid={}",
                                pgid.map_or_else(|| "unknown".to_string(), |pid| pid.to_string())
                            );
                            if let Some(pid) = pgid {
                                unsafe { libc::kill(-pid, libc::SIGTERM); }
                            }
                            termination_error = Some(error);
                            termination_state = TerminationState::SigkillPending {
                                reason: TerminationReason::HeartbeatPanic,
                            };
                            termination_deadline.as_mut().reset(
                                tokio::time::Instant::now()
                                    + Duration::from_secs(env::post_result_sigkill_grace_secs()),
                            );
                        }
                    }
                }
            }
        }
    };

    let event_result = match termination_error {
        Some(err) => Err(err),
        None => event_result,
    };

    // Close the channel so the background sender can finish.
    // On error (e.g. heartbeat failure) the server is likely unreachable,
    // so we drop unsent events to avoid stalling on retries.
    drop(event_tx);
    let mut last_event_sequence = None;
    if event_result.is_ok() {
        match event_sender.await {
            Ok(sequence) => {
                last_event_sequence = sequence;
            }
            Err(e) => {
                log_warn!(LOG_TAG, "Event sender task failed: {e}");
            }
        }
    } else {
        event_sender.abort();
        let _ = event_sender.await;
    }

    let status = match cli_status {
        Some(s) => s,
        None => {
            let status = child.wait().await?;
            cli_exit_at = Some(Instant::now());
            status
        }
    };
    if let (Some(last_read_event_at), Some(cli_exit_at)) = (last_read_event_at, cli_exit_at) {
        record_sandbox_op(
            "last_read_event_to_cli_exit",
            cli_exit_at
                .checked_duration_since(last_read_event_at)
                .unwrap_or(Duration::ZERO),
            true,
            None,
        );
    }
    let exit_code = match status.code() {
        Some(code) => code,
        None => {
            let mut code = 1;
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = status.signal() {
                    log_warn!(LOG_TAG, "Process killed by signal {sig}");
                    // Map signal to 128+signal (same convention as bash/vsock-guest)
                    // so the runner can detect OOM kills (SIGKILL=9 → exit 137).
                    code = 128 + sig;
                }
            }
            code
        }
    };

    // Apply the same drain deadline to stderr — orphaned child processes
    // may hold the stderr fd open just like stdout.
    let stderr_timeout =
        tokio::time::sleep(Duration::from_secs(constants::STDOUT_DRAIN_DEADLINE_SECS));
    tokio::pin!(stderr_timeout);
    let stderr_lines = tokio::select! {
        result = &mut stderr_handle => match result {
            Ok(lines) => lines,
            Err(e) => {
                log_warn!(LOG_TAG, "stderr collector panicked: {e}");
                Vec::new()
            }
        },
        () = &mut stderr_timeout => {
            log_warn!(
                LOG_TAG,
                "stderr drain timeout, possible orphaned child process"
            );
            stderr_handle.abort();
            let _ = stderr_handle.await;
            Vec::new()
        },
    };
    let masked_stderr_lines = stderr_lines
        .into_iter()
        .map(|line| masker.mask_string(&line))
        .collect::<Vec<_>>();

    // If event loop had an error, propagate it
    event_result?;

    Ok(CliExecutionResult {
        exit_code,
        stderr_lines: masked_stderr_lines,
        last_event_sequence,
        claude_result,
        failure_diagnostic,
    })
}

fn set_cli_current_dir(cmd: &mut tokio::process::Command, path: &str) -> Result<(), AgentError> {
    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|e| {
        AgentError::Execution(format!(
            "canonical working directory unavailable before CLI spawn: {}: {e}",
            path.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(AgentError::Execution(format!(
            "canonical working directory is not a directory before CLI spawn: {}",
            path.display()
        )));
    }
    cmd.current_dir(path);
    Ok(())
}

fn select_failure_diagnostic(
    existing: Option<&CliFailureDiagnostic>,
    candidate: CliFailureDiagnostic,
) -> Option<CliFailureDiagnostic> {
    if candidate.source != FailureDetailSource::CodexJsonl {
        return Some(candidate);
    }

    match existing {
        None => Some(candidate),
        Some(existing) => {
            if has_specific_failure_message(&candidate) {
                return Some(with_carried_failure_reason(Some(existing), candidate));
            }
            if candidate.failure_reason.is_some() {
                let mut selected = existing.clone();
                selected.failure_reason = candidate.failure_reason;
                return Some(selected);
            }
            if existing.source == FailureDetailSource::CodexJsonl
                && !has_specific_failure_diagnostic(existing)
            {
                return Some(candidate);
            }
            None
        }
    }
}

fn has_specific_failure_diagnostic(diagnostic: &CliFailureDiagnostic) -> bool {
    diagnostic.failure_reason.is_some() || has_specific_failure_message(diagnostic)
}

fn has_specific_failure_message(diagnostic: &CliFailureDiagnostic) -> bool {
    !events::is_generic_codex_failure_diagnostic(&diagnostic.message)
}

fn with_carried_failure_reason(
    existing: Option<&CliFailureDiagnostic>,
    mut candidate: CliFailureDiagnostic,
) -> CliFailureDiagnostic {
    if candidate.failure_reason.is_none() {
        candidate.failure_reason = existing.and_then(|diagnostic| diagnostic.failure_reason);
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::{
        CliFailureDiagnostic, select_failure_diagnostic, set_cli_current_dir,
        with_carried_failure_reason,
    };
    use agent_diagnostics::{FailureDetailSource, FailureReason};

    #[tokio::test]
    async fn cli_current_dir_helper_sets_child_working_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cmd = tokio::process::Command::new("pwd");
        cmd.stdout(std::process::Stdio::piped());

        set_cli_current_dir(&mut cmd, dir.path().to_str().expect("utf8 temp path"))
            .expect("set cwd");
        let output = cmd.output().await.expect("pwd");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            dir.path().to_string_lossy()
        );
    }

    #[test]
    fn cli_current_dir_helper_errors_for_missing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing");
        let mut cmd = tokio::process::Command::new("pwd");

        let err = set_cli_current_dir(&mut cmd, missing.to_str().expect("utf8 temp path"))
            .expect_err("missing cwd should fail");

        assert!(
            err.to_string()
                .contains("canonical working directory unavailable")
        );
    }

    #[test]
    fn cli_current_dir_helper_errors_for_non_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("workspace-file");
        std::fs::write(&file, b"not a directory").expect("write file");
        let mut cmd = tokio::process::Command::new("pwd");

        let err = set_cli_current_dir(&mut cmd, file.to_str().expect("utf8 temp path"))
            .expect_err("non-directory cwd should fail");

        assert!(err.to_string().contains("is not a directory"));
    }

    #[test]
    fn specific_codex_failure_diagnostic_survives_later_generic_event() {
        assert_eq!(
            select_failure_diagnostic(
                Some(&CliFailureDiagnostic {
                    message: "You've hit your usage limit.".to_string(),
                    source: FailureDetailSource::CodexJsonl,
                    failure_reason: None,
                }),
                CliFailureDiagnostic {
                    message: "turn failed".to_string(),
                    source: FailureDetailSource::CodexJsonl,
                    failure_reason: None,
                },
            ),
            None,
        );
    }

    #[test]
    fn specific_codex_failure_diagnostic_replaces_generic_event() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "You've hit your usage limit.".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            },
        );

        assert_eq!(
            selected.map(|diagnostic| diagnostic.message),
            Some("You've hit your usage limit.".to_string())
        );
    }

    #[test]
    fn codex_failure_reason_replaces_generic_diagnostic() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "turn failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: Some(FailureReason::InvalidApiKey),
            },
        );

        assert_eq!(
            selected.map(|diagnostic| diagnostic.failure_reason),
            Some(Some(FailureReason::InvalidApiKey))
        );
    }

    #[test]
    fn generic_codex_reason_preserves_existing_specific_message() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "request failed before shutdown".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "turn failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: Some(FailureReason::InvalidApiKey),
            },
        )
        .expect("reason-bearing generic diagnostic should update existing diagnostic");

        assert_eq!(selected.message, "request failed before shutdown");
        assert_eq!(selected.failure_reason, Some(FailureReason::InvalidApiKey));
    }

    #[test]
    fn carried_failure_reason_survives_message_replacement() {
        let candidate = with_carried_failure_reason(
            Some(&CliFailureDiagnostic {
                message: "turn failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: Some(FailureReason::InvalidApiKey),
            }),
            CliFailureDiagnostic {
                message: "request failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            },
        );

        assert_eq!(candidate.message, "request failed");
        assert_eq!(candidate.failure_reason, Some(FailureReason::InvalidApiKey));
    }
}
