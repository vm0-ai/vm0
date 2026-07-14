use std::path::{Path, PathBuf};
use std::time::SystemTime;

use nix::fcntl::Flock;
use tracing::{info, warn};

use crate::error::RunnerResult;
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{
    GcDirStatus, dir_stats, gc_entry_is_real_dir, gc_path_dir_status, next_entry_warn,
    read_dir_or_missing,
};
use super::image_refs::{ProtectedImageRefs, is_protected_image_ref};
use super::lock_file::{LockProbe, probe_lock};
use super::report::{GcReport, human_bytes};

const TEMPLATE_WARM_DIR_PREFIX: &str = "template-warm-";

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
/// Caller must hold the exclusive rootfs lock. Returns the freed bytes when
/// deletion succeeds or would occur, including `Some(0)` for zero-byte work.
async fn try_delete_orphan_rootfs(
    rootfs_path: &Path,
    rootfs_hash: &str,
    dry_run: bool,
) -> Option<u64> {
    match gc_path_dir_status(rootfs_path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing | GcDirStatus::NotDirectory) => return None,
        Err(e) => {
            warn!("images/{rootfs_hash}: stat failed ({e}), skipping");
            return None;
        }
    }

    let (rootfs_size, rootfs_mtime) = dir_stats(rootfs_path).await;
    let age = SystemTime::now()
        .duration_since(rootfs_mtime)
        .unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "images/{rootfs_hash}: orphaned but too recent ({}s), keeping",
            age.as_secs()
        );
        return None;
    }
    if dry_run {
        info!(
            "[dry-run] would delete orphaned rootfs images/{rootfs_hash} ({})",
            human_bytes(rootfs_size)
        );
    } else if let Err(e) = tokio::fs::remove_dir_all(rootfs_path).await {
        warn!("failed to remove orphaned rootfs images/{rootfs_hash}: {e}");
        return None;
    } else {
        info!(
            "deleted orphaned rootfs images/{rootfs_hash} ({})",
            human_bytes(rootfs_size)
        );
    }
    Some(rootfs_size)
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
) -> Option<u64> {
    let lock_path = home.template_lock(template_hash);
    let _lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            info!("images/{warm_name}: template warm dir in use, skipping");
            return None;
        }
        LockProbe::Error(e) => {
            info!("images/{warm_name}: template lock probe failed ({e}), skipping");
            return None;
        }
    };

    match gc_path_dir_status(warm_path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing | GcDirStatus::NotDirectory) => return None,
        Err(e) => {
            warn!("images/{warm_name}: stat failed ({e}), skipping");
            return None;
        }
    }

    let (size, mtime) = dir_stats(warm_path).await;
    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "images/{warm_name}: template warm dir too recent ({}s), keeping",
            age.as_secs()
        );
        return None;
    }
    if dry_run {
        info!(
            "[dry-run] would delete template warm dir images/{warm_name} ({})",
            human_bytes(size)
        );
    } else if let Err(e) = tokio::fs::remove_dir_all(warm_path).await {
        warn!("failed to remove template warm dir images/{warm_name}: {e}");
        return None;
    } else {
        info!(
            "deleted template warm dir images/{warm_name} ({})",
            human_bytes(size)
        );
    }
    Some(size)
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
#[cfg(test)]
async fn gc_nested_images(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let protected_image_refs = ProtectedImageRefs::new();
    let report =
        gc_nested_images_with_protected_refs(home, keep_latest, dry_run, &protected_image_refs)
            .await?;
    Ok(report.freed_bytes)
}

pub(super) async fn gc_nested_images_with_protected_refs(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
    protected_image_refs: &ProtectedImageRefs,
) -> RunnerResult<GcReport> {
    let images_dir = home.images_dir();
    let Some(mut rootfs_entries) = read_dir_or_missing(&images_dir).await? else {
        return Ok(GcReport::default());
    };

    let mut report = GcReport::default();
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

        // Skip non-directories (e.g. stale temp files) and symlinks.
        match gc_entry_is_real_dir(&rootfs_entry).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                warn!("images/{rootfs_hash}: cannot read file type ({e}), skipping");
                continue;
            }
        }

        if let Some(template_hash) = template_warm_hash(&rootfs_hash) {
            if let Some(freed_bytes) =
                gc_template_warm_dir(home, &rootfs_path, &rootfs_hash, template_hash, dry_run).await
            {
                report += GcReport::cleanup(1, freed_bytes);
            }
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
        match gc_path_dir_status(&snapshots_dir).await {
            Ok(GcDirStatus::RealDir(_)) => {}
            Ok(GcDirStatus::Missing) => {
                // No snapshots/ subdirectory — orphaned rootfs, handle inline.
                if let Some(freed_bytes) =
                    try_delete_orphan_rootfs(&rootfs_path, &rootfs_hash, dry_run).await
                {
                    report += GcReport::cleanup(1, freed_bytes);
                }
                continue;
            }
            Ok(GcDirStatus::NotDirectory) => {
                info!("images/{rootfs_hash}/snapshots: not a real directory, skipping");
                continue;
            }
            Err(e) => {
                warn!("images/{rootfs_hash}/snapshots: stat failed ({e}), skipping");
                continue;
            }
        }
        let mut snapshot_entries = match tokio::fs::read_dir(&snapshots_dir).await {
            Ok(rd) => rd,
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
            match gc_entry_is_real_dir(&snap_entry).await {
                Ok(true) => {}
                Ok(false) => {
                    mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                    continue;
                }
                Err(e) => {
                    mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                    warn!(
                        "images/{rootfs_hash}/snapshots/{snap_hash}: cannot read file type ({e}), skipping"
                    );
                    continue;
                }
            }

            if is_protected_image_ref(protected_image_refs, &rootfs_hash, &snap_hash) {
                mark_rootfs_survives(&mut rootfs_states, rootfs_idx);
                info!(
                    "images/{rootfs_hash}/snapshots/{snap_hash}: referenced by retained runner or service config, keeping"
                );
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
        report += GcReport::cleanup(1, c.size);
    }

    // Phase 3: any rootfs whose lock we hold AND where no snapshot survives
    // is orphan — delete the rootfs directory itself. In dry-run mode
    // `try_delete_orphan_rootfs` stats the rootfs *including* the snapshot
    // subdirs we already counted (dry-run leaves them on disk), so subtract
    // that overlap to match the real-mode total.
    for (idx, state) in rootfs_states.iter().enumerate() {
        if !state.any_snapshot_survives
            && let Some(rootfs_bytes) =
                try_delete_orphan_rootfs(&state.path, &state.hash, dry_run).await
        {
            let overlap = if dry_run {
                dry_run_snapshot_bytes.get(idx).copied().unwrap_or(0)
            } else {
                0
            };
            report += GcReport::cleanup(1, rootfs_bytes.saturating_sub(overlap));
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests;
