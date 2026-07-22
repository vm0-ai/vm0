use super::*;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &std::path::Path) -> Self {
        guest_common::log::set_system_log_file(path.to_string_lossy().as_ref());
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

fn cli_diagnostic(message: &str, source: FailureDetailSource) -> cli::CliFailureDiagnostic {
    cli::CliFailureDiagnostic {
        message: message.to_string(),
        source,
        failure_reason: None,
    }
}

fn selected_failure_message(
    message: &str,
    source: FailureDetailSource,
    failure_reason: Option<FailureReason>,
) -> CliFailureMessage {
    CliFailureMessage {
        message: message.to_string(),
        source,
        failure_reason,
    }
}

fn classify_cli_failure_reason(
    framework: AgentFramework,
    failure_message: &str,
) -> Option<FailureReason> {
    // Existing direct classifier tests model messages selected from stderr.
    super::classify_cli_failure_reason(framework, FailureDetailSource::Stderr, failure_message)
}

const CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE: &str = "API Error: 500 Internal server error. This is a server-side issue, usually temporary - try again in a moment. If it persists, check https://status.claude.com.";

#[test]
fn cli_failure_message_logs_stderr_to_system_log() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let long_line = format!("{}tail", "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES + 1));
    let stderr_lines = ["prefix line 0".to_string(), "prefix line 1".to_string()]
        .into_iter()
        .chain(std::iter::once("codex stderr includes ***".to_string()))
        .chain(std::iter::once(long_line.clone()))
        .chain((0..(MAX_LOGGED_CLI_STDERR_LINES - 2)).map(|i| format!("extra line {i}")))
        .collect::<Vec<_>>();
    let msg = cli_failure_message(1, &stderr_lines, None);
    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert!(
        !msg.message.contains("prefix line"),
        "returned error message should omit older stderr lines"
    );
    assert!(
        msg.message.contains("codex stderr includes ***"),
        "returned error message should preserve stderr"
    );
    assert!(
        msg.message.contains("...[truncated]"),
        "returned error message should truncate long stderr lines"
    );
    assert!(
        !msg.message.contains("tail"),
        "returned error message should not include bytes after the truncation boundary"
    );
    assert!(
        msg.message
            .contains("...[omitted 2 earlier stderr line(s)]"),
        "returned error message should report omitted earlier stderr lines"
    );

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("Captured 22 stderr lines"),
        "system log should include stderr count, got: {system_log}"
    );
    assert!(
        !system_log.contains("prefix line"),
        "system log should omit older stderr lines"
    );
    assert!(
        system_log.contains("CLI stderr: codex stderr includes ***"),
        "system log should include CLI stderr, got: {system_log}"
    );
    assert!(
        system_log.contains("...[truncated]"),
        "system log should truncate long stderr lines, got: {system_log}"
    );
    assert!(
        !system_log.contains("tail"),
        "system log should not include bytes after the truncation boundary"
    );
    assert!(
        system_log.contains("CLI stderr: omitted 2 earlier line(s)"),
        "system log should report omitted earlier stderr lines, got: {system_log}"
    );
}

#[test]
fn cli_failure_message_preserves_exact_limits_without_omission() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let exact_limit_line = "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES);
    let stderr_lines = std::iter::once(exact_limit_line.clone())
        .chain((1..MAX_LOGGED_CLI_STDERR_LINES).map(|i| format!("line {i}")))
        .collect::<Vec<_>>();

    let msg = cli_failure_message(1, &stderr_lines, None);
    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert!(
        msg.message.contains(&exact_limit_line),
        "returned error message should preserve line at exact size limit"
    );
    assert!(
        !msg.message.contains("...[truncated]"),
        "returned error message should not truncate line at exact size limit"
    );
    assert!(
        !msg.message.contains("omitted"),
        "returned error message should not report omitted lines at exact line limit"
    );

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("Captured 20 stderr lines"),
        "system log should include stderr count, got: {system_log}"
    );
    assert!(
        !system_log.contains("omitted"),
        "system log should not report omitted lines at exact line limit"
    );
}

#[test]
fn cli_failure_message_truncates_on_utf8_boundary() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let prefix = "x".repeat(MAX_LOGGED_CLI_STDERR_LINE_BYTES - 1);
    let stderr_line = format!("{prefix}é-tail");
    let msg = cli_failure_message(1, &[stderr_line], None);
    assert_eq!(msg.source, FailureDetailSource::Stderr);

    assert!(
        msg.message.contains(&prefix),
        "returned error message should preserve bytes before the truncation boundary"
    );
    assert!(
        msg.message.contains("...[truncated]"),
        "returned error message should indicate truncation"
    );
    assert!(
        !msg.message.contains("é-tail"),
        "returned error message should not split or include the over-boundary character"
    );

    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains("...[truncated]"),
        "system log should indicate truncation, got: {system_log}"
    );
    assert!(
        !system_log.contains("é-tail"),
        "system log should not split or include the over-boundary character"
    );
}

#[test]
fn cli_failure_message_prefers_codex_failure_diagnostic() {
    let stderr_lines = vec!["background task noise".to_string()];
    let msg = cli_failure_message(
        1,
        &stderr_lines,
        Some(&cli_diagnostic(
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
            FailureDetailSource::CodexJsonl,
        )),
    );

    assert_eq!(msg.source, FailureDetailSource::CodexJsonl);
    assert_eq!(
        msg.message,
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits."
    );
}

#[test]
fn cli_failure_message_uses_stderr_over_generic_codex_failure_diagnostic() {
    let stderr_lines = vec!["specific stderr failure".to_string()];
    for diagnostic_message in [
        "turn failed",
        "Turn failed.",
        "Unknown error",
        "codex error",
    ] {
        let diagnostic = cli_diagnostic(diagnostic_message, FailureDetailSource::CodexJsonl);
        let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

        assert_eq!(
            msg.source,
            FailureDetailSource::Stderr,
            "diagnostic message: {diagnostic_message}"
        );
        assert_eq!(msg.message, "specific stderr failure");
    }
}

#[test]
fn cli_failure_message_preserves_structured_reason_with_stderr_message() {
    let stderr_lines = vec!["specific stderr failure".to_string()];
    let diagnostic = cli::CliFailureDiagnostic {
        message: "turn failed".to_string(),
        source: FailureDetailSource::CodexJsonl,
        failure_reason: Some(FailureReason::InvalidApiKey),
    };
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, "specific stderr failure");
    assert_eq!(msg.failure_reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn cli_failure_reason_uses_selected_stderr_over_generic_diagnostic() {
    let _system_log_state_guard = crate::lock_system_log_test_state();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
    let stderr_lines = vec![
        "API Error: 402 Insufficient credits. Add credits or configure your own API key to continue."
            .to_string(),
    ];
    let generic_diagnostic = cli_diagnostic("turn failed", FailureDetailSource::CodexJsonl);
    let msg = cli_failure_message(1, &stderr_lines, Some(&generic_diagnostic));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::InsufficientCredits)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::Stderr)
    );
}

#[test]
fn cli_failure_message_uses_generic_codex_failure_diagnostic_without_stderr() {
    let diagnostic = cli_diagnostic("turn failed", FailureDetailSource::CodexJsonl);
    let msg = cli_failure_message(1, &[], Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::CodexJsonl);
    assert_eq!(msg.message, "turn failed");
}

#[test]
fn cli_failure_message_prefers_claude_result_diagnostic() {
    let stderr_lines = vec!["background task noise".to_string()];
    let diagnostic = cli_diagnostic(
        "permission denied while running command",
        FailureDetailSource::ClaudeResult,
    );
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(msg.message, "permission denied while running command");
}

#[test]
fn cli_failure_message_uses_stderr_over_generic_claude_result() {
    let stderr_lines = vec!["specific stderr failure".to_string()];
    let diagnostic = cli_diagnostic("error", FailureDetailSource::ClaudeResult);
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::Stderr);
    assert_eq!(msg.message, "specific stderr failure");
}

#[test]
fn cli_failure_message_does_not_apply_codex_generic_messages_to_claude_result() {
    let stderr_lines = vec!["background task noise".to_string()];
    let diagnostic = cli_diagnostic("Unknown error", FailureDetailSource::ClaudeResult);
    let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(msg.message, "Unknown error");
}

#[test]
fn cli_failure_message_marks_exit_code_fallback_source() {
    let msg = cli_failure_message(7, &[], None);

    assert_eq!(msg.source, FailureDetailSource::FallbackExitCode);
    assert_eq!(msg.message, "Agent exited with code 7");
}

#[test]
fn cli_failure_reason_classifies_insufficient_credits() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 402 Insufficient credits. Add credits or configure your own API key to continue.",
    );

    assert_eq!(reason, Some(FailureReason::InsufficientCredits));
}

#[test]
fn cli_failure_reason_classifies_provider_credit_affordability_error() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1600. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
    );

    assert_eq!(reason, Some(FailureReason::InsufficientCredits));
}

#[test]
fn cli_failure_reason_classifies_claude_result_credit_affordability_diagnostic() {
    let message = "API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1600. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::InsufficientCredits)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_ignores_generic_402_error() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 402 Payment Required",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_invalid_credentials() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    );

    assert_eq!(reason, Some(FailureReason::InvalidCredentials));
}

#[test]
fn cli_failure_reason_ignores_generic_claude_401() {
    let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, "401 unauthorized");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_provider_overloaded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_repeated_529_provider_overloaded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: Repeated 529 Overloaded errors. The API is at capacity - this is usually temporary.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_result_provider_overloaded_diagnostic() {
    let message = "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_result_repeated_529_provider_overloaded_diagnostic() {
    let message = "API Error: Repeated 529 Overloaded errors. The API is at capacity - this is usually temporary.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_result_simple_provider_overloaded() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: Overloaded",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_result_simple_provider_overloaded_diagnostic() {
    let message = "API Error: Overloaded";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_ignores_simple_claude_overloaded_from_stderr() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::Stderr,
        "API Error: Overloaded",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_result_stream_idle_timeout() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: Stream idle timeout - partial response received",
    );

    assert_eq!(reason, Some(FailureReason::ProviderStreamTimeout));
}

#[test]
fn cli_failure_reason_classifies_claude_result_stalled_mid_stream() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderStreamTimeout));
}

#[test]
fn cli_failure_reason_classifies_claude_result_stalled_mid_stream_diagnostic() {
    let message = "API Error: Response stalled mid-stream. The response above may be incomplete.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderStreamTimeout)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_ignores_claude_result_stream_timeout_messages_from_stderr() {
    for message in [
        "API Error: Stream idle timeout - partial response received",
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::Stderr,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_non_claude_stream_timeout_messages() {
    for message in [
        "API Error: Stream idle timeout - partial response received",
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_generic_claude_timeout() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: request timed out",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_explanatory_stream_timeout_text() {
    for message in [
        "Observed API Error: Stream idle timeout - partial response received in an earlier run",
        "Observed API Error: Response stalled mid-stream. The response above may be incomplete in an earlier run",
    ] {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            message,
        );

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_provider_server_error() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE,
    );

    assert_eq!(reason, Some(FailureReason::ProviderServerError));
}

#[test]
fn cli_failure_reason_ignores_claude_provider_server_error_from_stderr() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::Stderr,
        CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_claude_provider_server_error_status_prefix() {
    let reason = super::classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        FailureDetailSource::ClaudeResult,
        "API Error: 5000 Internal server error. This is a server-side issue, usually temporary - try again in a moment.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_result_provider_server_error_diagnostic() {
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(
            CLAUDE_PROVIDER_SERVER_ERROR_MESSAGE,
            FailureDetailSource::ClaudeResult,
        )),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ProviderServerError)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_classifies_claude_output_token_limit() {
    for message in [
        "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
        "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
        "API Error: Claude's response exceeded the maximum output tokens for this model.",
        "API Error: Claude's response exceeded the maximum output token limit for this model.",
        "API Error: Claude's response exceeds the output token limit for this model.",
        "API Error: Claude's response has exceeded the max output token budget.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(
            reason,
            Some(FailureReason::OutputTokenLimit),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_classifies_claude_result_output_token_limit_diagnostic() {
    let message = "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
    let msg = cli_failure_message(
        1,
        &["background stderr noise".to_string()],
        Some(&cli_diagnostic(message, FailureDetailSource::ClaudeResult)),
    );
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(msg.source);
    let diagnostic = with_cli_failure_reason(diagnostic, &msg);

    assert_eq!(msg.source, FailureDetailSource::ClaudeResult);
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::OutputTokenLimit)
    );
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::ClaudeResult)
    );
}

#[test]
fn cli_failure_reason_ignores_non_claude_output_token_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_unrelated_claude_output_token_limit_text() {
    for message in [
        "API Error: Claude's context window exceeded the available token budget.",
        "API Error: Claude's response used 32000 tokens before the request completed.",
        "Set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable to configure responses.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_codex_provider_overloaded_text() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_codex_model_capacity() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Selected model is at capacity. Please try a different model.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_wrapped_codex_model_capacity() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Codex failed: Selected model is at capacity. Please try a different model.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_ignores_non_codex_model_capacity() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Selected model is at capacity. Please try a different model.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_codex_context_window_exceeded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );

    assert_eq!(reason, Some(FailureReason::ContextWindowExceeded));
}

#[test]
fn cli_failure_reason_ignores_non_codex_context_window_exceeded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_generic_claude_529() {
    let reason =
        classify_cli_failure_reason(AgentFramework::ClaudeCode, "API Error: 529 upstream failed");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_later_claude_provider_overloaded() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 529 upstream failed. Background retry failed: API Error: 529 Overloaded.",
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_classifies_claude_provider_overloaded_error_type() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        r#"API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"The service is overloaded"}}"#,
    );

    assert_eq!(reason, Some(FailureReason::ProviderOverloaded));
}

#[test]
fn cli_failure_reason_ignores_negated_claude_overloaded_text() {
    let reason =
        classify_cli_failure_reason(AgentFramework::ClaudeCode, "API Error: 529 not overloaded");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_prefixed_claude_overloaded_error_type() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        r#"API Error: 529 {"type":"error","error":{"type":"not_overloaded_error"}}"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_claude_overloaded_prefix_word() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "API Error: 529 overloadedness check failed",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_repeated_claude_529_false_overloaded_text() {
    for message in [
        "API Error: Repeated 529 not overloaded errors.",
        "API Error: Repeated 529 overloadedness check failed.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::ClaudeCode, message);

        assert_eq!(reason, None, "message: {message}");
    }
}

#[test]
fn cli_failure_reason_ignores_claude_overloaded_without_529() {
    let reason =
        classify_cli_failure_reason(AgentFramework::ClaudeCode, "API Error: 503 Overloaded");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_codex_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_codex_quota_exceeded_as_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "Quota exceeded. Check your plan and billing details.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_codex_session_limit() {
    for message in [
        "You've hit your session limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits. Resets 12:50pm (Asia/Shanghai).",
        "SESSION LIMIT reached. Please try again after the reset window.",
    ] {
        let reason = classify_cli_failure_reason(AgentFramework::Codex, message);

        assert_eq!(
            reason,
            Some(FailureReason::UsageLimit),
            "message: {message}"
        );
    }
}

#[test]
fn cli_failure_reason_classifies_codex_invalid_api_key_code() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "OpenAI API request failed: invalid_api_key",
    );

    assert_eq!(reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn cli_failure_reason_classifies_codex_incorrect_api_key_message() {
    let reason =
        classify_cli_failure_reason(AgentFramework::Codex, "Incorrect API key provided: sk-...");

    assert_eq!(reason, Some(FailureReason::InvalidApiKey));
}

#[test]
fn cli_failure_reason_ignores_generic_codex_401() {
    let reason = classify_cli_failure_reason(AgentFramework::Codex, "401 unauthorized");

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token. The connector may need to be reconnected.","permission":"model-provider:codex-oauth-token","base":"https://chatgpt.com/backend-api/codex","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required_envelope() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":{"message":"Access token expired and refresh failed for: codex-oauth-token.","code":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required_after_metadata() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"request metadata {"traceId":"abc","status":502}: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_classifies_codex_oauth_reconnect_required_after_template_brace() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"request template {response_id: {"error":"TOKEN_REFRESH_FAILED","message":"Refresh failed for {codex} token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, Some(FailureReason::ReconnectRequired));
}

#[test]
fn cli_failure_reason_ignores_codex_oauth_upstream_provider() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token after reconnect_required state.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"upstream_provider"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_codex_oauth_refresh_without_failure_reason() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"]}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_non_codex_oauth_reconnect_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: zendesk.","permission":"connector:zendesk","connectors":["zendesk"],"failureReason":"reconnect_required"}, url: https://example.zendesk.com/api/v2/tickets"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_codex_oauth_multi_connector_reconnect_required() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: notion, codex-oauth-token.","connectors":["notion","codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_nested_codex_oauth_reconnect_required_payload() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        r#"unexpected status 502 Bad Gateway: {"debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}"#,
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_prefers_message_classification_over_carried_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("debug failure"),
    )
    .with_cli_exit_code(1);
    let failure_message = selected_failure_message(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage.",
        FailureDetailSource::Stderr,
        Some(FailureReason::InvalidApiKey),
    );
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(diagnostic.failure_reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_ignores_non_codex_invalid_api_key_text() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "OpenAI API request failed: invalid_api_key",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_classifies_claude_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Claude usage limit reached. Visit https://claude.ai/settings/usage.",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_subscription_access_disabled_as_usage_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_session_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "You've hit your session limit · resets 12:50pm (Asia/Shanghai)",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_weekly_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "You've hit your weekly limit · resets 10am (Asia/Shanghai)",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_classifies_claude_monthly_spend_limit() {
    let reason = classify_cli_failure_reason(
        AgentFramework::ClaudeCode,
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage",
    );

    assert_eq!(reason, Some(FailureReason::UsageLimit));
}

#[test]
fn cli_failure_reason_ignores_codex_monthly_spend_limit_text() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_ignores_unrelated_failures() {
    let reason = classify_cli_failure_reason(
        AgentFramework::Codex,
        "permission denied while running command",
    );

    assert_eq!(reason, None);
}

#[test]
fn cli_failure_reason_leaves_unrelated_diagnostic_unchanged() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(2)
    .with_failure_detail_source(FailureDetailSource::Stderr);
    let failure_message = selected_failure_message(
        "permission denied while running command",
        FailureDetailSource::Stderr,
        None,
    );
    let unchanged = with_cli_failure_reason(diagnostic.clone(), &failure_message);

    assert_eq!(unchanged, diagnostic);
}

#[test]
fn cli_failure_reason_is_attached_without_changing_failure_class() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl);
    let failure_message = selected_failure_message(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage.",
        FailureDetailSource::CodexJsonl,
        None,
    );
    let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);

    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(diagnostic.failure_reason, Some(FailureReason::UsageLimit));
    assert_eq!(
        diagnostic.failure_detail_source,
        Some(FailureDetailSource::CodexJsonl)
    );
}

#[test]
fn cli_termination_is_attached_without_changing_failure_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(143)
    .with_failure_reason(FailureReason::ProviderOverloaded);
    let termination = CliTerminationDiagnostic::new(CliTerminationReason::PostResultReap)
        .record_signal(CliTerminationSignal::Sigterm, Some(1401), Some(10_000))
        .with_observed_exit_code(143);

    let with_termination = with_cli_termination(diagnostic.clone(), Some(termination));
    let unchanged = with_cli_termination(diagnostic.clone(), None);

    assert_eq!(with_termination.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        with_termination.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(with_termination.cli_termination, Some(termination));
    assert_eq!(unchanged, diagnostic);
}

#[test]
fn cli_observed_exit_is_attached_without_changing_failure_reason() {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("plain prompt"),
    )
    .with_cli_exit_code(137)
    .with_failure_reason(FailureReason::ProviderOverloaded);
    let observed_exit = CliObservedExitDiagnostic::from_signal(libc::SIGKILL);

    let with_observed_exit =
        with_cli_observed_exit(diagnostic.clone(), Some(observed_exit.clone()));
    let unchanged = with_cli_observed_exit(diagnostic.clone(), None);

    assert_eq!(with_observed_exit.failure_class, FailureClass::CliNonzero);
    assert_eq!(
        with_observed_exit.failure_reason,
        Some(FailureReason::ProviderOverloaded)
    );
    assert_eq!(with_observed_exit.cli_observed_exit, Some(observed_exit));
    assert_eq!(unchanged, diagnostic);
}

#[test]
fn history_target_unavailable_detects_missing_and_empty_files() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing.jsonl");
    assert!(history_target_unavailable(&missing));

    let empty = tmp.path().join("empty.jsonl");
    std::fs::write(&empty, "").unwrap();
    assert!(history_target_unavailable(&empty));

    let non_empty = tmp.path().join("history.jsonl");
    std::fs::write(&non_empty, r#"{"type":"system"}"#).unwrap();
    assert!(!history_target_unavailable(&non_empty));

    assert!(!history_target_unavailable(tmp.path()));
}
