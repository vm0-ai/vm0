//! Final CLI failure-message selection and structured diagnostic construction.
//!
//! Structured provider events are parsed by [`crate::events`]. This module
//! consumes the already masked CLI result, selects the final user-visible
//! failure message, applies source-sensitive text classification, and persists
//! the resulting guest failure artifacts.

use crate::cli;
use crate::env;
use crate::failure_patterns;
use crate::paths;
use crate::session_metadata;
use guest_common::{log_info, log_warn};
use guest_contracts::diagnostics::{
    AgentFramework, CliObservedExitDiagnostic, CliTerminationDiagnostic, EventDeliveryDiagnostic,
    FailureClass, FailureDetailSource, FailureDiagnostic, FailureReason, PromptMetadata,
    SessionHistoryStatus,
};
use serde_json::Value;
use std::io::ErrorKind;
use std::path::Path;

const LOG_TAG: &str = "sandbox:guest-agent";
const MAX_LOGGED_CLI_STDERR_LINES: usize = 20;
const MAX_LOGGED_CLI_STDERR_LINE_BYTES: usize = 4096;
const CODEX_SAFETY_POLICY_REFUSAL_MESSAGE: &str = concat!(
    "This content was flagged for possible cybersecurity risk. ",
    "If this seems wrong, try rephrasing your request. ",
    "To get authorized for security work, join the Trusted Access for Cyber program: ",
    "https://chatgpt.com/cyber",
);

/// Final message and structured diagnostic for a nonzero CLI result.
#[derive(Debug)]
pub struct CliNonzeroFailure {
    /// Selected user-visible failure message.
    pub message: String,
    /// Structured diagnostic containing the selected source and reason.
    pub diagnostic: FailureDiagnostic,
}

/// Build a base diagnostic from explicit run configuration.
pub fn base_failure_diagnostic_for_config(
    config: &env::GuestConfig,
    failure_class: FailureClass,
) -> FailureDiagnostic {
    let framework = match config.framework {
        env::Framework::ClaudeCode => AgentFramework::ClaudeCode,
        env::Framework::Codex => AgentFramework::Codex,
    };
    FailureDiagnostic::new(
        failure_class,
        framework,
        PromptMetadata::from_prompt(&config.prompt),
    )
}

/// Build the diagnostic for a CLI control-path failure.
pub fn cli_control_failure_for_config(
    config: &env::GuestConfig,
    runtime_paths: &paths::GuestPaths,
    cli_result: &cli::CliExecutionResult,
) -> FailureDiagnostic {
    let diagnostic = cli_result_failure_diagnostic_for_config(
        config,
        runtime_paths,
        FailureClass::CliExecutionError,
        cli_result.exit_code,
        cli_result.claude_result,
    );
    let diagnostic =
        with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned());
    with_cli_termination(diagnostic, cli_result.cli_termination)
}

/// Build the primary diagnostic for terminal event delivery after a CLI result.
pub fn event_delivery_failure_for_config(
    config: &env::GuestConfig,
    runtime_paths: &paths::GuestPaths,
    cli_result: &cli::CliExecutionResult,
    event_delivery: EventDeliveryDiagnostic,
) -> FailureDiagnostic {
    let diagnostic = cli_result_failure_diagnostic_for_config(
        config,
        runtime_paths,
        FailureClass::EventUploadFailed,
        cli_result.exit_code,
        cli_result.claude_result,
    )
    .with_event_delivery(event_delivery);
    let diagnostic =
        with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned());
    with_cli_termination(diagnostic, cli_result.cli_termination)
}

/// Select the final message and build the diagnostic for a nonzero CLI result.
pub fn cli_nonzero_failure_for_config(
    config: &env::GuestConfig,
    runtime_paths: &paths::GuestPaths,
    cli_result: &cli::CliExecutionResult,
) -> CliNonzeroFailure {
    let failure_message = cli_failure_message(
        cli_result.exit_code,
        &cli_result.stderr_lines,
        cli_result.failure_diagnostic.as_ref(),
    );
    let diagnostic = cli_result_failure_diagnostic_for_config(
        config,
        runtime_paths,
        FailureClass::CliNonzero,
        cli_result.exit_code,
        cli_result.claude_result,
    )
    .with_failure_detail_source(failure_message.source);
    let diagnostic =
        with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned());
    let diagnostic = with_cli_termination(diagnostic, cli_result.cli_termination);
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    CliNonzeroFailure {
        message: failure_message.message,
        diagnostic,
    }
}

/// Build the diagnostic for a Claude zero-turn result without session history.
pub fn claude_zero_turn_failure_for_config(
    config: &env::GuestConfig,
    cli_result: &cli::CliExecutionResult,
    session_history_status: SessionHistoryStatus,
) -> FailureDiagnostic {
    let diagnostic =
        base_failure_diagnostic_for_config(config, FailureClass::ClaudeZeroTurnNoHistory)
            .with_cli_exit_code(cli_result.exit_code)
            .with_claude_num_turns(Some(0))
            .with_session_history_status(session_history_status);
    with_cli_observed_exit(diagnostic, cli_result.cli_observed_exit.as_ref().cloned())
}

/// Return session-history availability for failure diagnostics.
pub fn diagnostic_session_history_status_for_config(
    config: &env::GuestConfig,
    runtime_paths: &paths::GuestPaths,
) -> SessionHistoryStatus {
    match config.framework {
        env::Framework::ClaudeCode => {
            claude_history_target_status_for_config(config, runtime_paths)
        }
        env::Framework::Codex => SessionHistoryStatus::NotApplicable,
    }
}

/// Return whether a session-history status cannot support a recovery checkpoint.
pub fn session_history_unavailable(status: SessionHistoryStatus) -> bool {
    matches!(
        status,
        SessionHistoryStatus::Missing | SessionHistoryStatus::Empty
    )
}

fn claude_history_target_status_for_config(
    config: &env::GuestConfig,
    runtime_paths: &paths::GuestPaths,
) -> SessionHistoryStatus {
    let marker = match session_metadata::resolve_history_marker_payload_for_diagnostics_from(
        config.framework,
        &config.home_dir,
        runtime_paths.session_id_file(),
        runtime_paths.session_history_path_file(),
    ) {
        Ok(Some(marker)) => marker,
        Ok(None) => return SessionHistoryStatus::Missing,
        Err(_) => return SessionHistoryStatus::Unknown,
    };
    history_target_status(Path::new(&marker))
}

/// Persist a nonempty guest error message with private file permissions.
pub fn write_guest_error_file(checkpoint_error_file: &str, message: &str) {
    let message = message.trim();
    if message.is_empty() {
        return;
    }

    if let Err(e) = paths::write_private(checkpoint_error_file, message) {
        log_warn!(LOG_TAG, "Failed to write guest error file: {e}");
    }
}

/// Serialize and persist a structured guest failure diagnostic.
pub fn write_guest_failure_diagnostic(
    failure_diagnostic_file: &str,
    diagnostic: &FailureDiagnostic,
) {
    let bytes = match serde_json::to_vec(diagnostic) {
        Ok(bytes) => bytes,
        Err(e) => {
            log_warn!(LOG_TAG, "Failed to serialize guest failure diagnostic: {e}");
            return;
        }
    };

    if let Err(e) = paths::write_private(failure_diagnostic_file, bytes) {
        log_warn!(
            LOG_TAG,
            "Failed to write guest failure diagnostic file: {e}"
        );
    }
}

fn with_cli_termination(
    diagnostic: FailureDiagnostic,
    cli_termination: Option<CliTerminationDiagnostic>,
) -> FailureDiagnostic {
    if let Some(cli_termination) = cli_termination {
        diagnostic.with_cli_termination(cli_termination)
    } else {
        diagnostic
    }
}

fn with_cli_observed_exit(
    diagnostic: FailureDiagnostic,
    cli_observed_exit: Option<CliObservedExitDiagnostic>,
) -> FailureDiagnostic {
    if let Some(cli_observed_exit) = cli_observed_exit {
        diagnostic.with_cli_observed_exit(cli_observed_exit)
    } else {
        diagnostic
    }
}

fn cli_result_failure_diagnostic_for_config(
    config: &env::GuestConfig,
    runtime_paths: &paths::GuestPaths,
    failure_class: FailureClass,
    cli_exit_code: i32,
    claude_result: Option<cli::ClaudeResultSummary>,
) -> FailureDiagnostic {
    let mut diagnostic = base_failure_diagnostic_for_config(config, failure_class)
        .with_cli_exit_code(cli_exit_code)
        .with_session_history_status(diagnostic_session_history_status_for_config(
            config,
            runtime_paths,
        ));
    if let Some(result) = claude_result {
        diagnostic = diagnostic.with_claude_num_turns(result.num_turns);
    }
    diagnostic
}

fn with_cli_failure_reason(
    diagnostic: FailureDiagnostic,
    failure_message: &CliFailureMessage,
) -> FailureDiagnostic {
    if let Some(reason) = classify_cli_failure_reason(
        diagnostic.framework,
        failure_message.source,
        failure_message.message.as_str(),
    )
    .or(failure_message.failure_reason)
    {
        diagnostic.with_failure_reason(reason)
    } else {
        diagnostic
    }
}

fn classify_cli_failure_reason(
    framework: AgentFramework,
    source: FailureDetailSource,
    failure_message: &str,
) -> Option<FailureReason> {
    if matches!(framework, AgentFramework::Codex)
        && is_codex_safety_policy_refusal(source, failure_message)
    {
        return Some(FailureReason::SafetyPolicyRefusal);
    }

    let normalized = failure_message.to_ascii_lowercase();
    if is_insufficient_credits_error(&normalized) {
        return Some(FailureReason::InsufficientCredits);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_invalid_credentials_error(&normalized)
    {
        return Some(FailureReason::InvalidCredentials);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && (is_claude_provider_overloaded_error(&normalized)
            || is_claude_result_simple_provider_overloaded_error(source, &normalized))
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_result_provider_stream_timeout(source, &normalized)
    {
        return Some(FailureReason::ProviderStreamTimeout);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_provider_server_error(source, &normalized)
    {
        return Some(FailureReason::ProviderServerError);
    }
    if matches!(framework, AgentFramework::ClaudeCode)
        && is_claude_output_token_limit_error(&normalized)
    {
        return Some(FailureReason::OutputTokenLimit);
    }
    if matches!(framework, AgentFramework::Codex)
        && (normalized.contains("invalid_api_key")
            || normalized.contains("incorrect api key provided"))
    {
        return Some(FailureReason::InvalidApiKey);
    }
    if matches!(framework, AgentFramework::Codex)
        && is_codex_oauth_reconnect_required_run_error(failure_message)
    {
        return Some(FailureReason::ReconnectRequired);
    }
    if matches!(framework, AgentFramework::Codex)
        && failure_patterns::is_codex_model_capacity_message(failure_message)
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if matches!(framework, AgentFramework::Codex)
        && failure_patterns::is_codex_context_window_exceeded_message(failure_message)
    {
        return Some(FailureReason::ContextWindowExceeded);
    }
    // Subscription/usage limits are an expected quota state for both Codex
    // (ChatGPT plan "usage limit" or API billing "quota exceeded") and Claude
    // Code (Max plan "session limit" / "weekly limit" / Fable model limit /
    // org monthly spend limit), so classify them regardless of framework where
    // the wording is shared. This lets the runner log these expected outcomes
    // at info instead of error.
    if normalized.contains("usage limit")
        || (matches!(framework, AgentFramework::Codex)
            && normalized.contains("quota exceeded. check your plan and billing details"))
        || normalized.contains("session limit")
        || normalized.contains("weekly limit")
        || (matches!(framework, AgentFramework::ClaudeCode)
            && (normalized.contains("fable 5 requires usage credits")
                || normalized.contains("reached your fable 5 limit")
                || is_claude_subscription_access_disabled_error(&normalized)
                || is_claude_monthly_spend_limit_error(&normalized)))
    {
        return Some(FailureReason::UsageLimit);
    }
    None
}

fn is_codex_safety_policy_refusal(source: FailureDetailSource, failure_message: &str) -> bool {
    source == FailureDetailSource::CodexJsonl
        && failure_message.trim() == CODEX_SAFETY_POLICY_REFUSAL_MESSAGE
}

fn is_insufficient_credits_error(normalized: &str) -> bool {
    normalized.contains("402 insufficient credits")
        || (normalized.contains("api error: 402")
            && normalized.contains("requires more credits")
            && normalized.contains("can only afford"))
}

fn is_claude_invalid_credentials_error(normalized: &str) -> bool {
    normalized.contains("failed to authenticate")
        && normalized.contains("api error: 401 invalid authentication credentials")
}

fn is_claude_provider_overloaded_error(normalized: &str) -> bool {
    const MARKER: &str = "api error:";
    normalized.match_indices(MARKER).any(|(index, _)| {
        claude_529_error_detail(&normalized[index + MARKER.len()..]).is_some_and(|detail| {
            starts_with_overloaded_word(detail) || contains_overloaded_error_type(detail)
        })
    })
}

fn is_claude_result_simple_provider_overloaded_error(
    source: FailureDetailSource,
    normalized: &str,
) -> bool {
    source == FailureDetailSource::ClaudeResult && normalized.trim() == "api error: overloaded"
}

fn is_claude_result_provider_stream_timeout(source: FailureDetailSource, normalized: &str) -> bool {
    let trimmed = normalized.trim();
    source == FailureDetailSource::ClaudeResult
        && (is_claude_result_stream_idle_timeout(trimmed)
            || is_claude_result_stalled_mid_stream(trimmed))
}

fn is_claude_result_stream_idle_timeout(trimmed: &str) -> bool {
    trimmed.starts_with("api error: stream idle timeout")
        && (trimmed.contains("partial response received") || trimmed.contains("no chunks received"))
}

fn is_claude_result_stalled_mid_stream(trimmed: &str) -> bool {
    trimmed.starts_with("api error: response stalled mid-stream")
        && trimmed.contains("response above may be incomplete")
}

fn is_claude_provider_server_error(source: FailureDetailSource, normalized: &str) -> bool {
    source == FailureDetailSource::ClaudeResult
        && has_claude_api_status(normalized, "500")
        && normalized.contains("internal server error")
        && normalized.contains("server-side issue")
}

fn is_claude_output_token_limit_error(normalized: &str) -> bool {
    let response_exceeded = normalized.contains("response exceeded")
        || normalized.contains("response has exceeded")
        || normalized.contains("response exceeds");
    let output_token_limit = normalized.contains("output token maximum")
        || normalized.contains("output token limit")
        || normalized.contains("maximum output token")
        || normalized.contains("max output token")
        || normalized.contains("claude_code_max_output_tokens");
    response_exceeded && output_token_limit
}

fn claude_529_error_detail(detail: &str) -> Option<&str> {
    let detail = trim_error_detail_start(detail);
    let detail = if let Some(remaining) = strip_word_prefix(detail, "repeated") {
        trim_error_detail_start(remaining)
    } else {
        detail
    };
    let detail = detail.strip_prefix("529")?;
    if detail.chars().next().is_some_and(is_error_type_char) {
        return None;
    }
    Some(trim_error_detail_start(detail))
}

fn has_claude_api_status(normalized: &str, status: &str) -> bool {
    const MARKER: &str = "api error:";
    normalized.match_indices(MARKER).any(|(index, _)| {
        let detail = trim_error_detail_start(&normalized[index + MARKER.len()..]);
        let Some(remaining) = detail.strip_prefix(status) else {
            return false;
        };
        !remaining.chars().next().is_some_and(is_error_type_char)
    })
}

fn trim_error_detail_start(detail: &str) -> &str {
    detail.trim_start_matches(|c: char| c.is_ascii_whitespace() || matches!(c, ':' | '-' | '.'))
}

fn starts_with_overloaded_word(detail: &str) -> bool {
    strip_word_prefix(detail, "overloaded").is_some()
}

fn contains_overloaded_error_type(detail: &str) -> bool {
    const TOKEN: &str = "overloaded_error";
    detail.match_indices(TOKEN).any(|(index, _)| {
        let before = detail[..index].chars().next_back();
        let after = detail[index + TOKEN.len()..].chars().next();
        !before.is_some_and(is_error_type_char) && !after.is_some_and(is_error_type_char)
    })
}

fn strip_word_prefix<'a>(text: &'a str, token: &str) -> Option<&'a str> {
    text.strip_prefix(token).filter(|remaining| {
        remaining
            .chars()
            .next()
            .is_none_or(|c| !is_error_type_char(c))
    })
}

fn is_error_type_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-')
}

fn is_claude_subscription_access_disabled_error(normalized: &str) -> bool {
    normalized.contains("disabled claude subscription access") && normalized.contains("claude code")
}

fn is_claude_monthly_spend_limit_error(normalized: &str) -> bool {
    normalized.contains("org's monthly spend limit")
        && normalized.contains("claude.ai/settings/usage")
}

fn is_codex_oauth_reconnect_required_run_error(error_message: &str) -> bool {
    if !error_message.contains("TOKEN_REFRESH_FAILED")
        || !error_message.contains(failure_patterns::CODEX_OAUTH_TOKEN_CONNECTOR)
        || !error_message.contains("reconnect_required")
    {
        return false;
    }

    let mut search_start = 0;
    while let Some((value, end_index)) = parse_next_json_object(error_message, search_start) {
        if value
            .as_ref()
            .is_some_and(is_codex_oauth_reconnect_required_value)
        {
            return true;
        }
        search_start = end_index;
    }
    false
}

fn parse_next_json_object(message: &str, search_start: usize) -> Option<(Option<Value>, usize)> {
    let body_start = message[search_start.min(message.len())..]
        .find('{')
        .map(|offset| search_start + offset)?;
    let mut stream = serde_json::Deserializer::from_str(&message[body_start..]).into_iter();

    match stream.next() {
        Some(Ok(value)) => Some((Some(value), body_start + stream.byte_offset())),
        Some(Err(_)) | None => Some((None, body_start + 1)),
    }
}

fn is_codex_oauth_reconnect_required_value(value: &Value) -> bool {
    is_codex_oauth_reconnect_required_body(value)
        || value
            .get("error")
            .is_some_and(is_codex_oauth_reconnect_required_envelope)
}

fn is_codex_oauth_reconnect_required_body(value: &Value) -> bool {
    value.get("error").and_then(Value::as_str) == Some("TOKEN_REFRESH_FAILED")
        && has_reconnect_required_payload(value)
}

fn is_codex_oauth_reconnect_required_envelope(value: &Value) -> bool {
    value.get("code").and_then(Value::as_str) == Some("TOKEN_REFRESH_FAILED")
        && has_reconnect_required_payload(value)
}

fn has_reconnect_required_payload(value: &Value) -> bool {
    value.get("failureReason").and_then(Value::as_str) == Some("reconnect_required")
        && failure_patterns::has_exact_codex_oauth_connector(value)
}

#[cfg(test)]
fn history_target_unavailable(path: &Path) -> bool {
    session_history_unavailable(history_target_status(path))
}

fn history_target_status(path: &Path) -> SessionHistoryStatus {
    match path.metadata() {
        Ok(metadata) if metadata.is_file() && metadata.len() == 0 => SessionHistoryStatus::Empty,
        Ok(_) => SessionHistoryStatus::Present,
        Err(e) if e.kind() == ErrorKind::NotFound => SessionHistoryStatus::Missing,
        Err(_) => SessionHistoryStatus::Unknown,
    }
}

struct CliFailureMessage {
    message: String,
    source: FailureDetailSource,
    failure_reason: Option<FailureReason>,
}

fn cli_failure_message(
    code: i32,
    stderr_lines: &[String],
    failure_diagnostic: Option<&cli::CliFailureDiagnostic>,
) -> CliFailureMessage {
    let stdout_failure_reason = failure_diagnostic.and_then(|diagnostic| diagnostic.failure_reason);
    if let Some((message, source, failure_reason)) = failure_diagnostic.and_then(|diagnostic| {
        let message = diagnostic.message.trim();
        if message.is_empty() {
            None
        } else {
            Some((message, diagnostic.source, diagnostic.failure_reason))
        }
    }) && (!is_generic_stdout_failure_diagnostic(source, message) || stderr_lines.is_empty())
    {
        return CliFailureMessage {
            message: message.to_string(),
            source,
            failure_reason,
        };
    }

    if stderr_lines.is_empty() {
        return CliFailureMessage {
            message: format!("Agent exited with code {code}"),
            source: FailureDetailSource::FallbackExitCode,
            failure_reason: None,
        };
    }

    log_info!(LOG_TAG, "Captured {} stderr lines", stderr_lines.len());
    let omitted_lines = stderr_lines
        .len()
        .saturating_sub(MAX_LOGGED_CLI_STDERR_LINES);
    let mut message_lines = Vec::with_capacity(
        stderr_lines.len().min(MAX_LOGGED_CLI_STDERR_LINES) + usize::from(omitted_lines > 0),
    );
    if omitted_lines > 0 {
        log_warn!(
            LOG_TAG,
            "CLI stderr: omitted {} earlier line(s)",
            omitted_lines
        );
        message_lines.push(format!(
            "...[omitted {omitted_lines} earlier stderr line(s)]"
        ));
    }
    for line in stderr_lines.iter().skip(omitted_lines) {
        let line = truncate_cli_stderr_line(line);
        log_warn!(LOG_TAG, "CLI stderr: {line}");
        message_lines.push(line.into_owned());
    }
    CliFailureMessage {
        message: message_lines.join(" "),
        source: FailureDetailSource::Stderr,
        failure_reason: stdout_failure_reason,
    }
}

fn is_generic_stdout_failure_diagnostic(source: FailureDetailSource, message: &str) -> bool {
    if source == FailureDetailSource::CodexJsonl {
        return failure_patterns::is_generic_codex_failure_diagnostic(message);
    }

    matches!(message.trim(), "error" | "turn failed" | "turn interrupted")
}

fn truncate_cli_stderr_line(line: &str) -> std::borrow::Cow<'_, str> {
    if line.len() <= MAX_LOGGED_CLI_STDERR_LINE_BYTES {
        return std::borrow::Cow::Borrowed(line);
    }

    let mut cut = 0;
    for (idx, ch) in line.char_indices() {
        let next = idx + ch.len_utf8();
        if next > MAX_LOGGED_CLI_STDERR_LINE_BYTES {
            break;
        }
        cut = next;
    }

    let mut truncated = line[..cut].to_string();
    truncated.push_str("...[truncated]");
    std::borrow::Cow::Owned(truncated)
}

#[cfg(test)]
mod tests;
