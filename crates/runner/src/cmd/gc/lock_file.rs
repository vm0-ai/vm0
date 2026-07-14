use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use nix::fcntl::{Flock, FlockArg};
use tracing::{info, warn};

use crate::host_file;
use crate::lock;

pub(super) enum LockProbe {
    /// Lock acquired — resource is not in use.
    Free(Flock<std::fs::File>),
    /// Lock held by another process.
    Held,
    /// Could not probe (file error).
    Error(String),
}

pub(super) enum ExistingLockProbe {
    /// Lock acquired — resource is not in use.
    Free(Flock<std::fs::File>),
    /// Lock held by another process.
    Held,
    /// The path no longer exists.
    Missing,
    /// Could not probe (file error).
    Error(String),
}

fn lock_metadata_inode_is_current(
    lock_meta: std::fs::Metadata,
    path: &Path,
) -> Result<bool, String> {
    let path_meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("lstat lock {}: {e}", path.display())),
    };
    Ok(lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino())
}

fn lock_probe_inode_is_current(lock: &Flock<std::fs::File>, path: &Path) -> Result<bool, String> {
    let lock_meta = lock
        .metadata()
        .map_err(|e| format!("stat locked fd for {}: {e}", path.display()))?;
    lock_metadata_inode_is_current(lock_meta, path)
}

fn lock_file_inode_is_current(file: &std::fs::File, path: &Path) -> Result<bool, String> {
    let lock_meta = file
        .metadata()
        .map_err(|e| format!("stat lock fd for {}: {e}", path.display()))?;
    lock_metadata_inode_is_current(lock_meta, path)
}

/// Try a nonblocking exclusive flock to check if a resource is in use.
pub(super) fn probe_lock(path: &Path) -> LockProbe {
    const MAX_STALE_INODE_RETRIES: usize = 16;
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = match lock::open_lock_file(path) {
            Ok(f) => f,
            Err(e) => return LockProbe::Error(e.to_string()),
        };
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => match lock_probe_inode_is_current(&lock, path) {
                Ok(true) => return LockProbe::Free(lock),
                Ok(false) => continue,
                Err(e) => return LockProbe::Error(e),
            },
            Err((file, e)) if e == nix::errno::Errno::EWOULDBLOCK => {
                match lock_file_inode_is_current(&file, path) {
                    Ok(true) => return LockProbe::Held,
                    Ok(false) => continue,
                    Err(e) => return LockProbe::Error(e),
                }
            }
            Err((_, e)) => return LockProbe::Error(e.to_string()),
        }
    }
    LockProbe::Error(format!("lock path {} changed during probe", path.display()))
}

fn open_existing_lock_file(path: &Path) -> Result<Option<std::fs::File>, String> {
    host_file::validate_file_parent(path, "lock directory")
        .map_err(|e| format!("validate lock parent {}: {e}", path.display()))?;
    let file = match std::fs::File::options()
        .read(true)
        .write(true)
        .custom_flags(host_file::private_file_open_flags())
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("open lock {}: {e}", path.display())),
    };
    validate_existing_lock_file_for_probe(&file, path)?;
    Ok(Some(file))
}

fn validate_existing_lock_file_for_probe(file: &std::fs::File, path: &Path) -> Result<(), String> {
    const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
    let meta = file
        .metadata()
        .map_err(|e| format!("stat lock {}: {e}", path.display()))?;
    if !meta.file_type().is_file() {
        return Err(format!("{} is not a regular lock file", path.display()));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    if meta.uid() != expected_uid {
        return Err(format!(
            "{} is owned by uid {}, but runner euid is {expected_uid}",
            path.display(),
            meta.uid()
        ));
    }

    let mode = meta.mode() & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(format!("{} is group/other writable", path.display()));
    }
    Ok(())
}

/// Try a nonblocking exclusive flock without creating a missing lock path.
pub(super) fn probe_existing_lock(path: &Path) -> ExistingLockProbe {
    const MAX_STALE_INODE_RETRIES: usize = 16;
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = match open_existing_lock_file(path) {
            Ok(Some(file)) => file,
            Ok(None) => return ExistingLockProbe::Missing,
            Err(e) => return ExistingLockProbe::Error(e),
        };
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => match lock_probe_inode_is_current(&lock, path) {
                Ok(true) => return ExistingLockProbe::Free(lock),
                Ok(false) => continue,
                Err(e) => return ExistingLockProbe::Error(e),
            },
            Err((file, e)) if e == nix::errno::Errno::EWOULDBLOCK => {
                match lock_file_inode_is_current(&file, path) {
                    Ok(true) => return ExistingLockProbe::Held,
                    Ok(false) => continue,
                    Err(e) => return ExistingLockProbe::Error(e),
                }
            }
            Err((_, e)) => return ExistingLockProbe::Error(e.to_string()),
        }
    }
    ExistingLockProbe::Error(format!("lock path {} changed during probe", path.display()))
}

pub(super) async fn remove_unused_lock_after_probe(
    lock_path: &Path,
    lock: &Flock<std::fs::File>,
    name: &str,
    dry_run: bool,
) -> bool {
    if !lock_guard_matches_path(lock_path, lock) {
        return false;
    }

    if dry_run {
        info!("[dry-run] would remove unused lock {name}");
        return true;
    }

    if remove_lock_file(lock_path).await {
        info!("removed unused lock {name}");
        true
    } else {
        false
    }
}

fn lock_guard_matches_path(lock_path: &Path, lock: &Flock<std::fs::File>) -> bool {
    match lock_probe_inode_is_current(lock, lock_path) {
        Ok(true) => true,
        Ok(false) => false,
        Err(e) => {
            warn!("{e}");
            false
        }
    }
}

async fn remove_lock_file(lock_path: &Path) -> bool {
    match tokio::fs::remove_file(lock_path).await {
        Ok(()) => true,
        Err(e) => {
            warn!("cannot remove {}: {e}", lock_path.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_lock_free_when_no_holder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        match probe_lock(&path) {
            LockProbe::Free(_) => {}
            _ => panic!("expected Free"),
        }
    }

    #[test]
    fn probe_lock_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locks").join("test.lock");
        assert!(!dir.path().join("locks").exists());
        match probe_lock(&path) {
            LockProbe::Free(_) => {}
            _ => panic!("expected Free"),
        }
        assert!(dir.path().join("locks").exists());
    }

    #[test]
    fn probe_existing_lock_missing_path_does_not_create_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locks").join("test.lock");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        match probe_existing_lock(&path) {
            ExistingLockProbe::Missing => {}
            _ => panic!("missing lock path must not be probeable"),
        }

        assert!(
            !path.exists(),
            "existing-lock probe must not create a missing lock"
        );
        assert!(
            dir.path().join("locks").exists(),
            "test setup should leave the existing parent dir intact"
        );
    }

    #[test]
    fn probe_lock_held_when_shared_lock_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        // Hold a shared lock (simulating a running runner).
        let file = std::fs::File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let _shared = Flock::lock(file, FlockArg::LockShared).unwrap();

        match probe_lock(&path) {
            LockProbe::Held => {}
            _ => panic!("expected Held"),
        }
    }

    #[test]
    fn probe_lock_held_when_exclusive_lock_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        // Hold an exclusive lock (simulating a build).
        let file = std::fs::File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let _excl = Flock::lock(file, FlockArg::LockExclusive).unwrap();

        match probe_lock(&path) {
            LockProbe::Held => {}
            _ => panic!("expected Held"),
        }
    }

    #[test]
    fn lock_probe_inode_check_detects_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let held_lock = match probe_lock(&path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => panic!("new test lock must not be held"),
            LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
        };

        std::fs::remove_file(&path).unwrap();
        drop(lock::open_lock_file(&path).unwrap());

        assert!(
            !lock_probe_inode_is_current(&held_lock, &path).unwrap(),
            "inode check must reject a lock fd whose path was recreated"
        );
    }

    #[cfg(unix)]
    #[test]
    fn lock_probe_inode_check_rejects_symlink_to_same_inode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let alias = dir.path().join("alias.lock");

        let held_lock = match probe_lock(&path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => panic!("new test lock must not be held"),
            LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
        };

        std::fs::hard_link(&path, &alias).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&alias, &path).unwrap();

        assert!(
            !lock_probe_inode_is_current(&held_lock, &path).unwrap(),
            "inode check must reject a lock path replaced by a symlink"
        );
    }

    #[test]
    fn lock_file_inode_check_detects_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let file = lock::open_lock_file(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        drop(lock::open_lock_file(&path).unwrap());

        assert!(
            !lock_file_inode_is_current(&file, &path).unwrap(),
            "inode check must reject an opened lock fd whose path was recreated"
        );
    }

    #[tokio::test]
    async fn remove_unused_lock_after_probe_keeps_replaced_lock_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("locks")
            .join("workspace-image-cache-test.lock");

        let held_lock = match probe_lock(&path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => panic!("new test lock must not be held"),
            LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
        };

        std::fs::remove_file(&path).unwrap();
        drop(lock::open_lock_file(&path).unwrap());
        assert!(
            path.exists(),
            "test setup must recreate the lock path with a new inode"
        );

        let removed = remove_unused_lock_after_probe(
            &path,
            &held_lock,
            "workspace-image-cache-test.lock",
            false,
        )
        .await;

        assert!(!removed, "stale lock fd must not remove a recreated path");
        assert!(
            path.exists(),
            "cleanup must not remove a lock path recreated after this lock was acquired"
        );
    }
}
