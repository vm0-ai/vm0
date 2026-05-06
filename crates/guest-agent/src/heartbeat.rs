//! Heartbeat loop — periodic POST to the heartbeat endpoint.
//!
//! The first heartbeat is critical: if it fails, the returned future
//! resolves with an error, which the caller races against CLI execution
//! via `tokio::select!`.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::urls;
use guest_common::{log_error, log_info, log_warn};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Run the heartbeat loop. Returns when:
/// - The first heartbeat fails (returns `Err`)
/// - Consecutive heartbeat failures exceed `MAX_CONSECUTIVE_HEARTBEAT_FAILURES` (returns `Err`)
/// - The shutdown token is cancelled (returns `Ok(())`)
///
/// The caller should race this against CLI execution so that a network
/// failure terminates the run early.
pub async fn heartbeat_loop(
    http: HttpClient,
    shutdown: CancellationToken,
) -> Result<(), AgentError> {
    heartbeat_loop_with_interval(http, shutdown, constants::HEARTBEAT_INTERVAL_SECS).await
}

/// Like [`heartbeat_loop`] but with a configurable interval (for testing).
pub async fn heartbeat_loop_with_interval(
    http: HttpClient,
    shutdown: CancellationToken,
    interval_secs: u64,
) -> Result<(), AgentError> {
    // No API token → local/test mode; heartbeat has no server to reach.
    if !env::has_api() {
        shutdown.cancelled().await;
        return Ok(());
    }

    let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
    let mut is_first = true;
    let mut consecutive_failures: u32 = 0;

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = interval.tick() => {
                let payload = json!({ "runId": env::run_id() });
                match http.post_json(urls::heartbeat_url(), &payload, constants::HTTP_MAX_RETRIES).await {
                    Ok(_) => {
                        if is_first {
                            log_info!(LOG_TAG, "Heartbeat sent (initial)");
                        } else if consecutive_failures > 0 {
                            log_info!(LOG_TAG, "Heartbeat recovered after {consecutive_failures} failure(s)");
                        } else {
                            log_info!(LOG_TAG, "Heartbeat sent");
                        }
                        is_first = false;
                        consecutive_failures = 0;
                    }
                    Err(e) if is_first => {
                        log_error!(LOG_TAG, "Network connectivity check failed: {e}");
                        return Err(AgentError::Execution(format!(
                            "Network connectivity check failed - cannot reach API at {}",
                            urls::heartbeat_url()
                        )));
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        log_warn!(
                            LOG_TAG,
                            "Heartbeat failed ({consecutive_failures}/{}): {e}",
                            constants::MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
                        );
                        if consecutive_failures >= constants::MAX_CONSECUTIVE_HEARTBEAT_FAILURES {
                            return Err(AgentError::Execution(format!(
                                "Heartbeat failed {consecutive_failures} consecutive times, terminating",
                            )));
                        }
                    }
                }
            }
        }
    }
}
