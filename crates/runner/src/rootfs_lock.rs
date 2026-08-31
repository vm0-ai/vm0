//! Rootfs lock identity bridge for rolling Runner deployments.
//!
//! Pre-bridge releases use only `image-{hash}.lock`. Bridge releases acquire
//! that historical identity before the canonical `rootfs-{hash}.lock`, so
//! they coordinate with both pre-bridge and future canonical-only releases.
//! Every caller must acquire rootfs pairs before snapshot locks. Remove the
//! historical guard only after the rollout gate in vm0-ai/vm0#30478.

use std::fs::File;

use nix::fcntl::Flock;

use crate::error::RunnerResult;
use crate::lock::{self, TryLock};
use crate::paths::HomePaths;

pub(crate) struct RootfsLockGuard {
    // Struct fields drop in declaration order. Release the canonical identity
    // first so the historical bridge remains held until the pair is gone.
    _canonical: Flock<File>,
    _legacy: Flock<File>,
}

pub(crate) enum TryRootfsLock {
    Acquired(RootfsLockGuard),
    Busy,
}

pub(crate) async fn acquire(home: &HomePaths, hash: &str) -> RunnerResult<RootfsLockGuard> {
    let legacy = lock::acquire(home.legacy_rootfs_lock(hash)).await?;
    let canonical = lock::acquire(home.rootfs_lock(hash)).await?;
    Ok(RootfsLockGuard {
        _canonical: canonical,
        _legacy: legacy,
    })
}

pub(crate) async fn acquire_shared(home: &HomePaths, hash: &str) -> RunnerResult<RootfsLockGuard> {
    let legacy = lock::acquire_shared(home.legacy_rootfs_lock(hash)).await?;
    let canonical = lock::acquire_shared(home.rootfs_lock(hash)).await?;
    Ok(RootfsLockGuard {
        _canonical: canonical,
        _legacy: legacy,
    })
}

pub(crate) fn try_acquire_or_busy_blocking(
    home: &HomePaths,
    hash: &str,
) -> RunnerResult<TryRootfsLock> {
    let legacy = match lock::try_acquire_or_busy_blocking(&home.legacy_rootfs_lock(hash))? {
        TryLock::Acquired(legacy) => legacy,
        TryLock::Busy => return Ok(TryRootfsLock::Busy),
    };
    let canonical = match lock::try_acquire_or_busy_blocking(&home.rootfs_lock(hash))? {
        TryLock::Acquired(canonical) => canonical,
        TryLock::Busy => return Ok(TryRootfsLock::Busy),
    };
    Ok(TryRootfsLock::Acquired(RootfsLockGuard {
        _canonical: canonical,
        _legacy: legacy,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home(dir: &tempfile::TempDir) -> HomePaths {
        HomePaths::with_root(dir.path().join("runner"))
    }

    async fn assert_exclusive_busy(path: std::path::PathBuf) {
        let result = lock::try_acquire_or_busy(path).await.unwrap();
        assert!(matches!(result, TryLock::Busy));
    }

    #[tokio::test]
    async fn shared_pair_holds_and_releases_both_identities() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(&dir);
        let hash = "shared";

        let guard = acquire_shared(&home, hash).await.unwrap();
        assert_exclusive_busy(home.legacy_rootfs_lock(hash)).await;
        assert_exclusive_busy(home.rootfs_lock(hash)).await;

        drop(guard);
        drop(
            lock::try_acquire(home.legacy_rootfs_lock(hash))
                .await
                .unwrap(),
        );
        drop(lock::try_acquire(home.rootfs_lock(hash)).await.unwrap());
    }

    #[tokio::test]
    async fn exclusive_pair_holds_both_identities() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(&dir);
        let hash = "exclusive";

        let _guard = acquire(&home, hash).await.unwrap();
        assert_exclusive_busy(home.legacy_rootfs_lock(hash)).await;
        assert_exclusive_busy(home.rootfs_lock(hash)).await;
    }

    #[tokio::test]
    async fn nonblocking_pair_is_busy_for_historical_only_holder() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(&dir);
        let hash = "historical-busy";
        let _holder = lock::acquire_shared(home.legacy_rootfs_lock(hash))
            .await
            .unwrap();

        assert!(matches!(
            try_acquire_or_busy_blocking(&home, hash).unwrap(),
            TryRootfsLock::Busy
        ));
    }

    #[tokio::test]
    async fn nonblocking_pair_is_busy_for_canonical_only_holder() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(&dir);
        let hash = "canonical-busy";
        let _holder = lock::acquire_shared(home.rootfs_lock(hash)).await.unwrap();

        assert!(matches!(
            try_acquire_or_busy_blocking(&home, hash).unwrap(),
            TryRootfsLock::Busy
        ));
        drop(
            lock::try_acquire(home.legacy_rootfs_lock(hash))
                .await
                .unwrap(),
        );
    }

    #[tokio::test]
    async fn nonblocking_pair_holds_both_identities() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(&dir);
        let hash = "nonblocking";

        let guard = match try_acquire_or_busy_blocking(&home, hash).unwrap() {
            TryRootfsLock::Acquired(guard) => guard,
            TryRootfsLock::Busy => panic!("unheld pair must be acquired"),
        };
        assert_exclusive_busy(home.legacy_rootfs_lock(hash)).await;
        assert_exclusive_busy(home.rootfs_lock(hash)).await;
        drop(guard);
    }

    #[tokio::test]
    async fn canonical_path_error_releases_historical_guard() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(&dir);
        let hash = "canonical-error";
        std::fs::create_dir_all(home.rootfs_lock(hash)).unwrap();

        let error = match acquire_shared(&home, hash).await {
            Ok(_) => panic!("directory lock path must fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("rootfs-canonical-error.lock"));
        drop(
            lock::try_acquire(home.legacy_rootfs_lock(hash))
                .await
                .unwrap(),
        );
    }
}
