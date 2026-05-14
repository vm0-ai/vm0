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

/// Per-host storage archive cache size cap. Enforced by `gc_storage_cache`
/// as an LRU by `<version>/` dir mtime.
const STORAGE_CACHE_MAX_BYTES: u64 = 1 << 30; // 1 GiB
/// Per-host storage archive cache entry cap. The byte cap alone does not
/// bound many tiny storage versions, and each cached version also creates a
/// lock file.
const STORAGE_CACHE_MAX_ENTRIES: u64 = 5_000;
const TEMPLATE_WARM_DIR_PREFIX: &str = "template-warm-";

#[derive(Args)]
pub struct GcArgs {
    /// Show what would be deleted without actually deleting
    #[arg(long)]
    dry_run: bool,
    /// Keep the N most recent unused versions (by modification time)
    #[arg(long)]
    keep_latest: Option<usize>,
    /// TTL for R2 image cache objects (in days). Objects older than this
    /// are deleted from the legacy `runner-images/` prefix and the shared
    /// `runner-templates/` prefix on R2. Default: 7 days.
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
    let versions_removed = gc_versions(
        &home,
        args.dry_run,
        args.protect_version.as_deref(),
        args.keep_latest,
    )
    .await?;

    let debootstrap_freed = gc_debootstrap(&home, args.keep_latest, args.dry_run).await?;

    let storages_freed = gc_storage_cache(&home, args.dry_run).await?;

    let (r2_deleted, r2_freed) = gc_r2(args.r2_keep_days, args.dry_run).await;

    let total = images_freed
        + job_logs_freed
        + debootstrap_freed
        + workspace_freed
        + r2_freed
        + storages_freed;
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
    /// Index into the enclosing `Vec<RootfsState>` so we can mark the parent
    /// rootfs as "has a surviving snapshot" when this candidate is kept.
    rootfs_idx: usize,
    /// Exclusive lock held until the candidate is deleted or explicitly kept.
    /// Prevents a `runner start` from acquiring a shared lock between probe and delete.
    _lock: Flock<std::fs::File>,
}

/// Per-rootfs state carried through the two-phase global GC for rootfs
/// directories whose exclusive lock we hold: first we walk snapshots and record
/// whether any locked / recent snapshot already forces the rootfs to survive;
/// then we prune snapshots globally and, for each rootfs with no surviving
/// snapshot, try to delete the rootfs dir itself.
struct RootfsState {
    path: PathBuf,
    hash: String,
    /// Exclusive rootfs lock held until this GC pass finishes.
    _rootfs_lock: Flock<std::fs::File>,
    /// True once any snapshot under this rootfs is known to survive GC
    /// (in-use, too recent, kept by top-N, or a deletion failure). Blocks
    /// rootfs-dir deletion in the final pass.
    any_snapshot_survives: bool,
}

/// Set `any_snapshot_survives = true` on the rootfs at `idx`. `idx` is
/// either a freshly-minted `rootfs_states.len()` at push time or a
/// `GcCandidate.rootfs_idx` stamped at push time, so the `Some` branch is
/// the only reachable one in practice; the no-op `None` is a belt-and-
/// braces guard to satisfy panic-free indexing.
fn mark_rootfs_survives(states: &mut [RootfsState], idx: usize) {
    if let Some(state) = states.get_mut(idx) {
        state.any_snapshot_survives = true;
    }
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
    } else if let Err(e) = tokio::fs::remove_dir_all(rootfs_path).await {
        warn!("failed to remove orphaned rootfs images/{rootfs_hash}: {e}");
        return 0;
    } else {
        info!(
            "deleted orphaned rootfs images/{rootfs_hash} ({})",
            human_bytes(rootfs_size)
        );
    }
    rootfs_size
}

fn template_warm_hash(name: &str) -> Option<&str> {
    name.strip_prefix(TEMPLATE_WARM_DIR_PREFIX)
        .or_else(|| {
            name.strip_prefix("template-")
                .and_then(|rest| rest.strip_suffix(".warm.tmp"))
        })
        .filter(|hash| !hash.is_empty())
}

/// Try to delete an abandoned `runner build --warm-rootfs-cache` working dir.
///
/// The directory intentionally lives under `images/` so the warm download/build
/// uses the same data volume as normal rootfs builds. It is a template
/// warm dir, so it is guarded by the template lock rather than `image-*`.
async fn gc_template_warm_dir(
    home: &HomePaths,
    warm_path: &Path,
    warm_name: &str,
    template_hash: &str,
    dry_run: bool,
) -> u64 {
    let lock_path = home.template_lock(template_hash);
    let _lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            info!("images/{warm_name}: template warm dir in use, skipping");
            return 0;
        }
        LockProbe::Error(e) => {
            info!("images/{warm_name}: template lock probe failed ({e}), skipping");
            return 0;
        }
    };

    let (size, mtime) = dir_stats(warm_path).await;
    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "images/{warm_name}: template warm dir too recent ({}s), keeping",
            age.as_secs()
        );
        return 0;
    }
    if dry_run {
        info!(
            "[dry-run] would delete template warm dir images/{warm_name} ({})",
            human_bytes(size)
        );
    } else if let Err(e) = tokio::fs::remove_dir_all(warm_path).await {
        warn!("failed to remove template warm dir images/{warm_name}: {e}");
        return 0;
    } else {
        info!(
            "deleted template warm dir images/{warm_name} ({})",
            human_bytes(size)
        );
    }
    size
}

/// GC for the nested image layout: `<images>/<rootfs>/snapshots/<snapshot>/`.
///
/// Three phases, with **global** top-N semantics across all rootfs:
///
/// 1. Walk every rootfs. Probe locks and filter out snapshots that must
///    survive (in-use, too recent, malformed); collect the remaining
///    eligible snapshots into one flat candidate list. Rootfs dirs with
///    no `snapshots/` subdir are orphan-deleted inline when we hold the
///    rootfs lock.
/// 2. Global top-N: sort the candidate list by mtime (newest first), keep
///    the first `keep_latest`, delete the rest.
/// 3. Orphan rootfs sweep: any rootfs whose lock we hold AND where no
///    snapshot survived is deleted.
///
/// Global (cross-rootfs) rather than per-rootfs so a host that has
/// accumulated many distinct rootfs hashes (e.g. per-PR builds) can be
/// trimmed down — per-rootfs top-N kept every rootfs forever whenever
/// each had ≤ N snapshots.
async fn gc_nested_images(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let images_dir = home.images_dir();
    let Some(mut rootfs_entries) = read_dir_or_missing(&images_dir).await? else {
        return Ok(0);
    };

    let mut total_freed = 0u64;
    let mut rootfs_states: Vec<RootfsState> = Vec::new();
    let mut candidates: Vec<GcCandidate> = Vec::new();

    // Phase 1: walk all rootfs, collect candidates across the entire images tree.
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

        if let Some(template_hash) = template_warm_hash(&rootfs_hash) {
            total_freed +=
                gc_template_warm_dir(home, &rootfs_path, &rootfs_hash, template_hash, dry_run)
                    .await;
            continue;
        }

        // Probe rootfs lock. If held (by start/build), skip the whole rootfs.
        // `runner start` acquires shared rootfs before shared snapshot; cleaning
        // snapshots while only the rootfs lock is held can race that acquisition
        // window and delete a snapshot the runner is about to lock.
        let rootfs_lock_path = home.rootfs_lock(&rootfs_hash);
        let rootfs_lock = match probe_lock(&rootfs_lock_path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => {
                info!("images/{rootfs_hash}: rootfs in use, skipping");
                continue;
            }
            LockProbe::Error(e) => {
                info!("images/{rootfs_hash}: lock probe failed ({e}), skipping");
                continue;
            }
        };

        let snapshots_dir = rootfs_path.join("snapshots");
        let mut snapshot_entries = match tokio::fs::read_dir(&snapshots_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // No snapshots/ subdirectory — orphaned rootfs, handle inline.
                total_freed += try_delete_orphan_rootfs(&rootfs_path, &rootfs_hash, dry_run).await;
                continue;
            }
            Err(e) => {
                warn!("images/{rootfs_hash}/snapshots: read failed ({e}), skipping");
                continue;
            }
        };

        let rootfs_idx = rootfs_states.len();
        rootfs_states.push(RootfsState {
            path: rootfs_path.clone(),
            hash: rootfs_hash.clone(),
            _rootfs_lock: rootfs_lock,
            any_snapshot_survives: false,
        });

        while let Some(snap_entry) =
            next_entry_warn(&mut snapshot_entries, "snapshots", &snapshots_dir).await
        {
            let snap_path = snap_entry.path();
            let Some(snap_hash) = snap_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
            else {
                mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                continue;
            };
            if !snap_path.is_dir() {
                mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                continue;
            }

            let lock_path = home.snapshot_lock(&snap_hash);
            match probe_lock(&lock_path) {
                LockProbe::Free(lock) => {
                    let (size, mtime) = dir_stats(&snap_path).await;
                    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
                    if age < GC_MIN_AGE {
                        // Too recent to be safely deleted (races with
                        // `runner build` releasing its lock). Drop our
                        // exclusive lock so the next caller can pick it
                        // up; mark the rootfs as preserved.
                        mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                        info!(
                            "images/{rootfs_hash}/snapshots/{snap_hash}: too recent ({}s), keeping",
                            age.as_secs()
                        );
                    } else {
                        candidates.push(GcCandidate {
                            path: snap_path,
                            hash: snap_hash,
                            size,
                            mtime,
                            rootfs_idx,
                            _lock: lock,
                        });
                    }
                }
                LockProbe::Held => {
                    mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                    info!("images/{rootfs_hash}/snapshots/{snap_hash}: in use, skipping");
                }
                LockProbe::Error(e) => {
                    mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                    info!(
                        "images/{rootfs_hash}/snapshots/{snap_hash}: lock probe failed ({e}), skipping"
                    );
                }
            }
        }
    }

    // Phase 2a: global sort by mtime descending, keep the top N across all rootfs.
    candidates.sort_by_key(|c| std::cmp::Reverse(c.mtime));
    let keep_count = keep_latest.unwrap_or(0);
    for c in candidates.iter().take(keep_count) {
        if let Some(state) = rootfs_states.get_mut(c.rootfs_idx) {
            state.any_snapshot_survives = true;
            info!(
                "images/{}/snapshots/{}: keeping (global top-{keep_count}, {})",
                state.hash,
                c.hash,
                human_bytes(c.size)
            );
        }
    }

    // Phase 2b: delete everything past the top-N cutoff. Track per-rootfs
    // deleted-snapshot bytes so the dry-run orphan accounting can subtract
    // the overlap (see orphan-rootfs note below). Skip the allocation in
    // real-mode — nothing reads or writes it there.
    let mut dry_run_snapshot_bytes: Vec<u64> = if dry_run {
        vec![0; rootfs_states.len()]
    } else {
        Vec::new()
    };
    for c in candidates.iter().skip(keep_count) {
        // Clone `hash` so the immutable borrow on `rootfs_states` is
        // released before the error branch mutates it below.
        let Some(rootfs_hash) = rootfs_states.get(c.rootfs_idx).map(|s| s.hash.clone()) else {
            continue;
        };
        if dry_run {
            info!(
                "[dry-run] would delete images/{rootfs_hash}/snapshots/{} ({})",
                c.hash,
                human_bytes(c.size)
            );
            if let Some(slot) = dry_run_snapshot_bytes.get_mut(c.rootfs_idx) {
                *slot += c.size;
            }
        } else if let Err(e) = tokio::fs::remove_dir_all(&c.path).await {
            warn!(
                "failed to remove images/{rootfs_hash}/snapshots/{}: {e}",
                c.hash
            );
            mark_rootfs_survives(&mut rootfs_states, c.rootfs_idx);
            continue;
        } else {
            info!(
                "deleted images/{rootfs_hash}/snapshots/{} ({})",
                c.hash,
                human_bytes(c.size)
            );
        }
        total_freed += c.size;
    }

    // Phase 3: any rootfs whose lock we hold AND where no snapshot survives
    // is orphan — delete the rootfs directory itself. In dry-run mode
    // `try_delete_orphan_rootfs` stats the rootfs *including* the snapshot
    // subdirs we already counted (dry-run leaves them on disk), so subtract
    // that overlap to match the real-mode total.
    for (idx, state) in rootfs_states.iter().enumerate() {
        if !state.any_snapshot_survives {
            let rootfs_bytes = try_delete_orphan_rootfs(&state.path, &state.hash, dry_run).await;
            let overlap = if dry_run {
                dry_run_snapshot_bytes.get(idx).copied().unwrap_or(0)
            } else {
                0
            };
            total_freed += rootfs_bytes.saturating_sub(overlap);
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

fn lock_metadata_inode_is_current(
    lock_meta: std::fs::Metadata,
    path: &Path,
) -> Result<bool, String> {
    let path_meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("stat lock {}: {e}", path.display())),
    };
    Ok(lock_meta.ino() == path_meta.ino())
}

fn lock_probe_inode_is_current(lock: &Flock<std::fs::File>, path: &Path) -> Result<bool, String> {
    let lock_meta = lock
        .metadata()
        .map_err(|e| format!("stat locked fd for {}: {e}", path.display()))?;
    lock_metadata_inode_is_current(lock_meta, path)
}

fn lock_file_inode_is_current(file: &std::fs::File, path: &Path) -> Result<bool, String> {
    let lock_meta = file
        .metadata()
        .map_err(|e| format!("stat lock fd for {}: {e}", path.display()))?;
    lock_metadata_inode_is_current(lock_meta, path)
}

/// Try a nonblocking exclusive flock to check if a resource is in use.
fn probe_lock(path: &Path) -> LockProbe {
    const MAX_STALE_INODE_RETRIES: usize = 16;
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = match lock::open_lock_file(path) {
            Ok(f) => f,
            Err(e) => return LockProbe::Error(e.to_string()),
        };
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => match lock_probe_inode_is_current(&lock, path) {
                Ok(true) => return LockProbe::Free(lock),
                Ok(false) => continue,
                Err(e) => return LockProbe::Error(e),
            },
            Err((file, e)) if e == nix::errno::Errno::EWOULDBLOCK => {
                match lock_file_inode_is_current(&file, path) {
                    Ok(true) => return LockProbe::Held,
                    Ok(false) => continue,
                    Err(e) => return LockProbe::Error(e),
                }
            }
            Err((_, e)) => return LockProbe::Error(e.to_string()),
        }
    }
    LockProbe::Error(format!("lock path {} changed during probe", path.display()))
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

async fn read_dir_or_missing(path: &Path) -> RunnerResult<Option<tokio::fs::ReadDir>> {
    match tokio::fs::read_dir(path).await {
        Ok(rd) => Ok(Some(rd)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(RunnerError::Internal(format!(
            "read {}: {e}",
            path.display()
        ))),
    }
}

/// Remove cached debootstrap tarballs, keeping the `keep_latest` most recent.
async fn gc_debootstrap(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let dir = home.debootstrap_dir();
    if !dir.try_exists().map_err(|e| {
        RunnerError::Internal(format!("check debootstrap dir {}: {e}", dir.display()))
    })? {
        return Ok(0);
    }

    let lock_path = home.debootstrap_lock();
    let _lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            info!("debootstrap cache: in use, skipping");
            return Ok(0);
        }
        LockProbe::Error(e) => {
            info!("debootstrap cache: lock probe failed ({e}), skipping");
            return Ok(0);
        }
    };

    let Some(mut entries) = read_dir_or_missing(&dir).await? else {
        return Ok(0);
    };

    let mut files: Vec<DeBootstrapCacheFile> = Vec::new();
    while let Some(entry) = next_entry_warn(&mut entries, "gc_debootstrap", &dir).await {
        let path = entry.path();
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let Some(kind) = debootstrap_cache_file_kind(&path) else {
            continue;
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        files.push(DeBootstrapCacheFile {
            path,
            size: meta.len(),
            mtime,
            is_temp: matches!(kind, DeBootstrapCacheFileKind::Temp),
        });
    }

    // Skip files touched recently (same GC_MIN_AGE as rootfs/snapshots).
    let now = SystemTime::now();
    files.retain(|file| {
        let age = now.duration_since(file.mtime).unwrap_or_default();
        if age < GC_MIN_AGE {
            info!(
                "debootstrap cache: {} too recent ({}s old), skipping",
                file.path.display(),
                age.as_secs()
            );
            false
        } else {
            true
        }
    });

    // Sort newest first, keep the N most recent stable tarballs. Stale
    // `*.tar.tmp.<pid>` files are cancellation residue and must not consume a
    // keep_latest slot that would otherwise protect a usable cache tarball.
    files.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    let keep = keep_latest.unwrap_or(0);
    let mut stable_seen = 0usize;

    let mut freed: u64 = 0;
    for file in files.iter() {
        if !file.is_temp && stable_seen < keep {
            stable_seen += 1;
            continue;
        }
        if dry_run {
            info!(
                "debootstrap cache: would remove {} ({})",
                file.path.display(),
                human_bytes(file.size)
            );
        } else if let Err(e) = tokio::fs::remove_file(&file.path).await {
            tracing::warn!("remove {}: {e}", file.path.display());
            continue;
        } else {
            info!(
                "debootstrap cache: removed {} ({})",
                file.path.display(),
                human_bytes(file.size)
            );
        }
        freed += file.size;
    }
    Ok(freed)
}

struct DeBootstrapCacheFile {
    path: PathBuf,
    size: u64,
    mtime: SystemTime,
    is_temp: bool,
}

enum DeBootstrapCacheFileKind {
    Stable,
    Temp,
}

fn debootstrap_cache_file_kind(path: &Path) -> Option<DeBootstrapCacheFileKind> {
    let name = path.file_name().and_then(|name| name.to_str())?;
    if name.contains(".tar.tmp.") {
        Some(DeBootstrapCacheFileKind::Temp)
    } else if name.ends_with(".tar") {
        Some(DeBootstrapCacheFileKind::Stable)
    } else {
        None
    }
}

/// Remove unused lock files. Any lock file that can be exclusively locked is
/// not held by any process and can be safely deleted — `open_lock_file` will
/// recreate it on next use, and the inode recheck in `lock.rs` prevents races.
async fn gc_orphaned_locks(home: &HomePaths, dry_run: bool) -> RunnerResult<u64> {
    let locks_dir = home.locks_dir();
    let Some(mut entries) = read_dir_or_missing(&locks_dir).await? else {
        return Ok(0);
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
                    warn!("cannot remove {}: {e}", lock_path.display());
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
/// Covers per-job logs (`network-*.jsonl`, `system-*.log`, `metrics-*.jsonl`,
/// `sandbox-ops-*.jsonl`) and runner instance logs (`runner-*.log`).
/// Returns `(files_removed, bytes_freed)`.
async fn gc_job_logs(home: &HomePaths, dry_run: bool) -> RunnerResult<(u64, u64)> {
    let logs_dir = home.logs_dir();
    let Some(mut entries) = read_dir_or_missing(&logs_dir).await? else {
        return Ok((0, 0));
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
                    warn!("cannot remove {}: {e}", entry.path().display());
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

/// Parse `v<major>.<minor>.<patch>` into a tuple for ordering. Returns `None`
/// for non-semver names so callers can filter them out in one pass.
fn parse_semver(name: &str) -> Option<(u32, u32, u32)> {
    let rest = name.strip_prefix('v')?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Remove old deployment version directories that are not actively running.
///
/// Scans `home.bin_dir()` for semver-named subdirectories (e.g. `v0.2.0`) and
/// deletes inactive versions (bin dir, runner config dir, and systemd unit).
///
/// Survival rules (any one keeps the version):
/// - `--protect-version` matches the name.
/// - The version is in the top `keep_latest` by semver descending. This covers
///   the "staged but not yet installed" case where two overlapping releases
///   race: the older release's promote must not wipe the newer release's
///   just-staged binary even though the newer unit isn't active yet.
/// - The corresponding systemd unit is active.
async fn gc_versions(
    home: &HomePaths,
    dry_run: bool,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> RunnerResult<Vec<String>> {
    let bin_dir = home.bin_dir();
    let Some(mut entries) = read_dir_or_missing(&bin_dir).await? else {
        return Ok(Vec::new());
    };

    // First pass: collect all semver-named dirs. We need the full set to
    // pick the top `keep_latest` by version, so we can't decide-and-delete
    // in one pass.
    let mut semver_dirs: Vec<(String, (u32, u32, u32))> = Vec::new();
    while let Some(entry) = next_entry_warn(&mut entries, "gc_versions", &bin_dir).await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(ver) = parse_semver(name) {
            semver_dirs.push((name.to_string(), ver));
        }
    }

    // Pick the top-N by semver descending. `keep_latest = None` means no
    // version-based protection (pre-#10411 behavior).
    let keep_count = keep_latest.unwrap_or(0);
    let kept_by_latest: HashSet<String> = if keep_count == 0 {
        HashSet::new()
    } else {
        let mut sorted = semver_dirs.clone();
        sorted.sort_by_key(|e| std::cmp::Reverse(e.1));
        sorted
            .into_iter()
            .take(keep_count)
            .map(|(n, _)| n)
            .collect()
    };

    let mut removed: Vec<String> = Vec::new();
    for (name, _) in &semver_dirs {
        if protect == Some(name.as_str()) {
            info!("version {name}: protected (--protect-version), skipping");
            continue;
        }

        if kept_by_latest.contains(name) {
            info!("version {name}: within --keep-latest, skipping");
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
                warn!("version {name}: cannot check unit status ({e}), assuming inactive");
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
                warn!("cannot remove {}: {e}", version_bin.display());
                continue;
            }

            // Best-effort remove runner config directory.
            let version_config = home.runners_dir().join(name);
            let _ = tokio::fs::remove_dir_all(&version_config).await;

            info!("removed version {name}");
        }
        removed.push(name.clone());
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
            // Re-check before disconnect while holding the same per-index lock
            // the allocator uses. Between the scan and now, the device could
            // have been freed and re-acquired by another runner.
            let result = match tokio::task::spawn_blocking(move || {
                super::nbd::disconnect_orphan_if_still_dead(device_index, pid)
            })
            .await
            {
                Ok(result) => result,
                Err(e) => {
                    tracing::warn!("nbd disconnect task failed for /dev/nbd{device_index}: {e}");
                    continue;
                }
            };

            match result {
                super::nbd::NbdOrphanDisconnect::Disconnected => {
                    info!(
                        "disconnected orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
                    );
                    cleaned += 1;
                }
                super::nbd::NbdOrphanDisconnect::Locked => {
                    info!("nbd{device_index}: skipping disconnect, NBD device lock is held");
                }
                super::nbd::NbdOrphanDisconnect::Changed => {
                    info!(
                        "nbd{device_index}: skipping disconnect, device state changed since scan"
                    );
                }
                super::nbd::NbdOrphanDisconnect::Failed(e) => {
                    info!("failed to disconnect orphan NBD device /dev/nbd{device_index}: {e}");
                }
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

/// Eligible `<version>` directory discovered during the scan phase.
///
/// The scan-time size and mtime are advisory: deletion reacquires the
/// per-version lock and revalidates both before removing the directory.
struct StorageCandidate {
    path: PathBuf,
    name: String,
    version: String,
    size: u64,
    mtime: SystemTime,
}

struct StorageEvictionResult {
    freed: u64,
    /// Candidate contribution to keep in `total_size` after this attempt.
    /// `None` removes the scan-time size from the cap calculation.
    remaining_size: Option<u64>,
    /// Candidate contribution to keep in `total_entries` after this attempt.
    /// Dry-runs set this to false to model the real deletion while leaving
    /// the filesystem untouched.
    remaining_entry: bool,
    /// True when a real run deleted the cache entry, or a dry-run would have.
    evicted: bool,
}

/// Bound `/var/lib/vm0-runner/storages/` to storage cache size and entry
/// limits by evicting least-recently-used `<version>` directories.
///
/// Entries younger than [`GC_MIN_AGE`] or whose per-version flock is held
/// are always protected — the former prevents races with a writer's
/// atomic rename-in, the latter protects an in-flight cache read. Stale
/// `<version>.tmp/` staging directories are removed under the final
/// version's flock so crashed writers do not leak disk indefinitely.
///
/// Missing `storages_dir` is a no-op (cold host before the cache writer
/// in #10808 lands).
async fn gc_storage_cache(home: &HomePaths, dry_run: bool) -> RunnerResult<u64> {
    gc_storage_cache_with_limits(
        home,
        STORAGE_CACHE_MAX_BYTES,
        STORAGE_CACHE_MAX_ENTRIES,
        dry_run,
    )
    .await
}

#[cfg(test)]
async fn gc_storage_cache_with_cap(
    home: &HomePaths,
    max_bytes: u64,
    dry_run: bool,
) -> RunnerResult<u64> {
    gc_storage_cache_with_limits(home, max_bytes, u64::MAX, dry_run).await
}

async fn gc_storage_cache_with_limits(
    home: &HomePaths,
    max_bytes: u64,
    max_entries: u64,
    dry_run: bool,
) -> RunnerResult<u64> {
    let storages_dir = home.storages_dir();
    let Some(mut name_entries) = read_dir_or_missing(&storages_dir).await? else {
        return Ok(0);
    };

    let now = SystemTime::now();
    let mut candidates: Vec<StorageCandidate> = Vec::new();
    // Bytes known to be on disk under the cap. Recent (age-protected) entries
    // count toward this so we shrink observed disk use to within the cap;
    // locked entries deliberately do NOT count — we cannot safely stat them
    // without racing the writer, and counting them would evict eligible
    // entries to make room for unmeasurable ones.
    let mut total_size: u64 = 0;
    // Entry cardinality is independent from byte accounting: locked or
    // probe-error entries still contribute to filesystem pressure even when
    // they cannot be safely evicted in this pass.
    let mut total_entries: u64 = 0;
    let mut freed: u64 = 0;
    let mut scanned_entries: u64 = 0;
    let mut eligible_entries: u64 = 0;
    let mut skipped_recent: u64 = 0;
    let mut skipped_locked: u64 = 0;
    let mut lock_probe_errors: u64 = 0;
    let mut evicted_entries: u64 = 0;

    while let Some(name_entry) =
        next_entry_warn(&mut name_entries, "gc_storage_cache", &storages_dir).await
    {
        let name_path = name_entry.path();
        let Some(name_str) = name_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name_path.is_dir() {
            continue;
        }

        let mut version_entries = match tokio::fs::read_dir(&name_path).await {
            Ok(rd) => rd,
            Err(e) => {
                warn!("storages/{name_str}: read failed ({e}), skipping");
                continue;
            }
        };

        while let Some(version_entry) =
            next_entry_warn(&mut version_entries, "gc_storage_cache", &name_path).await
        {
            let version_path = version_entry.path();
            let Some(version_str) = version_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !version_path.is_dir() {
                continue;
            }
            if let Some(final_version_hash) = version_str.strip_suffix(".tmp") {
                freed = freed.saturating_add(
                    gc_storage_staging_dir(
                        home,
                        name_str,
                        final_version_hash,
                        &version_path,
                        now,
                        dry_run,
                    )
                    .await,
                );
                continue;
            }

            scanned_entries = scanned_entries.saturating_add(1);
            total_entries = total_entries.saturating_add(1);

            let lock_path = home.storage_lock_for_cache_key(name_str, version_str);
            let lock = match probe_lock(&lock_path) {
                LockProbe::Free(l) => l,
                LockProbe::Held => {
                    skipped_locked = skipped_locked.saturating_add(1);
                    continue;
                }
                LockProbe::Error(_) => {
                    lock_probe_errors = lock_probe_errors.saturating_add(1);
                    continue;
                }
            };

            let (size, mtime) = dir_stats(&version_path).await;
            let age = now.duration_since(mtime).unwrap_or_default();
            total_size = total_size.saturating_add(size);
            drop(lock);
            if age < GC_MIN_AGE {
                skipped_recent = skipped_recent.saturating_add(1);
                continue;
            }

            let name = name_str.to_owned();
            let version = version_str.to_owned();
            eligible_entries = eligible_entries.saturating_add(1);
            candidates.push(StorageCandidate {
                path: version_path,
                name,
                version,
                size,
                mtime,
            });
        }
    }

    if total_size <= max_bytes && total_entries <= max_entries {
        return Ok(freed);
    }

    // LRU: evict oldest first until within cap.
    candidates.sort_by_key(|c| c.mtime);

    for c in candidates {
        if total_size <= max_bytes && total_entries <= max_entries {
            break;
        }
        let result = evict_storage_candidate(home, &c, now, dry_run).await;
        freed = freed.saturating_add(result.freed);
        if result.evicted {
            evicted_entries = evicted_entries.saturating_add(1);
        }
        total_size = total_size.saturating_sub(c.size);
        if let Some(remaining_size) = result.remaining_size {
            total_size = total_size.saturating_add(remaining_size);
        }
        total_entries = total_entries.saturating_sub(1);
        if result.remaining_entry {
            total_entries = total_entries.saturating_add(1);
        }
    }

    let eviction_action = if dry_run { "would_evict" } else { "evicted" };
    info!(
        "storage cache gc: scanned={scanned_entries}, eligible={eligible_entries}, skipped_recent={skipped_recent}, skipped_locked={skipped_locked}, lock_probe_errors={lock_probe_errors}, eviction_action={eviction_action}, evicted_entries={evicted_entries}, freed={}, remaining_bytes={}, remaining_entries={total_entries}, limits=({}, {max_entries} entries)",
        human_bytes(freed),
        human_bytes(total_size),
        human_bytes(max_bytes)
    );

    Ok(freed)
}

async fn evict_storage_candidate(
    home: &HomePaths,
    candidate: &StorageCandidate,
    now: SystemTime,
    dry_run: bool,
) -> StorageEvictionResult {
    let lock_path = home.storage_lock_for_cache_key(&candidate.name, &candidate.version);
    let lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            info!(
                "storages/{}/{}: in use, skipping",
                candidate.name, candidate.version
            );
            return StorageEvictionResult {
                freed: 0,
                remaining_size: None,
                remaining_entry: true,
                evicted: false,
            };
        }
        LockProbe::Error(e) => {
            info!(
                "storages/{}/{}: lock probe failed ({e}), skipping",
                candidate.name, candidate.version
            );
            return StorageEvictionResult {
                freed: 0,
                remaining_size: None,
                remaining_entry: true,
                evicted: false,
            };
        }
    };

    match tokio::fs::metadata(&candidate.path).await {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            info!(
                "storages/{}/{}: no longer a directory, skipping",
                candidate.name, candidate.version
            );
            return StorageEvictionResult {
                freed: 0,
                remaining_size: None,
                remaining_entry: false,
                evicted: false,
            };
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return StorageEvictionResult {
                freed: 0,
                remaining_size: None,
                remaining_entry: false,
                evicted: false,
            };
        }
        Err(e) => {
            warn!(
                "storages/{}/{}: stat failed ({e}), skipping",
                candidate.name, candidate.version
            );
            return StorageEvictionResult {
                freed: 0,
                remaining_size: Some(candidate.size),
                remaining_entry: true,
                evicted: false,
            };
        }
    }

    let (size, mtime) = dir_stats(&candidate.path).await;
    let age = now.duration_since(mtime).unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "storages/{}/{}: too recent ({}s), keeping",
            candidate.name,
            candidate.version,
            age.as_secs()
        );
        return StorageEvictionResult {
            freed: 0,
            remaining_size: Some(size),
            remaining_entry: true,
            evicted: false,
        };
    }

    if dry_run {
        return StorageEvictionResult {
            freed: size,
            remaining_size: None,
            remaining_entry: false,
            evicted: true,
        };
    }

    match tokio::fs::remove_dir_all(&candidate.path).await {
        Ok(()) => {
            remove_storage_lock_after_eviction(
                &lock_path,
                &lock,
                &candidate.name,
                &candidate.version,
            )
            .await;
            remove_empty_storage_name_dir_after_eviction(&candidate.path, &candidate.name).await;
            StorageEvictionResult {
                freed: size,
                remaining_size: None,
                remaining_entry: false,
                evicted: true,
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StorageEvictionResult {
            freed: 0,
            remaining_size: None,
            remaining_entry: false,
            evicted: false,
        },
        Err(e) => {
            warn!(
                "failed to remove storages/{}/{}: {e}",
                candidate.name, candidate.version
            );
            StorageEvictionResult {
                freed: 0,
                remaining_size: Some(size),
                remaining_entry: true,
                evicted: false,
            }
        }
    }
}

async fn remove_empty_storage_name_dir_after_eviction(version_path: &Path, name_hash: &str) {
    let Some(name_path) = version_path.parent() else {
        return;
    };

    match tokio::fs::remove_dir(name_path).await {
        Ok(()) => {}
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(e) => {
            warn!(
                "storages/{name_hash}: failed to remove empty storage directory {}: {e}",
                name_path.display()
            );
        }
    }
}

async fn remove_storage_lock_after_eviction(
    lock_path: &Path,
    lock: &Flock<std::fs::File>,
    name_hash: &str,
    version_hash: &str,
) {
    let Ok(lock_meta) = lock.metadata() else {
        return;
    };

    match std::fs::metadata(lock_path) {
        Ok(path_meta) if path_meta.ino() == lock_meta.ino() => {}
        Ok(_) => return,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => return,
    }

    match tokio::fs::remove_file(lock_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            warn!(
                "storages/{name_hash}/{version_hash}: failed to remove storage lock {}: {e}",
                lock_path.display()
            );
        }
    }
}

async fn gc_storage_staging_dir(
    home: &HomePaths,
    name_hash: &str,
    version_hash: &str,
    path: &Path,
    now: SystemTime,
    dry_run: bool,
) -> u64 {
    let lock_path = home.storage_lock_for_cache_key(name_hash, version_hash);
    let _lock = match probe_lock(&lock_path) {
        LockProbe::Free(l) => l,
        LockProbe::Held => {
            info!("storages/{name_hash}/{version_hash}.tmp: in use, skipping");
            return 0;
        }
        LockProbe::Error(e) => {
            info!("storages/{name_hash}/{version_hash}.tmp: lock probe failed ({e}), skipping");
            return 0;
        }
    };

    let (size, mtime) = dir_stats(path).await;
    let age = now.duration_since(mtime).unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "storages/{name_hash}/{version_hash}.tmp: too recent ({}s), keeping",
            age.as_secs()
        );
        return 0;
    }

    if dry_run {
        info!(
            "[dry-run] would remove stale storage staging storages/{name_hash}/{version_hash}.tmp ({})",
            human_bytes(size)
        );
    } else if let Err(e) = tokio::fs::remove_dir_all(path).await {
        warn!(
            "failed to remove stale storage staging storages/{name_hash}/{version_hash}.tmp: {e}"
        );
        return 0;
    } else {
        info!(
            "removed stale storage staging storages/{name_hash}/{version_hash}.tmp ({})",
            human_bytes(size)
        );
    }

    size
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

    #[test]
    fn lock_probe_inode_check_detects_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let held_lock = match probe_lock(&path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => panic!("new test lock must not be held"),
            LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
        };

        std::fs::remove_file(&path).unwrap();
        drop(lock::open_lock_file(&path).unwrap());

        assert!(
            !lock_probe_inode_is_current(&held_lock, &path).unwrap(),
            "inode check must reject a lock fd whose path was recreated"
        );
    }

    #[test]
    fn lock_file_inode_check_detects_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let file = lock::open_lock_file(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        drop(lock::open_lock_file(&path).unwrap());

        assert!(
            !lock_file_inode_is_current(&file, &path).unwrap(),
            "inode check must reject an opened lock fd whose path was recreated"
        );
    }

    fn test_home(root: &Path) -> HomePaths {
        HomePaths::with_root(root.to_path_buf())
    }

    #[tokio::test]
    async fn gc_debootstrap_missing_cache_dir_does_not_create_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());

        let freed = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            !home.debootstrap_dir().exists(),
            "missing debootstrap cache dir should remain absent"
        );
        assert!(
            !home.debootstrap_lock().exists(),
            "GC must not create the debootstrap lock when there is no cache dir"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_skips_when_cache_lock_is_held() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let cache_tar = debootstrap_dir.join("noble-amd64.tar");
        std::fs::write(&cache_tar, b"cached").unwrap();
        std::fs::File::open(&cache_tar)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();

        let lock_file = lock::open_lock_file(&home.debootstrap_lock()).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

        let freed = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            cache_tar.exists(),
            "active debootstrap cache tarball must survive GC"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_keeps_its_lock_file() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let lock_path = home.debootstrap_lock();
        drop(lock::open_lock_file(&lock_path).unwrap());
        std::fs::File::open(&lock_path)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();

        let freed = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            lock_path.exists(),
            "debootstrap GC must not remove its own lock file"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_ignores_non_cache_files() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let unrelated = debootstrap_dir.join("README");
        std::fs::write(&unrelated, b"metadata").unwrap();
        std::fs::File::open(&unrelated)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();

        let freed = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            unrelated.exists(),
            "debootstrap GC should only remove cache tarballs"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_removes_stale_temp_tarballs_but_keeps_recent_ones() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let stale_tmp = debootstrap_dir.join("noble-amd64.tar.tmp.123");
        let recent_tmp = debootstrap_dir.join("noble-amd64.tar.tmp.456");
        std::fs::write(&stale_tmp, b"stale partial").unwrap();
        std::fs::write(&recent_tmp, b"recent partial").unwrap();
        let stale_size = std::fs::metadata(&stale_tmp).unwrap().len();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&stale_tmp)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let freed = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, stale_size);
        assert!(
            !stale_tmp.exists(),
            "stale debootstrap temp tarball should be GC'd"
        );
        assert!(
            recent_tmp.exists(),
            "recent debootstrap temp tarball may still belong to an active build"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_temp_tarballs_do_not_consume_keep_latest_slots() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let stable_tar = debootstrap_dir.join("noble-amd64.tar");
        let newer_tmp = debootstrap_dir.join("noble-amd64.tar.tmp.789");
        std::fs::write(&stable_tar, b"stable").unwrap();
        std::fs::write(&newer_tmp, b"newer partial").unwrap();
        let temp_size = std::fs::metadata(&newer_tmp).unwrap().len();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let newer_time = old_time + Duration::from_secs(60);
        std::fs::File::open(&stable_tar)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
        std::fs::File::open(&newer_tmp)
            .unwrap()
            .set_times(FileTimes::new().set_modified(newer_time))
            .unwrap();

        let freed = gc_debootstrap(&home, Some(1), false).await.unwrap();

        assert_eq!(freed, temp_size);
        assert!(
            stable_tar.exists(),
            "keep_latest should protect the stable debootstrap tarball"
        );
        assert!(
            !newer_tmp.exists(),
            "stale temp tarballs must not consume keep_latest slots"
        );
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
    fn parse_semver_valid() {
        assert_eq!(parse_semver("v1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_semver("v0.2.10"), Some((0, 2, 10)));
        assert_eq!(parse_semver("v12.34.56"), Some((12, 34, 56)));
    }

    #[test]
    fn parse_semver_invalid() {
        assert!(parse_semver("staging").is_none());
        assert!(parse_semver("test-abc").is_none());
        assert!(parse_semver("v1.0").is_none());
        assert!(parse_semver("v1.0.0-rc1").is_none());
        assert!(parse_semver("1.0.0").is_none());
        assert!(parse_semver("").is_none());
        assert!(parse_semver("v").is_none());
        assert!(parse_semver("v1.0.0.0").is_none());
    }

    /// Ordering must be numeric (`v0.10.0 > v0.9.0`), not lexicographic.
    #[test]
    fn parse_semver_orders_numerically() {
        assert!(parse_semver("v0.10.0") > parse_semver("v0.9.0"));
        assert!(parse_semver("v1.0.0") > parse_semver("v0.99.99"));
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
        let mut removed = gc_versions(&home, false, None, None).await.unwrap();
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

        let removed = gc_versions(&home, true, None, None).await.unwrap();
        assert_eq!(removed, ["v1.0.0"]);
        assert!(bin_dir.join("v1.0.0").exists(), "dry-run should not delete");
    }

    #[tokio::test]
    async fn gc_versions_empty_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.bin_dir()).unwrap();

        let removed = gc_versions(&home, false, None, None).await.unwrap();
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn gc_versions_missing_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        // Don't create bin_dir — should return 0, not error.
        let removed = gc_versions(&home, false, None, None).await.unwrap();
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn gc_versions_protect_keeps_named_version() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let bin_dir = home.bin_dir();

        std::fs::create_dir_all(bin_dir.join("v1.0.0")).unwrap();
        std::fs::create_dir_all(bin_dir.join("v2.0.0")).unwrap();

        let mut removed = gc_versions(&home, false, Some("v1.0.0"), None)
            .await
            .unwrap();
        removed.sort();
        assert_eq!(removed, ["v2.0.0"]);
        assert!(
            bin_dir.join("v1.0.0").exists(),
            "skipped version should survive"
        );
        assert!(!bin_dir.join("v2.0.0").exists());
    }

    /// Two overlapping release pipelines can interleave: v0.88.2's promote
    /// runs `gc --keep-latest 6 --protect-version v0.88.2` after v0.88.3 has
    /// already staged its binary. `--keep-latest` must cover semver dirs so
    /// v0.88.3 survives by version ordering alone, not just `--protect-version`.
    #[tokio::test]
    async fn gc_versions_keep_latest_covers_staged_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let bin_dir = home.bin_dir();

        for v in ["v0.88.0", "v0.88.1", "v0.88.2", "v0.88.3"] {
            std::fs::create_dir_all(bin_dir.join(v)).unwrap();
        }

        // Simulating v0.88.2's own promote: protects itself, keeps top 1.
        // v0.88.3 must survive via keep_latest even though protect is v0.88.2.
        let mut removed = gc_versions(&home, false, Some("v0.88.2"), Some(1))
            .await
            .unwrap();
        removed.sort();
        assert_eq!(removed, ["v0.88.0", "v0.88.1"]);
        assert!(
            bin_dir.join("v0.88.3").exists(),
            "newest survives via keep_latest"
        );
        assert!(bin_dir.join("v0.88.2").exists(), "protect-version survives");
        assert!(!bin_dir.join("v0.88.1").exists());
        assert!(!bin_dir.join("v0.88.0").exists());
    }

    /// `--keep-latest` orders numerically, not lexicographically — v0.10.0
    /// must outrank v0.9.0.
    #[tokio::test]
    async fn gc_versions_keep_latest_numeric_ordering() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let bin_dir = home.bin_dir();

        for v in ["v0.9.0", "v0.10.0"] {
            std::fs::create_dir_all(bin_dir.join(v)).unwrap();
        }

        let removed = gc_versions(&home, false, None, Some(1)).await.unwrap();
        assert_eq!(removed, ["v0.9.0"]);
        assert!(bin_dir.join("v0.10.0").exists());
    }

    #[tokio::test]
    async fn gc_nested_images_empty_dir_returns_zero() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let freed = gc_nested_images(&home, Some(1), false).await.unwrap();
        assert_eq!(freed, 0);
    }

    #[test]
    fn template_warm_hash_accepts_current_and_legacy_names() {
        assert_eq!(template_warm_hash("template-warm-abc123"), Some("abc123"));
        assert_eq!(
            template_warm_hash("template-abc123.warm.tmp"),
            Some("abc123")
        );
        assert_eq!(template_warm_hash("template-warm-"), None);
        assert_eq!(template_warm_hash("rootfs-hash"), None);
    }

    #[tokio::test]
    async fn gc_nested_images_keeps_locked_current_template_warm_dir() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let warm_dir = home.images_dir().join("template-warm-abc123");
        std::fs::create_dir_all(&warm_dir).unwrap();
        std::fs::write(warm_dir.join("attempt-old.tmp"), b"partial").unwrap();

        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&warm_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let lock_file = lock::open_lock_file(&home.template_lock("abc123")).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(warm_dir.exists(), "active warm rootfs dir must survive GC");
    }

    #[tokio::test]
    async fn gc_nested_images_keeps_locked_template_warm_dir() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let warm_dir = home.images_dir().join("template-abc123.warm.tmp");
        std::fs::create_dir_all(&warm_dir).unwrap();
        std::fs::write(warm_dir.join("template.ext4"), b"partial").unwrap();

        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&warm_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let lock_file = lock::open_lock_file(&home.template_lock("abc123")).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(warm_dir.exists(), "active warm rootfs dir must survive GC");
    }

    #[tokio::test]
    async fn gc_nested_images_keeps_recent_template_warm_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let warm_dir = home.images_dir().join("template-abc123.warm.tmp");
        std::fs::create_dir_all(&warm_dir).unwrap();
        std::fs::write(warm_dir.join("template.ext4"), b"partial").unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            warm_dir.exists(),
            "recent warm rootfs dir must survive the GC grace window"
        );
    }

    #[tokio::test]
    async fn gc_nested_images_keeps_recent_current_template_warm_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let warm_dir = home.images_dir().join("template-warm-abc123");
        std::fs::create_dir_all(&warm_dir).unwrap();
        std::fs::write(warm_dir.join("attempt-new.tmp"), b"partial").unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            warm_dir.exists(),
            "recent warm rootfs dir must survive the GC grace window"
        );
    }

    #[tokio::test]
    async fn gc_nested_images_removes_stale_template_warm_dir() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let warm_dir = home.images_dir().join("template-abc123.warm.tmp");
        std::fs::create_dir_all(&warm_dir).unwrap();
        std::fs::write(warm_dir.join("template.ext4"), b"partial").unwrap();

        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&warm_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert!(
            !warm_dir.exists(),
            "stale warm rootfs dir should be removed"
        );
        assert!(freed > 0);
    }

    #[tokio::test]
    async fn gc_nested_images_removes_stale_current_template_warm_dir() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let warm_dir = home.images_dir().join("template-warm-abc123");
        std::fs::create_dir_all(&warm_dir).unwrap();
        std::fs::write(warm_dir.join("attempt-old.tmp"), b"partial").unwrap();

        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&warm_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert!(
            !warm_dir.exists(),
            "stale warm rootfs dir should be removed"
        );
        assert!(freed > 0);
    }

    #[tokio::test]
    async fn gc_nested_images_keeps_latest_single_rootfs() {
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

    /// Global top-N across rootfs: three distinct rootfs each with a single
    /// snapshot. `keep_latest=1` keeps only the globally newest; the other
    /// two rootfs become orphan (no surviving snapshot) and get deleted
    /// alongside their lone snapshot.
    #[tokio::test]
    async fn gc_nested_images_keeps_global_top_n_across_rootfs() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let specs: [(&str, &str, u64); 3] = [
            ("rootfs_oldest", "snap_oldest", 1_000_000),
            ("rootfs_middle", "snap_middle", 2_000_000),
            ("rootfs_newest", "snap_newest", 3_000_000),
        ];

        for (rootfs_name, snap_name, mtime_secs) in &specs {
            let rootfs_dir = images_dir.join(rootfs_name);
            let snap = rootfs_dir.join("snapshots").join(snap_name);
            std::fs::create_dir_all(&snap).unwrap();
            std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
            std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

            let t = SystemTime::UNIX_EPOCH + Duration::from_secs(*mtime_secs);
            std::fs::File::open(&snap)
                .unwrap()
                .set_times(FileTimes::new().set_modified(t))
                .unwrap();
            // Age-gate the rootfs dir so orphan cleanup is eligible.
            std::fs::File::open(&rootfs_dir)
                .unwrap()
                .set_times(FileTimes::new().set_modified(t))
                .unwrap();
        }

        let freed = gc_nested_images(&home, Some(1), false).await.unwrap();

        // Only the globally newest rootfs+snapshot should survive.
        assert!(
            images_dir.join("rootfs_newest").exists(),
            "globally newest rootfs should survive"
        );
        assert!(
            images_dir
                .join("rootfs_newest/snapshots/snap_newest")
                .exists(),
            "globally newest snapshot should survive"
        );
        assert!(
            !images_dir.join("rootfs_middle").exists(),
            "middle rootfs should be deleted (snapshot not in top-1)"
        );
        assert!(
            !images_dir.join("rootfs_oldest").exists(),
            "oldest rootfs should be deleted (snapshot not in top-1)"
        );
        assert!(freed > 0);
    }

    /// Top-N selection must pick across rootfs boundaries — if rootfs A has
    /// the newest snapshot and rootfs B has the second-newest, `keep_latest=2`
    /// must keep one from each rather than greedily draining A. Regression
    /// guard: a bug that reintroduced per-rootfs buckets would keep only A
    /// and drop B entirely.
    #[tokio::test]
    async fn gc_nested_images_top_n_spans_multiple_rootfs() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Two rootfs, each with one old snapshot. Rootfs A's snapshot is
        // newer than rootfs B's.
        let rootfs_a = images_dir.join("rootfs_a");
        let snap_a = rootfs_a.join("snapshots").join("snap_a");
        let rootfs_b = images_dir.join("rootfs_b");
        let snap_b = rootfs_b.join("snapshots").join("snap_b");
        for d in [&snap_a, &snap_b] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
        }
        std::fs::write(rootfs_a.join("rootfs.ext4"), b"rootfs_a").unwrap();
        std::fs::write(rootfs_b.join("rootfs.ext4"), b"rootfs_b").unwrap();

        let time_b = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let time_a = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        std::fs::File::open(&snap_a)
            .unwrap()
            .set_times(FileTimes::new().set_modified(time_a))
            .unwrap();
        std::fs::File::open(&snap_b)
            .unwrap()
            .set_times(FileTimes::new().set_modified(time_b))
            .unwrap();

        // keep_latest=2 with 2 total candidates across 2 rootfs → both stay.
        let freed = gc_nested_images(&home, Some(2), false).await.unwrap();
        assert!(snap_a.exists(), "snap_a (newest) must survive");
        assert!(
            snap_b.exists(),
            "snap_b (older, but still in top-2 globally) must survive"
        );
        assert_eq!(freed, 0, "no candidates should have been deleted");
    }

    /// Locked and recent snapshots are protected but must NOT consume a
    /// top-N slot — the quota applies only to the eligible (unlocked,
    /// old-enough) candidate pool. Regression guard for a variant where
    /// `keep_latest` was implemented against the raw snapshot count.
    #[tokio::test]
    async fn gc_nested_images_locked_and_recent_snapshots_dont_consume_top_n() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // rootfs_locked: one locked snapshot (in use) — protected, outside quota.
        let rootfs_locked = images_dir.join("rootfs_locked");
        let snap_locked = rootfs_locked.join("snapshots").join("snap_locked");
        std::fs::create_dir_all(&snap_locked).unwrap();
        std::fs::write(snap_locked.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_locked.join("rootfs.ext4"), b"r").unwrap();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&snap_locked)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        // rootfs_recent: one recent snapshot (< GC_MIN_AGE) — protected, outside quota.
        let rootfs_recent = images_dir.join("rootfs_recent");
        let snap_recent = rootfs_recent.join("snapshots").join("snap_recent");
        std::fs::create_dir_all(&snap_recent).unwrap();
        std::fs::write(snap_recent.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_recent.join("rootfs.ext4"), b"r").unwrap();
        // snap_recent mtime stays at "now" (default), so age < GC_MIN_AGE.

        // rootfs_old: two eligible old snapshots, only one should survive keep_latest=1.
        let rootfs_old = images_dir.join("rootfs_old");
        let snap_old_a = rootfs_old.join("snapshots").join("snap_old_a");
        let snap_old_b = rootfs_old.join("snapshots").join("snap_old_b");
        for d in [&snap_old_a, &snap_old_b] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
        }
        std::fs::write(rootfs_old.join("rootfs.ext4"), b"r").unwrap();
        let older = SystemTime::UNIX_EPOCH + Duration::from_secs(500_000);
        let newer = SystemTime::UNIX_EPOCH + Duration::from_secs(900_000);
        std::fs::File::open(&snap_old_a)
            .unwrap()
            .set_times(FileTimes::new().set_modified(older))
            .unwrap();
        std::fs::File::open(&snap_old_b)
            .unwrap()
            .set_times(FileTimes::new().set_modified(newer))
            .unwrap();

        // Hold a shared lock on snap_locked (simulating runner start).
        let snap_lock_file = lock::open_lock_file(&home.snapshot_lock("snap_locked")).unwrap();
        let _snap_held = Flock::lock(snap_lock_file, FlockArg::LockShared).unwrap();

        let freed = gc_nested_images(&home, Some(1), false).await.unwrap();

        // Protected: untouched.
        assert!(snap_locked.exists(), "locked snapshot must survive");
        assert!(snap_recent.exists(), "recent snapshot must survive");
        // Eligible pool = {snap_old_a, snap_old_b}. keep_latest=1 → snap_old_b
        // (newer mtime) survives, snap_old_a is deleted. Crucially, the quota
        // was NOT consumed by snap_locked or snap_recent.
        assert!(snap_old_b.exists(), "newer eligible snapshot must survive");
        assert!(
            !snap_old_a.exists(),
            "older eligible snapshot must be deleted (top-1 quota spent on snap_old_b)"
        );
        // rootfs_old still has snap_old_b → rootfs dir survives.
        assert!(rootfs_old.exists(), "rootfs with surviving snapshot stays");
        assert!(freed > 0);
    }

    /// A rootfs whose mtime is younger than `GC_MIN_AGE` must NOT be
    /// orphan-deleted, even after all its old snapshots are pruned. The
    /// `any_snapshot_survives=false` branch in Phase 3 routes through
    /// `try_delete_orphan_rootfs` which applies a second age check against
    /// the rootfs-dir mtime itself. Covers the invariant that removing a
    /// snapshot subdir does NOT bump the rootfs-dir mtime (only its
    /// `snapshots/` child's mtime), so a freshly-built rootfs is preserved
    /// during its build-release race window.
    #[tokio::test]
    async fn gc_nested_images_recent_rootfs_with_all_old_snaps_stays() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("rootfs_recent_shell");
        let snap = rootfs_dir.join("snapshots").join("snap_old");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        // Snapshot is old — eligible for deletion.
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&snap)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
        // Rootfs dir itself stays at mtime "now" (default) — inside GC_MIN_AGE.

        let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

        assert!(
            !snap.exists(),
            "old snapshot is eligible and must be deleted"
        );
        assert!(
            rootfs_dir.exists(),
            "rootfs dir is recent — must survive even with no snapshots left"
        );
        assert!(
            rootfs_dir.join("rootfs.ext4").exists(),
            "rootfs file must still be on disk"
        );
        assert!(freed > 0, "snapshot bytes should be counted as freed");
    }

    /// Dry-run under global top-N across multiple rootfs: the reported
    /// `freed` bytes must equal what a real run would free, with each
    /// orphaned rootfs contributing its *full* directory size (snapshot
    /// bytes + rootfs files) exactly once. Regression guard for the
    /// per-rootfs `dry_run_snapshot_bytes` overlap vector — an off-by-one
    /// or wrong-index subtraction would show up as a byte mismatch here.
    #[tokio::test]
    async fn gc_nested_images_dry_run_global_top_n_byte_accounting() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        // Three rootfs, each with one old snapshot, strictly increasing mtimes.
        let specs: [(&str, &str, u64); 3] = [
            ("rootfs_1", "snap_1", 1_000_000),
            ("rootfs_2", "snap_2", 2_000_000),
            ("rootfs_3", "snap_3", 3_000_000),
        ];
        for (rootfs_name, snap_name, mtime_secs) in &specs {
            let rootfs_dir = images_dir.join(rootfs_name);
            let snap = rootfs_dir.join("snapshots").join(snap_name);
            std::fs::create_dir_all(&snap).unwrap();
            std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
            std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
            let t = SystemTime::UNIX_EPOCH + Duration::from_secs(*mtime_secs);
            std::fs::File::open(&snap)
                .unwrap()
                .set_times(FileTimes::new().set_modified(t))
                .unwrap();
            // Age-gate the rootfs dir so orphan cleanup is eligible in
            // both dry-run and real-mode.
            std::fs::File::open(&rootfs_dir)
                .unwrap()
                .set_times(FileTimes::new().set_modified(t))
                .unwrap();
        }

        // Expected: dry-run with keep_latest=1 would wipe rootfs_1 and
        // rootfs_2 in full; rootfs_3's snapshot survives as top-1. The
        // reported bytes should equal the full dir size of rootfs_1 +
        // rootfs_2 (captured BEFORE dry-run, because dry-run leaves disk
        // untouched and we can measure after).
        let (rootfs_1_bytes, _) = dir_stats(&images_dir.join("rootfs_1")).await;
        let (rootfs_2_bytes, _) = dir_stats(&images_dir.join("rootfs_2")).await;
        let expected = rootfs_1_bytes + rootfs_2_bytes;
        assert!(expected > 0, "test fixture must have non-zero size");

        let freed = gc_nested_images(&home, Some(1), true).await.unwrap();

        // Dry-run leaves everything in place.
        assert!(images_dir.join("rootfs_1").exists());
        assert!(images_dir.join("rootfs_2").exists());
        assert!(images_dir.join("rootfs_3").exists());
        assert_eq!(
            freed, expected,
            "dry-run bytes must match the sum of orphaned rootfs dir sizes"
        );
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

    /// Dry-run over an orphaned rootfs (no `snapshots/` subdir) must count the
    /// would-be-freed bytes via `try_delete_orphan_rootfs`. Regression guard
    /// for the silent-zero bug where dry-run returned 0 and `run_gc` printed
    /// "nothing to clean up" despite per-entry "would delete" log lines.
    #[tokio::test]
    async fn gc_nested_images_dry_run_reports_orphan_rootfs_bytes() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("orphan_rootfs_dry");
        std::fs::create_dir_all(&rootfs_dir).unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::open(&rootfs_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (expected_size, _) = dir_stats(&rootfs_dir).await;
        assert!(expected_size > 0, "test fixture must have non-zero size");

        let freed = gc_nested_images(&home, None, true).await.unwrap();
        assert!(rootfs_dir.exists(), "dry-run must not delete orphan rootfs");
        assert_eq!(
            freed, expected_size,
            "dry-run must report would-be-freed bytes for orphan rootfs"
        );
    }

    /// Dry-run with keep_latest=0 over a rootfs whose only snapshot would be
    /// deleted: the rootfs becomes logically orphan, so the total covers the
    /// snapshot + rootfs.ext4 + metadata — i.e. the whole rootfs directory.
    /// Mirrors what a real `gc` run would free (snapshot physically deleted,
    /// then rootfs dir deleted).
    #[tokio::test]
    async fn gc_nested_images_dry_run_reports_would_be_freed() {
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
        // Age-gate the rootfs too so try_delete_orphan_rootfs doesn't
        // skip it as "too recent".
        std::fs::File::open(&rootfs_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        // The whole rootfs dir would vanish under real GC (all snapshots
        // deleted → rootfs becomes orphan → rootfs deleted). Dry-run must
        // report the same total.
        let (expected_size, _) = dir_stats(&rootfs_dir).await;
        assert!(expected_size > 0, "test fixture must have non-zero size");

        let freed = gc_nested_images(&home, Some(0), true).await.unwrap();
        assert!(snap.exists(), "dry-run must not delete snapshot");
        assert!(
            rootfs_dir.exists(),
            "dry-run must not delete rootfs directory"
        );
        assert_eq!(
            freed, expected_size,
            "dry-run must report total rootfs bytes when all snapshots would be deleted"
        );
    }

    /// Dry-run with keep_latest=1 over a rootfs with 2 eligible snapshots:
    /// one snapshot would survive, rootfs is NOT orphan, total covers only
    /// the deleted snapshot — not the rootfs itself.
    #[tokio::test]
    async fn gc_nested_images_dry_run_partial_kept_no_orphan() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let images_dir = home.images_dir();
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();

        let rootfs_dir = images_dir.join("rootfs_partial");
        let snap_old = rootfs_dir.join("snapshots").join("snap_old");
        let snap_new = rootfs_dir.join("snapshots").join("snap_new");
        for d in [&snap_old, &snap_new] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
        }
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

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

        let (expected_size, _) = dir_stats(&snap_old).await;
        assert!(expected_size > 0, "test fixture must have non-zero size");

        let freed = gc_nested_images(&home, Some(1), true).await.unwrap();
        assert!(snap_old.exists(), "dry-run must not delete snapshot");
        assert!(snap_new.exists(), "kept snapshot must survive dry-run");
        assert_eq!(
            freed, expected_size,
            "dry-run must report only the deleted snapshot bytes; rootfs stays because snap_new survives"
        );
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

    /// When the rootfs lock is held, GC skips the whole rootfs. This avoids
    /// racing `runner start`, which acquires shared rootfs before shared
    /// snapshot and may be between those two locks.
    #[tokio::test]
    async fn gc_nested_images_locked_rootfs_keeps_all_snapshots() {
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
            snap_old.exists(),
            "unlocked old snapshot should survive while rootfs lock is held"
        );
        assert!(snap_used.exists(), "locked snapshot must survive");
        assert!(rootfs_dir.exists(), "rootfs must survive (lock held)");
        assert_eq!(freed, 0);
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
    async fn gc_job_logs_deletes_stale_system_metrics_and_sandbox_ops() {
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

        let sandbox_ops_log =
            logs_dir.join("sandbox-ops-550e8400-e29b-41d4-a716-446655440000.jsonl");
        std::fs::write(&sandbox_ops_log, "{}").unwrap();
        std::fs::File::open(&sandbox_ops_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let (removed, _) = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(removed, 3);
        assert!(!system_log.exists());
        assert!(!metrics_log.exists());
        assert!(!sandbox_ops_log.exists());
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

    // -----------------------------------------------------------------------
    // gc_storage_cache tests
    // -----------------------------------------------------------------------

    fn make_storage_entry_at(dir: PathBuf, archive_bytes: &[u8], mtime: SystemTime) -> PathBuf {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("archive.tar.gz"), archive_bytes).unwrap();
        std::fs::File::open(&dir)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        dir
    }

    fn make_storage_entry(
        home: &HomePaths,
        name: &str,
        version: &str,
        archive_bytes: &[u8],
        mtime: SystemTime,
    ) -> PathBuf {
        make_storage_entry_at(home.storage_cache_dir(name, version), archive_bytes, mtime)
    }

    fn make_storage_staging_entry(
        home: &HomePaths,
        name: &str,
        version: &str,
        archive_bytes: &[u8],
        mtime: SystemTime,
    ) -> PathBuf {
        let final_dir = home.storage_cache_dir(name, version);
        let tmp_name = format!(
            "{}.tmp",
            final_dir.file_name().and_then(|n| n.to_str()).unwrap()
        );
        make_storage_entry_at(final_dir.with_file_name(tmp_name), archive_bytes, mtime)
    }

    fn count_storage_cache_versions(home: &HomePaths) -> usize {
        let Ok(name_entries) = std::fs::read_dir(home.storages_dir()) else {
            return 0;
        };

        name_entries
            .filter_map(Result::ok)
            .map(|name_entry| name_entry.path())
            .filter(|path| path.is_dir())
            .map(|name_path| {
                let Ok(version_entries) = std::fs::read_dir(name_path) else {
                    return 0;
                };
                version_entries
                    .filter_map(Result::ok)
                    .map(|version_entry| version_entry.path())
                    .filter(|path| {
                        path.is_dir()
                            && !path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| name.ends_with(".tmp"))
                    })
                    .count()
            })
            .sum()
    }

    async fn storage_candidate_for(path: PathBuf) -> StorageCandidate {
        let name = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap()
            .to_owned();
        let version = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .to_owned();
        let (size, mtime) = dir_stats(&path).await;
        StorageCandidate {
            path,
            name,
            version,
            size,
            mtime,
        }
    }

    #[tokio::test]
    async fn gc_storage_cache_missing_dir_returns_zero() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        // storages_dir does not exist.
        let freed = gc_storage_cache(&home, false).await.unwrap();
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_storage_cache_empty_dir_returns_zero() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.storages_dir()).unwrap();
        let freed = gc_storage_cache(&home, false).await.unwrap();
        assert_eq!(freed, 0);
    }

    #[tokio::test]
    async fn gc_storage_cache_under_cap_keeps_all() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let a = make_storage_entry(&home, "foo", "v1", &[0u8; 512], old);
        let b = make_storage_entry(&home, "bar", "v1", &[0u8; 512], old);

        // Cap comfortably above total footprint.
        let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
            .await
            .unwrap();

        assert_eq!(freed, 0);
        assert!(a.exists(), "under-cap entry should survive");
        assert!(b.exists(), "under-cap entry should survive");
    }

    #[tokio::test]
    async fn gc_storage_cache_ignores_non_directory_entries_for_entry_cap() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 32], old);
        let root_file = home.storages_dir().join("root-file");
        let version_file = entry.parent().unwrap().join("not-a-version");
        std::fs::write(&root_file, b"noise").unwrap();
        std::fs::write(&version_file, b"noise").unwrap();

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
            .await
            .unwrap();

        assert_eq!(freed, 0);
        assert!(entry.exists(), "only real version directories should count");
        assert!(
            root_file.exists(),
            "GC should ignore non-directory root entries"
        );
        assert!(
            version_file.exists(),
            "GC should ignore non-directory version entries"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_over_cap_evicts_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        // Three entries, strictly increasing mtime.
        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let t_mid = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(3_000_000);
        let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 128], t_old);
        let middle = make_storage_entry(&home, "foo", "v2", &[0u8; 128], t_mid);
        let newest = make_storage_entry(&home, "bar", "v1", &[0u8; 128], t_new);

        let (oldest_size, _) = dir_stats(&oldest).await;
        let (middle_size, _) = dir_stats(&middle).await;
        let (newest_size, _) = dir_stats(&newest).await;

        // Cap picked so only the oldest must be evicted to fit: total
        // (oldest+middle+newest) exceeds cap, but (middle+newest) fits.
        let cap = middle_size + newest_size;
        let freed = gc_storage_cache_with_cap(&home, cap, false).await.unwrap();

        assert!(!oldest.exists(), "oldest entry must be evicted");
        assert!(middle.exists(), "middle entry must survive");
        assert!(newest.exists(), "newest entry must survive");
        assert_eq!(freed, oldest_size);
    }

    #[tokio::test]
    async fn gc_storage_cache_over_entry_cap_evicts_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let t_mid = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(3_000_000);
        let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
        let middle = make_storage_entry(&home, "foo", "v2", &[0u8; 32], t_mid);
        let newest = make_storage_entry(&home, "bar", "v1", &[0u8; 32], t_new);
        let (oldest_size, _) = dir_stats(&oldest).await;

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 2, false)
            .await
            .unwrap();

        assert!(!oldest.exists(), "oldest entry must be evicted");
        assert!(middle.exists(), "middle entry must survive");
        assert!(
            middle.parent().unwrap().exists(),
            "storage name dir must remain while another version exists"
        );
        assert!(newest.exists(), "newest entry must survive");
        assert_eq!(freed, oldest_size);
        assert_eq!(count_storage_cache_versions(&home), 2);
    }

    #[tokio::test]
    async fn gc_storage_cache_tmp_entries_do_not_count_toward_entry_cap() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let real = make_storage_entry(&home, "foo", "v1", &[0u8; 32], old);
        let tmp = make_storage_staging_entry(&home, "foo", "v2", &[0u8; 32], SystemTime::now());

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
            .await
            .unwrap();

        assert_eq!(freed, 0);
        assert!(
            real.exists(),
            ".tmp staging dirs must not consume entry cap"
        );
        assert!(
            tmp.exists(),
            "recent .tmp staging dir must remain protected"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_entry_cap_preserves_recent_entries() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let fresh_a = make_storage_entry(&home, "foo", "v1", &[0u8; 32], SystemTime::now());
        let fresh_b = make_storage_entry(&home, "foo", "v2", &[0u8; 32], SystemTime::now());

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
            .await
            .unwrap();

        assert_eq!(freed, 0);
        assert!(fresh_a.exists(), "recent entry must survive");
        assert!(fresh_b.exists(), "recent entry must survive");
        assert_eq!(count_storage_cache_versions(&home), 2);
    }

    #[tokio::test]
    async fn gc_storage_cache_entry_cap_skips_locked_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_locked = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let t_unlocked = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let locked = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_locked);
        let unlocked = make_storage_entry(&home, "bar", "v1", &[0u8; 32], t_unlocked);
        let (unlocked_size, _) = dir_stats(&unlocked).await;

        let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
            .await
            .unwrap();

        assert!(locked.exists(), "locked entry must survive");
        assert!(!unlocked.exists(), "unlocked entry must be evicted");
        assert_eq!(freed, unlocked_size);
        assert_eq!(count_storage_cache_versions(&home), 1);
    }

    #[tokio::test]
    async fn gc_storage_cache_grace_protects_recent() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        // One old entry (eligible) and one fresh entry (age-protected).
        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let old_entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], t_old);
        // Fresh entry: mtime = now, inside GC_MIN_AGE grace window.
        let fresh = make_storage_entry(&home, "foo", "v2", &[0u8; 256], SystemTime::now());

        let (old_size, _) = dir_stats(&old_entry).await;

        // Cap forces eviction; only the old entry is eligible.
        let freed = gc_storage_cache_with_cap(&home, 128, false).await.unwrap();

        assert!(!old_entry.exists(), "old entry must be evicted");
        assert!(fresh.exists(), "fresh entry must survive grace window");
        assert_eq!(freed, old_size);
    }

    #[tokio::test]
    async fn gc_storage_cache_skips_locked_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let t_older = SystemTime::UNIX_EPOCH + Duration::from_secs(500_000);
        // Locked entry is the older one; without the lock it would be
        // evicted first. With the lock, the unlocked entry should be
        // evicted instead.
        let locked = make_storage_entry(&home, "foo", "v1", &[0u8; 256], t_older);
        let unlocked = make_storage_entry(&home, "bar", "v1", &[0u8; 256], t_old);

        // Hold a shared flock on the locked entry, simulating a reader.
        let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

        let (unlocked_size, _) = dir_stats(&unlocked).await;

        let freed = gc_storage_cache_with_cap(&home, 128, false).await.unwrap();

        assert!(locked.exists(), "locked entry must survive");
        assert!(!unlocked.exists(), "unlocked entry must be evicted");
        assert_eq!(freed, unlocked_size);
    }

    #[tokio::test]
    async fn gc_storage_cache_dry_run_reports_bytes_without_deleting() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 128], t_old);
        let newest = make_storage_entry(&home, "foo", "v2", &[0u8; 128], t_new);

        let (oldest_size, _) = dir_stats(&oldest).await;
        let (newest_size, _) = dir_stats(&newest).await;

        // Cap fits the newest alone, so a real run would evict only the
        // oldest. The dry-run must report the same byte count.
        let freed = gc_storage_cache_with_cap(&home, newest_size, true)
            .await
            .unwrap();

        assert!(oldest.exists(), "dry-run must not delete");
        assert!(newest.exists(), "dry-run must not delete");
        assert_eq!(
            freed, oldest_size,
            "dry-run must report the bytes a real run would free"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_entry_cap_dry_run_does_not_delete() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
        let newest = make_storage_entry(&home, "foo", "v2", &[0u8; 32], t_new);
        let oldest_lock = home.storage_lock("foo", "v1");
        let (oldest_size, _) = dir_stats(&oldest).await;

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, true)
            .await
            .unwrap();

        assert!(oldest.exists(), "dry-run must not delete oldest entry");
        assert!(newest.exists(), "dry-run must not delete newest entry");
        assert!(
            oldest_lock.exists(),
            "dry-run must not remove the lock file it would clean up"
        );
        assert_eq!(freed, oldest_size);
        assert_eq!(count_storage_cache_versions(&home), 2);
    }

    #[tokio::test]
    async fn gc_storage_cache_removes_lock_after_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
        let lock_path = home.storage_lock("foo", "v1");
        drop(lock::open_lock_file(&lock_path).unwrap());
        assert!(lock_path.exists(), "test setup must create the lock file");

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 0, false)
            .await
            .unwrap();

        assert!(freed > 0);
        assert!(!entry.exists(), "entry should be evicted");
        assert!(
            !lock_path.exists(),
            "matching storage lock should be removed with the evicted entry"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_removes_empty_name_dir_after_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
        let name_dir = entry.parent().unwrap().to_path_buf();

        let freed = gc_storage_cache_with_limits(&home, 1 << 20, 0, false)
            .await
            .unwrap();

        assert!(freed > 0);
        assert!(!entry.exists(), "entry should be evicted");
        assert!(
            !name_dir.exists(),
            "empty storage name dir should be removed with its last version"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_lock_cleanup_keeps_replaced_lock_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let lock_path = home.storage_lock("foo", "v1");
        let held_lock = match probe_lock(&lock_path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => panic!("new test lock must not be held"),
            LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
        };

        std::fs::remove_file(&lock_path).unwrap();
        drop(lock::open_lock_file(&lock_path).unwrap());
        assert!(
            lock_path.exists(),
            "test setup must recreate the lock path with a new inode"
        );

        remove_storage_lock_after_eviction(&lock_path, &held_lock, "foo", "v1").await;

        assert!(
            lock_path.exists(),
            "cleanup must not remove a lock path recreated after this lock was acquired"
        );
    }

    /// Stale `<version>.tmp/` staging directories are crash residue and
    /// should be cleaned even when completed cache entries are under cap.
    #[tokio::test]
    async fn gc_storage_cache_removes_stale_tmp_staging_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let real = make_storage_entry(&home, "foo", "v1", &[0u8; 128], t_old);
        let tmp = make_storage_staging_entry(&home, "foo", "v2", &[0u8; 128], t_old);
        let (tmp_size, _) = dir_stats(&tmp).await;

        let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
            .await
            .unwrap();

        assert_eq!(freed, tmp_size, "stale .tmp bytes must be reported");
        assert!(real.exists(), "real entry must survive");
        assert!(!tmp.exists(), "stale .tmp staging dir must be removed");
    }

    #[tokio::test]
    async fn gc_storage_cache_keeps_recent_tmp_staging_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let tmp = make_storage_staging_entry(&home, "foo", "v1", &[0u8; 128], SystemTime::now());

        let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
            .await
            .unwrap();

        assert_eq!(freed, 0);
        assert!(
            tmp.exists(),
            "recent .tmp staging dir must survive grace window"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_keeps_locked_tmp_staging_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let tmp = make_storage_staging_entry(&home, "foo", "v1", &[0u8; 128], t_old);
        let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

        let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
            .await
            .unwrap();

        assert_eq!(freed, 0);
        assert!(tmp.exists(), "locked .tmp staging dir must survive");
    }

    #[tokio::test]
    async fn gc_storage_cache_dry_run_reports_stale_tmp_without_deleting() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let tmp = make_storage_staging_entry(&home, "foo", "v1", &[0u8; 128], t_old);
        let (tmp_size, _) = dir_stats(&tmp).await;

        let freed = gc_storage_cache_with_cap(&home, 1 << 20, true)
            .await
            .unwrap();

        assert_eq!(freed, tmp_size);
        assert!(
            tmp.exists(),
            "dry-run must not delete stale .tmp staging dir"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_delete_recheck_skips_candidate_locked_after_scan() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
        let candidate = storage_candidate_for(entry.clone()).await;

        let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

        let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

        assert_eq!(result.freed, 0);
        assert_eq!(result.remaining_size, None);
        assert!(result.remaining_entry);
        assert!(!result.evicted);
        assert!(
            entry.exists(),
            "candidate locked after scan must survive delete recheck"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_delete_recheck_treats_missing_candidate_as_removed() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
        let candidate = storage_candidate_for(entry.clone()).await;

        std::fs::remove_dir_all(&entry).unwrap();

        let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

        assert_eq!(result.freed, 0);
        assert_eq!(result.remaining_size, None);
        assert!(!result.remaining_entry);
        assert!(!result.evicted);
    }

    #[tokio::test]
    async fn gc_storage_cache_delete_recheck_treats_file_candidate_as_removed() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
        let candidate = storage_candidate_for(entry.clone()).await;

        std::fs::remove_dir_all(&entry).unwrap();
        std::fs::write(&entry, b"not-a-directory").unwrap();

        let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

        assert_eq!(result.freed, 0);
        assert_eq!(result.remaining_size, None);
        assert!(!result.remaining_entry);
        assert!(!result.evicted);
        assert!(
            entry.is_file(),
            "non-directory replacement must not be treated as a live cache entry"
        );
    }

    #[tokio::test]
    async fn gc_storage_cache_delete_recheck_keeps_candidate_that_became_recent() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
        let candidate = storage_candidate_for(entry.clone()).await;

        std::fs::File::open(&entry)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()))
            .unwrap();

        let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;
        let (fresh_size, _) = dir_stats(&entry).await;

        assert_eq!(result.freed, 0);
        assert_eq!(result.remaining_size, Some(fresh_size));
        assert!(result.remaining_entry);
        assert!(!result.evicted);
        assert!(
            entry.exists(),
            "candidate that became recent after scan must survive delete recheck"
        );
    }

    const LOW_FD_STORAGE_GC_CHILD_ENV: &str = "VM0_RUNNER_LOW_FD_STORAGE_GC_CHILD";

    #[test]
    fn gc_storage_cache_many_candidates_does_not_exhaust_lock_fds() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .env(LOW_FD_STORAGE_GC_CHILD_ENV, "1")
            .arg("gc_storage_cache_many_candidates_low_fd_child")
            .arg("--ignored")
            .arg("--nocapture")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(
            output.status.success(),
            "low-fd storage GC child failed\nstatus: {}\nstdout:\n{}\nstderr:\n{}",
            output.status,
            stdout,
            stderr
        );
        assert!(
            stdout.contains("gc_storage_cache_many_candidates_low_fd_child"),
            "low-fd storage GC child did not run\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
    }

    #[tokio::test]
    #[ignore = "spawned by gc_storage_cache_many_candidates_does_not_exhaust_lock_fds"]
    async fn gc_storage_cache_many_candidates_low_fd_child() {
        if std::env::var_os(LOW_FD_STORAGE_GC_CHILD_ENV).is_none() {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.locks_dir()).unwrap();

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let entry_count = 220usize;
        let keep_count = 20usize;
        let mut entry_size = 0;
        for index in 0..entry_count {
            let entry =
                make_storage_entry(&home, &format!("low-fd-{index}"), "v1", &[0u8; 4096], old);
            if index == 0 {
                entry_size = dir_stats(&entry).await.0;
            }
        }
        assert!(
            entry_size > 0,
            "test storage entries must consume disk blocks"
        );

        set_soft_nofile_limit_for_child(128);

        let cap = entry_size * keep_count as u64;
        let freed = gc_storage_cache_with_cap(&home, cap, false).await.unwrap();
        let remaining = count_storage_cache_versions(&home);

        assert!(
            remaining <= keep_count,
            "storage GC left {remaining} versions with cap for {keep_count}; freed {freed}"
        );
    }

    fn set_soft_nofile_limit_for_child(limit: u64) {
        // This helper runs only in the spawned child process, so lowering the
        // process-wide fd limit cannot leak into the parent test runner.
        unsafe {
            let mut current = std::mem::MaybeUninit::<nix::libc::rlimit>::uninit();
            let rc = nix::libc::getrlimit(nix::libc::RLIMIT_NOFILE, current.as_mut_ptr());
            assert_eq!(
                rc,
                0,
                "getrlimit(RLIMIT_NOFILE) failed: {}",
                std::io::Error::last_os_error()
            );
            let current = current.assume_init();
            let target = std::cmp::min(limit as nix::libc::rlim_t, current.rlim_max);
            assert!(
                target >= 64,
                "RLIMIT_NOFILE hard limit {target} is too low for this regression test"
            );

            let next = nix::libc::rlimit {
                rlim_cur: target,
                rlim_max: current.rlim_max,
            };
            let rc = nix::libc::setrlimit(nix::libc::RLIMIT_NOFILE, &next);
            assert_eq!(
                rc,
                0,
                "setrlimit(RLIMIT_NOFILE) failed: {}",
                std::io::Error::last_os_error()
            );
        }
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
