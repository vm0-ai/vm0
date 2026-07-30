//! Structured diagnostics shared by guest agents and runners.

use serde::{Deserialize, Serialize};

/// Current JSON schema version for failure diagnostics.
pub const FAILURE_DIAGNOSTIC_SCHEMA_VERSION: u8 = 1;

/// Process exit code used for the runner-owned agent execution timeout.
pub const AGENT_EXECUTION_TIMEOUT_EXIT_CODE: i32 = 124;

// These are stable Unix signal numbers in the serialized diagnostic contract.
const UNIX_SIGHUP_SIGNAL_NUMBER: i32 = 1;
const UNIX_SIGINT_SIGNAL_NUMBER: i32 = 2;
const UNIX_SIGQUIT_SIGNAL_NUMBER: i32 = 3;
const UNIX_SIGKILL_SIGNAL_NUMBER: i32 = 9;
const UNIX_SIGTERM_SIGNAL_NUMBER: i32 = 15;
const UNIX_SIGPIPE_SIGNAL_NUMBER: i32 = 13;
const SHELL_SIGNAL_EXIT_CODE_OFFSET: i32 = 128;

/// Structured information describing why a guest agent run failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDiagnostic {
    /// Version of the serialized diagnostic schema.
    pub schema_version: u8,
    /// Coarse failure category used by runner-side handling.
    pub failure_class: FailureClass,
    /// CLI framework that produced the diagnostic.
    pub framework: AgentFramework,
    /// Exit code observed from the CLI process, when available.
    pub cli_exit_code: Option<i32>,
    /// Raw CLI process exit observation before signal exits are flattened.
    pub cli_observed_exit: Option<CliObservedExitDiagnostic>,
    /// Guest-agent termination details for the CLI process, when available.
    pub cli_termination: Option<CliTerminationDiagnostic>,
    /// Number of turns reported by Claude Code, when available.
    pub claude_num_turns: Option<u64>,
    /// Source that supplied the detailed failure reason, when available.
    pub failure_detail_source: Option<FailureDetailSource>,
    /// Parsed detailed failure reason, when available.
    pub failure_reason: Option<FailureReason>,
    /// Availability of session history at the time of failure.
    pub session_history_status: SessionHistoryStatus,
    /// Content-safe shape classification for the submitted prompt.
    pub prompt_shape: PromptShape,
    /// Prompt length in bytes.
    pub prompt_bytes: u64,
    /// First prompt line length in bytes after stripping a trailing carriage return.
    pub first_line_bytes: u64,
    /// Bounded event-delivery failure details, when delivery was terminally incomplete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_delivery: Option<EventDeliveryDiagnostic>,
}

impl FailureDiagnostic {
    /// Create a diagnostic with required fields and empty optional details.
    #[must_use]
    pub fn new(
        failure_class: FailureClass,
        framework: AgentFramework,
        prompt: PromptMetadata,
    ) -> Self {
        Self {
            schema_version: FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
            failure_class,
            framework,
            cli_exit_code: None,
            cli_observed_exit: None,
            cli_termination: None,
            claude_num_turns: None,
            failure_detail_source: None,
            failure_reason: None,
            session_history_status: SessionHistoryStatus::Unknown,
            prompt_shape: prompt.prompt_shape,
            prompt_bytes: prompt.prompt_bytes,
            first_line_bytes: prompt.first_line_bytes,
            event_delivery: None,
        }
    }

    /// Attach the CLI process exit code.
    #[must_use]
    pub fn with_cli_exit_code(mut self, cli_exit_code: i32) -> Self {
        self.cli_exit_code = Some(cli_exit_code);
        self
    }

    /// Attach the raw CLI process exit observation.
    #[must_use]
    pub fn with_cli_observed_exit(mut self, cli_observed_exit: CliObservedExitDiagnostic) -> Self {
        self.cli_observed_exit = Some(cli_observed_exit);
        self
    }

    /// Attach CLI termination details.
    #[must_use]
    pub fn with_cli_termination(mut self, cli_termination: CliTerminationDiagnostic) -> Self {
        self.cli_termination = Some(cli_termination);
        self
    }

    /// Attach the Claude Code turn count, preserving absence when unknown.
    #[must_use]
    pub fn with_claude_num_turns(mut self, claude_num_turns: Option<u64>) -> Self {
        self.claude_num_turns = claude_num_turns;
        self
    }

    /// Attach the source that supplied the detailed failure reason.
    #[must_use]
    pub fn with_failure_detail_source(
        mut self,
        failure_detail_source: FailureDetailSource,
    ) -> Self {
        self.failure_detail_source = Some(failure_detail_source);
        self
    }

    /// Attach the detailed failure reason.
    #[must_use]
    pub fn with_failure_reason(mut self, failure_reason: FailureReason) -> Self {
        self.failure_reason = Some(failure_reason);
        self
    }

    /// Attach the session history status.
    #[must_use]
    pub fn with_session_history_status(
        mut self,
        session_history_status: SessionHistoryStatus,
    ) -> Self {
        self.session_history_status = session_history_status;
        self
    }

    /// Attach bounded event-delivery failure details.
    #[must_use]
    pub fn with_event_delivery(mut self, event_delivery: EventDeliveryDiagnostic) -> Self {
        self.event_delivery = Some(event_delivery);
        self
    }
}

/// Bounded structured details for terminal guest event-delivery failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryDiagnostic {
    /// Logical events included in delivery batches.
    pub total_events: u64,
    /// Logical delivery batches started.
    pub total_batches: u64,
    /// Logical batches whose HTTP retry budget was exhausted.
    pub failed_batches: u64,
    /// Highest contiguous event sequence acknowledged by the API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_acknowledged_sequence: Option<u32>,
    /// First logical batch whose retry budget was exhausted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_failed_batch: Option<EventDeliveryFailedBatchDiagnostic>,
    /// Final delivery state captured at the global drain deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_timeout: Option<EventDeliveryDrainTimeoutDiagnostic>,
}

/// First logical event batch whose HTTP retry budget was exhausted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryFailedBatchDiagnostic {
    /// First event sequence in the batch.
    pub first_sequence: u32,
    /// Last event sequence in the batch.
    pub last_sequence: u32,
    /// Number of events in the batch.
    pub event_count: u32,
    /// Conservative batch byte accounting used by guest admission control.
    pub conservative_bytes: u64,
    /// Whether the API explicitly rejected every terminal attempt.
    pub outcome: EventDeliveryAcceptanceOutcome,
    /// Completed failed attempts, bounded by the delivery retry budget.
    pub attempts: Vec<EventDeliveryCompletedAttemptDiagnostic>,
}

/// One completed failed HTTP attempt for an exhausted event batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryCompletedAttemptDiagnostic {
    /// One-based attempt number.
    pub attempt: u32,
    /// Exact `x-client-request-id` value sent on the request.
    pub client_request_id: String,
    /// Monotonic elapsed request time in milliseconds.
    pub elapsed_ms: u64,
    /// Stable content-safe failure classification.
    pub failure_kind: EventDeliveryAttemptFailureKind,
    /// HTTP response status, when a response was received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// Delivery state captured when the global drain deadline expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryDrainTimeoutDiagnostic {
    /// Events still waiting in the bounded channel.
    pub queued_events: u32,
    /// Conservative bytes still waiting in the bounded channel.
    pub queued_bytes: u64,
    /// Events held outside the channel for the next batch.
    pub carried_events: u32,
    /// Conservative bytes held outside the channel for the next batch.
    pub carried_bytes: u64,
    /// Logical batch active at the deadline, when one was active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_batch: Option<EventDeliveryActiveBatchDiagnostic>,
}

/// Logical event batch active at the global drain deadline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryActiveBatchDiagnostic {
    /// First event sequence in the batch.
    pub first_sequence: u32,
    /// Last event sequence in the batch.
    pub last_sequence: u32,
    /// Number of events in the batch.
    pub event_count: u32,
    /// Conservative batch byte accounting used by guest admission control.
    pub conservative_bytes: u64,
    /// Completed failed attempts before the drain deadline.
    pub completed_attempts: Vec<EventDeliveryCompletedAttemptDiagnostic>,
    /// Request attempt still in flight at the deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_attempt: Option<EventDeliveryActiveAttemptDiagnostic>,
    /// Acceptance remains unknown because delivery did not reach a terminal response.
    pub outcome: EventDeliveryAcceptanceOutcome,
}

/// Request attempt active when the global drain deadline expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryActiveAttemptDiagnostic {
    /// One-based attempt number.
    pub attempt: u32,
    /// Exact `x-client-request-id` value sent on the request.
    pub client_request_id: String,
    /// Monotonic elapsed request time in milliseconds at the deadline.
    pub elapsed_ms: u64,
}

/// Observed API acceptance outcome for terminal event delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventDeliveryAcceptanceOutcome {
    /// Every failed attempt received an explicit non-success HTTP response.
    ConfirmedRejection,
    /// At least one request received no response, so acceptance is unknown.
    OutcomeUnknown,
}

impl EventDeliveryAcceptanceOutcome {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConfirmedRejection => "confirmed_rejection",
            Self::OutcomeUnknown => "outcome_unknown",
        }
    }
}

/// Content-safe failure classification for a completed event HTTP attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventDeliveryAttemptFailureKind {
    /// The request exceeded its transport timeout.
    Timeout,
    /// A connection could not be established.
    Connect,
    /// The API returned a non-success HTTP response.
    HttpStatus,
    /// Another transport failure occurred without an HTTP response.
    Transport,
}

impl EventDeliveryAttemptFailureKind {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::HttpStatus => "http_status",
            Self::Transport => "transport",
        }
    }
}

/// Raw CLI process exit observation before guest-agent maps it to a numeric exit code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliObservedExitDiagnostic {
    /// Shape of the observed process exit.
    pub kind: CliObservedExitKind,
    /// Normal process exit code, when the process exited normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Unix signal number, when the process was killed by a signal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal_number: Option<i32>,
    /// Stable snake_case signal name for common Unix signals, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal_name: Option<String>,
    /// Existing shell-style mapped code used by `cliExitCode`.
    pub mapped_exit_code: i32,
}

impl CliObservedExitDiagnostic {
    /// Build a normal exit observation.
    #[must_use]
    pub const fn from_exit_code(exit_code: i32) -> Self {
        Self {
            kind: CliObservedExitKind::Exit,
            exit_code: Some(exit_code),
            signal_number: None,
            signal_name: None,
            mapped_exit_code: exit_code,
        }
    }

    /// Build a Unix signal exit observation.
    #[must_use]
    pub fn from_signal(signal_number: i32) -> Self {
        Self {
            kind: CliObservedExitKind::Signal,
            exit_code: None,
            signal_number: Some(signal_number),
            signal_name: observed_signal_name(signal_number).map(String::from),
            mapped_exit_code: shell_signal_exit_code(signal_number),
        }
    }

    /// Return the stable signal name derived from the observed signal number.
    #[must_use]
    pub fn known_signal_name(&self) -> Option<&'static str> {
        if self.kind != CliObservedExitKind::Signal {
            return None;
        }

        self.signal_number.and_then(observed_signal_name)
    }

    /// Return true when this observation is an observed SIGKILL.
    #[must_use]
    pub fn is_sigkill(&self) -> bool {
        self.kind == CliObservedExitKind::Signal
            && self.signal_number == Some(UNIX_SIGKILL_SIGNAL_NUMBER)
    }
}

/// Shape of the raw CLI process exit observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliObservedExitKind {
    /// The process exited normally with an exit code.
    Exit,
    /// The process was killed by a Unix signal.
    Signal,
}

impl CliObservedExitKind {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exit => "exit",
            Self::Signal => "signal",
        }
    }
}

fn observed_signal_name(signal_number: i32) -> Option<&'static str> {
    match signal_number {
        UNIX_SIGHUP_SIGNAL_NUMBER => Some("sighup"),
        UNIX_SIGINT_SIGNAL_NUMBER => Some("sigint"),
        UNIX_SIGQUIT_SIGNAL_NUMBER => Some("sigquit"),
        UNIX_SIGTERM_SIGNAL_NUMBER => Some("sigterm"),
        UNIX_SIGKILL_SIGNAL_NUMBER => Some("sigkill"),
        UNIX_SIGPIPE_SIGNAL_NUMBER => Some("sigpipe"),
        _ => None,
    }
}

const fn shell_signal_exit_code(signal_number: i32) -> i32 {
    SHELL_SIGNAL_EXIT_CODE_OFFSET.saturating_add(signal_number)
}

/// Details about how the guest agent terminated a CLI process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTerminationDiagnostic {
    /// Component that initiated termination.
    pub initiator: CliTerminationInitiator,
    /// Reason termination was requested.
    pub reason: CliTerminationReason,
    /// Signal sent to the process group, when a signal was sent.
    pub signal_sent: Option<CliTerminationSignal>,
    /// Process group ID targeted by the signal, when available.
    pub signal_pgid: Option<i32>,
    /// Grace period in milliseconds associated with the signal, when available.
    pub signal_grace_ms: Option<u64>,
    /// Whether termination escalated from SIGTERM to SIGKILL.
    pub escalated: bool,
    /// Exit code observed after termination, when available.
    pub observed_exit_code: Option<i32>,
}

impl CliTerminationDiagnostic {
    /// Create termination details with the guest agent as initiator.
    #[must_use]
    pub const fn new(reason: CliTerminationReason) -> Self {
        Self {
            initiator: CliTerminationInitiator::GuestAgent,
            reason,
            signal_sent: None,
            signal_pgid: None,
            signal_grace_ms: None,
            escalated: false,
            observed_exit_code: None,
        }
    }

    /// Record the first attempted signal, then only update on SIGTERM -> SIGKILL escalation.
    ///
    /// Multiple watchdog paths may observe the same child before `wait()` completes. Keeping this
    /// monotonic prevents a later duplicate signal from rewriting the original termination
    /// attribution fields.
    #[must_use]
    pub fn record_signal(
        mut self,
        signal_sent: CliTerminationSignal,
        signal_pgid: Option<i32>,
        signal_grace_ms: Option<u64>,
    ) -> Self {
        let should_update = matches!(
            (self.signal_sent, signal_sent),
            (None, _)
                | (
                    Some(CliTerminationSignal::Sigterm),
                    CliTerminationSignal::Sigkill
                )
        );
        if !should_update {
            return self;
        }
        if matches!(signal_sent, CliTerminationSignal::Sigkill) {
            self.escalated = true;
        }
        self.signal_sent = Some(signal_sent);
        self.signal_pgid = signal_pgid;
        self.signal_grace_ms = signal_grace_ms;
        self
    }

    /// Attach the exit code observed after termination.
    #[must_use]
    pub fn with_observed_exit_code(mut self, observed_exit_code: i32) -> Self {
        self.observed_exit_code = Some(observed_exit_code);
        self
    }
}

/// Component that initiated CLI termination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliTerminationInitiator {
    /// The guest agent initiated termination.
    GuestAgent,
}

impl CliTerminationInitiator {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GuestAgent => "guest_agent",
        }
    }
}

/// Reason the guest agent terminated a CLI process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliTerminationReason {
    /// The runner-owned agent execution budget elapsed.
    ExecutionTimeout,
    /// The user explicitly cancelled the active run.
    UserCancellation,
    /// The guest agent reaped the process after receiving a final result.
    PostResultReap,
    /// The stuck-tool watchdog terminated the process.
    StuckToolWatchdog,
    /// A resumed Codex process did not begin emitting real turn lifecycle events.
    CodexResumeStartupTimeout,
    /// Heartbeat handling failed and required termination.
    HeartbeatError,
    /// Heartbeat handling panicked and required termination.
    HeartbeatPanic,
    /// Writing the initial prompt to stdin failed and required termination.
    InitialPromptStdin,
    /// Event delivery overloaded or stopped and required termination.
    EventDelivery,
    /// CLI stdout framing or decoding failed and required termination.
    StdoutIngestion,
}

impl CliTerminationReason {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExecutionTimeout => "execution_timeout",
            Self::UserCancellation => "user_cancellation",
            Self::PostResultReap => "post_result_reap",
            Self::StuckToolWatchdog => "stuck_tool_watchdog",
            Self::CodexResumeStartupTimeout => "codex_resume_startup_timeout",
            Self::HeartbeatError => "heartbeat_error",
            Self::HeartbeatPanic => "heartbeat_panic",
            Self::InitialPromptStdin => "initial_prompt_stdin",
            Self::EventDelivery => "event_delivery",
            Self::StdoutIngestion => "stdout_ingestion",
        }
    }
}

/// Signal sent by the guest agent to terminate a CLI process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliTerminationSignal {
    /// SIGTERM was sent.
    Sigterm,
    /// SIGKILL was sent.
    Sigkill,
}

impl CliTerminationSignal {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sigterm => "sigterm",
            Self::Sigkill => "sigkill",
        }
    }
}

/// Coarse failure class for runner-side handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// Working directory setup failed before launching the CLI.
    WorkingDirSetupFailed,
    /// The CLI could not be executed.
    CliExecutionError,
    /// The CLI exited with a non-zero status.
    CliNonzero,
    /// Claude Code produced zero turns and no usable session history.
    ClaudeZeroTurnNoHistory,
    /// Uploading events failed.
    EventUploadFailed,
    /// Creating or uploading a checkpoint failed.
    CheckpointFailed,
}

impl FailureClass {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WorkingDirSetupFailed => "working_dir_setup_failed",
            Self::CliExecutionError => "cli_execution_error",
            Self::CliNonzero => "cli_nonzero",
            Self::ClaudeZeroTurnNoHistory => "claude_zero_turn_no_history",
            Self::EventUploadFailed => "event_upload_failed",
            Self::CheckpointFailed => "checkpoint_failed",
        }
    }
}

/// Detailed failure reason parsed from CLI output or fallback signals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    /// The session history exceeded the checkpoint size limit.
    SessionHistoryLimit,
    /// The provider account has insufficient credits.
    InsufficientCredits,
    /// The configured API key is invalid.
    InvalidApiKey,
    /// The configured credentials are invalid.
    InvalidCredentials,
    /// The model context window was exhausted.
    ContextWindowExceeded,
    /// The provider stopped because an output-token limit was reached.
    OutputTokenLimit,
    /// The provider reported overload.
    ProviderOverloaded,
    /// The provider stream timed out.
    ProviderStreamTimeout,
    /// The provider returned a server error.
    ProviderServerError,
    /// The provider refused the request under a safety policy.
    SafetyPolicyRefusal,
    /// The CLI requires reconnecting or re-authentication.
    ReconnectRequired,
    /// The provider reported a usage limit.
    UsageLimit,
}

impl FailureReason {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SessionHistoryLimit => "session_history_limit",
            Self::InsufficientCredits => "insufficient_credits",
            Self::InvalidApiKey => "invalid_api_key",
            Self::InvalidCredentials => "invalid_credentials",
            Self::ContextWindowExceeded => "context_window_exceeded",
            Self::OutputTokenLimit => "output_token_limit",
            Self::ProviderOverloaded => "provider_overloaded",
            Self::ProviderStreamTimeout => "provider_stream_timeout",
            Self::ProviderServerError => "provider_server_error",
            Self::SafetyPolicyRefusal => "safety_policy_refusal",
            Self::ReconnectRequired => "reconnect_required",
            Self::UsageLimit => "usage_limit",
        }
    }
}

/// Source used to derive a detailed failure reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureDetailSource {
    /// The reason came from a Claude result payload.
    ClaudeResult,
    /// The reason came from Codex JSONL output.
    CodexJsonl,
    /// The reason came from stderr output.
    Stderr,
    /// The reason was inferred from a fallback exit-code mapping.
    FallbackExitCode,
}

impl FailureDetailSource {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeResult => "claude_result",
            Self::CodexJsonl => "codex_jsonl",
            Self::Stderr => "stderr",
            Self::FallbackExitCode => "fallback_exit_code",
        }
    }
}

/// Agent CLI framework that produced the diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFramework {
    /// Anthropic Claude Code.
    ClaudeCode,
    /// OpenAI Codex CLI.
    Codex,
}

impl AgentFramework {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }
}

/// Session-history availability observed during failure handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionHistoryStatus {
    /// Session history file was expected but missing.
    Missing,
    /// Session history file existed but had no useful content.
    Empty,
    /// Session history file existed with content.
    Present,
    /// Session history status could not be determined.
    Unknown,
    /// Session history is not applicable to the framework or failure mode.
    NotApplicable,
}

impl SessionHistoryStatus {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Empty => "empty",
            Self::Present => "present",
            Self::Unknown => "unknown",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// Content-safe prompt shape classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptShape {
    /// The prompt is empty after trimming whitespace.
    Empty,
    /// The prompt starts with a slash after leading whitespace.
    SlashLike,
    /// The prompt contains plain non-slash content.
    Plain,
}

impl PromptShape {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::SlashLike => "slash_like",
            Self::Plain => "plain",
        }
    }
}

/// Content-safe metadata derived from a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptMetadata {
    /// Content-safe prompt shape.
    pub prompt_shape: PromptShape,
    /// Prompt length in bytes.
    pub prompt_bytes: u64,
    /// First prompt line length in bytes after stripping a trailing carriage return.
    pub first_line_bytes: u64,
}

impl PromptMetadata {
    /// Build prompt metadata without retaining prompt content.
    #[must_use]
    pub fn from_prompt(prompt: &str) -> Self {
        let raw_first_line = prompt.split_once('\n').map_or(prompt, |(line, _)| line);
        let first_line = raw_first_line.strip_suffix('\r').unwrap_or(raw_first_line);
        let trimmed = prompt.trim();
        let prompt_shape = if trimmed.is_empty() {
            PromptShape::Empty
        } else if prompt.trim_start().starts_with('/') {
            PromptShape::SlashLike
        } else {
            PromptShape::Plain
        };

        Self {
            prompt_shape,
            prompt_bytes: prompt.len() as u64,
            first_line_bytes: first_line.len() as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_metadata_classifies_safe_shapes_without_content() {
        let empty = PromptMetadata::from_prompt(" \n\t");
        assert_eq!(empty.prompt_shape, PromptShape::Empty);
        assert_eq!(empty.prompt_bytes, 3);
        assert_eq!(empty.first_line_bytes, 1);

        let slash = PromptMetadata::from_prompt("  /help\nsecret second line");
        assert_eq!(slash.prompt_shape, PromptShape::SlashLike);
        assert_eq!(slash.prompt_bytes, 26);
        assert_eq!(slash.first_line_bytes, 7);

        let plain = PromptMetadata::from_prompt("éplain\r\nsecond");
        assert_eq!(plain.prompt_shape, PromptShape::Plain);
        assert_eq!(plain.prompt_bytes, 15);
        assert_eq!(plain.first_line_bytes, 7);
    }

    #[test]
    fn failure_diagnostic_uses_camel_case_fields_and_snake_case_values() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::ClaudeZeroTurnNoHistory,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("/help"),
        )
        .with_cli_exit_code(0)
        .with_claude_num_turns(Some(0))
        .with_session_history_status(SessionHistoryStatus::Missing);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["failureClass"], "claude_zero_turn_no_history");
        assert_eq!(json["framework"], "claude_code");
        assert_eq!(json["cliExitCode"], 0);
        assert_eq!(json["claudeNumTurns"], 0);
        assert_eq!(json["failureDetailSource"], serde_json::Value::Null);
        assert_eq!(json["failureReason"], serde_json::Value::Null);
        assert_eq!(json["sessionHistoryStatus"], "missing");
        assert_eq!(json["promptShape"], "slash_like");
        assert_eq!(json["promptBytes"], 5);
        assert_eq!(json["firstLineBytes"], 5);

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_optional_detail_source_and_reason() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::ClaudeResult)
        .with_failure_reason(FailureReason::InsufficientCredits);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureDetailSource"], "claude_result");
        assert_eq!(json["failureReason"], "insufficient_credits");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_cli_termination() {
        let cli_termination = CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
            .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
            .with_observed_exit_code(143);
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(143)
        .with_cli_termination(cli_termination);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(
            json["cliTermination"],
            serde_json::json!({
                "initiator": "guest_agent",
                "reason": "post_result_reap",
                "signalSent": "sigterm",
                "signalPgid": 1401,
                "signalGraceMs": 10_000,
                "escalated": false,
                "observedExitCode": 143
            })
        );

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn stdout_ingestion_termination_reason_has_stable_serialization() {
        let reason = CliTerminationReason::StdoutIngestion;
        assert_eq!(reason.as_str(), "stdout_ingestion");
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::json!("stdout_ingestion")
        );
        assert_eq!(
            serde_json::from_value::<CliTerminationReason>(serde_json::json!("stdout_ingestion"))
                .unwrap(),
            reason
        );
    }

    #[test]
    fn execution_timeout_reason_has_stable_serialization_and_exit_code() {
        let reason = CliTerminationReason::ExecutionTimeout;
        assert_eq!(AGENT_EXECUTION_TIMEOUT_EXIT_CODE, 124);
        assert_eq!(reason.as_str(), "execution_timeout");
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::json!("execution_timeout")
        );
        assert_eq!(
            serde_json::from_value::<CliTerminationReason>(serde_json::json!("execution_timeout"))
                .unwrap(),
            reason
        );
    }

    #[test]
    fn user_cancellation_reason_has_stable_serialization() {
        let reason = CliTerminationReason::UserCancellation;
        assert_eq!(reason.as_str(), "user_cancellation");
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::json!("user_cancellation")
        );
        assert_eq!(
            serde_json::from_value::<CliTerminationReason>(serde_json::json!("user_cancellation"))
                .unwrap(),
            reason
        );
    }

    #[test]
    fn codex_resume_startup_timeout_reason_has_stable_serialization() {
        let reason = CliTerminationReason::CodexResumeStartupTimeout;
        assert_eq!(reason.as_str(), "codex_resume_startup_timeout");
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::json!("codex_resume_startup_timeout")
        );
        assert_eq!(
            serde_json::from_value::<CliTerminationReason>(serde_json::json!(
                "codex_resume_startup_timeout"
            ))
            .unwrap(),
            reason
        );
    }

    #[test]
    fn failure_diagnostic_serializes_observed_signal_exit() {
        let observed_exit = CliObservedExitDiagnostic::from_signal(UNIX_SIGKILL_SIGNAL_NUMBER);
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(137)
        .with_cli_observed_exit(observed_exit);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(
            json["cliObservedExit"],
            serde_json::json!({
                "kind": "signal",
                "signalNumber": 9,
                "signalName": "sigkill",
                "mappedExitCode": 137
            })
        );

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
        assert!(round_trip.cli_observed_exit.unwrap().is_sigkill());
    }

    #[test]
    fn observed_signal_exit_code_uses_shell_mapping_without_overflow() {
        assert_eq!(
            CliObservedExitDiagnostic::from_signal(UNIX_SIGKILL_SIGNAL_NUMBER).mapped_exit_code,
            137
        );
        assert_eq!(
            CliObservedExitDiagnostic::from_signal(i32::MAX).mapped_exit_code,
            i32::MAX
        );
    }

    #[test]
    fn observed_signal_name_is_derived_from_signal_number() {
        let mut observed_exit = CliObservedExitDiagnostic::from_signal(UNIX_SIGKILL_SIGNAL_NUMBER);
        observed_exit.signal_name = Some("tampered".to_string());

        assert_eq!(observed_exit.known_signal_name(), Some("sigkill"));
    }

    #[test]
    fn failure_diagnostic_serializes_observed_normal_exit() {
        let observed_exit = CliObservedExitDiagnostic::from_exit_code(137);
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(137)
        .with_cli_observed_exit(observed_exit);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(
            json["cliObservedExit"],
            serde_json::json!({
                "kind": "exit",
                "exitCode": 137,
                "mappedExitCode": 137
            })
        );

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
        assert!(!round_trip.cli_observed_exit.unwrap().is_sigkill());
    }

    #[test]
    fn failure_diagnostic_deserializes_without_observed_exit() {
        let json = serde_json::json!({
            "schemaVersion": 1,
            "failureClass": "cli_nonzero",
            "framework": "claude_code",
            "cliExitCode": 137,
            "cliTermination": null,
            "claudeNumTurns": null,
            "failureDetailSource": "fallback_exit_code",
            "failureReason": null,
            "sessionHistoryStatus": "present",
            "promptShape": "plain",
            "promptBytes": 5,
            "firstLineBytes": 5
        });

        let diagnostic: FailureDiagnostic = serde_json::from_value(json).unwrap();

        assert_eq!(diagnostic.cli_exit_code, Some(137));
        assert_eq!(diagnostic.cli_observed_exit, None);
    }

    #[test]
    fn failure_reason_and_cli_termination_reason_are_independent() {
        let cli_termination =
            CliTerminationDiagnostic::new(CliTerminationReason::StuckToolWatchdog)
                .record_signal(CliTerminationSignal::Sigkill, Some(234), Some(1_000))
                .with_observed_exit_code(137);
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(137)
        .with_failure_reason(FailureReason::ProviderOverloaded)
        .with_cli_termination(cli_termination);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "provider_overloaded");
        assert_eq!(json["cliTermination"]["reason"], "stuck_tool_watchdog");
        assert_eq!(json["cliTermination"]["signalSent"], "sigkill");
        assert_eq!(json["cliTermination"]["escalated"], true);

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn cli_termination_repeated_sigterm_does_not_overwrite_original_signal() {
        let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::HeartbeatError)
            .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(1_000))
            .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(2_000));

        assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigterm));
        assert_eq!(diagnostic.signal_pgid, Some(42));
        assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
        assert!(!diagnostic.escalated);
    }

    #[test]
    fn cli_termination_sigkill_is_not_downgraded_by_late_sigterm() {
        let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
            .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(10_000))
            .record_signal(CliTerminationSignal::Sigkill, Some(42), Some(1_000))
            .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(10_000));

        assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigkill));
        assert_eq!(diagnostic.signal_pgid, Some(42));
        assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
        assert!(diagnostic.escalated);
    }

    #[test]
    fn cli_termination_repeated_sigkill_does_not_overwrite_escalation_signal() {
        let diagnostic = CliTerminationDiagnostic::new(CliTerminationReason::StuckToolWatchdog)
            .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(10_000))
            .record_signal(CliTerminationSignal::Sigkill, Some(42), Some(1_000))
            .record_signal(CliTerminationSignal::Sigkill, Some(99), Some(2_000));

        assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigkill));
        assert_eq!(diagnostic.signal_pgid, Some(42));
        assert_eq!(diagnostic.signal_grace_ms, Some(1_000));
        assert!(diagnostic.escalated);
    }

    #[test]
    fn failure_diagnostic_serializes_usage_limit_reason() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::UsageLimit);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "usage_limit");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_invalid_api_key_reason() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::InvalidApiKey);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "invalid_api_key");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_invalid_credentials_reason() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::InvalidCredentials);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "invalid_credentials");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_context_window_exceeded_reason() {
        assert_eq!(
            FailureReason::ContextWindowExceeded.as_str(),
            "context_window_exceeded"
        );

        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::ContextWindowExceeded);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "context_window_exceeded");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_session_history_limit_reason() {
        assert_eq!(
            FailureReason::SessionHistoryLimit.as_str(),
            "session_history_limit"
        );

        for framework in [AgentFramework::Codex, AgentFramework::ClaudeCode] {
            let diagnostic = FailureDiagnostic::new(
                FailureClass::CheckpointFailed,
                framework,
                PromptMetadata::from_prompt("continue"),
            )
            .with_cli_exit_code(0)
            .with_failure_reason(FailureReason::SessionHistoryLimit);

            let json = serde_json::to_value(&diagnostic).unwrap();
            assert_eq!(json["failureReason"], "session_history_limit");

            let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
            assert_eq!(round_trip, diagnostic);
        }
    }

    #[test]
    fn failure_diagnostic_serializes_output_token_limit_reason() {
        assert_eq!(
            FailureReason::OutputTokenLimit.as_str(),
            "output_token_limit"
        );

        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::OutputTokenLimit);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "output_token_limit");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_provider_overloaded_reason() {
        assert_eq!(
            FailureReason::ProviderOverloaded.as_str(),
            "provider_overloaded"
        );

        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::ProviderOverloaded);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "provider_overloaded");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_provider_stream_timeout_reason() {
        assert_eq!(
            FailureReason::ProviderStreamTimeout.as_str(),
            "provider_stream_timeout"
        );

        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::ProviderStreamTimeout);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "provider_stream_timeout");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_provider_server_error_reason() {
        assert_eq!(
            FailureReason::ProviderServerError.as_str(),
            "provider_server_error"
        );

        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::ProviderServerError);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "provider_server_error");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_safety_policy_refusal_reason() {
        assert_eq!(
            FailureReason::SafetyPolicyRefusal.as_str(),
            "safety_policy_refusal"
        );

        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::SafetyPolicyRefusal);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "safety_policy_refusal");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_serializes_reconnect_required_reason() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1)
        .with_failure_reason(FailureReason::ReconnectRequired);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json["failureReason"], "reconnect_required");

        let round_trip: FailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, diagnostic);
    }

    #[test]
    fn failure_diagnostic_round_trips_bounded_event_delivery_details() {
        let first_attempt = EventDeliveryCompletedAttemptDiagnostic {
            attempt: 1,
            client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
            elapsed_ms: 30_000,
            failure_kind: EventDeliveryAttemptFailureKind::HttpStatus,
            http_status: Some(500),
        };
        let active_attempt = EventDeliveryActiveAttemptDiagnostic {
            attempt: 2,
            client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
            elapsed_ms: 4_000,
        };
        let event_delivery = EventDeliveryDiagnostic {
            total_events: 40,
            total_batches: 2,
            failed_batches: 1,
            last_acknowledged_sequence: Some(7),
            first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
                first_sequence: 8,
                last_sequence: 15,
                event_count: 8,
                conservative_bytes: 2_048,
                outcome: EventDeliveryAcceptanceOutcome::ConfirmedRejection,
                attempts: vec![first_attempt.clone()],
            }),
            drain_timeout: Some(EventDeliveryDrainTimeoutDiagnostic {
                queued_events: 0,
                queued_bytes: 0,
                carried_events: 0,
                carried_bytes: 0,
                active_batch: Some(EventDeliveryActiveBatchDiagnostic {
                    first_sequence: 16,
                    last_sequence: 39,
                    event_count: 24,
                    conservative_bytes: 8_192,
                    completed_attempts: vec![first_attempt],
                    active_attempt: Some(active_attempt),
                    outcome: EventDeliveryAcceptanceOutcome::OutcomeUnknown,
                }),
            }),
        };
        let diagnostic = FailureDiagnostic::new(
            FailureClass::EventUploadFailed,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("continue"),
        )
        .with_cli_exit_code(0)
        .with_event_delivery(event_delivery);

        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(
            json["eventDelivery"]["firstFailedBatch"]["outcome"],
            "confirmed_rejection"
        );
        assert_eq!(
            json["eventDelivery"]["firstFailedBatch"]["attempts"][0]["failureKind"],
            "http_status"
        );
        assert_eq!(
            json["eventDelivery"]["drainTimeout"]["activeBatch"]["outcome"],
            "outcome_unknown"
        );
        assert_eq!(
            EventDeliveryAcceptanceOutcome::ConfirmedRejection.as_str(),
            "confirmed_rejection"
        );
        assert_eq!(
            EventDeliveryAttemptFailureKind::Transport.as_str(),
            "transport"
        );

        let round_trip: FailureDiagnostic = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(round_trip, diagnostic);

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct OldFailureDiagnostic {
            schema_version: u8,
            failure_class: FailureClass,
        }

        let old_shape: OldFailureDiagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(old_shape.schema_version, FAILURE_DIAGNOSTIC_SCHEMA_VERSION);
        assert_eq!(old_shape.failure_class, FailureClass::EventUploadFailed);
    }

    #[test]
    fn failure_diagnostic_deserializes_without_optional_fields() {
        let json = serde_json::json!({
            "schemaVersion": 1,
            "failureClass": "cli_nonzero",
            "framework": "claude_code",
            "cliExitCode": 1,
            "claudeNumTurns": 1,
            "sessionHistoryStatus": "present",
            "promptShape": "plain",
            "promptBytes": 13,
            "firstLineBytes": 13
        });

        let diagnostic: FailureDiagnostic = serde_json::from_value(json).unwrap();

        assert_eq!(diagnostic.failure_detail_source, None);
        assert_eq!(diagnostic.failure_reason, None);
        assert_eq!(diagnostic.cli_termination, None);
        assert_eq!(diagnostic.event_delivery, None);
    }
}
