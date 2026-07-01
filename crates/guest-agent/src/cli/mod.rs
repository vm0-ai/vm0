//! Public facade for CLI setup and execution.
//!
//! This module keeps the external `guest_agent::cli` boundary stable while
//! private submodules own focused execution policies:
//!
//! - `codex_app_server_events`: Codex app-server notification compatibility mapping.
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

mod child_env;
pub mod codex_app_server;
mod codex_app_server_backend;
mod codex_app_server_events;
mod codex_setup;
mod command;
mod diagnostics;
mod event_delivery;
mod framework;
mod process_group;
mod termination;

pub use codex_app_server_events::{CodexAppServerEventError, notification_to_codex_event};
pub use codex_setup::setup_codex_for_config;
pub use framework::{ClaudeResultStatus, ClaudeResultSummary};

use crate::active_input::{ActiveInputController, ActiveInputWriter, ReplayUserEventAction};
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use crate::timing;
use event_delivery::{AckedEventPrefix, PreparedEvent};
use framework::CliFrameworkBehavior;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use guest_contracts::diagnostics::{CliTerminationDiagnostic, FailureDetailSource, FailureReason};
use process_group::ChildProcessGroup;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};
use termination::{
    CliTerminationRuntime, ControlTerminationLog, PostResultCleanupPolicy, TerminationReason,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio::time::Sleep;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(serde::Serialize)]
struct ClaudeUserFrame<'a> {
    #[serde(rename = "type")]
    event_type: &'static str,
    uuid: String,
    parent_tool_use_id: Option<&'static str>,
    message: ClaudeUserMessage<'a>,
}

#[derive(serde::Serialize)]
struct ClaudeUserMessage<'a> {
    role: &'static str,
    content: &'a str,
}

fn claude_user_frame<'a>(uuid: &str, text: &'a str) -> ClaudeUserFrame<'a> {
    ClaudeUserFrame {
        event_type: "user",
        uuid: uuid.to_owned(),
        parent_tool_use_id: None,
        message: ClaudeUserMessage {
            role: "user",
            content: text,
        },
    }
}

#[cfg(test)]
fn claude_initial_prompt_frame<'a>(run_id: &str, prompt: &'a str) -> ClaudeUserFrame<'a> {
    let uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    claude_user_frame(&uuid, prompt)
}

async fn write_claude_user_frame_to_stdin(
    stdin: &mut tokio::process::ChildStdin,
    uuid: &str,
    text: &str,
) -> Result<(), AgentError> {
    let mut line = serde_json::to_vec(&claude_user_frame(uuid, text))?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

async fn write_claude_stream_json_to_stdin(
    mut stdin: tokio::process::ChildStdin,
    run_id: &str,
    prompt: &str,
    mut active_input: ActiveInputWriter,
) -> Result<(), AgentError> {
    let initial_uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    write_claude_user_frame_to_stdin(&mut stdin, &initial_uuid, prompt).await?;
    if !active_input.is_enabled() {
        active_input.close_terminal();
        return Ok(());
    }

    while let Some(frame) = active_input.next_frame().await {
        active_input.mark_writing(&frame.uuid);
        write_claude_user_frame_to_stdin(&mut stdin, &frame.uuid, &frame.text).await?;
        active_input.mark_written(&frame.uuid);
    }

    active_input.close_terminal();
    Ok(())
}

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
    /// Terminal failure message selected from CLI stdout JSONL.
    ///
    /// When produced by [`execute_cli_with_active_input_for_config`], this
    /// message has already been secret-masked, line-break escaped, and bounded
    /// before exposure.
    pub message: String,

    /// High-level source of the stdout-derived failure detail.
    ///
    /// Values produced by [`execute_cli_with_active_input_for_config`] use
    /// `ClaudeResult` for Claude Code terminal result events and `CodexJsonl`
    /// for Codex JSONL failure events. The final run diagnostic may still
    /// prefer stderr when this stdout message is generic.
    pub source: FailureDetailSource,

    /// Optional structured failure reason parsed from supported CLI payloads.
    ///
    /// `None` means no supported structured reason was observed. A reason may
    /// be carried independently from the selected display message, including
    /// when a generic stdout message is replaced by a more specific message or
    /// stderr fallback.
    pub failure_reason: Option<FailureReason>,
}

/// Result returned after the configured CLI process exits.
///
/// The guest agent uses this summary to report final run status and to persist
/// the event-drain watermark consumed by host/API clients.
#[derive(Debug)]
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

    /// Claude Code result that armed post-result cleanup, when cleanup was
    /// armed. This is intentionally separate from `claude_result` because late
    /// drained stdout may contain another result event after cleanup starts.
    pub post_result_cleanup_result: Option<ClaudeResultSummary>,

    /// Best-effort, secret-masked terminal failure diagnostic parsed from CLI
    /// stdout JSONL.
    ///
    /// Some frameworks report terminal failures as JSONL events on stdout, not
    /// stderr. Keeping the diagnostic here lets the guest-agent surface the
    /// actual failure reason in its final run error.
    pub failure_diagnostic: Option<CliFailureDiagnostic>,

    /// Guest-agent control-path error that caused the CLI process group to be
    /// terminated after a meaningful process summary could still be collected.
    pub control_error: Option<AgentError>,

    /// Structured attribution for guest-agent initiated CLI process-group
    /// termination.
    pub cli_termination: Option<CliTerminationDiagnostic>,
}

/// Heartbeat completion signal observed by CLI execution.
///
/// The top-level guest-agent owns the heartbeat task handle so shutdown can
/// stop it before final telemetry. CLI execution only needs this one-shot
/// status while the CLI process is running.
pub enum HeartbeatStatus {
    /// The heartbeat loop returned an error while CLI execution was running.
    ///
    /// CLI execution treats this as a guest-agent control-path failure and may
    /// terminate the CLI process group so final diagnostics can report the
    /// heartbeat failure.
    Failed(AgentError),

    /// The heartbeat loop stopped cleanly.
    ///
    /// During CLI execution this is a non-error completion signal for the
    /// heartbeat race.
    Stopped,

    /// The heartbeat task itself failed, such as a task panic or join error.
    ///
    /// `execute_cli` surfaces this as a guest-agent execution error and may
    /// terminate the CLI process group if no earlier control-path termination
    /// is already in progress.
    TaskFailed(String),
}

/// Optional heartbeat completion receiver for a CLI execution.
///
/// `Some(receiver)` races CLI execution against heartbeat completion. `None`
/// disables heartbeat monitoring for that run, which is useful for tests and
/// callers that do not own a heartbeat task.
pub type HeartbeatMonitor = Option<oneshot::Receiver<HeartbeatStatus>>;

pub(super) struct CliRuntimeConfig<'a> {
    framework: env::Framework,
    run_id: Cow<'a, str>,
    prompt: Cow<'a, str>,
    resume_session_id: Cow<'a, str>,
    append_system_prompt: Cow<'a, str>,
    disallowed_tools: Cow<'a, str>,
    tools: Cow<'a, str>,
    settings: Cow<'a, str>,
    use_mock_claude: bool,
    mock_claude_path: Cow<'a, str>,
    use_mock_codex: bool,
    use_codex_app_server_backend: bool,
    mock_codex_path: Cow<'a, str>,
    home_dir: Cow<'a, str>,
    api_url: Cow<'a, str>,
    api_start_time: Cow<'a, str>,
    openai_model: Cow<'a, str>,
    openai_base_url: Cow<'a, str>,
    codex_oauth_mode: bool,
    stuck_tool_timeout_secs: u64,
    post_result_cleanup_policy: PostResultCleanupPolicy,
    agent_log_file: Cow<'a, str>,
    session_id_file: Cow<'a, str>,
    session_history_path_file: Cow<'a, str>,
    event_error_flag: Cow<'a, str>,
    user_env: &'a HashMap<String, String>,
}

impl<'a> CliRuntimeConfig<'a> {
    fn from_config(config: &'a env::GuestConfig, paths: &'a paths::GuestPaths) -> Self {
        Self {
            framework: config.framework,
            run_id: Cow::Borrowed(&config.run_id),
            prompt: Cow::Borrowed(&config.prompt),
            resume_session_id: Cow::Borrowed(&config.resume_session_id),
            append_system_prompt: Cow::Borrowed(&config.append_system_prompt),
            disallowed_tools: Cow::Borrowed(&config.disallowed_tools),
            tools: Cow::Borrowed(&config.tools),
            settings: Cow::Borrowed(&config.settings),
            use_mock_claude: config.use_mock_claude,
            mock_claude_path: Cow::Borrowed(&config.mock_claude_path),
            use_mock_codex: config.use_mock_codex,
            use_codex_app_server_backend: config.use_codex_app_server_backend,
            mock_codex_path: Cow::Borrowed(&config.mock_codex_path),
            home_dir: Cow::Borrowed(&config.home_dir),
            api_url: Cow::Borrowed(&config.api_url),
            api_start_time: Cow::Borrowed(&config.api_start_time),
            openai_model: Cow::Borrowed(user_env_value(&config.user_env, "OPENAI_MODEL")),
            openai_base_url: Cow::Borrowed(user_env_value(&config.user_env, "OPENAI_BASE_URL")),
            codex_oauth_mode: !user_env_value(&config.user_env, "CHATGPT_ACCOUNT_ID").is_empty(),
            stuck_tool_timeout_secs: config.stuck_tool_timeout_secs,
            post_result_cleanup_policy: PostResultCleanupPolicy::new(
                config.post_result_sigterm_grace,
                config.post_result_total_cap,
                config.post_result_sigkill_grace,
            ),
            agent_log_file: Cow::Borrowed(paths.agent_log_file()),
            session_id_file: Cow::Borrowed(paths.session_id_file()),
            session_history_path_file: Cow::Borrowed(paths.session_history_path_file()),
            event_error_flag: Cow::Borrowed(paths.event_error_flag()),
            user_env: &config.user_env,
        }
    }

    fn codex_home(&self) -> String {
        codex_home_for_home_dir(self.home_dir.as_ref())
    }
}

fn codex_home_for_home_dir(home_dir: &str) -> String {
    crate::codex_auth::codex_home_path(Path::new(home_dir))
        .to_string_lossy()
        .into_owned()
}

fn user_env_value<'a>(user_env: &'a HashMap<String, String>, key: &str) -> &'a str {
    user_env.get(key).map(String::as_str).unwrap_or("")
}

enum ParsedEventAction {
    Forward,
    Skip,
}

struct CliEventIngestor {
    seq: u32,
    run_id: String,
    api_start_time: String,
    last_read_event_at: Option<Instant>,
    session_metadata_capture: events::SessionMetadataCapture,
    failure_diagnostic: Option<CliFailureDiagnostic>,
}

impl CliEventIngestor {
    fn new(runtime: &CliRuntimeConfig<'_>) -> Self {
        Self {
            seq: 0,
            run_id: runtime.run_id.to_string(),
            api_start_time: runtime.api_start_time.to_string(),
            last_read_event_at: None,
            session_metadata_capture: events::SessionMetadataCapture::from_values(
                runtime.framework,
                runtime.home_dir.as_ref(),
                runtime.session_id_file.as_ref(),
                runtime.session_history_path_file.as_ref(),
            ),
            failure_diagnostic: None,
        }
    }

    async fn write_raw_line(log_file: &mut tokio::fs::File, raw_line: impl AsRef<[u8]>) {
        let _ = log_file.write_all(raw_line.as_ref()).await;
        let _ = log_file.write_all(b"\n").await;
    }

    async fn begin_event(
        &mut self,
        log_file: &mut tokio::fs::File,
        raw_line: impl AsRef<[u8]>,
        event: &serde_json::Value,
        masker: &SecretMasker,
        behavior: CliFrameworkBehavior,
    ) -> Result<ParsedEventAction, AgentError> {
        Self::write_raw_line(log_file, raw_line).await;

        if event.get("type").and_then(serde_json::Value::as_str) == Some("stream_event") {
            self.session_metadata_capture
                .register_event_session_identifier(event, masker);
            return Ok(ParsedEventAction::Skip);
        }
        self.last_read_event_at = Some(Instant::now());
        if self.seq == 0 {
            timing::record_e2e_from_api_start("api_to_cli_init", &self.api_start_time);
        }
        self.session_metadata_capture.capture_event(event, masker);

        if behavior.logs_codex_failure_diagnostics()
            && let Some(diagnostic) = events::masked_codex_failure_diagnostic(event, masker)
        {
            let candidate = CliFailureDiagnostic {
                message: diagnostic.message,
                source: FailureDetailSource::CodexJsonl,
                failure_reason: diagnostic.failure_reason,
            };
            log_warn!(
                LOG_TAG,
                "Codex JSONL failure event seq={} type={}: {}",
                self.seq,
                diagnostic.event_type,
                candidate.message
            );
            if let Some(selected) =
                select_failure_diagnostic(self.failure_diagnostic.as_ref(), candidate)
            {
                self.failure_diagnostic = Some(selected);
            }
        }

        Ok(ParsedEventAction::Forward)
    }

    fn replace_failure_diagnostic(&mut self, diagnostic: CliFailureDiagnostic) {
        self.failure_diagnostic = Some(diagnostic);
    }

    fn current_sequence(&self) -> u32 {
        self.seq
    }

    fn enqueue_event(
        &mut self,
        event: serde_json::Value,
        masker: &SecretMasker,
        should_send_events: bool,
        event_tx: &tokio::sync::mpsc::UnboundedSender<PreparedEvent>,
    ) {
        if should_send_events {
            let payload =
                events::prepare_event_payload_for_run_id(event, self.seq, masker, &self.run_id);
            if event_tx
                .send(PreparedEvent::Webhook {
                    sequence: self.seq,
                    payload,
                })
                .is_err()
            {
                log_warn!(
                    LOG_TAG,
                    "Event channel closed, dropping event seq={}",
                    self.seq
                );
            }
        }
        self.seq += 1;
    }

    fn last_read_event_at(&self) -> Option<Instant> {
        self.last_read_event_at
    }

    fn failure_diagnostic(&self) -> Option<CliFailureDiagnostic> {
        self.failure_diagnostic.clone()
    }
}

/// Execute the CLI process using values captured in a [`env::GuestConfig`] and
/// [`paths::GuestPaths`].
///
/// Production guest-agent bootstrap should prefer this entry point so CLI
/// setup observes the same immutable runtime snapshot as the rest of the run.
pub async fn execute_cli_with_active_input_for_config(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
) -> Result<CliExecutionResult, AgentError> {
    let runtime = CliRuntimeConfig::from_config(config, paths);
    execute_cli_inner(masker, heartbeat_monitor, http, active_input, &runtime).await
}

async fn execute_cli_inner(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    if matches!(runtime.framework, env::Framework::Codex) && runtime.use_codex_app_server_backend {
        return codex_app_server_backend::execute_codex_app_server_for_runtime(
            masker,
            heartbeat_monitor,
            http,
            active_input,
            runtime,
        )
        .await;
    }

    let behavior = CliFrameworkBehavior::new(runtime.framework);
    let replay_user_messages = active_input.is_enabled();
    masker.add_sensitive_value(runtime.resume_session_id.as_ref());
    log_info!(LOG_TAG, "Starting {} execution...", behavior.agent_type());

    let cmd = command::build_cli_command_for_runtime(runtime, replay_user_messages)?;
    let (bin, args) = cmd
        .split_first()
        .ok_or_else(|| AgentError::Execution("empty command".into()))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(if behavior.uses_stream_json_stdin() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        // If a future setup step fails after spawn, dropping `Child` must not
        // leave a CLI process running in the VM.
        .kill_on_drop(true);
    child_env::apply_to_tokio_command_for_runtime(&mut cmd, runtime);
    // Set the child cwd explicitly at spawn time so the CLI observes the
    // current canonical workspace mount instead of relying on inherited cwd.
    set_cli_current_dir(&mut cmd, paths::CANONICAL_WORKING_DIR)?;

    match runtime.framework {
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
            // Auth reconciliation and `codex exec` both honor CODEX_HOME;
            // pin it to $HOME/.codex so setup_codex state is visible to exec.
            cmd.env("CODEX_HOME", runtime.codex_home());
            // Test-only mock fixture selector; keep it explicit instead of
            // reopening inherited env for Codex children.
            if runtime.use_mock_codex
                && let Ok(fixture) = std::env::var("MOCK_CODEX_FIXTURE")
            {
                cmd.env("MOCK_CODEX_FIXTURE", fixture);
            }
            if runtime.codex_oauth_mode {
                cmd.env(
                    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
                    crate::codex_auth::REFRESH_TOKEN_NOOP_URL,
                );
            }
        }
    }

    // Open the run log before spawning the CLI. If the run-id-scoped path is
    // invalid or unavailable, fail without starting a child process.
    let log_file = guest_contracts::runtime_paths::create_private(runtime.agent_log_file.as_ref())?;
    let mut log_file = tokio::fs::File::from_std(log_file);

    let mut child = cmd.spawn()?;

    let claude_stdin = if behavior.uses_stream_json_stdin() {
        let Some(stdin) = child.stdin.take() else {
            let _ = child.start_kill();
            return Err(AgentError::Execution("no stdin".into()));
        };
        Some(stdin)
    } else {
        None
    };

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

    let active_input_controller = active_input.controller();
    let mut claude_stdin_write_handle = claude_stdin.map(|stdin| {
        let run_id = runtime.run_id.to_string();
        let prompt = runtime.prompt.to_string();
        tokio::spawn(async move {
            write_claude_stream_json_to_stdin(stdin, &run_id, &prompt, active_input).await
        })
    });

    // Stream stdout JSONL, racing against heartbeat and process exit.
    //
    // Event sending is decoupled from stdout reading via an mpsc channel
    // to prevent a deadlock: Bun (Claude CLI runtime) uses blocking stdout
    // writes, so if the agent's HTTP POSTs are slow and the pipe buffer
    // fills, the CLI's entire event loop blocks — including TCP I/O.
    // See: https://github.com/vm0-ai/vm0/issues/3645
    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let mut stdout_eof = false;

    // Capture the process group ID before wait() reaps the child, since
    // child.id() returns None after the process has been reaped.
    let process_group = ChildProcessGroup::from_group_leader_child_id(child.id());

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
    let mut termination_runtime =
        CliTerminationRuntime::new(process_group, runtime.post_result_cleanup_policy);

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
    let event_error_flag = runtime.event_error_flag.to_string();
    let event_sender = tokio::spawn(async move {
        let mut acked_prefix = AckedEventPrefix::default();
        while let Some(event) = event_rx.recv().await {
            match event {
                PreparedEvent::Webhook { sequence, payload } => {
                    match events::post_event_with_error_flag(
                        &event_http,
                        &payload,
                        &event_error_flag,
                    )
                    .await
                    {
                        Ok(()) => {
                            acked_prefix.record_success(sequence);
                        }
                        Err(e) => {
                            acked_prefix.record_failure(sequence);
                            log_warn!(LOG_TAG, "Event send failed: {e}");
                        }
                    }
                }
            }
        }
        acked_prefix.last_contiguous()
    });

    let mut heartbeat_done = false;
    let mut cli_exit_at: Option<Instant> = None;
    let mut claude_result = None;
    let mut post_result_cleanup_result = None;
    let mut event_ingestor = CliEventIngestor::new(runtime);
    let event_result: Result<(), AgentError> = loop {
        tokio::select! {
            stdin_write_result = async {
                match claude_stdin_write_handle.as_mut() {
                    Some(handle) => Some(handle.await),
                    None => std::future::pending().await,
                }
            }, if claude_stdin_write_handle.is_some() => {
                claude_stdin_write_handle = None;
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_eof,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutEof => break Ok(()),
                }
                let can_terminate_for_stdin_error = termination_runtime
                    .can_begin_initial_prompt_stdin_control_failure(cli_status.is_some());
                match stdin_write_result {
                    Some(Ok(Ok(()))) => {}
                    Some(Ok(Err(error))) if can_terminate_for_stdin_error => {
                        active_input_controller.close_terminal();
                        let error_log = error.to_string();
                        termination_runtime.begin_control_failure(
                            TerminationReason::InitialPromptStdin,
                            error,
                            ControlTerminationLog::ClaudeStdinWriterFailed { error: error_log },
                            termination_deadline.as_mut(),
                        );
                    }
                    Some(Ok(Err(_))) => {
                        active_input_controller.close_terminal();
                    }
                    Some(Err(error)) if can_terminate_for_stdin_error => {
                        active_input_controller.close_terminal();
                        let error_log = error.to_string();
                        let control_error =
                            AgentError::Execution(format!("Claude stdin writer task failed: {error_log}"));
                        termination_runtime.begin_control_failure(
                            TerminationReason::InitialPromptStdin,
                            control_error,
                            ControlTerminationLog::ClaudeStdinWriterTaskFailed { error: error_log },
                            termination_deadline.as_mut(),
                        );
                    }
                    Some(Err(_)) => {
                        active_input_controller.close_terminal();
                    }
                    None => {}
                }
            }
            line_result = reader.next_line(), if !stdout_eof => {
                match line_result {
                    Ok(Some(line)) => {
                        let stripped = line.trim();
                        if stripped.is_empty() {
                            continue;
                        }

                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(stripped) {
                            if behavior.filters_replayed_user_events() && replay_user_messages {
                                match active_input_controller.replay_user_event_action(&event) {
                                    ReplayUserEventAction::External => {}
                                    ReplayUserEventAction::InternalInitialPrompt => {
                                        let _ = log_file
                                            .write_all(
                                                br#"{"type":"vm0_internal","event":"filtered_replayed_initial_prompt"}"#,
                                            )
                                            .await;
                                        let _ = log_file.write_all(b"\n").await;
                                        continue;
                                    }
                                    ReplayUserEventAction::InternalActiveInput => {
                                        let _ = log_file
                                            .write_all(
                                                br#"{"type":"vm0_internal","event":"filtered_replayed_active_input"}"#,
                                            )
                                            .await;
                                        let _ = log_file.write_all(b"\n").await;
                                        continue;
                                    }
                                    ReplayUserEventAction::UnknownPromptUser => {
                                        let _ = log_file
                                            .write_all(
                                                br#"{"type":"vm0_internal","event":"filtered_unknown_prompt_user"}"#,
                                            )
                                            .await;
                                        let _ = log_file.write_all(b"\n").await;
                                        log_warn!(
                                            LOG_TAG,
                                            "Filtered unknown top-level Claude user replay event"
                                        );
                                        continue;
                                    }
                                }
                            }

                            let post_result_cleanup_was_armed =
                                termination_runtime.has_post_result_cleanup();
                            match event_ingestor
                                .begin_event(
                                    &mut log_file,
                                    line.as_bytes(),
                                    &event,
                                    masker,
                                    behavior,
                                )
                                .await?
                            {
                                ParsedEventAction::Forward => {}
                                ParsedEventAction::Skip => continue,
                            }
                            let is_result_event = behavior.handles_claude_result_event(&event);
                            if post_result_cleanup_was_armed || is_result_event {
                                match try_observe_cli_exit(
                                    &mut child,
                                    &mut cli_status,
                                    &mut cli_exit_at,
                                    &active_input_controller,
                                    &mut termination_runtime,
                                    stdout_eof,
                                    drain_deadline.as_mut(),
                                )? {
                                    CliExitObservation::NoNewExit
                                    | CliExitObservation::ExitedDrainingStdout => {}
                                    CliExitObservation::ExitedAndStdoutEof => break Ok(()),
                                }
                            }
                            // Print Claude Code final result to stdout if applicable.
                            if is_result_event {
                                let result_summary = ClaudeResultSummary::from_event(&event);
                                claude_result = Some(result_summary);
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
                                        "Claude JSONL failure result seq={} subtype={subtype}: {}",
                                        event_ingestor.current_sequence(),
                                        candidate.message
                                    );
                                    event_ingestor.replace_failure_diagnostic(candidate);
                                }
                                if let Some(result) = event.get("result").and_then(|v| v.as_str())
                                {
                                    // Guest-agent stdout is captured as
                                    // system-stream logs, so mask before
                                    // printing Claude's final result.
                                    println!("{}", masker.mask_string(result));
                                }
                                let active_input_idle =
                                    active_input_controller.close_for_result_if_idle();
                                // Arm the post-result reap deadline once per
                                // run when no active follow-up input is still
                                // pending.
                                if active_input_idle
                                    && termination_runtime.arm_post_result_cleanup(
                                        cli_status.is_some(),
                                        termination_deadline.as_mut(),
                                    )
                                {
                                    post_result_cleanup_result = Some(result_summary);
                                }
                            }
                            // Extract tool info BEFORE masking (masker may replace tool names).
                            behavior.track_claude_tool_events(&event, &mut stuck_tool_tracker);
                            termination_runtime.record_post_result_activity(
                                post_result_cleanup_was_armed,
                                termination_deadline.as_mut(),
                            );
                            // Prepare event payload (mask secrets, add seq) and enqueue
                            // for background sending. Network I/O stays off the reading loop.
                            event_ingestor.enqueue_event(event, masker, should_send_events, &event_tx);
                        } else {
                            CliEventIngestor::write_raw_line(&mut log_file, line.as_bytes()).await;
                        }
                    }
                    Ok(None) => {
                        stdout_eof = true;
                        active_input_controller.close_terminal();
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
                        if matches!(
                            record_cli_exit(
                                s,
                                &mut cli_status,
                                &mut cli_exit_at,
                                &active_input_controller,
                                &mut termination_runtime,
                                stdout_eof,
                                drain_deadline.as_mut(),
                            ),
                            CliExitObservation::ExitedAndStdoutEof
                        ) {
                            break Ok(());
                        }
                    }
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            () = &mut termination_deadline, if termination_runtime.has_pending_deadline() && cli_status.is_none() => {
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_eof,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutEof => break Ok(()),
                }
                termination_runtime.handle_deadline(termination_deadline.as_mut());
            }
            () = &mut drain_deadline, if cli_status.is_some() => {
                log_warn!(
                    LOG_TAG,
                    "Stdout drain deadline reached after {}s, possible orphaned child process",
                    constants::STDOUT_DRAIN_DEADLINE_SECS,
                );
                break Ok(());
            }
            _ = tick_optional_interval(&mut stuck_tool_check), if cli_status.is_none() => {
                let timeout_secs = runtime.stuck_tool_timeout_secs;
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
                {
                    match try_observe_cli_exit(
                        &mut child,
                        &mut cli_status,
                        &mut cli_exit_at,
                        &active_input_controller,
                        &mut termination_runtime,
                        stdout_eof,
                        drain_deadline.as_mut(),
                    )? {
                        CliExitObservation::NoNewExit => {}
                        CliExitObservation::ExitedDrainingStdout => continue,
                        CliExitObservation::ExitedAndStdoutEof => break Ok(()),
                    }
                    let timeout_error = AgentError::Execution(format!(
                        "Tool timeout: {name} exceeded {timeout_secs}s without returning a result"
                    ));
                    termination_runtime.begin_control_failure(
                        TerminationReason::StuckTool,
                        timeout_error,
                        ControlTerminationLog::StuckTool { name, elapsed },
                        termination_deadline.as_mut(),
                    );
                }
            }
            heartbeat_result = async {
                match heartbeat_monitor.as_mut() {
                    Some(receiver) => receiver.await,
                    None => {
                        std::future::pending::<Result<HeartbeatStatus, oneshot::error::RecvError>>()
                            .await
                    }
                }
            }, if !heartbeat_done && cli_status.is_none() => {
                heartbeat_done = true;
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_eof,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutEof => break Ok(()),
                }
                match heartbeat_result {
                    Ok(HeartbeatStatus::Failed(e)) => {
                        // Heartbeat failed — kill process group
                        termination_runtime.begin_control_failure(
                            TerminationReason::HeartbeatError,
                            e,
                            ControlTerminationLog::HeartbeatFailed,
                            termination_deadline.as_mut(),
                        );
                    }
                    Ok(HeartbeatStatus::Stopped) => {
                        // Heartbeat shutdown (should not happen before CLI exits)
                        break Ok(());
                    }
                    Ok(HeartbeatStatus::TaskFailed(message)) => {
                        let error = AgentError::Execution(format!("heartbeat task panicked: {message}"));
                        termination_runtime.begin_control_failure(
                            TerminationReason::HeartbeatPanic,
                            error,
                            ControlTerminationLog::HeartbeatTaskPanicked,
                            termination_deadline.as_mut(),
                        );
                    }
                    Err(e) => {
                        let error = AgentError::Execution(format!("heartbeat task stopped before reporting status: {e}"));
                        termination_runtime.begin_control_failure(
                            TerminationReason::HeartbeatPanic,
                            error,
                            ControlTerminationLog::HeartbeatStoppedBeforeStatus,
                            termination_deadline.as_mut(),
                        );
                    }
                }
            }
        }
    };

    active_input_controller.close_terminal();
    if let Some(handle) = claude_stdin_write_handle.take() {
        if handle.is_finished() {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    log_warn!(
                        LOG_TAG,
                        "Claude stdin writer finished after CLI loop with error: {error}"
                    );
                }
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Claude stdin writer failed after CLI loop: {error}"
                    );
                }
            }
        } else {
            handle.abort();
            let _ = handle.await;
            log_info!(LOG_TAG, "Stopped Claude stdin writer after CLI loop");
        }
    }

    let has_control_error = termination_runtime.has_control_error();
    let event_error = if has_control_error {
        None
    } else {
        event_result.err()
    };

    // Close the channel so the background sender can finish.
    // On error (e.g. heartbeat failure) the server is likely unreachable,
    // so we drop unsent events to avoid stalling on retries.
    drop(event_tx);
    let mut last_event_sequence = None;
    if event_error.is_none() && !has_control_error {
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
    if let (Some(last_read_event_at), Some(cli_exit_at)) =
        (event_ingestor.last_read_event_at(), cli_exit_at)
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
    let masked_stderr_lines = masker.mask_diagnostic_lines(stderr_lines);

    let (control_error, cli_termination) = termination_runtime.finish(exit_code);

    if let Some(err) = event_error {
        return Err(err);
    }

    Ok(CliExecutionResult {
        exit_code,
        stderr_lines: masked_stderr_lines,
        last_event_sequence,
        claude_result,
        post_result_cleanup_result,
        failure_diagnostic: event_ingestor.failure_diagnostic(),
        control_error,
        cli_termination,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliExitObservation {
    NoNewExit,
    ExitedDrainingStdout,
    ExitedAndStdoutEof,
}

fn try_observe_cli_exit(
    child: &mut tokio::process::Child,
    cli_status: &mut Option<ExitStatus>,
    cli_exit_at: &mut Option<Instant>,
    active_input_controller: &ActiveInputController,
    termination_runtime: &mut CliTerminationRuntime,
    stdout_eof: bool,
    drain_deadline: Pin<&mut Sleep>,
) -> Result<CliExitObservation, AgentError> {
    if cli_status.is_some() {
        return Ok(CliExitObservation::NoNewExit);
    }

    let Some(status) = child.try_wait().map_err(AgentError::Io)? else {
        return Ok(CliExitObservation::NoNewExit);
    };

    Ok(record_cli_exit(
        status,
        cli_status,
        cli_exit_at,
        active_input_controller,
        termination_runtime,
        stdout_eof,
        drain_deadline,
    ))
}

fn record_cli_exit(
    status: ExitStatus,
    cli_status: &mut Option<ExitStatus>,
    cli_exit_at: &mut Option<Instant>,
    active_input_controller: &ActiveInputController,
    termination_runtime: &mut CliTerminationRuntime,
    stdout_eof: bool,
    mut drain_deadline: Pin<&mut Sleep>,
) -> CliExitObservation {
    debug_assert!(cli_status.is_none(), "CLI exit recorded more than once");
    *cli_exit_at = Some(Instant::now());
    log_info!(
        LOG_TAG,
        "CLI process exited (status: {status}), draining stdout"
    );
    *cli_status = Some(status);
    active_input_controller.close_terminal();
    // CLI exited on its own (possibly in response to our SIGTERM). Park the
    // termination FSM so it can't re-arm on late result/control events while
    // stdout is draining.
    termination_runtime.mark_child_exited();
    if stdout_eof {
        return CliExitObservation::ExitedAndStdoutEof;
    }

    drain_deadline.as_mut().reset(
        tokio::time::Instant::now() + Duration::from_secs(constants::STDOUT_DRAIN_DEADLINE_SECS),
    );
    CliExitObservation::ExitedDrainingStdout
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
    use super::termination::{CliTerminationRuntime, PostResultCleanupPolicy};
    use super::{
        CliExitObservation, CliFailureDiagnostic, claude_initial_prompt_frame,
        codex_home_for_home_dir, record_cli_exit, select_failure_diagnostic, set_cli_current_dir,
        with_carried_failure_reason,
    };
    use crate::active_input::ActiveInputRuntime;
    use guest_contracts::diagnostics::{FailureDetailSource, FailureReason};
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    use std::time::Duration;

    #[test]
    fn claude_initial_prompt_frame_matches_stream_json_user_shape() {
        let frame = serde_json::to_value(claude_initial_prompt_frame("run_123", "hello stdin"))
            .expect("serialize prompt frame");

        assert_eq!(
            frame.get("type").and_then(serde_json::Value::as_str),
            Some("user")
        );
        assert_eq!(
            frame
                .pointer("/message/role")
                .and_then(serde_json::Value::as_str),
            Some("user")
        );
        assert_eq!(
            frame
                .pointer("/message/content")
                .and_then(serde_json::Value::as_str),
            Some("hello stdin")
        );
        assert!(
            frame
                .get("parent_tool_use_id")
                .is_some_and(serde_json::Value::is_null)
        );
        let uuid = frame
            .get("uuid")
            .and_then(serde_json::Value::as_str)
            .expect("uuid");
        uuid::Uuid::parse_str(uuid).expect("valid uuid");
    }

    #[test]
    fn codex_home_uses_shared_path_semantics_for_empty_home() {
        assert_eq!(codex_home_for_home_dir(""), ".codex");
        assert_eq!(codex_home_for_home_dir("/tmp/home"), "/tmp/home/.codex");
    }

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

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_exit_observation_distinguishes_stdout_drain_from_loop_completion() {
        let active_input = ActiveInputRuntime::new_disabled("run-exit-observation");
        let controller = active_input.controller();
        let termination_deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(termination_deadline);
        let drain_deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(drain_deadline);
        let mut runtime = CliTerminationRuntime::new(
            None,
            PostResultCleanupPolicy::new(
                Duration::from_secs(3),
                Duration::from_secs(60),
                Duration::from_secs(1),
            ),
        );
        assert!(runtime.arm_post_result_cleanup(false, termination_deadline.as_mut()));

        let mut cli_status = None;
        let mut cli_exit_at = None;
        let observation = record_cli_exit(
            std::process::ExitStatus::from_raw(0),
            &mut cli_status,
            &mut cli_exit_at,
            &controller,
            &mut runtime,
            false,
            drain_deadline.as_mut(),
        );

        assert_eq!(observation, CliExitObservation::ExitedDrainingStdout);
        assert!(cli_status.is_some());
        assert!(cli_exit_at.is_some());
        assert!(!runtime.has_pending_deadline());
        assert!(!runtime.has_post_result_cleanup());
        assert!(!runtime.arm_post_result_cleanup(false, termination_deadline.as_mut()));
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
        for generic_message in [
            "turn failed",
            "Turn failed.",
            "Unknown error",
            "codex error",
        ] {
            assert_eq!(
                select_failure_diagnostic(
                    Some(&CliFailureDiagnostic {
                        message: "You've hit your usage limit.".to_string(),
                        source: FailureDetailSource::CodexJsonl,
                        failure_reason: None,
                    }),
                    CliFailureDiagnostic {
                        message: generic_message.to_string(),
                        source: FailureDetailSource::CodexJsonl,
                        failure_reason: None,
                    },
                ),
                None,
                "generic message should not replace specific diagnostic: {generic_message}"
            );
        }
    }

    #[test]
    fn generic_codex_failure_diagnostic_replaces_prior_generic_event() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "Unknown error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            },
        );

        assert_eq!(
            selected,
            Some(CliFailureDiagnostic {
                message: "Unknown error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            })
        );
    }

    #[test]
    fn generic_codex_failure_diagnostic_does_not_replace_specific_claude_result() {
        assert_eq!(
            select_failure_diagnostic(
                Some(&CliFailureDiagnostic {
                    message: "Claude result failure".to_string(),
                    source: FailureDetailSource::ClaudeResult,
                    failure_reason: None,
                }),
                CliFailureDiagnostic {
                    message: "Unknown error".to_string(),
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
