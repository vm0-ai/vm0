//! Heartbeat loop — periodic POST to the heartbeat endpoint.
//!
//! The first heartbeat is critical: if it fails, the returned future
//! resolves with an error, which the caller races against CLI execution
//! via `tokio::select!`.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http;
use crate::urls;
use guest_common::{log_error, log_info, log_warn};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Run the heartbeat loop. Returns when:
/// - The first heartbeat fails (returns `Err`)
/// - The shutdown token is cancelled (returns `Ok(())`)
///
/// The caller should race this against CLI execution so that a network
/// failure terminates the run early.
pub async fn heartbeat_loop(shutdown: CancellationToken) -> Result<(), AgentError> {
    let mut interval =
        tokio::time::interval(Duration::from_secs(constants::HEARTBEAT_INTERVAL_SECS));
    let mut is_first = true;

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = interval.tick() => {
                let payload = json!({ "runId": env::run_id() });
                match http::post_json(urls::heartbeat_url(), &payload, constants::HTTP_MAX_RETRIES).await {
                    Ok(_) => {
                        if is_first {
                            log_info!(LOG_TAG, "Heartbeat sent (initial)");
                        } else {
                            log_info!(LOG_TAG, "Heartbeat sent");
                        }
                        is_first = false;
                    }
                    Err(e) if is_first => {
                        log_error!(LOG_TAG, "Network connectivity check failed: {e}");
                        return Err(AgentError::Execution(format!(
                            "Network connectivity check failed - cannot reach API at {}",
                            urls::heartbeat_url()
                        )));
                    }
                    Err(e) => {
                        log_warn!(LOG_TAG, "Heartbeat failed: {e}");
                    }
                }
            }
        }
    }
}
