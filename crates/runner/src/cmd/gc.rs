use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use clap::Args;
use nix::fcntl::{Flock, FlockArg};
use tracing::{info, warn};

use crate::cmd::service;
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, LogPaths};
use crate::r2_cache::R2ImageCache;

/// Default TTL for completed R2 image objects. Older objects are deleted by
/// `gc_r2`. 7 days comfortably covers our typical release cadence: an image
/// from the last week's release is still useful for a host that just spun
/// up. If a host has been offline >7 days and the cached image got swept,
/// the next `runner build` does a one-time local rebuild + re-upload — slow
/// but correct.
const R2_DEFAULT_KEEP_DAYS: u64 = 7;

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
    /// TTL for R2 image cache objects (in days). Objects older than this
    /// are deleted from `runner-images/` on R2. Default: 7 days.
    /// Minimum: 1 — `0` would wipe even the just-uploaded image.
    #[arg(long, default_value_t = R2_DEFAULT_KEEP_DAYS, value_parser = clap::value_parser!(u64).range(1..))]
    r2_keep_days: u64,
    /// Version name to protect from GC (e.g. "v0.78.3").
    /// Used during deployment to prevent deleting the version being deployed.
    #[arg(long)]
    protect_version: Option<String>,
}

pub async fn run_gc(args: GcArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;

    let images_freed = gc_nested_images(&home, args.keep_latest, args.dry_run).await?;

    // Workspace GC must run BEFORE orphaned lock cleanup: it reads base_dir
    // paths from lock files to discover workspaces from dead runners. If
    // gc_orphaned_locks runs first, it deletes those lock files and the
    // dead runner's workspaces become undiscoverable.
    let nbd_orphans = gc_nbd_orphans(args.dry_run).await?;
    let (workspace_orphans, workspace_freed) = gc_workspace_orphans(&home, args.dry_run).await?;

    let locks_removed = gc_orphaned_locks(&home, args.dry_run).await?;
    let (job_logs_removed, job_logs_freed) = gc_job_logs(&home, args.dry_run).await?;
    let versions_removed =
        gc_versions(&home, args.dry_run, args.protect_version.as_deref()).await?;

    let debootstrap_freed = gc_debootstrap(&home, args.keep_latest, args.dry_run).await?;

    let (r2_deleted, r2_freed) = gc_r2(args.r2_keep_days, args.dry_run).await;

    let total = images_freed + job_logs_freed + debootstrap_freed + workspace_freed + r2_freed;
    if total == 0
        && locks_removed == 0
        && job_logs_removed == 0
        && versions_removed.is_empty()
        && nbd_orphans == 0
        && workspace_orphans == 0
        && r2_deleted == 0
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

/// Delete R2 image cache objects older than `keep_days`. Errors (R2 not
/// configured, network blip, etc.) are logged and swallowed: GC must not
/// fail the deploy because the cache layer is misconfigured. Returns
/// `(deleted_count, freed_bytes)`.
///
/// Idempotent across the fleet — every host runs the same scan; DELETE on
/// already-absent keys is a no-op success.
async fn gc_r2(keep_days: u64, dry_run: bool) -> (u64, u64) {
    let cache = match R2ImageCache::from_env().await {
        Ok(Some(c)) => c,
        Ok(None) => {
            info!("r2: cache not configured, skipping R2 GC");
            return (0, 0);
        }
        Err(e) => {
            warn!("r2: init failed ({e}), skipping R2 GC");
            return (0, 0);
        }
    };

    if dry_run {
        // No safe dry-run: list_objects_v2 + counting age would still cost
        // R2 reads, and we can't filter without making the call. Surface the
        // intent and skip the destructive part.
        info!("[dry-run] would delete R2 image objects older than {keep_days} days");
        return (0, 0);
    }

    let max_age = std::time::Duration::from_secs(keep_days.saturating_mul(86_400));
    match cache.gc_older_than(max_age).await {
        Ok((0, _)) => {
            info!("r2: no objects older than {keep_days} days");
            (0, 0)
        }
        Ok((count, bytes)) => {
            info!(
                "r2: deleted {count} object(s) older than {keep_days} days ({})",
                human_bytes(bytes)
            );
            (count, bytes)
        }
        Err(e) => {
            warn!("r2: GC failed ({e}); will retry on next gc invocation");
            (0, 0)
        }
    }
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

/// Try to delete an orphaned rootfs directory (no surviving snapshots).
///
/// Caller must hold the exclusive rootfs lock. Returns bytes freed (0 if
/// skipped due to age, dry-run, or deletion error).
async fn try_delete_orphan_rootfs(rootfs_path: &Path, rootfs_hash: &str, dry_run: bool) -> u64 {
    let (rootfs_size, rootfs_mtime) = dir_stats(rootfs_path).await;
    let age = SystemTime::now()
        .duration_since(rootfs_mtime)
        .unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "images/{rootfs_hash}: orphaned but too recent ({}s), keeping",
            age.as_secs()
        );
        return 0;
    }
    if dry_run {
        info!(
            "[dry-run] would delete orphaned rootfs images/{rootfs_hash} ({})",
            human_bytes(rootfs_size)
        );
        return 0;
    }
    if let Err(e) = tokio::fs::remove_dir_all(rootfs_path).await {
        warn!("failed to remove orphaned rootfs images/{rootfs_hash}: {e}");
        return 0;
    }
    info!(
        "deleted orphaned rootfs images/{rootfs_hash} ({})",
        human_bytes(rootfs_size)
    );
    rootfs_size
}

/// GC for the nested image layout: `<images>/<rootfs>/snapshots/<snapshot>/`.
///
/// Per-rootfs: mtime-sort snapshots, keep the latest `keep_latest`, delete the rest.
/// After per-rootfs cleanup: if a rootfs dir has no surviving snapshots and its
/// mtime is older than `GC_MIN_AGE`, delete the entire rootfs dir (orphan cleanup).
async fn gc_nested_images(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let images_dir = home.images_dir();
    let mut rootfs_entries = match tokio::fs::read_dir(&images_dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read {}: {e}",
                images_dir.display()
            )));
        }
    };

    let mut total_freed = 0u64;

    while let Some(rootfs_entry) = next_entry_warn(&mut rootfs_entries, "images", &images_dir).await
    {
        let rootfs_path = rootfs_entry.path();
        let Some(rootfs_hash) = rootfs_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
        else {
            continue;
        };

        // Skip non-directories (e.g. stale temp files).
        if !rootfs_path.is_dir() {
            continue;
        }

        // Probe rootfs lock. If held (by start/build), we can still GC
        // individual snapshots (guarded by their own locks), but must NOT
        // delete the rootfs directory itself.
        let rootfs_lock_path = home.rootfs_lock(&rootfs_hash);
        let _rootfs_lock = match probe_lock(&rootfs_lock_path) {
            LockProbe::Free(lock) => Some(lock),
            LockProbe::Held => {
                info!("images/{rootfs_hash}: rootfs in use, will only GC unlocked snapshots");
                None
            }
            LockProbe::Error(e) => {
                info!("images/{rootfs_hash}: lock probe failed ({e}), skipping");
                continue;
            }
        };
        let can_delete_rootfs = _rootfs_lock.is_some();

        let snapshots_dir = rootfs_path.join("snapshots");
        let mut snapshot_entries = match tokio::fs::read_dir(&snapshots_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // No snapshots/ subdirectory — orphaned rootfs.
                if can_delete_rootfs {
                    total_freed +=
                        try_delete_orphan_rootfs(&rootfs_path, &rootfs_hash, dry_run).await;
                }
                continue;
            }
            Err(e) => {
                warn!("images/{rootfs_hash}/snapshots: read failed ({e}), skipping");
                continue;
            }
        };

        // Collect snapshot candidates.
        let mut candidates: Vec<GcCandidate> = Vec::new();
        while let Some(snap_entry) =
            next_entry_warn(&mut snapshot_entries, "snapshots", &snapshots_dir).await
        {
            let snap_path = snap_entry.path();
            let Some(snap_hash) = snap_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
            else {
                continue;
            };
            if !snap_path.is_dir() {
                continue;
            }

            let lock_path = home.snapshot_lock(&snap_hash);
            match probe_lock(&lock_path) {
                LockProbe::Free(lock) => {
                    let (size, mtime) = dir_stats(&snap_path).await;
                    candidates.push(GcCandidate {
                        path: snap_path,
                        hash: snap_hash,
                        size,
                        mtime,
                        _lock: lock,
                    });
                }
                LockProbe::Held => {
                    info!("images/{rootfs_hash}/snapshots/{snap_hash}: in use, skipping");
                }
                LockProbe::Error(e) => {
                    info!(
                        "images/{rootfs_hash}/snapshots/{snap_hash}: lock probe failed ({e}), skipping"
                    );
                }
            }
        }

        // Protect recently-created snapshots.
        let now = SystemTime::now();
        candidates.retain(|c| {
            let age = now.duration_since(c.mtime).unwrap_or_default();
            if age < GC_MIN_AGE {
                info!(
                    "images/{rootfs_hash}/snapshots/{}: too recent ({}s), keeping",
                    c.hash,
                    age.as_secs()
                );
                false
            } else {
                true
            }
        });

        // Sort by mtime descending (newest first), keep latest N.
        candidates.sort_by_key(|c| std::cmp::Reverse(c.mtime));
        let keep_count = keep_latest.unwrap_or(0);
        for c in candidates.iter().take(keep_count) {
            info!(
                "images/{rootfs_hash}/snapshots/{}: keeping (latest unused, {})",
                c.hash,
                human_bytes(c.size)
            );
        }

        for c in candidates.iter().skip(keep_count) {
            if dry_run {
                info!(
                    "[dry-run] would delete images/{rootfs_hash}/snapshots/{} ({})",
                    c.hash,
                    human_bytes(c.size)
                );
            } else if let Err(e) = tokio::fs::remove_dir_all(&c.path).await {
                warn!(
                    "failed to remove images/{rootfs_hash}/snapshots/{}: {e}",
                    c.hash
                );
            } else {
                info!(
                    "deleted images/{rootfs_hash}/snapshots/{} ({})",
                    c.hash,
                    human_bytes(c.size)
                );
                total_freed += c.size;
            }
        }

        // Check if rootfs is now orphaned (no remaining snapshots).
        // Only delete rootfs if we hold the exclusive rootfs lock.
        let has_snapshots = match tokio::fs::read_dir(&snapshots_dir).await {
            Ok(mut rd) => rd.next_entry().await.ok().flatten().is_some(),
            Err(_) => false,
        };
        if !has_snapshots && can_delete_rootfs {
            total_freed += try_delete_orphan_rootfs(&rootfs_path, &rootfs_hash, dry_run).await;
        }
    }

    Ok(total_freed)
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

/// Like `next_entry()`, but logs a warning and returns `None` on I/O error
/// instead of propagating — suitable for best-effort scans like GC.
///
/// Returning `None` terminates a `while let Some(entry)` loop, so an error
/// stops iteration for the current directory (remaining entries are skipped).
async fn next_entry_warn(
    entries: &mut tokio::fs::ReadDir,
    label: &str,
    dir: &Path,
) -> Option<tokio::fs::DirEntry> {
    match entries.next_entry().await {
        Ok(entry) => entry,
        Err(e) => {
            warn!("{label}: read entry in {}: {e}", dir.display());
            None
        }
    }
}

/// Remove cached debootstrap tarballs, keeping the `keep_latest` most recent.
async fn gc_debootstrap(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let dir = home.debootstrap_dir();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read {}: {e}",
                dir.display()
            )));
        }
    };

    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    while let Some(entry) = next_entry_warn(&mut entries, "gc_debootstrap", &dir).await {
        let path = entry.path();
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        files.push((path, meta.len(), mtime));
    }

    // Skip files touched recently (same GC_MIN_AGE as rootfs/snapshots).
    let now = SystemTime::now();
    files.retain(|(path, _, mtime)| {
        let age = now.duration_since(*mtime).unwrap_or_default();
        if age < GC_MIN_AGE {
            info!(
                "debootstrap cache: {} too recent ({}s old), skipping",
                path.display(),
                age.as_secs()
            );
            false
        } else {
            true
        }
    });

    // Sort newest first, keep the N most recent.
    files.sort_by_key(|f| std::cmp::Reverse(f.2));
    let keep = keep_latest.unwrap_or(0);

    let mut freed: u64 = 0;
    for (path, size, _) in files.iter().skip(keep) {
        if dry_run {
            info!(
                "debootstrap cache: would remove {} ({})",
                path.display(),
                human_bytes(*size)
            );
        } else if let Err(e) = tokio::fs::remove_file(path).await {
            tracing::warn!("remove {}: {e}", path.display());
            continue;
        } else {
            info!(
                "debootstrap cache: removed {} ({})",
                path.display(),
                human_bytes(*size)
            );
        }
        freed += size;
    }
    Ok(freed)
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

    while let Some(entry) = next_entry_warn(&mut entries, "gc_orphaned_locks", &locks_dir).await {
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
                    removed += 1;
                } else if let Err(e) = tokio::fs::remove_file(&lock_path).await {
                    tracing::debug!("cannot remove {}: {e}", lock_path.display());
                } else {
                    info!("removed unused lock {name}");
                    removed += 1;
                }
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

    while let Some(entry) = next_entry_warn(&mut entries, "gc_job_logs", &logs_dir).await {
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
        while let Some(entry) = next_entry_warn(&mut entries, "dir_stats", &current).await {
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
///
/// If `protect` is provided, that version is unconditionally kept regardless of
/// systemd unit state. This prevents the currently-deployed version from being
/// garbage-collected during deployment (see `--protect-version`).
async fn gc_versions(
    home: &HomePaths,
    dry_run: bool,
    protect: Option<&str>,
) -> RunnerResult<Vec<String>> {
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

    while let Some(entry) = next_entry_warn(&mut entries, "gc_versions", &bin_dir).await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_semver_version(name) {
            continue;
        }

        if protect == Some(name) {
            info!("version {name}: protected (--protect-version), skipping");
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

/// Read base_dir paths from lock files written by `runner start`, returning
/// only those whose runner is dead (lock not held).
///
/// Live runners manage their own workspaces via the factory — GC must not
/// touch them because CowPool pre-warmed slots would be indistinguishable
/// from orphaned workspaces.
fn discover_dead_runner_base_dirs(locks_dir: &Path) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(locks_dir) {
        Ok(rd) => rd,
        Err(e) => {
            warn!("workspace gc: cannot read {}: {e}", locks_dir.display());
            return Vec::new();
        }
    };

    let mut base_dirs = Vec::new();
    for result in entries {
        let entry = match result {
            Ok(entry) => entry,
            Err(e) => {
                warn!("workspace gc: read entry in {}: {e}", locks_dir.display());
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("base-dir-") || !name.ends_with(".lock") {
            continue;
        }
        // Only include base_dirs from dead runners (lock not held).
        // Hold the lock while reading the file to prevent a new runner from
        // starting and overwriting the content between the probe and the read.
        let LockProbe::Free(lock_guard) = probe_lock(&entry.path()) else {
            continue;
        };
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(e) => {
                warn!("workspace gc: cannot read {}: {e}", entry.path().display());
                continue;
            }
        };
        // lock_guard dropped after read — new runner can now start, but its
        // CowPool slots will have mtime=now and be age-gated.
        drop(lock_guard);
        let path = content.trim();
        if path.is_empty() {
            continue; // pre-upgrade lock file without base_dir
        }
        base_dirs.push(PathBuf::from(path));
    }
    base_dirs
}

/// Remove workspace directories from dead runners.
///
/// Only scans base_dirs whose runner lock is NOT held (dead runners). Live
/// runners manage their own workspaces via the factory — touching them would
/// risk deleting CowPool pre-warmed slots that are indistinguishable from
/// orphaned workspaces.
///
/// Even for dead runners, workspaces owned by still-running orphaned
/// Firecracker processes are protected via process discovery. Recently-created
/// workspaces (< [`GC_MIN_AGE`]) are also skipped as a safety margin.
async fn gc_workspace_orphans(home: &HomePaths, dry_run: bool) -> RunnerResult<(u32, u64)> {
    // 1. Discover active workspaces from any running Firecracker process.
    //    This protects orphaned FCs whose parent runner already died but
    //    whose VM is still running.
    let discovered = crate::process::discover_all().await;
    let active: HashSet<PathBuf> = discovered
        .firecrackers
        .iter()
        .filter_map(|fc| {
            fc.base_dir
                .as_ref()
                .map(|bd| bd.join("workspaces").join(&fc.sandbox_id))
        })
        .collect();

    // 2. Only scan base_dirs from dead runners (lock not held).
    //    Runs on a blocking thread because probe_lock uses flock(2) and
    //    std::fs::read_to_string — both synchronous.
    let locks_dir = home.locks_dir();
    let base_dirs = tokio::task::spawn_blocking(move || discover_dead_runner_base_dirs(&locks_dir))
        .await
        .map_err(|e| RunnerError::Internal(format!("discover base_dirs task failed: {e}")))?;

    if base_dirs.is_empty() {
        tracing::debug!("workspace gc: no dead-runner base_dirs discovered");
        return Ok((0, 0));
    }

    // 3. Scan each base_dir/workspaces/ for orphans.
    let now = SystemTime::now();
    let mut cleaned: u32 = 0;
    let mut freed: u64 = 0;

    for base_dir in &base_dirs {
        let workspaces_dir = base_dir.join("workspaces");
        let mut entries = match tokio::fs::read_dir(&workspaces_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                warn!(
                    "workspace gc: cannot read {}: {e}",
                    workspaces_dir.display()
                );
                continue;
            }
        };

        while let Some(entry) = next_entry_warn(&mut entries, "workspace gc", &workspaces_dir).await
        {
            let path = entry.path();
            let Ok(meta) = tokio::fs::metadata(&path).await else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }

            // Skip if actively owned by a running process.
            if active.contains(&path) {
                continue;
            }

            // Age-gate: skip recently created workspaces.
            let age = meta
                .modified()
                .ok()
                .and_then(|mtime| now.duration_since(mtime).ok())
                .unwrap_or_default();
            if age < GC_MIN_AGE {
                tracing::debug!(
                    "workspace gc: {} too recent ({}s), skipping",
                    path.display(),
                    age.as_secs()
                );
                continue;
            }

            let (size, _) = dir_stats(&path).await;
            if dry_run {
                info!(
                    "[dry-run] would remove orphaned workspace {} ({})",
                    path.display(),
                    human_bytes(size)
                );
            } else {
                match tokio::fs::remove_dir_all(&path).await {
                    Ok(()) => {
                        info!(
                            "removed orphaned workspace {} ({})",
                            path.display(),
                            human_bytes(size)
                        );
                    }
                    Err(e) => {
                        warn!("workspace gc: cannot remove {}: {e}", path.display());
                        continue;
                    }
                }
            }
            cleaned += 1;
            freed += size;
        }
    }

    if cleaned > 0 {
        info!(
            "workspace orphans: {cleaned} cleaned ({})",
            human_bytes(freed)
        );
    } else {
        tracing::debug!(
            "workspace gc: no orphans found across {} base_dirs",
            base_dirs.len()
        );
    }

    Ok((cleaned, freed))
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
    use clap::Parser;

    /// `--r2-keep-days 0` would wipe even just-uploaded images. Verify the
    /// clap range validator rejects it (catches a regression if the
    /// `value_parser` annotation is dropped).
    #[derive(Parser)]
    struct GcCli {
        #[command(flatten)]
        args: GcArgs,
    }

    #[test]
    fn r2_keep_days_zero_is_rejected() {
        let r = GcCli::try_parse_from(["gc", "--r2-keep-days", "0"]);
        assert!(r.is_err(), "--r2-keep-days 0 must be rejected");
    }

    #[test]
    fn r2_keep_days_one_is_accepted() {
        let r = GcCli::try_parse_from(["gc", "--r2-keep-days", "1"]);
        assert!(r.is_ok(), "--r2-keep-days 1 must be accepted");
    }

    #[test]
    fn r2_keep_days_default_when_omitted() {
        let parsed = GcCli::try_parse_from(["gc"]).unwrap();
        assert_eq!(parsed.args.r2_keep_days, R2_DEFAULT_KEEP_DAYS);
    }

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
        let mut removed = gc_versions(&home, false, None).await.unwrap();
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

        let removed = gc_versions(&home, true, None).await.unwrap();
        assert_eq!(removed, ["v1.0.0"]);
        assert!(bin_dir.join("v1.0.0").exists(), "dry-run should not delete");
    }

    #[tokio::test]
    async fn gc_versions_empty_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.bin_dir()).unwrap();

        let removed = gc_versions(&home, false, None).await.unwrap();
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn gc_versions_missing_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        // Don't create bin_dir — should return 0, not error.
        let removed = gc_versions(&home, false, None).await.unwrap();
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn gc_versions_protect_keeps_named_version() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let bin_dir = home.bin_dir();

        std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
        std::fs::create_dir_all(bin_dir.join("v2.0.0")).unwrap();

        let mut removed = gc_versions(&home, false, Some("v1.0.0")).await.unwrap();
        removed.sort();
        assert_eq!(removed, ["v2.0.0"]);
        assert!(
            bin_dir.join("v1.0.0").exists(),
            "skipped version should survive"
        );
        assert!(!bin_dir.join("v2.0.0").exists());
    }

    #[tokio::test]
    async fn gc_nested_images_empty_dir_returns_zero() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let freed = gc_nested_images(&home, Some(1), false).await.unwrap();
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_nested_images_keeps_latest_per_rootfs() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Create rootfs with two snapshots
        let rootfs_dir = images_dir.join("rootfs_aaa");
        let snap_old = rootfs_dir.join("snapshots").join("snap_old");
        let snap_new = rootfs_dir.join("snapshots").join("snap_new");
        for d in [&snap_old, &snap_new] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
        }
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // Set distinct mtimes — old snapshot is clearly old
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&snap_old)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
        let new_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        std::fs::File::open(&snap_new)
            .unwrap()
            .set_times(FileTimes::new().set_modified(new_time))
            .unwrap();

        let freed = gc_nested_images(&home, Some(1), false).await.unwrap();

        assert!(snap_new.exists(), "newest snapshot should survive");
        assert!(!snap_old.exists(), "oldest snapshot should be deleted");
        assert!(
            rootfs_dir.join("rootfs.ext4").exists(),
            "rootfs should survive"
        );
        assert!(freed > 0);
    }

    #[tokio::test]
    async fn gc_nested_images_orphaned_rootfs_old_enough() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Rootfs with no snapshots/ directory at all
        let rootfs_dir = images_dir.join("orphan_rootfs");
        std::fs::create_dir_all(&rootfs_dir).unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // Make it old enough for GC
        let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::open(&rootfs_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let freed = gc_nested_images(&home, None, false).await.unwrap();
        assert!(!rootfs_dir.exists(), "orphaned rootfs should be deleted");
        assert!(freed > 0);
    }

    #[tokio::test]
    async fn gc_nested_images_dry_run_deletes_nothing() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("rootfs_bbb");
        let snap = rootfs_dir.join("snapshots").join("snap_x");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&snap)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        // keep_latest=0 + dry_run: would delete but doesn't actually
        let freed = gc_nested_images(&home, Some(0), true).await.unwrap();
        assert!(snap.exists(), "dry-run must not delete");
        assert_eq!(freed, 0, "dry-run must not count freed space");
    }

    /// Empty `snapshots/` directory (not missing, just empty) → orphan rootfs deleted.
    /// Different code path from "no snapshots/ dir at all" (which hits the NotFound branch).
    #[tokio::test]
    async fn gc_nested_images_empty_snapshots_dir_orphans_rootfs() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("rootfs_empty_snaps");
        let snapshots_dir = rootfs_dir.join("snapshots");
        std::fs::create_dir_all(&snapshots_dir).unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // Make rootfs old enough for GC.
        let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::open(&rootfs_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let freed = gc_nested_images(&home, None, false).await.unwrap();
        assert!(
            !rootfs_dir.exists(),
            "orphaned rootfs (empty snapshots/) should be deleted"
        );
        assert!(freed > 0);
    }

    /// Snapshots younger than GC_MIN_AGE are unconditionally kept, even with keep_latest=0.
    #[tokio::test]
    async fn gc_nested_images_recent_snapshot_protected() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("rootfs_recent");
        let snap = rootfs_dir.join("snapshots").join("snap_fresh");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // mtime is NOW (default) — well within GC_MIN_AGE.
        // keep_latest=0 would delete everything, but GC_MIN_AGE protects.
        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();
        assert!(
            snap.exists(),
            "recent snapshot must survive despite keep_latest=0"
        );
        assert!(
            rootfs_dir.exists(),
            "rootfs must survive (has protected snapshot)"
        );
        assert_eq!(freed, 0);
    }

    /// When the rootfs lock is held, GC can still delete unlocked snapshots
    /// but must NOT delete the rootfs directory itself.
    #[tokio::test]
    async fn gc_nested_images_locked_rootfs_still_cleans_unlocked_snapshots() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("can_delete_rootfs");
        let snap_used = rootfs_dir.join("snapshots").join("snap_used");
        let snap_old = rootfs_dir.join("snapshots").join("snap_old");
        for d in [&snap_used, &snap_old] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
        }
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // Make snap_old old enough to be GC-eligible.
        let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::open(&snap_old)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        // Simulate `runner start` holding shared locks on rootfs + snap_used.
        let rootfs_lock_file =
            lock::open_lock_file(&home.rootfs_lock("can_delete_rootfs")).unwrap();
        let _rootfs_held = Flock::lock(rootfs_lock_file, FlockArg::LockShared).unwrap();
        let snap_lock_file = lock::open_lock_file(&home.snapshot_lock("snap_used")).unwrap();
        let _snap_held = Flock::lock(snap_lock_file, FlockArg::LockShared).unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();
        assert!(
            !snap_old.exists(),
            "unlocked old snapshot should be deleted"
        );
        assert!(snap_used.exists(), "locked snapshot must survive");
        assert!(rootfs_dir.exists(), "rootfs must survive (lock held)");
        assert!(freed > 0);
    }

    /// A locked snapshot must survive even with keep_latest=0 and old mtime.
    #[tokio::test]
    async fn gc_nested_images_skips_locked_snapshot() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("rootfs_lock_test");
        let snap = rootfs_dir.join("snapshots").join("snap_locked");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // Make old enough to be GC-eligible.
        let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::open(&snap)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        // Hold a shared lock on the snapshot (simulating runner start).
        let snap_lock_file = lock::open_lock_file(&home.snapshot_lock("snap_locked")).unwrap();
        let _snap_held = Flock::lock(snap_lock_file, FlockArg::LockShared).unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();
        assert!(snap.exists(), "locked snapshot must survive");
        assert_eq!(freed, 0);
    }

    #[test]
    fn gc_protect_version_flag_is_accepted() {
        let r = GcCli::try_parse_from(["gc", "--protect-version", "v0.78.3"]);
        assert!(r.is_ok(), "--protect-version must be accepted");
        let cli = r.unwrap();
        assert_eq!(cli.args.protect_version.as_deref(), Some("v0.78.3"));
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

    // -----------------------------------------------------------------------
    // Workspace orphan GC tests
    // -----------------------------------------------------------------------

    #[test]
    fn discover_dead_runner_base_dirs_reads_lock_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        std::fs::write(locks_dir.join("base-dir-abc123.lock"), "/data/runner-01").unwrap();
        std::fs::write(locks_dir.join("base-dir-def456.lock"), "/data/runner-02").unwrap();

        let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
        assert_eq!(dirs.len(), 2);
        assert!(dirs.contains(&PathBuf::from("/data/runner-01")));
        assert!(dirs.contains(&PathBuf::from("/data/runner-02")));
    }

    #[test]
    fn discover_dead_runner_base_dirs_skips_empty_and_non_matching() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Empty lock file (pre-upgrade runner)
        std::fs::write(locks_dir.join("base-dir-empty.lock"), "").unwrap();
        // Non-base-dir lock file
        std::fs::write(locks_dir.join("rootfs-abc.lock"), "/some/path").unwrap();

        let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
        assert!(dirs.is_empty());
    }

    #[test]
    fn discover_dead_runner_base_dirs_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        // locks dir does not exist
        let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
        assert!(dirs.is_empty());
    }

    #[test]
    fn discover_dead_runner_base_dirs_skips_held_locks() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Lock file with content, held by us (simulating a live runner).
        let lock_path = locks_dir.join("base-dir-live.lock");
        std::fs::write(&lock_path, "/data/live-runner").unwrap();
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        let _held = Flock::lock(file, FlockArg::LockExclusive).unwrap();

        // Lock file with content, NOT held (simulating a dead runner).
        std::fs::write(locks_dir.join("base-dir-dead.lock"), "/data/dead-runner").unwrap();

        let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0], PathBuf::from("/data/dead-runner"));
    }

    #[tokio::test]
    async fn gc_workspace_orphans_deletes_old_orphan() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Create a fake base_dir with a workspace
        let base_dir = dir.path().join("runner-data");
        let workspaces_dir = base_dir.join("workspaces");
        let workspace = workspaces_dir.join("run-abc-123");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("cow.img"), vec![0u8; 4096]).unwrap();

        // Register base_dir in lock file
        std::fs::write(
            locks_dir.join("base-dir-test.lock"),
            base_dir.to_str().unwrap(),
        )
        .unwrap();

        // Set workspace mtime to 1 hour ago (past GC_MIN_AGE)
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&workspace)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (cleaned, freed) = gc_workspace_orphans(&home, false).await.unwrap();

        assert!(!workspace.exists(), "orphaned workspace should be deleted");
        assert_eq!(cleaned, 1);
        assert!(freed > 0 || cfg!(target_os = "macos"));
    }

    #[tokio::test]
    async fn gc_workspace_orphans_skips_recent() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let base_dir = dir.path().join("runner-data");
        let workspace = base_dir.join("workspaces").join("run-new-456");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("cow.img"), b"data").unwrap();
        // mtime = now (default), so workspace is too recent

        std::fs::write(
            locks_dir.join("base-dir-test.lock"),
            base_dir.to_str().unwrap(),
        )
        .unwrap();

        let (cleaned, _) = gc_workspace_orphans(&home, false).await.unwrap();

        assert!(workspace.exists(), "recent workspace should NOT be deleted");
        assert_eq!(cleaned, 0);
    }

    #[tokio::test]
    async fn gc_workspace_orphans_dry_run_preserves() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let base_dir = dir.path().join("runner-data");
        let workspace = base_dir.join("workspaces").join("run-dry-789");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("cow.img"), b"data").unwrap();

        std::fs::write(
            locks_dir.join("base-dir-test.lock"),
            base_dir.to_str().unwrap(),
        )
        .unwrap();

        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&workspace)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (cleaned, freed) = gc_workspace_orphans(&home, true).await.unwrap();

        assert!(workspace.exists(), "dry-run should NOT delete");
        assert_eq!(cleaned, 1);
        assert!(freed > 0 || cfg!(target_os = "macos"));
    }

    #[tokio::test]
    async fn gc_workspace_orphans_no_base_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        // No lock files, no running processes → no base_dirs
        let (cleaned, freed) = gc_workspace_orphans(&home, false).await.unwrap();
        assert_eq!(cleaned, 0);
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_workspace_orphans_skips_non_directory_entries() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let base_dir = dir.path().join("runner-data");
        let workspaces_dir = base_dir.join("workspaces");
        std::fs::create_dir_all(&workspaces_dir).unwrap();

        // Regular file in workspaces/ — must NOT be deleted
        let stray_file = workspaces_dir.join(".gitkeep");
        std::fs::write(&stray_file, "").unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&stray_file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        std::fs::write(
            locks_dir.join("base-dir-test.lock"),
            base_dir.to_str().unwrap(),
        )
        .unwrap();

        let (cleaned, _) = gc_workspace_orphans(&home, false).await.unwrap();
        assert_eq!(cleaned, 0);
        assert!(stray_file.exists(), "non-directory entries must be skipped");
    }

    #[tokio::test]
    async fn gc_workspace_orphans_base_dir_without_workspaces_subdir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // base_dir exists but has no workspaces/ subdirectory
        let base_dir = dir.path().join("runner-data");
        std::fs::create_dir_all(&base_dir).unwrap();

        std::fs::write(
            locks_dir.join("base-dir-test.lock"),
            base_dir.to_str().unwrap(),
        )
        .unwrap();

        let (cleaned, freed) = gc_workspace_orphans(&home, false).await.unwrap();
        assert_eq!(cleaned, 0);
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_workspace_orphans_mixed_old_and_recent() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let base_dir = dir.path().join("runner-data");
        let workspaces_dir = base_dir.join("workspaces");

        // Old workspace — should be deleted
        let old_ws = workspaces_dir.join("run-old");
        std::fs::create_dir_all(&old_ws).unwrap();
        std::fs::write(old_ws.join("cow.img"), vec![0u8; 4096]).unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&old_ws)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        // Recent workspace — should be kept
        let new_ws = workspaces_dir.join("run-new");
        std::fs::create_dir_all(&new_ws).unwrap();
        std::fs::write(new_ws.join("cow.img"), b"data").unwrap();
        // mtime = now (default)

        std::fs::write(
            locks_dir.join("base-dir-test.lock"),
            base_dir.to_str().unwrap(),
        )
        .unwrap();

        let (cleaned, freed) = gc_workspace_orphans(&home, false).await.unwrap();

        assert_eq!(cleaned, 1, "only old workspace should be cleaned");
        assert!(!old_ws.exists(), "old workspace should be deleted");
        assert!(new_ws.exists(), "recent workspace should be kept");
        assert!(freed > 0 || cfg!(target_os = "macos"));
    }

    #[test]
    fn discover_dead_runner_base_dirs_trims_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Content with trailing newline (e.g., written by shell tools)
        std::fs::write(locks_dir.join("base-dir-ws.lock"), "/data/runner-01\n").unwrap();

        let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0], PathBuf::from("/data/runner-01"));
    }

    #[test]
    fn discover_dead_runner_base_dirs_skips_whitespace_only() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Whitespace-only content should be treated as empty
        std::fs::write(locks_dir.join("base-dir-ws-only.lock"), "  \n\t\n").unwrap();

        let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
        assert!(dirs.is_empty());
    }

    #[tokio::test]
    async fn gc_workspace_orphans_multiple_base_dirs() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Two distinct base_dirs, each with an old orphaned workspace
        let base_dir_a = dir.path().join("runner-a");
        let ws_a = base_dir_a.join("workspaces").join("run-aaa");
        std::fs::create_dir_all(&ws_a).unwrap();
        std::fs::write(ws_a.join("cow.img"), vec![0u8; 4096]).unwrap();

        let base_dir_b = dir.path().join("runner-b");
        let ws_b = base_dir_b.join("workspaces").join("run-bbb");
        std::fs::create_dir_all(&ws_b).unwrap();
        std::fs::write(ws_b.join("cow.img"), vec![0u8; 4096]).unwrap();

        // Register both in separate lock files
        std::fs::write(
            locks_dir.join("base-dir-aaa.lock"),
            base_dir_a.to_str().unwrap(),
        )
        .unwrap();
        std::fs::write(
            locks_dir.join("base-dir-bbb.lock"),
            base_dir_b.to_str().unwrap(),
        )
        .unwrap();

        // Age both workspaces past GC_MIN_AGE
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        for ws in [&ws_a, &ws_b] {
            std::fs::File::open(ws)
                .unwrap()
                .set_times(FileTimes::new().set_modified(old_time))
                .unwrap();
        }

        let (cleaned, freed) = gc_workspace_orphans(&home, false).await.unwrap();

        assert_eq!(cleaned, 2, "both orphans should be cleaned");
        assert!(!ws_a.exists(), "workspace A should be deleted");
        assert!(!ws_b.exists(), "workspace B should be deleted");
        assert!(freed > 0 || cfg!(target_os = "macos"));
    }
}
