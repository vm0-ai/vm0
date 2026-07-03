//! Explicit immutable guest-agent run context.

use crate::env::{GuestConfig, GuestConfigRaw};
use crate::http::HttpClient;
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
        let raw = GuestConfigRaw::from_process_env();
        let paths = paths_from_raw(&raw)?;
        let config = GuestConfig::from_raw(raw)?;
        Ok(Self::new(config, paths))
    }
}

/// Production runtime services for one guest-agent run.
#[derive(Clone)]
pub struct GuestRuntime {
    pub config: GuestConfig,
    pub paths: GuestPaths,
    pub http: HttpClient,
}

impl GuestRuntime {
    /// Build the production runtime from one raw process environment snapshot.
    pub fn from_process_env() -> Result<Self, String> {
        let raw = GuestConfigRaw::from_process_env();
        let paths = paths_from_raw(&raw)?;
        guest_common::log::set_system_log_file(paths.system_log_file());
        guest_common::telemetry::set_sandbox_ops_log_file(paths.sandbox_ops_file());

        let config = GuestConfig::from_raw(raw)?;
        let http = HttpClient::for_config(&config).map_err(|error| error.to_string())?;

        Ok(Self {
            config,
            paths,
            http,
        })
    }
}

fn paths_from_raw(raw: &GuestConfigRaw) -> Result<GuestPaths, String> {
    GuestPaths::from_captured_env(
        &raw.run_id,
        raw.guest_runtime_dir.as_deref(),
        raw.runtime_home
            .as_deref()
            .or_else(|| raw.home.as_deref().map(std::path::Path::new)),
    )
    .map_err(|error| format!("failed to resolve guest runtime paths: {error}"))
}
