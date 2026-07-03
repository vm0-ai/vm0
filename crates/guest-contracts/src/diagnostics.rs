//! Structured diagnostics shared by guest agents and runners.

use serde::{Deserialize, Serialize};

/// Current JSON schema version for failure diagnostics.
pub const FAILURE_DIAGNOSTIC_SCHEMA_VERSION: u8 = 1;

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
            cli_termination: None,
            claude_num_turns: None,
            failure_detail_source: None,
            failure_reason: None,
            session_history_status: SessionHistoryStatus::Unknown,
            prompt_shape: prompt.prompt_shape,
            prompt_bytes: prompt.prompt_bytes,
            first_line_bytes: prompt.first_line_bytes,
        }
    }

    /// Attach the CLI process exit code.
    #[must_use]
    pub fn with_cli_exit_code(mut self, cli_exit_code: i32) -> Self {
        self.cli_exit_code = Some(cli_exit_code);
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
    /// The guest agent reaped the process after receiving a final result.
    PostResultReap,
    /// The stuck-tool watchdog terminated the process.
    StuckToolWatchdog,
    /// Heartbeat handling failed and required termination.
    HeartbeatError,
    /// Heartbeat handling panicked and required termination.
    HeartbeatPanic,
    /// Writing the initial prompt to stdin failed and required termination.
    InitialPromptStdin,
}

impl CliTerminationReason {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PostResultReap => "post_result_reap",
            Self::StuckToolWatchdog => "stuck_tool_watchdog",
            Self::HeartbeatError => "heartbeat_error",
            Self::HeartbeatPanic => "heartbeat_panic",
            Self::InitialPromptStdin => "initial_prompt_stdin",
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
            Self::InsufficientCredits => "insufficient_credits",
            Self::InvalidApiKey => "invalid_api_key",
            Self::InvalidCredentials => "invalid_credentials",
            Self::ContextWindowExceeded => "context_window_exceeded",
            Self::OutputTokenLimit => "output_token_limit",
            Self::ProviderOverloaded => "provider_overloaded",
            Self::ProviderStreamTimeout => "provider_stream_timeout",
            Self::ProviderServerError => "provider_server_error",
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
    }
}
