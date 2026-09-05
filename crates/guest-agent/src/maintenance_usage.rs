//! Content-free accounting from the private maintenance child, including failure.

use crate::{constants, error::AgentError, run_context::GuestRuntime};
use api_contracts::generated::types::webhooks::agent::pi_memory_phase2::usage::Request;
use std::path::Path;

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
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        // No provider response is incurred on the engine's early no-diff path.
        // Old commit-pinned CLIs can also omit it through queue residence, the
        // two-hour execution budget, and bounded finalization. Remove that
        // allowance under #31067 once old queued and active contexts drain.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(invalid_usage()),
    };
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return Err(invalid_usage());
    }
    let usage: Request = serde_json::from_slice(&std::fs::read(path).map_err(|_| invalid_usage())?)
        .map_err(|_| invalid_usage())?;
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
