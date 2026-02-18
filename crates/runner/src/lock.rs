use std::fs::File;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

use crate::error::{RunnerError, RunnerResult};

/// Open (or create) the lock file, creating parent directories as needed.
fn open_lock_file(path: &Path) -> RunnerResult<File> {
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

/// Acquire an exclusive flock on the given path, blocking until available.
///
/// The returned guard holds the lock until dropped.
pub async fn acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    tokio::task::spawn_blocking(move || {
        let file = open_lock_file(&path)?;
        Flock::lock(file, FlockArg::LockExclusive)
            .map_err(|(_file, e)| RunnerError::Internal(format!("flock {}: {e}", path.display())))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

/// Try to acquire an exclusive flock, returning an error immediately if held by another process.
///
/// The returned guard holds the lock until dropped.
pub async fn try_acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    tokio::task::spawn_blocking(move || {
        let file = open_lock_file(&path)?;
        Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, e)| {
            if e == nix::errno::Errno::EWOULDBLOCK {
                RunnerError::Config("lock is already held by another process".into())
            } else {
                RunnerError::Internal(format!("flock {}: {e}", path.display()))
            }
        })
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
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
    async fn invalid_path_returns_error() {
        // /dev/null is a file, so create_dir_all cannot create a child directory
        // inside it — this fails even as root.
        let path = PathBuf::from("/dev/null/impossible/test.lock");
        let result = acquire(path).await;
        assert!(result.is_err());
    }
}
