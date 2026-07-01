//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! checkpoint creation inside a Firecracker VM.

use guest_agent::checkpoint;
use guest_agent::cli;
use guest_agent::complete;
use guest_agent::control;
use guest_agent::env;
use guest_agent::events;
use guest_agent::heartbeat;
use guest_agent::http::HttpClient;
use guest_agent::masker;
use guest_agent::metrics;
use guest_agent::paths;
use guest_agent::run_context::GuestRuntime;
use guest_agent::session_history_identity;
use guest_agent::session_metadata;
use guest_agent::telemetry::{Telemetry, UploadMode};

use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use guest_contracts::diagnostics::{
    AgentFramework, CliTerminationDiagnostic, CliTerminationReason, FailureClass,
    FailureDetailSource, FailureDiagnostic, FailureReason, PromptMetadata, SessionHistoryStatus,
};
use guest_contracts::session_history_identity::{
    FinalSessionHistoryIdentityExpectation, SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
};
use serde_json::Value;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const MAX_LOGGED_CLI_STDERR_LINES: usize = 20;
const MAX_LOGGED_CLI_STDERR_LINE_BYTES: usize = 4096;
const CODEX_OAUTH_TOKEN_CONNECTOR: &str = "codex-oauth-token";

#[tokio::main]
async fn main() {
    if let Some(exit_code) = helper_exit_code_from_args() {
        std::process::exit(exit_code);
    }
    let runtime = match GuestRuntime::from_process_env() {
        Ok(runtime) => runtime,
        Err(e) => {
            log_error!(LOG_TAG, "Fatal: {e}");
            log_info!(LOG_TAG, "✗ Sandbox failed (exit code 1)");
            std::process::exit(1);
        }
    };
    let exit_code = run(runtime).await;
    std::process::exit(exit_code);
}

fn helper_exit_code_from_args() -> Option<i32> {
    let mut args = std::env::args_os();
    let _program = args.next()?;
    let command = args.next()?;
    if command != "verify-session-history-identity" {
        return None;
    }
    let metadata_path = args
        .next()
        .unwrap_or_else(|| paths::final_session_history_identity_file().into());
    let remaining = args.collect::<Vec<_>>();
    let expected = match parse_session_history_identity_expectation(&remaining) {
        Ok(expected) => expected,
        Err(()) => return Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS),
    };
    Some(
        match session_history_identity::verify_final_session_history_identity_file(
            metadata_path,
            expected.as_ref(),
        ) {
            Ok(()) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
            Err(error) => {
                let exit_code = error.helper_exit_code();
                if exit_code == SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS {
                    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE
                } else {
                    exit_code
                }
            }
        },
    )
}

fn parse_session_history_identity_expectation(
    args: &[std::ffi::OsString],
) -> Result<Option<FinalSessionHistoryIdentityExpectation>, ()> {
    let [
        framework,
        session_id_hash,
        history_ref_kind,
        history_hash,
        history_size_bytes,
    ] = match args {
        [] => return Ok(None),
        [
            framework,
            session_id_hash,
            history_ref_kind,
            history_hash,
            history_size_bytes,
        ] => [
            framework,
            session_id_hash,
            history_ref_kind,
            history_hash,
            history_size_bytes,
        ],
        _ => return Err(()),
    };
    let framework = framework.to_str().ok_or(())?;
    let session_id_hash = session_id_hash.to_str().ok_or(())?;
    let history_ref_kind = history_ref_kind.to_str().ok_or(())?;
    let history_hash = history_hash.to_str().ok_or(())?;
    let history_size_bytes = history_size_bytes.to_str().ok_or(())?;
    FinalSessionHistoryIdentityExpectation::from_cli_args([
        framework,
        session_id_hash,
        history_ref_kind,
        history_hash,
        history_size_bytes,
    ])
    .map(Some)
    .map_err(|_| ())
}

/// Top-level orchestrator. Returns exit code directly (never panics/errors out).
/// Final telemetry upload is attempted on all paths where the HTTP client can
/// be initialized; when no API token is configured, that upload is a no-op.
async fn run(runtime: GuestRuntime) -> i32 {
    // Record API-to-agent E2E time (as early as possible)
    guest_agent::timing::record_e2e_from_api_start(
        "api_to_agent_start",
        &runtime.config.api_start_time,
    );

    // Lifecycle: Header
    log_info!(LOG_TAG, "▶ VM0 Sandbox {}", runtime.config.run_id);

    // Lifecycle: Initialization
    log_info!(LOG_TAG, "▷ Initialization");

    let http = runtime.http.clone();
    let masker = Arc::new(masker::SecretMasker::from_config(&runtime.config));
    let shutdown = CancellationToken::new();
    let framework_supports_active_input = framework_supports_active_input(
        runtime.config.framework,
        runtime.config.use_codex_app_server_backend,
    );
    let has_process_control_endpoint = matches!(
        std::env::var(process_control_ipc::BOOTSTRAP_ENV),
        Ok(endpoint) if !endpoint.is_empty()
    );
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        framework_supports_active_input && has_process_control_endpoint,
        &runtime.config.prompt,
    );
    let control_handle = control::ControlHandle::spawn(shutdown.clone(), active_input.controller());
    let start = Instant::now();

    log_info!(
        LOG_TAG,
        "Working directory: {}",
        paths::CANONICAL_WORKING_DIR
    );

    let t = Instant::now();
    let (heartbeat_status_tx, heartbeat_status_rx) = tokio::sync::oneshot::channel();
    let heartbeat_handle = spawn_heartbeat(
        runtime.config.run_id.clone(),
        shutdown.clone(),
        http.clone(),
        heartbeat_status_tx,
    );
    log_info!(LOG_TAG, "Heartbeat started");
    record_sandbox_op("heartbeat_start", t.elapsed(), true, None);

    let t = Instant::now();
    let metrics_handle = tokio::spawn({
        let shutdown = shutdown.clone();
        let metrics_log_file = runtime.paths.metrics_log_file().to_string();
        async move { metrics::metrics_loop_for_path(shutdown, metrics_log_file).await }
    });
    log_info!(LOG_TAG, "Metrics collector started");
    record_sandbox_op("metrics_collector_start", t.elapsed(), true, None);

    let t = Instant::now();
    let telemetry = Telemetry::spawn_for_paths(
        runtime.config.run_id.clone(),
        &runtime.paths,
        masker.clone(),
        http.clone(),
    );
    log_info!(LOG_TAG, "Telemetry upload started");
    record_sandbox_op("telemetry_upload_start", t.elapsed(), true, None);

    // Execute main logic (init + CLI + checkpoint/recovery + /complete).
    // On the success path, `execute` overlaps the pre-checkpoint telemetry
    // flush with checkpoint creation. The EOF-consuming final flush runs below,
    // after background producers stop, so `/complete` logs still upload without
    // racing metrics or heartbeat writes.
    let exit_code = execute(
        &masker,
        start,
        Some(heartbeat_status_rx),
        &telemetry,
        active_input.into_writer(),
        &runtime,
    )
    .await;

    stop_background_and_flush_final_telemetry(
        shutdown,
        control_handle,
        metrics_handle,
        heartbeat_handle,
        telemetry,
    )
    .await;

    if exit_code == 0 {
        log_info!(LOG_TAG, "✓ Sandbox finished successfully");
    } else {
        log_info!(LOG_TAG, "✗ Sandbox failed (exit code {exit_code})");
    }

    exit_code
}

fn framework_supports_active_input(
    framework: env::Framework,
    use_codex_app_server_backend: bool,
) -> bool {
    matches!(framework, env::Framework::ClaudeCode)
        || (matches!(framework, env::Framework::Codex) && use_codex_app_server_backend)
}

/// Main execution logic: working dir, CLI, checkpoint/recovery, and `/complete`.
/// The success path overlaps the pre-checkpoint telemetry flush with
/// checkpoint creation. Final telemetry is owned by [`run`] after producer
/// shutdown.
async fn execute(
    masker: &masker::SecretMasker,
    start: Instant,
    heartbeat_monitor: cli::HeartbeatMonitor,
    telemetry: &Telemetry,
    active_input: guest_agent::active_input::ActiveInputWriter,
    runtime: &GuestRuntime,
) -> i32 {
    let config = &runtime.config;
    let runtime_paths = &runtime.paths;
    let http = runtime.http.clone();

    // Pre-warm kernel DNS cache for the CLI's API endpoint.
    // Fire-and-forget: runs in background so the cache is populated by the
    // time the CLI spawns and makes its first HTTPS request.
    let dns_target = match config.framework {
        env::Framework::ClaudeCode => "api.anthropic.com:443",
        env::Framework::Codex => "api.openai.com:443",
    };
    tokio::spawn(async move {
        let _ = tokio::net::lookup_host(dns_target).await;
    });

    // Working directory setup
    let wd_start = Instant::now();
    if let Err(e) = setup_working_dir(paths::CANONICAL_WORKING_DIR) {
        let msg = format!("Working dir setup failed: {e}");
        log_error!(LOG_TAG, "{msg}");
        write_guest_error_file(runtime_paths.checkpoint_error_file(), &msg);
        write_guest_failure_diagnostic(
            runtime_paths.failure_diagnostic_file(),
            &base_failure_diagnostic_for_config(config, FailureClass::WorkingDirSetupFailed),
        );
        record_sandbox_op("working_dir_setup", wd_start.elapsed(), false, Some(&msg));
        return 1;
    }
    record_sandbox_op("working_dir_setup", wd_start.elapsed(), true, None);

    // Codex auth reconciliation must complete before the CLI starts. On reused
    // sandboxes, continuing after a setup failure can inherit stale auth state
    // from an earlier run.
    if matches!(config.framework, env::Framework::Codex)
        && let Err(e) = cli::setup_codex_for_config(masker, config).await
    {
        let msg = format!(
            "Codex auth setup failed: {}",
            masker.mask_string(&e.to_string())
        );
        log_error!(LOG_TAG, "{msg}");
        write_guest_error_file(runtime_paths.checkpoint_error_file(), &msg);
        write_guest_failure_diagnostic(
            runtime_paths.failure_diagnostic_file(),
            &base_failure_diagnostic_for_config(config, FailureClass::CliExecutionError),
        );
        return 1;
    }

    // Memory is mounted directly through manifest.artifacts[] at the
    // framework-specific memory path — no runtime symlink needed (see #10602).

    let init_elapsed = start.elapsed();
    record_sandbox_op("init_total", init_elapsed, true, None);
    log_info!(
        LOG_TAG,
        "✓ Initialization complete ({}s)",
        init_elapsed.as_secs()
    );

    // Execution phase
    log_info!(LOG_TAG, "▷ Execution");
    let cli_start = Instant::now();
    let mut last_event_sequence = None;
    let (
        cli_exit_code,
        exit_code,
        error_message,
        skip_recovery_checkpoint_for_no_history,
        failure_diagnostic,
        cli_execution_succeeded,
    ) = match cli::execute_cli_with_active_input_for_config(
        masker,
        heartbeat_monitor,
        http.clone(),
        active_input,
        config,
        runtime_paths,
    )
    .await
    {
        Ok(cli_result) => {
            last_event_sequence = cli_result.last_event_sequence;
            let cli_exit_code = cli_result.exit_code;
            if let Some(control_error) = cli_result.control_error.as_ref() {
                let msg = control_error.to_string();
                let diagnostic = cli_result_failure_diagnostic_for_config(
                    config,
                    runtime_paths,
                    FailureClass::CliExecutionError,
                    cli_exit_code,
                    cli_result.claude_result,
                );
                let diagnostic = with_cli_termination(diagnostic, cli_result.cli_termination);
                (cli_exit_code, 1, msg, false, Some(diagnostic), false)
            } else if preserves_successful_post_result_cleanup(config.framework, &cli_result) {
                (cli_exit_code, 0, String::new(), false, None, true)
            } else if cli_exit_code != 0 {
                let failure_message = cli_failure_message(
                    cli_exit_code,
                    &cli_result.stderr_lines,
                    cli_result.failure_diagnostic.as_ref(),
                );
                let diagnostic = cli_result_failure_diagnostic_for_config(
                    config,
                    runtime_paths,
                    FailureClass::CliNonzero,
                    cli_exit_code,
                    cli_result.claude_result,
                )
                .with_failure_detail_source(failure_message.source);
                let diagnostic = with_cli_termination(diagnostic, cli_result.cli_termination);
                let diagnostic = with_cli_failure_reason(diagnostic, &failure_message);
                (
                    cli_exit_code,
                    cli_exit_code,
                    failure_message.message,
                    false,
                    Some(diagnostic),
                    false,
                )
            } else if http.has_api() && is_claude_zero_turn_result(config.framework, &cli_result) {
                let history_check_start = Instant::now();
                let session_history_status =
                    claude_history_target_status_for_config(config, runtime_paths);
                if session_history_unavailable(session_history_status) {
                    let msg = "Claude Code emitted a zero-turn result without creating session history; skipping checkpoint";
                    record_sandbox_op(
                        "session_history_available",
                        history_check_start.elapsed(),
                        false,
                        Some(msg),
                    );
                    log_info!(LOG_TAG, "{msg}");
                    let diagnostic = base_failure_diagnostic_for_config(
                        config,
                        FailureClass::ClaudeZeroTurnNoHistory,
                    )
                    .with_cli_exit_code(cli_exit_code)
                    .with_claude_num_turns(Some(0))
                    .with_session_history_status(session_history_status);
                    (
                        cli_exit_code,
                        1,
                        msg.to_string(),
                        true,
                        Some(diagnostic),
                        true,
                    )
                } else {
                    (0, 0, String::new(), false, None, true)
                }
            } else {
                (0, 0, String::new(), false, None, true)
            }
        }
        Err(e) => {
            let msg = e.to_string();
            log_error!(LOG_TAG, "CLI execution failed: {msg}");
            (
                1,
                1,
                msg,
                false,
                Some(base_failure_diagnostic_for_config(
                    config,
                    FailureClass::CliExecutionError,
                )),
                false,
            )
        }
    };
    let cli_elapsed = cli_start.elapsed();
    record_sandbox_op(
        "cli_execution",
        cli_elapsed,
        cli_execution_succeeded,
        if cli_execution_succeeded {
            None
        } else {
            Some(error_message.as_str())
        },
    );

    complete_execution(
        cli_exit_code,
        exit_code,
        cli_elapsed,
        CompletionState {
            last_event_sequence,
            failure_message: (exit_code != 0).then_some(error_message.as_str()),
            failure_diagnostic,
            skip_recovery_checkpoint_for_no_history,
        },
        telemetry,
        runtime,
    )
    .await
}

fn is_claude_zero_turn_result(
    framework: env::Framework,
    cli_result: &cli::CliExecutionResult,
) -> bool {
    matches!(framework, env::Framework::ClaudeCode)
        && cli_result.exit_code == 0
        && cli_result.claude_result.is_some_and(|result| {
            result.status == cli::ClaudeResultStatus::Success && result.num_turns == Some(0)
        })
}

fn preserves_successful_post_result_cleanup(
    framework: env::Framework,
    cli_result: &cli::CliExecutionResult,
) -> bool {
    matches!(framework, env::Framework::ClaudeCode)
        && cli_result.control_error.is_none()
        && cli_result.exit_code != 0
        && cli_result
            .post_result_cleanup_result
            .is_some_and(|result| result.status == cli::ClaudeResultStatus::Success)
        && cli_result
            .cli_termination
            .as_ref()
            .is_some_and(|termination| {
                termination.reason == CliTerminationReason::PostResultReap
                    && termination.observed_exit_code == Some(cli_result.exit_code)
            })
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

fn base_failure_diagnostic_for_config(
    config: &env::GuestConfig,
    failure_class: FailureClass,
) -> FailureDiagnostic {
    base_failure_diagnostic_from_parts(failure_class, config.framework, &config.prompt)
}

fn base_failure_diagnostic_from_parts(
    failure_class: FailureClass,
    framework: env::Framework,
    prompt: &str,
) -> FailureDiagnostic {
    FailureDiagnostic::new(
        failure_class,
        diagnostic_framework_from_framework(framework),
        PromptMetadata::from_prompt(prompt),
    )
}

fn diagnostic_framework_from_framework(framework: env::Framework) -> AgentFramework {
    match framework {
        env::Framework::ClaudeCode => AgentFramework::ClaudeCode,
        env::Framework::Codex => AgentFramework::Codex,
    }
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
        && guest_agent::events::is_codex_model_capacity_message(failure_message)
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    // Subscription/usage limits are an expected quota state for both Codex
    // (ChatGPT plan "usage limit") and Claude Code (Max plan "session limit" /
    // "weekly limit" / org monthly spend limit), so classify them regardless of
    // framework where the wording is shared. This lets the runner log these
    // expected outcomes at info instead of error.
    if normalized.contains("usage limit")
        || normalized.contains("session limit")
        || normalized.contains("weekly limit")
        || (matches!(framework, AgentFramework::ClaudeCode)
            && (is_claude_subscription_access_disabled_error(&normalized)
                || is_claude_monthly_spend_limit_error(&normalized)))
    {
        return Some(FailureReason::UsageLimit);
    }
    None
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
        && trimmed.starts_with("api error: stream idle timeout")
        && trimmed.contains("partial response received")
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
        || !error_message.contains(CODEX_OAUTH_TOKEN_CONNECTOR)
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
        && has_exact_codex_oauth_connector(value)
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

fn diagnostic_session_history_status_for_config(
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

fn session_history_unavailable(status: SessionHistoryStatus) -> bool {
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

fn write_guest_error_file(checkpoint_error_file: &str, message: &str) {
    let message = message.trim();
    if message.is_empty() {
        return;
    }

    if let Err(e) = paths::write_private(checkpoint_error_file, message) {
        log_warn!(LOG_TAG, "Failed to write guest error file: {e}");
    }
}

fn write_guest_failure_diagnostic(failure_diagnostic_file: &str, diagnostic: &FailureDiagnostic) {
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

#[derive(Debug, Clone, PartialEq, Eq)]
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
        return events::is_generic_codex_failure_diagnostic(message);
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

struct CompletionState<'a> {
    last_event_sequence: Option<u32>,
    failure_message: Option<&'a str>,
    failure_diagnostic: Option<FailureDiagnostic>,
    skip_recovery_checkpoint_for_no_history: bool,
}

async fn complete_execution(
    cli_exit_code: i32,
    mut exit_code: i32,
    cli_elapsed: Duration,
    state: CompletionState<'_>,
    telemetry: &Telemetry,
    runtime: &GuestRuntime,
) -> i32 {
    let config = &runtime.config;
    let runtime_paths = &runtime.paths;
    let http = &runtime.http;
    let has_failure_message = state
        .failure_message
        .is_some_and(|message| !message.trim().is_empty());
    if let Some(message) = state.failure_message {
        write_guest_error_file(runtime_paths.checkpoint_error_file(), message);
    }
    let mut wrote_failure_diagnostic = false;
    if let Some(diagnostic) = &state.failure_diagnostic {
        write_guest_failure_diagnostic(runtime_paths.failure_diagnostic_file(), diagnostic);
        wrote_failure_diagnostic = true;
    }

    // Check if any events failed to send (before logging execution result)
    if std::path::Path::new(runtime_paths.event_error_flag()).exists() {
        let msg = "Some events failed to send, marking run as failed";
        log_error!(LOG_TAG, "{msg}");
        if !has_failure_message {
            write_guest_error_file(runtime_paths.checkpoint_error_file(), msg);
        }
        if !wrote_failure_diagnostic {
            let diagnostic =
                base_failure_diagnostic_for_config(config, FailureClass::EventUploadFailed)
                    .with_cli_exit_code(cli_exit_code)
                    .with_session_history_status(diagnostic_session_history_status_for_config(
                        config,
                        runtime_paths,
                    ));
            write_guest_failure_diagnostic(runtime_paths.failure_diagnostic_file(), &diagnostic);
            wrote_failure_diagnostic = true;
        }
        exit_code = 1;
    }

    if exit_code == 0 {
        log_info!(LOG_TAG, "✓ Execution complete ({}s)", cli_elapsed.as_secs());
    } else {
        log_info!(LOG_TAG, "✗ Execution failed ({}s)", cli_elapsed.as_secs());
    }

    // Checkpoint on success (skip when no API — local/test mode). The
    // pre-checkpoint flush runs in `tokio::join!` with the snapshot work so
    // its ~1s upload overlaps the ~4s checkpoint. The EOF-consuming final
    // pass runs from the top-level shutdown path after telemetry producers
    // stop, so it can safely catch checkpoint and `/complete` logs.
    let agent_type = config.framework.agent_type();
    if should_create_success_checkpoint(exit_code) && http.has_api() {
        log_info!(LOG_TAG, "{agent_type} completed successfully");

        log_info!(LOG_TAG, "▷ Checkpoint");
        let cp_start = Instant::now();
        let (cp_result, _) = tokio::join!(
            checkpoint::create_checkpoint_for_runtime(runtime),
            telemetry.flush(UploadMode::Live),
        );
        match cp_result {
            Ok(()) => {
                log_info!(
                    LOG_TAG,
                    "✓ Checkpoint complete ({}s)",
                    cp_start.elapsed().as_secs()
                );

                // Checkpoint row is in the DB — the complete route's only
                // hard dependency is satisfied. Fire /complete now so the
                // host's `last_event_to_complete` timestamp isn't stretched
                // by VM teardown + runner fallback (which used to be the
                // only trigger). Runner still posts /complete after VM
                // exit; its call is idempotency-short-circuited.
                //
                // Serialize /complete before returning to the top-level final
                // telemetry pass so the ack log line lands in the file before
                // the telemetry uploader snapshots its EOF. The
                // ~hundreds-of-ms we pay for serialization is invisible to
                // users because the host's status transition already happened
                // the moment /complete returned.
                log_info!(LOG_TAG, "▷ Cleanup");
                complete::report_success_for_run(
                    http,
                    &config.run_id,
                    &config.sandbox_id,
                    &config.sandbox_reuse_result,
                    state.last_event_sequence,
                )
                .await;
            }
            Err(e) => {
                let msg = format!("Checkpoint failed: {e}");
                log_error!(LOG_TAG, "{msg}");
                log_info!(
                    LOG_TAG,
                    "✗ Checkpoint failed ({}s)",
                    cp_start.elapsed().as_secs()
                );
                write_guest_error_file(runtime_paths.checkpoint_error_file(), &msg);
                if !wrote_failure_diagnostic {
                    let diagnostic =
                        base_failure_diagnostic_for_config(config, FailureClass::CheckpointFailed)
                            .with_cli_exit_code(cli_exit_code)
                            .with_session_history_status(
                                diagnostic_session_history_status_for_config(config, runtime_paths),
                            );
                    write_guest_failure_diagnostic(
                        runtime_paths.failure_diagnostic_file(),
                        &diagnostic,
                    );
                }
                exit_code = 1;

                // Failure path: don't call /complete from guest. The runner's
                // provider.complete() fallback posts exitCode=1, triggering
                // the route's "checkpoint not found → failed" branch.
                log_info!(LOG_TAG, "▷ Cleanup");
            }
        }
    } else {
        if exit_code == 0 {
            log_info!(LOG_TAG, "{agent_type} completed successfully");
        } else if state.skip_recovery_checkpoint_for_no_history {
            log_info!(
                LOG_TAG,
                "{agent_type} completed without resumable session history; marking run as failed"
            );
        } else if cli_exit_code != 0 {
            log_info!(
                LOG_TAG,
                "{agent_type} failed with exit code {cli_exit_code}"
            );
        }

        if http.has_api() {
            if state.skip_recovery_checkpoint_for_no_history {
                log_info!(
                    LOG_TAG,
                    "Skipping recovery checkpoint because no session history was created"
                );
            } else {
                log_info!(LOG_TAG, "Attempting best-effort recovery checkpoint");
                match checkpoint::create_recovery_checkpoint_for_runtime(runtime).await {
                    Ok(()) => log_info!(LOG_TAG, "Recovery checkpoint created"),
                    Err(e) => log_warn!(LOG_TAG, "Recovery checkpoint skipped: {e}"),
                }
            }
        }

        log_info!(LOG_TAG, "▷ Cleanup");
    }

    exit_code
}

async fn stop_background_and_flush_final_telemetry(
    shutdown: CancellationToken,
    control_handle: Option<control::ControlHandle>,
    metrics_handle: tokio::task::JoinHandle<()>,
    heartbeat_handle: tokio::task::JoinHandle<()>,
    telemetry: Telemetry,
) {
    // Stop telemetry producers before the EOF-consuming final pass.
    shutdown.cancel();
    stop_heartbeat(heartbeat_handle).await;
    if let Some(control_handle) = control_handle {
        control_handle.join();
    }
    let _ = metrics_handle.await;
    final_telemetry(telemetry).await;
    log_info!(LOG_TAG, "Background processes stopped");
}

fn spawn_heartbeat(
    run_id: String,
    shutdown: CancellationToken,
    http: HttpClient,
    status_tx: tokio::sync::oneshot::Sender<cli::HeartbeatStatus>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let heartbeat_task =
            tokio::spawn(heartbeat::heartbeat_loop_for_run(run_id, http, shutdown));
        let _abort_on_drop = AbortTaskOnDrop(heartbeat_task.abort_handle());
        let status = match heartbeat_task.await {
            Ok(Ok(())) => cli::HeartbeatStatus::Stopped,
            Ok(Err(error)) => cli::HeartbeatStatus::Failed(error),
            Err(error) => cli::HeartbeatStatus::TaskFailed(error.to_string()),
        };
        let _ = status_tx.send(status);
    })
}

struct AbortTaskOnDrop(tokio::task::AbortHandle);

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn stop_heartbeat(handle: tokio::task::JoinHandle<()>) {
    if !handle.is_finished() {
        handle.abort();
    }
    match handle.await {
        Ok(()) => {}
        Err(error) if error.is_cancelled() => {}
        Err(error) => log_warn!(LOG_TAG, "Heartbeat task stopped: {error}"),
    }
}

fn should_create_success_checkpoint(exit_code: i32) -> bool {
    exit_code == 0
}

fn setup_working_dir(path: impl AsRef<Path>) -> std::io::Result<()> {
    let path = path.as_ref();
    std::fs::create_dir_all(path)?;
    std::env::set_current_dir(path)
}

/// Final telemetry upload — best-effort and logs on failure.
/// Success `/complete` reporting has already run before this point; the runner
/// still keeps its idempotent VM-exit fallback.
async fn final_telemetry(telemetry: Telemetry) {
    log_info!(LOG_TAG, "Performing final telemetry upload...");
    if telemetry.final_flush_and_shutdown().await.is_err() {
        log_error!(LOG_TAG, "Final telemetry upload failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::diagnostics::CliTerminationSignal;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::sync::LazyLock;

    static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static COMPLETE_EXECUTION_MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(MockServer::start);
    static MAIN_TEST_RUNTIME_ROOT: LazyLock<std::path::PathBuf> = LazyLock::new(|| {
        let timestamp_nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "vm0-guest-agent-main-tests-{}-{timestamp_nanos}",
            std::process::id()
        ))
    });
    fn lock_test_state() -> std::sync::MutexGuard<'static, ()> {
        TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn test_http_client(server: &MockServer) -> HttpClient {
        HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO).unwrap()
    }

    fn test_guest_config(server: &MockServer, prompt: Option<&str>) -> env::GuestConfig {
        env::GuestConfig::from_raw(env::GuestConfigRaw {
            run_id: "main-recovery-checkpoint".to_string(),
            api_url: server.base_url(),
            api_token: "test-token".to_string(),
            prompt: prompt.unwrap_or_default().to_string(),
            home: Some("/home/vm0".to_string()),
            guest_runtime_dir: Some(test_runtime_dir()),
            ..env::GuestConfigRaw::default()
        })
        .unwrap()
    }

    fn test_guest_runtime(config: env::GuestConfig, http: HttpClient) -> GuestRuntime {
        GuestRuntime {
            config,
            paths: paths::GuestPaths::from_runtime_dir(test_runtime_dir()),
            http,
        }
    }

    fn test_runtime_dir() -> std::path::PathBuf {
        MAIN_TEST_RUNTIME_ROOT.join("main-recovery-checkpoint")
    }

    struct EnvVarRestoreGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvVarRestoreGuard {
        fn capture(keys: impl IntoIterator<Item = &'static str>) -> Self {
            let saved = keys
                .into_iter()
                .map(|key| (key, std::env::var_os(key)))
                .collect();
            Self { saved }
        }
    }

    impl Drop for EnvVarRestoreGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                unsafe {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }
    }

    #[test]
    fn framework_supports_active_input_for_claude_and_codex_app_server_only() {
        assert!(framework_supports_active_input(
            env::Framework::ClaudeCode,
            false
        ));
        assert!(framework_supports_active_input(
            env::Framework::ClaudeCode,
            true
        ));
        assert!(!framework_supports_active_input(
            env::Framework::Codex,
            false
        ));
        assert!(framework_supports_active_input(env::Framework::Codex, true));
    }

    struct TestEnvGuard;

    impl Drop for TestEnvGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&*MAIN_TEST_RUNTIME_ROOT);
        }
    }

    unsafe fn set_test_env(server: &MockServer, prompt: Option<&str>) -> TestEnvGuard {
        let _ = std::fs::remove_dir_all(&*MAIN_TEST_RUNTIME_ROOT);
        unsafe {
            clear_test_env();
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                test_runtime_dir(),
            );
            if let Some(prompt) = prompt {
                std::env::set_var("VM0_PROMPT", prompt);
            }
        }
        TestEnvGuard
    }

    unsafe fn clear_test_env() {
        for key in [
            guest_contracts::env::API_URL_ENV,
            guest_contracts::env::RUN_ID_ENV,
            guest_contracts::env::API_TOKEN_ENV,
            guest_contracts::env::SANDBOX_ID_ENV,
            guest_contracts::env::SANDBOX_REUSE_RESULT_ENV,
            guest_contracts::env::PROMPT_ENV,
            guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV,
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
            guest_contracts::env::RESUME_SESSION_ID_ENV,
            guest_contracts::env::API_START_TIME_ENV,
            guest_contracts::env::SECRET_VALUES_ENV,
            guest_contracts::env::DISALLOWED_TOOLS_ENV,
            guest_contracts::env::TOOLS_ENV,
            guest_contracts::env::SETTINGS_ENV,
            guest_contracts::env::CLI_AGENT_TYPE_ENV,
            guest_contracts::env::USER_ENV_FILE_ENV,
            guest_contracts::env::ARTIFACTS_ENV,
            guest_contracts::env::FEATURE_FLAGS_ENV,
            guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV,
            guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            guest_contracts::env::POST_RESULT_TOTAL_CAP_SECS_ENV,
            guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            guest_contracts::env::USE_MOCK_CLAUDE_ENV,
            guest_contracts::env::USE_MOCK_CODEX_ENV,
            guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV,
            guest_contracts::env::MOCK_CLAUDE_PATH_ENV,
            guest_contracts::env::MOCK_CODEX_PATH_ENV,
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            process_control_ipc::BOOTSTRAP_ENV,
            "MOCK_CODEX_FIXTURE",
            "MOCK_CODEX_APP_SERVER_SCENARIO",
        ] {
            unsafe {
                std::env::remove_var(key);
            }
        }
    }

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
        let _test_state_guard = lock_test_state();
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
        let _test_state_guard = lock_test_state();
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
        let _test_state_guard = lock_test_state();
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
        let _test_state_guard = lock_test_state();
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
    fn cli_failure_reason_ignores_stream_idle_timeout_from_stderr() {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::Stderr,
            "API Error: Stream idle timeout - partial response received",
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn cli_failure_reason_ignores_codex_stream_idle_timeout() {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::Codex,
            FailureDetailSource::ClaudeResult,
            "API Error: Stream idle timeout - partial response received",
        );

        assert_eq!(reason, None);
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
    fn cli_failure_reason_ignores_explanatory_stream_idle_timeout_text() {
        let reason = super::classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            FailureDetailSource::ClaudeResult,
            "Observed API Error: Stream idle timeout - partial response received in an earlier run",
        );

        assert_eq!(reason, None);
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
    fn cli_failure_reason_ignores_generic_claude_529() {
        let reason = classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            "API Error: 529 upstream failed",
        );

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
        let reason = classify_cli_failure_reason(
            AgentFramework::ClaudeCode,
            "API Error: 529 not overloaded",
        );

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
        let reason = classify_cli_failure_reason(
            AgentFramework::Codex,
            "Incorrect API key provided: sk-...",
        );

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
    fn is_claude_zero_turn_result_requires_all_guards() {
        let zero_turn = cli::CliExecutionResult {
            exit_code: 0,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: Some(cli::ClaudeResultSummary {
                num_turns: Some(0),
                status: cli::ClaudeResultStatus::Success,
            }),
            post_result_cleanup_result: None,
            failure_diagnostic: None,
            control_error: None,
            cli_termination: None,
        };
        let one_turn = cli::CliExecutionResult {
            exit_code: 0,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: Some(cli::ClaudeResultSummary {
                num_turns: Some(1),
                status: cli::ClaudeResultStatus::Success,
            }),
            post_result_cleanup_result: None,
            failure_diagnostic: None,
            control_error: None,
            cli_termination: None,
        };
        let failed_zero_turn = cli::CliExecutionResult {
            exit_code: 1,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: Some(cli::ClaudeResultSummary {
                num_turns: Some(0),
                status: cli::ClaudeResultStatus::Success,
            }),
            post_result_cleanup_result: None,
            failure_diagnostic: None,
            control_error: None,
            cli_termination: None,
        };
        let unknown_zero_turn = cli::CliExecutionResult {
            exit_code: 0,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: Some(cli::ClaudeResultSummary {
                num_turns: Some(0),
                status: cli::ClaudeResultStatus::Unknown,
            }),
            post_result_cleanup_result: None,
            failure_diagnostic: None,
            control_error: None,
            cli_termination: None,
        };

        assert!(is_claude_zero_turn_result(
            env::Framework::ClaudeCode,
            &zero_turn,
        ));
        assert!(!is_claude_zero_turn_result(
            env::Framework::Codex,
            &zero_turn,
        ));
        assert!(!is_claude_zero_turn_result(
            env::Framework::ClaudeCode,
            &one_turn,
        ));
        assert!(!is_claude_zero_turn_result(
            env::Framework::ClaudeCode,
            &failed_zero_turn,
        ));
        assert!(!is_claude_zero_turn_result(
            env::Framework::ClaudeCode,
            &unknown_zero_turn,
        ));
    }

    #[test]
    fn successful_post_result_cleanup_preserves_semantic_success_only_for_narrow_case() {
        let success_result = cli::ClaudeResultSummary {
            num_turns: Some(1),
            status: cli::ClaudeResultStatus::Success,
        };
        let make_result = |claude_result: cli::ClaudeResultSummary,
                           cleanup_result: cli::ClaudeResultSummary,
                           termination_reason: CliTerminationReason| {
            let termination = CliTerminationDiagnostic::new(termination_reason)
                .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(1_000))
                .with_observed_exit_code(143);
            cli::CliExecutionResult {
                exit_code: 143,
                stderr_lines: Vec::new(),
                last_event_sequence: None,
                claude_result: Some(claude_result),
                post_result_cleanup_result: Some(cleanup_result),
                failure_diagnostic: None,
                control_error: None,
                cli_termination: Some(termination),
            }
        };
        let successful_cleanup = make_result(
            success_result,
            success_result,
            CliTerminationReason::PostResultReap,
        );

        assert!(preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &successful_cleanup,
        ));
        assert!(!preserves_successful_post_result_cleanup(
            env::Framework::Codex,
            &successful_cleanup,
        ));

        let late_error_result_after_successful_cleanup = make_result(
            cli::ClaudeResultSummary {
                num_turns: Some(1),
                status: cli::ClaudeResultStatus::Error,
            },
            success_result,
            CliTerminationReason::PostResultReap,
        );
        assert!(preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &late_error_result_after_successful_cleanup,
        ));

        let error_cleanup = make_result(
            success_result,
            cli::ClaudeResultSummary {
                num_turns: Some(1),
                status: cli::ClaudeResultStatus::Error,
            },
            CliTerminationReason::PostResultReap,
        );
        assert!(!preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &error_cleanup,
        ));

        let stronger_termination = make_result(
            success_result,
            success_result,
            CliTerminationReason::StuckToolWatchdog,
        );
        assert!(!preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &stronger_termination,
        ));
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

    #[test]
    fn success_checkpoint_follows_semantic_run_success() {
        assert!(should_create_success_checkpoint(0));
        assert!(!should_create_success_checkpoint(1));
    }

    #[test]
    fn final_telemetry_success_does_not_record_recursive_upload_op() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(assert_final_telemetry_does_not_record_recursive_upload_op(
                200,
            ));
    }

    #[test]
    fn final_telemetry_failure_does_not_record_recursive_upload_op() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(assert_final_telemetry_does_not_record_recursive_upload_op(
                500,
            ));
    }

    async fn assert_final_telemetry_does_not_record_recursive_upload_op(status: u16) {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _env_guard = unsafe { set_test_env(server, None) };

        let tmp = tempfile::tempdir().unwrap();
        let system_log_path = tmp.path().join("system.log");
        let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
        let cleanup_paths = [
            system_log_path.to_string_lossy().into_owned(),
            paths::sandbox_ops_file().to_string(),
            paths::telemetry_system_log_pos_file().to_string(),
            paths::telemetry_metrics_pos_file().to_string(),
            paths::telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let telemetry_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("before_final_telemetry");
            then.status(status)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        record_sandbox_op(
            "before_final_telemetry",
            Duration::from_millis(1),
            true,
            None,
        );
        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http);

        final_telemetry(telemetry).await;

        telemetry_mock.assert_calls_async(1).await;
        telemetry_mock.delete_async().await;
        let sandbox_ops = std::fs::read_to_string(paths::sandbox_ops_file()).unwrap_or_default();
        assert!(
            !sandbox_ops.contains("final_telemetry_upload"),
            "final telemetry must not record telemetry-upload telemetry through the same stream"
        );

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn final_telemetry_waits_for_background_producers_before_upload() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
                server.reset_async().await;
                let _env_guard = unsafe { set_test_env(server, None) };

                let marker = "producer_after_shutdown_before_final_upload";
                let cleanup_paths = [
                    paths::sandbox_ops_file().to_string(),
                    paths::telemetry_system_log_pos_file().to_string(),
                    paths::telemetry_metrics_pos_file().to_string(),
                    paths::telemetry_sandbox_ops_pos_file().to_string(),
                ];
                for path in &cleanup_paths {
                    let _ = std::fs::remove_file(path);
                }

                let telemetry_mock = server.mock(|when, then| {
                    when.method(POST)
                        .path("/api/webhooks/agent/telemetry")
                        .body_includes(marker);
                    then.status(200)
                        .header("Content-Type", "application/json")
                        .json_body(json!({}));
                });

                let shutdown = CancellationToken::new();
                let producer_shutdown = shutdown.clone();
                let metrics_handle = tokio::spawn(async move {
                    producer_shutdown.cancelled().await;
                    record_sandbox_op(marker, Duration::from_millis(1), true, None);
                });
                let heartbeat_handle = tokio::spawn(async {
                    std::future::pending::<()>().await;
                });
                let masker = Arc::new(masker::SecretMasker::from_env());
                let http = test_http_client(server);
                let telemetry = Telemetry::spawn(masker, http);

                stop_background_and_flush_final_telemetry(
                    shutdown,
                    None,
                    metrics_handle,
                    heartbeat_handle,
                    telemetry,
                )
                .await;

                telemetry_mock.assert_calls_async(1).await;
                telemetry_mock.delete_async().await;
                for path in cleanup_paths {
                    let _ = std::fs::remove_file(path);
                }
            });
    }

    #[test]
    fn stop_heartbeat_aborts_pending_task_promptly() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let heartbeat_handle = tokio::spawn(async {
                    std::future::pending::<()>().await;
                });
                tokio::time::timeout(Duration::from_secs(1), stop_heartbeat(heartbeat_handle))
                    .await
                    .expect("stop_heartbeat should not wait for the heartbeat loop");
            });
    }

    #[test]
    fn complete_execution_creates_recovery_checkpoint_after_cli_failure() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_creates_recovery_checkpoint_after_cli_failure_inner());
    }

    #[test]
    fn complete_execution_skips_recovery_checkpoint_for_no_history() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_skips_recovery_checkpoint_for_no_history_inner());
    }

    #[test]
    fn complete_execution_writes_event_upload_failure_diagnostic() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_writes_event_upload_failure_diagnostic_inner());
    }

    #[test]
    fn complete_execution_writes_checkpoint_failure_diagnostic() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_writes_checkpoint_failure_diagnostic_inner());
    }

    #[test]
    fn complete_execution_preserves_existing_failure_diagnostic_when_events_fail() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(
                complete_execution_preserves_existing_failure_diagnostic_when_events_fail_inner(),
            );
    }

    #[test]
    fn complete_execution_uses_explicit_paths_after_process_env_changes() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_uses_explicit_paths_after_process_env_changes_inner());
    }

    async fn complete_execution_uses_explicit_paths_after_process_env_changes_inner() {
        let tmp = tempfile::tempdir().unwrap();
        let explicit_paths = paths::GuestPaths::from_runtime_dir(tmp.path().join("captured-run"));
        let stale_paths = paths::GuestPaths::from_runtime_dir(tmp.path().join("stale-run"));
        let config = env::GuestConfig::from_raw(env::GuestConfigRaw {
            run_id: "captured-run".to_string(),
            prompt: "captured prompt".to_string(),
            home: Some(
                tmp.path()
                    .join("captured-home")
                    .to_string_lossy()
                    .into_owned(),
            ),
            guest_runtime_dir: Some(explicit_paths.runtime_dir().to_path_buf()),
            ..env::GuestConfigRaw::default()
        })
        .unwrap();
        let http = HttpClient::for_config(&config).unwrap();
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let runtime = GuestRuntime {
            config,
            paths: explicit_paths,
            http,
        };

        let _env_guard = EnvVarRestoreGuard::capture([
            "VM0_RUN_ID",
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        ]);
        unsafe {
            std::env::set_var("VM0_RUN_ID", "stale-run");
            std::env::set_var(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                stale_paths.runtime_dir(),
            );
        }
        paths::write_private(runtime.paths.event_error_flag(), "").unwrap();

        let telemetry = Telemetry::spawn_for_paths(
            runtime.config.run_id.clone(),
            &runtime.paths,
            masker,
            runtime.http.clone(),
        );
        let exit_code = complete_execution(
            0,
            0,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: None,
                failure_diagnostic: None,
                skip_recovery_checkpoint_for_no_history: false,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        assert_eq!(
            std::fs::read_to_string(runtime.paths.checkpoint_error_file()).unwrap(),
            "Some events failed to send, marking run as failed"
        );
        let diagnostic: FailureDiagnostic = serde_json::from_slice(
            &std::fs::read(runtime.paths.failure_diagnostic_file()).unwrap(),
        )
        .unwrap();
        assert_eq!(diagnostic.failure_class, FailureClass::EventUploadFailed);
        assert_eq!(diagnostic.cli_exit_code, Some(0));
        assert!(
            !std::path::Path::new(stale_paths.checkpoint_error_file()).exists(),
            "completion should not write checkpoint errors through stale process env paths"
        );
        assert!(
            !std::path::Path::new(stale_paths.failure_diagnostic_file()).exists(),
            "completion should not write failure diagnostics through stale process env paths"
        );
    }

    async fn complete_execution_writes_event_upload_failure_diagnostic_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _env_guard = unsafe { set_test_env(server, Some("/event-upload-failure")) };

        let cleanup_paths = [
            paths::session_id_file().to_string(),
            paths::session_history_path_file().to_string(),
            paths::checkpoint_error_file().to_string(),
            paths::failure_diagnostic_file().to_string(),
            paths::event_error_flag().to_string(),
            paths::sandbox_ops_file().to_string(),
            paths::telemetry_system_log_pos_file().to_string(),
            paths::telemetry_metrics_pos_file().to_string(),
            paths::telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
        paths::write_private(paths::event_error_flag(), "").unwrap();

        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
        let config = test_guest_config(server, Some("/event-upload-failure"));
        let runtime = test_guest_runtime(config, http.clone());
        let exit_code = complete_execution(
            0,
            0,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: None,
                failure_diagnostic: None,
                skip_recovery_checkpoint_for_no_history: false,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        assert_eq!(
            std::fs::read_to_string(paths::checkpoint_error_file()).unwrap(),
            "Some events failed to send, marking run as failed"
        );
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(paths::failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic.failure_class, FailureClass::EventUploadFailed);
        assert_eq!(diagnostic.cli_exit_code, Some(0));
        assert_eq!(
            diagnostic.session_history_status,
            SessionHistoryStatus::Missing
        );
        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_writes_checkpoint_failure_diagnostic_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _env_guard = unsafe { set_test_env(server, Some("/checkpoint-failure")) };

        let cleanup_paths = [
            paths::session_id_file().to_string(),
            paths::session_history_path_file().to_string(),
            paths::checkpoint_error_file().to_string(),
            paths::failure_diagnostic_file().to_string(),
            paths::event_error_flag().to_string(),
            paths::sandbox_ops_file().to_string(),
            paths::telemetry_system_log_pos_file().to_string(),
            paths::telemetry_metrics_pos_file().to_string(),
            paths::telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
        let config = test_guest_config(server, Some("/checkpoint-failure"));
        let runtime = test_guest_runtime(config, http.clone());
        let exit_code = complete_execution(
            0,
            0,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: None,
                failure_diagnostic: None,
                skip_recovery_checkpoint_for_no_history: false,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        let error = std::fs::read_to_string(paths::checkpoint_error_file()).unwrap();
        assert!(error.contains("Checkpoint failed"), "got: {error}");
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(paths::failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic.failure_class, FailureClass::CheckpointFailed);
        assert_eq!(diagnostic.cli_exit_code, Some(0));
        assert_eq!(
            diagnostic.session_history_status,
            SessionHistoryStatus::Missing
        );
        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_preserves_existing_failure_diagnostic_when_events_fail_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _env_guard = unsafe { set_test_env(server, Some("plain prompt")) };

        let cleanup_paths = [
            paths::session_id_file().to_string(),
            paths::session_history_path_file().to_string(),
            paths::checkpoint_error_file().to_string(),
            paths::failure_diagnostic_file().to_string(),
            paths::event_error_flag().to_string(),
            paths::sandbox_ops_file().to_string(),
            paths::telemetry_system_log_pos_file().to_string(),
            paths::telemetry_metrics_pos_file().to_string(),
            paths::telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
        paths::write_private(paths::event_error_flag(), "").unwrap();

        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
        let config = test_guest_config(server, Some("plain prompt"));
        let runtime = test_guest_runtime(config, http.clone());
        let failure_message = "CLI failed before all events uploaded";
        let failure_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_session_history_status(SessionHistoryStatus::Missing);
        let exit_code = complete_execution(
            1,
            1,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: Some(failure_message),
                failure_diagnostic: Some(failure_diagnostic.clone()),
                skip_recovery_checkpoint_for_no_history: false,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        assert_eq!(
            std::fs::read_to_string(paths::checkpoint_error_file()).unwrap(),
            failure_message
        );
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(paths::failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic, failure_diagnostic);
        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_skips_recovery_checkpoint_for_no_history_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _env_guard = unsafe { set_test_env(server, Some("/help")) };

        let cleanup_paths = [
            paths::checkpoint_error_file().to_string(),
            paths::failure_diagnostic_file().to_string(),
            paths::event_error_flag().to_string(),
            paths::sandbox_ops_file().to_string(),
            paths::telemetry_system_log_pos_file().to_string(),
            paths::telemetry_metrics_pos_file().to_string(),
            paths::telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let prepare_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history");
            then.status(500);
        });
        let checkpoint_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/checkpoints");
            then.status(500);
        });
        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
        let config = test_guest_config(server, Some("/help"));
        let runtime = test_guest_runtime(config, http.clone());
        let failure_message = "Claude Code emitted a zero-turn result without creating session history; skipping checkpoint";
        let failure_diagnostic = FailureDiagnostic::new(
            FailureClass::ClaudeZeroTurnNoHistory,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("/help"),
        )
        .with_cli_exit_code(0)
        .with_claude_num_turns(Some(0))
        .with_session_history_status(SessionHistoryStatus::Missing);
        let exit_code = complete_execution(
            0,
            1,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: Some(failure_message),
                failure_diagnostic: Some(failure_diagnostic.clone()),
                skip_recovery_checkpoint_for_no_history: true,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        assert_eq!(
            std::fs::read_to_string(paths::checkpoint_error_file()).unwrap(),
            failure_message
        );
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(paths::failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic, failure_diagnostic);
        assert_eq!(prepare_mock.calls_async().await, 0);
        assert_eq!(checkpoint_mock.calls_async().await, 0);

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_creates_recovery_checkpoint_after_cli_failure_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _env_guard = unsafe { set_test_env(server, Some("plain prompt")) };

        let cleanup_paths = [
            paths::session_id_file().to_string(),
            paths::session_history_path_file().to_string(),
            paths::checkpoint_error_file().to_string(),
            paths::failure_diagnostic_file().to_string(),
            paths::event_error_flag().to_string(),
            paths::sandbox_ops_file().to_string(),
            paths::telemetry_system_log_pos_file().to_string(),
            paths::telemetry_metrics_pos_file().to_string(),
            paths::telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
        std::fs::write(&history_path, &history).unwrap();
        paths::write_private(paths::session_id_file(), "recovery-session-from-main").unwrap();
        paths::write_private(
            paths::session_history_path_file(),
            history_path.to_string_lossy().as_ref(),
        )
        .unwrap();

        let prepare_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body_includes(r#"{"runId":"main-recovery-checkpoint"}"#);
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({
                    "presignedUrl": server.url("/test/main-recovery-history-upload"),
                    "existing": false
                }));
        });
        let upload_mock = server.mock(|when, then| {
            when.method(PUT)
                .path("/test/main-recovery-history-upload")
                .body(history.as_str());
            then.status(200);
        });
        let checkpoint_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints")
                .json_body_includes(r#"{"cliAgentSessionId":"recovery-session-from-main"}"#);
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({"checkpointId": "checkpoint-from-main"}));
        });
        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
        let config = test_guest_config(server, Some("plain prompt"));
        let runtime = test_guest_runtime(config, http.clone());
        let failure_message = "You've hit your usage limit.";
        let failure_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_session_history_status(SessionHistoryStatus::Present);
        let exit_code = complete_execution(
            1,
            1,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: Some(failure_message),
                failure_diagnostic: Some(failure_diagnostic.clone()),
                skip_recovery_checkpoint_for_no_history: false,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        assert_eq!(
            std::fs::read_to_string(paths::checkpoint_error_file()).unwrap(),
            failure_message
        );
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(paths::failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic, failure_diagnostic);
        prepare_mock.assert_calls_async(1).await;
        upload_mock.assert_calls_async(1).await;
        checkpoint_mock.assert_calls_async(1).await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
