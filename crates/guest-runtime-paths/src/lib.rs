//! Shared guest runtime path contract.

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

pub const GUEST_RUNTIME_DIR_ENV: &str = "VM0_GUEST_RUNTIME_DIR";
const DEFAULT_RUNTIME_PARENT: &str = ".vm0/guest-agent/runs";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePathError {
    MissingRunId,
    InvalidRunId,
    MissingHome,
    InvalidRuntimeDir,
}

impl std::fmt::Display for RuntimePathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingRunId => f.write_str("VM0_RUN_ID is required for guest runtime paths"),
            Self::InvalidRunId => f.write_str("VM0_RUN_ID must be a single safe path segment"),
            Self::MissingHome => f.write_str("HOME is required for guest runtime paths"),
            Self::InvalidRuntimeDir => {
                f.write_str("VM0_GUEST_RUNTIME_DIR must be an absolute path")
            }
        }
    }
}

impl std::error::Error for RuntimePathError {}

fn is_safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id != "."
        && run_id != ".."
        && !run_id.contains('/')
        && !run_id.contains('\\')
        && !run_id.contains('\0')
}

pub fn validate_run_id(run_id: &str) -> Result<(), RuntimePathError> {
    if run_id.is_empty() {
        return Err(RuntimePathError::MissingRunId);
    }
    if !is_safe_run_id(run_id) {
        return Err(RuntimePathError::InvalidRunId);
    }
    Ok(())
}

pub fn run_dir_for_home(
    guest_home: impl AsRef<Path>,
    run_id: &str,
) -> Result<PathBuf, RuntimePathError> {
    validate_run_id(run_id)?;
    Ok(guest_home
        .as_ref()
        .join(DEFAULT_RUNTIME_PARENT)
        .join(run_id))
}

pub fn run_dir_from_env(run_id: &str) -> Result<PathBuf, RuntimePathError> {
    if let Some(path) = env::var_os(GUEST_RUNTIME_DIR_ENV)
        && !path.is_empty()
    {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(RuntimePathError::InvalidRuntimeDir);
        }
        return Ok(path);
    }

    let home = env::var_os("HOME").ok_or(RuntimePathError::MissingHome)?;
    if home.is_empty() {
        return Err(RuntimePathError::MissingHome);
    }
    run_dir_for_home(home, run_id)
}

fn file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join(name)
}

fn log_file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join("logs").join(name)
}

fn telemetry_file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join("telemetry").join(name)
}

pub fn session_id_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "session-id")
}

pub fn session_history_marker_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "session-history-marker")
}

pub fn event_error_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "event-error")
}

pub fn checkpoint_error_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "checkpoint-error")
}

pub fn failure_diagnostic_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "failure-diagnostic.json")
}

pub fn system_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "system.log")
}

pub fn agent_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "agent.jsonl")
}

pub fn metrics_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "metrics.jsonl")
}

pub fn sandbox_ops_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "sandbox-ops.jsonl")
}

pub fn telemetry_system_log_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "system-log.pos")
}

pub fn telemetry_metrics_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "metrics.pos")
}

pub fn telemetry_sandbox_ops_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "sandbox-ops.pos")
}

#[cfg(unix)]
fn set_dir_private(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_dir_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn ensure_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    #[cfg(unix)]
    {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(path)?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)?;
    }
    set_dir_private(path)
}

pub fn ensure_parent_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("runtime path has no parent: {}", path.display()),
        )
    })?;
    ensure_dir(parent)
}

#[cfg(unix)]
fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    options
}

#[cfg(not(unix))]
fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    options
}

#[cfg(unix)]
fn set_file_private(file: &File) -> io::Result<()> {
    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_file_private(_file: &File) -> io::Result<()> {
    Ok(())
}

pub fn create_private(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_parent_dir(path)?;
    let file = private_file_options().open(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("open runtime file {}: {e}", path.display()),
        )
    })?;
    set_file_private(&file)?;
    Ok(file)
}

pub fn write_private(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    let mut file = create_private(path)?;
    std::io::Write::write_all(&mut file, bytes.as_ref())
}

#[cfg(unix)]
fn private_append_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    options
}

#[cfg(not(unix))]
fn private_append_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    options
}

pub fn open_private_append(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_parent_dir(path)?;
    let file = private_append_options().open(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("open runtime file {}: {e}", path.display()),
        )
    })?;
    set_file_private(&file)?;
    Ok(file)
}

#[cfg(test)]
fn path_is_under(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_paths_are_not_under_tmp() {
        let run_dir =
            run_dir_for_home("/home/user", "00000000-0000-0000-0000-000000000001").unwrap();
        let files = [
            session_id_file(&run_dir),
            session_history_marker_file(&run_dir),
            event_error_file(&run_dir),
            checkpoint_error_file(&run_dir),
            failure_diagnostic_file(&run_dir),
            system_log_file(&run_dir),
            agent_log_file(&run_dir),
            metrics_log_file(&run_dir),
            sandbox_ops_log_file(&run_dir),
            telemetry_system_log_pos_file(&run_dir),
            telemetry_metrics_pos_file(&run_dir),
            telemetry_sandbox_ops_pos_file(&run_dir),
        ];

        for path in files {
            assert!(!path_is_under(&path, Path::new("/tmp")));
            assert!(path.starts_with("/home/user/.vm0/guest-agent/runs/"));
        }
    }

    #[test]
    fn rejects_unsafe_run_id_segments() {
        for run_id in ["", ".", "..", "a/b", "a\\b", "a\0b"] {
            assert!(run_dir_for_home("/home/user", run_id).is_err());
        }
    }

    #[test]
    fn env_runtime_dir_wins_without_run_id_segment() {
        let temp = tempfile::tempdir().unwrap();
        unsafe {
            env::set_var(GUEST_RUNTIME_DIR_ENV, temp.path());
        }

        let dir = run_dir_from_env("not/validated/when/env/is/set").unwrap();

        assert_eq!(dir, temp.path());
        unsafe {
            env::remove_var(GUEST_RUNTIME_DIR_ENV);
        }
    }

    #[test]
    fn write_private_creates_private_parent_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/logs/system.log");

        write_private(&path, b"hello").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn create_private_truncates_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/logs/agent.jsonl");
        write_private(&path, b"stale content").unwrap();

        let mut file = create_private(&path).unwrap();
        std::io::Write::write_all(&mut file, b"fresh").unwrap();
        drop(file);

        assert_eq!(fs::read(&path).unwrap(), b"fresh");
    }

    #[cfg(unix)]
    #[test]
    fn private_file_opens_reject_final_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("run/logs/system.log");
        ensure_parent_dir(&link).unwrap();
        std::fs::write(&target, b"target must survive").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(create_private(&link).is_err());
        assert!(open_private_append(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target must survive");
    }
}
