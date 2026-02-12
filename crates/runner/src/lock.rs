use std::path::PathBuf;

use nix::fcntl::{Flock, FlockArg};

use crate::error::{RunnerError, RunnerResult};

/// Acquire an exclusive flock on the given path, blocking until available.
///
/// The returned guard holds the lock until dropped.
pub async fn acquire(path: PathBuf) -> RunnerResult<Flock<std::fs::File>> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| RunnerError::Internal(format!("open lock {}: {e}", path.display())))?;
        Flock::lock(file, FlockArg::LockExclusive)
            .map_err(|(_file, e)| RunnerError::Internal(format!("flock {}: {e}", path.display())))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}
