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
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt};

const LOG_TAG: &str = "sandbox:guest-agent";
const STDERR_RESULT_MAX_LINES: usize = 200;
const STDERR_RESULT_MAX_LINE_BYTES: usize = 16 * 1024;
const STDERR_READ_BUFFER_BYTES: usize = 8 * 1024;
const STDERR_OMITTED_LONG_LINE: &str = "[stderr line omitted: exceeded diagnostic size limit]";
const INTERACTIVE_HOOK_POLL_MS: u64 = 50;
const INTERACTIVE_TRANSCRIPT_TAIL_MS: u64 = 50;
const INTERACTIVE_POST_STOP_DRAIN_MS: u64 = 1000;
const INTERACTIVE_PROCESS_EXIT_GRACE_MS: u64 = 1000;

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

fn build_interactive_claude_args(
    resume_id: &str,
    append_system_prompt: &str,
    disallowed_tools: &str,
    tools: &str,
    settings: &str,
) -> Vec<String> {
    let mut args = vec!["--dangerously-skip-permissions".to_string()];

    if !resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming interactive Claude session: {resume_id}");
        args.push("--resume".to_string());
        args.push(resume_id.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new interactive Claude session");
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
/// not a `--resume <id>` flag. Use `--` before the prompt so user text that
/// starts with `-` is not parsed as another codex option.
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
        args.push("--".to_string());
        args.push(prompt.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new codex session");
        args.push("--".to_string());
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

fn push_stderr_result_line(lines: &mut VecDeque<String>, line: String) {
    if lines.len() == STDERR_RESULT_MAX_LINES {
        lines.pop_front();
    }
    lines.push_back(line);
}

fn push_decoded_stderr_result_line(lines: &mut VecDeque<String>, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    if line.len() > STDERR_RESULT_MAX_LINE_BYTES {
        push_stderr_result_line(lines, STDERR_OMITTED_LONG_LINE.to_string());
    } else {
        push_stderr_result_line(lines, line.into_owned());
    }
}

fn finish_stderr_result_line(
    lines: &mut VecDeque<String>,
    line: &mut Vec<u8>,
    line_omitted: &mut bool,
    strip_trailing_cr: bool,
) {
    if *line_omitted {
        push_stderr_result_line(lines, STDERR_OMITTED_LONG_LINE.to_string());
    } else {
        if strip_trailing_cr && line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > STDERR_RESULT_MAX_LINE_BYTES {
            push_stderr_result_line(lines, STDERR_OMITTED_LONG_LINE.to_string());
        } else {
            push_decoded_stderr_result_line(lines, line);
        }
    }
    line.clear();
    *line_omitted = false;
}

async fn collect_stderr_result_tail<R>(mut stderr: R) -> Vec<String>
where
    R: AsyncRead + Unpin,
{
    let mut lines = VecDeque::with_capacity(STDERR_RESULT_MAX_LINES);
    let mut line = Vec::with_capacity(STDERR_RESULT_MAX_LINE_BYTES.min(1024));
    let mut line_omitted = false;
    let mut buffer = [0u8; STDERR_READ_BUFFER_BYTES];

    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };

        for &byte in buffer.iter().take(read) {
            if byte == b'\n' {
                finish_stderr_result_line(&mut lines, &mut line, &mut line_omitted, true);
                continue;
            }

            if line_omitted {
                continue;
            }

            if line.len() < STDERR_RESULT_MAX_LINE_BYTES
                || (byte == b'\r' && line.len() == STDERR_RESULT_MAX_LINE_BYTES)
            {
                line.push(byte);
            } else {
                line.clear();
                line_omitted = true;
            }
        }
    }

    if !line.is_empty() || line_omitted {
        finish_stderr_result_line(&mut lines, &mut line, &mut line_omitted, false);
    }

    lines.into_iter().collect()
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

struct ClaudeHookHarness {
    _temp_dir: tempfile::TempDir,
    fifo_path: String,
    settings_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeHookEventName {
    SessionStart,
    Stop,
}

struct ClaudeHookEvent {
    name: ClaudeHookEventName,
    payload: Value,
}

#[derive(Default)]
struct TranscriptTail {
    path: Option<String>,
    offset: u64,
    pending: Vec<u8>,
}

#[derive(Default)]
struct ClaudeUsageSummary {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

#[derive(Default)]
struct ClaudeTranscriptSummary {
    session_id: Option<String>,
    final_text: Option<String>,
    saw_assistant: bool,
    is_error: bool,
    num_turns: u64,
    total_cost_usd: f64,
    duration_api_ms: u64,
    usage: ClaudeUsageSummary,
    saw_result: bool,
}

#[derive(Default)]
struct InteractiveEventState {
    seq: u32,
    stuck_tool_tracker: HashMap<String, (String, Instant)>,
    transcript_summary: ClaudeTranscriptSummary,
    claude_result: Option<ClaudeResultSummary>,
    last_read_event_at: Option<Instant>,
}

fn shell_single_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn interactive_hook_entry(script_path: &str, event: &str) -> Value {
    let command = format!("{} {event}", shell_single_quote(script_path));
    json!({
        "matcher": "*",
        "hooks": [{
            "type": "command",
            "command": command,
        }],
    })
}

fn build_interactive_settings(settings: &str, script_path: &str) -> Result<String, AgentError> {
    let mut root = if settings.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(settings).map_err(|e| {
            AgentError::Execution(format!(
                "invalid Claude settings JSON for interactive driver: {e}"
            ))
        })?
    };

    let root_obj = root.as_object_mut().ok_or_else(|| {
        AgentError::Execution("Claude settings JSON must be an object".to_string())
    })?;
    let hooks_value = root_obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks_obj = hooks_value.as_object_mut().ok_or_else(|| {
        AgentError::Execution("Claude settings hooks field must be an object".to_string())
    })?;

    for event in ["SessionStart", "Stop"] {
        let event_hooks = hooks_obj.entry(event).or_insert_with(|| json!([]));
        let event_hooks = event_hooks.as_array_mut().ok_or_else(|| {
            AgentError::Execution(format!(
                "Claude settings hooks.{event} field must be an array"
            ))
        })?;
        event_hooks.insert(0, interactive_hook_entry(script_path, event));
    }

    serde_json::to_string(&root).map_err(|e| AgentError::Execution(e.to_string()))
}

impl ClaudeHookHarness {
    fn create(settings: &str) -> Result<Self, AgentError> {
        let temp_dir = tempfile::Builder::new()
            .prefix("vm0-claude-interactive-")
            .tempdir()?;
        let fifo_path_buf = temp_dir.path().join("hooks.fifo");
        let script_path_buf = temp_dir.path().join("hook.sh");
        let fifo_c = CString::new(fifo_path_buf.as_os_str().as_bytes()).map_err(|e| {
            AgentError::Execution(format!("invalid interactive hook FIFO path: {e}"))
        })?;
        let status = unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) };
        if status != 0 {
            return Err(AgentError::Io(std::io::Error::last_os_error()));
        }

        let fifo_path = fifo_path_buf.to_string_lossy().into_owned();
        let script_path = script_path_buf.to_string_lossy().into_owned();
        let script = format!(
            "#!/bin/sh\nset -eu\nfifo={}\npayload=$(cat)\nprintf '%s\\t%s\\n' \"$1\" \"$payload\" > \"$fifo\"\n",
            shell_single_quote(&fifo_path)
        );
        std::fs::write(&script_path_buf, script)?;
        std::fs::set_permissions(&script_path_buf, std::fs::Permissions::from_mode(0o700))?;
        let settings_json = build_interactive_settings(settings, &script_path)?;

        Ok(Self {
            _temp_dir: temp_dir,
            fifo_path,
            settings_json,
        })
    }

    fn open_fifo(&self) -> Result<std::fs::File, AgentError> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&self.fifo_path)
            .map_err(AgentError::Io)
    }
}

fn drain_fifo_lines(
    fifo: &mut std::fs::File,
    buffer: &mut Vec<u8>,
) -> Result<Vec<String>, AgentError> {
    let mut read_buffer = [0u8; 4096];
    loop {
        match fifo.read(&mut read_buffer) {
            Ok(0) => break,
            Ok(read) => {
                let Some(chunk) = read_buffer.get(..read) else {
                    return Err(AgentError::Execution(
                        "interactive hook FIFO read exceeded buffer length".to_string(),
                    ));
                };
                buffer.extend_from_slice(chunk);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => return Err(AgentError::Io(e)),
        }
    }
    Ok(drain_complete_lines(buffer))
}

fn drain_complete_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut bytes = buffer.drain(..=pos).collect::<Vec<_>>();
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        if !bytes.is_empty() {
            lines.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    lines
}

fn parse_hook_line(line: &str) -> Option<ClaudeHookEvent> {
    let (event_name, payload) = line.split_once('\t')?;
    let name = match event_name {
        "SessionStart" => ClaudeHookEventName::SessionStart,
        "Stop" => ClaudeHookEventName::Stop,
        _ => return None,
    };
    let payload = match serde_json::from_str::<Value>(payload) {
        Ok(payload) => payload,
        Err(e) => {
            log_warn!(LOG_TAG, "Ignoring malformed Claude hook payload: {e}");
            return None;
        }
    };
    Some(ClaudeHookEvent { name, payload })
}

fn hook_string<'a>(payload: &'a Value, field: &str) -> Option<&'a str> {
    payload.get(field).and_then(Value::as_str)
}

fn hook_session_id(payload: &Value) -> Option<&str> {
    hook_string(payload, "session_id").or_else(|| hook_string(payload, "sessionId"))
}

fn hook_transcript_path(payload: &Value) -> Option<&str> {
    hook_string(payload, "transcript_path")
}

fn persist_interactive_session(payload: &Value) {
    if let Some(session_id) = hook_session_id(payload)
        && !session_id.is_empty()
        && !std::path::Path::new(paths::session_id_file()).exists()
    {
        log_info!(
            LOG_TAG,
            "Captured interactive Claude session ID: {session_id}"
        );
        let _ = std::fs::write(paths::session_id_file(), session_id);
    }

    if let Some(transcript_path) = hook_transcript_path(payload)
        && !transcript_path.is_empty()
        && !std::path::Path::new(paths::session_history_path_file()).exists()
    {
        let _ = std::fs::write(paths::session_history_path_file(), transcript_path);
        log_info!(
            LOG_TAG,
            "Interactive Claude transcript will be at: {transcript_path}"
        );
    }
}

impl TranscriptTail {
    fn set_path(&mut self, path: &str) {
        if self.path.as_deref() == Some(path) {
            return;
        }
        self.path = Some(path.to_string());
        self.offset = 0;
        self.pending.clear();
    }

    fn read_new_lines(&mut self) -> Result<Vec<String>, AgentError> {
        let Some(path) = self.path.as_deref() else {
            return Ok(Vec::new());
        };
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AgentError::Io(e)),
        };
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        let read = file.read_to_end(&mut bytes)?;
        self.offset = self.offset.saturating_add(read as u64);
        if read == 0 {
            return Ok(Vec::new());
        }
        self.pending.extend_from_slice(&bytes);
        Ok(drain_complete_lines(&mut self.pending))
    }

    fn finish_pending_line(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let mut bytes = std::mem::take(&mut self.pending);
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        if bytes.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

impl ClaudeUsageSummary {
    fn add_from_value(&mut self, usage: &Value) {
        self.input_tokens = self.input_tokens.saturating_add(
            usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
        self.output_tokens = self.output_tokens.saturating_add(
            usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
        self.cache_read_input_tokens = self.cache_read_input_tokens.saturating_add(
            usage
                .get("cache_read_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
        self.cache_creation_input_tokens = self.cache_creation_input_tokens.saturating_add(
            usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
    }

    fn to_json(&self) -> Value {
        json!({
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
        })
    }
}

impl ClaudeTranscriptSummary {
    fn update_from_event(&mut self, event: &Value) {
        if self.session_id.is_none() {
            self.session_id = event
                .get("session_id")
                .or_else(|| event.get("sessionId"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
        }

        match event.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                self.saw_assistant = true;
                self.num_turns = self.num_turns.saturating_add(1);
                if let Some(text) = assistant_text(event)
                    && !text.is_empty()
                {
                    self.final_text = Some(text);
                }
                if let Some(usage) = event.pointer("/message/usage") {
                    self.usage.add_from_value(usage);
                }
            }
            Some("result") => {
                self.saw_result = true;
                if let Some(result) = event.get("result").and_then(Value::as_str) {
                    self.final_text = Some(result.to_string());
                }
                if let Some(is_error) = event.get("is_error").and_then(Value::as_bool) {
                    self.is_error = is_error;
                }
                if let Some(num_turns) = event.get("num_turns").and_then(Value::as_u64) {
                    self.num_turns = num_turns;
                }
                if let Some(total_cost_usd) = event.get("total_cost_usd").and_then(Value::as_f64) {
                    self.total_cost_usd = total_cost_usd;
                }
                if let Some(duration_api_ms) = event.get("duration_api_ms").and_then(Value::as_u64)
                {
                    self.duration_api_ms = duration_api_ms;
                }
            }
            _ => {}
        }
    }

    fn result_event(&self, duration: Duration, fallback_text: Option<&str>) -> Value {
        let result = self
            .final_text
            .as_deref()
            .or(fallback_text)
            .unwrap_or_default();
        let is_error = self.is_error || (!self.saw_assistant && fallback_text.is_none());
        json!({
            "type": "result",
            "subtype": if is_error { "error" } else { "success" },
            "session_id": self.session_id.as_deref().unwrap_or_default(),
            "result": result,
            "is_error": is_error,
            "duration_ms": duration.as_millis() as u64,
            "duration_api_ms": self.duration_api_ms,
            "num_turns": self.num_turns,
            "total_cost_usd": self.total_cost_usd,
            "usage": self.usage.to_json(),
            "permission_denials": [],
        })
    }
}

fn assistant_text(event: &Value) -> Option<String> {
    let contents = event.pointer("/message/content")?.as_array()?;
    let mut text = String::new();
    for content in contents {
        if content.get("type").and_then(Value::as_str) == Some("text")
            && let Some(block_text) = content.get("text").and_then(Value::as_str)
        {
            text.push_str(block_text);
        }
    }
    Some(text)
}

fn normalize_claude_transcript_event(event: &mut Value) {
    if event.get("session_id").is_some() {
        return;
    }
    let Some(session_id) = event.get("sessionId").cloned() else {
        return;
    };
    let Some(obj) = event.as_object_mut() else {
        return;
    };
    obj.insert("session_id".to_string(), session_id);
}

async fn process_interactive_claude_event_line(
    line: &str,
    log_file: &mut tokio::fs::File,
    masker: &SecretMasker,
    behavior: CliFrameworkBehavior,
    event_tx: &tokio::sync::mpsc::UnboundedSender<PreparedEvent>,
    state: &mut InteractiveEventState,
) -> Result<(), AgentError> {
    let _ = log_file.write_all(line.as_bytes()).await;
    let _ = log_file.write_all(b"\n").await;

    let stripped = line.trim();
    if stripped.is_empty() {
        return Ok(());
    }

    let Ok(mut event) = serde_json::from_str::<Value>(stripped) else {
        return Ok(());
    };

    normalize_claude_transcript_event(&mut event);
    state.transcript_summary.update_from_event(&event);
    state.last_read_event_at = Some(Instant::now());
    if state.seq == 0 {
        timing::record_e2e_from_api("api_to_cli_init");
    }
    if behavior.handles_claude_result_event(&event) {
        state.claude_result = Some(ClaudeResultSummary::from_event(&event));
        if let Some(result) = event.get("result").and_then(Value::as_str) {
            println!("{result}");
        }
    }
    behavior.track_claude_tool_events(&event, &mut state.stuck_tool_tracker);
    if let Some(payload) = events::prepare_event(&mut event, state.seq, masker)
        && event_tx
            .send(PreparedEvent {
                sequence: state.seq,
                payload,
            })
            .is_err()
    {
        log_warn!(
            LOG_TAG,
            "Event channel closed, dropping event seq={}",
            state.seq
        );
    }
    state.seq += 1;
    Ok(())
}

fn duplicate_file(file: &std::fs::File) -> Result<std::fs::File, AgentError> {
    let fd = unsafe { libc::dup(file.as_raw_fd()) };
    if fd < 0 {
        return Err(AgentError::Io(std::io::Error::last_os_error()));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

fn open_pty() -> Result<(std::fs::File, std::fs::File), AgentError> {
    let mut master = -1;
    let mut slave = -1;
    let status = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if status != 0 {
        return Err(AgentError::Io(std::io::Error::last_os_error()));
    }
    let master = unsafe { std::fs::File::from_raw_fd(master) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave) };
    Ok((master, slave))
}

fn configure_claude_command_env(cmd: &mut tokio::process::Command) {
    cmd.env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1");
    cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    cmd.env("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1");
    cmd.env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1");
    cmd.env("DISABLE_AUTOUPDATER", "1");
    cmd.env("DISABLE_ERROR_REPORTING", "1");
    cmd.env("DISABLE_INSTALLATION_CHECKS", "1");
    cmd.env("DISABLE_TELEMETRY", "1");
}

fn signal_process_group(pgid: Option<i32>, signal: i32, reason: &str) {
    if let Some(pid) = pgid {
        log_warn!(LOG_TAG, "{reason}, signal={signal} pgid={pid}");
        unsafe {
            libc::kill(-pid, signal);
        }
    }
}

async fn execute_interactive_claude(
    masker: &SecretMasker,
    mut heartbeat_handle: tokio::task::JoinHandle<Result<(), AgentError>>,
    http: HttpClient,
) -> Result<CliExecutionResult, AgentError> {
    let behavior = CliFrameworkBehavior::new(env::Framework::ClaudeCode);
    log_info!(LOG_TAG, "Starting interactive Claude Code execution...");

    let harness = ClaudeHookHarness::create(env::settings())?;
    let args = build_interactive_claude_args(
        env::resume_session_id(),
        env::append_system_prompt(),
        env::disallowed_tools(),
        env::tools(),
        &harness.settings_json,
    );
    let bin = if env::use_mock_claude() {
        log_info!(LOG_TAG, "Using mock-claude for interactive testing");
        env::mock_claude_path()
    } else {
        "claude".to_string()
    };

    let mut fifo = harness.open_fifo()?;
    let (master, slave) = open_pty()?;
    let master_writer = duplicate_file(&master)?;
    let slave_stdin = duplicate_file(&slave)?;
    let slave_stdout = duplicate_file(&slave)?;
    let slave_stderr = duplicate_file(&slave)?;

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&args)
        .stdin(Stdio::from(slave_stdin))
        .stdout(Stdio::from(slave_stdout))
        .stderr(Stdio::from(slave_stderr))
        .kill_on_drop(true);
    configure_claude_command_env(&mut cmd);
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut log_file = tokio::fs::File::create(paths::agent_log_file()).await?;
    let mut child = cmd.spawn()?;
    drop(slave);

    let pgid = child.id().map(|pid| pid as i32);
    let mut pty_reader = tokio::fs::File::from_std(master);
    let mut pty_writer = tokio::fs::File::from_std(master_writer);
    let pty_drain = tokio::spawn(async move {
        let mut buffer = [0u8; 8192];
        loop {
            match pty_reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

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

    let mut hook_buffer = Vec::new();
    let mut transcript_tail = TranscriptTail::default();
    let mut event_state = InteractiveEventState::default();
    let mut fallback_final_text: Option<String> = None;
    let mut prompt_sent = false;
    let mut stop_seen = false;
    let mut final_drain_armed = false;
    let mut cli_status: Option<std::process::ExitStatus> = None;
    let mut cli_exit_at: Option<Instant> = None;
    let mut stuck_tool_check = {
        let interval = Duration::from_secs(constants::STUCK_TOOL_CHECK_INTERVAL_SECS);
        tokio::time::interval_at(tokio::time::Instant::now() + interval, interval)
    };
    const STUCK_TOOL_NAMES: &[&str] = &["WebSearch", "WebFetch"];

    let mut hook_poll = tokio::time::interval(Duration::from_millis(INTERACTIVE_HOOK_POLL_MS));
    let mut transcript_poll =
        tokio::time::interval(Duration::from_millis(INTERACTIVE_TRANSCRIPT_TAIL_MS));
    let post_stop_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(post_stop_deadline);

    let started_at = Instant::now();
    let event_result: Result<(), AgentError> = loop {
        tokio::select! {
            _ = hook_poll.tick() => {
                let lines = drain_fifo_lines(&mut fifo, &mut hook_buffer)?;
                for line in lines {
                    let Some(event) = parse_hook_line(&line) else {
                        continue;
                    };
                    persist_interactive_session(&event.payload);
                    if let Some(path) = hook_transcript_path(&event.payload) {
                        transcript_tail.set_path(path);
                    }

                    match event.name {
                        ClaudeHookEventName::SessionStart => {
                            if !prompt_sent {
                                pty_writer.write_all(env::prompt().as_bytes()).await?;
                                pty_writer.write_all(b"\r").await?;
                                pty_writer.flush().await?;
                                prompt_sent = true;
                            }
                        }
                        ClaudeHookEventName::Stop => {
                            stop_seen = true;
                            final_drain_armed = true;
                            fallback_final_text = hook_string(&event.payload, "last_assistant_message")
                                .map(ToOwned::to_owned);
                            post_stop_deadline.as_mut().reset(
                                tokio::time::Instant::now()
                                    + Duration::from_millis(INTERACTIVE_POST_STOP_DRAIN_MS),
                            );
                        }
                    }
                }
            }
            _ = transcript_poll.tick() => {
                for line in transcript_tail.read_new_lines()? {
                    process_interactive_claude_event_line(
                        &line,
                        &mut log_file,
                        masker,
                        behavior,
                        &event_tx,
                        &mut event_state,
                    )
                    .await?;
                }
            }
            status = child.wait(), if cli_status.is_none() => {
                match status {
                    Ok(status) => {
                        cli_exit_at = Some(Instant::now());
                        log_info!(LOG_TAG, "Interactive Claude process exited (status: {status})");
                        cli_status = Some(status);
                        if !stop_seen {
                            final_drain_armed = true;
                            post_stop_deadline.as_mut().reset(
                                tokio::time::Instant::now()
                                    + Duration::from_millis(INTERACTIVE_POST_STOP_DRAIN_MS),
                            );
                        }
                    }
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            _ = stuck_tool_check.tick() => {
                let timeout_secs = env::stuck_tool_timeout_secs();
                let stuck = event_state.stuck_tool_tracker
                    .values()
                    .filter(|(name, started)| {
                        started.elapsed().as_secs() >= timeout_secs
                            && STUCK_TOOL_NAMES.contains(&name.as_str())
                    })
                    .min_by_key(|(_, started)| *started)
                    .map(|(name, started)| (name.clone(), started.elapsed().as_secs()));
                if let Some((name, elapsed)) = stuck {
                    let timeout_error = AgentError::Execution(format!(
                        "Tool timeout: {name} exceeded {timeout_secs}s without returning a result"
                    ));
                    log_warn!(
                        LOG_TAG,
                        "Tool timeout: {name} stuck for {elapsed}s in interactive Claude"
                    );
                    signal_process_group(pgid, libc::SIGTERM, "Terminating stuck interactive Claude");
                    break Err(timeout_error);
                }
            }
            hb_result = &mut heartbeat_handle => {
                match hb_result {
                    Ok(Err(e)) => {
                        signal_process_group(pgid, libc::SIGTERM, "Heartbeat failed for interactive Claude");
                        break Err(e);
                    }
                    Ok(Ok(())) => break Ok(()),
                    Err(e) => {
                        signal_process_group(pgid, libc::SIGTERM, "Heartbeat task panicked for interactive Claude");
                        break Err(AgentError::Execution(format!("heartbeat task panicked: {e}")));
                    }
                }
            }
            () = &mut post_stop_deadline, if final_drain_armed => {
                break Ok(());
            }
        }
    };

    if event_result.is_ok() {
        for line in transcript_tail.read_new_lines()? {
            process_interactive_claude_event_line(
                &line,
                &mut log_file,
                masker,
                behavior,
                &event_tx,
                &mut event_state,
            )
            .await?;
        }
        if let Some(line) = transcript_tail.finish_pending_line() {
            process_interactive_claude_event_line(
                &line,
                &mut log_file,
                masker,
                behavior,
                &event_tx,
                &mut event_state,
            )
            .await?;
        }
        if stop_seen && !event_state.transcript_summary.saw_result {
            let result_event = event_state
                .transcript_summary
                .result_event(started_at.elapsed(), fallback_final_text.as_deref());
            let result_line = serde_json::to_string(&result_event)
                .map_err(|e| AgentError::Execution(e.to_string()))?;
            process_interactive_claude_event_line(
                &result_line,
                &mut log_file,
                masker,
                behavior,
                &event_tx,
                &mut event_state,
            )
            .await?;
        }
    }

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
        Some(status) => status,
        None => wait_or_kill_child(&mut child, pgid).await?,
    };
    if cli_exit_at.is_none() {
        cli_exit_at = Some(Instant::now());
    }
    if let (Some(last_read_event_at), Some(cli_exit_at)) =
        (event_state.last_read_event_at, cli_exit_at)
    {
        record_sandbox_op(
            "last_read_event_to_cli_exit",
            cli_exit_at
                .checked_duration_since(last_read_event_at)
                .unwrap_or(Duration::ZERO),
            true,
            None,
        );
    }
    pty_drain.abort();
    let _ = pty_drain.await;

    event_result?;

    let exit_code = if event_state.claude_result.is_some() {
        if event_state.transcript_summary.is_error
            || (stop_seen
                && !event_state.transcript_summary.saw_assistant
                && fallback_final_text.is_none())
        {
            1
        } else {
            0
        }
    } else {
        status.code().unwrap_or(1)
    };

    Ok(CliExecutionResult {
        exit_code,
        stderr_lines: Vec::new(),
        last_event_sequence,
        claude_result: event_state.claude_result,
    })
}

async fn wait_or_kill_child(
    child: &mut tokio::process::Child,
    pgid: Option<i32>,
) -> Result<std::process::ExitStatus, AgentError> {
    if let Some(status) = child.try_wait()? {
        return Ok(status);
    }
    signal_process_group(pgid, libc::SIGTERM, "Terminating interactive Claude");
    let wait = tokio::time::sleep(Duration::from_millis(INTERACTIVE_PROCESS_EXIT_GRACE_MS));
    tokio::pin!(wait);
    tokio::select! {
        status = child.wait() => status.map_err(AgentError::Io),
        () = &mut wait => {
            signal_process_group(pgid, libc::SIGKILL, "Escalating interactive Claude termination");
            child.wait().await.map_err(AgentError::Io)
        }
    }
}

/// Execute the CLI process, streaming JSONL events and racing against heartbeat.
pub async fn execute_cli(
    masker: &SecretMasker,
    mut heartbeat_handle: tokio::task::JoinHandle<Result<(), AgentError>>,
    http: HttpClient,
) -> Result<CliExecutionResult, AgentError> {
    let framework = env::Framework::from_env();
    if matches!(framework, env::Framework::ClaudeCode)
        && matches!(env::claude_driver(), env::ClaudeDriver::Interactive)
    {
        return execute_interactive_claude(masker, heartbeat_handle, http).await;
    }

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
            configure_claude_command_env(&mut cmd);
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
    let mut stderr_handle = tokio::spawn(async move { collect_stderr_result_tail(stderr).await });

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
    fn build_interactive_claude_args_omits_print_mode() {
        disable_system_log();
        let args = build_interactive_claude_args(
            "sess-123",
            "Be helpful.",
            "CronCreate,CronDelete",
            "Bash,Read",
            r#"{"hooks":{}}"#,
        );

        assert!(!args.contains(&"--print".to_string()));
        assert!(!args.contains(&"--output-format".to_string()));
        assert!(!args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert!(args.contains(&"--settings".to_string()));
    }

    #[test]
    fn build_interactive_settings_merges_existing_hooks() {
        let settings = r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"touch /tmp/original"}]}],"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"touch /tmp/user-stop"}]}]}}"#;
        let merged = build_interactive_settings(settings, "/tmp/vm0 hook.sh").unwrap();
        let parsed = serde_json::from_str::<serde_json::Value>(&merged).unwrap();

        let hooks = parsed.get("hooks").unwrap();
        assert_eq!(
            hooks
                .get("PreToolUse")
                .and_then(serde_json::Value::as_array)
                .unwrap()
                .len(),
            1
        );
        let stop_hooks = hooks
            .get("Stop")
            .and_then(serde_json::Value::as_array)
            .unwrap();
        assert_eq!(stop_hooks.len(), 2);
        let first_stop_command = stop_hooks[0]
            .get("hooks")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items[0].get("command"))
            .and_then(serde_json::Value::as_str)
            .unwrap();
        assert!(first_stop_command.contains("'"));
        assert!(first_stop_command.ends_with(" Stop"));
        assert!(hooks.get("SessionStart").is_some());
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
        assert_eq!(args[args.len() - 2], "--");
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
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "follow up");
        // resume is a positional sub-subcommand, NOT a --resume flag
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_codex_args_resume_layout_is_resume_id_prompt() {
        let args = build_codex_args_for_test("/wd", "", "id1", "p1");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args.len(), r_idx + 4);
        assert_eq!(args[r_idx + 1], "id1");
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "p1");
    }

    #[test]
    fn build_codex_args_separates_prompt_from_options() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "id", "hello");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "hello");
    }

    #[test]
    fn build_codex_args_prompt_last_in_no_resume_path() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "", "the prompt");
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "the prompt");
    }

    #[test]
    fn build_codex_args_keeps_dash_prefixed_prompt_as_prompt() {
        let prompt = "--input-format stream-json 是说从一个文件里读取 input 吗？";
        let args = build_codex_args_for_test("/wd", "gpt-5", "", prompt);
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), prompt);
    }

    #[test]
    fn build_codex_args_resume_keeps_dash_prefixed_prompt_as_prompt() {
        let prompt = "--input-format stream-json 是说从一个文件里读取 input 吗？";
        let args = build_codex_args_for_test("/wd", "gpt-5", "id1", prompt);
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[r_idx + 1], "id1");
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], prompt);
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
        assert_eq!(args[args.len() - 2], "--");
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
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "next");
        assert_eq!(args.len(), r_idx + 4);
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
