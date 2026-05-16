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

    // Validate required env vars
    if env::working_dir().is_empty() {
        log_error!(LOG_TAG, "Fatal: VM0_WORKING_DIR is required but not set");
        let masker = Arc::new(masker::SecretMasker::from_env());
        let telemetry = match HttpClient::for_current_env() {
            Ok(http) => Some(Telemetry::spawn(masker, http)),
            Err(e) => {
                log_error!(LOG_TAG, "Final telemetry unavailable: {e}");
                None
            }
        };
        log_info!(LOG_TAG, "▷ Cleanup");
        if let Some(telemetry) = telemetry {
            final_telemetry(&telemetry).await;
            telemetry.shutdown().await;
        }
        log_info!(LOG_TAG, "Background processes stopped");
        log_info!(LOG_TAG, "✗ Sandbox failed (exit code 1)");
        return 1;
    }

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

    log_info!(LOG_TAG, "Working directory: {}", env::working_dir());

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
    if let Err(e) = std::fs::create_dir_all(env::working_dir())
        .and_then(|()| std::env::set_current_dir(env::working_dir()))
    {
        let msg = format!("Working dir setup failed: {e}");
        log_error!(LOG_TAG, "{msg}");
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
    let (cli_exit_code, exit_code, error_message, skip_recovery_checkpoint_for_no_history) =
        match cli::execute_cli(masker, heartbeat_handle, http.clone()).await {
            Ok(cli_result) => {
                last_event_sequence = cli_result.last_event_sequence;
                let cli_exit_code = cli_result.exit_code;
                if cli_exit_code != 0 {
                    (
                        cli_exit_code,
                        cli_exit_code,
                        cli_failure_message(cli_exit_code, &cli_result.stderr_lines),
                        false,
                    )
                } else if env::has_api()
                    && is_claude_zero_turn_result(env::Framework::from_env(), &cli_result)
                {
                    let history_check_start = Instant::now();
                    if claude_history_target_unavailable() {
                        let msg = "Claude Code emitted a zero-turn result without creating session history; skipping checkpoint";
                        record_sandbox_op(
                            "session_history_available",
                            history_check_start.elapsed(),
                            false,
                            Some(msg),
                        );
                        log_info!(LOG_TAG, "{msg}");
                        let _ = std::fs::write(paths::checkpoint_error_file(), msg);
                        (cli_exit_code, 1, msg.to_string(), true)
                    } else {
                        (0, 0, String::new(), false)
                    }
                } else {
                    (0, 0, String::new(), false)
                }
            }
            Err(e) => {
                let msg = e.to_string();
                log_error!(LOG_TAG, "CLI execution failed: {msg}");
                (1, 1, msg, false)
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
        last_event_sequence,
        skip_recovery_checkpoint_for_no_history,
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

fn claude_history_target_unavailable() -> bool {
    let raw = match std::fs::read_to_string(paths::session_history_path_file()) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    let target = raw.trim();
    if target.is_empty() {
        return true;
    }
    history_target_unavailable(Path::new(target))
}

fn history_target_unavailable(path: &Path) -> bool {
    match path.metadata() {
        Ok(metadata) => metadata.is_file() && metadata.len() == 0,
        Err(e) if e.kind() == ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

fn cli_failure_message(code: i32, stderr_lines: &[String]) -> String {
    if stderr_lines.is_empty() {
        return format!("Agent exited with code {code}");
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
    message_lines.join(" ")
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

async fn complete_execution(
    cli_exit_code: i32,
    mut exit_code: i32,
    cli_elapsed: Duration,
    last_event_sequence: Option<u32>,
    skip_recovery_checkpoint_for_no_history: bool,
    telemetry: &Telemetry,
    http: &HttpClient,
) -> i32 {
    // Check if any events failed to send (before logging execution result)
    if std::path::Path::new(paths::event_error_flag()).exists() {
        log_error!(LOG_TAG, "Some events failed to send, marking run as failed");
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
    if should_create_success_checkpoint(cli_exit_code, exit_code) && env::has_api() {
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
                    last_event_sequence,
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
                let _ = std::fs::write(paths::checkpoint_error_file(), &msg);
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
        } else if skip_recovery_checkpoint_for_no_history {
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

        if env::has_api() {
            if skip_recovery_checkpoint_for_no_history {
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
        let msg = cli_failure_message(1, &stderr_lines);
        assert!(
            !msg.contains("prefix line"),
            "returned error message should omit older stderr lines"
        );
        assert!(
            msg.contains("codex stderr includes ***"),
            "returned error message should preserve stderr"
        );
        assert!(
            msg.contains("...[truncated]"),
            "returned error message should truncate long stderr lines"
        );
        assert!(
            !msg.contains("tail"),
            "returned error message should not include bytes after the truncation boundary"
        );
        assert!(
            msg.contains("...[omitted 2 earlier stderr line(s)]"),
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

        let msg = cli_failure_message(1, &stderr_lines);
        assert!(
            msg.contains(&exact_limit_line),
            "returned error message should preserve line at exact size limit"
        );
        assert!(
            !msg.contains("...[truncated]"),
            "returned error message should not truncate line at exact size limit"
        );
        assert!(
            !msg.contains("omitted"),
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
        let msg = cli_failure_message(1, &[stderr_line]);

        assert!(
            msg.contains(&prefix),
            "returned error message should preserve bytes before the truncation boundary"
        );
        assert!(
            msg.contains("...[truncated]"),
            "returned error message should indicate truncation"
        );
        assert!(
            !msg.contains("é-tail"),
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
    fn is_claude_zero_turn_result_requires_all_guards() {
        let zero_turn = cli::CliExecutionResult {
            exit_code: 0,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: Some(cli::ClaudeResultSummary { num_turns: Some(0) }),
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
        let http = HttpClient::new().unwrap();
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

    async fn complete_execution_skips_recovery_checkpoint_for_no_history_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
            std::env::set_var("VM0_API_TOKEN", "test-token");
            std::env::set_var("VM0_RUN_ID", "main-recovery-checkpoint");
            std::env::set_var("VM0_WORKING_DIR", "/tmp/main-recovery-checkpoint");
        }

        let cleanup_paths = [
            paths::checkpoint_error_file().to_string(),
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
        let http = HttpClient::new().unwrap();
        let telemetry = Telemetry::spawn(masker, http.clone());
        let exit_code =
            complete_execution(0, 1, Duration::ZERO, None, true, &telemetry, &http).await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
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
            std::env::set_var("VM0_WORKING_DIR", "/tmp/main-recovery-checkpoint");
        }

        let cleanup_paths = [
            paths::session_id_file().to_string(),
            paths::session_history_path_file().to_string(),
            paths::checkpoint_error_file().to_string(),
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
        let http = HttpClient::new().unwrap();
        let telemetry = Telemetry::spawn(masker, http.clone());
        let exit_code =
            complete_execution(1, 1, Duration::ZERO, None, false, &telemetry, &http).await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        assert!(
            !std::path::Path::new(paths::checkpoint_error_file()).exists(),
            "recovery checkpoint failure must not write the success-path checkpoint error file"
        );
        prepare_mock.assert_calls_async(1).await;
        upload_mock.assert_calls_async(1).await;
        checkpoint_mock.assert_calls_async(1).await;
        telemetry_mock.assert_calls_async(1).await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
