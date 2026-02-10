//! Event sending — forwards masked JSONL events to the webhook endpoint.
//!
//! Extracts session ID from the init event (Claude: `system/init`,
//! Codex: `thread.started`) and persists it for checkpoint use.

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
///
/// Returns `true` on success.
pub async fn send_event(
    event: &mut Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<bool, AgentError> {
    // Extract session ID from init event
    extract_session_id(event);

    // Add sequence number
    if let Some(obj) = event.as_object_mut() {
        obj.insert("sequenceNumber".to_string(), json!(seq));
    }

    // Mask secrets
    masker.mask_value(event);

    // POST to events endpoint
    let payload = json!({
        "runId": env::run_id(),
        "events": [event],
    });

    match http::post_json(
        urls::events_url(),
        &payload,
        crate::constants::HTTP_MAX_RETRIES,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(e) => {
            log_error!(LOG_TAG, "Failed to send event after retries");
            // Write error flag
            let _ = std::fs::write(paths::event_error_flag(), "1");
            Err(e)
        }
    }
}

/// If this is an init event, extract session ID and write temp files.
fn extract_session_id(event: &Value) {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

    let session_id = if env::cli_agent_type() == "codex" {
        if event_type == "thread.started" {
            event.get("thread_id").and_then(|v| v.as_str())
        } else {
            None
        }
    } else {
        let subtype = event.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if event_type == "system" && subtype == "init" {
            event.get("session_id").and_then(|v| v.as_str())
        } else {
            None
        }
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

    let history_path = if env::cli_agent_type() == "codex" {
        let codex_home = std::env::var("CODEX_HOME").unwrap_or_else(|_| format!("{home}/.codex"));
        format!("CODEX_SEARCH:{codex_home}/sessions:{session_id}")
    } else {
        let working_dir = env::working_dir();
        let project_name = working_dir
            .strip_prefix('/')
            .unwrap_or(working_dir)
            .replace('/', "-");
        format!("{home}/.claude/projects/-{project_name}/{session_id}.jsonl")
    };

    let _ = std::fs::write(paths::session_history_path_file(), &history_path);
    log_info!(LOG_TAG, "Session history will be at: {history_path}");
}
