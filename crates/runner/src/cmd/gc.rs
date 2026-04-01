use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use clap::Args;
use nix::fcntl::{Flock, FlockArg};
use tracing::info;

use crate::cmd::service;
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, LogPaths};

/// Artifacts younger than this are unconditionally kept, regardless of lock
/// status or `--keep-latest`. This prevents races between `runner build`
/// releasing its lock and `runner start` acquiring a shared lock.
const GC_MIN_AGE: Duration = Duration::from_secs(10 * 60);

/// Per-job log files older than this are eligible for GC.
const JOB_LOG_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

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

    let locks_removed = gc_orphaned_locks(&home, args.dry_run).await?;
    let (job_logs_removed, job_logs_freed) = gc_job_logs(&home, args.dry_run).await?;
    let versions_removed = gc_versions(&home, args.dry_run).await?;

    let nbd_orphans = gc_nbd_orphans(args.dry_run).await?;

    let total = rootfs_freed + snapshot_freed + job_logs_freed;
    if total == 0
        && locks_removed == 0
        && job_logs_removed == 0
        && versions_removed.is_empty()
        && nbd_orphans == 0
    {
        info!("nothing to clean up");
    } else {
        let verb = if args.dry_run {
            "would be freed"
        } else {
            "freed"
        };
        info!("total: {} {verb}", human_bytes(total));
        if !versions_removed.is_empty() {
            let list = versions_removed.join(", ");
            if args.dry_run {
                info!("versions that would be removed: {list}");
            } else {
                info!("versions removed: {list}");
            }
        }
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

    // Protect recently-created artifacts from deletion. This closes the race
    // window between `runner build` releasing its lock and `runner start`
    // acquiring a shared lock.
    let now = SystemTime::now();
    let mut protected = Vec::new();
    candidates.retain(|c| {
        let age = now.duration_since(c.mtime).unwrap_or_default();
        if age < GC_MIN_AGE {
            protected.push((c.hash.clone(), age));
            false
        } else {
            true
        }
    });
    for (hash, age) in &protected {
        info!(
            "{label}/{hash}: too recent ({}s old), skipping",
            age.as_secs()
        );
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
    let file = match lock::open_lock_file(path) {
        Ok(f) => f,
        Err(e) => return LockProbe::Error(e.to_string()),
    };
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => LockProbe::Free(lock),
        Err((_, e)) if e == nix::errno::Errno::EWOULDBLOCK => LockProbe::Held,
        Err((_, e)) => LockProbe::Error(e.to_string()),
    }
}

/// Remove unused lock files. Any lock file that can be exclusively locked is
/// not held by any process and can be safely deleted — `open_lock_file` will
/// recreate it on next use, and the inode recheck in `lock.rs` prevents races.
async fn gc_orphaned_locks(home: &HomePaths, dry_run: bool) -> RunnerResult<u64> {
    let locks_dir = home.locks_dir();
    let mut entries = match tokio::fs::read_dir(&locks_dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read {}: {e}",
                locks_dir.display()
            )));
        }
    };

    let mut removed = 0u64;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(".lock") {
            continue;
        }

        let lock_path = entry.path();
        match probe_lock(&lock_path) {
            LockProbe::Free(_lock) => {
                if dry_run {
                    info!("[dry-run] would remove unused lock {name}");
                } else {
                    match tokio::fs::remove_file(&lock_path).await {
                        Ok(()) => info!("removed unused lock {name}"),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => {
                            tracing::debug!("cannot remove {}: {e}", lock_path.display());
                        }
                    }
                }
                removed += 1;
            }
            LockProbe::Held | LockProbe::Error(_) => {}
        }
    }

    Ok(removed)
}

/// Delete stale log files (older than [`JOB_LOG_MAX_AGE`]).
///
/// Covers per-job logs (`network-*.jsonl`, `system-*.log`, `metrics-*.jsonl`)
/// and runner instance logs (`runner-*.log`). Returns `(files_removed, bytes_freed)`.
async fn gc_job_logs(home: &HomePaths, dry_run: bool) -> RunnerResult<(u64, u64)> {
    let logs_dir = home.logs_dir();
    let mut entries = match tokio::fs::read_dir(&logs_dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read {}: {e}",
                logs_dir.display()
            )));
        }
    };

    let now = SystemTime::now();
    let mut removed = 0u64;
    let mut freed = 0u64;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };

        if !LogPaths::is_gc_eligible_log(name) {
            continue;
        }

        let Ok(meta) = entry.metadata().await else {
            continue;
        };

        let age = meta
            .modified()
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok())
            .unwrap_or_default();

        if age <= JOB_LOG_MAX_AGE {
            continue;
        }

        let size = meta.blocks() * 512;
        if dry_run {
            info!(
                "[dry-run] would delete job log {name} ({})",
                human_bytes(size)
            );
        } else {
            match tokio::fs::remove_file(entry.path()).await {
                Ok(()) => {
                    info!("deleted job log {name} ({})", human_bytes(size));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::debug!("cannot remove {}: {e}", entry.path().display());
                    continue;
                }
            }
        }
        removed += 1;
        freed += size;
    }

    Ok((removed, freed))
}

/// Compute total disk usage (st_blocks * 512) and last-used time for a directory.
///
/// Last-used time comes from the root directory's own mtime, which `touch_mtime`
/// updates on every cache hit and `runner start`.
async fn dir_stats(dir: &Path) -> (u64, SystemTime) {
    let mtime = match tokio::fs::metadata(dir).await {
        Ok(meta) => meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        Err(_) => SystemTime::UNIX_EPOCH,
    };

    let mut total_bytes = 0u64;
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
            total_bytes += meta.blocks() * BYTES_PER_BLOCK;
            if meta.is_dir() {
                stack.push(entry.path());
            }
        }
    }

    (total_bytes, mtime)
}

/// Check whether a directory name is a semver version string (`v<major>.<minor>.<patch>`).
fn is_semver_version(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<&str> = rest.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| p.parse::<u32>().is_ok())
}

/// Remove old deployment version directories that are not actively running.
///
/// Scans `home.bin_dir()` for semver-named subdirectories (e.g. `v0.2.0`), checks
/// whether the corresponding systemd unit is active, and deletes inactive versions
/// (bin dir, runner config dir, and systemd unit).
async fn gc_versions(home: &HomePaths, dry_run: bool) -> RunnerResult<Vec<String>> {
    let bin_dir = home.bin_dir();
    let mut entries = match tokio::fs::read_dir(&bin_dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read {}: {e}",
                bin_dir.display()
            )));
        }
    };

    let mut removed: Vec<String> = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| RunnerError::Internal(format!("read entry in {}: {e}", bin_dir.display())))?
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_semver_version(name) {
            continue;
        }

        // Check if the corresponding systemd unit is active — skip if so.
        let unit = match service::unit_name(name) {
            Ok(u) => u,
            Err(_) => continue,
        };
        match service::is_unit_active(&unit).await {
            Ok(true) => {
                info!("version {name}: active, skipping");
                continue;
            }
            Ok(false) => {}
            Err(e) => {
                // systemctl unavailable (e.g. in tests or broken PATH).
                // Log and treat as inactive — the version dir will still be
                // removed, which is preferable to silently accumulating stale
                // versions when systemd units are already gone.
                tracing::debug!(
                    "version {name}: cannot check unit status ({e}), assuming inactive"
                );
            }
        }

        if dry_run {
            info!("[dry-run] would remove version {name}");
        } else {
            // Best-effort uninstall the systemd service (may not exist).
            let _ = service::uninstall_service(name).await;

            // Remove bin directory.
            let version_bin = bin_dir.join(name);
            if let Err(e) = tokio::fs::remove_dir_all(&version_bin).await
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::debug!("cannot remove {}: {e}", version_bin.display());
                continue;
            }

            // Best-effort remove runner config directory.
            let version_config = home.runners_dir().join(name);
            let _ = tokio::fs::remove_dir_all(&version_config).await;

            info!("removed version {name}");
        }
        removed.push(name.to_string());
    }

    Ok(removed)
}

/// Scan for NBD devices whose owning process has exited (orphans) and
/// optionally disconnect them. Returns the number of orphans cleaned.
async fn gc_nbd_orphans(dry_run: bool) -> RunnerResult<u32> {
    let (max_devs, orphans) = tokio::task::spawn_blocking(super::nbd::find_nbd_orphans)
        .await
        .map_err(|e| RunnerError::Internal(format!("nbd orphan scan task failed: {e}")))?;

    if orphans.is_empty() {
        tracing::debug!("nbd: scanned {max_devs} devices, no orphans");
        return Ok(0);
    }

    let found = orphans.len() as u32;
    let mut cleaned: u32 = 0;
    for (device_index, pid) in orphans {
        if dry_run {
            info!(
                "[dry-run] would disconnect orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
            );
            cleaned += 1;
        } else {
            // Re-check before disconnect: between the scan and now, the device
            // could have been freed and re-acquired by another runner. Only
            // disconnect if the PID is unchanged and still dead.
            let result = match tokio::task::spawn_blocking(move || {
                match super::nbd::read_nbd_pid(device_index) {
                    Some(current_pid) if current_pid == pid
                        && !Path::new(&format!("/proc/{pid}")).exists() =>
                    {
                        Some(nbd_cow::netlink::disconnect(device_index))
                    }
                    _ => {
                        tracing::debug!(
                            "nbd{device_index}: skipping disconnect, device state changed since scan"
                        );
                        None
                    }
                }
            })
            .await
            {
                Ok(result) => result,
                Err(e) => {
                    tracing::warn!(
                        "nbd disconnect task failed for /dev/nbd{device_index}: {e}"
                    );
                    continue;
                }
            };

            match result {
                Some(Ok(())) => {
                    info!(
                        "disconnected orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
                    );
                    cleaned += 1;
                }
                Some(Err(e)) => {
                    info!("failed to disconnect orphan NBD device /dev/nbd{device_index}: {e}");
                }
                None => {} // skipped — already logged at debug level
            }
        }
    }

    if cleaned < found {
        info!("nbd orphans: {found} found, {cleaned} cleaned");
    }

    Ok(cleaned)
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
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let hash_dir = artifacts_dir.join("abc123");
        std::fs::create_dir_all(&hash_dir).unwrap();
        std::fs::write(hash_dir.join("rootfs.ext4"), b"data").unwrap();
        // Set mtime past GC_MIN_AGE so the artifact is eligible for deletion.
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&hash_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

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
        std::fs::write(hash_dir.join("rootfs.ext4"), b"data").unwrap();

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
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let hash_dir = artifacts_dir.join("abc123");
        std::fs::create_dir_all(&hash_dir).unwrap();
        std::fs::write(hash_dir.join("rootfs.ext4"), b"data").unwrap();
        // Set mtime past GC_MIN_AGE so the artifact is eligible for deletion.
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&hash_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

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

        // Create two dirs and set explicit directory mtimes for determinism.
        // dir_stats uses the root directory mtime as the "last used" signal.
        let old_dir = artifacts_dir.join("old_hash");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("snapshot.bin"), b"old").unwrap();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&old_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let new_dir = artifacts_dir.join("new_hash");
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(new_dir.join("snapshot.bin"), b"new").unwrap();
        let new_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        std::fs::File::open(&new_dir)
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

    fn test_home(root: &Path) -> HomePaths {
        HomePaths::with_root(root.to_path_buf())
    }

    #[tokio::test]
    async fn gc_job_logs_deletes_stale() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let old_file = logs_dir.join("network-550e8400-e29b-41d4-a716-446655440000.jsonl");
        std::fs::write(&old_file, r#"{"timestamp":"2026-01-01T00:00:00"}"#).unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        std::fs::File::open(&old_file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (removed, _freed) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 1);
        assert!(!old_file.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_keeps_recent() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let recent = logs_dir.join("network-aabbccdd-1234-5678-9abc-def012345678.jsonl");
        std::fs::write(&recent, r#"{"timestamp":"2026-02-18T00:00:00"}"#).unwrap();

        let (removed, _) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 0);
        assert!(recent.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_deletes_stale_runner_logs() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        // Old runner log file — should be deleted.
        let runner_log = logs_dir.join("runner-default.2026-02-10.log");
        std::fs::write(&runner_log, "log content").unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        std::fs::File::open(&runner_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (removed, _) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 1);
        assert!(!runner_log.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_keeps_recent_runner_logs() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        // Recent runner log — should be kept.
        let runner_log = logs_dir.join("runner-default.2026-03-19.log");
        std::fs::write(&runner_log, "log content").unwrap();

        let (removed, _) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 0);
        assert!(runner_log.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_keeps_at_boundary() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        // File just under 7 days old — should be kept (age <= MAX_AGE).
        // Subtract 1 second less than max age to avoid race between set_times and check.
        let boundary = logs_dir.join("network-11111111-1111-1111-1111-111111111111.jsonl");
        std::fs::write(&boundary, r#"{"timestamp":"2026-02-11T00:00:00"}"#).unwrap();
        let boundary_time = SystemTime::now() - JOB_LOG_MAX_AGE + Duration::from_secs(1);
        std::fs::File::open(&boundary)
            .unwrap()
            .set_times(FileTimes::new().set_modified(boundary_time))
            .unwrap();

        let (removed, _) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 0);
        assert!(boundary.exists(), "file at max age should be kept");
    }

    #[test]
    fn is_semver_version_valid() {
        assert!(is_semver_version("v1.0.0"));
        assert!(is_semver_version("v0.2.10"));
        assert!(is_semver_version("v12.34.56"));
    }

    #[test]
    fn is_semver_version_invalid() {
        assert!(!is_semver_version("staging"));
        assert!(!is_semver_version("test-abc"));
        assert!(!is_semver_version("v1.0"));
        assert!(!is_semver_version("v1.0.0-rc1"));
        assert!(!is_semver_version("1.0.0"));
        assert!(!is_semver_version(""));
        assert!(!is_semver_version("v"));
        assert!(!is_semver_version("v1.0.0.0"));
    }

    #[tokio::test]
    async fn gc_versions_removes_inactive_semver_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let bin_dir = home.bin_dir();
        let runners_dir = home.runners_dir();

        // Create semver version dirs in bin/
        std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
        std::fs::create_dir_all(bin_dir.join("v2.0.0")).unwrap();
        // Create a non-semver dir that should be untouched
        std::fs::create_dir_all(bin_dir.join("staging")).unwrap();

        // Create corresponding runner config dirs
        std::fs::create_dir_all(runners_dir.join("v1.0.0")).unwrap();

        // systemctl will fail in test env, so versions are treated as inactive
        let mut removed = gc_versions(&home, false).await.unwrap();
        removed.sort();
        assert_eq!(removed, ["v1.0.0", "v2.0.0"]);
        assert!(!bin_dir.join("v1.0.0").exists());
        assert!(!bin_dir.join("v2.0.0").exists());
        assert!(
            bin_dir.join("staging").exists(),
            "non-semver should be untouched"
        );
        assert!(!runners_dir.join("v1.0.0").exists());
    }

    #[tokio::test]
    async fn gc_versions_dry_run() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let bin_dir = home.bin_dir();

        std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();

        let removed = gc_versions(&home, true).await.unwrap();
        assert_eq!(removed, ["v1.0.0"]);
        assert!(bin_dir.join("v1.0.0").exists(), "dry-run should not delete");
    }

    #[tokio::test]
    async fn gc_versions_empty_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.bin_dir()).unwrap();

        let removed = gc_versions(&home, false).await.unwrap();
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn gc_versions_missing_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        // Don't create bin_dir — should return 0, not error.
        let removed = gc_versions(&home, false).await.unwrap();
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn gc_job_logs_dry_run() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let old_file = logs_dir.join("network-00000000-0000-0000-0000-000000000001.jsonl");
        std::fs::write(&old_file, r#"{"timestamp":"2026-01-01T00:00:00"}"#).unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        std::fs::File::open(&old_file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (removed, _) = gc_job_logs(&home, true).await.unwrap();
        assert_eq!(removed, 1);
        assert!(old_file.exists(), "dry-run should not delete");
    }

    #[tokio::test]
    async fn gc_job_logs_deletes_stale_system_and_metrics() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);

        let system_log = logs_dir.join("system-550e8400-e29b-41d4-a716-446655440000.log");
        std::fs::write(&system_log, "log content").unwrap();
        std::fs::File::open(&system_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let metrics_log = logs_dir.join("metrics-550e8400-e29b-41d4-a716-446655440000.jsonl");
        std::fs::write(&metrics_log, "{}").unwrap();
        std::fs::File::open(&metrics_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (removed, _) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 2);
        assert!(!system_log.exists());
        assert!(!metrics_log.exists());
    }

    #[tokio::test]
    async fn gc_min_age_preserves_recent_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let recent_dir = artifacts_dir.join("recent_hash");
        std::fs::create_dir_all(&recent_dir).unwrap();
        std::fs::write(recent_dir.join("rootfs.ext4"), b"data").unwrap();
        // mtime defaults to now — well within GC_MIN_AGE (10 min)

        let freed = gc_dir(
            "rootfs",
            &artifacts_dir,
            |hash| locks_dir.join(format!("rootfs-{hash}.lock")),
            Some(0), // keep_latest=0 would normally delete everything
            false,
        )
        .await
        .unwrap();

        assert!(recent_dir.exists(), "recent artifact should be protected");
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_min_age_allows_old_artifact_deletion() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let locks_dir = dir.path().join("locks");
        std::fs::create_dir_all(&locks_dir).unwrap();

        let artifacts_dir = dir.path().join("rootfs");
        let old_dir = artifacts_dir.join("old_hash");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("rootfs.ext4"), b"data").unwrap();

        // Set mtime to 1 hour ago — well past GC_MIN_AGE
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&old_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let freed = gc_dir(
            "rootfs",
            &artifacts_dir,
            |hash| locks_dir.join(format!("rootfs-{hash}.lock")),
            Some(0),
            false,
        )
        .await
        .unwrap();

        assert!(!old_dir.exists(), "old artifact should be deleted");
        assert!(freed > 0 || cfg!(target_os = "macos"));
    }

    #[tokio::test]
    async fn gc_nbd_orphans_no_devices() {
        // On CI / dev machines without NBD module, this should return 0 without panicking.
        let count = gc_nbd_orphans(true).await.unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn read_nbd_pid_nonexistent_device() {
        // A device index that almost certainly doesn't exist.
        assert!(crate::cmd::nbd::read_nbd_pid(9999).is_none());
    }

    #[test]
    fn read_nbds_max_returns_default_without_module() {
        // When the NBD module is not loaded, the function should return the default.
        // On CI this is expected; on a host with NBD it returns the actual value.
        let max = crate::cmd::nbd::read_nbds_max();
        assert!(max > 0);
    }
}
