//! Explicit immutable guest-agent run context.

use crate::env::GuestConfig;
use crate::paths::GuestPaths;

/// Immutable config and derived paths for one guest-agent run.
#[derive(Clone)]
pub struct GuestContext {
    pub config: GuestConfig,
    pub paths: GuestPaths,
}

impl GuestContext {
    /// Build a run context from explicit config and paths.
    pub fn new(config: GuestConfig, paths: GuestPaths) -> Self {
        Self { config, paths }
    }

    /// Build a run context from the current process environment.
    pub fn from_process_env() -> Result<Self, String> {
        let config = GuestConfig::from_process_env()?;
        let paths = GuestPaths::from_process_env(&config.run_id)
            .map_err(|error| format!("failed to resolve guest runtime paths: {error}"))?;
        Ok(Self::new(config, paths))
    }
}
