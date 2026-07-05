//! Host-global NBD device index locks.
//!
//! These locks coordinate `/dev/nbdN` ownership across runner processes on the
//! same host. The kernel releases `flock` locks automatically when the owning
//! process exits.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

const LOCK_FILE_PREFIX: &str = "vm0-nbd";
const MAX_STALE_INODE_RETRIES: usize = 16;
const PRIVATE_FILE_MODE: u32 = 0o600;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;

/// Owned host-global claim for one NBD device index.
///
/// Dropping this value releases the corresponding per-index `flock`.
#[derive(Debug)]
pub struct NbdDeviceClaim {
    index: u32,
    _lock: Flock<File>,
}

impl NbdDeviceClaim {
    /// NBD device index (N in `/dev/nbdN`).
    pub fn index(&self) -> u32 {
        self.index
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(index: u32, lock_dir: &Path) -> Self {
        try_acquire_device_claim_in(index, lock_dir)
            .expect("test lock acquisition should not fail")
            .expect("test lock should be free")
    }
}

/// Default NBD lock directory.
pub fn default_lock_dir() -> PathBuf {
    PathBuf::from("/var/lock")
}

/// Lock file path for a device index under the default lock directory.
pub fn device_lock_path(index: u32) -> PathBuf {
    device_lock_path_in(index, &default_lock_dir())
}

fn device_lock_path_in(index: u32, lock_dir: &Path) -> PathBuf {
    lock_dir.join(format!("{LOCK_FILE_PREFIX}-{index}.lock"))
}

/// Try to acquire a host-global claim for an NBD device index.
///
/// Returns `Ok(None)` when another process holds the per-index lock.
pub fn try_acquire_device_claim(index: u32) -> io::Result<Option<NbdDeviceClaim>> {
    try_acquire_device_claim_in(index, &default_lock_dir())
}

/// Try to acquire a host-global claim in a custom lock directory.
pub fn try_acquire_device_claim_in(
    index: u32,
    lock_dir: &Path,
) -> io::Result<Option<NbdDeviceClaim>> {
    let path = device_lock_path_in(index, lock_dir);
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = open_lock_file(&path)?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                if lock_inode_is_current(&lock, &path)? {
                    return Ok(Some(NbdDeviceClaim { index, _lock: lock }));
                }
            }
            Err((file, errno)) if errno == nix::errno::Errno::EWOULDBLOCK => {
                if file_inode_is_current(&file, &path)? {
                    return Ok(None);
                }
            }
            Err((_file, errno)) => return Err(io::Error::from_raw_os_error(errno as i32)),
        }
    }

    Err(io::Error::other(format!(
        "lock path {} changed during NBD claim",
        path.display()
    )))
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    open_existing_lock_file(path).or_else(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            create_lock_file(path)
        } else {
            Err(e)
        }
    })
}

fn base_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    options
}

fn open_existing_lock_file(path: &Path) -> io::Result<File> {
    let file = base_open_options().open(path)?;
    validate_lock_file(&file, path)?;
    Ok(file)
}

fn create_lock_file(path: &Path) -> io::Result<File> {
    let mut options = base_open_options();
    let file = options
        .create(true)
        .truncate(false)
        .mode(PRIVATE_FILE_MODE)
        .open(path)?;
    validate_lock_file(&file, path)?;
    Ok(file)
}

fn validate_lock_file(file: &File, path: &Path) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(permission_denied(format!(
            "{} is not a regular lock file",
            path.display()
        )));
    }

    // SAFETY: `geteuid` has no preconditions and does not mutate Rust-owned memory.
    let expected_uid = unsafe { libc::geteuid() };
    if metadata.uid() != expected_uid {
        return Err(permission_denied(format!(
            "{} is owned by uid {}, but current euid is {expected_uid}",
            path.display(),
            metadata.uid()
        )));
    }

    let mode = metadata.mode() & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(permission_denied(format!(
            "{} is group/other writable",
            path.display()
        )));
    }
    if mode != PRIVATE_FILE_MODE {
        chmod_lock_file(file, path)?;
    }
    Ok(())
}

fn chmod_lock_file(file: &File, path: &Path) -> io::Result<()> {
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod lock file {}: {}",
            path.display(),
            io::Error::last_os_error()
        )))
    }
}

fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn metadata_inode_is_current(lock_meta: std::fs::Metadata, path: &Path) -> io::Result<bool> {
    let path_meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    Ok(lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino())
}

fn lock_inode_is_current(lock: &Flock<File>, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(lock.metadata()?, path)
}

fn file_inode_is_current(file: &File, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(file.metadata()?, path)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::{Arc, Barrier, mpsc};

    use super::*;

    #[test]
    fn second_claim_for_same_index_reports_busy_until_first_drops() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = try_acquire_device_claim_in(7, dir.path())
            .expect("first lock")
            .expect("first claim");

        assert!(
            try_acquire_device_claim_in(7, dir.path())
                .expect("second lock attempt")
                .is_none()
        );

        drop(first);

        assert!(
            try_acquire_device_claim_in(7, dir.path())
                .expect("third lock")
                .is_some()
        );
    }

    #[test]
    fn concurrent_claims_for_same_index_have_single_winner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_dir = Arc::new(dir.path().to_owned());
        let worker_count = 8;
        let start = Arc::new(Barrier::new(worker_count + 1));
        let finish = Arc::new(Barrier::new(worker_count + 1));
        let (result_tx, result_rx) = mpsc::channel();
        let mut handles = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let lock_dir = Arc::clone(&lock_dir);
            let start = Arc::clone(&start);
            let finish = Arc::clone(&finish);
            let result_tx = result_tx.clone();
            handles.push(std::thread::spawn(move || {
                start.wait();
                let claim = try_acquire_device_claim_in(7, &lock_dir);
                let result = claim
                    .as_ref()
                    .map(|claim| claim.is_some())
                    .map_err(|error| error.to_string());
                let _ = result_tx.send(result);
                finish.wait();
                drop(claim);
            }));
        }
        drop(result_tx);

        start.wait();
        let results = (0..worker_count)
            .map(|_| result_rx.recv().expect("worker result"))
            .collect::<Vec<_>>();
        finish.wait();

        for handle in handles {
            handle.join().expect("worker should not panic");
        }

        let winner_count = results
            .into_iter()
            .map(|result| result.expect("lock attempt should not fail"))
            .filter(|acquired| *acquired)
            .count();
        assert_eq!(winner_count, 1);
    }

    #[test]
    fn held_claim_detects_replaced_lock_file_inode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let claim = try_acquire_device_claim_in(7, dir.path())
            .expect("lock")
            .expect("claim");

        std::fs::remove_file(&path).expect("remove lock path");
        drop(create_lock_file(&path).expect("recreate lock path"));

        assert!(
            !lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
            "held claim should detect that the path was replaced"
        );
    }

    #[test]
    fn claim_rejects_symlink_lock_path_without_touching_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let target = dir.path().join("target.lock");
        std::fs::write(&target, b"target").expect("write target");
        symlink(&target, &path).expect("create lock path symlink");

        try_acquire_device_claim_in(7, dir.path()).expect_err("symlink lock path should fail");

        assert_eq!(std::fs::read(&target).expect("read target"), b"target");
        assert!(
            std::fs::symlink_metadata(&path)
                .expect("lock path metadata")
                .file_type()
                .is_symlink(),
            "lock path should remain a symlink"
        );
    }

    #[test]
    fn held_claim_rejects_symlink_replacement_to_same_inode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let alias = dir.path().join("alias.lock");
        let claim = try_acquire_device_claim_in(7, dir.path())
            .expect("lock")
            .expect("claim");

        std::fs::hard_link(&path, &alias).expect("create lock alias");
        std::fs::remove_file(&path).expect("remove lock path");
        symlink(&alias, &path).expect("replace lock path with symlink");

        assert!(
            !lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
            "held claim should reject a symlink replacement even when it resolves to the same inode"
        );
    }

    #[test]
    fn claim_rejects_fifo_lock_path_without_blocking() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        nix::unistd::mkfifo(
            &path,
            nix::sys::stat::Mode::from_bits_truncate(PRIVATE_FILE_MODE),
        )
        .expect("create fifo lock path");

        let error =
            try_acquire_device_claim_in(7, dir.path()).expect_err("fifo lock path should fail");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            error.to_string().contains("not a regular lock file"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn claim_tightens_world_readable_lock_file_permissions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        std::fs::write(&path, b"").expect("write lock path");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("set loose lock permissions");

        let _claim = try_acquire_device_claim_in(7, dir.path())
            .expect("lock")
            .expect("claim");

        assert_eq!(
            std::fs::metadata(&path)
                .expect("lock metadata")
                .permissions()
                .mode()
                & 0o777,
            PRIVATE_FILE_MODE
        );
    }

    #[test]
    fn claim_reports_busy_for_held_legacy_world_readable_lock_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        std::fs::write(&path, b"").expect("write lock path");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("set legacy lock permissions");
        let legacy_file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open legacy lock file");
        let _legacy_lock = Flock::lock(legacy_file, FlockArg::LockExclusiveNonblock)
            .map_err(|(_file, errno)| errno)
            .expect("hold legacy lock");

        let claim =
            try_acquire_device_claim_in(7, dir.path()).expect("new lock attempt should not fail");

        assert!(claim.is_none());
        assert_eq!(
            std::fs::metadata(&path)
                .expect("lock metadata")
                .permissions()
                .mode()
                & 0o777,
            PRIVATE_FILE_MODE
        );
    }

    #[test]
    fn claim_rejects_group_writable_lock_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        std::fs::write(&path, b"").expect("write lock path");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o620))
            .expect("set group-writable lock permissions");

        let error = try_acquire_device_claim_in(7, dir.path())
            .expect_err("group-writable lock path should fail");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
    }
}
