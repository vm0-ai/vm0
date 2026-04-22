//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! checkpoint creation inside a Firecracker VM.

use guest_agent::checkpoint;
use guest_agent::cli;
use guest_agent::env;
use guest_agent::error;
use guest_agent::heartbeat;
use guest_agent::masker;
use guest_agent::metrics;
use guest_agent::paths;
use guest_agent::telemetry;

use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info};
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

#[tokio::main]
async fn main() {
    let exit_code = run().await;
    std::process::exit(exit_code);
}

/// Top-level orchestrator. Returns exit code directly (never panics/errors out).
/// Final telemetry upload is guaranteed to run on every code path.
async fn run() -> i32 {
    // Record API-to-agent E2E time (as early as possible)
    guest_agent::timing::record_e2e_from_api("api_to_agent_start");

    // Validate required env vars
    if env::working_dir().is_empty() {
        log_error!(LOG_TAG, "Fatal: VM0_WORKING_DIR is required but not set");
        let masker = masker::SecretMasker::from_env();
        log_info!(LOG_TAG, "▷ Cleanup");
        final_telemetry(&masker).await;
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

    // Execute main logic (init + CLI + checkpoint + final telemetry).
    // `execute` owns the final telemetry upload — on the success path it's run
    // in parallel with `checkpoint` so the ~1s upload doesn't serialize behind
    // the ~4s snapshot work.
    let exit_code = execute(&masker, start, heartbeat_handle).await;

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

/// Main execution logic: working dir, CLI, checkpoint, and final telemetry
/// upload (parallel with checkpoint on the success path; serial otherwise).
async fn execute(
    masker: &masker::SecretMasker,
    start: Instant,
    heartbeat_handle: tokio::task::JoinHandle<Result<(), error::AgentError>>,
) -> i32 {
    // Pre-warm kernel DNS cache for the CLI's API endpoint.
    // Fire-and-forget: runs in background so the cache is populated by the
    // time the CLI spawns and makes its first HTTPS request.
    tokio::spawn(async move {
        let _ = tokio::net::lookup_host("api.anthropic.com:443").await;
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

    // Memory is now mounted directly at the Claude Code auto-memory path via
    // manifest.artifacts[] — no runtime symlink needed (see #10602).

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
    let (mut exit_code, error_message) = match cli::execute_cli(masker, heartbeat_handle).await {
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
    }

    if cli_exit_code == 0 && exit_code == 0 {
        log_info!(LOG_TAG, "✓ Execution complete ({}s)", cli_elapsed.as_secs());
    } else {
        log_info!(LOG_TAG, "✗ Execution failed ({}s)", cli_elapsed.as_secs());
    }

    // Checkpoint on success (skip when no API — local/test mode). The final
    // telemetry upload runs in two phases to keep the operator-visible log
    // output identical to the pre-parallelization sequence while still
    // overlapping the ~1s upload with checkpoint:
    //   1. A silent first pass inside `tokio::join!` drains the pre-checkpoint
    //      sandbox_ops under cover of `checkpoint::create_checkpoint` — no
    //      log banner, no error log, no `record_sandbox_op`. On failure,
    //      position tracking doesn't advance so the catch-up re-reads the
    //      same delta.
    //   2. After checkpoint completes, `final_telemetry` runs serially as
    //      the pre-parallelization "cleanup" step — it emits the `▷ Cleanup`
    //      lifecycle banner, the `"Performing final telemetry upload..."`
    //      log inside `final_upload`, the failure log on error, and records
    //      the `final_telemetry_upload` sandbox op.
    // The catch-up step also captures records checkpoint wrote after the
    // parallel pass snapshotted the file (`session_id_read`, VAS snapshot
    // timings, `checkpoint_total`, etc) — `telemetry_loop` breaks on
    // shutdown without a final flush, so without this serial pass those
    // records would never reach the server.
    if cli_exit_code == 0 && exit_code == 0 && env::has_api() {
        log_info!(LOG_TAG, "claude-code completed successfully");

        log_info!(LOG_TAG, "▷ Checkpoint");
        let cp_start = Instant::now();
        let (cp_result, _) = tokio::join!(
            checkpoint::create_checkpoint(),
            telemetry::final_upload_silent(masker),
        );
        match cp_result {
            Ok(()) => {
                log_info!(
                    LOG_TAG,
                    "✓ Checkpoint complete ({}s)",
                    cp_start.elapsed().as_secs()
                );
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
            }
        }

        log_info!(LOG_TAG, "▷ Cleanup");
        final_telemetry(masker).await;
    } else {
        if cli_exit_code == 0 && exit_code == 0 {
            log_info!(LOG_TAG, "claude-code completed successfully");
        } else if cli_exit_code != 0 {
            log_info!(LOG_TAG, "claude-code failed with exit code {cli_exit_code}");
        }
        log_info!(LOG_TAG, "▷ Cleanup");
        final_telemetry(masker).await;
    }

    exit_code
}

/// Final telemetry upload — records timing and logs on failure.
/// The complete API is called by the runner after VM exits, not by guest-agent.
async fn final_telemetry(masker: &masker::SecretMasker) {
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
}
