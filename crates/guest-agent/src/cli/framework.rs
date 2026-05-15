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
}

impl ClaudeResultSummary {
    pub(super) fn from_event(event: &serde_json::Value) -> Self {
        Self {
            num_turns: event.get("num_turns").and_then(|v| v.as_u64()),
        }
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
}
