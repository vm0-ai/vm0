use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use clap::Args;
use nix::fcntl::{Flock, FlockArg};
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

#[derive(Args)]
pub struct GcArgs {
    /// Show what would be deleted without actually deleting
    #[arg(long)]
    dry_run: bool,
    /// Keep the N most recent unused versions (by modification time)
    #[arg(long)]
    keep_latest: Option<usize>,
}

pub async fn run_gc(args: GcArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;

    let rootfs_freed = gc_dir(
        "rootfs",
        &home.rootfs_dir(),
        |hash| home.rootfs_lock(hash),
        args.keep_latest,
        args.dry_run,
    )
    .await?;

    let snapshot_freed = gc_dir(
        "snapshots",
        &home.snapshots_dir(),
        |hash| home.snapshot_lock(hash),
        args.keep_latest,
        args.dry_run,
    )
    .await?;

    let total = rootfs_freed + snapshot_freed;
    if total == 0 {
        info!("nothing to clean up");
    } else if args.dry_run {
        info!("total: {} would be freed", human_bytes(total));
    } else {
        info!("total: {} freed", human_bytes(total));
    }

    Ok(())
}

/// An unused artifact directory whose exclusive lock is held to prevent races.
struct GcCandidate {
    path: PathBuf,
    hash: String,
    size: u64,
    mtime: SystemTime,
    /// Exclusive lock held until the candidate is deleted or explicitly kept.
    /// Prevents a `runner start` from acquiring a shared lock between probe and delete.
    _lock: Flock<std::fs::File>,
}

/// GC a single artifact directory (rootfs/ or snapshots/).
///
/// Each subdirectory is named by its content hash. We try an exclusive nonblocking
/// flock on the corresponding lock file — if it succeeds the resource is unused.
/// The exclusive lock is held until deletion to prevent TOCTOU races.
async fn gc_dir(
    label: &str,
    dir: &Path,
    lock_path_fn: impl Fn(&str) -> PathBuf,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read {}: {e}",
                dir.display()
            )));
        }
    };

    let mut candidates: Vec<GcCandidate> = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| RunnerError::Internal(format!("read entry in {}: {e}", dir.display())))?
    {
        let path = entry.path();
        let Some(hash) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };

        let lock_path = lock_path_fn(&hash);
        match probe_lock(&lock_path) {
            LockProbe::Free(lock) => {
                let (size, mtime) = dir_stats(&path).await;
                candidates.push(GcCandidate {
                    path,
                    hash,
                    size,
                    mtime,
                    _lock: lock,
                });
            }
            LockProbe::Held => {
                info!("{label}/{hash}: in use, skipping");
            }
            LockProbe::Error(e) => {
                info!("{label}/{hash}: lock probe failed ({e}), skipping");
            }
        }
    }

    // Sort by mtime descending (newest first) so keep_latest keeps the most recent.
    candidates.sort_by(|a, b| b.mtime.cmp(&a.mtime));

    let keep_count = keep_latest.unwrap_or(0);
    for c in candidates.iter().take(keep_count) {
        info!(
            "{label}/{}: keeping (latest unused, {})",
            c.hash,
            human_bytes(c.size)
        );
    }

    let mut freed = 0u64;
    for c in candidates.iter().skip(keep_count) {
        if dry_run {
            info!(
                "[dry-run] would delete {label}/{} ({})",
                c.hash,
                human_bytes(c.size)
            );
        } else {
            tokio::fs::remove_dir_all(&c.path)
                .await
                .map_err(|e| RunnerError::Internal(format!("remove {}: {e}", c.path.display())))?;
            info!("deleted {label}/{} ({})", c.hash, human_bytes(c.size));
        }
        freed += c.size;
    }

    Ok(freed)
}

enum LockProbe {
    /// Lock acquired — resource is not in use.
    Free(Flock<std::fs::File>),
    /// Lock held by another process.
    Held,
    /// Could not probe (file error).
    Error(String),
}

/// Try a nonblocking exclusive flock to check if a resource is in use.
fn probe_lock(path: &Path) -> LockProbe {
    let file = match crate::lock::open_lock_file(path) {
        Ok(f) => f,
        Err(e) => return LockProbe::Error(e.to_string()),
    };
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => LockProbe::Free(lock),
        Err((_, e)) if e == nix::errno::Errno::EWOULDBLOCK => LockProbe::Held,
        Err((_, e)) => LockProbe::Error(e.to_string()),
    }
}

/// Compute total disk usage (st_blocks * 512) and latest mtime for a directory.
async fn dir_stats(dir: &Path) -> (u64, SystemTime) {
    let mut total_blocks = 0u64;
    let mut latest_mtime = SystemTime::UNIX_EPOCH;

    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(e) => {
                tracing::debug!("dir_stats: cannot read {}: {e}", current.display());
                continue;
            }
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                tracing::debug!("dir_stats: cannot stat {}", entry.path().display());
                continue;
            };
            const BYTES_PER_BLOCK: u64 = 512;
            total_blocks += meta.blocks() * BYTES_PER_BLOCK;
            if let Ok(mtime) = meta.modified()
                && mtime > latest_mtime
            {
                latest_mtime = mtime;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            }
        }
    }

    (total_blocks, latest_mtime)
}

fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.1} GiB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.1} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_formats_correctly() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MiB");
        assert_eq!(human_bytes(1024 * 1024 * 1024), "1.0 GiB");
    }

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

    #[tokio::test]
    async fn gc_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        std::fs::create_dir_all(&artifacts_dir).unwrap();

        let freed = gc_dir(
            "rootfs",
            &artifacts_dir,
            |hash| locks_dir.join(format!("rootfs-{hash}.lock")),
            None,
            false,
        )
        .await
        .unwrap();
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_deletes_unused_dir() {
        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let hash_dir = artifacts_dir.join("abc123");
        std::fs::create_dir_all(&hash_dir).unwrap();
        std::fs::write(hash_dir.join("rootfs.squashfs"), b"data").unwrap();

        let freed = gc_dir(
            "rootfs",
            &artifacts_dir,
            |hash| locks_dir.join(format!("rootfs-{hash}.lock")),
            None,
            false,
        )
        .await
        .unwrap();

        assert!(!hash_dir.exists(), "dir should be deleted");
        assert!(freed > 0 || cfg!(target_os = "macos")); // blocks may be 0 on some FS
    }

    #[tokio::test]
    async fn gc_skips_locked_dir() {
        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let hash_dir = artifacts_dir.join("abc123");
        std::fs::create_dir_all(&hash_dir).unwrap();
        std::fs::write(hash_dir.join("rootfs.squashfs"), b"data").unwrap();

        // Hold a shared lock (simulating runner start).
        let lock_path = locks_dir.join("rootfs-abc123.lock");
        let file = std::fs::File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        let _shared = Flock::lock(file, FlockArg::LockShared).unwrap();

        let freed = gc_dir(
            "rootfs",
            &artifacts_dir,
            |hash| locks_dir.join(format!("rootfs-{hash}.lock")),
            None,
            false,
        )
        .await
        .unwrap();

        assert!(hash_dir.exists(), "dir should NOT be deleted");
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_dry_run_does_not_delete() {
        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let hash_dir = artifacts_dir.join("abc123");
        std::fs::create_dir_all(&hash_dir).unwrap();
        std::fs::write(hash_dir.join("rootfs.squashfs"), b"data").unwrap();

        let freed = gc_dir(
            "rootfs",
            &artifacts_dir,
            |hash| locks_dir.join(format!("rootfs-{hash}.lock")),
            None,
            true,
        )
        .await
        .unwrap();

        assert!(hash_dir.exists(), "dry-run should not delete");
        assert!(freed > 0 || cfg!(target_os = "macos"));
    }

    #[tokio::test]
    async fn gc_keep_latest_preserves_newest() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("snapshots");

        // Create two dirs and set explicit mtimes for determinism.
        let old_dir = artifacts_dir.join("old_hash");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_file_path = old_dir.join("snapshot.bin");
        std::fs::write(&old_file_path, b"old").unwrap();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&old_file_path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let new_dir = artifacts_dir.join("new_hash");
        std::fs::create_dir_all(&new_dir).unwrap();
        let new_file_path = new_dir.join("snapshot.bin");
        std::fs::write(&new_file_path, b"new").unwrap();
        let new_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        std::fs::File::open(&new_file_path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(new_time))
            .unwrap();

        gc_dir(
            "snapshots",
            &artifacts_dir,
            |hash| locks_dir.join(format!("snapshot-{hash}.lock")),
            Some(1),
            false,
        )
        .await
        .unwrap();

        assert!(new_dir.exists(), "newest should be kept");
        assert!(!old_dir.exists(), "oldest should be deleted");
    }

    #[tokio::test]
    async fn gc_nonexistent_dir_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let freed = gc_dir(
            "rootfs",
            &dir.path().join("nonexistent"),
            |hash| dir.path().join(format!("{hash}.lock")),
            None,
            false,
        )
        .await
        .unwrap();
        assert_eq!(freed, 0);
    }
}
