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
use crate::session_metadata;
use guest_common::{log_error, log_info};
use guest_contracts::diagnostics::FailureReason;
use serde_json::{Map, Value, json};

const LOG_TAG: &str = "sandbox:guest-agent";
const FAILURE_DIAGNOSTIC_MAX_BYTES: usize = 4096;
const FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX: &str = "...[truncated]";
const CODEX_OAUTH_TOKEN_CONNECTOR: &str = "codex-oauth-token";
const CODEX_MODEL_CAPACITY_MESSAGE: &str =
    "selected model is at capacity. please try a different model.";
const CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX: &str =
    "codex ran out of room in the model's context window.";

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
    event: Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), AgentError> {
    let mut capture = SessionMetadataCapture::new();
    capture.capture_event(&event, masker);

    if !http.has_api() {
        return Ok(());
    }

    let payload = prepare_event_payload(event, seq, masker);
    post_event(http, &payload).await
}

/// Prepare an event webhook payload by adding a sequence number, masking secrets,
/// and moving the event into the HTTP payload shape.
///
/// This function does not perform filesystem or network I/O; session metadata
/// capture is handled separately before payload preparation, and network
/// delivery happens in `post_event` / `send_event`.
pub fn prepare_event_payload(event: Value, seq: u32, masker: &SecretMasker) -> Value {
    prepare_event_payload_for_run_id(event, seq, masker, env::run_id())
}

pub(crate) fn prepare_event_payload_for_run_id(
    mut event: Value,
    seq: u32,
    masker: &SecretMasker,
    run_id: &str,
) -> Value {
    // Add sequence number
    if let Some(obj) = event.as_object_mut() {
        obj.insert("sequenceNumber".to_string(), json!(seq));
    }

    // Mask secrets
    masker.mask_value(&mut event);

    let mut payload = Map::new();
    payload.insert("runId".to_string(), Value::String(run_id.to_string()));
    payload.insert("events".to_string(), Value::Array(vec![event]));
    Value::Object(payload)
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

pub fn is_generic_codex_failure_diagnostic(message: &str) -> bool {
    let message = message.trim().to_ascii_lowercase();
    let message = message.trim_end_matches(['.', ':', '!', '?']).trim_end();
    matches!(
        message,
        "error" | "turn failed" | "turn interrupted" | "unknown error" | "codex error"
    )
}

pub fn is_codex_model_capacity_message(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains(CODEX_MODEL_CAPACITY_MESSAGE)
}

pub fn is_codex_context_window_exceeded_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains(CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX)
        && (message.contains("start a new thread") || message.contains("start a new conversation"))
        && message.contains("clear earlier history")
        && message.contains("before retrying")
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
            let turn_error = codex_structured_turn_error(event);
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: codex_turn_failed_message(error, turn_error),
                failure_reason: codex_event_failure_reason_from_errors(event, [turn_error, error]),
            })
        }
        "turn.completed" => {
            let status = codex_turn_completed_failure_status(event)?;
            let turn_error = codex_structured_turn_error(event);
            let error = event.get("error");
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: codex_best_error_message([turn_error, error])
                    .unwrap_or_else(|| format!("turn {status}")),
                failure_reason: codex_event_failure_reason_from_errors(event, [turn_error, error]),
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

fn codex_structured_turn_error(event: &Value) -> Option<&Value> {
    event
        .pointer("/turn/error")
        .filter(|error| !error.is_null())
}

fn codex_turn_failed_message(error: Option<&Value>, turn_error: Option<&Value>) -> String {
    let top_level_message = codex_error_message(error);
    let top_level_primary_message = codex_error_primary_message(error);
    let turn_error_message = codex_error_message(turn_error);
    let turn_error_is_specific = turn_error_message
        .as_deref()
        .is_some_and(|message| !is_generic_codex_failure_diagnostic(message));
    let top_level_should_yield = top_level_primary_message
        .as_deref()
        .map(is_generic_codex_failure_diagnostic)
        .unwrap_or(true)
        && turn_error_is_specific;

    match (top_level_message, turn_error_message) {
        (Some(_), Some(turn_error_message)) if top_level_should_yield => turn_error_message,
        (Some(message), _) => message,
        (None, Some(turn_error_message)) => turn_error_message,
        (None, None) => "turn failed".into(),
    }
}

fn codex_best_error_message<const N: usize>(errors: [Option<&Value>; N]) -> Option<String> {
    let mut first_generic_message = None;
    for error in errors {
        let Some(message) = codex_error_message(error) else {
            continue;
        };
        if !is_generic_codex_failure_diagnostic(&message) {
            return Some(message);
        }
        if first_generic_message.is_none() {
            first_generic_message = Some(message);
        }
    }
    first_generic_message
}

fn codex_error_message(error: Option<&Value>) -> Option<String> {
    let error = error?;
    if let Some(message) = raw_message_from_field(Some(error)) {
        return Some(message);
    }

    let message = error.get("message").and_then(Value::as_str);
    let details = error
        .get("additional_details")
        .or_else(|| error.get("additionalDetails"))
        .and_then(Value::as_str);
    combined_message_and_details(message, details)
}

fn codex_error_primary_message(error: Option<&Value>) -> Option<String> {
    let error = error?;
    raw_message_from_field(Some(error)).or_else(|| {
        error
            .get("message")
            .and_then(Value::as_str)
            .and_then(trimmed_message)
    })
}

fn codex_error_failure_reason(error: Option<&Value>) -> Option<FailureReason> {
    let error = error?;
    if error.get("code").and_then(Value::as_str) == Some("invalid_api_key") {
        return Some(FailureReason::InvalidApiKey);
    }
    if codex_refresh_error_code(error) == Some("TOKEN_REFRESH_FAILED")
        && error.get("failureReason").and_then(Value::as_str) == Some("reconnect_required")
        && has_exact_codex_oauth_connector(error)
    {
        return Some(FailureReason::ReconnectRequired);
    }
    if let Some(failure_reason) = codex_error_info_failure_reason(error) {
        return Some(failure_reason);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_model_capacity_message)
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_context_window_exceeded_message)
    {
        return Some(FailureReason::ContextWindowExceeded);
    }
    None
}

fn codex_event_failure_reason(event: &Value, error: Option<&Value>) -> Option<FailureReason> {
    codex_event_failure_reason_from_errors(event, [error])
}

fn codex_event_failure_reason_from_errors<const N: usize>(
    event: &Value,
    errors: [Option<&Value>; N],
) -> Option<FailureReason> {
    for error in errors.into_iter().flatten() {
        if let Some(failure_reason) = codex_error_failure_reason(Some(error)) {
            return Some(failure_reason);
        }
    }

    codex_error_failure_reason(Some(event))
}

fn codex_error_info_failure_reason(error: &Value) -> Option<FailureReason> {
    match codex_error_info_variant(error)? {
        "serverOverloaded" => Some(FailureReason::ProviderOverloaded),
        "usageLimitExceeded" => Some(FailureReason::UsageLimit),
        _ => None,
    }
}

fn codex_error_info_variant(error: &Value) -> Option<&str> {
    let error_info = error
        .get("codex_error_info")
        .or_else(|| error.get("codexErrorInfo"))?;

    match error_info {
        Value::String(variant) => Some(variant.as_str()),
        Value::Object(object) if object.len() == 1 => object.keys().next().map(String::as_str),
        _ => None,
    }
}

fn codex_refresh_error_code(value: &Value) -> Option<&str> {
    value
        .get("code")
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
}

fn has_exact_codex_oauth_connector(value: &Value) -> bool {
    value
        .get("connectors")
        .and_then(Value::as_array)
        .is_some_and(|connectors| {
            connectors.len() == 1
                && connectors.first().and_then(Value::as_str) == Some(CODEX_OAUTH_TOKEN_CONNECTOR)
        })
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
    let paths = paths::legacy_paths_from_process_env();
    post_event_with_error_flag(http, payload, paths.event_error_flag()).await
}

pub async fn post_event_with_error_flag(
    http: &HttpClient,
    payload: &Value,
    event_error_flag: &str,
) -> Result<(), AgentError> {
    let url = http.events_url()?;
    match http
        .post_json(url, payload, constants::HTTP_MAX_RETRIES)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) => {
            log_error!(LOG_TAG, "Failed to send event after retries");
            let _ = paths::write_private(event_error_flag, "1");
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

/// Capture session metadata files needed by checkpoint.
///
/// Both frameworks emit a single id-bearing event near the top of their
/// JSONL stream:
/// - Claude Code: `{type: system, subtype: init, session_id: <uuid>}`
/// - Codex:       `{type: thread.started, thread_id: <uuid>}`
///
/// Ordinary events only seed the masker from an existing session id once; they
/// do not repair the history marker. Checkpoint resolves missing markers when
/// it consumes session metadata.
///
/// The on-disk format of `session_history_path_file()` differs by framework:
/// - Claude: literal `~/.claude/projects/-{cwd}/{session_id}.jsonl` path.
/// - Codex: length-prefixed `CODEX_SEARCH:{dir_len}:{sessions_dir}:{thread_id}`
///   marker — codex doesn't write the session file until turn-completion, so
///   resolution is deferred to checkpoint time.
pub(crate) struct SessionMetadataCapture {
    existing_session_id_seeded: bool,
    framework: Framework,
    home_dir: String,
    session_id_file: String,
    session_history_path_file: String,
}

impl SessionMetadataCapture {
    pub(crate) fn new() -> Self {
        let paths = paths::legacy_paths_from_process_env();
        Self::from_values(
            Framework::from_env(),
            env::home_dir(),
            paths.session_id_file(),
            paths.session_history_path_file(),
        )
    }

    pub(crate) fn from_values(
        framework: Framework,
        home_dir: &str,
        session_id_file: &str,
        session_history_path_file: &str,
    ) -> Self {
        Self {
            existing_session_id_seeded: false,
            framework,
            home_dir: home_dir.to_string(),
            session_id_file: session_id_file.to_string(),
            session_history_path_file: session_history_path_file.to_string(),
        }
    }

    pub(crate) fn capture_event(&mut self, event: &Value, masker: &SecretMasker) {
        self.register_event_session_identifier(event, masker);

        let session_id = match self.framework {
            Framework::ClaudeCode => extract_claude_session_id(event),
            Framework::Codex => extract_codex_thread_id(event),
        };
        let Some(session_id) = session_id else {
            self.seed_existing_session_id(masker);
            return;
        };
        let Some(history_path_payload) =
            session_metadata::history_marker_payload_for_session_id_with_home(
                self.framework,
                &self.home_dir,
                &session_id,
            )
        else {
            self.seed_existing_session_id(masker);
            return;
        };
        masker.add_sensitive_value(&session_id);

        // Idempotency: only the first id-bearing event of the run wins, but allow
        // a retry of the same session to repair a missing history marker after a
        // partial metadata write.
        match std::fs::read_to_string(&self.session_id_file) {
            Ok(existing_session_id) => {
                let existing_session_id = existing_session_id.trim();
                if !existing_session_id.is_empty() {
                    masker.add_sensitive_value(existing_session_id);
                    self.existing_session_id_seeded = true;
                }
                if existing_session_id == session_id {
                    session_metadata::ensure_history_marker_payload_at(
                        &self.session_history_path_file,
                        &history_path_payload,
                    );
                }
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                log_error!(
                    LOG_TAG,
                    "Failed to read existing session ID from {}: {e}",
                    self.session_id_file
                );
                return;
            }
        }

        log_info!(LOG_TAG, "Captured session ID");
        match paths::write_private(&self.session_id_file, &session_id) {
            Ok(()) => log_info!(LOG_TAG, "Session ID written to {}", self.session_id_file),
            Err(e) => log_error!(
                LOG_TAG,
                "Failed to write session ID to {}: {e}",
                self.session_id_file
            ),
        }
        self.existing_session_id_seeded = true;
        session_metadata::write_session_history_marker_at(
            &self.session_history_path_file,
            &history_path_payload,
        );
    }

    pub(crate) fn register_event_session_identifier(&self, event: &Value, masker: &SecretMasker) {
        register_event_session_identifier_for_framework(event, masker, self.framework);
    }

    fn seed_existing_session_id(&mut self, masker: &SecretMasker) {
        if self.existing_session_id_seeded {
            return;
        }
        self.existing_session_id_seeded = true;

        match std::fs::read_to_string(&self.session_id_file) {
            Ok(session_id) => {
                let session_id = session_id.trim();
                if !session_id.is_empty() {
                    masker.add_sensitive_value(session_id);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log_error!(
                LOG_TAG,
                "Failed to read existing session ID from {}: {e}",
                self.session_id_file
            ),
        }
    }
}

fn register_event_session_identifier_for_framework(
    event: &Value,
    masker: &SecretMasker,
    framework: Framework,
) {
    let id = match framework {
        Framework::ClaudeCode => string_field(event, "session_id"),
        Framework::Codex => string_field(event, "thread_id"),
    };
    if let Some(id) = id {
        masker.add_sensitive_value(id);
    }
}

fn string_field<'a>(event: &'a Value, field: &str) -> Option<&'a str> {
    event
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Claude variant — matches `system/init` and returns the raw Claude session id.
fn extract_claude_session_id(event: &Value) -> Option<String> {
    raw_claude_session_id(event).map(ToString::to_string)
}

fn raw_claude_session_id(event: &Value) -> Option<&str> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let subtype = event.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "system" || subtype != "init" {
        return None;
    }
    string_field(event, "session_id")
}

/// Codex variant — matches `thread.started` and returns the canonical Codex
/// thread id.
fn extract_codex_thread_id(event: &Value) -> Option<String> {
    let thread_id = raw_codex_thread_id(event)?;
    guest_contracts::codex_thread_id::canonical_codex_thread_id(thread_id)
}

fn raw_codex_thread_id(event: &Value) -> Option<&str> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "thread.started" {
        return None;
    }
    string_field(event, "thread_id")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_event_payload_adds_sequence_and_masks_object_event() {
        let event = serde_json::json!({
            "type": "test",
            "data": "contains secret-value"
        });
        let masker = SecretMasker::from_raw("c2VjcmV0LXZhbHVl");

        let payload = prepare_event_payload(event, 7, &masker);

        assert_eq!(payload["events"][0]["type"], "test");
        assert_eq!(payload["events"][0]["sequenceNumber"], 7);
        assert_eq!(payload["events"][0]["data"], "contains ***");
    }

    #[test]
    fn prepare_event_payload_wraps_non_object_event_without_sequence_number() {
        let event = serde_json::json!("contains secret-value");
        let masker = SecretMasker::from_raw("c2VjcmV0LXZhbHVl");

        let payload = prepare_event_payload(event, 7, &masker);

        assert_eq!(payload["events"][0], "contains ***");
    }

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
    fn codex_error_event_model_capacity_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Selected model is at capacity. Please try a different model."
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Selected model is at capacity. Please try a different model.".to_string(),
                failure_reason: Some(FailureReason::ProviderOverloaded),
            })
        );
    }

    #[test]
    fn codex_error_event_context_window_exceeded_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.".to_string(),
                failure_reason: Some(FailureReason::ContextWindowExceeded),
            })
        );
    }

    #[test]
    fn codex_error_event_error_string_invalid_api_key_remains_unclassified() {
        let event = serde_json::json!({
            "type": "error",
            "error": "invalid_api_key",
            "message": "Provider reported invalid_api_key in an error field"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Provider reported invalid_api_key in an error field".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_top_level_reconnect_required_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "code": "TOKEN_REFRESH_FAILED",
            "message": "Access token expired and refresh failed for: codex-oauth-token.",
            "connectors": ["codex-oauth-token"],
            "failureReason": "reconnect_required"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token expired and refresh failed for: codex-oauth-token."
                    .to_string(),
                failure_reason: Some(FailureReason::ReconnectRequired),
            })
        );
    }

    #[test]
    fn codex_error_event_top_level_error_string_reconnect_required_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "error": "TOKEN_REFRESH_FAILED",
            "message": "Access token expired and refresh failed for: codex-oauth-token.",
            "connectors": ["codex-oauth-token"],
            "failureReason": "reconnect_required"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token expired and refresh failed for: codex-oauth-token."
                    .to_string(),
                failure_reason: Some(FailureReason::ReconnectRequired),
            })
        );
    }

    #[test]
    fn codex_error_event_upstream_provider_refresh_remains_unclassified() {
        let event = serde_json::json!({
            "type": "error",
            "code": "TOKEN_REFRESH_FAILED",
            "message": "Access token refresh failed for: codex-oauth-token.",
            "connectors": ["codex-oauth-token"],
            "failureReason": "upstream_provider"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token refresh failed for: codex-oauth-token.".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_multi_connector_reconnect_remains_unclassified() {
        let event = serde_json::json!({
            "type": "error",
            "code": "TOKEN_REFRESH_FAILED",
            "message": "Access token expired and refresh failed for: notion, codex-oauth-token.",
            "connectors": ["notion", "codex-oauth-token"],
            "failureReason": "reconnect_required"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token expired and refresh failed for: notion, codex-oauth-token."
                    .to_string(),
                failure_reason: None,
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
    fn codex_generic_failure_diagnostic_matcher_is_case_insensitive() {
        for message in [
            "error",
            "error:",
            "error :",
            "Turn failed",
            "Turn failed.",
            "Turn failed .",
            " turn interrupted ",
            "UNKNOWN ERROR",
            "unknown error!",
            "codex error",
            "codex error?",
        ] {
            assert!(
                is_generic_codex_failure_diagnostic(message),
                "message should be generic: {message}"
            );
        }

        assert!(!is_generic_codex_failure_diagnostic(
            "Selected model is at capacity. Please try a different model."
        ));
    }

    #[test]
    fn codex_turn_failed_uses_nested_turn_error_for_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": "turn failed",
            "turn": {
                "error": {
                    "code": "invalid_api_key",
                    "message": "Incorrect API key provided"
                }
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
    fn codex_turn_failed_keeps_specific_top_level_message_with_nested_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": "request failed before shutdown",
            "turn": {
                "error": {
                    "code": "invalid_api_key",
                    "message": "Incorrect API key provided"
                }
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "request failed before shutdown".to_string(),
                failure_reason: Some(FailureReason::InvalidApiKey),
            })
        );
    }

    #[test]
    fn codex_turn_failed_uses_nested_message_when_top_level_is_generic() {
        for top_level_error in [
            "turn failed",
            "Turn failed.",
            "Unknown error",
            "codex error",
        ] {
            let event = serde_json::json!({
                "type": "turn.failed",
                "error": top_level_error,
                "turn": {
                    "error": {
                        "message": "nested turn failure",
                        "additionalDetails": "quota exhausted"
                    }
                }
            });

            assert_eq!(
                masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
                Some(CodexFailureDiagnostic {
                    event_type: "turn.failed",
                    message: "nested turn failure (quota exhausted)".to_string(),
                    failure_reason: None,
                }),
                "top-level error: {top_level_error}"
            );
        }
    }

    #[test]
    fn codex_turn_failed_uses_nested_message_when_top_level_object_message_is_generic() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed",
                "additionalDetails": "wrapper-level detail"
            },
            "turn": {
                "error": {
                    "message": "nested turn failure",
                    "additionalDetails": "quota exhausted"
                }
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "nested turn failure (quota exhausted)".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_uses_nested_message_when_top_level_object_message_is_absent() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "additionalDetails": "wrapper-level detail"
            },
            "turn": {
                "error": {
                    "message": "nested turn failure",
                    "additionalDetails": "quota exhausted"
                }
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "nested turn failure (quota exhausted)".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_keeps_top_level_details_when_nested_message_is_generic() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "additionalDetails": "wrapper-level detail"
            },
            "turn": {
                "error": {
                    "message": "turn failed"
                }
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "wrapper-level detail".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_uses_nested_message_when_top_level_is_missing() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "turn": {
                "error": {
                    "message": "nested turn failure",
                    "additionalDetails": "quota exhausted"
                }
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "nested turn failure (quota exhausted)".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_turn_failed_null_nested_turn_error_uses_top_level_error() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "code": "invalid_api_key",
                "message": "Incorrect API key provided"
            },
            "turn": {"error": null}
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
    fn codex_turn_failed_model_capacity_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "Selected model is at capacity. Please try a different model."
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "Selected model is at capacity. Please try a different model.".to_string(),
                failure_reason: Some(FailureReason::ProviderOverloaded),
            })
        );
    }

    #[test]
    fn codex_turn_failed_context_window_exceeded_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.".to_string(),
                failure_reason: Some(FailureReason::ContextWindowExceeded),
            })
        );
    }

    #[test]
    fn codex_error_info_server_overloaded_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed from server",
                "codex_error_info": "serverOverloaded"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "turn failed from server".to_string(),
                failure_reason: Some(FailureReason::ProviderOverloaded),
            })
        );
    }

    #[test]
    fn codex_error_info_usage_limit_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed from server",
                "codexErrorInfo": "usageLimitExceeded"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "turn failed from server".to_string(),
                failure_reason: Some(FailureReason::UsageLimit),
            })
        );
    }

    #[test]
    fn codex_error_info_object_variant_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed from server",
                "codexErrorInfo": {
                    "serverOverloaded": {
                        "httpStatusCode": 529
                    }
                }
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "turn failed from server".to_string(),
                failure_reason: Some(FailureReason::ProviderOverloaded),
            })
        );
    }

    #[test]
    fn codex_error_info_unknown_object_variant_remains_unclassified() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed from server",
                "codexErrorInfo": {"badRequest": {}}
            }
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
    fn codex_model_capacity_matcher_accepts_wrapped_case_insensitive_message() {
        assert!(is_codex_model_capacity_message(
            "Codex failed: SELECTED MODEL IS AT CAPACITY. PLEASE TRY A DIFFERENT MODEL."
        ));
    }

    #[test]
    fn codex_model_capacity_matcher_ignores_generic_overload_text() {
        assert!(!is_codex_model_capacity_message(
            "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment."
        ));
    }

    #[test]
    fn codex_context_window_matcher_accepts_thread_and_conversation_variants() {
        for message in [
            "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            "Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying.",
        ] {
            assert!(
                is_codex_context_window_exceeded_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_context_window_matcher_ignores_generic_context_window_text() {
        assert!(!is_codex_context_window_exceeded_message(
            "The prompt mentions the model context window but did not fail."
        ));
    }

    #[test]
    fn codex_turn_failed_reconnect_required_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "code": "TOKEN_REFRESH_FAILED",
                "message": "Access token expired and refresh failed for: codex-oauth-token.",
                "connectors": ["codex-oauth-token"],
                "failureReason": "reconnect_required"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "Access token expired and refresh failed for: codex-oauth-token."
                    .to_string(),
                failure_reason: Some(FailureReason::ReconnectRequired),
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
    fn codex_turn_failed_appends_camel_case_additional_details() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "turn failed from server",
                "additionalDetails": "rate limit exceeded"
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
    fn codex_turn_failed_error_string_invalid_api_key_remains_unclassified() {
        let event = serde_json::json!({
            "type": "turn.failed",
            "error": "invalid_api_key"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.failed",
                message: "invalid_api_key".to_string(),
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
    fn codex_failed_turn_completed_empty_nested_error_uses_top_level_error() {
        let event = serde_json::json!({
            "type": "turn.completed",
            "error": {"message": "top-level completed failure"},
            "turn": {
                "status": "failed",
                "error": {}
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "top-level completed failure".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failed_turn_completed_generic_nested_error_uses_specific_top_level_error() {
        let event = serde_json::json!({
            "type": "turn.completed",
            "error": {"message": "top-level completed failure"},
            "turn": {
                "status": "failed",
                "error": {"message": "turn failed"}
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "top-level completed failure".to_string(),
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

    // Note: end-to-end coverage of session metadata capture (including both
    // the Claude `system/init` branch and the codex `thread.started`
    // branch) lives in the integration test suites:
    //   - `tests/integration.rs::send_event_extracts_claude_session_id`
    //   - `tests/codex_session_resume.rs` (codex variant)
    // The Claude/Codex helpers are private; their contracts are
    // exercised transitively through `send_event`.
}
