//! Framework-specific CLI execution behavior.
//!
//! Command construction lives in `command`; this module owns the small
//! Claude-vs-Codex policy switches consumed by `execute_cli`.

use crate::env;
use crate::events;
use std::collections::HashMap;
use std::time::Instant;

/// Summary of Claude Code's terminal `type=result` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeResultSummary {
    /// Claude Code's reported turn count for the run, when present.
    pub num_turns: Option<u64>,

    /// Semantic status of Claude Code's terminal result event.
    pub status: ClaudeResultStatus,
}

/// Semantic status derived from Claude Code's terminal `type=result` event.
///
/// This describes only the event's recognized semantic evidence. It is
/// independent of the CLI process exit status and the outcome of any later
/// post-result cleanup. When the event contains conflicting evidence,
/// recognized error evidence takes precedence over recognized success evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeResultStatus {
    /// The event contains recognized success evidence (`is_error` is `false` or
    /// `subtype` is `"success"`) and no recognized error evidence.
    Success,

    /// The event contains recognized error evidence (`is_error` is `true` or
    /// `subtype` is `"error"`).
    ///
    /// This status takes precedence over [`Self::Success`] when both kinds of
    /// evidence are present.
    Error,

    /// The event contains neither recognized success nor recognized error
    /// evidence.
    ///
    /// This status does not assert either success or failure.
    Unknown,
}

impl ClaudeResultSummary {
    pub(super) fn from_event(event: &serde_json::Value) -> Self {
        Self {
            num_turns: event.get("num_turns").and_then(|v| v.as_u64()),
            status: ClaudeResultStatus::from_event(event),
        }
    }
}

impl ClaudeResultStatus {
    fn from_event(event: &serde_json::Value) -> Self {
        let is_error = event.get("is_error").and_then(|v| v.as_bool());
        let subtype = event.get("subtype").and_then(|v| v.as_str());

        if is_error == Some(true) || subtype == Some("error") {
            return Self::Error;
        }
        if is_error == Some(false) || subtype == Some("success") {
            return Self::Success;
        }

        Self::Unknown
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CliFrameworkBehavior {
    framework: env::Framework,
}

impl CliFrameworkBehavior {
    pub(super) fn new(framework: env::Framework) -> Self {
        Self { framework }
    }

    pub(super) fn agent_type(self) -> &'static str {
        self.framework.agent_type()
    }

    pub(super) fn handles_claude_result_event(self, event: &serde_json::Value) -> bool {
        matches!(self.framework, env::Framework::ClaudeCode)
            && event.get("type").and_then(|v| v.as_str()) == Some("result")
    }

    pub(super) fn uses_claude_tool_watchdog(self) -> bool {
        matches!(self.framework, env::Framework::ClaudeCode)
    }

    pub(super) fn uses_stream_json_stdin(self) -> bool {
        matches!(self.framework, env::Framework::ClaudeCode)
    }

    pub(super) fn filters_replayed_user_events(self) -> bool {
        matches!(self.framework, env::Framework::ClaudeCode)
    }

    pub(super) fn track_claude_tool_events(
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

    pub(super) fn logs_codex_failure_diagnostics(self) -> bool {
        matches!(self.framework, env::Framework::Codex)
    }

    pub(super) fn is_codex_turn_lifecycle_event(self, event: &serde_json::Value) -> bool {
        matches!(self.framework, env::Framework::Codex)
            && matches!(
                event.get("type").and_then(serde_json::Value::as_str),
                Some(
                    "turn.started"
                        | "turn.completed"
                        | "turn.failed"
                        | "item.started"
                        | "item.updated"
                        | "item.completed"
                        | "error"
                )
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn framework_behavior_stream_json_stdin_only_for_claude_code() {
        assert!(CliFrameworkBehavior::new(env::Framework::ClaudeCode).uses_stream_json_stdin());
        assert!(!CliFrameworkBehavior::new(env::Framework::Codex).uses_stream_json_stdin());
    }

    #[test]
    fn framework_behavior_filters_replayed_user_events_only_for_claude_code() {
        assert!(
            CliFrameworkBehavior::new(env::Framework::ClaudeCode).filters_replayed_user_events()
        );
        assert!(!CliFrameworkBehavior::new(env::Framework::Codex).filters_replayed_user_events());
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
            ClaudeResultSummary {
                num_turns: Some(0),
                status: ClaudeResultStatus::Success,
            }
        );
    }

    #[test]
    fn claude_result_summary_marks_is_error_result_as_error() {
        let event = serde_json::json!({
            "type": "result",
            "num_turns": 1,
            "is_error": true,
            "result": "Error."
        });

        assert_eq!(
            ClaudeResultSummary::from_event(&event).status,
            ClaudeResultStatus::Error
        );
    }

    #[test]
    fn claude_result_summary_marks_error_subtype_as_error() {
        let event = serde_json::json!({
            "type": "result",
            "num_turns": 1,
            "subtype": "error",
            "result": "Error."
        });

        assert_eq!(
            ClaudeResultSummary::from_event(&event).status,
            ClaudeResultStatus::Error
        );
    }

    #[test]
    fn claude_result_summary_marks_ambiguous_result_as_unknown() {
        let event = serde_json::json!({
            "type": "result",
            "num_turns": 1,
            "result": "Done."
        });

        assert_eq!(
            ClaudeResultSummary::from_event(&event).status,
            ClaudeResultStatus::Unknown
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
}
