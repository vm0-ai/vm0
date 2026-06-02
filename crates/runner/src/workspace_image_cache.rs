use std::collections::BTreeMap;
#[cfg(not(test))]
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use chrono::SecondsFormat;
use nix::fcntl::Flock;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncReadExt;
use tracing::{debug, info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::idle_pool::StorageFingerprints;
use crate::ids::RunId;
#[cfg(test)]
use crate::paths::session_workspace_cache_key;
use crate::paths::{
    HomePaths, RunnerPaths, scoped_session_workspace_cache_key, workspace_image_cache_lock_path,
};
use crate::types::{HeldSessionState, MAX_HELD_SESSION_STATES};

const CACHE_FORMAT_VERSION: u32 = 1;
const CACHE_KEY_VERSION: u32 = 1;
const WORKSPACE_DRIVE_LAYOUT: &str = "workspace-drive-v1";
const GIB: u64 = 1024 * 1024 * 1024;
const MIN_FREE_BYTES_FLOOR: u64 = 50 * GIB;
const MAX_ENTRY_BYTES_CAP: u64 = 32 * GIB;
const WORKSPACE_IMAGE_COPY_TIMEOUT: Duration = Duration::from_secs(300);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceCacheCheckoutResult {
    Hit,
    Miss,
    NoSession,
    InvalidWorkingDir,
    LockBusy,
    InvalidMetadata,
    DiskPressure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceCacheTerminalStatus {
    Success,
    NonzeroExit,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceCacheState {
    Current,
    Dirty,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceTrust {
    Clean,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImagePrepareRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: &'a str,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) working_dir: &'a str,
    pub(crate) image_size_bytes: u64,
    pub(crate) workspace_drive_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceImageActiveLeaseRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) profile_name: &'a str,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) working_dir: &'a str,
    pub(crate) image_size_bytes: u64,
    pub(crate) workspace_drive_available: bool,
}

pub(crate) struct WorkspaceImageLease {
    cache: SessionWorkspaceCache,
    cache_key: Option<String>,
    profile_name: String,
    session_id: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    source_image: Option<PathBuf>,
    image_size_bytes: u64,
    workspace_drive_enabled: bool,
    result: WorkspaceCacheCheckoutResult,
    previous_storage: Option<StorageFingerprints>,
    entry_lock: Option<Flock<std::fs::File>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCacheMetadata {
    format_version: u32,
    key_version: u32,
    cache_scope: String,
    profile_name: String,
    session_id: String,
    working_dir: String,
    last_completed_at: String,
    last_used_at: String,
    last_terminal_status: WorkspaceCacheTerminalStatus,
    workspace_trust: WorkspaceTrust,
    logical_image_size_bytes: u64,
    allocated_bytes: u64,
    current_image: WorkspaceImageFileIdentity,
    drive_layout: String,
    storage_fingerprints: StorageFingerprints,
    state: WorkspaceCacheState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceImageFileIdentity {
    dev: u64,
    ino: u64,
    len: u64,
}

impl WorkspaceImageFileIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            len: metadata.len(),
        }
    }
}

fn workspace_image_size_mb(image_size_bytes: u64) -> u32 {
    let mib = 1024 * 1024;
    image_size_bytes.div_ceil(mib).min(u64::from(u32::MAX)) as u32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FsStats {
    total_bytes: u64,
    available_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CacheBudget {
    pub(crate) max_cache_bytes: u64,
    pub(crate) target_after_gc_bytes: u64,
    pub(crate) min_free_bytes: u64,
    pub(crate) max_entry_bytes: u64,
}

impl CacheBudget {
    pub(crate) fn from_fs_stats(stats: FsStats) -> Self {
        let max_cache_bytes = stats.total_bytes.saturating_mul(50) / 100;
        let target_after_gc_bytes = max_cache_bytes.saturating_mul(75) / 100;
        let min_free_bytes = (stats.total_bytes.saturating_mul(10) / 100).max(MIN_FREE_BYTES_FLOOR);
        let max_entry_bytes = (stats.total_bytes.saturating_mul(5) / 100).min(MAX_ENTRY_BYTES_CAP);
        Self {
            max_cache_bytes,
            target_after_gc_bytes,
            min_free_bytes,
            max_entry_bytes,
        }
    }
}

impl SessionWorkspaceCache {
    #[cfg(test)]
    pub(crate) fn new(paths: RunnerPaths) -> Self {
        let cache_dir = paths.workspace_image_cache_dir();
        let lock_dir = paths.base_dir().join("locks");
        Self::with_cache_dirs(paths, cache_dir, lock_dir, "")
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
        Self {
            inner: Arc::new(SessionWorkspaceCacheInner {
                paths,
                cache_dir,
                lock_dir,
                cache_scope: cache_scope.to_owned(),
                #[cfg(test)]
                fs_stats_override: FsStats {
                    total_bytes: TEST_FS_TOTAL_BYTES,
                    available_bytes: TEST_FS_AVAILABLE_BYTES,
                },
            }),
        }
    }

    pub(crate) fn paths(&self) -> &RunnerPaths {
        &self.inner.paths
    }

    fn workspace_image_cache_dir(&self) -> &Path {
        &self.inner.cache_dir
    }

    #[cfg(not(test))]
    fn workspace_image_cache_fs_stats_path(&self) -> &Path {
        self.inner
            .cache_dir
            .parent()
            .unwrap_or(self.workspace_image_cache_dir())
    }

    async fn fs_stats(&self) -> RunnerResult<FsStats> {
        #[cfg(test)]
        {
            Ok(self.inner.fs_stats_override)
        }

        #[cfg(not(test))]
        {
            statvfs_bytes(self.workspace_image_cache_fs_stats_path()).await
        }
    }

    fn session_workspace_cache_entry_dir(&self, cache_key: &str) -> PathBuf {
        self.workspace_image_cache_dir().join(cache_key)
    }

    fn session_workspace_cache_metadata(&self, cache_key: &str) -> PathBuf {
        self.session_workspace_cache_entry_dir(cache_key)
            .join("metadata.json")
    }

    fn session_workspace_cache_current_image(&self, cache_key: &str) -> PathBuf {
        self.session_workspace_cache_entry_dir(cache_key)
            .join("current.ext4")
    }

    fn session_workspace_cache_tmp_image(&self, cache_key: &str, run_id: RunId) -> PathBuf {
        self.session_workspace_cache_entry_dir(cache_key)
            .join(format!("current.ext4.tmp.{run_id}"))
    }

    fn scoped_cache_key(
        &self,
        profile_name: &str,
        session_id: &str,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> String {
        scoped_session_workspace_cache_key(
            &self.inner.cache_scope,
            profile_name,
            session_id,
            working_dir,
            image_size_bytes,
        )
    }

    fn metadata_matches_cache_key(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
    ) -> bool {
        scoped_session_workspace_cache_key(
            &metadata.cache_scope,
            &metadata.profile_name,
            &metadata.session_id,
            &metadata.working_dir,
            metadata.logical_image_size_bytes,
        ) == cache_key
    }

    fn can_collect_metadata_scope(&self, metadata: &WorkspaceCacheMetadata) -> bool {
        self.inner.cache_scope.is_empty() || metadata.cache_scope == self.inner.cache_scope
    }

    pub(crate) async fn lease_active(
        &self,
        request: WorkspaceImageActiveLeaseRequest<'_>,
    ) -> WorkspaceImageLease {
        let active_image = self.paths().active_workspace_image(&request.sandbox_id);
        let normalized_working_dir = normalize_safe_guest_working_dir(request.working_dir);
        let lease_working_dir = normalized_working_dir
            .as_deref()
            .unwrap_or(request.working_dir);
        let active_lease = |result, lock, cache_key| WorkspaceImageLease {
            cache: self.clone(),
            cache_key,
            profile_name: request.profile_name.to_owned(),
            session_id: request.session_id.map(str::to_owned),
            working_dir: lease_working_dir.to_owned(),
            active_image: active_image.clone(),
            source_image: None,
            image_size_bytes: request.image_size_bytes,
            workspace_drive_enabled: request.workspace_drive_available,
            result,
            previous_storage: None,
            entry_lock: lock,
        };

        let Some(working_dir) = normalized_working_dir.as_deref() else {
            warn!(
                run_id = %request.run_id,
                working_dir = %request.working_dir,
                "workspace image cache active lease disabled for unsafe working directory"
            );
            return active_lease(WorkspaceCacheCheckoutResult::InvalidWorkingDir, None, None);
        };
        let Some(session_id) = request.session_id else {
            return active_lease(WorkspaceCacheCheckoutResult::NoSession, None, None);
        };

        let cache_key = self.scoped_cache_key(
            request.profile_name,
            session_id,
            working_dir,
            request.image_size_bytes,
        );
        match crate::lock::try_acquire(self.entry_lock_path(&cache_key)).await {
            Ok(lock) => active_lease(
                WorkspaceCacheCheckoutResult::Miss,
                Some(lock),
                Some(cache_key),
            ),
            Err(e) => {
                info!(
                    run_id = %request.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache active lease lock busy or unavailable; promotion disabled"
                );
                active_lease(WorkspaceCacheCheckoutResult::LockBusy, None, None)
            }
        }
    }

    pub(crate) async fn prepare(
        &self,
        request: WorkspaceImagePrepareRequest<'_>,
    ) -> WorkspaceImageLease {
        let active_image = self.paths().active_workspace_image(&request.sandbox_id);
        let normalized_working_dir = normalize_safe_guest_working_dir(request.working_dir);
        let lease_working_dir = normalized_working_dir
            .as_deref()
            .unwrap_or(request.working_dir);
        let workspace_drive =
            |result, source_image, previous_storage, lock, cache_key, workspace_drive_enabled| {
                WorkspaceImageLease {
                    cache: self.clone(),
                    cache_key,
                    profile_name: request.profile_name.to_owned(),
                    session_id: request.session_id.map(str::to_owned),
                    working_dir: lease_working_dir.to_owned(),
                    active_image: active_image.clone(),
                    source_image,
                    image_size_bytes: request.image_size_bytes,
                    workspace_drive_enabled,
                    result,
                    previous_storage,
                    entry_lock: lock,
                }
            };

        let Some(working_dir) = normalized_working_dir.as_deref() else {
            warn!(
                run_id = %request.run_id,
                working_dir = %request.working_dir,
                "workspace image cache disabled for unsafe working directory"
            );
            return workspace_drive(
                WorkspaceCacheCheckoutResult::InvalidWorkingDir,
                None,
                None,
                None,
                None,
                request.workspace_drive_required,
            );
        };
        let Some(session_id) = request.session_id else {
            return workspace_drive(
                WorkspaceCacheCheckoutResult::NoSession,
                None,
                None,
                None,
                None,
                true,
            );
        };
        let Ok(mut stats) = self.fs_stats().await else {
            warn!(
                run_id = %request.run_id,
                "workspace image cache disabled because filesystem stats are unavailable"
            );
            return workspace_drive(
                WorkspaceCacheCheckoutResult::DiskPressure,
                None,
                None,
                None,
                None,
                true,
            );
        };
        let mut budget = CacheBudget::from_fs_stats(stats);
        if stats.available_bytes < budget.min_free_bytes {
            match self.gc(false).await {
                Ok(freed) if freed > 0 => match self.fs_stats().await {
                    Ok(updated) => {
                        stats = updated;
                        budget = CacheBudget::from_fs_stats(stats);
                    }
                    Err(e) => warn!(
                        run_id = %request.run_id,
                        error = %e,
                        "workspace image cache stats refresh failed after GC"
                    ),
                },
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %request.run_id,
                    error = %e,
                    "workspace image cache GC failed before checkout"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %request.run_id,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache skipped due to free-space pressure"
            );
            return workspace_drive(
                WorkspaceCacheCheckoutResult::DiskPressure,
                None,
                None,
                None,
                None,
                true,
            );
        }

        let cache_key = self.scoped_cache_key(
            request.profile_name,
            session_id,
            working_dir,
            request.image_size_bytes,
        );
        let lock_path = self.entry_lock_path(&cache_key);
        let lock = match crate::lock::try_acquire(lock_path).await {
            Ok(lock) => lock,
            Err(e) => {
                info!(
                    run_id = %request.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache lock busy or unavailable; using fresh workspace image"
                );
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::LockBusy,
                    None,
                    None,
                    None,
                    None,
                    true,
                );
            }
        };

        let metadata_path = self.session_workspace_cache_metadata(&cache_key);
        let current_path = self.session_workspace_cache_current_image(&cache_key);
        let hit = match self
            .read_valid_metadata(
                &metadata_path,
                request.profile_name,
                session_id,
                working_dir,
                request.image_size_bytes,
            )
            .await
        {
            Ok(Some(metadata)) => {
                if !has_copy_headroom(stats, budget, metadata.allocated_bytes) {
                    match self.gc(false).await {
                        Ok(freed) if freed > 0 => match self.fs_stats().await {
                            Ok(updated) => {
                                stats = updated;
                                budget = CacheBudget::from_fs_stats(stats);
                            }
                            Err(e) => warn!(
                                run_id = %request.run_id,
                                cache_key,
                                error = %e,
                                "workspace image cache stats refresh failed after cache-hit GC"
                            ),
                        },
                        Ok(_) => {}
                        Err(e) => warn!(
                            run_id = %request.run_id,
                            cache_key,
                            error = %e,
                            "workspace image cache GC failed before cache hit checkout"
                        ),
                    }
                }
                if !has_copy_headroom(stats, budget, metadata.allocated_bytes) {
                    info!(
                        run_id = %request.run_id,
                        cache_key,
                        allocated_bytes = metadata.allocated_bytes,
                        available_bytes = stats.available_bytes,
                        min_free_bytes = budget.min_free_bytes,
                        "workspace image cache hit skipped due to free-space pressure"
                    );
                    if let Err(e) = self
                        .invalidate_current_image(
                            request.run_id,
                            &cache_key,
                            &current_path,
                            "cache hit checkout skipped due to free-space pressure",
                        )
                        .await
                    {
                        warn!(
                            run_id = %request.run_id,
                            cache_key,
                            error = %e,
                            "failed to invalidate workspace image cache baseline after checkout was skipped"
                        );
                        return workspace_drive(
                            WorkspaceCacheCheckoutResult::DiskPressure,
                            None,
                            None,
                            Some(lock),
                            None,
                            true,
                        );
                    }
                    return workspace_drive(
                        WorkspaceCacheCheckoutResult::DiskPressure,
                        None,
                        None,
                        Some(lock),
                        Some(cache_key),
                        true,
                    );
                }
                let previous = metadata.storage_fingerprints.clone();
                if let Err(e) = self
                    .write_metadata(
                        &cache_key,
                        request.run_id,
                        WorkspaceCacheMetadata {
                            last_used_at: local_timestamp(),
                            ..metadata
                        },
                    )
                    .await
                {
                    warn!(
                        run_id = %request.run_id,
                        cache_key,
                        error = %e,
                        "failed to update workspace image cache lastUsedAt"
                    );
                }
                Some((current_path, previous))
            }
            Ok(None) => None,
            Err(e) => {
                warn!(
                    run_id = %request.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache metadata invalid; using fresh workspace image"
                );
                let entry_dir = self.session_workspace_cache_entry_dir(&cache_key);
                match fs::remove_dir_all(&entry_dir).await {
                    Ok(()) => {
                        info!(
                            run_id = %request.run_id,
                            cache_key,
                            "removed invalid workspace image cache entry before fresh checkout"
                        );
                        return workspace_drive(
                            WorkspaceCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                        );
                    }
                    Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => {
                        return workspace_drive(
                            WorkspaceCacheCheckoutResult::Miss,
                            None,
                            None,
                            Some(lock),
                            Some(cache_key),
                            true,
                        );
                    }
                    Err(remove_error) => {
                        warn!(
                            run_id = %request.run_id,
                            cache_key,
                            error = %remove_error,
                            "failed to remove invalid workspace image cache entry"
                        );
                    }
                }
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::InvalidMetadata,
                    None,
                    None,
                    Some(lock),
                    Some(cache_key),
                    true,
                );
            }
        };

        match hit {
            Some((source, previous)) => workspace_drive(
                WorkspaceCacheCheckoutResult::Hit,
                Some(source),
                Some(previous),
                Some(lock),
                Some(cache_key),
                true,
            ),
            None => workspace_drive(
                WorkspaceCacheCheckoutResult::Miss,
                None,
                None,
                Some(lock),
                Some(cache_key),
                true,
            ),
        }
    }

    pub(crate) async fn held_session_states(&self) -> Vec<HeldSessionState> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn!(path = %root.display(), error = %e, "failed to scan workspace image cache");
                return Vec::new();
            }
        };
        let mut states = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(cache_key) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !is_cache_key_name(cache_key) {
                continue;
            }
            let Ok(lock) = crate::lock::try_acquire(self.entry_lock_path(cache_key)).await else {
                continue;
            };
            let metadata_path = self.session_workspace_cache_metadata(cache_key);
            let metadata = match self.read_metadata_file(&metadata_path).await {
                Ok(metadata) => metadata,
                Err(_) => {
                    drop(lock);
                    continue;
                }
            };
            if metadata.format_version == CACHE_FORMAT_VERSION
                && metadata.key_version == CACHE_KEY_VERSION
                && metadata.cache_scope == self.inner.cache_scope
                && metadata.drive_layout == WORKSPACE_DRIVE_LAYOUT
                && metadata.state == WorkspaceCacheState::Current
                && metadata.workspace_trust == WorkspaceTrust::Clean
                && is_safe_guest_working_dir(&metadata.working_dir)
                && self.metadata_matches_cache_key(cache_key, &metadata)
                && self
                    .metadata_matches_current_image(cache_key, &metadata)
                    .await
            {
                states.push(HeldSessionState {
                    session_id: metadata.session_id,
                    last_completed_at: metadata.last_completed_at,
                });
            }
            drop(lock);
        }
        cap_workspace_held_session_states(states)
    }

    pub(crate) async fn gc(&self, dry_run: bool) -> RunnerResult<u64> {
        let temporary_freed = self.gc_temporary_images(dry_run).await?;
        let stale_entry_freed = self.gc_entries_without_current_image(dry_run).await?;
        let unusable_current_freed = self.gc_unusable_current_entries(dry_run).await?;
        let stats = self.fs_stats().await?;
        let budget = CacheBudget::from_fs_stats(stats);
        let mut candidates = self.gc_candidates().await?;
        let mut entry_count = candidates.len();
        let mut total: u64 = candidates
            .iter()
            .map(|candidate| candidate.allocated_bytes)
            .sum();
        let needs_budget_gc =
            total > budget.max_cache_bytes || stats.available_bytes < budget.min_free_bytes;
        if !needs_budget_gc && entry_count <= MAX_HELD_SESSION_STATES {
            return Ok(temporary_freed
                .saturating_add(stale_entry_freed)
                .saturating_add(unusable_current_freed));
        }
        candidates.sort_by(|left, right| {
            left.last_used_at
                .cmp(&right.last_used_at)
                .then_with(|| left.cache_key.cmp(&right.cache_key))
        });
        let mut freed = temporary_freed
            .saturating_add(stale_entry_freed)
            .saturating_add(unusable_current_freed);
        let mut candidate_freed: u64 = 0;
        for candidate in candidates {
            if gc_budget_satisfied(
                needs_budget_gc,
                total,
                entry_count,
                stats,
                budget,
                candidate_freed,
            ) {
                break;
            }
            let Ok(lock) =
                crate::lock::try_acquire(self.entry_lock_path(&candidate.cache_key)).await
            else {
                continue;
            };
            let Some(refreshed) = self.gc_candidate(candidate.cache_key.clone()).await else {
                drop(lock);
                continue;
            };
            if !refreshed.same_current_image(&candidate) {
                drop(lock);
                continue;
            }
            if dry_run {
                info!(
                    cache_key = candidate.cache_key,
                    allocated_bytes = refreshed.allocated_bytes,
                    "[dry-run] would delete workspace image cache entry"
                );
            } else if let Err(e) =
                fs::remove_dir_all(self.session_workspace_cache_entry_dir(&candidate.cache_key))
                    .await
            {
                warn!(
                    cache_key = candidate.cache_key,
                    error = %e,
                    "failed to delete workspace image cache entry"
                );
                drop(lock);
                continue;
            } else {
                info!(
                    cache_key = candidate.cache_key,
                    allocated_bytes = refreshed.allocated_bytes,
                    "deleted workspace image cache entry"
                );
            }
            total = total.saturating_sub(refreshed.allocated_bytes);
            entry_count = entry_count.saturating_sub(1);
            freed = freed.saturating_add(refreshed.allocated_bytes);
            candidate_freed = candidate_freed.saturating_add(refreshed.allocated_bytes);
            drop(lock);
        }
        Ok(freed)
    }

    async fn gc_unusable_current_entries(&self, dry_run: bool) -> RunnerResult<u64> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let mut freed: u64 = 0;
        while let Some(entry) = entries.next_entry().await? {
            if !entry_file_type_is_dir(&entry).await? {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            let Ok(lock) = crate::lock::try_acquire(self.entry_lock_path(&cache_key)).await else {
                continue;
            };
            let current = self.session_workspace_cache_current_image(&cache_key);
            let current_metadata = match fs::metadata(&current).await {
                Ok(metadata) => metadata,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    drop(lock);
                    continue;
                }
                Err(e) => {
                    drop(lock);
                    return Err(e.into());
                }
            };
            let metadata_path = self.session_workspace_cache_metadata(&cache_key);
            let reason = match self.read_metadata_file(&metadata_path).await {
                Ok(metadata) => {
                    self.unusable_current_entry_reason(&cache_key, &metadata, &current_metadata)
                }
                Err(RunnerError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    Some("missing metadata")
                }
                Err(RunnerError::Internal(_)) => Some("invalid metadata"),
                Err(e) => {
                    warn!(
                        cache_key,
                        error = %e,
                        "failed to inspect workspace image cache metadata during GC"
                    );
                    drop(lock);
                    continue;
                }
            };
            let Some(reason) = reason else {
                drop(lock);
                continue;
            };

            let entry_dir = entry.path();
            let allocated = flat_directory_allocated_bytes(&entry_dir).await;
            if dry_run {
                info!(
                    cache_key,
                    reason,
                    allocated_bytes = allocated,
                    "[dry-run] would delete unusable workspace image cache entry"
                );
            } else if let Err(e) = fs::remove_dir_all(&entry_dir).await {
                warn!(
                    cache_key,
                    reason,
                    path = %entry_dir.display(),
                    error = %e,
                    "failed to delete unusable workspace image cache entry"
                );
                drop(lock);
                continue;
            } else {
                info!(
                    cache_key,
                    reason,
                    allocated_bytes = allocated,
                    "deleted unusable workspace image cache entry"
                );
            }
            freed = freed.saturating_add(allocated);
            drop(lock);
        }
        Ok(freed)
    }

    fn unusable_current_entry_reason(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
        current_metadata: &std::fs::Metadata,
    ) -> Option<&'static str> {
        if metadata.format_version != CACHE_FORMAT_VERSION {
            return Some("metadata format version mismatch");
        }
        if metadata.key_version != CACHE_KEY_VERSION {
            return Some("metadata key version mismatch");
        }
        if metadata.drive_layout != WORKSPACE_DRIVE_LAYOUT {
            return Some("drive layout mismatch");
        }
        if metadata.state != WorkspaceCacheState::Current
            || metadata.workspace_trust != WorkspaceTrust::Clean
        {
            return Some("metadata is not reusable");
        }
        if !is_safe_guest_working_dir(&metadata.working_dir) {
            return Some("unsafe working dir");
        }
        if !self.metadata_matches_cache_key(cache_key, metadata) {
            return Some("cache key mismatch");
        }
        if validate_current_image_identity(metadata, current_metadata).is_err() {
            return Some("current image identity mismatch");
        }
        None
    }

    async fn gc_entries_without_current_image(&self, dry_run: bool) -> RunnerResult<u64> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let mut freed: u64 = 0;
        while let Some(entry) = entries.next_entry().await? {
            if !entry_file_type_is_dir(&entry).await? {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            let Ok(lock) = crate::lock::try_acquire(self.entry_lock_path(&cache_key)).await else {
                continue;
            };
            let current = self.session_workspace_cache_current_image(&cache_key);
            match fs::try_exists(&current).await {
                Ok(true) => {
                    drop(lock);
                    continue;
                }
                Ok(false) => {}
                Err(e) => {
                    drop(lock);
                    return Err(e.into());
                }
            }
            let entry_dir = entry.path();
            let allocated = flat_directory_allocated_bytes(&entry_dir).await;
            if dry_run {
                info!(
                    cache_key,
                    allocated_bytes = allocated,
                    "[dry-run] would delete stale workspace image cache entry"
                );
            } else if let Err(e) = fs::remove_dir_all(&entry_dir).await {
                warn!(
                    cache_key,
                    path = %entry_dir.display(),
                    error = %e,
                    "failed to delete stale workspace image cache entry"
                );
                drop(lock);
                continue;
            } else {
                info!(
                    cache_key,
                    allocated_bytes = allocated,
                    "deleted stale workspace image cache entry"
                );
            }
            freed = freed.saturating_add(allocated);
            drop(lock);
        }
        Ok(freed)
    }

    async fn gc_temporary_images(&self, dry_run: bool) -> RunnerResult<u64> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let mut freed: u64 = 0;
        while let Some(entry) = entries.next_entry().await? {
            if !entry_file_type_is_dir(&entry).await? {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            let Ok(lock) = crate::lock::try_acquire(self.entry_lock_path(&cache_key)).await else {
                continue;
            };
            let entry_dir = entry.path();
            let mut files = match fs::read_dir(&entry_dir).await {
                Ok(files) => files,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    drop(lock);
                    continue;
                }
                Err(e) => {
                    drop(lock);
                    return Err(e.into());
                }
            };
            while let Some(file) = files.next_entry().await? {
                if !entry_file_type_is_file(&file).await? {
                    continue;
                }
                let file_name = file.file_name();
                let Some(file_name) = file_name.to_str() else {
                    continue;
                };
                if !is_workspace_tmp_file_name(file_name) {
                    continue;
                }
                let path = file.path();
                let allocated = fs::metadata(&path)
                    .await
                    .map(|metadata| allocated_bytes(&metadata))
                    .unwrap_or(0);
                if dry_run {
                    info!(
                        cache_key,
                        path = %path.display(),
                        allocated_bytes = allocated,
                        "[dry-run] would delete temporary workspace image cache file"
                    );
                } else if let Err(e) = fs::remove_file(&path).await {
                    warn!(
                        cache_key,
                        path = %path.display(),
                        error = %e,
                        "failed to delete temporary workspace image cache file"
                    );
                    continue;
                } else {
                    info!(
                        cache_key,
                        path = %path.display(),
                        allocated_bytes = allocated,
                        "deleted temporary workspace image cache file"
                    );
                }
                freed = freed.saturating_add(allocated);
            }
            drop(lock);
        }
        Ok(freed)
    }

    async fn gc_candidates(&self) -> RunnerResult<Vec<GcCandidate>> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut candidates = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if !entry_file_type_is_dir(&entry).await? {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            let Some(candidate) = self.gc_candidate(cache_key).await else {
                continue;
            };
            candidates.push(candidate);
        }
        Ok(candidates)
    }

    async fn gc_candidate(&self, cache_key: String) -> Option<GcCandidate> {
        let metadata_path = self.session_workspace_cache_metadata(&cache_key);
        let current_path = self.session_workspace_cache_current_image(&cache_key);
        let file_metadata = fs::metadata(&current_path).await.ok()?;
        let last_used_at = match self.read_metadata_file(&metadata_path).await {
            Ok(metadata) => {
                if !self.can_collect_metadata_scope(&metadata) {
                    return None;
                }
                metadata.last_used_at
            }
            Err(_) if self.inner.cache_scope.is_empty() => String::new(),
            Err(_) => return None,
        };
        Some(GcCandidate {
            cache_key,
            allocated_bytes: allocated_bytes(&file_metadata),
            file_dev: file_metadata.dev(),
            file_ino: file_metadata.ino(),
            last_used_at,
        })
    }

    fn entry_lock_path(&self, cache_key: &str) -> PathBuf {
        workspace_image_cache_lock_path(&self.inner.lock_dir, cache_key)
    }

    async fn read_valid_metadata(
        &self,
        metadata_path: &Path,
        profile_name: &str,
        session_id: &str,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> RunnerResult<Option<WorkspaceCacheMetadata>> {
        let metadata = match self.read_metadata_file(metadata_path).await {
            Ok(metadata) => metadata,
            Err(RunnerError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let current_path = self.session_workspace_cache_current_image(&self.scoped_cache_key(
            profile_name,
            session_id,
            working_dir,
            image_size_bytes,
        ));
        let current_metadata = match fs::metadata(&current_path).await {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        validate_metadata(
            &metadata,
            &self.inner.cache_scope,
            profile_name,
            session_id,
            working_dir,
            image_size_bytes,
        )?;
        validate_current_image_identity(&metadata, &current_metadata)?;
        Ok(Some(metadata))
    }

    async fn metadata_matches_current_image(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
    ) -> bool {
        let current_path = self.session_workspace_cache_current_image(cache_key);
        let Ok(current_metadata) = fs::metadata(current_path).await else {
            return false;
        };
        validate_current_image_identity(metadata, &current_metadata).is_ok()
    }

    async fn read_metadata_file(
        &self,
        metadata_path: &Path,
    ) -> RunnerResult<WorkspaceCacheMetadata> {
        let bytes = fs::read(metadata_path).await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| RunnerError::Internal(format!("parse {}: {e}", metadata_path.display())))
    }

    async fn write_metadata(
        &self,
        cache_key: &str,
        run_id: RunId,
        metadata: WorkspaceCacheMetadata,
    ) -> RunnerResult<()> {
        let metadata_path = self.session_workspace_cache_metadata(cache_key);
        let tmp = metadata_path.with_file_name(format!("metadata.json.tmp.{run_id}"));
        if let Some(parent) = metadata_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(&metadata)
            .map_err(|e| RunnerError::Internal(format!("serialize workspace metadata: {e}")))?;
        if let Err(e) = fs::write(&tmp, bytes).await {
            let _ = fs::remove_file(&tmp).await;
            return Err(e.into());
        }
        if let Err(e) = fs::rename(&tmp, &metadata_path).await {
            let _ = fs::remove_file(&tmp).await;
            return Err(e.into());
        }
        Ok(())
    }

    async fn invalidate_current_image(
        &self,
        run_id: RunId,
        cache_key: &str,
        current: &Path,
        reason: &str,
    ) -> RunnerResult<bool> {
        match fs::remove_file(current).await {
            Ok(()) => {
                info!(
                    run_id = %run_id,
                    cache_key,
                    reason,
                    "workspace image cache baseline invalidated"
                );
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
}

impl WorkspaceImageLease {
    #[cfg(test)]
    pub(crate) fn working_dir(&self) -> &str {
        &self.working_dir
    }

    pub(crate) fn result(&self) -> WorkspaceCacheCheckoutResult {
        self.result
    }

    pub(crate) fn is_cache_hit(&self) -> bool {
        self.result == WorkspaceCacheCheckoutResult::Hit
    }

    pub(crate) fn previous_storage(&self) -> Option<&StorageFingerprints> {
        self.previous_storage.as_ref()
    }

    pub(crate) fn workspace_drive_config(&self) -> Option<sandbox::WorkspaceDriveConfig> {
        self.workspace_drive_enabled
            .then(|| sandbox::WorkspaceDriveConfig {
                size_mb: workspace_image_size_mb(self.image_size_bytes),
                seed_image: self.source_image.clone(),
            })
    }

    pub(crate) fn workspace_drive_available(&self) -> bool {
        self.workspace_drive_enabled
    }

    pub(crate) fn can_attempt_promotion(&self, session_id_override: Option<&str>) -> bool {
        if !self.workspace_drive_enabled || !is_safe_guest_working_dir(&self.working_dir) {
            return false;
        }

        match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                self.cache_key.is_some() && self.entry_lock.is_some() && self.session_id.is_some()
            }
            WorkspaceCacheCheckoutResult::NoSession => {
                self.session_id.is_none() && session_id_override.is_some()
            }
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
            | WorkspaceCacheCheckoutResult::LockBusy
            | WorkspaceCacheCheckoutResult::InvalidMetadata
            | WorkspaceCacheCheckoutResult::DiskPressure => false,
        }
    }

    pub(crate) async fn invalidate(&self, run_id: RunId, reason: &str) -> RunnerResult<bool> {
        let Some(cache_key) = self.cache_key.as_deref() else {
            return Ok(false);
        };
        let current = self.cache.session_workspace_cache_current_image(cache_key);
        self.cache
            .invalidate_current_image(run_id, cache_key, &current, reason)
            .await
    }

    pub(crate) async fn promote(
        &self,
        run_id: RunId,
        session_id_override: Option<&str>,
        terminal_status: WorkspaceCacheTerminalStatus,
        completed_at: String,
        storage_fingerprints: &StorageFingerprints,
    ) -> RunnerResult<bool> {
        if !self.workspace_drive_enabled {
            debug!(
                run_id = %run_id,
                "workspace image cache promotion skipped: workspace drive unavailable"
            );
            return Ok(false);
        }
        if !is_safe_guest_working_dir(&self.working_dir) {
            debug!(
                run_id = %run_id,
                working_dir = %self.working_dir,
                "workspace image cache promotion skipped: unsafe working directory"
            );
            return Ok(false);
        }
        if !self.can_attempt_promotion(session_id_override) {
            debug!(
                run_id = %run_id,
                checkout_result = ?self.result,
                "workspace image cache promotion skipped: checkout result is not promotable"
            );
            return Ok(false);
        }

        let mut _late_entry_lock_guard = None;
        let late_cache_key;
        let (cache_key, session_id) = if let Some(cache_key) = self.cache_key.as_deref() {
            let Some(session_id) = self.session_id.as_deref() else {
                debug!(run_id = %run_id, "workspace image cache promotion skipped: no session id");
                return Ok(false);
            };
            if self.entry_lock.is_none() {
                debug!(
                    run_id = %run_id,
                    cache_key,
                    "workspace image cache promotion skipped: entry lock not held"
                );
                return Ok(false);
            }
            (cache_key, session_id)
        } else if self.session_id.is_none() {
            let Some(session_id) = session_id_override else {
                debug!(run_id = %run_id, "workspace image cache promotion skipped: no session id");
                return Ok(false);
            };
            late_cache_key = self.cache.scoped_cache_key(
                &self.profile_name,
                session_id,
                &self.working_dir,
                self.image_size_bytes,
            );
            _late_entry_lock_guard = Some(
                match crate::lock::try_acquire(self.cache.entry_lock_path(&late_cache_key)).await {
                    Ok(lock) => lock,
                    Err(e) => {
                        info!(
                            run_id = %run_id,
                            cache_key = late_cache_key,
                            error = %e,
                            "workspace image cache promotion skipped: late entry lock unavailable"
                        );
                        return Ok(false);
                    }
                },
            );
            (late_cache_key.as_str(), session_id)
        } else {
            debug!(run_id = %run_id, "workspace image cache promotion skipped: no cache key");
            return Ok(false);
        };

        let mut stats = self.cache.fs_stats().await?;
        let mut budget = CacheBudget::from_fs_stats(stats);
        if stats.available_bytes < budget.min_free_bytes {
            match self.cache.gc(false).await {
                Ok(freed) if freed > 0 => {
                    stats = self.cache.fs_stats().await?;
                    budget = CacheBudget::from_fs_stats(stats);
                }
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache GC failed before promotion"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %run_id,
                cache_key,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache promotion skipped due to free-space pressure"
            );
            return Ok(false);
        }
        let image_metadata = fs::metadata(&self.active_image).await?;
        let active_allocated = allocated_bytes(&image_metadata);
        if active_allocated > budget.max_entry_bytes {
            info!(
                run_id = %run_id,
                cache_key,
                allocated_bytes = active_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because image is too large"
            );
            return Ok(false);
        }
        if !has_copy_headroom(stats, budget, active_allocated) {
            match self.cache.gc(false).await {
                Ok(freed) if freed > 0 => {
                    stats = self.cache.fs_stats().await?;
                    budget = CacheBudget::from_fs_stats(stats);
                }
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache GC failed before promotion copy"
                ),
            }
        }
        if !has_copy_headroom(stats, budget, active_allocated) {
            info!(
                run_id = %run_id,
                cache_key,
                allocated_bytes = active_allocated,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache promotion skipped due to copy free-space pressure"
            );
            return Ok(false);
        }

        let cache_dir = self.cache.session_workspace_cache_entry_dir(cache_key);
        fs::create_dir_all(&cache_dir).await?;
        let tmp = self
            .cache
            .session_workspace_cache_tmp_image(cache_key, run_id);
        if fs::try_exists(&tmp).await.unwrap_or(false) {
            let _ = fs::remove_file(&tmp).await;
        }
        if let Err(e) = sparse_copy(&self.active_image, &tmp).await {
            let _ = fs::remove_file(&tmp).await;
            return Err(e);
        }
        let tmp_metadata = fs::metadata(&tmp).await?;
        let tmp_allocated = allocated_bytes(&tmp_metadata);
        if tmp_allocated > budget.max_entry_bytes {
            let _ = fs::remove_file(&tmp).await;
            info!(
                run_id = %run_id,
                cache_key,
                allocated_bytes = tmp_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because copied image is too large"
            );
            return Ok(false);
        }
        let current = self.cache.session_workspace_cache_current_image(cache_key);
        if let Err(e) = fs::rename(&tmp, &current).await {
            let _ = fs::remove_file(&tmp).await;
            return Err(e.into());
        }
        let current_metadata = fs::metadata(&current).await?;
        let logical_image_size_bytes = current_metadata.len();
        let allocated = allocated_bytes(&current_metadata);
        let metadata = WorkspaceCacheMetadata {
            format_version: CACHE_FORMAT_VERSION,
            key_version: CACHE_KEY_VERSION,
            cache_scope: self.cache.inner.cache_scope.clone(),
            profile_name: self.profile_name.clone(),
            session_id: session_id.to_owned(),
            working_dir: self.working_dir.clone(),
            last_completed_at: completed_at,
            last_used_at: local_timestamp(),
            last_terminal_status: terminal_status,
            workspace_trust: WorkspaceTrust::Clean,
            logical_image_size_bytes,
            allocated_bytes: allocated,
            current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
            drive_layout: WORKSPACE_DRIVE_LAYOUT.to_owned(),
            storage_fingerprints: filter_storage_fingerprints_for_working_dir(
                storage_fingerprints,
                &self.working_dir,
            ),
            state: WorkspaceCacheState::Current,
        };
        if let Err(e) = self.cache.write_metadata(cache_key, run_id, metadata).await {
            let _ = fs::remove_file(&current).await;
            return Err(e);
        }
        info!(
            run_id = %run_id,
            cache_key,
            allocated_bytes = allocated,
            "workspace image cache promoted"
        );
        if let Err(e) = self.cache.gc(false).await {
            warn!(
                run_id = %run_id,
                cache_key,
                error = %e,
                "workspace image cache GC failed after promotion"
            );
        }
        Ok(true)
    }
}

fn cap_workspace_held_session_states(states: Vec<HeldSessionState>) -> Vec<HeldSessionState> {
    let mut newest_by_session = BTreeMap::<String, HeldSessionState>::new();
    for state in states {
        match newest_by_session.get_mut(&state.session_id) {
            Some(existing) if state.last_completed_at > existing.last_completed_at => {
                *existing = state;
            }
            Some(_) => {}
            None => {
                newest_by_session.insert(state.session_id.clone(), state);
            }
        }
    }

    let mut states: Vec<HeldSessionState> = newest_by_session.into_values().collect();
    if states.len() > MAX_HELD_SESSION_STATES {
        states.sort_unstable_by(|a, b| {
            b.last_completed_at
                .cmp(&a.last_completed_at)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        states.truncate(MAX_HELD_SESSION_STATES);
    }
    states.sort_unstable_by(|a, b| a.session_id.cmp(&b.session_id));
    states
}

fn is_cache_key_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

struct GcCandidate {
    cache_key: String,
    allocated_bytes: u64,
    file_dev: u64,
    file_ino: u64,
    last_used_at: String,
}

impl GcCandidate {
    fn same_current_image(&self, other: &Self) -> bool {
        self.file_dev == other.file_dev
            && self.file_ino == other.file_ino
            && self.last_used_at == other.last_used_at
    }
}

pub(crate) fn filter_storage_fingerprints_for_working_dir(
    fingerprints: &StorageFingerprints,
    working_dir: &str,
) -> StorageFingerprints {
    let keep_path = |mount_path: &str| is_workspace_scoped_path(mount_path, working_dir);
    StorageFingerprints {
        storages: fingerprints
            .storages
            .iter()
            .filter(|(path, _)| keep_path(path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect(),
        artifacts: fingerprints
            .artifacts
            .iter()
            .filter(|(path, _)| keep_path(path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect(),
    }
}

pub(crate) fn is_safe_guest_working_dir(path: &str) -> bool {
    normalize_safe_guest_working_dir(path).is_some()
}

pub(crate) fn normalize_safe_guest_working_dir(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.as_bytes().contains(&0) {
        return None;
    }

    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" => {}
            "." | ".." => return None,
            _ => components.push(component),
        }
    }

    if components.is_empty() {
        return None;
    }

    Some(format!("/{}", components.join("/")))
}

fn is_workspace_scoped_path(mount_path: &str, working_dir: &str) -> bool {
    let Some(mount_path) = normalize_safe_guest_working_dir(mount_path) else {
        return false;
    };
    let Some(working_dir) = normalize_safe_guest_working_dir(working_dir) else {
        return false;
    };
    if mount_path == working_dir {
        return true;
    }
    let Some(suffix) = mount_path.strip_prefix(&working_dir) else {
        return false;
    };
    suffix.starts_with('/')
}

fn validate_metadata(
    metadata: &WorkspaceCacheMetadata,
    cache_scope: &str,
    profile_name: &str,
    session_id: &str,
    working_dir: &str,
    image_size_bytes: u64,
) -> RunnerResult<()> {
    if metadata.format_version != CACHE_FORMAT_VERSION {
        return Err(RunnerError::Internal(format!(
            "workspace metadata format version {} does not match {CACHE_FORMAT_VERSION}",
            metadata.format_version
        )));
    }
    if metadata.key_version != CACHE_KEY_VERSION {
        return Err(RunnerError::Internal(format!(
            "workspace metadata key version {} does not match {CACHE_KEY_VERSION}",
            metadata.key_version
        )));
    }
    if metadata.cache_scope != cache_scope {
        return Err(RunnerError::Internal(
            "workspace metadata cache scope mismatch".into(),
        ));
    }
    if metadata.profile_name != profile_name {
        return Err(RunnerError::Internal(
            "workspace metadata profile mismatch".into(),
        ));
    }
    if metadata.session_id != session_id {
        return Err(RunnerError::Internal(
            "workspace metadata session id mismatch".into(),
        ));
    }
    if metadata.working_dir != working_dir {
        return Err(RunnerError::Internal(
            "workspace metadata working dir mismatch".into(),
        ));
    }
    if metadata.drive_layout != WORKSPACE_DRIVE_LAYOUT {
        return Err(RunnerError::Internal(format!(
            "workspace metadata drive layout {} does not match {WORKSPACE_DRIVE_LAYOUT}",
            metadata.drive_layout
        )));
    }
    if metadata.logical_image_size_bytes != image_size_bytes {
        return Err(RunnerError::Internal(format!(
            "workspace metadata image size {} does not match {image_size_bytes}",
            metadata.logical_image_size_bytes
        )));
    }
    if metadata.state != WorkspaceCacheState::Current
        || metadata.workspace_trust != WorkspaceTrust::Clean
    {
        return Err(RunnerError::Internal(
            "workspace metadata is not reusable".into(),
        ));
    }
    Ok(())
}

fn validate_current_image_identity(
    metadata: &WorkspaceCacheMetadata,
    current: &std::fs::Metadata,
) -> RunnerResult<()> {
    let current_image = WorkspaceImageFileIdentity::from_metadata(current);
    if metadata.current_image != current_image {
        return Err(RunnerError::Internal(
            "workspace metadata current image identity mismatch".into(),
        ));
    }
    if metadata.logical_image_size_bytes != current.len() {
        return Err(RunnerError::Internal(format!(
            "workspace metadata image size {} does not match current image size {}",
            metadata.logical_image_size_bytes,
            current.len()
        )));
    }
    Ok(())
}

fn is_workspace_tmp_file_name(name: &str) -> bool {
    name.starts_with("current.ext4.tmp.") || name.starts_with("metadata.json.tmp.")
}

fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

fn has_copy_headroom(stats: FsStats, budget: CacheBudget, allocated_bytes: u64) -> bool {
    stats.available_bytes.saturating_sub(allocated_bytes) >= budget.min_free_bytes
}

fn gc_budget_satisfied(
    needs_budget_gc: bool,
    total_cache_bytes: u64,
    entry_count: usize,
    stats_after_pre_cleanup: FsStats,
    budget: CacheBudget,
    candidate_freed_bytes: u64,
) -> bool {
    if entry_count > MAX_HELD_SESSION_STATES {
        return false;
    }
    !needs_budget_gc
        || (total_cache_bytes <= budget.target_after_gc_bytes
            && stats_after_pre_cleanup
                .available_bytes
                .saturating_add(candidate_freed_bytes)
                >= budget.min_free_bytes)
}

async fn sparse_copy(src: &Path, dst: &Path) -> RunnerResult<()> {
    sparse_copy_with_timeout(src, dst, WORKSPACE_IMAGE_COPY_TIMEOUT).await
}

async fn sparse_copy_with_timeout(src: &Path, dst: &Path, timeout: Duration) -> RunnerResult<()> {
    let mut command = tokio::process::Command::new("cp");
    command
        .arg("--sparse=always")
        .arg("--")
        .arg(src)
        .arg(dst)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("exec cp: {e}")))?;
    let Some(stderr) = child.stderr.take() else {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(RunnerError::Internal("cp stderr pipe unavailable".into()));
    };
    let stderr_task = tokio::spawn(read_child_output(stderr));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err(RunnerError::Internal(format!("wait cp: {e}")));
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err(RunnerError::Internal(format!(
                "cp --sparse=always {} {} timed out after {}ms",
                src.display(),
                dst.display(),
                timeout.as_millis()
            )));
        }
    };
    let stderr = stderr_task
        .await
        .map_err(|e| RunnerError::Internal(format!("cp stderr task failed: {e}")))?
        .map_err(|e| RunnerError::Internal(format!("read cp stderr: {e}")))?;
    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr);
    Err(RunnerError::Internal(format!(
        "cp --sparse=always {} {} failed: {}",
        src.display(),
        dst.display(),
        stderr.trim()
    )))
}

async fn read_child_output<R>(mut output: R) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(not(test))]
async fn statvfs_bytes(path: &Path) -> RunnerResult<FsStats> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || statvfs_bytes_sync(&path))
        .await
        .map_err(|e| RunnerError::Internal(format!("statvfs task failed: {e}")))?
}

async fn entry_file_type_is_dir(entry: &fs::DirEntry) -> RunnerResult<bool> {
    entry_file_type_matches(entry, std::fs::FileType::is_dir).await
}

async fn entry_file_type_is_file(entry: &fs::DirEntry) -> RunnerResult<bool> {
    entry_file_type_matches(entry, std::fs::FileType::is_file).await
}

async fn entry_file_type_matches(
    entry: &fs::DirEntry,
    matches: fn(&std::fs::FileType) -> bool,
) -> RunnerResult<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(matches(&file_type)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

#[cfg(not(test))]
fn statvfs_bytes_sync(path: &Path) -> RunnerResult<FsStats> {
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let bytes = path.as_os_str().as_bytes();
    let c_path = std::ffi::CString::new(bytes).map_err(|_| {
        RunnerError::Internal(format!(
            "statvfs path contains nul byte: {}",
            path.display()
        ))
    })?;
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stats = unsafe { stats.assume_init() };
    let block_size = stats.f_frsize;
    Ok(FsStats {
        total_bytes: stats.f_blocks.saturating_mul(block_size),
        available_bytes: stats.f_bavail.saturating_mul(block_size),
    })
}

async fn flat_directory_allocated_bytes(path: &Path) -> u64 {
    let mut entries = match fs::read_dir(path).await {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    let mut total: u64 = 0;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let allocated = fs::metadata(entry.path())
            .await
            .map(|metadata| allocated_bytes(&metadata))
            .unwrap_or(0);
        total = total.saturating_add(allocated);
    }
    total
}

fn local_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const TEST_PROFILE_NAME: &str = "vm0/default";

    fn timestamp_for_index(index: usize) -> String {
        format!("2026-05-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
    }

    async fn write_current_cache_entry(
        cache: &SessionWorkspaceCache,
        paths: &RunnerPaths,
        run_id: RunId,
        session_id: &str,
        working_dir: &str,
        last_completed_at: &str,
        last_used_at: &str,
    ) -> String {
        let image = format!("image-{session_id}");
        let key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            session_id,
            working_dir,
            image.len() as u64,
        );
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, image).await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: cache.inner.cache_scope.clone(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: session_id.into(),
                    working_dir: working_dir.into(),
                    last_completed_at: last_completed_at.into(),
                    last_used_at: last_used_at.into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();
        key
    }

    async fn promote_current_cache_entry(
        cache: &SessionWorkspaceCache,
        paths: &RunnerPaths,
        session_id: &str,
        image: &[u8],
        last_completed_at: &str,
    ) -> String {
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
                workspace_drive_required: false,
            })
            .await;
        let active_image = paths.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&active_image, image).await.unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    last_completed_at.into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        drop(lease);
        cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            session_id,
            "/workspace",
            image.len() as u64,
        )
    }

    #[test]
    fn budget_uses_automatic_bounds() {
        let budget = CacheBudget::from_fs_stats(FsStats {
            total_bytes: 2_000 * GIB,
            available_bytes: 1_000 * GIB,
        });
        assert_eq!(budget.max_cache_bytes, 1_000 * GIB);
        assert_eq!(budget.target_after_gc_bytes, 750 * GIB);
        assert_eq!(budget.min_free_bytes, 200 * GIB);
        assert_eq!(budget.max_entry_bytes, 32 * GIB);
    }

    #[test]
    fn budget_uses_half_of_filesystem_for_smaller_hosts() {
        let budget = CacheBudget::from_fs_stats(FsStats {
            total_bytes: 400 * GIB,
            available_bytes: 300 * GIB,
        });
        assert_eq!(budget.max_cache_bytes, 200 * GIB);
        assert_eq!(budget.target_after_gc_bytes, 150 * GIB);
        assert_eq!(budget.min_free_bytes, 50 * GIB);
        assert_eq!(budget.max_entry_bytes, 20 * GIB);
    }

    #[test]
    fn cache_key_separates_profile_and_image_size() {
        let base = scoped_session_workspace_cache_key(
            "vm0/test",
            "vm0/default",
            "sess-1",
            "/workspace",
            5,
        );

        assert_ne!(
            base,
            scoped_session_workspace_cache_key(
                "vm0/test",
                "vm0/browser",
                "sess-1",
                "/workspace",
                5,
            )
        );
        assert_ne!(
            base,
            scoped_session_workspace_cache_key(
                "vm0/test",
                "vm0/default",
                "sess-1",
                "/workspace",
                6,
            )
        );
    }

    #[test]
    fn workspace_scoped_fingerprints_do_not_match_prefix_traps() {
        let fingerprints = StorageFingerprints {
            storages: HashMap::from([
                ("/workspace".into(), ("repo".into(), "v1".into())),
                ("/workspace/sub".into(), ("sub".into(), "v1".into())),
                ("/workspace//sub2".into(), ("sub2".into(), "v1".into())),
                ("/workspace2".into(), ("trap".into(), "v1".into())),
                (
                    "/workspace/../outside".into(),
                    ("escape".into(), "v1".into()),
                ),
                ("/tmp/cache".into(), ("tmp".into(), "v1".into())),
            ]),
            artifacts: HashMap::from([
                ("/workspace/art".into(), ("art".into(), "v1".into())),
                ("/home/user/.codex".into(), ("codex".into(), "v1".into())),
            ]),
        };

        let filtered = filter_storage_fingerprints_for_working_dir(&fingerprints, "/workspace");

        assert!(filtered.storages.contains_key("/workspace"));
        assert!(filtered.storages.contains_key("/workspace/sub"));
        assert!(filtered.storages.contains_key("/workspace//sub2"));
        assert!(!filtered.storages.contains_key("/workspace2"));
        assert!(!filtered.storages.contains_key("/workspace/../outside"));
        assert!(!filtered.storages.contains_key("/tmp/cache"));
        assert!(filtered.artifacts.contains_key("/workspace/art"));
        assert!(!filtered.artifacts.contains_key("/home/user/.codex"));

        let trailing_slash_filtered =
            filter_storage_fingerprints_for_working_dir(&fingerprints, "/workspace/");
        assert!(trailing_slash_filtered.storages.contains_key("/workspace"));
        assert!(
            trailing_slash_filtered
                .storages
                .contains_key("/workspace/sub")
        );
        assert!(!trailing_slash_filtered.storages.contains_key("/workspace2"));
    }

    #[test]
    fn cap_workspace_held_session_states_dedupes_and_keeps_newest() {
        let mut states: Vec<HeldSessionState> = (0..=MAX_HELD_SESSION_STATES)
            .map(|index| HeldSessionState {
                session_id: format!("sess-{index:04}"),
                last_completed_at: timestamp_for_index(index),
            })
            .collect();
        states.push(HeldSessionState {
            session_id: "sess-0001".into(),
            last_completed_at: timestamp_for_index(MAX_HELD_SESSION_STATES + 1),
        });

        let capped = cap_workspace_held_session_states(states);

        assert_eq!(capped.len(), MAX_HELD_SESSION_STATES);
        assert!(
            !capped.iter().any(|state| state.session_id == "sess-0000"),
            "oldest advertised cache state should be dropped"
        );
        assert!(capped.iter().any(|state| {
            state.session_id == "sess-0001"
                && state.last_completed_at == timestamp_for_index(MAX_HELD_SESSION_STATES + 1)
        }));
        assert!(
            capped
                .iter()
                .any(|state| state.session_id == format!("sess-{MAX_HELD_SESSION_STATES:04}"))
        );
    }

    #[test]
    fn safe_guest_working_dir_rejects_root_relative_and_parent() {
        assert!(is_safe_guest_working_dir("/home/user/workspace"));
        assert_eq!(
            normalize_safe_guest_working_dir("/home//user/workspace/").as_deref(),
            Some("/home/user/workspace"),
        );
        assert!(!is_safe_guest_working_dir("/"));
        assert!(!is_safe_guest_working_dir("//"));
        assert!(!is_safe_guest_working_dir("///"));
        assert!(!is_safe_guest_working_dir("/."));
        assert!(!is_safe_guest_working_dir("/./"));
        assert!(!is_safe_guest_working_dir("/workspace/."));
        assert!(!is_safe_guest_working_dir("workspace"));
        assert!(!is_safe_guest_working_dir("/home/../workspace"));
        assert!(!is_safe_guest_working_dir("/home/user/work\0space"));
    }

    #[tokio::test]
    async fn invalid_working_dir_allocates_only_required_workspace_drive() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths);

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/",
                image_size_bytes: 1024,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(
            lease.result(),
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
        );
        assert!(lease.workspace_drive_config().is_none());

        let no_session_lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: None,
                working_dir: "/",
                image_size_bytes: 1024,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(
            no_session_lease.result(),
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
        );
        assert!(no_session_lease.workspace_drive_config().is_none());

        let snapshot_restore_lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/",
                image_size_bytes: 1024,
                workspace_drive_required: true,
            })
            .await;

        assert_eq!(
            snapshot_restore_lease.result(),
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
        );
        assert!(snapshot_restore_lease.workspace_drive_config().is_some());
        assert!(
            !snapshot_restore_lease
                .promote(
                    RunId::new_v4(),
                    Some("sess-1"),
                    WorkspaceCacheTerminalStatus::Success,
                    local_timestamp(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap(),
            "unsafe working dirs may require an attached drive for snapshot restore but must not be cached",
        );
    }

    #[tokio::test]
    async fn prepare_normalizes_working_dir_for_cache_identity() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace//repo/",
                image_size_bytes: 1024,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(lease.working_dir(), "/workspace/repo");
        let expected_key =
            cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace/repo", 1024);
        assert_eq!(lease.cache_key.as_deref(), Some(expected_key.as_str()));
    }

    #[tokio::test]
    async fn shared_cache_is_reusable_across_runner_base_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
            .await
            .unwrap();
        let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
        let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
        tokio::fs::create_dir_all(runner_a.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(runner_b.base_dir())
            .await
            .unwrap();
        let cache_a = SessionWorkspaceCache::shared(runner_a.clone(), &home, "test-group");
        let cache_b = SessionWorkspaceCache::shared(runner_b.clone(), &home, "test-group");
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();

        let lease = cache_a
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
        let active_image = runner_a.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&active_image, b"image").await.unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-05-01T00:00:00.000Z".into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        drop(lease);

        let checkout = cache_b
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Hit);
        assert!(
            checkout
                .source_image
                .as_ref()
                .is_some_and(|path| path.starts_with(home.workspace_image_cache_dir())),
            "shared checkout must source the host-level workspace image cache",
        );
    }

    #[tokio::test]
    async fn shared_cache_same_key_lock_blocks_other_runner_without_deadlock() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
            .await
            .unwrap();
        let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
        let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
        tokio::fs::create_dir_all(runner_a.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(runner_b.base_dir())
            .await
            .unwrap();
        let cache_a = SessionWorkspaceCache::shared(runner_a, &home, "test-group");
        let cache_b = SessionWorkspaceCache::shared(runner_b, &home, "test-group");

        let lease_a = cache_a
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(lease_a.result(), WorkspaceCacheCheckoutResult::Miss);

        let blocked_checkout = cache_b
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(
            blocked_checkout.result(),
            WorkspaceCacheCheckoutResult::LockBusy
        );
        assert!(blocked_checkout.cache_key.is_none());
        assert!(blocked_checkout.source_image.is_none());
        assert!(
            blocked_checkout.workspace_drive_config().is_some(),
            "lock contention should fall back to a fresh workspace image"
        );

        drop(lease_a);
        let checkout_after_drop = cache_b
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(
            checkout_after_drop.result(),
            WorkspaceCacheCheckoutResult::Miss
        );
    }

    #[tokio::test]
    async fn shared_cache_is_scoped_by_runner_group() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
            .await
            .unwrap();
        let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
        let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
        tokio::fs::create_dir_all(runner_a.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(runner_b.base_dir())
            .await
            .unwrap();
        let cache_a = SessionWorkspaceCache::shared(runner_a.clone(), &home, "group-a");
        let cache_b = SessionWorkspaceCache::shared(runner_b.clone(), &home, "group-b");
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();

        let lease = cache_a
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
        let active_image = runner_a.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&active_image, b"image").await.unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-05-01T00:00:00.000Z".into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        drop(lease);

        let checkout = cache_b
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
        assert!(checkout.source_image.is_none());
        assert!(
            cache_b.held_session_states().await.is_empty(),
            "a runner must not advertise workspace cache entries from another group"
        );
    }

    #[tokio::test]
    async fn scoped_gc_preserves_other_group_cache_entries() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
            .await
            .unwrap();
        let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
        let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
        tokio::fs::create_dir_all(runner_a.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(runner_b.base_dir())
            .await
            .unwrap();
        let cache_a = SessionWorkspaceCache::shared(runner_a.clone(), &home, "group-a");
        let cache_b = SessionWorkspaceCache::shared(runner_b, &home, "group-b");
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();

        let lease = cache_a
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        let active_image = runner_a.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&active_image, b"image").await.unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-05-01T00:00:00.000Z".into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        drop(lease);

        cache_b.gc(false).await.unwrap();

        assert_eq!(cache_a.held_session_states().await.len(), 1);
    }

    #[tokio::test]
    async fn scoped_gc_candidates_ignore_other_group_cache_entries() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
            .await
            .unwrap();
        let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
        let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
        tokio::fs::create_dir_all(runner_a.base_dir())
            .await
            .unwrap();
        tokio::fs::create_dir_all(runner_b.base_dir())
            .await
            .unwrap();
        let cache_a = SessionWorkspaceCache::shared(runner_a.clone(), &home, "group-a");
        let cache_b = SessionWorkspaceCache::shared(runner_b.clone(), &home, "group-b");

        let group_a_key = promote_current_cache_entry(
            &cache_a,
            &runner_a,
            "sess-a",
            b"image-a",
            "2026-05-01T00:00:00.000Z",
        )
        .await;

        assert!(
            cache_a.gc_candidate(group_a_key.clone()).await.is_some(),
            "own group entries should remain eligible for scoped GC"
        );
        assert!(
            cache_b.gc_candidates().await.unwrap().is_empty(),
            "scoped GC must not budget-evict entries owned by another group"
        );

        promote_current_cache_entry(
            &cache_b,
            &runner_b,
            "sess-b",
            b"image-b",
            "2026-05-01T00:01:00.000Z",
        )
        .await;

        let candidates = cache_b.gc_candidates().await.unwrap();
        assert_eq!(candidates.len(), 1);
        assert_ne!(candidates[0].cache_key, group_a_key);
    }

    #[tokio::test]
    async fn metadata_validation_rejects_metadata_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().to_path_buf());
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 1024);
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, b"image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "other".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: local_timestamp(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: 1024,
                    allocated_bytes: 1024,
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let err = cache
            .read_valid_metadata(
                &paths.session_workspace_cache_metadata(&key),
                TEST_PROFILE_NAME,
                "sess-1",
                "/workspace",
                1024,
            )
            .await;

        assert!(err.unwrap_err().to_string().contains("session id mismatch"));
    }

    #[tokio::test]
    async fn prepare_removes_invalid_metadata_entry_and_allows_repromotion() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().to_path_buf());
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let image_size = b"old image".len() as u64;
        let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", image_size);
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, b"old image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "other".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: local_timestamp(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: image_size,
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
        assert!(
            !paths.session_workspace_cache_entry_dir(&key).exists(),
            "invalid entry should be removed while the entry lock is held"
        );

        let active_image = paths.active_workspace_image(&sandbox_id);
        fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        fs::write(&active_image, b"new image").await.unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-06-01T00:00:00.000Z".into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );

        let metadata = cache
            .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
            .await
            .unwrap();
        assert_eq!(metadata.session_id, "sess-1");
        drop(lease);
        assert_eq!(cache.held_session_states().await.len(), 1);
    }

    #[tokio::test]
    async fn held_session_states_rejects_metadata_under_wrong_cache_key() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().to_path_buf());
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            b"old image".len() as u64,
        );
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, b"image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "sess-other".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: local_timestamp(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        assert!(
            cache.held_session_states().await.is_empty(),
            "metadata must not be advertised from a cache key derived from another session"
        );
    }

    #[tokio::test]
    async fn held_session_states_rejects_unsafe_working_dir_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().to_path_buf());
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = session_workspace_cache_key("sess-1", "/");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, b"image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "sess-1".into(),
                    working_dir: "/".into(),
                    last_completed_at: local_timestamp(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        assert!(
            cache.held_session_states().await.is_empty(),
            "unsafe working dirs must not be advertised for affinity",
        );
    }

    #[tokio::test]
    async fn metadata_validation_rejects_replaced_current_image() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().to_path_buf());
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            b"old image".len() as u64,
        );
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, b"old image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "sess-1".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: local_timestamp(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();
        let replacement = paths
            .session_workspace_cache_entry_dir(&key)
            .join("replacement.ext4");
        fs::write(&replacement, b"new image").await.unwrap();
        fs::rename(&replacement, &current).await.unwrap();

        let err = cache
            .read_valid_metadata(
                &paths.session_workspace_cache_metadata(&key),
                TEST_PROFILE_NAME,
                "sess-1",
                "/workspace",
                current_metadata.len(),
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("current image identity mismatch"));
        assert!(
            cache.held_session_states().await.is_empty(),
            "stale metadata/current pairs must not be advertised for affinity",
        );
    }

    #[test]
    fn copy_headroom_requires_min_free_after_copy() {
        let budget = CacheBudget {
            max_cache_bytes: 100,
            target_after_gc_bytes: 75,
            min_free_bytes: 50,
            max_entry_bytes: 100,
        };

        assert!(has_copy_headroom(
            FsStats {
                total_bytes: 200,
                available_bytes: 75,
            },
            budget,
            25,
        ));
        assert!(!has_copy_headroom(
            FsStats {
                total_bytes: 200,
                available_bytes: 74,
            },
            budget,
            25,
        ));
    }

    #[test]
    fn gc_budget_satisfied_counts_only_candidate_deletes_after_pre_cleanup() {
        let budget = CacheBudget {
            max_cache_bytes: 100,
            target_after_gc_bytes: 75,
            min_free_bytes: 50,
            max_entry_bytes: 100,
        };
        let stats_after_pre_cleanup = FsStats {
            total_bytes: 200,
            available_bytes: 40,
        };

        assert!(!gc_budget_satisfied(
            true,
            75,
            MAX_HELD_SESSION_STATES,
            stats_after_pre_cleanup,
            budget,
            0,
        ));
        assert!(gc_budget_satisfied(
            true,
            75,
            MAX_HELD_SESSION_STATES,
            stats_after_pre_cleanup,
            budget,
            10,
        ));
    }

    #[test]
    fn gc_budget_satisfied_enforces_entry_cap_even_without_disk_pressure() {
        let budget = CacheBudget {
            max_cache_bytes: 100,
            target_after_gc_bytes: 75,
            min_free_bytes: 50,
            max_entry_bytes: 100,
        };

        assert!(!gc_budget_satisfied(
            false,
            50,
            MAX_HELD_SESSION_STATES + 1,
            FsStats {
                total_bytes: 200,
                available_bytes: 100,
            },
            budget,
            0,
        ));
    }

    #[tokio::test]
    async fn checkout_invalidates_stale_current_when_cache_hit_copy_lacks_headroom() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let cache_key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            b"old image".len() as u64,
        );
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&cache_key);
        tokio::fs::write(&current, b"old image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &cache_key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "sess-1".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:00:00.000Z".into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: u64::MAX,
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: current_metadata.len(),
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::DiskPressure);
        assert!(!lease.can_attempt_promotion(Some("sess-1")));
        assert!(
            !tokio::fs::try_exists(&current).await.unwrap(),
            "old current image must not remain reusable after a cache hit is skipped"
        );
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"new image")
            .await
            .unwrap();

        assert!(
            !lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-05-02T00:00:00.000Z".into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap(),
            "disk-pressure checkout should not promote a fresh image into the cache"
        );
        assert!(cache.held_session_states().await.is_empty());
    }

    #[tokio::test]
    async fn lock_busy_checkout_cannot_promote_without_entry_lock() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 1024);
        let _held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
            .await
            .unwrap();

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 1024,
                workspace_drive_required: false,
            })
            .await;

        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::LockBusy);
        assert!(!lease.can_attempt_promotion(Some("sess-1")));
        assert!(
            !lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    local_timestamp(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        assert!(
            !paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
    }

    #[tokio::test]
    async fn active_lease_hides_cached_session_until_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&cache_key);
        tokio::fs::write(&current, b"image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &cache_key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "sess-1".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: 5,
                    allocated_bytes: 5,
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        assert_eq!(cache.held_session_states().await.len(), 1);

        let lease = cache
            .lease_active(WorkspaceImageActiveLeaseRequest {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_available: true,
            })
            .await;

        assert!(cache.held_session_states().await.is_empty());
        drop(lease);
        assert_eq!(cache.held_session_states().await.len(), 1);
    }

    #[tokio::test]
    async fn gc_candidate_detects_replaced_image_with_same_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        let entry_dir = paths.session_workspace_cache_entry_dir(&cache_key);
        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        let current = paths.session_workspace_cache_current_image(&cache_key);
        tokio::fs::write(&current, b"old image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &cache_key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: "sess-1".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:00:00.000Z".into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: 9,
                    allocated_bytes: 9,
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let old_candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();
        let replacement = entry_dir.join("current.ext4.tmp");
        tokio::fs::write(&replacement, b"new image").await.unwrap();
        tokio::fs::rename(&replacement, &current).await.unwrap();
        let refreshed_candidate = cache.gc_candidate(cache_key).await.unwrap();

        assert_eq!(refreshed_candidate.last_used_at, old_candidate.last_used_at);
        assert!(
            !refreshed_candidate.same_current_image(&old_candidate),
            "GC must notice current.ext4 was replaced even when metadata timestamp is unchanged",
        );
    }

    #[tokio::test]
    async fn gc_candidate_includes_current_image_without_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&cache_key);
        tokio::fs::write(&current, b"orphan image").await.unwrap();

        let candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();

        assert_eq!(candidate.cache_key, cache_key);
        assert!(current.exists());
        assert_eq!(candidate.last_used_at, "");
        assert!(candidate.allocated_bytes > 0);
    }

    #[tokio::test]
    async fn gc_prunes_oldest_entries_above_held_session_limit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();

        let mut oldest_key = String::new();
        let mut newest_key = String::new();
        for index in 0..=MAX_HELD_SESSION_STATES {
            let session_id = format!("sess-{index:04}");
            let timestamp = timestamp_for_index(index);
            let key = write_current_cache_entry(
                &cache,
                &paths,
                run_id,
                &session_id,
                "/workspace",
                &timestamp,
                &timestamp,
            )
            .await;
            if index == 0 {
                oldest_key = key.clone();
            }
            if index == MAX_HELD_SESSION_STATES {
                newest_key = key;
            }
        }

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(
            !paths
                .session_workspace_cache_current_image(&oldest_key)
                .exists(),
            "oldest unlocked cache entry should be removed when the cache is over the advertised limit"
        );
        assert!(
            !paths
                .session_workspace_cache_entry_dir(&oldest_key)
                .exists(),
            "GC should remove the whole evicted entry so stale metadata directories do not slow heartbeat scans"
        );
        assert!(
            paths
                .session_workspace_cache_current_image(&newest_key)
                .exists(),
            "newest cache entry should be retained"
        );
        assert_eq!(
            cache.gc_candidates().await.unwrap().len(),
            MAX_HELD_SESSION_STATES
        );
        assert_eq!(
            cache.held_session_states().await.len(),
            MAX_HELD_SESSION_STATES
        );
    }

    #[tokio::test]
    async fn gc_removes_stale_entry_without_current_image() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = write_current_cache_entry(
            &cache,
            &paths,
            run_id,
            "sess-1",
            "/workspace",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        tokio::fs::remove_file(paths.session_workspace_cache_current_image(&key))
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(
            !paths.session_workspace_cache_entry_dir(&key).exists(),
            "stale metadata-only entries should not accumulate and slow heartbeat scans"
        );
    }

    #[tokio::test]
    async fn gc_removes_unusable_current_entry_without_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        tokio::fs::write(
            paths.session_workspace_cache_current_image(&key),
            b"orphan image",
        )
        .await
        .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(
            !paths.session_workspace_cache_entry_dir(&key).exists(),
            "current images without metadata are not reusable and should not accumulate"
        );
    }

    #[tokio::test]
    async fn gc_keeps_unusable_current_entry_when_entry_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        tokio::fs::write(
            paths.session_workspace_cache_current_image(&key),
            b"orphan image",
        )
        .await
        .unwrap();
        let _lock = crate::lock::acquire(cache.entry_lock_path(&key))
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            paths.session_workspace_cache_entry_dir(&key).exists(),
            "entry locks must protect in-progress promotions from GC removal"
        );
    }

    #[tokio::test]
    async fn gc_keeps_stale_entry_without_current_image_when_entry_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = write_current_cache_entry(
            &cache,
            &paths,
            run_id,
            "sess-1",
            "/workspace",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        tokio::fs::remove_file(paths.session_workspace_cache_current_image(&key))
            .await
            .unwrap();
        let _lock = crate::lock::acquire(cache.entry_lock_path(&key))
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(
            paths.session_workspace_cache_entry_dir(&key).exists(),
            "entry locks must protect stale entries from GC removal"
        );
    }

    #[tokio::test]
    async fn gc_removes_orphan_temporary_workspace_cache_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap();
        let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
        let metadata_tmp = paths
            .session_workspace_cache_metadata(&cache_key)
            .with_file_name(format!("metadata.json.tmp.{run_id}"));
        tokio::fs::write(&tmp, b"partial image").await.unwrap();
        tokio::fs::write(&metadata_tmp, b"partial metadata")
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(!tmp.exists());
        assert!(!metadata_tmp.exists());
    }

    #[tokio::test]
    async fn gc_keeps_temporary_workspace_cache_files_when_entry_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap();
        let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
        let metadata_tmp = paths
            .session_workspace_cache_metadata(&cache_key)
            .with_file_name(format!("metadata.json.tmp.{run_id}"));
        tokio::fs::write(&tmp, b"partial image").await.unwrap();
        tokio::fs::write(&metadata_tmp, b"partial metadata")
            .await
            .unwrap();
        let _lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert_eq!(freed, 0);
        assert!(tmp.exists());
        assert!(metadata_tmp.exists());
    }

    #[tokio::test]
    async fn sparse_copy_times_out_when_copy_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("blocked.fifo");
        let destination = dir.path().join("out.ext4");
        let status = std::process::Command::new("mkfifo")
            .arg(&source)
            .status()
            .unwrap();
        assert!(status.success());

        let err = sparse_copy_with_timeout(&source, &destination, std::time::Duration::ZERO)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("timed out after"));
    }

    #[tokio::test]
    async fn promote_removes_current_image_when_metadata_write_fails() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();

        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        let metadata_path = paths.session_workspace_cache_metadata(&cache_key);
        tokio::fs::create_dir_all(&metadata_path).await.unwrap();

        let err = lease
            .promote(
                run_id,
                Some("sess-1"),
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap_err();

        assert!(matches!(err, RunnerError::Io(_)));
        assert!(
            !paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
        assert!(
            !paths
                .session_workspace_cache_tmp_image(&cache_key, run_id)
                .exists()
        );
        assert!(
            !metadata_path
                .with_file_name(format!("metadata.json.tmp.{run_id}"))
                .exists()
        );
    }

    #[tokio::test]
    async fn no_session_checkout_can_promote_with_late_guest_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();

        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
        assert!(!lease.can_attempt_promotion(None));
        assert!(lease.can_attempt_promotion(Some("sess-1")));
        assert!(
            lease
                .promote(
                    run_id,
                    Some("sess-1"),
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-05-01T00:00:00.000Z".into(),
                    &StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );

        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        assert!(
            paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
        let metadata = cache
            .read_metadata_file(&paths.session_workspace_cache_metadata(&cache_key))
            .await
            .unwrap();
        assert_eq!(metadata.session_id, "sess-1");
        assert_eq!(metadata.working_dir, "/workspace");
        assert_eq!(metadata.logical_image_size_bytes, 5);
    }
}
