//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! checkpoint creation inside a Firecracker VM.

mod artifact;
mod checkpoint;
mod cli;
mod constants;
mod env;
mod error;
mod events;
mod heartbeat;
mod http;
mod masker;
mod metrics;
mod paths;
mod telemetry;
mod urls;

use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

#[tokio::main]
async fn main() {
    let exit_code = run().await;
    std::process::exit(exit_code);
}

/// Top-level orchestrator. Returns exit code directly (never panics/errors out).
/// Cleanup (final telemetry + complete API) is guaranteed to run.
async fn run() -> i32 {
    // Record API-to-agent E2E time (as early as possible)
    let api_start = env::api_start_time();
    if !api_start.is_empty()
        && let Ok(api_ms) = api_start.parse::<u64>()
    {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let e2e = now_ms.saturating_sub(api_ms);
        record_sandbox_op("api_to_agent_start", Duration::from_millis(e2e), true, None);
        log_info!(LOG_TAG, "E2E time from API to agent start: {e2e}ms");
    }

    // Validate required env vars
    if env::working_dir().is_empty() {
        log_error!(LOG_TAG, "Fatal: VM0_WORKING_DIR is required but not set");
        let masker = masker::SecretMasker::from_env();
        log_info!(LOG_TAG, "▷ Cleanup");
        cleanup(&masker, 1, "VM0_WORKING_DIR is required but not set").await;
        log_info!(LOG_TAG, "Background processes stopped");
        log_info!(LOG_TAG, "✗ Sandbox failed (exit code 1)");
        return 1;
    }

    // Lifecycle: Header
    log_info!(LOG_TAG, "▶ VM0 Sandbox {}", env::run_id());

    // Lifecycle: Initialization
    log_info!(LOG_TAG, "▷ Initialization");

    let masker = Arc::new(masker::SecretMasker::from_env());
    let shutdown = CancellationToken::new();
    let start = Instant::now();

    log_info!(LOG_TAG, "Working directory: {}", env::working_dir());

    let t = Instant::now();
    let heartbeat_handle = tokio::spawn({
        let shutdown = shutdown.clone();
        async move { heartbeat::heartbeat_loop(shutdown).await }
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
    let telemetry_handle = tokio::spawn({
        let shutdown = shutdown.clone();
        let masker = masker.clone();
        async move { telemetry::telemetry_loop(shutdown, masker).await }
    });
    log_info!(LOG_TAG, "Telemetry upload started");
    record_sandbox_op("telemetry_upload_start", t.elapsed(), true, None);

    // Execute main logic (init + CLI + checkpoint)
    let (exit_code, error_message) = execute(&masker, start, heartbeat_handle).await;

    // Guaranteed cleanup: final telemetry + complete API
    log_info!(LOG_TAG, "▷ Cleanup");
    cleanup(&masker, exit_code, &error_message).await;

    // Stop all background processes (heartbeat, metrics, telemetry)
    shutdown.cancel();
    let _ = metrics_handle.await;
    let _ = telemetry_handle.await;
    log_info!(LOG_TAG, "Background processes stopped");

    if exit_code == 0 {
        log_info!(LOG_TAG, "✓ Sandbox finished successfully");
    } else {
        log_info!(LOG_TAG, "✗ Sandbox failed (exit code {exit_code})");
    }

    exit_code
}

/// Main execution logic: working dir, codex setup, CLI, checkpoint.
/// Returns `(exit_code, error_message)`.
async fn execute(
    masker: &masker::SecretMasker,
    start: Instant,
    heartbeat_handle: tokio::task::JoinHandle<Result<(), error::AgentError>>,
) -> (i32, String) {
    // Working directory setup
    let wd_start = Instant::now();
    if let Err(e) = std::fs::create_dir_all(env::working_dir())
        .and_then(|()| std::env::set_current_dir(env::working_dir()))
    {
        let msg = format!("Working dir setup failed: {e}");
        log_error!(LOG_TAG, "{msg}");
        record_sandbox_op("working_dir_setup", wd_start.elapsed(), false, Some(&msg));
        return (1, msg);
    }
    record_sandbox_op("working_dir_setup", wd_start.elapsed(), true, None);

    // Codex setup (sandbox op recorded inside setup_codex)
    if env::cli_agent_type() == "codex"
        && let Err(e) = cli::setup_codex()
    {
        log_error!(LOG_TAG, "Codex setup failed: {e}");
    }

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
    let (mut exit_code, mut error_message) = match cli::execute_cli(masker, heartbeat_handle).await
    {
        Ok((code, stderr_lines)) => {
            if code != 0 {
                let msg = if stderr_lines.is_empty() {
                    format!("Agent exited with code {code}")
                } else {
                    log_info!(LOG_TAG, "Captured {} stderr lines", stderr_lines.len());
                    stderr_lines.join(" ")
                };
                (code, msg)
            } else {
                (0, String::new())
            }
        }
        Err(e) => {
            let msg = e.to_string();
            log_error!(LOG_TAG, "CLI execution failed: {msg}");
            (1, msg)
        }
    };
    let cli_exit_code = exit_code;
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

    // Check if any events failed to send (before logging execution result)
    if std::path::Path::new(paths::event_error_flag()).exists() {
        log_error!(LOG_TAG, "Some events failed to send, marking run as failed");
        exit_code = 1;
        // Only override error_message when CLI itself succeeded (matching TS priority)
        if cli_exit_code == 0 {
            error_message = "Some events failed to send".to_string();
        }
    }

    if cli_exit_code == 0 && exit_code == 0 {
        log_info!(LOG_TAG, "✓ Execution complete ({}s)", cli_elapsed.as_secs());
    } else {
        log_info!(LOG_TAG, "✗ Execution failed ({}s)", cli_elapsed.as_secs());
    }

    // Checkpoint on success
    if cli_exit_code == 0 && exit_code == 0 {
        log_info!(LOG_TAG, "{} completed successfully", env::cli_agent_type());

        log_info!(LOG_TAG, "▷ Checkpoint");
        let cp_start = Instant::now();
        match checkpoint::create_checkpoint().await {
            Ok(()) => {
                log_info!(
                    LOG_TAG,
                    "✓ Checkpoint complete ({}s)",
                    cp_start.elapsed().as_secs()
                );
            }
            Err(e) => {
                log_error!(LOG_TAG, "Checkpoint failed: {e}");
                log_info!(
                    LOG_TAG,
                    "✗ Checkpoint failed ({}s)",
                    cp_start.elapsed().as_secs()
                );
                exit_code = 1;
                error_message = "Checkpoint creation failed".to_string();
            }
        }
    } else if cli_exit_code != 0 {
        log_info!(
            LOG_TAG,
            "{} failed with exit code {cli_exit_code}",
            env::cli_agent_type()
        );
    }

    (exit_code, error_message)
}

/// Cleanup that always runs: final telemetry upload and complete API call.
async fn cleanup(masker: &masker::SecretMasker, exit_code: i32, error_message: &str) {
    // Final telemetry upload
    let telemetry_start = Instant::now();
    let telemetry_ok = telemetry::final_upload(masker).await.is_ok();
    if !telemetry_ok {
        log_error!(LOG_TAG, "Final telemetry upload failed");
    }
    record_sandbox_op(
        "final_telemetry_upload",
        telemetry_start.elapsed(),
        telemetry_ok,
        None,
    );

    // Complete API call
    log_info!(LOG_TAG, "Calling complete API with exitCode={exit_code}");
    let complete_start = Instant::now();
    let mut payload = serde_json::json!({
        "runId": env::run_id(),
        "exitCode": exit_code,
    });
    if !error_message.is_empty()
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert(
            "error".to_string(),
            serde_json::Value::String(error_message.to_string()),
        );
    }
    let complete_ok = http::post_json(urls::complete_url(), &payload, constants::HTTP_MAX_RETRIES)
        .await
        .is_ok();
    if complete_ok {
        log_info!(LOG_TAG, "Complete API called successfully");
    } else {
        log_error!(
            LOG_TAG,
            "Failed to call complete API (sandbox may not be cleaned up)"
        );
    }
    record_sandbox_op(
        "complete_api_call",
        complete_start.elapsed(),
        complete_ok,
        None,
    );
}
