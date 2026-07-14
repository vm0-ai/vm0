use std::path::Path;

use tracing::warn;

use crate::error::RunnerResult;
use crate::paths::HomePaths;

use super::filesystem::{next_entry_warn, read_dir_or_missing};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;
use super::versions::parse_semver;

fn version_from_service_lock_name(name: &str) -> Option<&str> {
    const PREFIX: &str = "service-vm0-runner-";
    const SUFFIX: &str = ".lock";

    let version = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    parse_semver(version)?;
    Some(version)
}

async fn version_bin_is_gc_enumerable_dir(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(meta) => Ok(meta.file_type().is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("stat version bin {}: {e}", path.display())),
    }
}

pub(super) async fn gc_orphaned_version_service_locks(
    home: &HomePaths,
    dry_run: bool,
) -> RunnerResult<GcReport> {
    let locks_dir = home.locks_dir();
    let Some(mut entries) = read_dir_or_missing(&locks_dir).await? else {
        return Ok(GcReport::default());
    };

    let mut removed = 0u64;
    let bin_dir = home.bin_dir();

    while let Some(entry) = next_entry_warn(
        &mut entries,
        "gc_orphaned_version_service_locks",
        &locks_dir,
    )
    .await
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(version) = version_from_service_lock_name(name) else {
            continue;
        };

        let version_bin = bin_dir.join(version);
        match version_bin_is_gc_enumerable_dir(&version_bin).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                warn!("{e}");
                continue;
            }
        }

        let lock_path = entry.path();
        match probe_existing_lock(&lock_path) {
            ExistingLockProbe::Free(lock) => {
                // A version can be recreated between the initial stat and
                // acquiring the free service lock.
                match version_bin_is_gc_enumerable_dir(&version_bin).await {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(e) => {
                        warn!("{e}");
                        continue;
                    }
                }

                if remove_unused_lock_after_probe(&lock_path, &lock, name, dry_run).await {
                    removed += 1;
                }
            }
            ExistingLockProbe::Held | ExistingLockProbe::Missing => {}
            ExistingLockProbe::Error(e) => warn!("cannot probe service lock {name}: {e}"),
        }
    }

    Ok(GcReport::version_service_locks_removed(removed))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use nix::fcntl::{Flock, FlockArg};

    use super::*;
    use crate::cmd::gc::test_support::test_home;
    use crate::{cmd::service, lock};

    fn test_version_service_lock(home: &HomePaths, version: &str) -> PathBuf {
        let unit = service::RunnerServiceUnit::from_suffix(version).unwrap();
        home.service_lock(unit.unit_name())
    }

    fn test_version_service_unit_name(version: &str) -> String {
        service::RunnerServiceUnit::from_suffix(version)
            .unwrap()
            .unit_name()
            .to_string()
    }

    fn create_test_version_service_lock(home: &HomePaths, version: &str) -> PathBuf {
        let path = test_version_service_lock(home, version);
        drop(lock::open_lock_file(&path).unwrap());
        path
    }
    #[test]
    fn version_from_service_lock_name_parses_only_semver_runner_service_locks() {
        assert_eq!(
            version_from_service_lock_name("service-vm0-runner-v1.0.0.lock"),
            Some("v1.0.0")
        );
        assert!(version_from_service_lock_name("service-vm0-runner-staging.lock").is_none());
        assert!(version_from_service_lock_name("service-vm0-runner-v1.0.lock").is_none());
        assert!(version_from_service_lock_name("workspace-image-cache-v1.0.0.lock").is_none());
        assert!(version_from_service_lock_name("service-vm0-runner-v1.0.0").is_none());
    }

    #[tokio::test]
    async fn gc_orphaned_version_service_locks_removes_missing_version_bin() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let service_lock = create_test_version_service_lock(&home, "v1.0.0");

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 1);
        assert!(
            !service_lock.exists(),
            "missing version bin dir should make its service lock stale"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_version_service_locks_keeps_existing_version_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let version = "v1.0.0";
        let service_lock = create_test_version_service_lock(&home, version);
        std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 0);
        assert!(
            service_lock.exists(),
            "existing version dir should keep its service lock"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_version_service_locks_removes_semver_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let version = "v1.0.0";
        let service_lock = create_test_version_service_lock(&home, version);
        std::fs::create_dir_all(home.bin_dir()).unwrap();
        std::fs::write(home.bin_dir().join(version), "not a directory").unwrap();

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 1);
        assert!(
            !service_lock.exists(),
            "semver-named files are not GC-enumerable version dirs"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gc_orphaned_version_service_locks_removes_semver_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let version = "v1.0.0";
        let service_lock = create_test_version_service_lock(&home, version);
        let target_dir = dir.path().join("external-version");
        std::fs::create_dir_all(home.bin_dir()).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        std::os::unix::fs::symlink(&target_dir, home.bin_dir().join(version)).unwrap();

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 1);
        assert!(
            !service_lock.exists(),
            "semver-named symlinks are not GC-enumerable version dirs"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_version_service_locks_keeps_held_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let service_lock = test_version_service_lock(&home, "v1.0.0");
        let lock_file = lock::open_lock_file(&service_lock).unwrap();
        let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 0);
        assert!(
            service_lock.exists(),
            "held orphaned service lock must not be removed"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_version_service_locks_keeps_non_semver_service_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let unit = test_version_service_unit_name("staging");
        let service_lock = home.service_lock(&unit);
        drop(lock::open_lock_file(&service_lock).unwrap());

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 0);
        assert!(
            service_lock.exists(),
            "non-semver service locks belong outside version GC"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gc_orphaned_version_service_locks_skips_symlink_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let service_lock = test_version_service_lock(&home, "v1.0.0");
        let target = dir.path().join("outside-lock-target");
        std::fs::create_dir_all(home.locks_dir()).unwrap();
        std::fs::write(&target, "outside").unwrap();
        std::os::unix::fs::symlink(&target, &service_lock).unwrap();

        let removed = gc_orphaned_version_service_locks(&home, false)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 0);
        assert!(
            std::fs::symlink_metadata(&service_lock)
                .unwrap()
                .file_type()
                .is_symlink(),
            "symlink lock path must be left untouched"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside");
    }

    #[tokio::test]
    async fn gc_orphaned_version_service_locks_dry_run_preserves_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let service_lock = create_test_version_service_lock(&home, "v1.0.0");

        let removed = gc_orphaned_version_service_locks(&home, true)
            .await
            .unwrap();

        assert_eq!(removed.version_service_locks_removed, 1);
        assert!(
            service_lock.exists(),
            "dry-run should count but not remove stale service locks"
        );
    }
}
