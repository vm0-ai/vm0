use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use nix::fcntl::Flock;
use tracing::{info, warn};

use crate::error::RunnerResult;
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{
    GcDirStatus, dir_stats, gc_entry_is_real_dir, gc_path_dir_status, next_entry_warn_or_stop,
    read_dir_or_missing,
};
use super::lock_file::{LockProbe, probe_lock};
use super::report::{GcReport, human_bytes};

/// Per-host storage archive cache size cap. Enforced by `gc_storage_cache`
/// as an LRU by `<version>/` dir mtime.
const STORAGE_CACHE_MAX_BYTES: u64 = 1 << 30; // 1 GiB
/// Per-host storage archive cache entry cap. The byte cap alone does not
/// bound many tiny storage versions, and each cached version also creates a
/// lock file.
const STORAGE_CACHE_MAX_ENTRIES: u64 = 5_000;

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
/// A missing `storages_dir` is a no-op: a host without a populated storage
/// cache has nothing to collect.
pub(super) async fn gc_storage_cache(home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport> {
    gc_storage_cache_with_limits_report(
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
    let report = gc_storage_cache_with_limits_report(home, max_bytes, u64::MAX, dry_run).await?;
    Ok(report.freed_bytes)
}

#[cfg(test)]
async fn gc_storage_cache_with_limits(
    home: &HomePaths,
    max_bytes: u64,
    max_entries: u64,
    dry_run: bool,
) -> RunnerResult<u64> {
    let report = gc_storage_cache_with_limits_report(home, max_bytes, max_entries, dry_run).await?;
    Ok(report.freed_bytes)
}

async fn gc_storage_cache_with_limits_report(
    home: &HomePaths,
    max_bytes: u64,
    max_entries: u64,
    dry_run: bool,
) -> RunnerResult<GcReport> {
    let storages_dir = home.storages_dir();
    let Some(mut name_entries) = read_dir_or_missing(&storages_dir).await? else {
        return Ok(GcReport::default());
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
    let mut activity_count: u64 = 0;
    let mut scanned_entries: u64 = 0;
    let mut eligible_entries: u64 = 0;
    let mut skipped_recent: u64 = 0;
    let mut skipped_locked: u64 = 0;
    let mut lock_probe_errors: u64 = 0;
    let mut evicted_entries: u64 = 0;

    while let Some(name_entry) =
        next_entry_warn_or_stop(&mut name_entries, "gc_storage_cache", &storages_dir).await
    {
        let name_path = name_entry.path();
        let Some(name_str) = name_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        match gc_entry_is_real_dir(&name_entry).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                warn!("storages/{name_str}: cannot read file type ({e}), skipping");
                continue;
            }
        }

        let mut version_entries = match tokio::fs::read_dir(&name_path).await {
            Ok(rd) => rd,
            Err(e) => {
                warn!("storages/{name_str}: read failed ({e}), skipping");
                continue;
            }
        };

        while let Some(version_entry) =
            next_entry_warn_or_stop(&mut version_entries, "gc_storage_cache", &name_path).await
        {
            let version_path = version_entry.path();
            let Some(version_str) = version_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            match gc_entry_is_real_dir(&version_entry).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(e) => {
                    warn!(
                        "storages/{name_str}/{version_str}: cannot read file type ({e}), skipping"
                    );
                    continue;
                }
            }
            if let Some(final_version_hash) = version_str.strip_suffix(".tmp") {
                if let Some(staging_freed) = gc_storage_staging_dir(
                    home,
                    name_str,
                    final_version_hash,
                    &version_path,
                    now,
                    dry_run,
                )
                .await
                {
                    freed = freed.saturating_add(staging_freed);
                    activity_count = activity_count.saturating_add(1);
                }
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
        return Ok(GcReport::cleanup(activity_count, freed));
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
            activity_count = activity_count.saturating_add(1);
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

    Ok(GcReport::cleanup(activity_count, freed))
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

    match gc_path_dir_status(&candidate.path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::NotDirectory) => {
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
        Ok(GcDirStatus::Missing) => {
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

    match tokio::fs::symlink_metadata(lock_path).await {
        Ok(path_meta)
            if path_meta.dev() == lock_meta.dev() && path_meta.ino() == lock_meta.ino() => {}
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
) -> Option<u64> {
    let lock_path = home.storage_lock_for_cache_key(name_hash, version_hash);
    let _lock = match probe_lock(&lock_path) {
        LockProbe::Free(l) => l,
        LockProbe::Held => {
            info!("storages/{name_hash}/{version_hash}.tmp: in use, skipping");
            return None;
        }
        LockProbe::Error(e) => {
            info!("storages/{name_hash}/{version_hash}.tmp: lock probe failed ({e}), skipping");
            return None;
        }
    };

    match gc_path_dir_status(path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing | GcDirStatus::NotDirectory) => return None,
        Err(e) => {
            warn!("storages/{name_hash}/{version_hash}.tmp: stat failed ({e}), skipping");
            return None;
        }
    }

    let (size, mtime) = dir_stats(path).await;
    let age = now.duration_since(mtime).unwrap_or_default();
    if age < GC_MIN_AGE {
        info!(
            "storages/{name_hash}/{version_hash}.tmp: too recent ({}s), keeping",
            age.as_secs()
        );
        return None;
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
        return None;
    } else {
        info!(
            "removed stale storage staging storages/{name_hash}/{version_hash}.tmp ({})",
            human_bytes(size)
        );
    }

    Some(size)
}

#[cfg(test)]
mod tests;
