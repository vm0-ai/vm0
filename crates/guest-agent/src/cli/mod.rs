//! Public facade for CLI setup and execution.
//!
//! This module keeps the external `guest_agent::cli` boundary stable while
//! private submodules own focused execution policies:
//!
//! - `codex_app_server_events`: Codex app-server notification compatibility mapping.
//! - `codex_setup`: pre-exec Codex auth/bootstrap.
//! - `command`: Claude Code command construction.
//! - `diagnostics`: bounded stderr tail collection.
//! - `event_delivery`: event sender watermark state.
//! - `claude`: Claude result parsing and tool tracking.
//! - `termination`: process-group termination FSM.
//!
//! `execute_cli` owns the Claude Code subprocess orchestration, while
//! `codex_app_server_backend` owns the Codex JSON-RPC lifecycle and
//! Pi uses the same JSONL subprocess lifecycle as Claude Code. Each path retains
//! ownership of its process, event delivery, heartbeat races, and child
//! reaping until completion.

mod child_env;
mod child_exit_notifier;
mod claude;
#[doc(hidden)]
pub mod codex_app_server;
mod codex_app_server_backend;
mod codex_app_server_events;
mod codex_event_delivery;
mod codex_runtime_config;
mod codex_setup;
mod codex_startup;
mod command;
mod diagnostics;
mod event_delivery;
mod exec_boundary;
mod line_reader;
mod process_group;
mod termination;

pub use claude::{ClaudeResultStatus, ClaudeResultSummary};
pub use codex_setup::setup_codex_for_config;
pub use codex_startup::CodexStartupTiming;

use crate::active_input::{ActiveInputController, ActiveInputWriter, ReplayUserEventAction};
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::failure_patterns;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use crate::timing;
use event_delivery::{EventDeliveryRuntime, EventDeliverySender};
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use guest_contracts::diagnostics::{
    CliObservedExitDiagnostic, CliTerminationDiagnostic, EventDeliveryDiagnostic,
    FailureDetailSource, FailureReason,
};
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
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
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio::time::Sleep;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const OPENAI_BASE_URL_ENV_KEY: &str = "OPENAI_BASE_URL";
const ZERO_AGENT_ID_ENV_KEY: &str = "ZERO_AGENT_ID";
const OKOU_AGENT_ID_ENV_KEY: &str = "OKOU_AGENT_ID";
const CLI_PACKAGE_URL_ENV_KEY: &str = "CLI_PKG_URL";
const WEB_SEARCH_TOOL_NAME: &str = "WebSearch";
const CODEX_FIXED_STARTUP_CONFIGS: [&str; 4] = [
    "analytics.enabled=false",
    "features.plugins=false",
    "features.apps=false",
    "features.goals=false",
];
const CODEX_FAST_MODE_STARTUP_CONFIGS: [&str; 2] =
    ["features.fast_mode=true", r#"service_tier="fast""#];
const CODEX_WEB_SEARCH_DISABLED_CONFIG: &str = r#"web_search="disabled""#;

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
        if let Err(error) =
            write_claude_user_frame_to_stdin(&mut stdin, &frame.uuid, &frame.text).await
        {
            active_input.mark_backend_failed(&frame);
            return Err(error);
        }
        active_input.mark_backend_accepted_with_replay(&frame)?;
    }

    active_input.close_terminal();
    Ok(())
}

async fn write_pi_prompt_to_stdin(
    mut stdin: tokio::process::ChildStdin,
    run_id: &str,
    prompt: &str,
    active_input: ActiveInputWriter,
) -> Result<(), AgentError> {
    let initial_uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    write_claude_user_frame_to_stdin(&mut stdin, &initial_uuid, prompt).await?;
    active_input.close_terminal();
    Ok(())
}

/// Bounded terminal failure detail extracted from a CLI event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliFailureDiagnostic {
    /// Terminal failure message selected from a CLI event.
    ///
    /// When produced by [`execute_cli_with_active_input_for_config`], this
    /// message has already been secret-masked, line-break escaped, and bounded
    /// before exposure.
    pub message: String,

    /// High-level source of the event-derived failure detail.
    ///
    /// Values produced by [`execute_cli_with_active_input_for_config`] use
    /// `ClaudeResult` for Claude Code terminal result events and `CodexJsonl`
    /// for Codex compatibility JSONL failure events. The final run diagnostic
    /// may still prefer stderr when this event message is generic.
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
    /// Terminal outcome code for the configured CLI backend.
    ///
    /// For Claude Code execution, this is the CLI process exit code. On Unix,
    /// signal termination is mapped to `128 + signal`, matching shell
    /// convention, so SIGKILL is reported as `137`.
    ///
    /// For Codex app-server execution, completed turns map to `0`, while failed
    /// or interrupted turns and terminal non-retry errors map to `1`. These are
    /// protocol-level outcomes, not the child process wait status.
    pub exit_code: i32,

    /// Raw CLI process exit observation before signal exits are flattened, when
    /// available.
    ///
    /// `None` means raw process-exit attribution is unavailable. Codex
    /// app-server execution leaves this unset because its outcome is derived
    /// from terminal protocol events, not the child process wait status.
    pub cli_observed_exit: Option<CliObservedExitDiagnostic>,

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

    /// Bounded event-delivery failure details, when delivery was terminally incomplete.
    pub event_delivery: Option<EventDeliveryDiagnostic>,

    /// Claude Code's final result metadata, when a terminal result event was
    /// observed. Codex uses its own event schema and leaves this unset.
    pub claude_result: Option<ClaudeResultSummary>,

    /// Claude Code result that armed post-result cleanup, when cleanup was
    /// armed. This is intentionally separate from `claude_result` because late
    /// drained stdout may contain another result event after cleanup starts.
    pub post_result_cleanup_result: Option<ClaudeResultSummary>,

    /// Best-effort, secret-masked terminal failure diagnostic parsed from the
    /// framework event stream.
    ///
    /// Frameworks can report terminal failures as structured events rather
    /// than stderr. Keeping the diagnostic here lets the guest-agent surface
    /// the actual failure reason in its final run error.
    pub failure_diagnostic: Option<CliFailureDiagnostic>,

    /// Guest-agent control-path error that caused the CLI process group to be
    /// terminated after a meaningful process summary could still be collected.
    pub control_error: Option<AgentError>,

    /// Structured attribution for guest-agent initiated CLI process-group
    /// termination.
    pub cli_termination: Option<CliTerminationDiagnostic>,

    /// Backend-accepted delivery identities settled or recoverable at completion.
    pub active_input_delivery_ids: Vec<String>,
}

/// How top-level guest-agent handling should settle a finished CLI execution.
///
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

#[derive(Clone, Copy)]
struct AgentExecutionDeadline {
    at: Instant,
    timeout_secs: u64,
}

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
    mock_codex_path: Cow<'a, str>,
    home_dir: Cow<'a, str>,
    api_url: Cow<'a, str>,
    api_start_time: Cow<'a, str>,
    anthropic_model: Cow<'a, str>,
    openai_model: Cow<'a, str>,
    openai_base_url: Cow<'a, str>,
    codex_runtime_config: Option<codex_runtime_config::CodexRuntimeConfig>,
    codex_oauth_mode: bool,
    codex_fast_mode: bool,
    disable_builtin_web_search: bool,
    agent_execution_deadline: Option<AgentExecutionDeadline>,
    stuck_tool_timeout_secs: u64,
    post_result_cleanup_policy: PostResultCleanupPolicy,
    agent_log_file: Cow<'a, str>,
    session_id_file: Cow<'a, str>,
    session_history_path_file: Cow<'a, str>,
    pi_session_id: Cow<'a, str>,
    pi_system_prompt: Cow<'a, str>,
    pi_model_config: Cow<'a, str>,
    user_env: &'a HashMap<String, String>,
}

impl<'a> CliRuntimeConfig<'a> {
    fn from_config(
        config: &'a env::GuestConfig,
        paths: &'a paths::GuestPaths,
        execution_started_at: Instant,
    ) -> Result<Self, AgentError> {
        let codex_runtime_config = if matches!(config.framework, env::Framework::Codex) {
            codex_runtime_config::parse_raw(&config.codex_runtime_config)?
        } else {
            None
        };
        let disable_builtin_web_search = config.user_env.contains_key(OKOU_AGENT_ID_ENV_KEY)
            || config.user_env.contains_key(ZERO_AGENT_ID_ENV_KEY);
        let disallowed_tools = disallowed_tools_with_builtin_web_search_disabled(
            &config.disallowed_tools,
            disable_builtin_web_search,
        );
        let agent_execution_deadline = config
            .agent_execution_timeout
            .map(|timeout| {
                execution_started_at
                    .checked_add(timeout)
                    .map(|at| AgentExecutionDeadline {
                        at,
                        timeout_secs: timeout.as_secs(),
                    })
                    .ok_or_else(|| {
                        AgentError::Execution(format!(
                            "{} is too large",
                            guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV
                        ))
                    })
            })
            .transpose()?;
        Ok(Self {
            framework: config.framework,
            run_id: Cow::Borrowed(&config.run_id),
            prompt: Cow::Borrowed(&config.prompt),
            resume_session_id: Cow::Borrowed(&config.resume_session_id),
            append_system_prompt: Cow::Borrowed(&config.append_system_prompt),
            disallowed_tools,
            tools: Cow::Borrowed(&config.tools),
            settings: Cow::Borrowed(&config.settings),
            use_mock_claude: config.use_mock_claude,
            mock_claude_path: Cow::Borrowed(&config.mock_claude_path),
            use_mock_codex: config.use_mock_codex,
            mock_codex_path: Cow::Borrowed(&config.mock_codex_path),
            home_dir: Cow::Borrowed(&config.home_dir),
            api_url: Cow::Borrowed(&config.api_url),
            api_start_time: Cow::Borrowed(&config.api_start_time),
            anthropic_model: Cow::Borrowed(user_env_value(&config.user_env, "ANTHROPIC_MODEL")),
            openai_model: Cow::Borrowed(user_env_value(&config.user_env, "OPENAI_MODEL")),
            openai_base_url: Cow::Borrowed(user_env_value(
                &config.user_env,
                OPENAI_BASE_URL_ENV_KEY,
            )),
            codex_runtime_config,
            codex_oauth_mode: !user_env_value(&config.user_env, "CHATGPT_ACCOUNT_ID").is_empty(),
            codex_fast_mode: user_env_value(&config.user_env, "VM0_CODEX_SERVICE_TIER") == "fast",
            disable_builtin_web_search,
            agent_execution_deadline,
            stuck_tool_timeout_secs: config.stuck_tool_timeout_secs,
            post_result_cleanup_policy: PostResultCleanupPolicy::new(
                config.post_result_sigterm_grace,
                config.post_result_total_cap,
                config.post_result_sigkill_grace,
            ),
            agent_log_file: Cow::Borrowed(paths.agent_log_file()),
            session_id_file: Cow::Borrowed(paths.session_id_file()),
            session_history_path_file: Cow::Borrowed(paths.session_history_path_file()),
            pi_session_id: Cow::Borrowed(&config.pi_session_id),
            pi_system_prompt: Cow::Borrowed(&config.pi_system_prompt),
            pi_model_config: Cow::Borrowed(&config.pi_model_config),
            user_env: &config.user_env,
        })
    }

    fn codex_home(&self) -> String {
        codex_home_for_home_dir(self.home_dir.as_ref())
    }

    fn codex_startup_config_overrides(&self) -> Vec<String> {
        let codex_home = self.codex_home();
        let mut overrides = codex_runtime_config::startup_config_overrides(
            self.codex_runtime_config.as_ref(),
            Path::new(&codex_home),
        );
        if self.codex_runtime_config.is_none() && !self.openai_base_url.is_empty() {
            let base_url =
                codex_runtime_config::quote_toml_basic_string(self.openai_base_url.as_ref());
            overrides.push(format!("openai_base_url={base_url}"));
        }
        if self.disable_builtin_web_search {
            overrides.push(CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string());
        }
        overrides.extend(CODEX_FIXED_STARTUP_CONFIGS.map(str::to_string));
        if self.codex_fast_mode {
            overrides.extend(CODEX_FAST_MODE_STARTUP_CONFIGS.map(str::to_string));
        }
        overrides
    }

    fn codex_model_provider_id(&self) -> Option<&str> {
        self.codex_runtime_config
            .as_ref()
            .map(|config| config.provider_id.as_str())
    }

    fn child_user_env(&self) -> Cow<'_, HashMap<String, String>> {
        if self.codex_runtime_config.is_none()
            || !self.user_env.contains_key(OPENAI_BASE_URL_ENV_KEY)
        {
            return Cow::Borrowed(self.user_env);
        }
        // Structured Codex runtime config is authoritative; do not let stale
        // provider env leak a conflicting base URL into the child process.
        let mut user_env = self.user_env.clone();
        user_env.remove(OPENAI_BASE_URL_ENV_KEY);
        Cow::Owned(user_env)
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

const PI_NODE_OPTIONS: &str = "--disable-warning=ExperimentalWarning";
// Remove after the Phase 1 Runner release is live and every queued or active
// context pinned to a legacy commit-addressed Pi CLI artifact has drained.
const LEGACY_PI_RUN_ID_ENV: &str = "VM0_RUN_ID";

fn build_pi_command_for_runtime(runtime: &CliRuntimeConfig<'_>) -> Result<Vec<String>, AgentError> {
    for (name, value) in [
        ("Pi session id", runtime.pi_session_id.as_ref()),
        ("Pi system prompt", runtime.pi_system_prompt.as_ref()),
        ("Pi model config", runtime.pi_model_config.as_ref()),
    ] {
        if value.is_empty() {
            return Err(AgentError::Execution(format!(
                "{name} is required for Pi execution"
            )));
        }
    }
    let package_url = runtime
        .user_env
        .get(CLI_PACKAGE_URL_ENV_KEY)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentError::Execution(format!(
                "{CLI_PACKAGE_URL_ENV_KEY} is required for Pi execution"
            ))
        })?;
    Ok(vec![
        "npx".to_string(),
        "--yes".to_string(),
        format!("--package={package_url}"),
        "okou".to_string(),
        "__agent-loop".to_string(),
    ])
}

fn pi_child_env_values(runtime: &CliRuntimeConfig<'_>) -> [(String, String); 6] {
    let run_id = runtime.run_id.to_string();
    [
        (guest_contracts::env::RUN_ID_ENV.to_string(), run_id.clone()),
        (LEGACY_PI_RUN_ID_ENV.to_string(), run_id),
        (
            guest_contracts::env::PI_SESSION_ID_ENV.to_string(),
            runtime.pi_session_id.to_string(),
        ),
        (
            guest_contracts::env::PI_SYSTEM_PROMPT_ENV.to_string(),
            runtime.pi_system_prompt.to_string(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV.to_string(),
            runtime.pi_model_config.to_string(),
        ),
        // Pi 0.84.1 uses node:sqlite, which emits an experimental warning on
        // the sandbox's Node 22 runtime. Keep stderr available for actionable
        // diagnostics while suppressing only that warning category.
        ("NODE_OPTIONS".to_string(), PI_NODE_OPTIONS.to_string()),
    ]
}

fn disallowed_tools_with_builtin_web_search_disabled(
    disallowed_tools: &str,
    disable_builtin_web_search: bool,
) -> Cow<'_, str> {
    if !disable_builtin_web_search
        || disallowed_tools
            .split(',')
            .any(|tool| tool.trim() == WEB_SEARCH_TOOL_NAME)
    {
        return Cow::Borrowed(disallowed_tools);
    }
    if disallowed_tools.is_empty() {
        return Cow::Borrowed(WEB_SEARCH_TOOL_NAME);
    }
    Cow::Owned(format!("{disallowed_tools},{WEB_SEARCH_TOOL_NAME}"))
}

enum ParsedEventAction {
    Forward,
    Skip,
}

struct CliEventIngestor<'a> {
    framework: env::Framework,
    seq: u32,
    api_start_time: String,
    last_read_event_at: Option<Instant>,
    session_metadata_capture: events::SessionMetadataCapture,
    failure_diagnostic: Option<CliFailureDiagnostic>,
    codex_startup: Option<&'a CodexStartupTiming>,
}

impl<'a> CliEventIngestor<'a> {
    fn new(runtime: &CliRuntimeConfig<'_>, codex_startup: Option<&'a CodexStartupTiming>) -> Self {
        Self {
            framework: runtime.framework,
            seq: 0,
            api_start_time: runtime.api_start_time.to_string(),
            last_read_event_at: None,
            session_metadata_capture: events::SessionMetadataCapture::from_values(
                runtime.framework,
                runtime.home_dir.as_ref(),
                runtime.session_id_file.as_ref(),
                runtime.session_history_path_file.as_ref(),
            ),
            failure_diagnostic: None,
            codex_startup,
        }
    }

    fn record_e2e_from_api_start_at(&self, op_name: &str, observed_at_ms: u64) {
        timing::record_e2e_from_api_start_at(op_name, &self.api_start_time, observed_at_ms);
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
        framework: env::Framework,
    ) -> Result<ParsedEventAction, AgentError> {
        let is_stream_event =
            event.get("type").and_then(serde_json::Value::as_str) == Some("stream_event");
        if !is_stream_event
            && matches!(framework, env::Framework::Codex)
            && event.get("type").and_then(serde_json::Value::as_str) == Some("turn.started")
            && let Some(codex_startup) = self.codex_startup
        {
            codex_startup.record_success_at(Instant::now());
        }
        Self::write_raw_line(log_file, raw_line).await;

        if is_stream_event {
            return Ok(ParsedEventAction::Skip);
        }
        self.last_read_event_at = Some(Instant::now());
        if self.seq == 0 {
            timing::record_e2e_from_api_start("api_to_cli_init", &self.api_start_time);
        }
        self.session_metadata_capture.capture_event(event);

        if matches!(framework, env::Framework::Codex)
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
        event_tx: &EventDeliverySender,
    ) -> Result<(), AgentError> {
        let sequence = self.seq;
        self.seq += 1;
        if should_send_events {
            let event = events::prepare_event_for_delivery(event, sequence, masker);
            if self.framework == env::Framework::Codex {
                let prepared = codex_event_delivery::prepare_for_delivery(
                    event,
                    event_tx.max_serialized_event_bytes(),
                )?;
                if let Some(reduction) = prepared.reduction {
                    log_warn!(
                        LOG_TAG,
                        "Codex event reduced for delivery: seq={} event_type={} item_type={} original_bytes={} delivered_bytes={} fields={} fallback={}",
                        sequence,
                        reduction.event_type,
                        reduction.item_type,
                        reduction.original_bytes,
                        reduction.delivered_bytes,
                        reduction.fields.join(","),
                        reduction.fallback
                    );
                }
                event_tx.try_send_serialized(sequence, prepared.serialized)?;
            } else {
                event_tx.try_send(sequence, event)?;
            }
        }
        Ok(())
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
pub async fn execute_cli_with_active_input_for_config(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
) -> Result<CliExecutionResult, AgentError> {
    execute_cli_with_active_input_for_config_started_at(
        masker,
        heartbeat_monitor,
        http,
        active_input,
        config,
        paths,
        Instant::now(),
    )
    .await
}

/// Execute the CLI against an execution budget that started before guest
/// initialization.
///
/// Production guest-agent bootstrap uses this entry point so setup time counts
/// against the runner-owned execution budget.
pub async fn execute_cli_with_active_input_for_config_started_at(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
    execution_started_at: Instant,
) -> Result<CliExecutionResult, AgentError> {
    execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat_monitor,
        http,
        CliExecutionControls::new(active_input, CancellationToken::new(), None),
        config,
        paths,
        execution_started_at,
    )
    .await
}

/// Run-scoped controls observed while the inner CLI is executing.
pub struct CliExecutionControls<'a> {
    active_input: ActiveInputWriter,
    user_cancellation: CancellationToken,
    codex_startup: Option<&'a CodexStartupTiming>,
}

impl<'a> CliExecutionControls<'a> {
    /// Create controls for active input, cancellation, and optional Codex startup timing.
    #[must_use]
    pub fn new(
        active_input: ActiveInputWriter,
        user_cancellation: CancellationToken,
        codex_startup: Option<&'a CodexStartupTiming>,
    ) -> Self {
        Self {
            active_input,
            user_cancellation,
            codex_startup,
        }
    }
}

/// Execute the CLI while observing run-scoped controls.
///
pub async fn execute_cli_with_controls_for_config_started_at(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
    execution_started_at: Instant,
) -> Result<CliExecutionResult, AgentError> {
    let runtime = CliRuntimeConfig::from_config(config, paths, execution_started_at)?;
    execute_cli_inner(masker, heartbeat_monitor, http, controls, &runtime).await
}

async fn execute_cli_inner(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    if matches!(runtime.framework, env::Framework::Codex) {
        return codex_app_server_backend::execute_codex_app_server_for_runtime(
            masker,
            heartbeat_monitor,
            http,
            controls,
            runtime,
        )
        .await;
    }

    let CliExecutionControls {
        active_input,
        user_cancellation,
        codex_startup: _,
    } = controls;

    let replay_user_messages =
        active_input.is_enabled() && matches!(runtime.framework, env::Framework::ClaudeCode);
    log_info!(
        LOG_TAG,
        "Starting {} execution...",
        runtime.framework.agent_type()
    );

    let cmd = if matches!(runtime.framework, env::Framework::Pi) {
        build_pi_command_for_runtime(runtime)?
    } else {
        command::build_claude_command_for_runtime(runtime, replay_user_messages)
    };
    let (bin, args) = cmd
        .split_first()
        .ok_or_else(|| AgentError::Execution("empty command".into()))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        // If a future setup step fails after spawn, dropping `Child` must not
        // leave a CLI process running in the VM.
        .kill_on_drop(true);

    let mut child_env_values = child_env::values_for_runtime(runtime);
    if matches!(runtime.framework, env::Framework::Pi) {
        child_env_values.extend(pi_child_env_values(runtime));
    }
    // Suppress Claude CLI features that are unnecessary or harmful in a
    // sandbox: startup network calls (statsig, Datadog, Segment, GCS update
    // check, GitHub) add ~2s latency, background tasks can keep a one-shot run
    // alive after its final result, telemetry has no receiver, and the CLI
    // version is baked into the rootfs image.
    child_env_values.extend([
        (
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS".to_string(),
            "1".to_string(),
        ),
        (
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
            "1".to_string(),
        ),
        (
            "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY".to_string(),
            "1".to_string(),
        ),
        (
            "CLAUDE_CODE_DISABLE_TERMINAL_TITLE".to_string(),
            "1".to_string(),
        ),
        ("DISABLE_AUTOUPDATER".to_string(), "1".to_string()),
        ("DISABLE_ERROR_REPORTING".to_string(), "1".to_string()),
        ("DISABLE_INSTALLATION_CHECKS".to_string(), "1".to_string()),
        ("DISABLE_TELEMETRY".to_string(), "1".to_string()),
    ]);
    let child_env_values = child_env::normalize_values(child_env_values);
    exec_boundary::validate_process_argv_env(
        "CLI child argv/env too large",
        bin,
        args.iter().map(String::as_str),
        &child_env_values,
    )
    .map_err(AgentError::Execution)?;
    cmd.stdin(Stdio::piped());
    child_env::apply_values_to_tokio_command(&mut cmd, &child_env_values);
    // Set the child cwd explicitly at spawn time so the CLI observes the
    // current canonical workspace mount instead of relying on inherited cwd.
    set_cli_current_dir(&mut cmd, paths::CANONICAL_WORKING_DIR)?;

    // Open the run log before spawning the CLI. If the run-id-scoped path is
    // invalid or unavailable, fail without starting a child process.
    let log_file = guest_contracts::runtime_paths::create_private(runtime.agent_log_file.as_ref())?;
    let mut log_file = tokio::fs::File::from_std(log_file);

    let mut child = cmd.spawn()?;

    let Some(claude_stdin) = child.stdin.take() else {
        let _ = child.start_kill();
        return Err(AgentError::Execution("no stdin".into()));
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
    let pi_execution = matches!(runtime.framework, env::Framework::Pi);
    let mut claude_stdin_write_handle = Some({
        let run_id = runtime.run_id.to_string();
        let prompt = runtime.prompt.to_string();
        tokio::spawn(async move {
            if pi_execution {
                write_pi_prompt_to_stdin(claude_stdin, &run_id, &prompt, active_input).await
            } else {
                write_claude_stream_json_to_stdin(claude_stdin, &run_id, &prompt, active_input)
                    .await
            }
        })
    });

    // Stream Claude Code stdout JSONL, racing against heartbeat and process exit.
    //
    // Event sending is decoupled from stdout reading via an mpsc channel
    // to prevent a deadlock: Bun (Claude CLI runtime) uses blocking stdout
    // writes, so if the agent's HTTP POSTs are slow and the pipe buffer
    // fills, the CLI's entire event loop blocks — including TCP I/O.
    // See: https://github.com/vm0-ai/vm0/issues/3645
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut stdout_partial_line = Vec::new();
    let mut stdout_closed = false;

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

    let agent_execution_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(agent_execution_deadline);
    let mut agent_execution_deadline_armed = false;
    let mut agent_execution_timeout_secs = 0;
    if let Some(deadline) = runtime.agent_execution_deadline {
        agent_execution_deadline
            .as_mut()
            .reset(tokio::time::Instant::from_std(deadline.at));
        agent_execution_deadline_armed = true;
        agent_execution_timeout_secs = deadline.timeout_secs;
    }

    // Stuck-tool watchdog: workaround for Claude Code bug where
    // WebSearch/WebFetch hang indefinitely. Track all in-flight tool calls;
    // if a network tool exceeds STUCK_TOOL_TIMEOUT_SECS without producing
    // a tool_result, kill the process. Keyed by tool_use_id to handle
    // parallel tool calls correctly.
    // See: https://github.com/anthropics/claude-code/issues/11650
    let mut stuck_tool_tracker: HashMap<String, (String, tokio::time::Instant)> = HashMap::new();
    let stuck_tool_interval = Duration::from_secs(constants::STUCK_TOOL_CHECK_INTERVAL_SECS);
    let mut stuck_tool_check = tokio::time::interval_at(
        tokio::time::Instant::now() + stuck_tool_interval,
        stuck_tool_interval,
    );
    // MAINTENANCE: update if Claude Code adds new network tools that can hang.
    const STUCK_TOOL_NAMES: &[&str] = &["WebSearch", "WebFetch"];

    // Background event sender: HTTP POSTs happen here, never in the stdout
    // reading loop. Admission is non-blocking and bounded by count and bytes;
    // the serial worker greedily batches only existing FIFO backlog. There is
    // no collection delay or concurrent POST path. Overload enters controlled
    // CLI termination rather than blocking stdout.
    let mut should_send_events = http.has_api();
    let event_delivery = EventDeliveryRuntime::start(http.clone(), &runtime.run_id)?;

    let mut heartbeat_done = false;
    let mut user_cancellation_handled = false;
    let mut cli_exit_at: Option<Instant> = None;
    let mut claude_result = None;
    let mut post_result_cleanup_result = None;
    let mut event_ingestor = CliEventIngestor::new(runtime, None);
    let event_result: Result<(), AgentError> = loop {
        tokio::select! {
            () = user_cancellation.cancelled(), if !user_cancellation_handled && cli_status.is_none() => {
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => {
                        user_cancellation_handled = true;
                        continue;
                    }
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                user_cancellation_handled = true;
                active_input_controller.close_terminal();
                termination_runtime.begin_control_failure(
                    TerminationReason::UserCancellation,
                    AgentError::Execution("Run cancelled by user".to_string()),
                    ControlTerminationLog::UserCancellation,
                    termination_deadline.as_mut(),
                );
            }
            () = &mut agent_execution_deadline, if agent_execution_deadline_armed && cli_status.is_none() => {
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => {
                        agent_execution_deadline_armed = false;
                        continue;
                    }
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                agent_execution_deadline_armed = false;
                if termination_runtime
                    .preserve_post_result_cleanup_at_execution_deadline(
                        termination_deadline.as_mut(),
                    )
                {
                    // A terminal result already ended semantic execution.
                    // Preserve its classification and, when SIGTERM has not
                    // already been sent, advance its bounded reaper.
                    continue;
                }
                active_input_controller.close_terminal();
                let timeout_error = AgentError::Execution(format!(
                    "Agent execution timed out after {agent_execution_timeout_secs} seconds"
                ));
                termination_runtime.begin_control_failure(
                    TerminationReason::ExecutionTimeout,
                    timeout_error,
                    ControlTerminationLog::ExecutionTimeout {
                        timeout_secs: agent_execution_timeout_secs,
                    },
                    termination_deadline.as_mut(),
                );
            }
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
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
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
            line_result = line_reader::read_bounded_utf8_line(
                &mut reader,
                &mut stdout_partial_line,
                ORDINARY_CLI_STDOUT_MAX_LINE_BYTES,
            ), if !stdout_closed => {
                match line_result {
                    Ok(Some(line)) => {
                        let stripped = line.trim();
                        if stripped.is_empty() {
                            continue;
                        }

                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(stripped) {
                            if replay_user_messages {
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
                                    runtime.framework,
                                )
                                .await?
                            {
                                ParsedEventAction::Forward => {}
                                ParsedEventAction::Skip => continue,
                            }
                            let is_result_event =
                                event.get("type").and_then(serde_json::Value::as_str)
                                    == Some("result");
                            if post_result_cleanup_was_armed || is_result_event {
                                match try_observe_cli_exit(
                                    &mut child,
                                    &mut cli_status,
                                    &mut cli_exit_at,
                                    &active_input_controller,
                                    &mut termination_runtime,
                                    stdout_closed,
                                    drain_deadline.as_mut(),
                                )? {
                                    CliExitObservation::NoNewExit
                                    | CliExitObservation::ExitedDrainingStdout => {}
                                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
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
                            claude::track_claude_tool_events(&event, &mut stuck_tool_tracker);
                            termination_runtime.record_post_result_activity(
                                post_result_cleanup_was_armed,
                                termination_deadline.as_mut(),
                            );
                            // Prepare event payload (mask secrets, add seq) and enqueue
                            // for background sending. Network I/O stays off the reading loop.
                            if let Err(error) = event_ingestor.enqueue_event(
                                event,
                                masker,
                                should_send_events,
                                event_delivery.sender(),
                            ) {
                                should_send_events = false;
                                if cli_status.is_some() {
                                    break Err(error);
                                }
                                let error_log = error.to_string();
                                termination_runtime.begin_control_failure(
                                    TerminationReason::EventDelivery,
                                    error,
                                    ControlTerminationLog::EventDeliveryFailed { error: error_log },
                                    termination_deadline.as_mut(),
                                );
                            }
                        } else {
                            CliEventIngestor::write_raw_line(&mut log_file, line.as_bytes()).await;
                        }
                    }
                    Ok(None) => {
                        stdout_closed = true;
                        active_input_controller.close_terminal();
                        if cli_status.is_some() {
                            break Ok(());
                        }
                    }
                    Err(error) => {
                        stdout_closed = true;
                        active_input_controller.close_terminal();
                        let error = match error {
                            line_reader::BoundedLineError::Io(error) => AgentError::Io(error),
                            line_reader::BoundedLineError::TooLong => AgentError::Execution(
                                format!(
                                    "CLI stdout line exceeded {ORDINARY_CLI_STDOUT_MAX_LINE_BYTES} bytes"
                                ),
                            ),
                            line_reader::BoundedLineError::InvalidUtf8 {
                                valid_up_to,
                                error_len,
                                line_bytes,
                            } => {
                                let utf8_error = match error_len {
                                    Some(error_len) => format!(
                                        "invalid utf-8 sequence of {error_len} bytes from index {valid_up_to}"
                                    ),
                                    None => format!(
                                        "incomplete utf-8 byte sequence from index {valid_up_to}"
                                    ),
                                };
                                AgentError::Execution(format!(
                                    "CLI stdout line is not UTF-8: {utf8_error}; line_bytes={line_bytes}"
                                ))
                            }
                        };

                        if cli_status.is_some() {
                            break Err(error);
                        }
                        match try_observe_cli_exit(
                            &mut child,
                            &mut cli_status,
                            &mut cli_exit_at,
                            &active_input_controller,
                            &mut termination_runtime,
                            stdout_closed,
                            drain_deadline.as_mut(),
                        )? {
                            CliExitObservation::NoNewExit => {
                                let error_log = error.to_string();
                                termination_runtime.begin_control_failure(
                                    TerminationReason::StdoutIngestion,
                                    error,
                                    ControlTerminationLog::StdoutIngestionFailed {
                                        error: error_log,
                                    },
                                    termination_deadline.as_mut(),
                                );
                            }
                            CliExitObservation::ExitedDrainingStdout
                            | CliExitObservation::ExitedAndStdoutClosed => break Err(error),
                        }
                    }
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
                                stdout_closed,
                                drain_deadline.as_mut(),
                            ),
                            CliExitObservation::ExitedAndStdoutClosed
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
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
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
            _ = stuck_tool_check.tick(), if cli_status.is_none() => {
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
                        stdout_closed,
                        drain_deadline.as_mut(),
                    )? {
                        CliExitObservation::NoNewExit => {}
                        CliExitObservation::ExitedDrainingStdout => continue,
                        CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
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
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
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

    // `tokio::fs::File` may still own an in-flight blocking write after
    // `write_all` returns. Wait for it before callers observe the completed
    // execution and read the run log.
    let _ = log_file.flush().await;

    active_input_controller.close_terminal();
    let mut active_input_error = None;
    if let Some(handle) = claude_stdin_write_handle.take() {
        if handle.is_finished() {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    log_warn!(
                        LOG_TAG,
                        "Claude stdin writer finished after CLI loop with error: {error}"
                    );
                    if active_input_controller.has_activity() {
                        active_input_error = Some(error);
                    }
                }
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Claude stdin writer failed after CLI loop: {error}"
                    );
                    if active_input_controller.has_activity() {
                        active_input_error = Some(AgentError::Execution(format!(
                            "Claude stdin writer task failed during active-input quiescence: {error}"
                        )));
                    }
                }
            }
        } else if active_input_controller.has_activity() {
            let mut handle = handle;
            match tokio::time::timeout(
                Duration::from_secs(constants::ACTIVE_INPUT_SINK_QUIESCENCE_TIMEOUT_SECS),
                &mut handle,
            )
            .await
            {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => active_input_error = Some(error),
                Ok(Err(error)) => {
                    active_input_error = Some(AgentError::Execution(format!(
                        "Claude stdin writer task failed during active-input quiescence: {error}"
                    )));
                }
                Err(_) => {
                    handle.abort();
                    let _ = handle.await;
                    active_input_error = Some(AgentError::Execution(
                        "Claude stdin writer did not quiesce after terminal close".to_string(),
                    ));
                }
            }
        } else {
            handle.abort();
            let _ = handle.await;
            log_info!(LOG_TAG, "Stopped Claude stdin writer after CLI loop");
        }
    }

    let active_input_delivery_ids = match active_input_controller.finalize_receipts().await {
        Ok(delivery_ids) => delivery_ids,
        Err(error) => {
            if active_input_error.is_none() {
                active_input_error = Some(error);
            }
            Vec::new()
        }
    };

    let has_control_error = termination_runtime.has_control_error();
    let event_error = if active_input_error.is_some() {
        active_input_error
    } else if has_control_error {
        None
    } else {
        event_result.err()
    };

    // On success, boundedly drain accepted events. On any execution or
    // control error, abort unsent delivery rather than stalling on retries.
    let delivery_report = if event_error.is_none() && !has_control_error {
        event_delivery.finish().await
    } else {
        Ok(event_delivery.abort().await)
    }?;
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
    let (exit_code, cli_observed_exit) = cli_exit_summary_from_status(&status);

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
        cli_observed_exit,
        stderr_lines: masked_stderr_lines,
        last_event_sequence: delivery_report.last_acknowledged_sequence,
        event_delivery: delivery_report.diagnostic,
        claude_result,
        post_result_cleanup_result,
        failure_diagnostic: event_ingestor.failure_diagnostic(),
        control_error,
        cli_termination,
        active_input_delivery_ids,
    })
}

fn cli_exit_summary_from_status(status: &ExitStatus) -> (i32, Option<CliObservedExitDiagnostic>) {
    if let Some(code) = status.code() {
        return (code, Some(CliObservedExitDiagnostic::from_exit_code(code)));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            log_warn!(LOG_TAG, "Process killed by signal {sig}");
            let observed_exit = CliObservedExitDiagnostic::from_signal(sig);
            return (observed_exit.mapped_exit_code, Some(observed_exit));
        }
    }

    (1, None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliExitObservation {
    NoNewExit,
    ExitedDrainingStdout,
    ExitedAndStdoutClosed,
}

fn try_observe_cli_exit(
    child: &mut tokio::process::Child,
    cli_status: &mut Option<ExitStatus>,
    cli_exit_at: &mut Option<Instant>,
    active_input_controller: &ActiveInputController,
    termination_runtime: &mut CliTerminationRuntime,
    stdout_closed: bool,
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
        stdout_closed,
        drain_deadline,
    ))
}

fn record_cli_exit(
    status: ExitStatus,
    cli_status: &mut Option<ExitStatus>,
    cli_exit_at: &mut Option<Instant>,
    active_input_controller: &ActiveInputController,
    termination_runtime: &mut CliTerminationRuntime,
    stdout_closed: bool,
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
    if stdout_closed {
        return CliExitObservation::ExitedAndStdoutClosed;
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
    !failure_patterns::is_generic_codex_failure_diagnostic(&diagnostic.message)
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
        CliExitObservation, CliFailureDiagnostic, CliRuntimeConfig, PI_NODE_OPTIONS, child_env,
        claude_initial_prompt_frame, cli_exit_summary_from_status, codex_home_for_home_dir,
        codex_runtime_config, command, exec_boundary, pi_child_env_values, record_cli_exit,
        select_failure_diagnostic, set_cli_current_dir, with_carried_failure_reason,
    };
    use crate::active_input::ActiveInputRuntime;
    use crate::{constants, env};
    use guest_contracts::diagnostics::{FailureDetailSource, FailureReason};
    use std::borrow::Cow;
    use std::collections::HashMap;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    use std::time::{Duration, Instant};

    fn guest_config_for_agent_context(user_env: HashMap<String, String>) -> env::GuestConfig {
        env::GuestConfig {
            run_id: "run-okou-env-test".to_string(),
            api_url: "https://runner.example".to_string(),
            api_token: "test-token".to_string(),
            sandbox_id: String::new(),
            sandbox_reuse_result: String::new(),
            workspace_reuse_result: String::new(),
            prompt: "prompt".to_string(),
            append_system_prompt: String::new(),
            vercel_bypass: String::new(),
            resume_session_id: String::new(),
            api_start_time: String::new(),
            agent_execution_timeout: None,
            secret_values: String::new(),
            disallowed_tools: String::new(),
            tools: String::new(),
            settings: String::new(),
            use_mock_claude: false,
            mock_claude_path: String::new(),
            cli_agent_type: "codex".to_string(),
            framework: env::Framework::Codex,
            user_env,
            use_mock_codex: false,
            mock_codex_path: String::new(),
            home_dir: "/tmp/home".to_string(),
            artifacts: Vec::new(),
            feature_flags: HashMap::new(),
            codex_runtime_config: String::new(),
            pi_system_prompt: String::new(),
            pi_model_config: String::new(),
            pi_session_id: String::new(),
            stuck_tool_timeout_secs: constants::STUCK_TOOL_TIMEOUT_SECS,
            post_result_sigterm_grace: Duration::from_secs(
                constants::POST_RESULT_SIGTERM_GRACE_SECS,
            ),
            post_result_total_cap: Duration::from_secs(constants::POST_RESULT_TOTAL_CAP_SECS),
            post_result_sigkill_grace: Duration::from_secs(
                constants::POST_RESULT_SIGKILL_GRACE_SECS,
            ),
        }
    }

    fn runtime_for_command_test<'a>(
        framework: env::Framework,
        prompt: &'a str,
        append_system_prompt: &'a str,
        user_env: &'a HashMap<String, String>,
    ) -> CliRuntimeConfig<'a> {
        CliRuntimeConfig {
            framework,
            run_id: Cow::Borrowed("run-exec-boundary-test"),
            prompt: Cow::Borrowed(prompt),
            resume_session_id: Cow::Borrowed(""),
            append_system_prompt: Cow::Borrowed(append_system_prompt),
            disallowed_tools: Cow::Borrowed(""),
            tools: Cow::Borrowed(""),
            settings: Cow::Borrowed(""),
            use_mock_claude: false,
            mock_claude_path: Cow::Borrowed(""),
            use_mock_codex: false,
            mock_codex_path: Cow::Borrowed(""),
            home_dir: Cow::Borrowed("/tmp/home"),
            api_url: Cow::Borrowed(""),
            api_start_time: Cow::Borrowed(""),
            anthropic_model: Cow::Borrowed(""),
            openai_model: Cow::Borrowed(""),
            openai_base_url: Cow::Borrowed(""),
            codex_runtime_config: None,
            codex_oauth_mode: false,
            codex_fast_mode: false,
            disable_builtin_web_search: false,
            agent_execution_deadline: None,
            stuck_tool_timeout_secs: constants::STUCK_TOOL_TIMEOUT_SECS,
            post_result_cleanup_policy: PostResultCleanupPolicy::new(
                Duration::from_secs(constants::POST_RESULT_SIGTERM_GRACE_SECS),
                Duration::from_secs(constants::POST_RESULT_TOTAL_CAP_SECS),
                Duration::from_secs(constants::POST_RESULT_SIGKILL_GRACE_SECS),
            ),
            agent_log_file: Cow::Borrowed("/tmp/agent.log"),
            session_id_file: Cow::Borrowed("/tmp/session-id"),
            session_history_path_file: Cow::Borrowed("/tmp/session-history-path"),
            pi_session_id: Cow::Borrowed(""),
            pi_system_prompt: Cow::Borrowed(""),
            pi_model_config: Cow::Borrowed(""),
            user_env,
        }
    }

    #[test]
    fn codex_web_search_override_is_in_app_server_startup_config() {
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

        assert!(
            !runtime
                .codex_startup_config_overrides()
                .contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string())
        );

        runtime.disable_builtin_web_search = true;

        assert!(
            runtime
                .codex_startup_config_overrides()
                .contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string())
        );
    }

    #[test]
    fn pi_child_env_keeps_run_id_compatible_and_controls_node_warnings() {
        let user_env = HashMap::from([(
            "NODE_OPTIONS".to_string(),
            "--require /tmp/user-script.js".to_string(),
        )]);
        let runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
        let mut values = child_env::values_for_runtime(&runtime);
        values.extend(pi_child_env_values(&runtime));
        let values = child_env::normalize_values(values);

        assert_eq!(
            values
                .iter()
                .find(|(key, _)| key == "NODE_OPTIONS")
                .map(|(_, value)| value.as_str()),
            Some(PI_NODE_OPTIONS)
        );
        assert_eq!(
            values
                .iter()
                .filter(|(key, _)| key == "NODE_OPTIONS")
                .count(),
            1
        );
        let canonical_run_id = values
            .iter()
            .find(|(key, _)| key == guest_contracts::env::RUN_ID_ENV)
            .map(|(_, value)| value.as_str());
        let legacy_run_id = values
            .iter()
            .find(|(key, _)| key == super::LEGACY_PI_RUN_ID_ENV)
            .map(|(_, value)| value.as_str());
        assert_eq!(canonical_run_id, Some(runtime.run_id.as_ref()));
        assert_eq!(legacy_run_id, canonical_run_id);
    }

    #[test]
    fn codex_runtime_accepts_okou_and_zero_agent_contexts() {
        for key in [super::OKOU_AGENT_ID_ENV_KEY, super::ZERO_AGENT_ID_ENV_KEY] {
            let config = guest_config_for_agent_context(HashMap::from([(
                key.to_string(),
                "agent-test".to_string(),
            )]));
            let paths = crate::paths::GuestPaths::from_runtime_dir("/tmp/okou-env-test");

            let runtime = CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

            assert!(runtime.disable_builtin_web_search);
            assert!(
                runtime
                    .codex_startup_config_overrides()
                    .contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string())
            );
        }
    }

    #[test]
    fn codex_web_search_override_composes_with_provider_config() {
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);
        runtime.disable_builtin_web_search = true;
        runtime.codex_runtime_config = Some(codex_runtime_config::CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: None,
        });

        let overrides = runtime.codex_startup_config_overrides();

        assert!(overrides.contains(&r#"model_provider="deepseek""#.to_string()));
        assert!(overrides.contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string()));
    }

    #[test]
    fn claude_large_prompt_is_not_rejected_by_process_argv_guard() {
        let user_env = HashMap::new();
        let prompt = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        let runtime = runtime_for_command_test(env::Framework::ClaudeCode, &prompt, "", &user_env);

        let cmd = command::build_claude_command_for_runtime(&runtime, false);
        let (bin, args) = cmd.split_first().unwrap();
        let env_values = child_env::values_for_runtime(&runtime);

        exec_boundary::validate_process_argv_env(
            "test cli child",
            bin,
            args.iter().map(String::as_str),
            &env_values,
        )
        .unwrap();
    }

    #[test]
    fn codex_app_server_large_prompt_is_not_part_of_process_argv_guard() {
        let user_env = HashMap::new();
        let prompt = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        let runtime = runtime_for_command_test(env::Framework::Codex, &prompt, "", &user_env);
        let mut env_values = child_env::values_for_runtime(&runtime);
        env_values.push(("CODEX_HOME".to_string(), runtime.codex_home()));

        exec_boundary::validate_process_argv_env(
            "test codex app-server",
            "codex",
            ["app-server", "--listen", "stdio://"],
            &env_values,
        )
        .unwrap();
    }

    #[test]
    fn codex_child_env_keeps_openai_base_url_without_structured_runtime_config() {
        let user_env = HashMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
            ("OPENAI_MODEL".to_string(), "gpt-5".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://api.legacy-provider.test/v1".to_string(),
            ),
        ]);
        let runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

        let env_values = child_env::values_for_runtime(&runtime);

        assert!(env_values.iter().any(|(key, value)| {
            key == "OPENAI_BASE_URL" && value == "https://api.legacy-provider.test/v1"
        }));
    }

    #[test]
    fn structured_codex_runtime_config_omits_stale_openai_base_url_from_child_env() {
        let user_env = HashMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
            ("OPENAI_MODEL".to_string(), "deepseek-v4-flash".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://api.should-not-win.test/v1".to_string(),
            ),
        ]);
        let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);
        runtime.codex_runtime_config = Some(codex_runtime_config::CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: None,
        });

        let env_values = child_env::values_for_runtime(&runtime);

        assert!(
            env_values
                .iter()
                .any(|(key, value)| { key == "OPENAI_API_KEY" && value == "sk-test" })
        );
        assert!(
            env_values
                .iter()
                .any(|(key, value)| { key == "OPENAI_MODEL" && value == "deepseek-v4-flash" })
        );
        assert!(!env_values.iter().any(|(key, _)| key == "OPENAI_BASE_URL"));
    }

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
    #[test]
    fn cli_exit_summary_preserves_normal_exit_137() {
        let status = std::process::ExitStatus::from_raw(137 << 8);

        let (exit_code, observed_exit) = cli_exit_summary_from_status(&status);

        let observed_exit = observed_exit.expect("normal exit should be observed");
        assert_eq!(exit_code, 137);
        assert_eq!(
            observed_exit,
            guest_contracts::diagnostics::CliObservedExitDiagnostic::from_exit_code(137)
        );
        assert!(!observed_exit.is_sigkill());
    }

    #[cfg(unix)]
    #[test]
    fn cli_exit_summary_preserves_signal_exit_before_mapping() {
        let status = std::process::ExitStatus::from_raw(libc::SIGKILL);

        let (exit_code, observed_exit) = cli_exit_summary_from_status(&status);

        let observed_exit = observed_exit.expect("signal exit should be observed");
        assert_eq!(exit_code, 137);
        assert_eq!(
            observed_exit,
            guest_contracts::diagnostics::CliObservedExitDiagnostic::from_signal(libc::SIGKILL)
        );
        assert!(observed_exit.is_sigkill());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_exit_observation_distinguishes_stdout_drain_from_loop_completion() {
        let active_input = ActiveInputRuntime::new_disabled("run-exit-observation", "");
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
