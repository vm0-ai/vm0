//! CLI command building and execution for Claude Code / Codex.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use crate::timing;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;

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
}

async fn tick_optional_interval(interval: &mut Option<tokio::time::Interval>) {
    match interval {
        Some(interval) => {
            interval.tick().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// Build the CLI command + args based on `CLI_AGENT_TYPE`.
pub fn build_cli_command() -> Result<Vec<String>, AgentError> {
    build_cli_command_for_framework(env::Framework::from_env())
}

fn build_cli_command_for_framework(framework: env::Framework) -> Result<Vec<String>, AgentError> {
    match framework {
        env::Framework::ClaudeCode => Ok(build_claude_command(env::use_mock_claude())),
        env::Framework::Codex => Ok(build_codex_command(env::use_mock_codex())),
    }
}

/// Build the argument list from explicit parameters (testable).
fn build_claude_args(
    resume_id: &str,
    append_system_prompt: &str,
    disallowed_tools: &str,
    tools: &str,
    settings: &str,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    if !resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming session: {resume_id}");
        args.push("--resume".to_string());
        args.push(resume_id.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new session");
    }

    if !append_system_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(append_system_prompt.to_string());
    }

    if !disallowed_tools.is_empty() {
        args.push("--disallowed-tools".to_string());
        for tool in disallowed_tools.split(',') {
            let tool = tool.trim();
            if !tool.is_empty() {
                args.push(tool.to_string());
            }
        }
    }

    if !tools.is_empty() {
        args.push("--tools".to_string());
        for tool in tools.split(',') {
            let tool = tool.trim();
            if !tool.is_empty() {
                args.push(tool.to_string());
            }
        }
    }

    if !settings.is_empty() {
        args.push("--settings".to_string());
        args.push(settings.to_string());
    }

    // "--" terminates option parsing so Commander.js variadic options
    // (--disallowed-tools, --tools) do not consume the prompt.
    args.push("--".to_string());
    args.push(prompt.to_string());
    args
}

fn build_claude_command(use_mock: bool) -> Vec<String> {
    let args = build_claude_args(
        env::resume_session_id(),
        env::append_system_prompt(),
        env::disallowed_tools(),
        env::tools(),
        env::settings(),
        env::prompt(),
    );

    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-claude for testing");
        // Tests can override the path so they target a cargo-built
        // artifact rather than the sandbox's baked-in `/usr/local/bin`.
        env::mock_claude_path()
    } else {
        "claude".to_string()
    };

    let mut cmd = vec![bin];
    cmd.extend(args);
    cmd
}

/// Build the codex argument list (testable).
///
/// Resume is a positional sub-subcommand (`codex exec resume <id> <prompt>`),
/// not a `--resume <id>` flag. No `--` separator before the prompt: codex
/// has no variadic flags here, so `--` would propagate as a literal arg.
fn quote_toml_basic_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\u{08}' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\u{0C}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            ch if ch.is_control() => quoted.push_str(&format!("\\u{:04X}", u32::from(ch))),
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

fn build_codex_developer_instructions_config(append_system_prompt: &str) -> String {
    let value = quote_toml_basic_string(append_system_prompt);
    format!("developer_instructions={value}")
}

fn build_codex_memories_config() -> String {
    "features.memories=true".to_string()
}

fn build_codex_args(
    working_dir: &str,
    model: &str,
    resume_id: &str,
    append_system_prompt: &str,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--sandbox".to_string(),
        "danger-full-access".to_string(),
        "--skip-git-repo-check".to_string(),
        "-C".to_string(),
        working_dir.to_string(),
    ];

    args.push("-c".to_string());
    args.push(build_codex_memories_config());

    if !model.is_empty() {
        args.push("-m".to_string());
        args.push(model.to_string());
    }

    if !append_system_prompt.is_empty() {
        args.push("-c".to_string());
        args.push(build_codex_developer_instructions_config(
            append_system_prompt,
        ));
    }

    if !resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming codex session: {resume_id}");
        args.push("resume".to_string());
        args.push(resume_id.to_string());
        args.push(prompt.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new codex session");
        args.push(prompt.to_string());
    }

    args
}

fn build_codex_command(use_mock: bool) -> Vec<String> {
    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-codex for testing");
        env::mock_codex_path()
    } else {
        "codex".to_string()
    };

    let mut cmd = vec![bin];
    cmd.extend(build_codex_args(
        env::working_dir(),
        env::openai_model(),
        env::resume_session_id(),
        env::append_system_prompt(),
        env::prompt(),
    ));
    cmd
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

struct PreparedEvent {
    sequence: u32,
    payload: serde_json::Value,
}

#[derive(Default)]
struct AckedEventPrefix {
    next_expected: u32,
    last_contiguous: Option<u32>,
    prefix_broken: bool,
}

impl AckedEventPrefix {
    fn record_success(&mut self, sequence: u32) {
        if self.prefix_broken {
            return;
        }

        if sequence == self.next_expected {
            self.last_contiguous = Some(sequence);
            self.next_expected = sequence.saturating_add(1);
        } else if sequence > self.next_expected {
            self.prefix_broken = true;
        }
    }

    fn record_failure(&mut self, sequence: u32) {
        if sequence >= self.next_expected {
            self.prefix_broken = true;
        }
    }

    fn last_contiguous(&self) -> Option<u32> {
        self.last_contiguous
    }
}

pub struct CliExecutionResult {
    pub exit_code: i32,
    pub stderr_lines: Vec<String>,
    pub last_event_sequence: Option<u32>,
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

    let cmd = build_cli_command_for_framework(framework)?;
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
    let mut stderr_handle = tokio::spawn(async move {
        let mut lines = Vec::new();
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            lines.push(line);
        }
        lines
    });

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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    fn build_claude_args_for_test(
        resume_id: &str,
        append_system_prompt: &str,
        disallowed_tools: &str,
        tools: &str,
        settings: &str,
        prompt: &str,
    ) -> Vec<String> {
        disable_system_log();
        build_claude_args(
            resume_id,
            append_system_prompt,
            disallowed_tools,
            tools,
            settings,
            prompt,
        )
    }

    fn build_claude_command_for_test(use_mock: bool) -> Vec<String> {
        disable_system_log();
        build_claude_command(use_mock)
    }

    /// Assert prompt is last and preceded by "--" separator.
    fn assert_prompt_with_separator(args: &[String], expected_prompt: &str) {
        let len = args.len();
        assert!(len >= 2, "args too short: {args:?}");
        assert_eq!(
            args[len - 2],
            "--",
            "second-to-last arg must be '--': {args:?}"
        );
        assert_eq!(args[len - 1], expected_prompt);
    }

    #[test]
    fn build_claude_args_basic() {
        let args = build_claude_args_for_test("", "", "", "", "", "hello world");
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert_prompt_with_separator(&args, "hello world");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_claude_args_with_append_system_prompt() {
        let args = build_claude_args_for_test("", "Your name is Aria.", "", "", "", "analyze this");
        let asp_idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[asp_idx + 1], "Your name is Aria.");
        assert_prompt_with_separator(&args, "analyze this");
    }

    #[test]
    fn build_claude_args_empty_append_system_prompt_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume_and_append() {
        let args = build_claude_args_for_test("sess-123", "Be helpful.", "", "", "", "prompt");
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert_prompt_with_separator(&args, "prompt");
    }

    #[test]
    fn build_claude_command_uses_claude_binary() {
        let cmd = build_claude_command_for_test(false);
        assert_eq!(cmd[0], "claude");
    }

    #[test]
    fn build_claude_command_uses_mock_binary() {
        // Unit tests run in the lib-test binary where
        // `VM0_MOCK_CLAUDE_PATH` is unset, so `env::mock_claude_path()`
        // falls through to `DEFAULT_MOCK_CLAUDE_PATH`. Asserting
        // against the const (not the accessor) catches regressions in
        // the default path itself — the previous form compared the
        // accessor against itself and was tautological.
        let cmd = build_claude_command_for_test(true);
        assert_eq!(cmd[0], env::DEFAULT_MOCK_CLAUDE_PATH);
    }

    // -----------------------------------------------------------------
    // build_codex_args / build_codex_command
    // -----------------------------------------------------------------

    fn build_codex_args_for_test(
        working_dir: &str,
        model: &str,
        resume_id: &str,
        prompt: &str,
    ) -> Vec<String> {
        disable_system_log();
        build_codex_args(working_dir, model, resume_id, "", prompt)
    }

    fn build_codex_args_with_append_for_test(
        working_dir: &str,
        model: &str,
        resume_id: &str,
        append_system_prompt: &str,
        prompt: &str,
    ) -> Vec<String> {
        disable_system_log();
        build_codex_args(working_dir, model, resume_id, append_system_prompt, prompt)
    }

    fn codex_args_have_config(args: &[String], config: &str) -> bool {
        args.windows(2)
            .any(|window| window[0] == "-c" && window[1] == config)
    }

    fn build_codex_command_for_test(use_mock: bool) -> Vec<String> {
        disable_system_log();
        build_codex_command(use_mock)
    }

    #[test]
    fn build_codex_args_basic_shape() {
        let args = build_codex_args_for_test("/workspace", "", "", "hello");
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "--json");
        let s_idx = args.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(args[s_idx + 1], "danger-full-access");
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        let c_idx = args.iter().position(|a| a == "-C").unwrap();
        assert_eq!(args[c_idx + 1], "/workspace");
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert_eq!(args.last().unwrap(), "hello");
    }

    #[test]
    fn build_codex_args_omits_model_when_empty() {
        let args = build_codex_args_for_test("/wd", "", "", "p");
        assert!(!args.contains(&"-m".to_string()));
    }

    #[test]
    fn build_codex_args_with_model() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "", "p");
        let m_idx = args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(args[m_idx + 1], "gpt-5");
    }

    #[test]
    fn build_codex_args_resume_uses_positional_subcommand() {
        let args = build_codex_args_for_test("/wd", "", "thread-abc", "follow up");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[r_idx + 1], "thread-abc");
        assert_eq!(args[r_idx + 2], "follow up");
        // resume is a positional sub-subcommand, NOT a --resume flag
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_codex_args_resume_layout_is_resume_id_prompt() {
        let args = build_codex_args_for_test("/wd", "", "id1", "p1");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args.len(), r_idx + 3);
        assert_eq!(args[r_idx + 1], "id1");
        assert_eq!(args[r_idx + 2], "p1");
    }

    #[test]
    fn build_codex_args_no_double_dash_separator() {
        // Codex has no variadic flags here; a bare `--` separator would
        // propagate as a literal arg to the codex CLI.
        let args = build_codex_args_for_test("/wd", "gpt-5", "id", "hello");
        assert!(!args.contains(&"--".to_string()));
    }

    #[test]
    fn build_codex_args_prompt_last_in_no_resume_path() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "", "the prompt");
        assert_eq!(args.last().unwrap(), "the prompt");
    }

    #[test]
    fn build_codex_args_with_append_system_prompt() {
        let args = build_codex_args_with_append_for_test(
            "/wd",
            "",
            "",
            "Your name is Aria.",
            "analyze this",
        );
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert!(codex_args_have_config(
            &args,
            r#"developer_instructions="Your name is Aria.""#
        ));
        assert_eq!(args.last().unwrap(), "analyze this");
    }

    #[test]
    fn build_codex_args_empty_append_system_prompt_omitted() {
        let args = build_codex_args_with_append_for_test("/wd", "", "", "", "test");
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("developer_instructions="))
        );
    }

    #[test]
    fn build_codex_args_resume_with_append_system_prompt_order() {
        let args =
            build_codex_args_with_append_for_test("/wd", "", "thread-abc", "Be concise.", "next");
        let c_idx = args
            .iter()
            .position(|a| a == r#"developer_instructions="Be concise.""#)
            .unwrap();
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert!(c_idx < r_idx);
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert_eq!(args[c_idx], r#"developer_instructions="Be concise.""#);
        assert_eq!(args[r_idx + 1], "thread-abc");
        assert_eq!(args[r_idx + 2], "next");
        assert_eq!(args.len(), r_idx + 3);
    }

    #[test]
    fn build_codex_args_quotes_append_system_prompt_for_config() {
        let args = build_codex_args_with_append_for_test(
            "/wd",
            "",
            "",
            "Say \"hi\"\nPath C:\\tmp",
            "prompt",
        );
        assert!(codex_args_have_config(
            &args,
            r#"developer_instructions="Say \"hi\"\nPath C:\\tmp""#
        ));
    }

    #[test]
    fn build_codex_command_uses_codex_binary() {
        let cmd = build_codex_command_for_test(false);
        assert_eq!(cmd[0], "codex");
    }

    #[test]
    fn build_codex_command_uses_mock_binary() {
        // Mirrors `build_claude_command_uses_mock_binary`: assert against
        // the default const so regressions in the install path surface.
        let cmd = build_codex_command_for_test(true);
        assert_eq!(cmd[0], env::DEFAULT_MOCK_CODEX_PATH);
    }

    #[test]
    fn build_claude_args_with_disallowed_tools() {
        let args =
            build_claude_args_for_test("", "", "CronCreate,CronDelete,CronList", "", "", "hello");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        assert_eq!(args[dt_idx + 1], "CronCreate");
        assert_eq!(args[dt_idx + 2], "CronDelete");
        assert_eq!(args[dt_idx + 3], "CronList");
        // "--" must separate variadic tools from the prompt
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_disallowed_tools_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--disallowed-tools".to_string()));
    }

    #[test]
    fn build_claude_args_with_tools() {
        let args = build_claude_args_for_test("", "", "", "Bash,Edit,Read", "", "hello");
        let t_idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[t_idx + 1], "Bash");
        assert_eq!(args[t_idx + 2], "Edit");
        assert_eq!(args[t_idx + 3], "Read");
        // "--" must separate variadic tools from the prompt
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_tools_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--tools".to_string()));
    }

    #[test]
    fn build_claude_args_with_settings() {
        let args = build_claude_args_for_test("", "", "", "", r#"{"hooks":{}}"#, "hello");
        let s_idx = args.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(args[s_idx + 1], r#"{"hooks":{}}"#);
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_settings_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--settings".to_string()));
    }

    #[test]
    fn build_claude_args_all_options_combined() {
        let args = build_claude_args_for_test(
            "sess-abc",
            "Be concise.",
            "CronCreate,CronDelete",
            "Bash,Read",
            r#"{"hooks":{}}"#,
            "do something",
        );
        for expected in [
            "--resume",
            "sess-abc",
            "--append-system-prompt",
            "Be concise.",
            "--disallowed-tools",
            "CronCreate",
            "CronDelete",
            "--tools",
            "Bash",
            "Read",
            "--settings",
            r#"{"hooks":{}}"#,
        ] {
            assert!(args.iter().any(|a| a == expected), "missing: {expected}");
        }
        assert_prompt_with_separator(&args, "do something");
    }

    #[test]
    fn build_claude_args_disallowed_tools_whitespace_trimmed() {
        let args = build_claude_args_for_test("", "", " CronCreate , CronDelete ", "", "", "test");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        assert_eq!(args[dt_idx + 1], "CronCreate");
        assert_eq!(args[dt_idx + 2], "CronDelete");
    }

    #[test]
    fn build_claude_args_tools_whitespace_trimmed() {
        let args = build_claude_args_for_test("", "", "", " Bash , Read ", "", "test");
        let t_idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[t_idx + 1], "Bash");
        assert_eq!(args[t_idx + 2], "Read");
    }

    #[test]
    fn build_claude_args_disallowed_tools_empty_items_skipped() {
        // Trailing comma produces an empty token that should be skipped
        let args = build_claude_args_for_test("", "", "CronCreate,,CronDelete,", "", "", "test");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        // Only non-empty tools should be present
        let tool_args: Vec<&str> = args[dt_idx + 1..]
            .iter()
            .take_while(|a| a.as_str() != "--" && !a.starts_with("--"))
            .map(|s| s.as_str())
            .collect();
        assert_eq!(tool_args, vec!["CronCreate", "CronDelete"]);
    }

    #[test]
    fn build_claude_args_prompt_always_last() {
        let args = build_claude_args_for_test("", "", "", "", "", "my prompt");
        assert_eq!(args.last().unwrap(), "my prompt");
    }

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
    // AckedEventPrefix
    // -----------------------------------------------------------------

    #[test]
    fn acked_event_prefix_advances_on_contiguous_successes() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_success(1);
        prefix.record_success(2);

        assert_eq!(prefix.last_contiguous(), Some(2));
    }

    #[test]
    fn acked_event_prefix_stops_at_first_failed_event() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_failure(1);
        prefix.record_success(2);

        assert_eq!(prefix.last_contiguous(), Some(0));
    }

    #[test]
    fn acked_event_prefix_has_no_watermark_when_first_event_fails() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_failure(0);
        prefix.record_success(1);

        assert_eq!(prefix.last_contiguous(), None);
    }

    #[test]
    fn acked_event_prefix_rejects_success_gap() {
        let mut prefix = AckedEventPrefix::default();

        prefix.record_success(0);
        prefix.record_success(2);
        prefix.record_success(3);

        assert_eq!(prefix.last_contiguous(), Some(0));
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
