use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

use super::target::RunnerServiceUnit;
use super::unit_file::{cleanup_unit_staging_files, write_unit_file};

const RUNTIME_SYSTEMD_SYSTEM_DIR: &str = "/run/systemd/system";
const DRAIN_DROP_IN_FILE_NAME: &str = "50-vm0-drain.conf";
const DRAIN_DROP_IN_CONTENT: &str = "[Service]\nRestart=no\n";

pub(super) fn write_drain_restart_override(unit: &RunnerServiceUnit) -> RunnerResult<()> {
    write_drain_restart_override_at(Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR), unit)
}

/// Returns whether cleanup found state that warrants reloading systemd.
pub(super) fn remove_drain_restart_override(unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    remove_drain_restart_override_at(Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR), unit)
}

pub(super) fn drain_restart_override_path(unit: &RunnerServiceUnit) -> PathBuf {
    drain_restart_override_path_at(Path::new(RUNTIME_SYSTEMD_SYSTEM_DIR), unit)
}

fn drain_restart_override_dir_at(root: &Path, unit: &RunnerServiceUnit) -> PathBuf {
    root.join(format!("{}.d", unit.service_name()))
}

fn drain_restart_override_path_at(root: &Path, unit: &RunnerServiceUnit) -> PathBuf {
    drain_restart_override_dir_at(root, unit).join(DRAIN_DROP_IN_FILE_NAME)
}

fn write_drain_restart_override_at(root: &Path, unit: &RunnerServiceUnit) -> RunnerResult<()> {
    let dir = drain_restart_override_dir_at(root, unit);
    std::fs::create_dir_all(&dir).map_err(|e| {
        RunnerError::Internal(format!(
            "create drain restart override directory {}: {e}",
            dir.display()
        ))
    })?;
    let path = drain_restart_override_path_at(root, unit);
    cleanup_unit_staging_files(&path)?;
    write_unit_file(&path, DRAIN_DROP_IN_CONTENT)
}

fn remove_drain_restart_override_at(root: &Path, unit: &RunnerServiceUnit) -> RunnerResult<bool> {
    let path = drain_restart_override_path_at(root, unit);
    cleanup_unit_staging_files(&path)?;

    let mut changed = match std::fs::remove_file(&path) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => false,
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "remove drain restart override {}: {e}",
                path.display()
            )));
        }
    };

    let dir = drain_restart_override_dir_at(root, unit);
    match std::fs::remove_dir(&dir) {
        Ok(()) => changed = true,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty) => {}
        Err(e) => {
            warn!(
                directory = %dir.display(),
                error = %e,
                "failed to remove empty drain restart override directory"
            );
        }
    }

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    #[test]
    fn override_path_is_derived_from_service_name() {
        let dir = tempfile::tempdir().unwrap();
        let unit = RunnerServiceUnit::from_suffix("v1.2.3").unwrap();

        assert_eq!(
            drain_restart_override_path_at(dir.path(), &unit),
            dir.path()
                .join("vm0-runner-v1.2.3.service.d")
                .join(DRAIN_DROP_IN_FILE_NAME)
        );
    }

    #[test]
    fn write_creates_fixed_drop_in() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let path = drain_restart_override_path_at(dir.path(), &unit);

        write_drain_restart_override_at(dir.path(), &unit).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            DRAIN_DROP_IN_CONTENT
        );
    }

    #[test]
    fn repeated_writes_overwrite_same_drop_in() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        let path = drain_restart_override_path_at(dir.path(), &unit);

        write_drain_restart_override_at(dir.path(), &unit).unwrap();
        std::fs::write(&path, "old content").unwrap();
        write_drain_restart_override_at(dir.path(), &unit).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            DRAIN_DROP_IN_CONTENT
        );
        let entries: Vec<_> = std::fs::read_dir(&drop_in_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![DRAIN_DROP_IN_FILE_NAME]);
    }

    #[test]
    fn remove_ignores_missing_drop_in() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();

        assert!(!remove_drain_restart_override_at(dir.path(), &unit).unwrap());
    }

    #[test]
    fn remove_reports_change_when_empty_directory_is_cleaned() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        std::fs::create_dir(&drop_in_dir).unwrap();

        assert!(remove_drain_restart_override_at(dir.path(), &unit).unwrap());

        assert!(!drop_in_dir.exists());
    }

    #[test]
    fn remove_deletes_empty_drop_in_directory() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);

        write_drain_restart_override_at(dir.path(), &unit).unwrap();
        assert!(remove_drain_restart_override_at(dir.path(), &unit).unwrap());

        assert!(!drop_in_dir.exists());
    }

    #[test]
    fn remove_preserves_nonempty_drop_in_directory() {
        let dir = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        let other = drop_in_dir.join("90-operator.conf");

        write_drain_restart_override_at(dir.path(), &unit).unwrap();
        std::fs::write(&other, "[Service]\nEnvironment=EXTRA=1\n").unwrap();
        assert!(remove_drain_restart_override_at(dir.path(), &unit).unwrap());

        assert!(drop_in_dir.exists());
        assert!(other.exists());
        assert!(!drain_restart_override_path_at(dir.path(), &unit).exists());
    }

    #[cfg(unix)]
    #[test]
    fn remove_reports_override_change_when_directory_cleanup_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let unit = service_unit();
        let drop_in_dir = drain_restart_override_dir_at(dir.path(), &unit);
        std::os::unix::fs::symlink(target.path(), &drop_in_dir).unwrap();
        let path = drain_restart_override_path_at(dir.path(), &unit);
        std::fs::write(&path, DRAIN_DROP_IN_CONTENT).unwrap();

        assert!(remove_drain_restart_override_at(dir.path(), &unit).unwrap());

        assert!(!path.exists());
        assert!(
            std::fs::symlink_metadata(&drop_in_dir)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
