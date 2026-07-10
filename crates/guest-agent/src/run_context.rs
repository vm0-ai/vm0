//! Explicit immutable guest-agent runtime state.

use crate::env::{GuestConfig, GuestConfigRaw};
use crate::http::HttpClient;
use crate::paths::GuestPaths;

/// Production runtime services for one guest-agent run.
#[derive(Clone)]
pub struct GuestRuntime {
    pub config: GuestConfig,
    pub paths: GuestPaths,
    pub http: HttpClient,
}

impl GuestRuntime {
    /// Build the ordinary production runtime from captured process startup state.
    ///
    /// Call this exactly once, after the runner or test has finished configuring
    /// the process environment. The method captures owned configuration inputs,
    /// derives immutable run paths from those captured values, installs those
    /// paths as the process-wide guest-common system-log and sandbox-ops sinks,
    /// and builds the run-scoped HTTP client.
    ///
    /// After successful bootstrap, pass this runtime or its owned fields through
    /// callers instead of rereading run-scoped process globals.
    ///
    /// # Errors
    ///
    /// Ordinary startup treats any error as terminal. Bootstrap can perform
    /// process-wide setup and consume runner-owned inputs before returning, so
    /// callers must not retry it in the same process.
    pub fn from_process_env() -> Result<Self, String> {
        let raw = GuestConfigRaw::from_process_env();
        raw.require_run_payload_file()?;
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
