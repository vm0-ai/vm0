//! Explicit immutable guest-agent runtime state.

use crate::env::{GuestConfig, GuestConfigRaw};
use crate::http::HttpClient;
use crate::paths::GuestPaths;
use crate::workload_containment::WorkloadContainment;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Clone, Copy)]
enum ProcessControlEnvSource {
    CanonicalOnly,
    LegacyOnly,
    Dual,
}

type ProcessControlEnvResolution = (Option<String>, Option<ProcessControlEnvSource>);

impl ProcessControlEnvSource {
    fn label(self) -> &'static str {
        match self {
            Self::CanonicalOnly => "canonical-only",
            Self::LegacyOnly => "legacy-only",
            Self::Dual => "dual",
        }
    }
}

/// Production runtime services for one guest-agent run.
#[derive(Clone)]
pub struct GuestRuntime {
    pub config: GuestConfig,
    pub paths: GuestPaths,
    pub http: HttpClient,
    pub workload_containment: Option<WorkloadContainment>,
    pub process_control_endpoint: Option<String>,
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
        let guest_runtime_dir =
            guest_contracts::runtime_paths::guest_runtime_dir_env_from_process_env()
                .map_err(|error| format!("failed to resolve guest runtime paths: {error}"))?;
        let (process_control_endpoint, process_control_source) =
            process_control_endpoint_from_process_env()?;
        let workload_containment =
            WorkloadContainment::from_process_env(process_control_endpoint.is_some())?;
        let raw = GuestConfigRaw::from_process_env_with_guest_runtime_dir(guest_runtime_dir)?;
        raw.require_run_payload_file()?;
        let paths = paths_from_raw(&raw)?;
        guest_common::log::set_system_log_file(paths.system_log_file());
        guest_common::telemetry::set_sandbox_ops_log_file(paths.sandbox_ops_file());
        if let Some(source) = process_control_source {
            guest_common::log_info!(
                LOG_TAG,
                "process_control_env_source key={} source={}",
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                source.label()
            );
        }
        if let Some(containment) = &workload_containment {
            for (key, source) in containment.env_source_evidence() {
                guest_common::log_info!(
                    LOG_TAG,
                    "cgroup_placement_env_source key={key} source={source}"
                );
            }
        }
        raw.emit_bootstrap_alias_source_events();

        let config = GuestConfig::from_raw(raw)?;
        let http = HttpClient::for_config(&config).map_err(|error| error.to_string())?;

        Ok(Self {
            config,
            paths,
            http,
            workload_containment,
            process_control_endpoint,
        })
    }
}

/// Resolve Stage 1 compatibility between an existing runner or sandbox and a
/// new guest reader. Existing instances can expose the legacy writer for the
/// two-hour guest runtime budget plus bounded finalization. #28914 owns the
/// later writer-cutover and reader-removal issues; remove the legacy branch
/// only after the reader floor, sandbox drain, rollback window, and
/// legacy-read-zero gates are complete.
fn process_control_endpoint_from_process_env() -> Result<ProcessControlEnvResolution, String> {
    let canonical = process_control_env_value(process_control_ipc::CANONICAL_BOOTSTRAP_ENV)?;
    let legacy = process_control_env_value(process_control_ipc::BOOTSTRAP_ENV)?;

    match (canonical, legacy) {
        (None, None) => Ok((None, None)),
        (Some(endpoint), None) => {
            Ok((Some(endpoint), Some(ProcessControlEnvSource::CanonicalOnly)))
        }
        (None, Some(endpoint)) => Ok((Some(endpoint), Some(ProcessControlEnvSource::LegacyOnly))),
        (Some(canonical), Some(legacy)) if canonical == legacy => {
            Ok((Some(canonical), Some(ProcessControlEnvSource::Dual)))
        }
        (Some(_), Some(_)) => Err(format!(
            "conflicting process control environment aliases: canonical_key={} legacy_key={} \
             state=conflict",
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            process_control_ipc::BOOTSTRAP_ENV
        )),
    }
}

fn process_control_env_value(key: &'static str) -> Result<Option<String>, String> {
    match std::env::var_os(key) {
        None => Ok(None),
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => value
            .into_string()
            .map(Some)
            .map_err(|_| format!("{key} must be valid UTF-8")),
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
