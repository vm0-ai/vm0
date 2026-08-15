//! Claude Code result parsing and tool tracking.

use crate::events;
use std::collections::HashMap;
use std::fmt;
use tokio::time::Instant;

/// Maximum number of network tool calls retained by the stuck-tool watchdog.
///
/// This is intentionally higher than the normal parallelism of Claude Code,
/// while keeping the control-process allocation bounded if a child emits
/// unmatched tool-use events indefinitely.
pub(super) const MAX_TRACKED_STUCK_TOOLS: usize = 256;

/// Maximum number of bytes in one tool-use ID retained by the watchdog.
pub(super) const MAX_TRACKED_STUCK_TOOL_ID_BYTES: usize = 1024;

/// Network tools whose unmatched calls are handled by the stuck-tool watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StuckToolName {
    /// Claude's web search tool.
    WebSearch,

    /// Claude's web fetch tool.
    WebFetch,
}

impl StuckToolName {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "WebSearch" => Some(Self::WebSearch),
            "WebFetch" => Some(Self::WebFetch),
            _ => None,
        }
    }

    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::WebSearch => "WebSearch",
            Self::WebFetch => "WebFetch",
        }
    }
}

/// An admission failure while adding a network tool call to the watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StuckToolTrackingError {
    /// The tool-use ID is too large to retain safely.
    ToolUseIdTooLong { max_bytes: usize },

    /// The tracker already contains its maximum number of calls.
    CapacityExceeded { max_entries: usize },
}

impl fmt::Display for StuckToolTrackingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ToolUseIdTooLong { max_bytes } => write!(
                formatter,
                "Claude tool tracking rejected a tool-use ID larger than {max_bytes} bytes"
            ),
            Self::CapacityExceeded { max_entries } => write!(
                formatter,
                "Claude tool tracking capacity exceeded at {max_entries} in-flight calls"
            ),
        }
    }
}

impl std::error::Error for StuckToolTrackingError {}

/// Bounded in-flight state used by the stuck-tool watchdog.
pub(super) struct StuckToolTracker {
    entries: HashMap<String, (StuckToolName, Instant)>,
}

impl StuckToolTracker {
    pub(super) fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub(super) fn track_event(
        &mut self,
        event: &serde_json::Value,
    ) -> Result<(), StuckToolTrackingError> {
        for tool_event in events::extract_claude_tool_info(event) {
            match tool_event {
                events::ClaudeToolEvent::Use { id, name } => self.track_use(id, name)?,
                events::ClaudeToolEvent::Result { tool_use_id } => {
                    self.entries.remove(tool_use_id);
                }
            }
        }
        Ok(())
    }

    fn track_use(&mut self, id: &str, name: &str) -> Result<(), StuckToolTrackingError> {
        let Some(name) = StuckToolName::parse(name) else {
            return Ok(());
        };

        if id.len() > MAX_TRACKED_STUCK_TOOL_ID_BYTES {
            return Err(StuckToolTrackingError::ToolUseIdTooLong {
                max_bytes: MAX_TRACKED_STUCK_TOOL_ID_BYTES,
            });
        }

        if let Some((tracked_name, started)) = self.entries.get_mut(id) {
            *tracked_name = name;
            *started = Instant::now();
            return Ok(());
        }

        if self.entries.len() >= MAX_TRACKED_STUCK_TOOLS {
            return Err(StuckToolTrackingError::CapacityExceeded {
                max_entries: MAX_TRACKED_STUCK_TOOLS,
            });
        }

        self.entries.insert(id.to_owned(), (name, Instant::now()));
        Ok(())
    }

    pub(super) fn oldest_expired(&self, timeout_secs: u64) -> Option<(StuckToolName, u64)> {
        self.entries
            .values()
            .filter_map(|(name, started)| {
                let elapsed = started.elapsed().as_secs();
                (elapsed >= timeout_secs).then_some((*name, elapsed, *started))
            })
            .min_by_key(|(_, _, started)| *started)
            .map(|(name, elapsed, _)| (name, elapsed))
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    fn contains_key(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
}

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

pub(super) fn track_claude_tool_events(
    event: &serde_json::Value,
    tracker: &mut StuckToolTracker,
) -> Result<(), StuckToolTrackingError> {
    tracker.track_event(event)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn track_claude_tools_updates_in_flight_state() {
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
        let mut tracker = StuckToolTracker::new();

        track_claude_tool_events(&tool_use, &mut tracker).unwrap();
        assert!(tracker.contains_key("tool-1"));

        track_claude_tool_events(&tool_result, &mut tracker).unwrap();
        assert_eq!(tracker.len(), 0);
    }
}
