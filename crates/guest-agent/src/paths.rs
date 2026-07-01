//! Guest filesystem paths and derived runtime-file paths.
//!
//! Naming conventions:
//! - "system log" = guest-agent's own stderr (matches TS `SYSTEM_LOG_FILE` and API `systemLog`)
//! - "agent log" = AI agent (Claude Code) stdout output
//! - "metrics" = periodic CPU/memory/disk snapshots
//! - "sandbox ops" = operation timing records (defined in guest-common, re-exported here)
//! - runtime-file paths are scoped to the current run ID

pub use api_contracts::generated::constants::runners::paths::{
    CANONICAL_GUEST_HOME_DIR, CANONICAL_WORKING_DIR,
};
use std::io;
use std::path::{Path, PathBuf};

/// Immutable run-scoped guest paths derived from one runtime directory.
#[derive(Clone, Debug)]
pub struct GuestPaths {
    runtime_dir: PathBuf,
    session_id_file: String,
    session_history_path_file: String,
    event_error_flag: String,
    checkpoint_error_file: String,
    final_session_history_identity_file: String,
    failure_diagnostic_file: String,
    system_log_file: String,
    agent_log_file: String,
    metrics_log_file: String,
    sandbox_ops_file: String,
    telemetry_system_log_pos_file: String,
    telemetry_metrics_pos_file: String,
    telemetry_sandbox_ops_pos_file: String,
}

impl GuestPaths {
    /// Build all run-scoped paths from an explicit runtime directory.
    pub fn from_runtime_dir(runtime_dir: impl Into<PathBuf>) -> Self {
        let runtime_dir = runtime_dir.into();
        Self {
            session_id_file: path_to_string(guest_contracts::runtime_paths::session_id_file(
                &runtime_dir,
            )),
            session_history_path_file: path_to_string(
                guest_contracts::runtime_paths::session_history_marker_file(&runtime_dir),
            ),
            event_error_flag: path_to_string(guest_contracts::runtime_paths::event_error_file(
                &runtime_dir,
            )),
            checkpoint_error_file: path_to_string(
                guest_contracts::runtime_paths::checkpoint_error_file(&runtime_dir),
            ),
            final_session_history_identity_file: path_to_string(
                guest_contracts::runtime_paths::final_session_history_identity_file(&runtime_dir),
            ),
            failure_diagnostic_file: path_to_string(
                guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir),
            ),
            system_log_file: path_to_string(guest_contracts::runtime_paths::system_log_file(
                &runtime_dir,
            )),
            agent_log_file: path_to_string(guest_contracts::runtime_paths::agent_log_file(
                &runtime_dir,
            )),
            metrics_log_file: path_to_string(guest_contracts::runtime_paths::metrics_log_file(
                &runtime_dir,
            )),
            sandbox_ops_file: path_to_string(guest_contracts::runtime_paths::sandbox_ops_log_file(
                &runtime_dir,
            )),
            telemetry_system_log_pos_file: path_to_string(
                guest_contracts::runtime_paths::telemetry_system_log_pos_file(&runtime_dir),
            ),
            telemetry_metrics_pos_file: path_to_string(
                guest_contracts::runtime_paths::telemetry_metrics_pos_file(&runtime_dir),
            ),
            telemetry_sandbox_ops_pos_file: path_to_string(
                guest_contracts::runtime_paths::telemetry_sandbox_ops_pos_file(&runtime_dir),
            ),
            runtime_dir,
        }
    }

    /// Build paths by resolving the current process runtime-dir contract.
    pub fn from_process_env(
        run_id: &str,
    ) -> Result<Self, guest_contracts::runtime_paths::RuntimePathError> {
        let runtime_dir = std::env::var_os(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self::from_captured_env(run_id, runtime_dir.as_deref(), home.as_deref())
    }

    /// Build paths from values captured during bootstrap without rereading env.
    pub fn from_captured_env(
        run_id: &str,
        runtime_dir: Option<&Path>,
        process_home: Option<&Path>,
    ) -> Result<Self, guest_contracts::runtime_paths::RuntimePathError> {
        resolve_run_dir_from_captured_env(run_id, runtime_dir, process_home)
            .map(Self::from_runtime_dir)
    }

    /// Build paths from a guest home and run id using the default layout.
    pub fn from_home(
        guest_home: impl AsRef<Path>,
        run_id: &str,
    ) -> Result<Self, guest_contracts::runtime_paths::RuntimePathError> {
        guest_contracts::runtime_paths::run_dir_for_home(guest_home, run_id)
            .map(Self::from_runtime_dir)
    }

    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    pub fn session_id_file(&self) -> &str {
        &self.session_id_file
    }

    pub fn session_history_path_file(&self) -> &str {
        &self.session_history_path_file
    }

    pub fn event_error_flag(&self) -> &str {
        &self.event_error_flag
    }

    pub fn checkpoint_error_file(&self) -> &str {
        &self.checkpoint_error_file
    }

    pub fn final_session_history_identity_file(&self) -> &str {
        &self.final_session_history_identity_file
    }

    pub fn failure_diagnostic_file(&self) -> &str {
        &self.failure_diagnostic_file
    }

    pub fn system_log_file(&self) -> &str {
        &self.system_log_file
    }

    pub fn agent_log_file(&self) -> &str {
        &self.agent_log_file
    }

    pub fn metrics_log_file(&self) -> &str {
        &self.metrics_log_file
    }

    pub fn sandbox_ops_file(&self) -> &str {
        &self.sandbox_ops_file
    }

    pub fn telemetry_system_log_pos_file(&self) -> &str {
        &self.telemetry_system_log_pos_file
    }

    pub fn telemetry_metrics_pos_file(&self) -> &str {
        &self.telemetry_metrics_pos_file
    }

    pub fn telemetry_sandbox_ops_pos_file(&self) -> &str {
        &self.telemetry_sandbox_ops_pos_file
    }
}

fn resolve_run_dir_from_captured_env(
    run_id: &str,
    runtime_dir: Option<&Path>,
    process_home: Option<&Path>,
) -> Result<PathBuf, guest_contracts::runtime_paths::RuntimePathError> {
    if let Some(runtime_dir) = runtime_dir {
        if !runtime_dir.is_absolute() {
            return Err(guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir);
        }
        return Ok(runtime_dir.to_path_buf());
    }

    let home = process_home
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or(guest_contracts::runtime_paths::RuntimePathError::MissingHome)?;
    guest_contracts::runtime_paths::run_dir_for_home(home, run_id)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

pub fn ensure_parent_dir(path: impl AsRef<Path>) -> io::Result<()> {
    guest_contracts::runtime_paths::ensure_parent_dir(path)
}

pub fn write_private(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    guest_contracts::runtime_paths::write_private(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_paths_derives_runtime_files_from_run_dir() {
        let runtime_dir = PathBuf::from("/tmp/vm0-run");
        let paths = GuestPaths::from_runtime_dir(runtime_dir.clone());

        assert_eq!(paths.runtime_dir(), runtime_dir.as_path());
        assert_eq!(
            paths.session_id_file(),
            guest_contracts::runtime_paths::session_id_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.session_history_path_file(),
            guest_contracts::runtime_paths::session_history_marker_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.event_error_flag(),
            guest_contracts::runtime_paths::event_error_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.checkpoint_error_file(),
            guest_contracts::runtime_paths::checkpoint_error_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.final_session_history_identity_file(),
            guest_contracts::runtime_paths::final_session_history_identity_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.failure_diagnostic_file(),
            guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.system_log_file(),
            guest_contracts::runtime_paths::system_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.agent_log_file(),
            guest_contracts::runtime_paths::agent_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.metrics_log_file(),
            guest_contracts::runtime_paths::metrics_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.sandbox_ops_file(),
            guest_contracts::runtime_paths::sandbox_ops_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.telemetry_system_log_pos_file(),
            guest_contracts::runtime_paths::telemetry_system_log_pos_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.telemetry_metrics_pos_file(),
            guest_contracts::runtime_paths::telemetry_metrics_pos_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.telemetry_sandbox_ops_pos_file(),
            guest_contracts::runtime_paths::telemetry_sandbox_ops_pos_file(&runtime_dir)
                .to_string_lossy()
        );
    }

    #[test]
    fn guest_paths_from_home_uses_default_runtime_layout() {
        let home = PathBuf::from("/home/vm0");
        let paths = GuestPaths::from_home(&home, "run-123").unwrap();
        let expected_runtime =
            guest_contracts::runtime_paths::run_dir_for_home(&home, "run-123").unwrap();

        assert_eq!(paths.runtime_dir(), expected_runtime.as_path());
        assert_eq!(
            paths.agent_log_file(),
            guest_contracts::runtime_paths::agent_log_file(&expected_runtime).to_string_lossy()
        );
    }

    #[test]
    fn guest_paths_from_captured_env_uses_absolute_runtime_dir() {
        let runtime_dir = PathBuf::from("/tmp/vm0-runtime");
        let paths = GuestPaths::from_captured_env("ignored/for-override", Some(&runtime_dir), None)
            .unwrap();

        assert_eq!(paths.runtime_dir(), runtime_dir.as_path());
    }

    #[test]
    fn guest_paths_from_captured_env_rejects_relative_runtime_dir() {
        let err = GuestPaths::from_captured_env(
            "run-123",
            Some(Path::new("relative-runtime")),
            Some(Path::new("/home/vm0")),
        )
        .unwrap_err();

        assert_eq!(
            err,
            guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir
        );
    }

    #[test]
    fn guest_paths_from_captured_env_falls_back_to_process_home() {
        let paths =
            GuestPaths::from_captured_env("run-123", None, Some(Path::new("/home/vm0"))).unwrap();
        let expected_runtime =
            guest_contracts::runtime_paths::run_dir_for_home("/home/vm0", "run-123").unwrap();

        assert_eq!(paths.runtime_dir(), expected_runtime.as_path());
    }

    #[test]
    fn guest_paths_from_captured_env_rejects_missing_process_home() {
        let err = GuestPaths::from_captured_env("run-123", None, Some(Path::new(""))).unwrap_err();

        assert_eq!(
            err,
            guest_contracts::runtime_paths::RuntimePathError::MissingHome
        );
    }
}
