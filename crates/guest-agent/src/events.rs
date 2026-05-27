//! Event sending — forwards masked JSONL events to the webhook endpoint.
//!
//! Captures framework session metadata for checkpoint use and prepares masked
//! event payloads for webhook delivery.

use crate::constants;
use crate::env;
use crate::env::Framework;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use agent_diagnostics::FailureReason;
use guest_common::{log_error, log_info};
use serde_json::{Value, json};

const LOG_TAG: &str = "sandbox:guest-agent";
const FAILURE_DIAGNOSTIC_MAX_BYTES: usize = 4096;
const FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX: &str = "...[truncated]";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CodexFailureDiagnostic {
    pub event_type: &'static str,
    pub message: String,
    pub failure_reason: Option<FailureReason>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ClaudeFailureDiagnostic {
    pub subtype: Option<&'static str>,
    pub message: String,
}

/// Send a single event to the webhook.
///
/// On framework session-start events, captures the session metadata needed by
/// checkpoints before preparing the webhook payload.
pub async fn send_event(
    http: &HttpClient,
    event: &mut Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), AgentError> {
    capture_session_metadata(event);

    if !http.has_api() {
        return Ok(());
    }

    let payload = prepare_event(event, seq, masker);
    post_event(http, &payload).await
}

/// Prepare an event webhook payload by adding a sequence number, masking
/// secrets, and wrapping the event in the HTTP payload shape.
///
/// This function does not perform filesystem or network I/O; session metadata
/// capture is handled separately before payload preparation, and network
/// delivery happens in `post_event` / `send_event`.
pub fn prepare_event(event: &mut Value, seq: u32, masker: &SecretMasker) -> Value {
    // Add sequence number
    if let Some(obj) = event.as_object_mut() {
        obj.insert("sequenceNumber".to_string(), json!(seq));
    }

    // Mask secrets
    masker.mask_value(event);

    // Build payload
    json!({
        "runId": env::run_id(),
        "events": [event],
    })
}

/// Extract a secret-masked Codex failure diagnostic from stdout JSONL.
///
/// Codex reports terminal failures on stdout JSONL (`type=error` or
/// `type=turn.failed`), while the guest-agent process failure summary is built
/// from stderr. Logging these events into the system log preserves the real
/// failure reason when stderr only contains side-channel background-task noise.
pub(crate) fn masked_codex_failure_diagnostic(
    event: &Value,
    masker: &SecretMasker,
) -> Option<CodexFailureDiagnostic> {
    let diagnostic = extract_codex_failure_diagnostic(event)?;
    Some(CodexFailureDiagnostic {
        event_type: diagnostic.event_type,
        message: mask_and_truncate_diagnostic(&diagnostic.message, masker),
        failure_reason: diagnostic.failure_reason,
    })
}

/// Extract a secret-masked Claude Code terminal failure diagnostic.
///
/// Claude Code reports the terminal run outcome as `type=result`. On failure,
/// the `result` field carries the concise terminal reason that is otherwise
/// lost when stderr is empty.
pub(crate) fn masked_claude_failure_diagnostic(
    event: &Value,
    masker: &SecretMasker,
) -> Option<ClaudeFailureDiagnostic> {
    let diagnostic = extract_claude_failure_diagnostic(event)?;
    Some(ClaudeFailureDiagnostic {
        subtype: diagnostic.subtype,
        message: mask_and_truncate_diagnostic(&diagnostic.message, masker),
    })
}

pub(crate) fn is_generic_codex_failure_diagnostic(message: &str) -> bool {
    matches!(message.trim(), "error" | "turn failed" | "turn interrupted")
}

fn extract_codex_failure_diagnostic(event: &Value) -> Option<CodexFailureDiagnostic> {
    match event.get("type").and_then(Value::as_str)? {
        "error" => {
            let error = event.get("error");
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: raw_message_from_field(event.get("message"))
                    .or_else(|| codex_error_message(error))
                    .unwrap_or_else(|| "error".into()),
                failure_reason: codex_event_failure_reason(event, error),
            })
        }
        "turn.failed" => {
            let error = event.get("error");
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: codex_error_message(error).unwrap_or_else(|| "turn failed".into()),
                failure_reason: codex_event_failure_reason(event, error),
            })
        }
        "turn.completed" => {
            let status = codex_turn_completed_failure_status(event)?;
            let error = event.pointer("/turn/error").or_else(|| event.get("error"));
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: codex_error_message(error).unwrap_or_else(|| format!("turn {status}")),
                failure_reason: codex_event_failure_reason(event, error),
            })
        }
        _ => None,
    }
}

fn extract_claude_failure_diagnostic(event: &Value) -> Option<ClaudeFailureDiagnostic> {
    if event.get("type").and_then(Value::as_str)? != "result" {
        return None;
    }

    let raw_subtype = event.get("subtype").and_then(Value::as_str);
    let subtype = match raw_subtype {
        Some("error") => Some("error"),
        _ => None,
    };
    let is_failure = event.get("is_error").and_then(Value::as_bool) == Some(true)
        || raw_subtype == Some("error");
    if !is_failure {
        return None;
    }

    Some(ClaudeFailureDiagnostic {
        subtype,
        message: raw_message_from_field(event.get("result"))?,
    })
}

fn codex_turn_completed_failure_status(event: &Value) -> Option<&'static str> {
    let status = event
        .pointer("/turn/status")
        .or_else(|| event.get("status"))
        .and_then(Value::as_str)?;
    match status {
        "failed" | "Failed" => Some("failed"),
        "interrupted" | "Interrupted" => Some("interrupted"),
        _ => None,
    }
}

fn codex_error_message(error: Option<&Value>) -> Option<String> {
    let error = error?;
    if let Some(message) = raw_message_from_field(Some(error)) {
        return Some(message);
    }

    let message = error.get("message").and_then(Value::as_str);
    let details = error.get("additional_details").and_then(Value::as_str);
    combined_message_and_details(message, details)
}

fn codex_error_failure_reason(error: Option<&Value>) -> Option<FailureReason> {
    let error = error?;
    if error.get("code").and_then(Value::as_str) == Some("invalid_api_key") {
        return Some(FailureReason::InvalidApiKey);
    }
    None
}

fn codex_event_failure_reason(event: &Value, error: Option<&Value>) -> Option<FailureReason> {
    codex_error_failure_reason(error).or_else(|| codex_error_failure_reason(Some(event)))
}

fn raw_message_from_field(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed_message)
}

fn combined_message_and_details(message: Option<&str>, details: Option<&str>) -> Option<String> {
    match (
        message.and_then(trimmed_message),
        details.and_then(trimmed_message),
    ) {
        (Some(message), Some(details)) => Some(format!("{message} ({details})")),
        (Some(message), None) => Some(message),
        (None, Some(details)) => Some(details),
        (None, None) => None,
    }
}

fn trimmed_message(message: &str) -> Option<String> {
    let message = message.trim();
    if message.is_empty() {
        return None;
    }

    Some(message.to_string())
}

fn mask_and_truncate_diagnostic(message: &str, masker: &SecretMasker) -> String {
    truncate_diagnostic_message(&escape_log_line_breaks(&masker.mask_string(message)))
}

fn escape_log_line_breaks(message: &str) -> String {
    message.replace('\r', "\\r").replace('\n', "\\n")
}

fn truncate_diagnostic_message(message: &str) -> String {
    if message.len() <= FAILURE_DIAGNOSTIC_MAX_BYTES {
        return message.to_string();
    }

    let mut end = FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len();
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &message[..end], FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX)
}

/// POST a prepared event payload to the webhook endpoint.
pub async fn post_event(http: &HttpClient, payload: &Value) -> Result<(), AgentError> {
    let url = http.events_url()?;
    match http
        .post_json(url, payload, constants::HTTP_MAX_RETRIES)
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

/// If this is a session-start event, capture the session id and persist the
/// session-history-path metadata files for checkpoint use.
///
/// Both frameworks emit a single id-bearing event near the top of their
/// JSONL stream:
/// - Claude Code: `{type: system, subtype: init, session_id: <uuid>}`
/// - Codex:       `{type: thread.started, thread_id: <uuid>}`
///
/// The on-disk format of `session_history_path_file()` differs by framework:
/// - Claude: literal `~/.claude/projects/-{cwd}/{session_id}.jsonl` path.
/// - Codex: `CODEX_SEARCH:{sessions_dir}:{thread_id}` marker — codex
///   doesn't write the session file until turn-completion, so resolution
///   is deferred to checkpoint time.
pub(crate) fn capture_session_metadata(event: &Value) {
    let parsed = match Framework::from_env() {
        Framework::ClaudeCode => extract_claude_session_id(event),
        Framework::Codex => extract_codex_thread_id(event),
    };
    let Some((session_id, history_path_payload)) = parsed else {
        return;
    };

    // Idempotency: only the first id-bearing event of the run wins.
    if std::path::Path::new(paths::session_id_file()).exists() {
        return;
    }

    log_info!(LOG_TAG, "Captured session ID: {session_id}");
    let _ = std::fs::write(paths::session_id_file(), &session_id);
    let _ = std::fs::write(paths::session_history_path_file(), &history_path_payload);
    log_info!(
        LOG_TAG,
        "Session history will be at: {history_path_payload}"
    );
}

/// Claude variant — matches `system/init` and computes the project-scoped
/// jsonl path under `$HOME/.claude/projects/-{cwd}/`.
fn extract_claude_session_id(event: &Value) -> Option<(String, String)> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let subtype = event.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "system" || subtype != "init" {
        return None;
    }
    let session_id = event.get("session_id").and_then(|v| v.as_str())?;
    if session_id.is_empty() {
        return None;
    }

    let home = env::home_dir();
    let working_dir = env::working_dir();
    let project_name = working_dir
        .strip_prefix('/')
        .unwrap_or(working_dir)
        .replace('/', "-");
    let history_path = format!("{home}/.claude/projects/-{project_name}/{session_id}.jsonl");
    Some((session_id.to_string(), history_path))
}

/// Codex variant — matches `thread.started` and emits a `CODEX_SEARCH:`
/// marker pointing at `${HOME}/.codex/sessions` plus the thread_id.
fn extract_codex_thread_id(event: &Value) -> Option<(String, String)> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "thread.started" {
        return None;
    }
    let thread_id = event.get("thread_id").and_then(|v| v.as_str())?;
    crate::session_history::normalize_codex_thread_id(thread_id)?;

    let home = env::home_dir();
    let marker = format!("CODEX_SEARCH:{home}/.codex/sessions:{thread_id}");
    Some((thread_id.to_string(), marker))
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

    #[test]
    fn codex_error_event_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "error",
            "message": "server rejected request"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "server rejected request".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_top_level_invalid_api_key_code_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "code": "invalid_api_key",
            "message": "Incorrect API key provided"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Incorrect API key provided".to_string(),
                failure_reason: Some(FailureReason::InvalidApiKey),
            })
        );
    }

    #[test]
    fn codex_turn_failed_event_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {"message": "turn failed from server"}
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "turn failed from server".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_invalid_api_key_code_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "code": "invalid_api_key",
                "message": "Incorrect API key provided"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "Incorrect API key provided".to_string(),
                failure_reason: Some(FailureReason::InvalidApiKey),
            })
        );
    }

    #[test]
    fn codex_turn_failed_appends_additional_details() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed from server",
                "additional_details": "rate limit exceeded"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "turn failed from server (rate limit exceeded)".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_legacy_string_error_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": "legacy turn failure"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "legacy turn failure".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_unknown_object_uses_generic_message() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {"code": "internal", "context": "not a public error message"}
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "turn failed".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_accepts_nested_error_shape() {
        let event = serde_json::json!({
            "type": "error",
            "error": {
                "message": "server rejected request",
                "additional_details": "policy denied"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "server rejected request (policy denied)".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failed_turn_completed_event_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "turn.completed",
            "turn": {
                "status": "failed",
                "error": {"message": "failed TurnCompleted reason"}
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "failed TurnCompleted reason".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failure_diagnostic_masks_secrets() {
        let event = serde_json::json!({
            "type": "error",
            "message": "request failed with token supersecret"
        });
        let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &masker),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "request failed with token ***".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failure_diagnostic_escapes_line_breaks() {
        let event = serde_json::json!({
            "type": "error",
            "message": "first line\nsecond line\rthird line"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "first line\\nsecond line\\rthird line".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failure_diagnostic_masks_before_truncating() {
        let prefix = "x".repeat(
            FAILURE_DIAGNOSTIC_MAX_BYTES
                - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len()
                - "super".len(),
        );
        let event = serde_json::json!({
            "type": "error",
            "message": format!("{prefix}supersecret after-boundary")
        });
        let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");
        let diagnostic = masked_codex_failure_diagnostic(&event, &masker)
            .expect("error event should produce a diagnostic");

        assert!(
            diagnostic.message.contains("***"),
            "diagnostic should keep the masked token marker: {diagnostic:?}"
        );
        assert!(
            !diagnostic.message.contains("super"),
            "diagnostic should not leak a partial secret near the truncation boundary: {diagnostic:?}"
        );
    }

    #[test]
    fn codex_failure_diagnostic_truncates_to_max_bytes() {
        let event = serde_json::json!({
            "type": "error",
            "message": "x".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES + 100)
        });
        let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("error event should produce a diagnostic");

        assert_eq!(diagnostic.message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
        assert!(
            diagnostic
                .message
                .ends_with(FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX),
            "diagnostic should end with truncation marker: {diagnostic:?}"
        );
    }

    #[test]
    fn claude_error_result_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "is_error": true,
            "result": "permission denied while running command"
        });

        assert_eq!(
            masked_claude_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(ClaudeFailureDiagnostic {
                subtype: Some("error"),
                message: "permission denied while running command".to_string(),
            })
        );
    }

    #[test]
    fn claude_error_subtype_without_is_error_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "result": "terminal result failed"
        });

        assert_eq!(
            masked_claude_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(ClaudeFailureDiagnostic {
                subtype: Some("error"),
                message: "terminal result failed".to_string(),
            })
        );
    }

    #[test]
    fn claude_failure_diagnostic_drops_unrecognized_subtype() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "secret\nsubtype",
            "is_error": true,
            "result": "terminal result failed"
        });

        assert_eq!(
            masked_claude_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(ClaudeFailureDiagnostic {
                subtype: None,
                message: "terminal result failed".to_string(),
            })
        );
    }

    #[test]
    fn claude_success_result_has_no_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "Done."
        });

        assert_eq!(
            masked_claude_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn claude_error_result_requires_nonempty_result_message() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "is_error": true,
            "result": " \n\t "
        });

        assert_eq!(
            masked_claude_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn claude_failure_diagnostic_masks_and_escapes_line_breaks() {
        let event = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "first line with supersecret\nsecond\rthird"
        });
        let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");

        assert_eq!(
            masked_claude_failure_diagnostic(&event, &masker),
            Some(ClaudeFailureDiagnostic {
                subtype: None,
                message: "first line with ***\\nsecond\\rthird".to_string(),
            })
        );
    }

    #[test]
    fn claude_failure_diagnostic_truncates_to_max_bytes() {
        let event = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "é".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES)
        });
        let diagnostic = masked_claude_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("Claude error result should produce a diagnostic");

        assert_eq!(diagnostic.message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
        assert!(
            diagnostic
                .message
                .ends_with(FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX),
            "diagnostic should end with truncation marker: {diagnostic:?}"
        );
        assert!(diagnostic.message.is_char_boundary(
            FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len()
        ));
    }

    #[test]
    fn non_failure_codex_event_has_no_failure_diagnostic() {
        let event = serde_json::json!({"type": "turn.completed", "usage": {}});

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    // Note: end-to-end coverage of `capture_session_metadata` (including both
    // the Claude `system/init` branch and the codex `thread.started`
    // branch) lives in the integration test suites:
    //   - `tests/integration.rs::send_event_extracts_claude_session_id`
    //   - `tests/codex_session_resume.rs` (codex variant + read-back)
    // The Claude/Codex helpers are private; their contracts are
    // exercised transitively through `send_event`.
}
