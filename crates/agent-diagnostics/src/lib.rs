//! Structured diagnostics shared by guest agents and runners.

use serde::{Deserialize, Serialize};

pub const FAILURE_DIAGNOSTIC_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDiagnostic {
    pub schema_version: u8,
    pub failure_class: FailureClass,
    pub framework: AgentFramework,
    pub cli_exit_code: Option<i32>,
    pub claude_num_turns: Option<u64>,
    pub failure_detail_source: Option<FailureDetailSource>,
    pub failure_reason: Option<FailureReason>,
    pub session_history_status: SessionHistoryStatus,
    pub prompt_shape: PromptShape,
    pub prompt_bytes: u64,
    pub first_line_bytes: u64,
}

impl FailureDiagnostic {
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
            claude_num_turns: None,
            failure_detail_source: None,
            failure_reason: None,
            session_history_status: SessionHistoryStatus::Unknown,
            prompt_shape: prompt.prompt_shape,
            prompt_bytes: prompt.prompt_bytes,
            first_line_bytes: prompt.first_line_bytes,
        }
    }

    #[must_use]
    pub fn with_cli_exit_code(mut self, cli_exit_code: i32) -> Self {
        self.cli_exit_code = Some(cli_exit_code);
        self
    }

    #[must_use]
    pub fn with_claude_num_turns(mut self, claude_num_turns: Option<u64>) -> Self {
        self.claude_num_turns = claude_num_turns;
        self
    }

    #[must_use]
    pub fn with_failure_detail_source(
        mut self,
        failure_detail_source: FailureDetailSource,
    ) -> Self {
        self.failure_detail_source = Some(failure_detail_source);
        self
    }

    #[must_use]
    pub fn with_failure_reason(mut self, failure_reason: FailureReason) -> Self {
        self.failure_reason = Some(failure_reason);
        self
    }

    #[must_use]
    pub fn with_session_history_status(
        mut self,
        session_history_status: SessionHistoryStatus,
    ) -> Self {
        self.session_history_status = session_history_status;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    WorkingDirSetupFailed,
    CliExecutionError,
    CliNonzero,
    ClaudeZeroTurnNoHistory,
    EventUploadFailed,
    CheckpointFailed,
}

impl FailureClass {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    InsufficientCredits,
    InvalidApiKey,
    UsageLimit,
}

impl FailureReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InsufficientCredits => "insufficient_credits",
            Self::InvalidApiKey => "invalid_api_key",
            Self::UsageLimit => "usage_limit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureDetailSource {
    ClaudeResult,
    CodexJsonl,
    Stderr,
    FallbackExitCode,
}

impl FailureDetailSource {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFramework {
    ClaudeCode,
    Codex,
}

impl AgentFramework {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionHistoryStatus {
    Missing,
    Empty,
    Present,
    Unknown,
    NotApplicable,
}

impl SessionHistoryStatus {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptShape {
    Empty,
    SlashLike,
    Plain,
}

impl PromptShape {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::SlashLike => "slash_like",
            Self::Plain => "plain",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptMetadata {
    pub prompt_shape: PromptShape,
    pub prompt_bytes: u64,
    pub first_line_bytes: u64,
}

impl PromptMetadata {
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
    }
}
