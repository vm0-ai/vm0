//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! checkpoint creation inside a Firecracker VM.

use guest_agent::checkpoint;
use guest_agent::cli;
use guest_agent::complete;
use guest_agent::env;
use guest_agent::error;
use guest_agent::heartbeat;
use guest_agent::http::HttpClient;
use guest_agent::masker;
use guest_agent::metrics;
use guest_agent::paths;
use guest_agent::telemetry::{Telemetry, UploadMode};

use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info};
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

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
    let mut last_event_sequence = None;
    let (mut exit_code, error_message) =
        match cli::execute_cli(masker, heartbeat_handle, http.clone()).await {
            Ok(cli_result) => {
                last_event_sequence = cli_result.last_event_sequence;
                let code = cli_result.exit_code;
                if code != 0 {
                    let msg = if cli_result.stderr_lines.is_empty() {
                        format!("Agent exited with code {code}")
                    } else {
                        log_info!(
                            LOG_TAG,
                            "Captured {} stderr lines",
                            cli_result.stderr_lines.len()
                        );
                        cli_result.stderr_lines.join(" ")
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

    // Checkpoint on success (skip when no API — local/test mode). The
    // pre-checkpoint flush runs in `tokio::join!` with the snapshot work so
    // its ~1s upload overlaps the ~4s checkpoint. The post-checkpoint flush
    // catches records checkpoint itself wrote (`session_id_read`, VAS
    // snapshot timings, `checkpoint_total`, etc.) and is the EOF-consuming
    // final pass. Both go through the single-writer uploader, so the two
    // flushes never race the periodic tick on the pos files.
    if cli_exit_code == 0 && exit_code == 0 && env::has_api() {
        log_info!(LOG_TAG, "claude-code completed successfully");

        log_info!(LOG_TAG, "▷ Checkpoint");
        let cp_start = Instant::now();
        let (cp_result, _) = tokio::join!(
            checkpoint::create_checkpoint(&http),
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
                    &http,
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
            log_info!(LOG_TAG, "claude-code completed successfully");
        } else if cli_exit_code != 0 {
            log_info!(LOG_TAG, "claude-code failed with exit code {cli_exit_code}");
        }
        log_info!(LOG_TAG, "▷ Cleanup");
        final_telemetry(telemetry).await;
    }

    exit_code
}

/// Final telemetry upload — records timing and logs on failure.
/// The complete API is called by the runner after VM exits, not by guest-agent.
async fn final_telemetry(telemetry: &Telemetry) {
    log_info!(LOG_TAG, "Performing final telemetry upload...");
    let telemetry_start = Instant::now();
    let telemetry_ok = telemetry.flush(UploadMode::Final).await.is_ok();
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
