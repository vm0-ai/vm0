//! Local session workspace image cache.
//!
//! This cache stores reusable workspace drive images for session-backed runs.
//! Each cache entry is keyed by cache scope, profile, session id, and logical
//! workspace image size. The normalized working directory is still stored in
//! metadata and validated at promotion/reuse boundaries; the hash key itself
//! follows the canonical-workspace semantics in `paths.rs`. A cache entry
//! contains a `metadata.json` file and a `current.ext4` image file.
//!
//! ## Invariants
//!
//! - Within this module, entry paths are always derived from the same cache key
//!   through `CacheEntryPaths`; callers should not hand-roll per-entry paths.
//! - The shared cache root may contain entries for multiple runner groups. Reuse
//!   is scoped by cache key metadata; global inspection and GC may scan the
//!   shared root.
//! - Entry locks protect one cache key. Capacity lock protects budget-sensitive
//!   promotion and GC work across the shared cache root.
//! - GC takes the capacity lock and then uses non-blocking entry lock attempts.
//!   Promotion already holds or reacquires an entry lock and then uses a
//!   non-blocking capacity lock attempt. Do not turn either side into blocking
//!   nested lock acquisition.
//! - A checkout hit removes `metadata.json` before returning the current image as
//!   a move seed, so the cache entry is not reusable while the image is active.
//! - Metadata is reusable only when it matches the cache key inputs, workspace
//!   drive layout, terminal status, trust/state, and current image identity.
//! - GC refreshes a candidate and compares the current image identity before
//!   deleting, so concurrent replacement by another runner is preserved.

use std::path::PathBuf;
use std::sync::Arc;

use crate::paths::{HomePaths, RunnerPaths};

mod entry;
mod fs;
mod gc;
mod inspection;
mod lifecycle;
mod metadata;
mod path_safety;
mod types;

#[cfg(test)]
mod tests;

pub(crate) use lifecycle::{
    WorkspaceImageLease, WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityFailure,
    WorkspaceImagePromotionOutcome,
};
pub(crate) use types::{
    CacheBudget, FsStats, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImageActiveLeaseRequest, WorkspaceImageCacheInspection,
    WorkspaceImageCacheInspectionEntry, WorkspaceImageCacheInspectionStatus,
    WorkspaceImageCacheInspectionSummary, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest, WorkspaceImagePromotionIdentityMismatch,
    WorkspaceImagePromotionIdentityRequest, WorkspaceImagePromotionRequest,
};

const CACHE_FORMAT_VERSION: u32 = 1;
const CACHE_KEY_VERSION: u32 = 1;
const WORKSPACE_DRIVE_LAYOUT: &str = "workspace-drive-v1";
const GIB: u64 = 1024 * 1024 * 1024;
const MIN_FREE_BYTES_FLOOR: u64 = 50 * GIB;
const MAX_ENTRY_BYTES_CAP: u64 = 32 * GIB;

#[cfg(test)]
const TEST_FS_TOTAL_BYTES: u64 = 2_000 * GIB;
#[cfg(test)]
const TEST_FS_AVAILABLE_BYTES: u64 = 1_000 * GIB;

#[derive(Clone)]
pub(crate) struct SessionWorkspaceCache {
    inner: Arc<SessionWorkspaceCacheInner>,
}

struct SessionWorkspaceCacheInner {
    paths: RunnerPaths,
    cache_dir: PathBuf,
    lock_dir: PathBuf,
    cache_scope: String,
    #[cfg(test)]
    fs_stats_override: FsStats,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TemporaryPathStats {
    path_count: usize,
    allocated_bytes: u64,
}

impl SessionWorkspaceCache {
    #[cfg(test)]
    pub(crate) fn new(paths: RunnerPaths) -> Self {
        let cache_dir = paths.workspace_image_cache_dir();
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs(paths, cache_dir, lock_dir, "")
    }

    #[cfg(test)]
    fn new_with_fs_stats(paths: RunnerPaths, fs_stats: FsStats) -> Self {
        let cache_dir = paths.workspace_image_cache_dir();
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs_and_fs_stats(paths, cache_dir, lock_dir, "", fs_stats)
    }

    pub(crate) fn shared(paths: RunnerPaths, home: &HomePaths, cache_scope: &str) -> Self {
        Self::with_cache_dirs(
            paths,
            home.workspace_image_cache_dir(),
            home.locks_dir(),
            cache_scope,
        )
    }

    fn with_cache_dirs(
        paths: RunnerPaths,
        cache_dir: PathBuf,
        lock_dir: PathBuf,
        cache_scope: &str,
    ) -> Self {
        #[cfg(test)]
        {
            Self::with_cache_dirs_and_fs_stats(
                paths,
                cache_dir,
                lock_dir,
                cache_scope,
                FsStats {
                    total_bytes: TEST_FS_TOTAL_BYTES,
                    available_bytes: TEST_FS_AVAILABLE_BYTES,
                },
            )
        }

        #[cfg(not(test))]
        {
            Self {
                inner: Arc::new(SessionWorkspaceCacheInner {
                    paths,
                    cache_dir,
                    lock_dir,
                    cache_scope: cache_scope.to_owned(),
                }),
            }
        }
    }

    #[cfg(test)]
    fn with_cache_dirs_and_fs_stats(
        paths: RunnerPaths,
        cache_dir: PathBuf,
        lock_dir: PathBuf,
        cache_scope: &str,
        fs_stats: FsStats,
    ) -> Self {
        Self {
            inner: Arc::new(SessionWorkspaceCacheInner {
                paths,
                cache_dir,
                lock_dir,
                cache_scope: cache_scope.to_owned(),
                fs_stats_override: fs_stats,
            }),
        }
    }

    pub(crate) fn paths(&self) -> &RunnerPaths {
        &self.inner.paths
    }
}
