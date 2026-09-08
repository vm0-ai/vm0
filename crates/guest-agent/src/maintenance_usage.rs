//! Content-free accounting from the private maintenance child, including failure.

use crate::{constants, error::AgentError, run_context::GuestRuntime};
use api_contracts::generated::types::webhooks::agent::pi_memory_phase2::usage::Request;
use std::path::Path;

const MAX_MAINTENANCE_USAGE_BYTES: usize = 256 * 1024;

fn invalid_usage() -> AgentError {
    AgentError::Execution("Invalid private maintenance usage".into())
}

/// Forward the child's bounded private usage journal before terminal reporting.
/// The API binds it to the immutable callback and deduplicates each attempt.
pub async fn report_for_runtime(runtime: &GuestRuntime) -> Result<(), AgentError> {
    if !matches!(runtime.config.framework, crate::env::Framework::Pi)
        || runtime.config.pi_launch_config.is_empty()
        || !runtime.http.has_api()
    {
        return Ok(());
    }
    let launch: serde_json::Value =
        serde_json::from_str(&runtime.config.pi_launch_config).map_err(|_| invalid_usage())?;
    if launch.get("maintenance").is_none() {
        return Ok(());
    }
    let path =
        Path::new(runtime.paths.pi_launch_payload_file()).with_file_name("maintenance-usage.json");
    let bytes = match guest_contracts::runtime_paths::read_private_bounded(
        path,
        MAX_MAINTENANCE_USAGE_BYTES,
    ) {
        Ok(Some(bytes)) => bytes,
        // No provider response is incurred on the engine's early no-diff path.
        // Old commit-pinned CLIs can also omit it through queue residence, the
        // two-hour execution budget, and bounded finalization. Remove that
        // allowance under #31067 once old queued and active contexts drain.
        Ok(None) => return Ok(()),
        Err(_) => return Err(invalid_usage()),
    };
    let usage: Request = serde_json::from_slice(&bytes).map_err(|_| invalid_usage())?;
    if usage.run_id != runtime.config.run_id
        || usage.attempts.is_empty()
        || usage.attempts.len() > 256
    {
        return Err(invalid_usage());
    }
    runtime
        .http
        .post_json(
            runtime.http.maintenance_usage_url()?,
            &usage,
            constants::HTTP_MAX_ATTEMPTS,
        )
        .await?;
    Ok(())
}
