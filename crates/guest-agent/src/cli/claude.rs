//! Claude Code result parsing and tool tracking.

use crate::events;
use std::collections::HashMap;
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

    pub(super) fn track_event(&mut self, event: &serde_json::Value) {
        for tool_event in events::extract_claude_tool_info(event) {
            match tool_event {
                events::ClaudeToolEvent::Use { id, name } => self.track_use(id, name),
                events::ClaudeToolEvent::Result { tool_use_id } => {
                    self.entries.remove(tool_use_id);
                }
            }
        }
    }

    fn track_use(&mut self, id: &str, name: &str) {
        let Some(name) = StuckToolName::parse(name) else {
            return;
        };

        if id.len() > MAX_TRACKED_STUCK_TOOL_ID_BYTES {
            // Tracking is auxiliary state.  Keep the event stream alive when
            // an ID cannot be retained within the watchdog bound.
            return;
        }

        if let Some((tracked_name, started)) = self.entries.get_mut(id) {
            *tracked_name = name;
            *started = Instant::now();
            return;
        }

        if self.entries.len() >= MAX_TRACKED_STUCK_TOOLS {
            // Do not evict an older call: eviction could hide a genuinely
            // stuck network request.  Once a slot is freed by its result,
            // later calls can be tracked normally again.
            return;
        }

        self.entries.insert(id.to_owned(), (name, Instant::now()));
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

pub(super) fn track_claude_tool_events(event: &serde_json::Value, tracker: &mut StuckToolTracker) {
    tracker.track_event(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn track_tool_use(tracker: &mut StuckToolTracker, id: &str, name: &str) {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": id, "name": name}]
            }
        });

        track_claude_tool_events(&event, tracker);
    }

    fn track_tool_result(tracker: &mut StuckToolTracker, id: &str) {
        let event = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": id}]
            }
        });

        track_claude_tool_events(&event, tracker);
    }

    fn fill_stuck_tool_tracker(tracker: &mut StuckToolTracker) {
        for index in 0..MAX_TRACKED_STUCK_TOOLS {
            track_tool_use(tracker, &format!("tool-{index}"), "WebFetch");
        }
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
    fn track_claude_tools_updates_in_flight_state() {
        let mut tracker = StuckToolTracker::new();

        track_tool_use(&mut tracker, "tool-1", "WebFetch");
        assert!(tracker.contains_key("tool-1"));

        track_tool_result(&mut tracker, "tool-1");
        assert_eq!(tracker.len(), 0);
    }

    #[test]
    fn stuck_tool_tracker_enforces_capacity_and_reuses_freed_slot() {
        let mut tracker = StuckToolTracker::new();
        fill_stuck_tool_tracker(&mut tracker);

        assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
        assert!(tracker.contains_key("tool-0"));
        assert!(tracker.contains_key(&format!("tool-{}", MAX_TRACKED_STUCK_TOOLS - 1)));

        track_tool_use(&mut tracker, "overflow", "WebSearch");

        assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
        assert!(!tracker.contains_key("overflow"));
        assert!(tracker.contains_key("tool-0"));

        track_tool_result(&mut tracker, "tool-0");

        assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS - 1);
        assert!(!tracker.contains_key("tool-0"));

        track_tool_use(&mut tracker, "later", "WebSearch");

        assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
        assert!(tracker.contains_key("later"));
    }

    #[tokio::test(start_paused = true)]
    async fn stuck_tool_tracker_refreshes_duplicate_at_capacity() {
        let mut tracker = StuckToolTracker::new();
        fill_stuck_tool_tracker(&mut tracker);
        tokio::time::advance(Duration::from_secs(1)).await;

        track_tool_use(&mut tracker, "tool-0", "WebSearch");

        assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
        for index in 1..MAX_TRACKED_STUCK_TOOLS {
            track_tool_result(&mut tracker, &format!("tool-{index}"));
        }
        assert_eq!(tracker.len(), 1);
        assert_eq!(tracker.oldest_expired(1), None);
        assert_eq!(
            tracker.oldest_expired(0).map(|(name, _)| name),
            Some(StuckToolName::WebSearch)
        );
    }

    #[test]
    fn stuck_tool_tracker_ignores_unsupported_tools() {
        let mut tracker = StuckToolTracker::new();

        track_tool_use(&mut tracker, "unsupported", "Bash");

        assert_eq!(tracker.len(), 0);
        assert!(!tracker.contains_key("unsupported"));
    }

    #[test]
    fn stuck_tool_tracker_enforces_id_size_limit() {
        let mut tracker = StuckToolTracker::new();
        let maximum_id = "x".repeat(MAX_TRACKED_STUCK_TOOL_ID_BYTES);
        let oversized_id = "y".repeat(MAX_TRACKED_STUCK_TOOL_ID_BYTES + 1);

        track_tool_use(&mut tracker, &maximum_id, "WebFetch");
        track_tool_use(&mut tracker, &oversized_id, "WebFetch");

        assert_eq!(tracker.len(), 1);
        assert!(tracker.contains_key(&maximum_id));
        assert!(!tracker.contains_key(&oversized_id));
    }
}
