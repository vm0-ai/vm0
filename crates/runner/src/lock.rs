use std::fs::File;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

use crate::error::{RunnerError, RunnerResult};

const LOCK_BUSY_ERROR: &str = "lock is already held by another process";

/// Open (or create) the lock file, creating parent directories as needed.
pub(crate) fn open_lock_file(path: &Path) -> RunnerResult<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            RunnerError::Internal(format!("create lock dir {}: {e}", parent.display()))
        })?;
    }
    File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| RunnerError::Internal(format!("open lock {}: {e}", path.display())))
}

/// Check whether the locked fd still refers to the file currently at `path`.
///
/// Returns `false` if the file was unlinked and recreated (stale inode),
/// meaning the caller should retry lock acquisition.
fn is_current_inode(lock: &Flock<File>, path: &Path) -> bool {
    let Ok(lock_meta) = lock.metadata() else {
        return true;
    };
    let Ok(path_meta) = std::fs::metadata(path) else {
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
    tokio::task::spawn_blocking(move || {
        loop {
            let file = open_lock_file(&path)?;
            let lock = match Flock::lock(file, mode.arg()) {
                Ok(lock) => lock,
                Err((_file, e))
                    if matches!(mode, LockMode::TryExclusive)
                        && e == nix::errno::Errno::EWOULDBLOCK =>
                {
                    return Ok(LockAcquire::Busy);
                }
                Err((_file, e)) => return Err(mode.map_error(&path, e)),
            };
            if is_current_inode(&lock, &path) {
                return Ok(LockAcquire::Acquired(lock));
            }
        }
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
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

    #[tokio::test]
    async fn acquire_creates_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();
        assert!(path.exists());
        drop(guard);
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
