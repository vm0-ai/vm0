//! Netns pool index ownership during the private-lock migration.
//!
//! A bridge runner acquires the legacy `/var/lock` file first and the matching
//! owner-only runtime file second. Holding both claims keeps it mutually
//! exclusive with deployed legacy-only runners and with the future
//! private-only release. The legacy half must not be removed until #22632's
//! rollout gate confirms that legacy-only rollback is no longer supported.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use nix::fcntl::{Flock, FlockArg};
use tracing::{info, warn};

use crate::paths::LockPaths;
use crate::runtime_dirs::{
    ensure_private_runtime_dir, ensure_traversable_runtime_dir, validate_private_runtime_dir,
    validate_traversable_runtime_dir,
};

use super::super::error::{NetworkError, Result};
use super::naming::MAX_POOLS;

const MAX_STALE_INODE_RETRIES: usize = 16;
const PRIVATE_FILE_MODE: u32 = 0o600;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;

/// Observable ownership state for one netns pool index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetnsPoolLockStatus {
    /// At least one side of the migration bridge is held by a current owner.
    Active,
    /// Neither side of the migration bridge is currently held.
    Idle,
}

/// Complete ownership claim for one netns pool index.
///
/// Dropping this value releases both flocks. The field order is not relied on
/// for release ordering; acquisition is always legacy first, private second.
#[derive(Debug)]
pub(super) struct PoolIndexLock {
    index: u32,
    _legacy_lock: Flock<File>,
    _private_lock: Flock<File>,
}

impl PoolIndexLock {
    pub(super) fn index(&self) -> u32 {
        self.index
    }

    #[cfg(test)]
    pub(super) fn for_test(index: u32) -> Self {
        let legacy_file = tempfile::tempfile().expect("create legacy test lock file");
        let private_file = tempfile::tempfile().expect("create private test lock file");
        let legacy_lock = Flock::lock(legacy_file, FlockArg::LockExclusiveNonblock)
            .unwrap_or_else(|(_, error)| panic!("lock legacy test file: {error}"));
        let private_lock = Flock::lock(private_file, FlockArg::LockExclusiveNonblock)
            .unwrap_or_else(|(_, error)| panic!("lock private test file: {error}"));
        Self {
            index,
            _legacy_lock: legacy_lock,
            _private_lock: private_lock,
        }
    }
}

#[derive(Debug)]
enum FileClaim {
    Acquired(Flock<File>),
    Busy,
    Missing,
}

enum BridgeClaim {
    Acquired(PoolIndexLock),
    Busy,
}

#[derive(Clone, Copy)]
struct OpenPolicy {
    create: bool,
    tighten_mode: bool,
}

impl OpenPolicy {
    const CLAIM: Self = Self {
        create: true,
        tighten_mode: true,
    };
    const PROBE: Self = Self {
        create: false,
        tighten_mode: false,
    };
}

/// Acquire the first safe, idle pool index and retain both bridge locks.
pub(super) fn acquire_pool_lock(paths: &LockPaths) -> Result<PoolIndexLock> {
    prepare_private_lock_dir(paths).map_err(pool_lock_error)?;

    let mut first_error = None;
    let mut error_count = 0_usize;
    for index in 0..MAX_POOLS {
        match try_claim_complete(paths, index) {
            Ok(BridgeClaim::Acquired(claim)) => {
                info!(index, "acquired pool index lock bridge");
                return Ok(claim);
            }
            Ok(BridgeClaim::Busy) => {}
            Err(error) => {
                warn!(index, %error, "cannot safely claim pool index, skipping index");
                error_count += 1;
                first_error.get_or_insert(error);
            }
        }
    }

    match first_error {
        Some(error) => Err(NetworkError::PoolLock(format!(
            "{error} ({error_count} unsafe or failed pool indexes)"
        ))),
        None => Err(NetworkError::NoPoolIndexAvailable),
    }
}

/// Try to claim an index discovered from captured host resources.
///
/// Missing lock files are created because captured namespaces or firewall
/// rules are evidence that the index needs ownership-aware reconciliation.
pub(super) fn try_claim_reconciliation_lock(
    paths: &LockPaths,
    index: u32,
) -> io::Result<Option<PoolIndexLock>> {
    match try_claim_complete(paths, index)? {
        BridgeClaim::Acquired(claim) => Ok(Some(claim)),
        BridgeClaim::Busy => Ok(None),
    }
}

/// Probe whether a production netns pool index has a current owner.
///
/// The probe never creates lock files or runtime directories and never changes
/// file modes. Unsafe files, unstable pathnames, and invalid private runtime
/// directories are returned as errors so diagnostics cannot misclassify them
/// as orphaned resources.
pub fn probe_netns_pool_lock(index: u32) -> io::Result<NetnsPoolLockStatus> {
    probe_netns_pool_lock_with_paths(&LockPaths::new(), index)
}

pub(crate) fn probe_netns_pool_lock_with_paths(
    paths: &LockPaths,
    index: u32,
) -> io::Result<NetnsPoolLockStatus> {
    let legacy_path = paths.netns_pool(index);
    let legacy_lock = match try_lock_file(&legacy_path, OpenPolicy::PROBE)? {
        FileClaim::Acquired(lock) => Some(lock),
        FileClaim::Busy => return Ok(NetnsPoolLockStatus::Active),
        FileClaim::Missing => None,
    };

    validate_private_lock_dir_if_present(paths)?;
    let private_path = paths.private_netns_pool(index);
    let status = match try_lock_file(&private_path, OpenPolicy::PROBE)? {
        FileClaim::Busy => NetnsPoolLockStatus::Active,
        FileClaim::Acquired(_) | FileClaim::Missing => NetnsPoolLockStatus::Idle,
    };
    drop(legacy_lock);
    Ok(status)
}

fn try_claim_complete(paths: &LockPaths, index: u32) -> io::Result<BridgeClaim> {
    let legacy_path = paths.netns_pool(index);
    let legacy_lock = match try_lock_file(&legacy_path, OpenPolicy::CLAIM)? {
        FileClaim::Acquired(lock) => lock,
        FileClaim::Busy => return Ok(BridgeClaim::Busy),
        FileClaim::Missing => {
            return Err(io::Error::other(format!(
                "legacy pool lock disappeared while creating {}",
                legacy_path.display()
            )));
        }
    };

    let private_path = paths.private_netns_pool(index);
    let private_lock = match try_lock_file(&private_path, OpenPolicy::CLAIM)? {
        FileClaim::Acquired(lock) => lock,
        FileClaim::Busy => return Ok(BridgeClaim::Busy),
        FileClaim::Missing => {
            return Err(io::Error::other(format!(
                "private pool lock disappeared while creating {}",
                private_path.display()
            )));
        }
    };

    Ok(BridgeClaim::Acquired(PoolIndexLock {
        index,
        _legacy_lock: legacy_lock,
        _private_lock: private_lock,
    }))
}

fn prepare_private_lock_dir(paths: &LockPaths) -> io::Result<()> {
    ensure_traversable_runtime_dir(paths.runtime_base())?;
    ensure_private_runtime_dir(paths.private_base())
}

fn validate_private_lock_dir_if_present(paths: &LockPaths) -> io::Result<()> {
    match std::fs::symlink_metadata(paths.runtime_base()) {
        Ok(_) => validate_traversable_runtime_dir(paths.runtime_base())?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(path_error(
                "stat runtime lock parent",
                paths.runtime_base(),
                error,
            ));
        }
    }

    match std::fs::symlink_metadata(paths.private_base()) {
        Ok(_) => validate_private_runtime_dir(paths.private_base()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(path_error(
            "stat private lock directory",
            paths.private_base(),
            error,
        )),
    }
}

fn try_lock_file(path: &Path, policy: OpenPolicy) -> io::Result<FileClaim> {
    try_lock_file_with(path, policy, |_, _| {})
}

fn try_lock_file_with(
    path: &Path,
    policy: OpenPolicy,
    mut after_flock: impl FnMut(usize, &Path),
) -> io::Result<FileClaim> {
    for attempt in 0..MAX_STALE_INODE_RETRIES {
        let Some(file) = open_lock_file(path, policy)? else {
            return Ok(FileClaim::Missing);
        };
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                after_flock(attempt, path);
                if lock_inode_is_current(&lock, path)? {
                    return Ok(FileClaim::Acquired(lock));
                }
            }
            Err((file, error)) if error == nix::errno::Errno::EWOULDBLOCK => {
                after_flock(attempt, path);
                if file_inode_is_current(&file, path)? {
                    return Ok(FileClaim::Busy);
                }
            }
            Err((_file, error)) => {
                return Err(path_error(
                    "flock pool lock",
                    path,
                    io::Error::from_raw_os_error(error as i32),
                ));
            }
        }
    }

    Err(io::Error::other(format!(
        "pool lock path {} changed during {MAX_STALE_INODE_RETRIES} acquisition attempts",
        path.display()
    )))
}

fn open_lock_file(path: &Path, policy: OpenPolicy) -> io::Result<Option<File>> {
    match open_existing_lock_file(path, policy.tighten_mode) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !policy.create => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_lock_file(path, policy.tighten_mode).map(Some)
        }
        Err(error) => Err(error),
    }
}

fn base_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    options
}

fn open_existing_lock_file(path: &Path, tighten_mode: bool) -> io::Result<File> {
    let file = base_open_options()
        .open(path)
        .map_err(|error| path_error("open pool lock", path, error))?;
    validate_lock_file(&file, path, tighten_mode)?;
    Ok(file)
}

fn create_lock_file(path: &Path, tighten_mode: bool) -> io::Result<File> {
    let mut options = base_open_options();
    let file = options
        .create(true)
        .truncate(false)
        .mode(PRIVATE_FILE_MODE)
        .open(path)
        .map_err(|error| path_error("create pool lock", path, error))?;
    validate_lock_file(&file, path, tighten_mode)?;
    Ok(file)
}

fn validate_lock_file(file: &File, path: &Path, tighten_mode: bool) -> io::Result<()> {
    let metadata = file
        .metadata()
        .map_err(|error| path_error("stat opened pool lock", path, error))?;
    if !metadata.is_file() {
        return Err(permission_denied(format!(
            "{} is not a regular pool lock file",
            path.display()
        )));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    if !lock_file_owner_is_trusted(metadata.uid(), expected_uid) {
        return Err(permission_denied(format!(
            "{} is owned by uid {}, but current euid is {expected_uid}",
            path.display(),
            metadata.uid()
        )));
    }

    if metadata.nlink() != 1 {
        return Err(permission_denied(format!(
            "{} has {} hard links",
            path.display(),
            metadata.nlink()
        )));
    }

    let mode = metadata.mode() & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(permission_denied(format!(
            "{} is group/other writable",
            path.display()
        )));
    }
    if tighten_mode && mode != PRIVATE_FILE_MODE {
        chmod_lock_file(file, path)?;
    }
    Ok(())
}

fn lock_file_owner_is_trusted(owner_uid: u32, effective_uid: u32) -> bool {
    owner_uid == effective_uid
}

fn chmod_lock_file(file: &File, path: &Path) -> io::Result<()> {
    // SAFETY: `fchmod` operates on this live descriptor and does not affect
    // Rust memory or aliasing.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(path_error(
            "chmod pool lock",
            path,
            io::Error::last_os_error(),
        ))
    }
}

fn metadata_inode_is_current(metadata: std::fs::Metadata, path: &Path) -> io::Result<bool> {
    let path_metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(path_error("stat pool lock path", path, error)),
    };
    Ok(metadata.dev() == path_metadata.dev() && metadata.ino() == path_metadata.ino())
}

fn lock_inode_is_current(lock: &Flock<File>, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(
        lock.metadata()
            .map_err(|error| path_error("stat flocked pool lock", path, error))?,
        path,
    )
}

fn file_inode_is_current(file: &File, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(
        file.metadata()
            .map_err(|error| path_error("stat contended pool lock", path, error))?,
        path,
    )
}

fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn path_error(action: &str, path: &Path, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("{action} {}: {error}", path.display()),
    )
}

fn pool_lock_error(error: io::Error) -> NetworkError {
    NetworkError::PoolLock(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs::Permissions;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::{Arc, Barrier};
    use std::thread;

    use nix::sys::stat::Mode;
    use nix::unistd::mkfifo;
    use tempfile::TempDir;

    use super::*;

    struct Fixture {
        _dir: TempDir,
        paths: LockPaths,
    }

    impl Fixture {
        fn new() -> Self {
            let fixture = Self::unprepared();
            prepare_private_lock_dir(&fixture.paths).unwrap();
            fixture
        }

        fn unprepared() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let legacy = dir.path().join("legacy");
            let runtime = dir.path().join("runtime");
            std::fs::create_dir(&legacy).unwrap();
            let paths = LockPaths::with_dirs(legacy, runtime);
            Self { _dir: dir, paths }
        }

        fn create_lock(&self, path: &Path) -> File {
            let file = base_open_options()
                .create(true)
                .truncate(false)
                .mode(PRIVATE_FILE_MODE)
                .open(path)
                .unwrap();
            std::fs::set_permissions(path, Permissions::from_mode(PRIVATE_FILE_MODE)).unwrap();
            file
        }
    }

    fn flock(file: File) -> Flock<File> {
        Flock::lock(file, FlockArg::LockExclusiveNonblock)
            .unwrap_or_else(|(_, error)| panic!("lock test file: {error}"))
    }

    #[test]
    fn acquisition_creates_private_files_and_reuses_released_index() {
        let fixture = Fixture::new();
        let first = acquire_pool_lock(&fixture.paths).unwrap();
        assert_eq!(first.index(), 0);
        assert_eq!(
            std::fs::metadata(fixture.paths.netns_pool(0))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            PRIVATE_FILE_MODE
        );
        assert_eq!(
            std::fs::metadata(fixture.paths.private_netns_pool(0))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            PRIVATE_FILE_MODE
        );
        assert_eq!(
            std::fs::metadata(fixture.paths.runtime_base())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o711
        );
        assert_eq!(
            std::fs::metadata(fixture.paths.private_base())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let second = acquire_pool_lock(&fixture.paths).unwrap();
        assert_eq!(second.index(), 1);
        drop(first);
        assert_eq!(acquire_pool_lock(&fixture.paths).unwrap().index(), 0);
    }

    #[test]
    fn private_contention_releases_partial_legacy_claim() {
        let fixture = Fixture::new();
        let private_path = fixture.paths.private_netns_pool(0);
        let _private_holder = flock(fixture.create_lock(&private_path));

        assert!(matches!(
            try_claim_complete(&fixture.paths, 0).unwrap(),
            BridgeClaim::Busy
        ));
        assert!(matches!(
            try_lock_file(&fixture.paths.netns_pool(0), OpenPolicy::CLAIM).unwrap(),
            FileClaim::Acquired(_)
        ));
    }

    #[test]
    fn legacy_contention_does_not_create_private_counterpart() {
        let fixture = Fixture::new();
        let legacy_path = fixture.paths.netns_pool(0);
        let _legacy_holder = flock(fixture.create_lock(&legacy_path));

        assert!(matches!(
            try_claim_complete(&fixture.paths, 0).unwrap(),
            BridgeClaim::Busy
        ));
        assert!(!fixture.paths.private_netns_pool(0).exists());
    }

    #[test]
    fn compatible_legacy_mode_is_tightened_even_while_contended() {
        let fixture = Fixture::new();
        let path = fixture.paths.netns_pool(0);
        let file = fixture.create_lock(&path);
        std::fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
        let _holder = flock(file);

        assert!(matches!(
            try_claim_complete(&fixture.paths, 0).unwrap(),
            BridgeClaim::Busy
        ));
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            PRIVATE_FILE_MODE
        );
    }

    #[test]
    fn captured_candidate_creates_both_missing_locks() {
        let fixture = Fixture::new();
        let claim = try_claim_reconciliation_lock(&fixture.paths, 7)
            .unwrap()
            .expect("candidate should be claimable");
        assert_eq!(claim.index(), 7);
        assert!(fixture.paths.netns_pool(7).is_file());
        assert!(fixture.paths.private_netns_pool(7).is_file());
    }

    #[test]
    fn captured_candidate_creates_a_missing_private_counterpart() {
        let fixture = Fixture::new();
        fixture.create_lock(&fixture.paths.netns_pool(8));

        let claim = try_claim_reconciliation_lock(&fixture.paths, 8)
            .unwrap()
            .expect("candidate should be claimable");
        assert_eq!(claim.index(), 8);
        assert!(fixture.paths.private_netns_pool(8).is_file());
    }

    #[test]
    fn only_one_concurrent_candidate_claim_wins() {
        let fixture = Fixture::new();
        let paths = Arc::new(fixture.paths);
        let start = Arc::new(Barrier::new(3));
        let finish = Arc::new(Barrier::new(3));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let paths = Arc::clone(&paths);
                let start = Arc::clone(&start);
                let finish = Arc::clone(&finish);
                thread::spawn(move || {
                    start.wait();
                    let claim = try_claim_reconciliation_lock(&paths, 3).unwrap();
                    let acquired = claim.is_some();
                    finish.wait();
                    acquired
                })
            })
            .collect();
        start.wait();
        finish.wait();
        let acquired = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|acquired| *acquired)
            .count();
        assert_eq!(acquired, 1);
    }

    #[test]
    fn rejects_symlink_fifo_directory_hard_link_and_unsafe_mode() {
        let fixture = Fixture::new();

        let target = fixture.paths.netns_pool(63);
        fixture.create_lock(&target);
        symlink(&target, fixture.paths.netns_pool(0)).unwrap();
        assert!(try_claim_complete(&fixture.paths, 0).is_err());

        mkfifo(&fixture.paths.netns_pool(1), Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
        assert!(try_claim_complete(&fixture.paths, 1).is_err());

        std::fs::create_dir(fixture.paths.netns_pool(2)).unwrap();
        assert!(try_claim_complete(&fixture.paths, 2).is_err());

        let hard_link_source = fixture.paths.netns_pool(61);
        fixture.create_lock(&hard_link_source);
        std::fs::hard_link(&hard_link_source, fixture.paths.netns_pool(3)).unwrap();
        assert!(try_claim_complete(&fixture.paths, 3).is_err());

        let unsafe_mode = fixture.paths.netns_pool(4);
        fixture.create_lock(&unsafe_mode);
        std::fs::set_permissions(&unsafe_mode, Permissions::from_mode(0o620)).unwrap();
        assert!(try_claim_complete(&fixture.paths, 4).is_err());
    }

    #[test]
    fn retries_replaced_path_before_accepting_claim() {
        let fixture = Fixture::new();
        let path = fixture.paths.netns_pool(0);
        fixture.create_lock(&path);
        let mut replaced = false;

        let claim = try_lock_file_with(&path, OpenPolicy::CLAIM, |_, path| {
            if !replaced {
                std::fs::remove_file(path).unwrap();
                let replacement = base_open_options()
                    .create(true)
                    .truncate(false)
                    .mode(PRIVATE_FILE_MODE)
                    .open(path)
                    .unwrap();
                drop(replacement);
                replaced = true;
            }
        })
        .unwrap();
        assert!(matches!(claim, FileClaim::Acquired(_)));
    }

    #[test]
    fn retries_replaced_contended_path_instead_of_reporting_busy() {
        let fixture = Fixture::new();
        let path = fixture.paths.netns_pool(0);
        let _holder = flock(fixture.create_lock(&path));
        let mut replaced = false;

        let claim = try_lock_file_with(&path, OpenPolicy::CLAIM, |_, path| {
            if !replaced {
                std::fs::remove_file(path).unwrap();
                let replacement = base_open_options()
                    .create(true)
                    .truncate(false)
                    .mode(PRIVATE_FILE_MODE)
                    .open(path)
                    .unwrap();
                drop(replacement);
                replaced = true;
            }
        })
        .unwrap();
        assert!(matches!(claim, FileClaim::Acquired(_)));
    }

    #[test]
    fn replacement_retries_are_bounded() {
        let fixture = Fixture::new();
        let path = fixture.paths.netns_pool(0);
        fixture.create_lock(&path);
        let mut replacements = 0;

        let error = try_lock_file_with(&path, OpenPolicy::CLAIM, |_, path| {
            std::fs::remove_file(path).unwrap();
            let replacement = base_open_options()
                .create(true)
                .truncate(false)
                .mode(PRIVATE_FILE_MODE)
                .open(path)
                .unwrap();
            drop(replacement);
            replacements += 1;
        })
        .unwrap_err();
        assert_eq!(replacements, MAX_STALE_INODE_RETRIES);
        assert!(error.to_string().contains("changed during"));
    }

    #[test]
    fn allocation_skips_unsafe_index_but_preserves_terminal_error() {
        let fixture = Fixture::new();
        let target = fixture.paths.netns_pool(63);
        fixture.create_lock(&target);
        symlink(&target, fixture.paths.netns_pool(0)).unwrap();

        let mut claims = Vec::new();
        for expected in 1..MAX_POOLS {
            let claim = acquire_pool_lock(&fixture.paths).unwrap();
            assert_eq!(claim.index(), expected);
            claims.push(claim);
        }
        assert!(matches!(
            acquire_pool_lock(&fixture.paths),
            Err(NetworkError::PoolLock(_))
        ));
    }

    #[test]
    fn ordinary_contention_returns_pool_exhaustion() {
        let fixture = Fixture::new();
        let claims: Vec<_> = (0..MAX_POOLS)
            .map(|_| acquire_pool_lock(&fixture.paths).unwrap())
            .collect();
        assert_eq!(claims.len(), MAX_POOLS as usize);
        assert!(matches!(
            acquire_pool_lock(&fixture.paths),
            Err(NetworkError::NoPoolIndexAvailable)
        ));
    }

    #[test]
    fn probe_distinguishes_idle_legacy_and_private_owners() {
        let fixture = Fixture::new();
        assert_eq!(
            probe_netns_pool_lock_with_paths(&fixture.paths, 0).unwrap(),
            NetnsPoolLockStatus::Idle
        );
        assert!(!fixture.paths.netns_pool(0).exists());
        assert!(!fixture.paths.private_netns_pool(0).exists());

        let legacy_path = fixture.paths.netns_pool(0);
        let legacy_holder = flock(fixture.create_lock(&legacy_path));
        assert_eq!(
            probe_netns_pool_lock_with_paths(&fixture.paths, 0).unwrap(),
            NetnsPoolLockStatus::Active
        );
        drop(legacy_holder);
        std::fs::remove_file(legacy_path).unwrap();

        let private_path = fixture.paths.private_netns_pool(0);
        let _private_holder = flock(fixture.create_lock(&private_path));
        assert_eq!(
            probe_netns_pool_lock_with_paths(&fixture.paths, 0).unwrap(),
            NetnsPoolLockStatus::Active
        );
    }

    #[test]
    fn idle_probe_does_not_create_runtime_namespace() {
        let fixture = Fixture::unprepared();

        assert_eq!(
            probe_netns_pool_lock_with_paths(&fixture.paths, 0).unwrap(),
            NetnsPoolLockStatus::Idle
        );
        assert!(!fixture.paths.runtime_base().exists());
        assert!(!fixture.paths.private_base().exists());
    }

    #[test]
    fn probe_reports_unsafe_file_without_changing_it() {
        let fixture = Fixture::new();
        let path = fixture.paths.netns_pool(0);
        fixture.create_lock(&path);
        std::fs::set_permissions(&path, Permissions::from_mode(0o622)).unwrap();

        assert!(probe_netns_pool_lock_with_paths(&fixture.paths, 0).is_err());
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o622
        );
    }

    #[test]
    fn probe_does_not_tighten_compatible_legacy_mode() {
        let fixture = Fixture::new();
        let path = fixture.paths.netns_pool(0);
        fixture.create_lock(&path);
        std::fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();

        assert_eq!(
            probe_netns_pool_lock_with_paths(&fixture.paths, 0).unwrap(),
            NetnsPoolLockStatus::Idle
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn rejects_unsafe_private_lock_file() {
        let fixture = Fixture::new();
        let path = fixture.paths.private_netns_pool(0);
        fixture.create_lock(&path);
        std::fs::set_permissions(&path, Permissions::from_mode(0o602)).unwrap();

        assert!(try_claim_complete(&fixture.paths, 0).is_err());
        assert!(matches!(
            try_lock_file(&fixture.paths.netns_pool(0), OpenPolicy::CLAIM).unwrap(),
            FileClaim::Acquired(_)
        ));
    }

    #[test]
    fn probe_rejects_invalid_private_directory_without_repairing_it() {
        let fixture = Fixture::new();
        std::fs::set_permissions(fixture.paths.private_base(), Permissions::from_mode(0o755))
            .unwrap();

        assert!(probe_netns_pool_lock_with_paths(&fixture.paths, 0).is_err());
        assert_eq!(
            std::fs::metadata(fixture.paths.private_base())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[test]
    fn legacy_owner_is_active_without_requiring_private_directory() {
        let fixture = Fixture::new();
        let legacy_path = fixture.paths.netns_pool(0);
        let _legacy_holder = flock(fixture.create_lock(&legacy_path));
        std::fs::set_permissions(fixture.paths.private_base(), Permissions::from_mode(0o755))
            .unwrap();

        assert_eq!(
            probe_netns_pool_lock_with_paths(&fixture.paths, 0).unwrap(),
            NetnsPoolLockStatus::Active
        );
    }

    #[test]
    fn owner_policy_rejects_a_different_uid() {
        assert!(lock_file_owner_is_trusted(1000, 1000));
        assert!(!lock_file_owner_is_trusted(1001, 1000));
    }
}
