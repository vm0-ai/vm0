//! CLI command building and execution for Claude Code / Codex.

mod command;
mod diagnostics;
mod event_delivery;

pub use command::build_cli_command;

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use crate::timing;
use event_delivery::{AckedEventPrefix, PreparedEvent};
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const LOG_TAG: &str = "sandbox:guest-agent";

/// State machine driving forced CLI process-group termination. A single
/// pinned deadline is resettable across phases; the enum value tells the
/// lone select! branch what to do when the deadline fires.
///
/// | From             | Trigger        | To              | Action          |
/// |------------------|----------------|-----------------|-----------------|
/// | `Idle`           | `type=result`  | `SigtermPending`| arm delayed sigterm grace |
/// | `Idle`           | forced kill    | `SigkillPending`| SIGTERM pgid, arm sigkill grace |
/// | `SigtermPending` | deadline fires | `SigkillPending`| SIGTERM pgid, arm sigkill grace |
/// | `SigkillPending` | deadline fires | `Done`          | SIGKILL pgid    |
/// | _any pending_    | `child.wait()` | `Done`          | (no signal)     |
///
/// `Done` is sticky: a late second `type=result` on the same run cannot
/// re-arm the deadline, and any in-flight signalling is one-shot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminationState {
    Idle,
    SigtermPending { reason: TerminationReason },
    SigkillPending { reason: TerminationReason },
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminationReason {
    PostResult,
    StuckTool,
    HeartbeatError,
    HeartbeatPanic,
}

impl TerminationReason {
    fn label(self) -> &'static str {
        match self {
            TerminationReason::PostResult => "post-result reap",
            TerminationReason::StuckTool => "stuck-tool watchdog",
            TerminationReason::HeartbeatError => "heartbeat error",
            TerminationReason::HeartbeatPanic => "heartbeat panic",
        }
    }
}

impl TerminationState {
    /// True while waiting for an armed SIGTERM or SIGKILL deadline to fire;
    /// used as the select! branch's eligibility guard.
    fn is_pending(self) -> bool {
        matches!(
            self,
            TerminationState::SigtermPending { .. } | TerminationState::SigkillPending { .. }
        )
    }

    /// Whether to arm the reap deadline on an incoming `type=result`
    /// event. Only the initial Idle → SigtermPending transition should
    /// fire — later events (or a result that races a CLI exit) must
    /// not re-arm. Single source of truth consumed by both the
    /// production guard in `execute_cli` and the FSM unit tests.
    fn should_arm_post_result(self, cli_exited: bool) -> bool {
        matches!(self, TerminationState::Idle) && !cli_exited
    }
}

#[derive(Debug, Clone, Copy)]
struct CliFrameworkBehavior {
    framework: env::Framework,
}

impl CliFrameworkBehavior {
    fn new(framework: env::Framework) -> Self {
        Self { framework }
    }

    fn agent_type(self) -> &'static str {
        self.framework.agent_type()
    }

    fn handles_claude_result_event(self, event: &serde_json::Value) -> bool {
        matches!(self.framework, env::Framework::ClaudeCode)
            && event.get("type").and_then(|v| v.as_str()) == Some("result")
    }

    fn uses_claude_tool_watchdog(self) -> bool {
        matches!(self.framework, env::Framework::ClaudeCode)
    }

    fn track_claude_tool_events(
        self,
        event: &serde_json::Value,
        tracker: &mut HashMap<String, (String, Instant)>,
    ) {
        if !self.uses_claude_tool_watchdog() {
            return;
        }

        for tool_event in events::extract_claude_tool_info(event) {
            match tool_event {
                events::ClaudeToolEvent::Use { id, name } => {
                    tracker.insert(id.to_string(), (name.to_string(), Instant::now()));
                }
                events::ClaudeToolEvent::Result { tool_use_id } => {
                    tracker.remove(tool_use_id);
                }
            }
        }
    }

    fn logs_codex_failure_diagnostics(self) -> bool {
        matches!(self.framework, env::Framework::Codex)
    }
}

async fn tick_optional_interval(interval: &mut Option<tokio::time::Interval>) {
    match interval {
        Some(interval) => {
            interval.tick().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// Set up codex auth on the guest before invoking `codex exec`.
///
/// Two mutually-exclusive paths:
///
/// - **ChatGPT-OAuth mode** (`CHATGPT_ACCOUNT_ID` set): write a fabricated
///   `~/.codex/auth.json` containing placeholder JWTs that put codex into
///   `Chatgpt` mode without ever holding real OAuth credentials inside
///   the sandbox. The firewall replaces placeholder bytes on egress. See
///   the `codex_auth` module + issue #11877.
///
/// - **API-key mode** (default): pipe `OPENAI_API_KEY` into
///   `codex login --with-api-key` to write `~/.codex/auth.json`. If
///   `OPENAI_API_KEY` is empty, log and return Ok — `codex exec` reads
///   the env directly so the env path covers authn even when the login
///   subcommand isn't available.
///
/// Both paths are best-effort — failure logs but does not abort init.
pub fn setup_codex() -> Result<(), AgentError> {
    use std::io::Write as _;

    if env::is_codex_oauth_mode() {
        return setup_codex_chatgpt();
    }

    let codex_home = format!("{}/.codex", env::home_dir());
    std::fs::create_dir_all(&codex_home)?;
    log_info!(LOG_TAG, "Codex home directory: {codex_home}");

    let api_key = env::openai_api_key();
    if api_key.is_empty() {
        log_info!(LOG_TAG, "OPENAI_API_KEY not set, skipping codex login");
        return Ok(());
    }

    let login_start = Instant::now();
    let result = std::process::Command::new("codex")
        .args(["login", "--with-api-key"])
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(api_key.as_bytes());
            }
            child.wait_with_output()
        });
    let success = matches!(&result, Ok(o) if o.status.success());
    if success {
        log_info!(LOG_TAG, "Codex authenticated with API key");
    } else {
        match &result {
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                log_warn!(LOG_TAG, "codex login failed (non-fatal): {stderr}");
            }
            Err(e) => {
                log_warn!(LOG_TAG, "codex login spawn failed (non-fatal): {e}");
            }
        }
    }
    record_sandbox_op("codex_login", login_start.elapsed(), success, None);
    Ok(())
}

/// Wrapper that calls `codex_auth::setup_codex_chatgpt_inner` with values
/// read from env + the real clock, and records a telemetry op so failures
/// surface in dashboards.
fn setup_codex_chatgpt() -> Result<(), AgentError> {
    let setup_start = Instant::now();
    let home = std::path::PathBuf::from(env::home_dir());
    let result = crate::codex_auth::setup_codex_chatgpt_inner(&home, chrono::Utc::now());

    let success = result.is_ok();
    let err_msg = result.as_ref().err().map(|e| e.to_string());
    record_sandbox_op(
        "codex_chatgpt_setup",
        setup_start.elapsed(),
        success,
        err_msg.as_deref(),
    );

    if success {
        log_info!(LOG_TAG, "Codex ChatGPT-OAuth auth.json written");
    }
    result
}

/// Summary of Claude Code's terminal `type=result` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeResultSummary {
    /// Claude Code's reported turn count for the run, when present.
    pub num_turns: Option<u64>,
}

impl ClaudeResultSummary {
    fn from_event(event: &serde_json::Value) -> Self {
        Self {
            num_turns: event.get("num_turns").and_then(|v| v.as_u64()),
        }
    }
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
        .process_group(0)
        // If a future setup step fails after spawn, dropping `Child` must not
        // leave a CLI process running in the VM.
        .kill_on_drop(true);

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

                        if let Ok(mut event) = serde_json::from_str::<serde_json::Value>(stripped) {
                            last_read_event_at = Some(Instant::now());
                            // First event is the CLI init (system/init or thread.started)
                            if seq == 0 {
                                timing::record_e2e_from_api("api_to_cli_init");
                            }
                            // Print Claude Code final result to stdout if applicable.
                            if behavior.handles_claude_result_event(&event) {
                                claude_result = Some(ClaudeResultSummary::from_event(&event));
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
                                log_warn!(
                                    LOG_TAG,
                                    "Codex JSONL failure event seq={seq} type={}: {}",
                                    diagnostic.event_type,
                                    diagnostic.message
                                );
                            }
                            // Prepare event (fast: mask secrets, add seq) and enqueue
                            // for background sending.  Never blocks the reading loop.
                            if let Some(payload) = events::prepare_event(&mut event, seq, masker)
                                && event_tx
                                    .send(PreparedEvent {
                                        sequence: seq,
                                        payload,
                                    })
                                    .is_err()
                            {
                                log_warn!(LOG_TAG, "Event channel closed, dropping event seq={seq}");
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // CliFrameworkBehavior
    // -----------------------------------------------------------------

    #[test]
    fn framework_behavior_uses_agent_type_strings_for_logs() {
        assert_eq!(
            CliFrameworkBehavior::new(env::Framework::ClaudeCode).agent_type(),
            "claude-code"
        );
        assert_eq!(
            CliFrameworkBehavior::new(env::Framework::Codex).agent_type(),
            "codex"
        );
    }

    #[test]
    fn framework_behavior_handles_result_events_only_for_claude_code() {
        let result_event = serde_json::json!({
            "type": "result",
            "result": "done"
        });
        let codex_terminal_event = serde_json::json!({
            "type": "turn.completed",
            "usage": {"input_tokens": 1, "output_tokens": 2}
        });

        assert!(
            CliFrameworkBehavior::new(env::Framework::ClaudeCode)
                .handles_claude_result_event(&result_event)
        );
        assert!(
            !CliFrameworkBehavior::new(env::Framework::Codex)
                .handles_claude_result_event(&result_event)
        );
        assert!(
            !CliFrameworkBehavior::new(env::Framework::ClaudeCode)
                .handles_claude_result_event(&codex_terminal_event)
        );
    }

    #[test]
    fn claude_result_summary_captures_terminal_result_metadata() {
        let event = serde_json::json!({
            "type": "result",
            "num_turns": 0,
            "is_error": false,
            "result": "done"
        });

        assert_eq!(
            ClaudeResultSummary::from_event(&event),
            ClaudeResultSummary { num_turns: Some(0) }
        );
    }

    #[test]
    fn framework_behavior_tracks_claude_tools_only_for_claude_code() {
        let tool_use = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": "tool-1", "name": "WebFetch"}]
            }
        });
        let tool_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "tool-1"}]
            }
        });
        let mut tracker = HashMap::new();

        CliFrameworkBehavior::new(env::Framework::Codex)
            .track_claude_tool_events(&tool_use, &mut tracker);
        assert!(tracker.is_empty());

        CliFrameworkBehavior::new(env::Framework::ClaudeCode)
            .track_claude_tool_events(&tool_use, &mut tracker);
        assert_eq!(
            tracker.get("tool-1").map(|(name, _)| name.as_str()),
            Some("WebFetch")
        );

        CliFrameworkBehavior::new(env::Framework::Codex)
            .track_claude_tool_events(&tool_result, &mut tracker);
        assert!(tracker.contains_key("tool-1"));

        CliFrameworkBehavior::new(env::Framework::ClaudeCode)
            .track_claude_tool_events(&tool_result, &mut tracker);
        assert!(tracker.is_empty());
    }

    // -----------------------------------------------------------------
    // TerminationState FSM
    // -----------------------------------------------------------------

    #[test]
    fn termination_state_is_pending_only_between_arming_and_done() {
        assert!(!TerminationState::Idle.is_pending());
        assert!(
            TerminationState::SigtermPending {
                reason: TerminationReason::PostResult,
            }
            .is_pending()
        );
        assert!(
            TerminationState::SigkillPending {
                reason: TerminationReason::StuckTool,
            }
            .is_pending()
        );
        assert!(!TerminationState::Done.is_pending());
    }

    /// The arming guard must fire exactly once per run, on the first
    /// `type=result` event, and only when the CLI is still alive. Any
    /// later state — or a CLI that already exited — must be ignored
    /// (Done is sticky; SigtermPending/SigkillPending already armed).
    ///
    /// Calls `TerminationState::should_arm_post_result` directly so
    /// the test shares a single source of truth with the production
    /// `select!` branch.
    #[test]
    fn termination_state_should_arm_post_result_matches_invariant() {
        // Fire only from Idle with CLI still alive.
        assert!(TerminationState::Idle.should_arm_post_result(false));

        // CLI already exited → no arm, even from Idle.
        assert!(!TerminationState::Idle.should_arm_post_result(true));

        // Already armed → no re-arm.
        assert!(
            !TerminationState::SigtermPending {
                reason: TerminationReason::PostResult,
            }
            .should_arm_post_result(false)
        );
        assert!(
            !TerminationState::SigkillPending {
                reason: TerminationReason::HeartbeatError,
            }
            .should_arm_post_result(false)
        );

        // Done is sticky.
        assert!(!TerminationState::Done.should_arm_post_result(false));
    }
}
