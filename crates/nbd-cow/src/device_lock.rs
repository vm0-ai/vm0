//! Cooperative NBD device index locks.
//!
//! These locks coordinate `/dev/nbdN` ownership across runner processes that
//! resolve their lock files through the same host-visible lock directory.
//! Dropping the returned claim closes the lock file descriptor and releases the
//! corresponding kernel `flock`.
//!
//! Claims are represented by per-index lock files named
//! `vm0-nbd-{index}.lock`. When this API creates a missing lock file, it uses
//! private mode bits. The default directory is [`default_lock_dir`],
//! currently `/var/lock`; callers using [`try_acquire_device_claim_in`] may
//! provide another operator-approved lock-file directory. The directory must
//! already exist, but this API does not require the directory itself to be owned
//! by the current effective uid or private to the process.
//! Cooperating processes must use the same resolved lock directory for their
//! claims to coordinate with each other.
//!
//! The security-sensitive object is the final per-index lock file. Existing
//! lock files must be regular files openable for read and write by the current
//! process, must be owned by the current effective uid, must not have multiple
//! hard links, and must not have group/other-writable mode bits. Unsafe or
//! invalid final lock-file paths are reported as I/O errors instead of ordinary
//! lock contention.
//!
//! The per-index lock file path must remain stable while claims may be held:
//! kernel `flock` locks the opened inode, so deleting or replacing the path can
//! create a separate lock domain for later callers.
//!
//! A claim only represents cooperative ownership of the lock file. It does not
//! validate that `/dev/nbdN` exists or is currently free; callers that need a
//! usable device must check device state while holding the claim.

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

/// Owned cooperative claim for one NBD device index.
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

/// Try to acquire a cooperative claim for an NBD device index.
///
/// This uses [`default_lock_dir`] for the lock file directory. Returns
/// `Ok(Some(_))` when the caller owns the claim until the returned
/// [`NbdDeviceClaim`] is dropped.
///
/// Returns `Ok(None)` only when the flock is already held on the current
/// per-index lock inode. Unsafe or invalid lock-file state is reported as an
/// [`std::io::Error`] rather than as `Ok(None)`.
pub fn try_acquire_device_claim(index: u32) -> io::Result<Option<NbdDeviceClaim>> {
    try_acquire_device_claim_in(index, &default_lock_dir())
}

/// Try to acquire a cooperative claim in a custom lock directory.
///
/// `lock_dir` must already exist. The per-index lock path is
/// `lock_dir/vm0-nbd-{index}.lock`. Missing per-index lock files are created
/// with private mode bits and then validated before locking.
/// Processes using different lock directories do not coordinate with each
/// other. Relative lock directories are resolved by each caller's current
/// working directory, so cooperating processes should use paths that resolve to
/// the same directory inode.
///
/// Existing final lock files must be regular files openable for read and write
/// by the current process, must be owned by the current effective uid, must not
/// have multiple hard links, and must not have group/other-writable mode bits.
/// Unsafe final lock-file paths, including a symlink at the per-index lock path
/// and non-regular files, are reported as [`std::io::Error`]. Existing lock
/// files with otherwise acceptable legacy mode bits may be tightened to `0600`.
///
/// Returns `Ok(Some(_))` when the caller owns the claim until the returned
/// [`NbdDeviceClaim`] is dropped. Returns `Ok(None)` only when the flock is
/// already held on the current per-index lock inode; unsafe lock-file state and
/// repeated path replacement during acquisition are reported as I/O errors.
pub fn try_acquire_device_claim_in(
    index: u32,
    lock_dir: &Path,
) -> io::Result<Option<NbdDeviceClaim>> {
    try_acquire_device_claim_in_with(index, lock_dir, |_| {})
}

fn try_acquire_device_claim_in_with(
    index: u32,
    lock_dir: &Path,
    mut before_current_inode_check: impl FnMut(&Path),
) -> io::Result<Option<NbdDeviceClaim>> {
    let path = device_lock_path_in(index, lock_dir);
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = open_lock_file(&path)?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                before_current_inode_check(&path);
                if lock_inode_is_current(&lock, &path)? {
                    return Ok(Some(NbdDeviceClaim { index, _lock: lock }));
                }
            }
            Err((file, errno)) if errno == nix::errno::Errno::EWOULDBLOCK => {
                before_current_inode_check(&path);
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

    if metadata.nlink() > 1 {
        return Err(permission_denied(format!(
            "{} has multiple hard links",
            path.display()
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier, mpsc};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use super::*;

    fn replace_lock_file(path: &Path) {
        std::fs::remove_file(path).expect("remove lock path");
        drop(create_lock_file(path).expect("recreate lock path"));
    }

    const CONCURRENT_CLAIM_RESULT_TIMEOUT: Duration = Duration::from_secs(5);
    const CLAIM_WORKER_RELEASE_TIMEOUT: Duration = Duration::from_secs(10);
    const DELAYED_WORKER_RELEASE_TIMEOUT: Duration = Duration::from_secs(1);

    type ClaimAttemptResult = Result<bool, String>;

    fn collect_claim_results_and_join_workers(
        result_rx: mpsc::Receiver<ClaimAttemptResult>,
        expected_results: usize,
        timeout: Duration,
        release_txs: Vec<mpsc::Sender<()>>,
        handles: Vec<JoinHandle<()>>,
    ) -> Result<Vec<ClaimAttemptResult>, String> {
        let deadline = Instant::now() + timeout;
        let mut results = Vec::with_capacity(expected_results);
        let collection_result = loop {
            if results.len() == expected_results {
                break Ok(results);
            }

            let now = Instant::now();
            if now >= deadline {
                break Err(format!(
                    "claim result collection timed out after {timeout:?}: {} of {expected_results} workers completed",
                    results.len()
                ));
            }

            match result_rx.recv_timeout(deadline - now) {
                Ok(result) => results.push(result),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    break Err(format!(
                        "claim result collection timed out after {timeout:?}: {} of {expected_results} workers completed",
                        results.len()
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(format!(
                        "claim result channel disconnected after {} of {expected_results} workers completed",
                        results.len()
                    ));
                }
            }
        };

        for release_tx in release_txs {
            let _ = release_tx.send(());
        }

        let panicked_workers = handles
            .into_iter()
            .map(|handle| handle.join())
            .filter(Result::is_err)
            .count();

        match (collection_result, panicked_workers) {
            (Ok(results), 0) => Ok(results),
            (Ok(_), count) => Err(format!("claim worker panics during cleanup: {count}")),
            (Err(error), 0) => Err(error),
            (Err(error), count) => Err(format!(
                "{error}; claim worker panics during cleanup: {count}"
            )),
        }
    }

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
        let (result_tx, result_rx) = mpsc::channel();
        let mut release_txs = Vec::with_capacity(worker_count);
        let mut handles = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let lock_dir = Arc::clone(&lock_dir);
            let start = Arc::clone(&start);
            let result_tx = result_tx.clone();
            let (release_tx, release_rx) = mpsc::channel();
            release_txs.push(release_tx);
            handles.push(std::thread::spawn(move || {
                start.wait();
                let claim = try_acquire_device_claim_in(7, &lock_dir);
                let result = claim
                    .as_ref()
                    .map(|claim| claim.is_some())
                    .map_err(|error| error.to_string());
                let holds_claim = matches!(&claim, Ok(Some(_)));
                let _ = result_tx.send(result);
                drop(result_tx);
                if holds_claim {
                    release_rx
                        .recv_timeout(CLAIM_WORKER_RELEASE_TIMEOUT)
                        .expect("claim worker should be released");
                }
                drop(claim);
            }));
        }
        drop(result_tx);

        start.wait();
        let results = collect_claim_results_and_join_workers(
            result_rx,
            worker_count,
            CONCURRENT_CLAIM_RESULT_TIMEOUT,
            release_txs,
            handles,
        )
        .expect("claim workers should complete");

        assert_eq!(results.len(), worker_count);
        let winner_count = results
            .into_iter()
            .map(|result| result.expect("lock attempt should not fail"))
            .filter(|acquired| *acquired)
            .count();
        assert_eq!(winner_count, 1);
    }

    #[test]
    fn claim_retries_after_successful_flock_on_replaced_inode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let mut replaced = false;

        let claim = try_acquire_device_claim_in_with(7, dir.path(), |lock_path| {
            if !replaced {
                replace_lock_file(lock_path);
                replaced = true;
            }
        })
        .expect("lock attempt should not fail")
        .expect("replacement lock should be free");

        assert!(replaced, "lock path should be replaced after flock");
        assert!(
            lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
            "returned claim should hold the current lock inode"
        );
    }

    #[test]
    fn claim_retries_after_contention_on_replaced_inode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let stale_file = create_lock_file(&path).expect("create stale lock file");
        let _stale_lock = Flock::lock(stale_file, FlockArg::LockExclusiveNonblock)
            .map_err(|(_file, errno)| errno)
            .expect("hold stale lock");
        let mut replaced = false;

        let claim = try_acquire_device_claim_in_with(7, dir.path(), |lock_path| {
            if !replaced {
                replace_lock_file(lock_path);
                replaced = true;
            }
        })
        .expect("lock attempt should not fail")
        .expect("replacement lock should be free");

        assert!(replaced, "contended lock path should be replaced");
        assert!(
            lock_inode_is_current(&claim._lock, &path).expect("inode comparison"),
            "returned claim should hold the current lock inode"
        );
    }

    #[test]
    fn claim_errors_after_repeated_lock_path_replacement() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let mut replacement_count = 0;

        let error = try_acquire_device_claim_in_with(7, dir.path(), |lock_path| {
            replace_lock_file(lock_path);
            replacement_count += 1;
        })
        .expect_err("repeated lock path replacement should fail");

        assert_eq!(replacement_count, MAX_STALE_INODE_RETRIES);
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(
            error.to_string(),
            format!("lock path {} changed during NBD claim", path.display())
        );
    }

    #[test]
    fn claim_result_timeout_releases_and_joins_delayed_worker() {
        let (result_tx, result_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_observed = Arc::new(AtomicBool::new(false));
        let worker_completed = Arc::new(AtomicBool::new(false));
        let release_observed_by_worker = Arc::clone(&release_observed);
        let worker_completed_by_worker = Arc::clone(&worker_completed);
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            result_tx.send(Ok(false)).expect("send delayed result");
            let released = release_rx
                .recv_timeout(DELAYED_WORKER_RELEASE_TIMEOUT)
                .is_ok();
            release_observed_by_worker.store(released, Ordering::SeqCst);
            worker_completed_by_worker.store(true, Ordering::SeqCst);
        });

        let error = collect_claim_results_and_join_workers(
            result_rx,
            1,
            Duration::ZERO,
            vec![release_tx],
            vec![handle],
        )
        .expect_err("delayed result should exceed the collection deadline");

        assert!(
            error.contains("0 of 1 workers completed"),
            "unexpected error: {error}"
        );
        assert!(release_observed.load(Ordering::SeqCst));
        assert!(worker_completed.load(Ordering::SeqCst));
    }

    #[test]
    fn held_claim_detects_replaced_lock_file_inode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let claim = try_acquire_device_claim_in(7, dir.path())
            .expect("lock")
            .expect("claim");

        replace_lock_file(&path);

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
    fn claim_rejects_hard_link_lock_path_without_chmod_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = device_lock_path_in(7, dir.path());
        let target = dir.path().join("target.lock");
        std::fs::write(&target, b"target").expect("write target");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))
            .expect("set target permissions");
        std::fs::hard_link(&target, &path).expect("create lock hard link");

        let error = try_acquire_device_claim_in(7, dir.path())
            .expect_err("hard-linked lock path should fail");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            error.to_string().contains("multiple hard links"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read(&target).expect("read target"), b"target");
        assert_eq!(
            std::fs::metadata(&target)
                .expect("target metadata")
                .permissions()
                .mode()
                & 0o777,
            0o644
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
