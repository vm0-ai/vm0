//! Event sending — forwards masked JSONL events to the webhook endpoint.
//!
//! Extracts session ID from the `system/init` event and persists it for
//! checkpoint use.

use crate::env;
use crate::error::AgentError;
use crate::http;
use crate::masker::SecretMasker;
use crate::paths;
use crate::urls;
use guest_common::{log_error, log_info};
use serde_json::{Value, json};

const LOG_TAG: &str = "sandbox:guest-agent";

/// Send a single event to the webhook, masking secrets first.
///
/// On the init event, extracts and persists the session ID and
/// session history path.
pub async fn send_event(
    event: &mut Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), AgentError> {
    let Some(payload) = prepare_event(event, seq, masker) else {
        return Ok(());
    };
    post_event(&payload).await
}

/// Prepare an event for sending: extract session ID, add sequence number,
/// mask secrets, and build the HTTP payload.
///
/// Returns `None` if there is no API token (local/test mode) or the event
/// should not be posted.  This function is fast (no I/O) and safe to call
/// inline in the stdout reading loop.
pub fn prepare_event(event: &mut Value, seq: u32, masker: &SecretMasker) -> Option<Value> {
    // Extract session ID from init event (must happen before masking)
    extract_session_id(event);

    // No API token → local/test mode; skip posting events.
    if !env::has_api() {
        return None;
    }

    // Add sequence number
    if let Some(obj) = event.as_object_mut() {
        obj.insert("sequenceNumber".to_string(), json!(seq));
    }

    // Mask secrets
    masker.mask_value(event);

    // Build payload
    Some(json!({
        "runId": env::run_id(),
        "events": [event],
    }))
}

/// POST a prepared event payload to the webhook endpoint.
pub async fn post_event(payload: &Value) -> Result<(), AgentError> {
    match http::post_json(
        urls::events_url(),
        payload,
        crate::constants::HTTP_MAX_RETRIES,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(e) => {
            log_error!(LOG_TAG, "Failed to send event after retries");
            let _ = std::fs::write(paths::event_error_flag(), "1");
            Err(e)
        }
    }
}

/// Tool event extracted from a Claude Code JSONL line.
#[derive(Debug, PartialEq)]
pub(crate) enum ClaudeToolEvent<'a> {
    /// Tool invocation: `(tool_use_id, tool_name)`.
    Use { id: &'a str, name: &'a str },
    /// Tool result: `(tool_use_id)`.
    Result { tool_use_id: &'a str },
}

/// Extract tool call info from a Claude Code JSONL event.
///
/// Iterates all content blocks (handles `[text, tool_use]` and parallel
/// `[tool_use, tool_use]` patterns).  Returns an empty vec for non-tool
/// events.
pub(crate) fn extract_claude_tool_info(event: &Value) -> Vec<ClaudeToolEvent<'_>> {
    let Some(contents) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    let mut results = Vec::new();
    for content in contents {
        let Some(content_type) = content.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        match content_type {
            "tool_use" => {
                if let (Some(id), Some(name)) = (
                    content.get("id").and_then(|v| v.as_str()),
                    content.get("name").and_then(|v| v.as_str()),
                ) {
                    results.push(ClaudeToolEvent::Use { id, name });
                }
            }
            "tool_result" => {
                if let Some(tool_use_id) = content.get("tool_use_id").and_then(|v| v.as_str()) {
                    results.push(ClaudeToolEvent::Result { tool_use_id });
                }
            }
            _ => {}
        }
    }
    results
}

/// If this is an init event, extract session ID and write temp files.
fn extract_session_id(event: &Value) {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let subtype = event.get("subtype").and_then(|v| v.as_str()).unwrap_or("");

    let session_id = if event_type == "system" && subtype == "init" {
        event.get("session_id").and_then(|v| v.as_str())
    } else {
        None
    };

    let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
        return;
    };

    // Only write once
    if std::path::Path::new(paths::session_id_file()).exists() {
        return;
    }

    log_info!(LOG_TAG, "Captured session ID: {session_id}");
    let _ = std::fs::write(paths::session_id_file(), session_id);

    // Build session history path
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let working_dir = env::working_dir();
    let project_name = working_dir
        .strip_prefix('/')
        .unwrap_or(working_dir)
        .replace('/', "-");
    let history_path = format!("{home}/.claude/projects/-{project_name}/{session_id}.jsonl");

    let _ = std::fs::write(paths::session_history_path_file(), &history_path);
    log_info!(LOG_TAG, "Session history will be at: {history_path}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_tool_use() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}}]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Use {
                id: "t1",
                name: "WebFetch"
            }]
        );
    }

    #[test]
    fn extract_tool_result() {
        let event = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Result { tool_use_id: "t1" }]
        );
    }

    #[test]
    fn extract_text_then_tool_use() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "Let me search..."},
                    {"type": "tool_use", "id": "t2", "name": "WebSearch", "input": {}}
                ]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Use {
                id: "t2",
                name: "WebSearch"
            }]
        );
    }

    #[test]
    fn extract_parallel_tool_uses() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}},
                    {"type": "tool_use", "id": "t2", "name": "WebSearch", "input": {}}
                ]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![
                ClaudeToolEvent::Use {
                    id: "t1",
                    name: "WebFetch"
                },
                ClaudeToolEvent::Use {
                    id: "t2",
                    name: "WebSearch"
                },
            ]
        );
    }

    #[test]
    fn extract_tool_use_missing_id_skipped() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "WebFetch", "input": {}}]
            }
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_tool_result_missing_id_skipped() {
        let event = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "content": "ok"}]
            }
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_text_event_returns_empty() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "hello"}]
            }
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_non_network_tool_still_parsed() {
        // Non-network tools (Bash, Read, etc.) ARE parsed by extract_claude_tool_info.
        // Filtering by STUCK_TOOL_NAMES happens in the caller (cli.rs watchdog).
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 999"}}]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Use {
                id: "t1",
                name: "Bash"
            }]
        );
    }

    #[test]
    fn extract_init_event_returns_empty() {
        let event = serde_json::json!({"type": "system", "subtype": "init"});
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_empty_content_returns_empty() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {"content": []}
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }
}
