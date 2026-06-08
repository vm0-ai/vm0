use std::fs::File;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

use crate::error::{RunnerError, RunnerResult};
use crate::host_file::{self, DirMode, PRIVATE_FILE_MODE};

const LOCK_BUSY_ERROR: &str = "lock is already held by another process";
const LOCK_REPLACED_MAX_RETRIES: usize = 64;

/// Open (or create) the lock file, creating parent directories as needed.
pub(crate) fn open_lock_file(path: &Path) -> RunnerResult<File> {
    let parent = host_file::file_parent(path);
    host_file::ensure_dir(parent, DirMode::TrustedParent, "lock directory")
        .map_err(|e| RunnerError::Internal(format!("create lock dir {}: {e}", parent.display())))?;

    let file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(PRIVATE_FILE_MODE)
        .custom_flags(host_file::private_file_open_flags())
        .open(path)
        .map_err(|e| RunnerError::Internal(format!("open lock {}: {e}", path.display())))?;
    host_file::secure_regular_private_file(&file, path, "lock file")
        .map_err(|e| RunnerError::Internal(format!("validate lock {}: {e}", path.display())))?;
    Ok(file)
}

/// Check whether the locked fd still refers to the file currently at `path`.
///
/// Returns `false` if the file was unlinked and recreated (stale inode),
/// meaning the caller should retry lock acquisition.
fn is_current_inode(lock: &Flock<File>, path: &Path) -> bool {
    let Ok(lock_meta) = lock.metadata() else {
        return true;
    };
    let Ok(path_meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino()
}

#[derive(Clone, Copy)]
enum LockMode {
    Exclusive,
    Shared,
    TryExclusive,
}

impl LockMode {
    fn arg(self) -> FlockArg {
        match self {
            Self::Exclusive => FlockArg::LockExclusive,
            Self::Shared => FlockArg::LockShared,
            Self::TryExclusive => FlockArg::LockExclusiveNonblock,
        }
    }

    fn map_error(self, path: &Path, e: nix::errno::Errno) -> RunnerError {
        RunnerError::Internal(format!("flock {}: {e}", path.display()))
    }
}

pub(crate) enum TryLock {
    Acquired(Flock<File>),
    Busy,
}

enum LockAcquire {
    Acquired(Flock<File>),
    Busy,
}

async fn acquire_result_with(path: PathBuf, mode: LockMode) -> RunnerResult<LockAcquire> {
    tokio::task::spawn_blocking(move || acquire_result_blocking(&path, mode, |_| Ok(())))
        .await
        .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

fn acquire_result_blocking(
    path: &Path,
    mode: LockMode,
    mut after_lock: impl FnMut(&Path) -> RunnerResult<()>,
) -> RunnerResult<LockAcquire> {
    for _ in 0..LOCK_REPLACED_MAX_RETRIES {
        let file = open_lock_file(path)?;
        let lock = match Flock::lock(file, mode.arg()) {
            Ok(lock) => lock,
            Err((_file, e))
                if matches!(mode, LockMode::TryExclusive)
                    && e == nix::errno::Errno::EWOULDBLOCK =>
            {
                return Ok(LockAcquire::Busy);
            }
            Err((_file, e)) => return Err(mode.map_error(path, e)),
        };
        after_lock(path)?;
        if is_current_inode(&lock, path) {
            return Ok(LockAcquire::Acquired(lock));
        }
    }
    Err(RunnerError::Internal(format!(
        "lock {} was repeatedly replaced while acquiring",
        path.display()
    )))
}

async fn acquire_with(path: PathBuf, mode: LockMode) -> RunnerResult<Flock<File>> {
    match acquire_result_with(path, mode).await? {
        LockAcquire::Acquired(lock) => Ok(lock),
        LockAcquire::Busy => Err(RunnerError::Config(LOCK_BUSY_ERROR.into())),
    }
}

/// Acquire an exclusive flock on the given path, blocking until available.
///
/// The returned guard holds the lock until dropped.
pub async fn acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::Exclusive).await
}

/// Acquire a shared flock on the given path, blocking until available.
///
/// Multiple shared locks can coexist; only exclusive locks conflict.
/// The returned guard holds the lock until dropped.
pub async fn acquire_shared(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::Shared).await
}

/// Try to acquire an exclusive flock, returning an error immediately if held by another process.
///
/// The returned guard holds the lock until dropped.
pub async fn try_acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::TryExclusive).await
}

pub async fn try_acquire_or_busy(path: PathBuf) -> RunnerResult<TryLock> {
    match acquire_result_with(path, LockMode::TryExclusive).await? {
        LockAcquire::Acquired(lock) => Ok(TryLock::Acquired(lock)),
        LockAcquire::Busy => Ok(TryLock::Busy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn acquire_creates_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();
        assert!(path.exists());
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_creates_private_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();

        assert_eq!(mode(&path), 0o600);
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_tightens_existing_safe_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        std::fs::write(&path, b"base-dir").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let guard = acquire(path.clone()).await.unwrap();

        assert_eq!(mode(&path), 0o600);
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_rejects_symlink_lock_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.lock");
        let path = dir.path().join("test.lock");
        std::fs::write(&target, b"target").unwrap();
        symlink(&target, &path).unwrap();

        let error = acquire(path).await.unwrap_err();

        assert!(
            error.to_string().contains("open lock"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"target");
    }

    #[tokio::test]
    async fn acquire_rejects_fifo_lock_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();

        let error = acquire(path).await.unwrap_err();

        assert!(
            error.to_string().contains("regular lock file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn acquire_rejects_directory_lock_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        std::fs::create_dir(&path).unwrap();

        let error = acquire(path).await.unwrap_err();

        assert!(
            error.to_string().contains("open lock")
                || error.to_string().contains("regular lock file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn acquire_rejects_group_writable_direct_parent() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("unsafe");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
        let path = parent.join("test.lock");

        let error = acquire(path.clone()).await.unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn acquire_allows_sticky_intermediate_parent_but_rejects_sticky_direct_parent() {
        let dir = tempfile::tempdir().unwrap();
        let sticky = dir.path().join("sticky");
        std::fs::create_dir(&sticky).unwrap();
        std::fs::set_permissions(&sticky, std::fs::Permissions::from_mode(0o1777)).unwrap();

        let direct_path = sticky.join("direct.lock");
        let error = acquire(direct_path.clone()).await.unwrap_err();
        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(!direct_path.exists());

        let nested_path = sticky.join("private").join("nested.lock");
        let guard = acquire(nested_path.clone()).await.unwrap();
        assert_eq!(mode(&nested_path), 0o600);
        drop(guard);
    }

    #[test]
    fn acquire_returns_bounded_error_when_lock_path_keeps_being_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let mut replacements = 0;

        let result = acquire_result_blocking(&path, LockMode::Exclusive, |path| {
            replacements += 1;
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(RunnerError::Internal(format!(
                        "remove replaced lock {}: {e}",
                        path.display()
                    )));
                }
            }
            std::fs::write(path, b"replacement").map_err(|e| {
                RunnerError::Internal(format!("write replaced lock {}: {e}", path.display()))
            })
        });
        let error = match result {
            Ok(_) => panic!("lock acquisition should fail after repeated replacement"),
            Err(error) => error,
        };

        assert_eq!(replacements, LOCK_REPLACED_MAX_RETRIES);
        assert!(
            error.to_string().contains("repeatedly replaced"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn held_lock_blocks_nonblocking_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        // Hold the lock via acquire().
        let _guard = acquire(path.clone()).await.unwrap();

        // A non-blocking attempt on the same file must fail with EWOULDBLOCK.
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let err = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap_err();
        assert_eq!(err.1, nix::errno::Errno::EWOULDBLOCK);
    }

    #[tokio::test]
    async fn lock_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();
        drop(guard);

        // After drop, a non-blocking lock should succeed.
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let _lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap();
    }

    #[tokio::test]
    async fn acquire_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b").join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();
        assert!(path.exists());
        drop(guard);
    }

    #[tokio::test]
    async fn try_acquire_fails_when_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard = acquire(path.clone()).await.unwrap();
        let err = try_acquire(path).await.unwrap_err();
        assert!(err.to_string().contains("already held by another process"));
    }

    #[tokio::test]
    async fn try_acquire_succeeds_when_free() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = try_acquire(path.clone()).await.unwrap();
        assert!(path.exists());
        drop(guard);
    }

    #[tokio::test]
    async fn try_acquire_or_busy_reports_busy_when_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let _guard = acquire(path.clone()).await.unwrap();

        let result = try_acquire_or_busy(path).await.unwrap();

        assert!(matches!(result, TryLock::Busy));
    }

    #[tokio::test]
    async fn try_acquire_or_busy_propagates_lock_path_errors() {
        let path = PathBuf::from("/dev/null/impossible/test.lock");

        let result = try_acquire_or_busy(path).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn shared_locks_coexist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard1 = acquire_shared(path.clone()).await.unwrap();
        let _guard2 = acquire_shared(path.clone()).await.unwrap();
        // Both held simultaneously — no conflict.
    }

    #[tokio::test]
    async fn shared_lock_blocks_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard = acquire_shared(path.clone()).await.unwrap();
        let err = try_acquire(path).await.unwrap_err();
        assert!(err.to_string().contains("already held by another process"));
    }

    #[tokio::test]
    async fn exclusive_blocks_shared_nonblocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard = acquire(path.clone()).await.unwrap();

        // A nonblocking shared attempt must fail.
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let err = Flock::lock(file, FlockArg::LockSharedNonblock).unwrap_err();
        assert_eq!(err.1, nix::errno::Errno::EWOULDBLOCK);
    }

    #[tokio::test]
    async fn invalid_path_returns_error() {
        // /dev/null is a file, so create_dir_all cannot create a child directory
        // inside it — this fails even as root.
        let path = PathBuf::from("/dev/null/impossible/test.lock");
        let result = acquire(path).await;
        assert!(result.is_err());
    }
}
