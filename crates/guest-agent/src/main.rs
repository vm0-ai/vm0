//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! checkpoint creation inside a Firecracker VM.

use guest_agent::checkpoint;
use guest_agent::cli;
use guest_agent::complete;
use guest_agent::control;
use guest_agent::env;
use guest_agent::error;
use guest_agent::heartbeat;
use guest_agent::http::HttpClient;
use guest_agent::masker;
use guest_agent::metrics;
use guest_agent::paths;
use guest_agent::telemetry::{Telemetry, UploadMode};

use agent_diagnostics::{
    AgentFramework, FailureClass, FailureDetailSource, FailureDiagnostic, FailureReason,
    PromptMetadata, SessionHistoryStatus,
};
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const MAX_LOGGED_CLI_STDERR_LINES: usize = 20;
const MAX_LOGGED_CLI_STDERR_LINE_BYTES: usize = 4096;

#[tokio::main]
async fn main() {
    guest_common::log::enable_system_log_file();
    let exit_code = run().await;
    std::process::exit(exit_code);
}

/// Top-level orchestrator. Returns exit code directly (never panics/errors out).
/// Final telemetry upload is attempted on all paths where the HTTP client can
/// be initialized; when no API token is configured, that upload is a no-op.
async fn run() -> i32 {
    // Record API-to-agent E2E time (as early as possible)
    guest_agent::timing::record_e2e_from_api("api_to_agent_start");

    let http = match HttpClient::for_current_env() {
        Ok(http) => http,
        Err(e) => {
            log_error!(LOG_TAG, "Fatal: {e}");
            log_info!(LOG_TAG, "✗ Sandbox failed (exit code 1)");
            return 1;
        }
    };

    // Lifecycle: Header
    log_info!(LOG_TAG, "▶ VM0 Sandbox {}", env::run_id());

    // Lifecycle: Initialization
    log_info!(LOG_TAG, "▷ Initialization");

    let masker = Arc::new(masker::SecretMasker::from_env());
    let shutdown = CancellationToken::new();
    let control_handle = control::ControlHandle::spawn(shutdown.clone());
    let start = Instant::now();

    log_info!(
        LOG_TAG,
        "Working directory: {}",
        paths::CANONICAL_WORKING_DIR
    );

    let t = Instant::now();
    let heartbeat_handle = tokio::spawn({
        let shutdown = shutdown.clone();
        let http = http.clone();
        async move { heartbeat::heartbeat_loop(http, shutdown).await }
    });
    log_info!(LOG_TAG, "Heartbeat started");
    record_sandbox_op("heartbeat_start", t.elapsed(), true, None);

    let t = Instant::now();
    let metrics_handle = tokio::spawn({
        let shutdown = shutdown.clone();
        async move { metrics::metrics_loop(shutdown).await }
    });
    log_info!(LOG_TAG, "Metrics collector started");
    record_sandbox_op("metrics_collector_start", t.elapsed(), true, None);

    let t = Instant::now();
    let telemetry = Telemetry::spawn(masker.clone(), http.clone());
    log_info!(LOG_TAG, "Telemetry upload started");
    record_sandbox_op("telemetry_upload_start", t.elapsed(), true, None);

    // Execute main logic (init + CLI + checkpoint + cleanup telemetry).
    // On the success path, `execute` overlaps the pre-checkpoint telemetry
    // flush with checkpoint creation; the final flush still runs after
    // `/complete` so the acknowledgement log line is uploaded.
    let exit_code = execute(&masker, start, heartbeat_handle, &telemetry, http).await;

    // Stop all background processes. Telemetry uses its own command
    // channel; `shutdown` only covers heartbeat/metrics.
    shutdown.cancel();
    if let Some(control_handle) = control_handle {
        control_handle.join();
    }
    let _ = metrics_handle.await;
    telemetry.shutdown().await;
    log_info!(LOG_TAG, "Background processes stopped");

    if exit_code == 0 {
        log_info!(LOG_TAG, "✓ Sandbox finished successfully");
    } else {
        log_info!(LOG_TAG, "✗ Sandbox failed (exit code {exit_code})");
    }

    exit_code
}

/// Main execution logic: working dir, CLI, checkpoint, and cleanup telemetry.
/// The success path overlaps the pre-checkpoint telemetry flush with
/// checkpoint creation, then runs the final flush after `/complete`.
async fn execute(
    masker: &masker::SecretMasker,
    start: Instant,
    heartbeat_handle: tokio::task::JoinHandle<Result<(), error::AgentError>>,
    telemetry: &Telemetry,
    http: HttpClient,
) -> i32 {
    // Pre-warm kernel DNS cache for the CLI's API endpoint.
    // Fire-and-forget: runs in background so the cache is populated by the
    // time the CLI spawns and makes its first HTTPS request.
    let dns_target = match env::Framework::from_env() {
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
        write_guest_error_file(&msg);
        write_guest_failure_diagnostic(&base_failure_diagnostic(
            FailureClass::WorkingDirSetupFailed,
        ));
        record_sandbox_op("working_dir_setup", wd_start.elapsed(), false, Some(&msg));
        return 1;
    }
    record_sandbox_op("working_dir_setup", wd_start.elapsed(), true, None);

    // Codex setup: best-effort `codex login`. Failure is non-fatal —
    // `codex exec` reads `OPENAI_API_KEY` directly from the env.
    if matches!(env::Framework::from_env(), env::Framework::Codex)
        && let Err(e) = cli::setup_codex()
    {
        log_error!(LOG_TAG, "Codex setup failed (non-fatal, continuing): {e}");
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
    ) = match cli::execute_cli(masker, heartbeat_handle, http.clone()).await {
        Ok(cli_result) => {
            last_event_sequence = cli_result.last_event_sequence;
            let cli_exit_code = cli_result.exit_code;
            if cli_exit_code != 0 {
                let failure_message = cli_failure_message(
                    cli_exit_code,
                    &cli_result.stderr_lines,
                    cli_result.failure_diagnostic.as_ref(),
                );
                let diagnostic = cli_result_failure_diagnostic(
                    FailureClass::CliNonzero,
                    cli_exit_code,
                    cli_result.claude_result,
                )
                .with_failure_detail_source(failure_message.source);
                let diagnostic = with_cli_failure_reason(
                    diagnostic,
                    failure_message.message.as_str(),
                    failure_message.failure_reason,
                );
                (
                    cli_exit_code,
                    cli_exit_code,
                    failure_message.message,
                    false,
                    Some(diagnostic),
                )
            } else if http.has_api()
                && is_claude_zero_turn_result(env::Framework::from_env(), &cli_result)
            {
                let history_check_start = Instant::now();
                let session_history_status = claude_history_target_status();
                if session_history_unavailable(session_history_status) {
                    let msg = "Claude Code emitted a zero-turn result without creating session history; skipping checkpoint";
                    record_sandbox_op(
                        "session_history_available",
                        history_check_start.elapsed(),
                        false,
                        Some(msg),
                    );
                    log_info!(LOG_TAG, "{msg}");
                    let diagnostic = base_failure_diagnostic(FailureClass::ClaudeZeroTurnNoHistory)
                        .with_cli_exit_code(cli_exit_code)
                        .with_claude_num_turns(Some(0))
                        .with_session_history_status(session_history_status);
                    (cli_exit_code, 1, msg.to_string(), true, Some(diagnostic))
                } else {
                    (0, 0, String::new(), false, None)
                }
            } else {
                (0, 0, String::new(), false, None)
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
                Some(base_failure_diagnostic(FailureClass::CliExecutionError)),
            )
        }
    };
    let cli_elapsed = cli_start.elapsed();
    record_sandbox_op(
        "cli_execution",
        cli_elapsed,
        cli_exit_code == 0,
        if cli_exit_code != 0 {
            Some(error_message.as_str())
        } else {
            None
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
        &http,
    )
    .await
}

fn is_claude_zero_turn_result(
    framework: env::Framework,
    cli_result: &cli::CliExecutionResult,
) -> bool {
    matches!(framework, env::Framework::ClaudeCode)
        && cli_result.exit_code == 0
        && cli_result
            .claude_result
            .is_some_and(|result| result.num_turns == Some(0))
}

fn cli_result_failure_diagnostic(
    failure_class: FailureClass,
    cli_exit_code: i32,
    claude_result: Option<cli::ClaudeResultSummary>,
) -> FailureDiagnostic {
    let mut diagnostic = base_failure_diagnostic(failure_class)
        .with_cli_exit_code(cli_exit_code)
        .with_session_history_status(diagnostic_session_history_status());
    if let Some(result) = claude_result {
        diagnostic = diagnostic.with_claude_num_turns(result.num_turns);
    }
    diagnostic
}

fn base_failure_diagnostic(failure_class: FailureClass) -> FailureDiagnostic {
    FailureDiagnostic::new(
        failure_class,
        diagnostic_framework(),
        PromptMetadata::from_prompt(env::prompt()),
    )
}

fn diagnostic_framework() -> AgentFramework {
    match env::Framework::from_env() {
        env::Framework::ClaudeCode => AgentFramework::ClaudeCode,
        env::Framework::Codex => AgentFramework::Codex,
    }
}

fn with_cli_failure_reason(
    diagnostic: FailureDiagnostic,
    failure_message: &str,
    failure_reason: Option<FailureReason>,
) -> FailureDiagnostic {
    if let Some(reason) =
        classify_cli_failure_reason(diagnostic.framework, failure_message).or(failure_reason)
    {
        diagnostic.with_failure_reason(reason)
    } else {
        diagnostic
    }
}

fn classify_cli_failure_reason(
    framework: AgentFramework,
    failure_message: &str,
) -> Option<FailureReason> {
    let normalized = failure_message.to_ascii_lowercase();
    if normalized.contains("402 insufficient credits") {
        return Some(FailureReason::InsufficientCredits);
    }
    if matches!(framework, AgentFramework::Codex)
        && (normalized.contains("invalid_api_key")
            || normalized.contains("incorrect api key provided"))
    {
        return Some(FailureReason::InvalidApiKey);
    }
    // Subscription/usage limits are an expected quota state for both Codex
    // (ChatGPT plan "usage limit") and Claude Code (Max plan "session limit" /
    // "weekly limit"), so classify them regardless of framework. This lets the
    // runner log these expected outcomes at info instead of error.
    if normalized.contains("usage limit")
        || normalized.contains("session limit")
        || normalized.contains("weekly limit")
    {
        return Some(FailureReason::UsageLimit);
    }
    None
}

fn diagnostic_session_history_status() -> SessionHistoryStatus {
    match env::Framework::from_env() {
        env::Framework::ClaudeCode => claude_history_target_status(),
        env::Framework::Codex => SessionHistoryStatus::NotApplicable,
    }
}

fn session_history_unavailable(status: SessionHistoryStatus) -> bool {
    matches!(
        status,
        SessionHistoryStatus::Missing | SessionHistoryStatus::Empty
    )
}

fn claude_history_target_status() -> SessionHistoryStatus {
    let raw = match std::fs::read_to_string(paths::session_history_path_file()) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return SessionHistoryStatus::Missing,
        Err(_) => return SessionHistoryStatus::Unknown,
    };
    let target = raw.trim();
    if target.is_empty() {
        return SessionHistoryStatus::Missing;
    }
    history_target_status(Path::new(target))
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

fn write_guest_error_file(message: &str) {
    let message = message.trim();
    if message.is_empty() {
        return;
    }

    if let Err(e) = std::fs::write(paths::checkpoint_error_file(), message) {
        log_warn!(LOG_TAG, "Failed to write guest error file: {e}");
    }
}

fn write_guest_failure_diagnostic(diagnostic: &FailureDiagnostic) {
    let bytes = match serde_json::to_vec(diagnostic) {
        Ok(bytes) => bytes,
        Err(e) => {
            log_warn!(LOG_TAG, "Failed to serialize guest failure diagnostic: {e}");
            return;
        }
    };

    if let Err(e) = std::fs::write(paths::failure_diagnostic_file(), bytes) {
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
    }) && (!is_generic_stdout_failure_diagnostic(message) || stderr_lines.is_empty())
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

fn is_generic_stdout_failure_diagnostic(message: &str) -> bool {
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
    http: &HttpClient,
) -> i32 {
    let has_failure_message = state
        .failure_message
        .is_some_and(|message| !message.trim().is_empty());
    if let Some(message) = state.failure_message {
        write_guest_error_file(message);
    }
    let mut wrote_failure_diagnostic = false;
    if let Some(diagnostic) = &state.failure_diagnostic {
        write_guest_failure_diagnostic(diagnostic);
        wrote_failure_diagnostic = true;
    }

    // Check if any events failed to send (before logging execution result)
    if std::path::Path::new(paths::event_error_flag()).exists() {
        let msg = "Some events failed to send, marking run as failed";
        log_error!(LOG_TAG, "{msg}");
        if !has_failure_message {
            write_guest_error_file(msg);
        }
        if !wrote_failure_diagnostic {
            let diagnostic = base_failure_diagnostic(FailureClass::EventUploadFailed)
                .with_cli_exit_code(cli_exit_code)
                .with_session_history_status(diagnostic_session_history_status());
            write_guest_failure_diagnostic(&diagnostic);
            wrote_failure_diagnostic = true;
        }
        exit_code = 1;
    }

    if cli_exit_code == 0 && exit_code == 0 {
        log_info!(LOG_TAG, "✓ Execution complete ({}s)", cli_elapsed.as_secs());
    } else {
        log_info!(LOG_TAG, "✗ Execution failed ({}s)", cli_elapsed.as_secs());
    }

    // Checkpoint on success (skip when no API — local/test mode). The
    // pre-checkpoint flush runs in `tokio::join!` with the snapshot work so
    // its ~1s upload overlaps the ~4s checkpoint. The post-checkpoint flush
    // catches records checkpoint itself wrote (`session_id_read`, VAS
    // snapshot timings, `checkpoint_total`, etc.) and is the EOF-consuming
    // final pass. Both go through the single-writer uploader, so the two
    // flushes never race the periodic tick on the pos files.
    let agent_type = env::Framework::from_env().agent_type();
    if should_create_success_checkpoint(cli_exit_code, exit_code) && http.has_api() {
        log_info!(LOG_TAG, "{agent_type} completed successfully");

        log_info!(LOG_TAG, "▷ Checkpoint");
        let cp_start = Instant::now();
        let (cp_result, _) = tokio::join!(
            checkpoint::create_checkpoint(http),
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
                // Serialize /complete before final_telemetry so the ack log
                // line lands in the file before the telemetry uploader
                // snapshots its EOF — parallelizing the two hides the ack
                // from `vm0 logs --system`. The ~hundreds-of-ms we pay for
                // serialization is invisible to users because the host's
                // status transition already happened the moment /complete
                // returned.
                log_info!(LOG_TAG, "▷ Cleanup");
                complete::report_success(
                    http,
                    env::sandbox_id(),
                    env::sandbox_reuse_result(),
                    state.last_event_sequence,
                )
                .await;
                final_telemetry(telemetry).await;
            }
            Err(e) => {
                let msg = format!("Checkpoint failed: {e}");
                log_error!(LOG_TAG, "{msg}");
                log_info!(
                    LOG_TAG,
                    "✗ Checkpoint failed ({}s)",
                    cp_start.elapsed().as_secs()
                );
                write_guest_error_file(&msg);
                if !wrote_failure_diagnostic {
                    let diagnostic = base_failure_diagnostic(FailureClass::CheckpointFailed)
                        .with_cli_exit_code(cli_exit_code)
                        .with_session_history_status(diagnostic_session_history_status());
                    write_guest_failure_diagnostic(&diagnostic);
                }
                exit_code = 1;

                // Failure path: don't call /complete from guest. The runner's
                // provider.complete() fallback posts exitCode=1, triggering
                // the route's "checkpoint not found → failed" branch.
                log_info!(LOG_TAG, "▷ Cleanup");
                final_telemetry(telemetry).await;
            }
        }
    } else {
        if cli_exit_code == 0 && exit_code == 0 {
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
                match checkpoint::create_recovery_checkpoint(http).await {
                    Ok(()) => log_info!(LOG_TAG, "Recovery checkpoint created"),
                    Err(e) => log_warn!(LOG_TAG, "Recovery checkpoint skipped: {e}"),
                }
            }
        }

        log_info!(LOG_TAG, "▷ Cleanup");
        final_telemetry(telemetry).await;
    }

    exit_code
}

fn should_create_success_checkpoint(cli_exit_code: i32, exit_code: i32) -> bool {
    cli_exit_code == 0 && exit_code == 0
}

fn setup_working_dir(path: impl AsRef<Path>) -> std::io::Result<()> {
    let path = path.as_ref();
    std::fs::create_dir_all(path)?;
    std::env::set_current_dir(path)
}

/// Final telemetry upload — best-effort and logs on failure.
/// The complete API is called by the runner after VM exits, not by guest-agent.
async fn final_telemetry(telemetry: &Telemetry) {
    log_info!(LOG_TAG, "Performing final telemetry upload...");
    if telemetry.flush(UploadMode::Final).await.is_err() {
        log_error!(LOG_TAG, "Final telemetry upload failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::sync::LazyLock;

    static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static COMPLETE_EXECUTION_MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(MockServer::start);

    fn lock_test_state() -> std::sync::MutexGuard<'static, ()> {
        TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn test_http_client(server: &MockServer) -> HttpClient {
        HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO).unwrap()
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
        let diagnostic = cli_diagnostic("turn failed", FailureDetailSource::CodexJsonl);
        let msg = cli_failure_message(1, &stderr_lines, Some(&diagnostic));

        assert_eq!(msg.source, FailureDetailSource::Stderr);
        assert_eq!(msg.message, "specific stderr failure");
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
        let diagnostic =
            with_cli_failure_reason(diagnostic, msg.message.as_str(), msg.failure_reason);

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
    fn cli_failure_reason_prefers_message_classification_over_carried_reason() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("debug failure"),
        )
        .with_cli_exit_code(1);
        let diagnostic = with_cli_failure_reason(
            diagnostic,
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage.",
            Some(FailureReason::InvalidApiKey),
        );

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
        let unchanged = with_cli_failure_reason(
            diagnostic.clone(),
            "permission denied while running command",
            None,
        );

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
        let diagnostic = with_cli_failure_reason(
            diagnostic,
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage.",
            None,
        );

        assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
        assert_eq!(diagnostic.failure_reason, Some(FailureReason::UsageLimit));
        assert_eq!(
            diagnostic.failure_detail_source,
            Some(FailureDetailSource::CodexJsonl)
        );
    }

    #[test]
    fn is_claude_zero_turn_result_requires_all_guards() {
        let zero_turn = cli::CliExecutionResult {
            exit_code: 0,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: Some(cli::ClaudeResultSummary { num_turns: Some(0) }),
            failure_diagnostic: None,
        };
        let one_turn = cli::CliExecutionResult {
            claude_result: Some(cli::ClaudeResultSummary { num_turns: Some(1) }),
            ..zero_turn.clone()
        };
        let failed_zero_turn = cli::CliExecutionResult {
            exit_code: 1,
            ..zero_turn.clone()
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
    fn success_checkpoint_requires_cli_and_run_success() {
        assert!(should_create_success_checkpoint(0, 0));
        assert!(!should_create_success_checkpoint(0, 1));
        assert!(!should_create_success_checkpoint(1, 1));
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
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
        }

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

        final_telemetry(&telemetry).await;
        telemetry.shutdown().await;

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

    async fn complete_execution_writes_event_upload_failure_diagnostic_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var("VM0_PROMPT", "/event-upload-failure");
        }

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
        std::fs::write(paths::event_error_flag(), "").unwrap();

        let telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
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
            &http,
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
        telemetry_mock.assert_calls_async(1).await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_writes_checkpoint_failure_diagnostic_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var("VM0_PROMPT", "/checkpoint-failure");
        }

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

        let telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
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
            &http,
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
        telemetry_mock.assert_calls_async(1).await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_preserves_existing_failure_diagnostic_when_events_fail_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var("VM0_PROMPT", "plain prompt");
        }

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
        std::fs::write(paths::event_error_flag(), "").unwrap();

        let telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
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
            &http,
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
        telemetry_mock.assert_calls_async(1).await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_skips_recovery_checkpoint_for_no_history_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var("VM0_PROMPT", "/help");
        }

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
            &http,
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
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var("VM0_PROMPT", "plain prompt");
        }

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
        std::fs::write(paths::session_id_file(), "recovery-session-from-main").unwrap();
        std::fs::write(
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
        let telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let masker = Arc::new(masker::SecretMasker::from_env());
        let http = test_http_client(server);
        let telemetry = Telemetry::spawn(masker, http.clone());
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
            &http,
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
        telemetry_mock.assert_calls_async(1).await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
