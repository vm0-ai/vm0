use std::collections::{BTreeMap, BTreeSet};
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
#[cfg(test)]
use tracing::debug;
use tracing::{info, warn};

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

pub(crate) struct WorkspaceImagePromotionContext {
    cache: SessionWorkspaceCache,
    cache_key: String,
    entry_lock: Option<Flock<std::fs::File>>,
    run_id: RunId,
    sandbox_id: sandbox::SandboxId,
    profile_name: String,
    session_id: String,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: String,
    storage_fingerprints: StorageFingerprints,
}

pub(crate) struct WorkspaceImagePromotionRequest<'a> {
    pub(crate) run_id: RunId,
    pub(crate) sandbox_id: sandbox::SandboxId,
    pub(crate) session_id_override: Option<&'a str>,
    pub(crate) terminal_status: WorkspaceCacheTerminalStatus,
    pub(crate) completed_at: String,
    pub(crate) storage_fingerprints: StorageFingerprints,
    pub(crate) promotable: bool,
}

struct WorkspaceImagePromotionInput<'a> {
    run_id: RunId,
    cache_key: &'a str,
    profile_name: &'a str,
    session_id: &'a str,
    working_dir: &'a str,
    active_image: &'a Path,
    image_size_bytes: u64,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: &'a str,
    storage_fingerprints: &'a StorageFingerprints,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsStats {
    pub(crate) total_bytes: u64,
    pub(crate) available_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspection {
    pub(crate) cache_dir: String,
    pub(crate) lock_dir: String,
    pub(crate) fs_stats: FsStats,
    pub(crate) budget: CacheBudget,
    pub(crate) summary: WorkspaceImageCacheInspectionSummary,
    pub(crate) entries: Vec<WorkspaceImageCacheInspectionEntry>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspectionSummary {
    pub(crate) total_entries: usize,
    pub(crate) reusable_entries: usize,
    pub(crate) invalid_entries: usize,
    pub(crate) stale_entries: usize,
    pub(crate) temporary_entries: usize,
    pub(crate) locked_entries: usize,
    pub(crate) temporary_paths: usize,
    pub(crate) total_allocated_bytes: u64,
    pub(crate) total_logical_image_bytes: u64,
    pub(crate) temporary_allocated_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageCacheInspectionEntry {
    pub(crate) cache_key: String,
    pub(crate) status: WorkspaceImageCacheInspectionStatus,
    pub(crate) reason: Option<String>,
    pub(crate) cache_scope: Option<String>,
    pub(crate) profile_name: Option<String>,
    pub(crate) working_dir: Option<String>,
    pub(crate) last_completed_at: Option<String>,
    pub(crate) last_used_at: Option<String>,
    pub(crate) last_terminal_status: Option<WorkspaceCacheTerminalStatus>,
    pub(crate) allocated_bytes: u64,
    pub(crate) logical_image_size_bytes: u64,
    pub(crate) temporary_path_count: usize,
    pub(crate) temporary_allocated_bytes: u64,
    pub(crate) storage_count: usize,
    pub(crate) artifact_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceImageCacheInspectionStatus {
    Reusable,
    Invalid,
    Stale,
    TemporaryOnly,
    Locked,
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

    fn workspace_image_cache_dir(&self) -> &Path {
        &self.inner.cache_dir
    }

    fn workspace_image_cache_fs_stats_path(&self) -> PathBuf {
        existing_fs_stats_path(self.workspace_image_cache_dir())
    }

    async fn fs_stats(&self) -> RunnerResult<FsStats> {
        #[cfg(test)]
        {
            Ok(self.inner.fs_stats_override)
        }

        #[cfg(not(test))]
        {
            let path = self.workspace_image_cache_fs_stats_path();
            statvfs_bytes(&path).await
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

        let entry_dir = self.session_workspace_cache_entry_dir(&cache_key);
        match remove_non_directory_workspace_cache_entry(&entry_dir).await {
            Ok(true) => {
                info!(
                    run_id = %request.run_id,
                    cache_key,
                    path = %entry_dir.display(),
                    "removed non-directory workspace image cache entry before checkout"
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
            Ok(false) => {}
            Err(e) => {
                warn!(
                    run_id = %request.run_id,
                    cache_key,
                    path = %entry_dir.display(),
                    error = %e,
                    "failed to remove non-directory workspace image cache entry before checkout"
                );
                return workspace_drive(
                    WorkspaceCacheCheckoutResult::InvalidMetadata,
                    None,
                    None,
                    Some(lock),
                    Some(cache_key),
                    true,
                );
            }
        }

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

    pub(crate) async fn invalidate_current_images_for_session(
        &self,
        run_id: RunId,
        session_id: Option<&str>,
        reason: &str,
    ) -> RunnerResult<usize> {
        let Some(session_id) = session_id else {
            return Ok(0);
        };

        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let mut invalidated = 0;
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(e) => return Err(e.into()),
            };
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
            if metadata.session_id == session_id
                && self
                    .metadata_is_publishable_held_session_state(cache_key, &metadata)
                    .await
            {
                let current = self.session_workspace_cache_current_image(cache_key);
                match self
                    .invalidate_current_image(run_id, cache_key, &current, reason)
                    .await
                {
                    Ok(true) => invalidated += 1,
                    Ok(false) => {}
                    Err(e) => warn!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        error = %e,
                        "failed to invalidate workspace image cache baseline for disabled session"
                    ),
                }
            }
            drop(lock);
        }
        Ok(invalidated)
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
            if self
                .metadata_is_publishable_held_session_state(cache_key, &metadata)
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

    async fn metadata_is_publishable_held_session_state(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
    ) -> bool {
        metadata.format_version == CACHE_FORMAT_VERSION
            && metadata.key_version == CACHE_KEY_VERSION
            && metadata.cache_scope == self.inner.cache_scope
            && metadata.drive_layout == WORKSPACE_DRIVE_LAYOUT
            && metadata.state == WorkspaceCacheState::Current
            && metadata.workspace_trust == WorkspaceTrust::Clean
            && is_safe_guest_working_dir(&metadata.working_dir)
            && self.metadata_matches_cache_key(cache_key, metadata)
            && self
                .metadata_matches_current_image(cache_key, metadata)
                .await
    }

    pub(crate) async fn inspect(&self) -> RunnerResult<WorkspaceImageCacheInspection> {
        let fs_stats = self.fs_stats().await?;
        let budget = CacheBudget::from_fs_stats(fs_stats);
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.inspection_from_entries(fs_stats, budget, Vec::new()));
            }
            Err(e) => return Err(e.into()),
        };
        let mut inspection_entries = Vec::new();
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
            if let Some(entry) = self.inspect_entry(cache_key, entry.path()).await? {
                inspection_entries.push(entry);
            }
        }
        inspection_entries.sort_unstable_by(|left, right| left.cache_key.cmp(&right.cache_key));
        Ok(self.inspection_from_entries(fs_stats, budget, inspection_entries))
    }

    fn inspection_from_entries(
        &self,
        fs_stats: FsStats,
        budget: CacheBudget,
        entries: Vec<WorkspaceImageCacheInspectionEntry>,
    ) -> WorkspaceImageCacheInspection {
        let mut summary = WorkspaceImageCacheInspectionSummary {
            total_entries: entries.len(),
            ..WorkspaceImageCacheInspectionSummary::default()
        };
        for entry in &entries {
            match entry.status {
                WorkspaceImageCacheInspectionStatus::Reusable => summary.reusable_entries += 1,
                WorkspaceImageCacheInspectionStatus::Invalid => summary.invalid_entries += 1,
                WorkspaceImageCacheInspectionStatus::Stale => summary.stale_entries += 1,
                WorkspaceImageCacheInspectionStatus::TemporaryOnly => {
                    summary.temporary_entries += 1;
                }
                WorkspaceImageCacheInspectionStatus::Locked => summary.locked_entries += 1,
            }
            summary.temporary_paths += entry.temporary_path_count;
            summary.total_allocated_bytes = summary
                .total_allocated_bytes
                .saturating_add(entry.allocated_bytes)
                .saturating_add(entry.temporary_allocated_bytes);
            summary.total_logical_image_bytes = summary
                .total_logical_image_bytes
                .saturating_add(entry.logical_image_size_bytes);
            summary.temporary_allocated_bytes = summary
                .temporary_allocated_bytes
                .saturating_add(entry.temporary_allocated_bytes);
        }
        WorkspaceImageCacheInspection {
            cache_dir: self.workspace_image_cache_dir().display().to_string(),
            lock_dir: self.inner.lock_dir.display().to_string(),
            fs_stats,
            budget,
            summary,
            entries,
        }
    }

    async fn inspect_entry(
        &self,
        cache_key: String,
        entry_dir: PathBuf,
    ) -> RunnerResult<Option<WorkspaceImageCacheInspectionEntry>> {
        let lock = match crate::lock::try_acquire_or_busy(self.entry_lock_path(&cache_key)).await? {
            crate::lock::TryLock::Acquired(lock) => lock,
            crate::lock::TryLock::Busy => {
                return Ok(Some(WorkspaceImageCacheInspectionEntry {
                    cache_key,
                    status: WorkspaceImageCacheInspectionStatus::Locked,
                    reason: Some("entry lock is held".into()),
                    cache_scope: None,
                    profile_name: None,
                    working_dir: None,
                    last_completed_at: None,
                    last_used_at: None,
                    last_terminal_status: None,
                    allocated_bytes: 0,
                    logical_image_size_bytes: 0,
                    temporary_path_count: 0,
                    temporary_allocated_bytes: 0,
                    storage_count: 0,
                    artifact_count: 0,
                }));
            }
        };
        if !cache_entry_dir_is_dir(&entry_dir).await? {
            drop(lock);
            return Ok(None);
        }
        let temporary = inspect_temporary_paths(&entry_dir).await?;

        let current = self.session_workspace_cache_current_image(&cache_key);
        let current_metadata = match fs::symlink_metadata(&current).await {
            Ok(metadata) => Some(metadata),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                drop(lock);
                return Err(e.into());
            }
        };
        let metadata_path = self.session_workspace_cache_metadata(&cache_key);
        let (metadata, metadata_read_error) = match self.read_metadata_file(&metadata_path).await {
            Ok(metadata) => (Some(metadata), None),
            Err(RunnerError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(RunnerError::Internal(_)) => (None, None),
            Err(e) => (None, Some(e.to_string())),
        };
        let current_allocated_bytes = match current_metadata.as_ref() {
            Some(metadata) if metadata.is_dir() => directory_tree_allocated_bytes(&current).await,
            Some(metadata) => allocated_bytes(metadata),
            None => 0,
        };

        let entry = match (current_metadata, metadata) {
            (None, metadata) => {
                let status = if temporary.path_count > 0 {
                    WorkspaceImageCacheInspectionStatus::TemporaryOnly
                } else {
                    WorkspaceImageCacheInspectionStatus::Stale
                };
                let reason = if temporary.path_count > 0 {
                    "missing current image; temporary paths present"
                } else {
                    "missing current image"
                };
                workspace_image_cache_inspection_entry(
                    cache_key,
                    status,
                    Some(reason.into()),
                    metadata.as_ref(),
                    None,
                    0,
                    temporary,
                )
            }
            (Some(current_metadata), None) => {
                let reason = metadata_read_error
                    .map(|error| format!("metadata read failed: {error}"))
                    .unwrap_or_else(|| "missing or invalid metadata".into());
                workspace_image_cache_inspection_entry(
                    cache_key,
                    WorkspaceImageCacheInspectionStatus::Invalid,
                    Some(reason),
                    None,
                    Some(&current_metadata),
                    current_allocated_bytes,
                    temporary,
                )
            }
            (Some(current_metadata), Some(metadata)) => {
                let reason = self
                    .unusable_current_entry_reason(&cache_key, &metadata, &current_metadata)
                    .map(str::to_owned);
                let status = if reason.is_some() {
                    WorkspaceImageCacheInspectionStatus::Invalid
                } else {
                    WorkspaceImageCacheInspectionStatus::Reusable
                };
                workspace_image_cache_inspection_entry(
                    cache_key,
                    status,
                    reason,
                    Some(&metadata),
                    Some(&current_metadata),
                    current_allocated_bytes,
                    temporary,
                )
            }
        };
        drop(lock);
        Ok(Some(entry))
    }

    pub(crate) async fn gc(&self, dry_run: bool) -> RunnerResult<u64> {
        let stale_cleanup = self.gc_entries_without_current_image(dry_run).await?;
        let unusable_cleanup = self.gc_unusable_current_entries(dry_run).await?;
        let mut removed_entry_keys = stale_cleanup.removed_entry_keys;
        removed_entry_keys.extend(unusable_cleanup.removed_entry_keys);
        let temporary_freed = self
            .gc_temporary_images(dry_run, &removed_entry_keys)
            .await?;
        let stats = self.fs_stats().await?;
        let pre_cleanup_freed = temporary_freed
            .saturating_add(stale_cleanup.freed_bytes)
            .saturating_add(unusable_cleanup.freed_bytes);
        let stats_after_pre_cleanup = if dry_run {
            fs_stats_with_additional_available(stats, pre_cleanup_freed)
        } else {
            stats
        };
        let budget = CacheBudget::from_fs_stats(stats_after_pre_cleanup);
        let mut candidates = self.gc_candidates().await?;
        candidates.retain(|candidate| !removed_entry_keys.contains(&candidate.cache_key));
        let mut entry_count = candidates.len();
        let mut total: u64 = candidates
            .iter()
            .map(|candidate| candidate.allocated_bytes)
            .sum();
        let needs_budget_gc = total > budget.max_cache_bytes
            || stats_after_pre_cleanup.available_bytes < budget.min_free_bytes;
        if !needs_budget_gc && entry_count <= MAX_HELD_SESSION_STATES {
            return Ok(pre_cleanup_freed);
        }
        candidates.sort_by(|left, right| {
            left.last_used_at
                .cmp(&right.last_used_at)
                .then_with(|| left.cache_key.cmp(&right.cache_key))
        });
        let mut freed = pre_cleanup_freed;
        let mut candidate_freed: u64 = 0;
        for candidate in candidates {
            if gc_budget_satisfied(
                needs_budget_gc,
                total,
                entry_count,
                stats_after_pre_cleanup,
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

    async fn gc_unusable_current_entries(&self, dry_run: bool) -> RunnerResult<GcEntryCleanup> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(GcEntryCleanup::default());
            }
            Err(e) => return Err(e.into()),
        };
        let mut cleanup = GcEntryCleanup::default();
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
            if !cache_entry_dir_is_dir(&entry_dir).await? {
                drop(lock);
                continue;
            }
            let current = self.session_workspace_cache_current_image(&cache_key);
            let current_metadata = match fs::symlink_metadata(&current).await {
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
                Ok(metadata) => self
                    .unusable_current_entry_reason(&cache_key, &metadata, &current_metadata)
                    .map(str::to_owned),
                Err(RunnerError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    Some("missing metadata".into())
                }
                Err(RunnerError::Internal(_)) => Some("invalid metadata".into()),
                Err(e) => Some(format!("metadata read failed: {e}")),
            };
            let Some(reason) = reason else {
                drop(lock);
                continue;
            };

            let allocated = directory_tree_allocated_bytes(&entry_dir).await;
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
            cleanup.freed_bytes = cleanup.freed_bytes.saturating_add(allocated);
            cleanup.removed_entry_keys.insert(cache_key);
            drop(lock);
        }
        Ok(cleanup)
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
        if !current_metadata.is_file() {
            return Some("current image is not a file");
        }
        if !self.metadata_matches_cache_key(cache_key, metadata) {
            return Some("cache key mismatch");
        }
        if validate_current_image_identity(metadata, current_metadata).is_err() {
            return Some("current image identity mismatch");
        }
        None
    }

    async fn gc_entries_without_current_image(
        &self,
        dry_run: bool,
    ) -> RunnerResult<GcEntryCleanup> {
        let root = self.workspace_image_cache_dir().to_path_buf();
        let mut entries = match fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(GcEntryCleanup::default());
            }
            Err(e) => return Err(e.into()),
        };
        let mut cleanup = GcEntryCleanup::default();
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
            if !cache_entry_dir_is_dir(&entry_dir).await? {
                drop(lock);
                continue;
            }
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
            let allocated = directory_tree_allocated_bytes(&entry_dir).await;
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
            cleanup.freed_bytes = cleanup.freed_bytes.saturating_add(allocated);
            cleanup.removed_entry_keys.insert(cache_key);
            drop(lock);
        }
        Ok(cleanup)
    }

    async fn gc_temporary_images(
        &self,
        dry_run: bool,
        skip_entry_keys: &BTreeSet<String>,
    ) -> RunnerResult<u64> {
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
            if skip_entry_keys.contains(&cache_key) {
                continue;
            }
            let Ok(lock) = crate::lock::try_acquire(self.entry_lock_path(&cache_key)).await else {
                continue;
            };
            let entry_dir = entry.path();
            if !cache_entry_dir_is_dir(&entry_dir).await? {
                drop(lock);
                continue;
            }
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
                let file_name = file.file_name();
                let Some(file_name) = file_name.to_str() else {
                    continue;
                };
                if !is_workspace_tmp_path_name(file_name) {
                    continue;
                }
                let path = file.path();
                let allocated = workspace_cache_path_allocated_bytes(&path).await;
                if dry_run {
                    info!(
                        cache_key,
                        path = %path.display(),
                        allocated_bytes = allocated,
                        "[dry-run] would delete temporary workspace image cache path"
                    );
                } else {
                    match remove_workspace_cache_path_if_exists(&path).await {
                        Ok(true) => info!(
                            cache_key,
                            path = %path.display(),
                            allocated_bytes = allocated,
                            "deleted temporary workspace image cache path"
                        ),
                        Ok(false) => continue,
                        Err(e) => {
                            warn!(
                                cache_key,
                                path = %path.display(),
                                error = %e,
                                "failed to delete temporary workspace image cache path"
                            );
                            continue;
                        }
                    }
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
        let entry_dir = self.session_workspace_cache_entry_dir(&cache_key);
        if !cache_entry_dir_is_dir(&entry_dir).await.ok()? {
            return None;
        }
        let metadata_path = self.session_workspace_cache_metadata(&cache_key);
        let current_path = self.session_workspace_cache_current_image(&cache_key);
        let file_metadata = fs::symlink_metadata(&current_path).await.ok()?;
        if !file_metadata.is_file() {
            return None;
        }
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
        let mut metadata = match self.read_metadata_file(metadata_path).await {
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
        let current_metadata = match fs::symlink_metadata(&current_path).await {
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
        metadata.allocated_bytes = allocated_bytes(&current_metadata);
        Ok(Some(metadata))
    }

    async fn metadata_matches_current_image(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
    ) -> bool {
        let current_path = self.session_workspace_cache_current_image(cache_key);
        let Ok(current_metadata) = fs::symlink_metadata(current_path).await else {
            return false;
        };
        validate_current_image_identity(metadata, &current_metadata).is_ok()
    }

    async fn read_metadata_file(
        &self,
        metadata_path: &Path,
    ) -> RunnerResult<WorkspaceCacheMetadata> {
        let bytes = crate::state_file::read_to_bytes_required(
            metadata_path,
            crate::state_file::WORKSPACE_METADATA_MAX_BYTES,
            crate::state_file::OwnerCheck::None,
        )
        .await?;
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
            ensure_workspace_cache_entry_dir(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(&metadata)
            .map_err(|e| RunnerError::Internal(format!("serialize workspace metadata: {e}")))?;
        let _ = remove_workspace_cache_path_if_exists(&tmp).await;
        if let Err(e) = fs::write(&tmp, bytes).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(e.into());
        }
        if let Err(e) = fs::rename(&tmp, &metadata_path).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
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

    async fn promote_locked(&self, input: WorkspaceImagePromotionInput<'_>) -> RunnerResult<bool> {
        let cache_dir = self.session_workspace_cache_entry_dir(input.cache_key);
        if remove_non_directory_workspace_cache_entry(&cache_dir).await? {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                path = %cache_dir.display(),
                "removed non-directory workspace image cache entry before promotion"
            );
        }
        let metadata_path = self.session_workspace_cache_metadata(input.cache_key);
        match self
            .read_valid_metadata(
                &metadata_path,
                input.profile_name,
                input.session_id,
                input.working_dir,
                input.image_size_bytes,
            )
            .await
        {
            Ok(Some(metadata)) if metadata.last_completed_at.as_str() >= input.completed_at => {
                info!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    existing_last_completed_at = %metadata.last_completed_at,
                    promotion_completed_at = %input.completed_at,
                    "workspace image cache promotion skipped because existing cache is newer"
                );
                return Ok(false);
            }
            Ok(_) => {}
            Err(e) => warn!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                error = %e,
                "workspace image cache existing metadata invalid during promotion; overwriting"
            ),
        }

        let mut stats = self.fs_stats().await?;
        let mut budget = CacheBudget::from_fs_stats(stats);
        if stats.available_bytes < budget.min_free_bytes {
            match self.gc(false).await {
                Ok(freed) if freed > 0 => {
                    stats = self.fs_stats().await?;
                    budget = CacheBudget::from_fs_stats(stats);
                }
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    error = %e,
                    "workspace image cache GC failed before promotion"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache promotion skipped due to free-space pressure"
            );
            return Ok(false);
        }
        let image_metadata = fs::symlink_metadata(input.active_image).await?;
        if !image_metadata.is_file() {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                active_image = %input.active_image.display(),
                "workspace image cache promotion skipped because active image is not a file"
            );
            return Ok(false);
        }
        let active_allocated = allocated_bytes(&image_metadata);
        if active_allocated > budget.max_entry_bytes {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                allocated_bytes = active_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because image is too large"
            );
            return Ok(false);
        }
        if !has_copy_headroom(stats, budget, active_allocated) {
            match self.gc(false).await {
                Ok(freed) if freed > 0 => {
                    stats = self.fs_stats().await?;
                    budget = CacheBudget::from_fs_stats(stats);
                }
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    error = %e,
                    "workspace image cache GC failed before promotion copy"
                ),
            }
        }
        if !has_copy_headroom(stats, budget, active_allocated) {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                allocated_bytes = active_allocated,
                available_bytes = stats.available_bytes,
                min_free_bytes = budget.min_free_bytes,
                "workspace image cache promotion skipped due to copy free-space pressure"
            );
            return Ok(false);
        }

        ensure_workspace_cache_entry_dir(&cache_dir).await?;
        let tmp = self.session_workspace_cache_tmp_image(input.cache_key, input.run_id);
        let _ = remove_workspace_cache_path_if_exists(&tmp).await;
        if let Err(e) = sparse_copy(input.active_image, &tmp).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(e);
        }
        let tmp_metadata = match fs::symlink_metadata(&tmp).await {
            Ok(metadata) => metadata,
            Err(e) => {
                let _ = remove_workspace_cache_path_if_exists(&tmp).await;
                return Err(e.into());
            }
        };
        if !tmp_metadata.is_file() {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(RunnerError::Internal(format!(
                "workspace image cache temporary image is not a file: {}",
                tmp.display()
            )));
        }
        let logical_image_size_bytes = tmp_metadata.len();
        if logical_image_size_bytes != input.image_size_bytes {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                actual_image_size_bytes = logical_image_size_bytes,
                expected_image_size_bytes = input.image_size_bytes,
                "workspace image cache promotion skipped because copied image size does not match cache key"
            );
            return Ok(false);
        }
        let tmp_allocated = allocated_bytes(&tmp_metadata);
        if tmp_allocated > budget.max_entry_bytes {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                allocated_bytes = tmp_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because copied image is too large"
            );
            return Ok(false);
        }
        let current = self.session_workspace_cache_current_image(input.cache_key);
        match fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.is_dir() => {
                remove_workspace_cache_path_if_exists(&current).await?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if let Err(e) = fs::rename(&tmp, &current).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            return Err(e.into());
        }
        let current_metadata = match fs::symlink_metadata(&current).await {
            Ok(metadata) => metadata,
            Err(e) => {
                let _ = remove_workspace_cache_path_if_exists(&current).await;
                return Err(e.into());
            }
        };
        if !current_metadata.is_file() {
            let _ = remove_workspace_cache_path_if_exists(&current).await;
            return Err(RunnerError::Internal(format!(
                "workspace image cache current image is not a file: {}",
                current.display()
            )));
        }
        let allocated = allocated_bytes(&current_metadata);
        let metadata = WorkspaceCacheMetadata {
            format_version: CACHE_FORMAT_VERSION,
            key_version: CACHE_KEY_VERSION,
            cache_scope: self.inner.cache_scope.clone(),
            profile_name: input.profile_name.to_owned(),
            session_id: input.session_id.to_owned(),
            working_dir: input.working_dir.to_owned(),
            last_completed_at: input.completed_at.to_owned(),
            last_used_at: local_timestamp(),
            last_terminal_status: input.terminal_status,
            workspace_trust: WorkspaceTrust::Clean,
            logical_image_size_bytes,
            allocated_bytes: allocated,
            current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
            drive_layout: WORKSPACE_DRIVE_LAYOUT.to_owned(),
            storage_fingerprints: filter_storage_fingerprints_for_working_dir(
                input.storage_fingerprints,
                input.working_dir,
            ),
            state: WorkspaceCacheState::Current,
        };
        if let Err(e) = self
            .write_metadata(input.cache_key, input.run_id, metadata)
            .await
        {
            let _ = remove_workspace_cache_path_if_exists(&current).await;
            return Err(e);
        }
        info!(
            run_id = %input.run_id,
            cache_key = input.cache_key,
            allocated_bytes = allocated,
            "workspace image cache promoted"
        );
        if let Err(e) = self.gc(false).await {
            warn!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                error = %e,
                "workspace image cache GC failed after promotion"
            );
        }
        Ok(true)
    }
}

fn workspace_image_cache_inspection_entry(
    cache_key: String,
    status: WorkspaceImageCacheInspectionStatus,
    reason: Option<String>,
    metadata: Option<&WorkspaceCacheMetadata>,
    current_metadata: Option<&std::fs::Metadata>,
    current_allocated_bytes: u64,
    temporary: TemporaryPathStats,
) -> WorkspaceImageCacheInspectionEntry {
    let logical_image_size_bytes = current_metadata.map(std::fs::Metadata::len).unwrap_or(0);
    WorkspaceImageCacheInspectionEntry {
        cache_key,
        status,
        reason,
        cache_scope: metadata.map(|metadata| metadata.cache_scope.clone()),
        profile_name: metadata.map(|metadata| metadata.profile_name.clone()),
        working_dir: metadata.map(|metadata| metadata.working_dir.clone()),
        last_completed_at: metadata.map(|metadata| metadata.last_completed_at.clone()),
        last_used_at: metadata.map(|metadata| metadata.last_used_at.clone()),
        last_terminal_status: metadata.map(|metadata| metadata.last_terminal_status),
        allocated_bytes: current_allocated_bytes,
        logical_image_size_bytes,
        temporary_path_count: temporary.path_count,
        temporary_allocated_bytes: temporary.allocated_bytes,
        storage_count: metadata
            .map(|metadata| metadata.storage_fingerprints.storages.len())
            .unwrap_or(0),
        artifact_count: metadata
            .map(|metadata| metadata.storage_fingerprints.artifacts.len())
            .unwrap_or(0),
    }
}

async fn inspect_temporary_paths(entry_dir: &Path) -> RunnerResult<TemporaryPathStats> {
    let mut files = match fs::read_dir(entry_dir).await {
        Ok(files) => files,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TemporaryPathStats::default());
        }
        Err(e) => return Err(e.into()),
    };
    let mut stats = TemporaryPathStats::default();
    while let Some(file) = files.next_entry().await? {
        let file_name = file.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !is_workspace_tmp_path_name(file_name) {
            continue;
        }
        let path = file.path();
        let metadata = match fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let allocated = if metadata.is_dir() {
            directory_tree_allocated_bytes(&path).await
        } else {
            allocated_bytes(&metadata)
        };
        stats.path_count += 1;
        stats.allocated_bytes = stats.allocated_bytes.saturating_add(allocated);
    }
    Ok(stats)
}

impl WorkspaceCacheTerminalStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::NonzeroExit => "nonzeroExit",
            Self::Cancelled => "cancelled",
        }
    }
}

impl WorkspaceImageCacheInspectionStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reusable => "reusable",
            Self::Invalid => "invalid",
            Self::Stale => "stale",
            Self::TemporaryOnly => "temporaryOnly",
            Self::Locked => "locked",
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

    pub(crate) fn can_attempt_promotion(&self, session_id_override: Option<&str>) -> bool {
        if !self.workspace_drive_enabled || !is_safe_guest_working_dir(&self.working_dir) {
            return false;
        }

        match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                self.cache_key.is_some() && self.session_id.is_some()
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

    #[cfg(test)]
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

        self.cache
            .promote_locked(WorkspaceImagePromotionInput {
                run_id,
                cache_key,
                profile_name: &self.profile_name,
                session_id,
                working_dir: &self.working_dir,
                active_image: &self.active_image,
                image_size_bytes: self.image_size_bytes,
                terminal_status,
                completed_at: &completed_at,
                storage_fingerprints,
            })
            .await
    }

    pub(crate) fn into_promotion_context(
        mut self,
        request: WorkspaceImagePromotionRequest<'_>,
    ) -> Option<WorkspaceImagePromotionContext> {
        if !request.promotable {
            return None;
        }
        if !self.workspace_drive_enabled || !is_safe_guest_working_dir(&self.working_dir) {
            return None;
        }

        let session_id = match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                self.session_id.clone()?
            }
            WorkspaceCacheCheckoutResult::NoSession => request.session_id_override?.to_owned(),
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
            | WorkspaceCacheCheckoutResult::LockBusy
            | WorkspaceCacheCheckoutResult::InvalidMetadata
            | WorkspaceCacheCheckoutResult::DiskPressure => return None,
        };

        let cache_key = match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                self.cache_key.clone()?
            }
            WorkspaceCacheCheckoutResult::NoSession => self.cache.scoped_cache_key(
                &self.profile_name,
                &session_id,
                &self.working_dir,
                self.image_size_bytes,
            ),
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
            | WorkspaceCacheCheckoutResult::LockBusy
            | WorkspaceCacheCheckoutResult::InvalidMetadata
            | WorkspaceCacheCheckoutResult::DiskPressure => return None,
        };

        Some(WorkspaceImagePromotionContext {
            cache: self.cache.clone(),
            cache_key,
            entry_lock: self.entry_lock.take(),
            run_id: request.run_id,
            sandbox_id: request.sandbox_id,
            profile_name: self.profile_name.clone(),
            session_id,
            working_dir: self.working_dir.clone(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
            terminal_status: request.terminal_status,
            completed_at: request.completed_at,
            storage_fingerprints: request.storage_fingerprints,
        })
    }
}

impl WorkspaceImagePromotionContext {
    pub(crate) fn run_id(&self) -> RunId {
        self.run_id
    }

    pub(crate) fn sandbox_id(&self) -> sandbox::SandboxId {
        self.sandbox_id
    }

    pub(crate) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) async fn promote(&self) -> RunnerResult<bool> {
        let tainted_storage_fingerprints;
        let promotion_storage_fingerprints = match self.terminal_status {
            WorkspaceCacheTerminalStatus::Success => &self.storage_fingerprints,
            WorkspaceCacheTerminalStatus::NonzeroExit | WorkspaceCacheTerminalStatus::Cancelled => {
                tainted_storage_fingerprints = self.storage_fingerprints.tainted_paths();
                &tainted_storage_fingerprints
            }
        };

        let _late_entry_lock_guard = match self.entry_lock.as_ref() {
            Some(_) => None,
            None => {
                match crate::lock::try_acquire(self.cache.entry_lock_path(&self.cache_key)).await {
                    Ok(lock) => Some(lock),
                    Err(e) => {
                        info!(
                            run_id = %self.run_id,
                            cache_key = self.cache_key,
                            error = %e,
                            "workspace image cache promotion skipped: late entry lock unavailable"
                        );
                        return Ok(false);
                    }
                }
            }
        };

        self.cache
            .promote_locked(WorkspaceImagePromotionInput {
                run_id: self.run_id,
                cache_key: &self.cache_key,
                profile_name: &self.profile_name,
                session_id: &self.session_id,
                working_dir: &self.working_dir,
                active_image: &self.active_image,
                image_size_bytes: self.image_size_bytes,
                terminal_status: self.terminal_status,
                completed_at: &self.completed_at,
                storage_fingerprints: promotion_storage_fingerprints,
            })
            .await
    }

    pub(crate) async fn invalidate_current(self, reason: &str) -> RunnerResult<bool> {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id,
            ..
        } = self;
        let _late_entry_lock_guard = match entry_lock.as_ref() {
            Some(_) => None,
            None => match crate::lock::try_acquire(cache.entry_lock_path(&cache_key)).await {
                Ok(lock) => Some(lock),
                Err(e) => {
                    warn!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        error = %e,
                        "workspace image cache baseline invalidation failed: late entry lock unavailable"
                    );
                    return Err(RunnerError::Internal(format!(
                        "workspace image cache baseline invalidation lock unavailable: {e}"
                    )));
                }
            },
        };
        let current = cache.session_workspace_cache_current_image(&cache_key);
        cache
            .invalidate_current_image(run_id, &cache_key, &current, reason)
            .await
    }

    pub(crate) fn into_active_lease(
        self,
        request: WorkspaceImageActiveLeaseRequest<'_>,
    ) -> WorkspaceImageLease {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id: _,
            sandbox_id,
            profile_name,
            session_id,
            working_dir,
            active_image,
            image_size_bytes,
            terminal_status: _,
            completed_at: _,
            storage_fingerprints: _,
        } = self;
        debug_assert_eq!(request.sandbox_id, sandbox_id);
        debug_assert_eq!(request.profile_name, profile_name.as_str());
        debug_assert_eq!(request.session_id, Some(session_id.as_str()));
        debug_assert_eq!(request.working_dir, working_dir.as_str());
        debug_assert_eq!(request.image_size_bytes, image_size_bytes);
        WorkspaceImageLease {
            cache,
            cache_key: Some(cache_key),
            profile_name,
            session_id: Some(session_id),
            working_dir,
            active_image,
            source_image: None,
            image_size_bytes,
            workspace_drive_enabled: request.workspace_drive_available,
            result: WorkspaceCacheCheckoutResult::Miss,
            previous_storage: None,
            entry_lock,
        }
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

#[derive(Default)]
struct GcEntryCleanup {
    freed_bytes: u64,
    removed_entry_keys: BTreeSet<String>,
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
    if !current.is_file() {
        return Err(RunnerError::Internal(
            "workspace metadata current image is not a file".into(),
        ));
    }
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

fn is_workspace_tmp_path_name(name: &str) -> bool {
    name.starts_with("current.ext4.tmp.") || name.starts_with("metadata.json.tmp.")
}

fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

fn fs_stats_with_additional_available(stats: FsStats, bytes: u64) -> FsStats {
    FsStats {
        total_bytes: stats.total_bytes,
        available_bytes: stats
            .available_bytes
            .saturating_add(bytes)
            .min(stats.total_bytes),
    }
}

fn existing_fs_stats_path(path: &Path) -> PathBuf {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match std::fs::metadata(candidate) {
            Ok(_) => return candidate.to_path_buf(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                current = candidate.parent();
            }
            Err(_) => return candidate.to_path_buf(),
        }
    }
    path.to_path_buf()
}

async fn workspace_cache_path_allocated_bytes(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path).await else {
        return 0;
    };
    if metadata.is_dir() {
        directory_tree_allocated_bytes(path).await
    } else {
        allocated_bytes(&metadata)
    }
}

async fn remove_workspace_cache_path_if_exists(path: &Path) -> std::io::Result<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }
    Ok(true)
}

async fn remove_non_directory_workspace_cache_entry(path: &Path) -> RunnerResult<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if metadata.is_dir() {
        return Ok(false);
    }
    remove_workspace_cache_path_if_exists(path).await?;
    Ok(true)
}

async fn ensure_workspace_cache_entry_dir(path: &Path) -> RunnerResult<()> {
    remove_non_directory_workspace_cache_entry(path).await?;
    fs::create_dir_all(path).await?;
    let metadata = fs::symlink_metadata(path).await?;
    if metadata.is_dir() {
        return Ok(());
    }
    Err(RunnerError::Internal(format!(
        "workspace image cache entry is not a directory: {}",
        path.display()
    )))
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
        .arg("--no-dereference")
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
                "cp --sparse=always --no-dereference {} {} timed out after {}ms",
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
        "cp --sparse=always --no-dereference {} {} failed: {}",
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

async fn cache_entry_dir_is_dir(path: &Path) -> RunnerResult<bool> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
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

async fn directory_tree_allocated_bytes(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&dir).await else {
            continue;
        };
        total = total.saturating_add(allocated_bytes(&metadata));
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path).await else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(path);
            } else {
                total = total.saturating_add(allocated_bytes(&metadata));
            }
        }
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

    fn make_fifo(path: &Path) {
        let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );
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

    #[tokio::test]
    async fn promotion_does_not_overwrite_newer_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let session_id = "sess-race";
        let image_size = b"new image".len() as u64;
        let key = promote_current_cache_entry(
            &cache,
            &paths,
            session_id,
            b"new image",
            "2026-06-02T00:00:00.000Z",
        )
        .await;
        let stale_run_id = RunId::new_v4();
        let stale_sandbox_id = sandbox::SandboxId::new_v4();
        let stale_lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: stale_run_id,
                sandbox_id: stale_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image_size,
                workspace_drive_required: false,
            })
            .await;
        assert!(stale_lease.is_cache_hit());
        let stale_active_image = paths.active_workspace_image(&stale_sandbox_id);
        tokio::fs::create_dir_all(stale_active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&stale_active_image, b"old image")
            .await
            .unwrap();

        let promoted = stale_lease
            .promote(
                stale_run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap();

        assert!(!promoted);
        drop(stale_lease);
        let metadata = cache
            .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
            .await
            .unwrap();
        assert_eq!(metadata.last_completed_at, "2026-06-02T00:00:00.000Z");
        let current = tokio::fs::read(paths.session_workspace_cache_current_image(&key))
            .await
            .unwrap();
        assert_eq!(current, b"new image");
    }

    #[tokio::test]
    async fn promotion_does_not_overwrite_same_completed_at_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let session_id = "sess-same-completed-at";
        let completed_at = "2026-06-02T00:00:00.000Z";
        let image_size = b"old image".len() as u64;
        let key =
            promote_current_cache_entry(&cache, &paths, session_id, b"old image", completed_at)
                .await;
        let competing_run_id = RunId::new_v4();
        let competing_sandbox_id = sandbox::SandboxId::new_v4();
        let competing_lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: competing_run_id,
                sandbox_id: competing_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image_size,
                workspace_drive_required: false,
            })
            .await;
        assert!(competing_lease.is_cache_hit());
        let competing_active_image = paths.active_workspace_image(&competing_sandbox_id);
        tokio::fs::create_dir_all(competing_active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&competing_active_image, b"new image")
            .await
            .unwrap();

        let promoted = competing_lease
            .promote(
                competing_run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                completed_at.into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap();

        assert!(!promoted);
        drop(competing_lease);
        let metadata = cache
            .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
            .await
            .unwrap();
        assert_eq!(metadata.last_completed_at, completed_at);
        let current = tokio::fs::read(paths.session_workspace_cache_current_image(&key))
            .await
            .unwrap();
        assert_eq!(current, b"old image");
    }

    #[tokio::test]
    async fn promotion_overwrites_older_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let session_id = "sess-newer";
        let image_size = b"old image".len() as u64;
        let key = promote_current_cache_entry(
            &cache,
            &paths,
            session_id,
            b"old image",
            "2026-06-01T00:00:00.000Z",
        )
        .await;
        let newer_run_id = RunId::new_v4();
        let newer_sandbox_id = sandbox::SandboxId::new_v4();
        let newer_lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: newer_run_id,
                sandbox_id: newer_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image_size,
                workspace_drive_required: false,
            })
            .await;
        assert!(newer_lease.is_cache_hit());
        let newer_active_image = paths.active_workspace_image(&newer_sandbox_id);
        tokio::fs::create_dir_all(newer_active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&newer_active_image, b"new image")
            .await
            .unwrap();

        let promoted = newer_lease
            .promote(
                newer_run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap();

        assert!(promoted);
        drop(newer_lease);
        let metadata = cache
            .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
            .await
            .unwrap();
        assert_eq!(metadata.last_completed_at, "2026-06-02T00:00:00.000Z");
        let current = tokio::fs::read(paths.session_workspace_cache_current_image(&key))
            .await
            .unwrap();
        assert_eq!(current, b"new image");
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
    fn fs_stats_path_prefers_existing_cache_dir() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        std::fs::create_dir_all(paths.workspace_image_cache_dir()).unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());

        assert_eq!(
            cache.workspace_image_cache_fs_stats_path(),
            paths.workspace_image_cache_dir()
        );
    }

    #[test]
    fn fs_stats_path_falls_back_to_existing_parent_when_cache_dir_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        std::fs::create_dir_all(paths.base_dir()).unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());

        assert_eq!(
            cache.workspace_image_cache_fs_stats_path(),
            paths.base_dir().to_path_buf()
        );
    }

    #[tokio::test]
    async fn inspect_missing_cache_dir_returns_empty_summary() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths);

        let inspection = cache.inspect().await.unwrap();

        assert!(inspection.entries.is_empty());
        assert_eq!(inspection.summary.total_entries, 0);
        assert_eq!(inspection.summary.total_allocated_bytes, 0);
        assert_eq!(inspection.summary.total_logical_image_bytes, 0);
        assert_eq!(inspection.fs_stats.total_bytes, TEST_FS_TOTAL_BYTES);
        assert_eq!(
            inspection.budget,
            CacheBudget::from_fs_stats(inspection.fs_stats)
        );
    }

    #[tokio::test]
    async fn inspect_reports_reusable_entry_with_storage_counts() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
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
                    working_dir: "/workspace".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:01:00.000Z".into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints {
                        storages: HashMap::from([
                            ("/workspace".into(), ("repo".into(), "v1".into())),
                            ("/workspace/cache".into(), ("cache".into(), "v2".into())),
                        ]),
                        artifacts: HashMap::from([(
                            "/workspace/artifact".into(),
                            ("artifact".into(), "v1".into()),
                        )]),
                    },
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.total_entries, 1);
        assert_eq!(inspection.summary.reusable_entries, 1);
        assert_eq!(inspection.summary.total_logical_image_bytes, 5);
        assert!(inspection.summary.total_allocated_bytes > 0);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Reusable);
        assert_eq!(entry.storage_count, 2);
        assert_eq!(entry.artifact_count, 1);
        assert_eq!(entry.allocated_bytes, allocated_bytes(&current_metadata));
        assert_eq!(entry.logical_image_size_bytes, current_metadata.len());
    }

    #[tokio::test]
    async fn inspect_reports_invalid_metadata_reason() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
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
                    session_id: "other-session".into(),
                    working_dir: "/workspace".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("cache key mismatch"));
    }

    #[tokio::test]
    async fn inspect_rejects_symlink_current_image() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let image = b"image";
        let key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            image.len() as u64,
        );
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let target = dir.path().join("target.ext4");
        fs::write(&target, image).await.unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        std::os::unix::fs::symlink(&target, &current).unwrap();
        let current_target_metadata = fs::metadata(&current).await.unwrap();
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
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:01:00.000Z".into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: current_target_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_target_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(
                        &current_target_metadata,
                    ),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("current image is not a file"));
    }

    #[tokio::test]
    async fn inspect_reports_current_directory_as_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let session_id = "sess-1";
        let working_dir = "/workspace";
        let probe = dir.path().join("current-probe");
        tokio::fs::create_dir_all(&probe).await.unwrap();
        let image_size_bytes = fs::metadata(&probe).await.unwrap().len();
        tokio::fs::remove_dir_all(&probe).await.unwrap();
        let key =
            cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, working_dir, image_size_bytes);
        let current = paths.session_workspace_cache_current_image(&key);
        fs::create_dir_all(&current).await.unwrap();
        fs::write(current.join("nested"), vec![1_u8; 4096])
            .await
            .unwrap();
        let current_metadata = fs::symlink_metadata(&current).await.unwrap();
        cache
            .write_metadata(
                &key,
                run_id,
                WorkspaceCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    key_version: CACHE_KEY_VERSION,
                    cache_scope: String::new(),
                    profile_name: TEST_PROFILE_NAME.into(),
                    session_id: session_id.into(),
                    working_dir: working_dir.into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("current image is not a file"));
        assert!(
            entry.allocated_bytes > allocated_bytes(&current_metadata),
            "inspection should count nested bytes for directory-shaped current images",
        );
    }

    #[tokio::test]
    async fn inspect_reports_stale_entry_without_current_image() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = write_current_cache_entry(
            &cache,
            &paths,
            RunId::new_v4(),
            "sess-1",
            "/workspace",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        fs::remove_file(paths.session_workspace_cache_current_image(&key))
            .await
            .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.stale_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Stale);
        assert_eq!(entry.reason.as_deref(), Some("missing current image"));
        assert_eq!(entry.profile_name.as_deref(), Some(TEST_PROFILE_NAME));
    }

    #[tokio::test]
    async fn inspect_reports_temporary_only_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
        fs::create_dir_all(tmp.parent().unwrap()).await.unwrap();
        fs::write(&tmp, b"partial image").await.unwrap();
        let tmp_metadata = fs::metadata(&tmp).await.unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.temporary_entries, 1);
        assert_eq!(inspection.summary.temporary_paths, 1);
        assert_eq!(
            inspection.summary.temporary_allocated_bytes,
            allocated_bytes(&tmp_metadata)
        );
        let entry = &inspection.entries[0];
        assert_eq!(
            entry.status,
            WorkspaceImageCacheInspectionStatus::TemporaryOnly
        );
        assert_eq!(entry.temporary_path_count, 1);
    }

    #[tokio::test]
    async fn inspect_reports_temporary_only_directory() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
        fs::create_dir_all(&tmp).await.unwrap();
        fs::write(tmp.join("partial-image"), vec![1_u8; 4096])
            .await
            .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.temporary_entries, 1);
        assert_eq!(inspection.summary.temporary_paths, 1);
        assert!(inspection.summary.temporary_allocated_bytes > 0);
        let entry = &inspection.entries[0];
        assert_eq!(
            entry.status,
            WorkspaceImageCacheInspectionStatus::TemporaryOnly
        );
        assert_eq!(
            entry.reason.as_deref(),
            Some("missing current image; temporary paths present")
        );
        assert_eq!(entry.temporary_path_count, 1);
        assert!(entry.temporary_allocated_bytes > 0);
    }

    #[tokio::test]
    async fn inspect_reports_locked_entry_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        fs::write(
            paths.session_workspace_cache_tmp_image(&key, RunId::new_v4()),
            b"partial image",
        )
        .await
        .unwrap();
        let _lock = crate::lock::acquire(cache.entry_lock_path(&key))
            .await
            .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.locked_entries, 1);
        assert_eq!(inspection.summary.temporary_paths, 0);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Locked);
        assert_eq!(entry.reason.as_deref(), Some("entry lock is held"));
        assert_eq!(entry.temporary_path_count, 0);
    }

    #[tokio::test]
    async fn inspect_propagates_lock_path_errors() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        fs::write(paths.base_dir().join("locks"), b"not a directory")
            .await
            .unwrap();

        let err = cache.inspect().await.unwrap_err();

        assert!(
            err.to_string().contains("create lock dir"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn inspect_entry_skips_directory_removed_after_scan() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        let entry_dir = paths.session_workspace_cache_entry_dir(&key);
        fs::create_dir_all(&entry_dir).await.unwrap();
        fs::remove_dir_all(&entry_dir).await.unwrap();

        let entry = cache.inspect_entry(key, entry_dir).await.unwrap();

        assert!(entry.is_none());
    }

    #[tokio::test]
    async fn inspect_entry_skips_symlink_replacement_after_scan() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        let entry_dir = paths.session_workspace_cache_entry_dir(&key);
        fs::create_dir_all(entry_dir.parent().unwrap())
            .await
            .unwrap();
        let target = dir.path().join("outside-cache-entry");
        fs::create_dir_all(&target).await.unwrap();
        std::os::unix::fs::symlink(&target, &entry_dir).unwrap();

        let entry = cache.inspect_entry(key, entry_dir).await.unwrap();

        assert!(entry.is_none());
    }

    #[tokio::test]
    async fn inspect_reports_non_file_metadata_as_invalid_entry() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        fs::write(paths.session_workspace_cache_current_image(&key), b"image")
            .await
            .unwrap();
        fs::create_dir(paths.session_workspace_cache_metadata(&key))
            .await
            .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
    }

    #[tokio::test]
    async fn inspect_rejects_metadata_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        fs::write(paths.session_workspace_cache_current_image(&key), b"image")
            .await
            .unwrap();
        let outside = dir.path().join("outside-metadata.json");
        fs::write(&outside, b"{\"unexpected\":true}").await.unwrap();
        std::os::unix::fs::symlink(&outside, paths.session_workspace_cache_metadata(&key)).unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
    }

    #[tokio::test]
    async fn inspect_rejects_fifo_metadata_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        fs::write(paths.session_workspace_cache_current_image(&key), b"image")
            .await
            .unwrap();
        make_fifo(&paths.session_workspace_cache_metadata(&key));

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
    }

    #[tokio::test]
    async fn inspect_rejects_oversized_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        fs::write(paths.session_workspace_cache_current_image(&key), b"image")
            .await
            .unwrap();
        fs::write(
            paths.session_workspace_cache_metadata(&key),
            vec![b' '; crate::state_file::WORKSPACE_METADATA_MAX_BYTES as usize + 1],
        )
        .await
        .unwrap();

        let inspection = cache.inspect().await.unwrap();

        assert_eq!(inspection.summary.invalid_entries, 1);
        let entry = &inspection.entries[0];
        assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
        assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
    }

    #[tokio::test]
    async fn prepare_removes_symlink_cache_entry_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let session_id = "sess-entry-symlink";
        let key = cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, "/workspace", 5);
        let outside_entry = dir.path().join("outside-cache-entry");
        fs::create_dir_all(&outside_entry).await.unwrap();
        let outside_current = outside_entry.join("current.ext4");
        fs::write(&outside_current, b"image").await.unwrap();
        let current_metadata = fs::metadata(&outside_current).await.unwrap();
        let metadata = WorkspaceCacheMetadata {
            format_version: CACHE_FORMAT_VERSION,
            key_version: CACHE_KEY_VERSION,
            cache_scope: cache.inner.cache_scope.clone(),
            profile_name: TEST_PROFILE_NAME.into(),
            session_id: session_id.into(),
            working_dir: "/workspace".into(),
            last_completed_at: "2026-05-01T00:00:00.000Z".into(),
            last_used_at: "2026-05-01T00:00:00.000Z".into(),
            last_terminal_status: WorkspaceCacheTerminalStatus::Success,
            workspace_trust: WorkspaceTrust::Clean,
            logical_image_size_bytes: current_metadata.len(),
            allocated_bytes: allocated_bytes(&current_metadata),
            current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
            drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
            storage_fingerprints: StorageFingerprints::default(),
            state: WorkspaceCacheState::Current,
        };
        fs::write(
            outside_entry.join("metadata.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .await
        .unwrap();
        let entry_dir = paths.session_workspace_cache_entry_dir(&key);
        fs::create_dir_all(entry_dir.parent().unwrap())
            .await
            .unwrap();
        std::os::unix::fs::symlink(&outside_entry, &entry_dir).unwrap();

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: true,
            })
            .await;

        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
        assert!(
            lease
                .workspace_drive_config()
                .expect("workspace drive should stay enabled")
                .seed_image
                .is_none()
        );
        assert!(matches!(
            fs::symlink_metadata(&entry_dir).await,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound
        ));
        assert_eq!(fs::read(&outside_current).await.unwrap(), b"image");
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
    async fn write_metadata_replaces_stale_tmp_symlink_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        fs::write(&current, b"image").await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        let outside = dir.path().join("outside-metadata-target");
        fs::write(&outside, b"outside").await.unwrap();
        let metadata_tmp = paths
            .session_workspace_cache_metadata(&key)
            .with_file_name(format!("metadata.json.tmp.{run_id}"));
        std::os::unix::fs::symlink(&outside, &metadata_tmp).unwrap();

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
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

        assert_eq!(fs::read(&outside).await.unwrap(), b"outside");
        let metadata_path = paths.session_workspace_cache_metadata(&key);
        let metadata_file_type = fs::symlink_metadata(&metadata_path)
            .await
            .unwrap()
            .file_type();
        assert!(metadata_file_type.is_file());
        assert!(!metadata_file_type.is_symlink());
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

    #[tokio::test]
    async fn metadata_validation_rejects_symlink_current_image() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().to_path_buf());
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            b"image".len() as u64,
        );
        fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
            .await
            .unwrap();
        let target = dir.path().join("target.ext4");
        fs::write(&target, b"image").await.unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        std::os::unix::fs::symlink(&target, &current).unwrap();
        let current_target_metadata = fs::metadata(&current).await.unwrap();
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
                    logical_image_size_bytes: current_target_metadata.len(),
                    allocated_bytes: allocated_bytes(&current_target_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(
                        &current_target_metadata,
                    ),
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
                current_target_metadata.len(),
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("current image is not a file"));
        assert!(
            cache.held_session_states().await.is_empty(),
            "symlink current image entries must not be advertised for affinity",
        );

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(!paths.session_workspace_cache_entry_dir(&key).exists());
        assert!(
            target.exists(),
            "GC must remove the symlink, not its target"
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
    async fn checkout_uses_current_allocated_bytes_when_cache_hit_copy_lacks_headroom() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let setup_cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let image = vec![1_u8; 4096];
        let cache_key = setup_cache.scoped_cache_key(
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            image.len() as u64,
        );
        tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap();
        let current = paths.session_workspace_cache_current_image(&cache_key);
        tokio::fs::write(&current, &image).await.unwrap();
        let current_metadata = fs::metadata(&current).await.unwrap();
        let actual_allocated_bytes = allocated_bytes(&current_metadata);
        assert!(
            actual_allocated_bytes > 0,
            "test filesystem must report allocated blocks for the cache image"
        );
        setup_cache
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
                    allocated_bytes: 0,
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();
        let min_free = CacheBudget::from_fs_stats(FsStats {
            total_bytes: TEST_FS_TOTAL_BYTES,
            available_bytes: TEST_FS_TOTAL_BYTES,
        })
        .min_free_bytes;
        let cache = SessionWorkspaceCache::new_with_fs_stats(
            paths.clone(),
            FsStats {
                total_bytes: TEST_FS_TOTAL_BYTES,
                available_bytes: min_free.saturating_add(actual_allocated_bytes - 1),
            },
        );

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
            "current image must not remain reusable after real allocated bytes make a cache hit unsafe"
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
    async fn promotion_context_keeps_entry_locked_until_reused_active_lease_drops() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let session_id = "sess-locked-context";
        let image_size_bytes = 16 * 1024 * 1024;

        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

        let promotion = lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: local_timestamp(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .unwrap();

        let blocked_by_context = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(
            blocked_by_context.result(),
            WorkspaceCacheCheckoutResult::LockBusy
        );

        let active_lease = promotion.into_active_lease(WorkspaceImageActiveLeaseRequest {
            run_id: RunId::new_v4(),
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes,
            workspace_drive_available: true,
        });

        let blocked_by_active_lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(
            blocked_by_active_lease.result(),
            WorkspaceCacheCheckoutResult::LockBusy
        );

        drop(active_lease);
        let after_drop = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(after_drop.result(), WorkspaceCacheCheckoutResult::Miss);
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
    async fn gc_removes_unusable_current_entry_with_unreadable_metadata_path() {
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
        tokio::fs::create_dir(paths.session_workspace_cache_metadata(&key))
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(
            !paths.session_workspace_cache_entry_dir(&key).exists(),
            "unreadable metadata paths make entries unusable and should not block cache GC"
        );
    }

    #[tokio::test]
    async fn gc_dry_run_counts_temporary_only_entry_once() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        let entry_dir = paths.session_workspace_cache_entry_dir(&key);
        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
        tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
        let expected = directory_tree_allocated_bytes(&entry_dir).await;

        let freed = cache.gc(true).await.unwrap();

        assert_eq!(
            freed, expected,
            "dry-run should count temporary-only entries once, matching actual full-entry cleanup"
        );
        assert!(tmp.exists());
        assert!(entry_dir.exists());
    }

    #[tokio::test]
    async fn gc_dry_run_counts_unusable_entry_with_temporary_path_once() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let key = session_workspace_cache_key("sess-1", "/workspace");
        let entry_dir = paths.session_workspace_cache_entry_dir(&key);
        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        let current = paths.session_workspace_cache_current_image(&key);
        tokio::fs::write(&current, b"orphan image").await.unwrap();
        let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
        tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
        let expected = directory_tree_allocated_bytes(&entry_dir).await;

        let freed = cache.gc(true).await.unwrap();

        assert_eq!(
            freed, expected,
            "dry-run should not count temporary paths again after an unusable entry is already selected for cleanup"
        );
        assert!(current.exists());
        assert!(tmp.exists());
        assert!(entry_dir.exists());
    }

    #[tokio::test]
    async fn gc_dry_run_uses_pre_cleanup_freed_bytes_for_disk_pressure() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let setup_cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let key = write_current_cache_entry(
            &setup_cache,
            &paths,
            run_id,
            "sess-1",
            "/workspace",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        let tmp = paths.session_workspace_cache_tmp_image(&key, run_id);
        tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
        let temporary_allocated = workspace_cache_path_allocated_bytes(&tmp).await;
        assert!(temporary_allocated > 0);

        let fs_total = TEST_FS_TOTAL_BYTES;
        let min_free = CacheBudget::from_fs_stats(FsStats {
            total_bytes: fs_total,
            available_bytes: fs_total,
        })
        .min_free_bytes;
        let cache = SessionWorkspaceCache::new_with_fs_stats(
            paths.clone(),
            FsStats {
                total_bytes: fs_total,
                available_bytes: min_free.saturating_sub(1),
            },
        );

        let freed = cache.gc(true).await.unwrap();

        assert_eq!(
            freed, temporary_allocated,
            "dry-run should account for pre-cleanup temporary bytes before deciding whether valid cache entries need budget GC"
        );
        assert!(tmp.exists());
        assert!(
            paths.session_workspace_cache_current_image(&key).exists(),
            "dry-run must not preview deleting a valid entry when temporary cleanup would relieve disk pressure"
        );
    }

    #[tokio::test]
    async fn gc_removes_current_directory_even_when_metadata_matches() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let session_id = "sess-1";
        let working_dir = "/workspace";
        let probe = dir.path().join("current-probe");
        tokio::fs::create_dir_all(&probe).await.unwrap();
        let image_size_bytes = fs::metadata(&probe).await.unwrap().len();
        tokio::fs::remove_dir_all(&probe).await.unwrap();
        let key =
            cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, working_dir, image_size_bytes);
        let current = paths.session_workspace_cache_current_image(&key);
        tokio::fs::create_dir_all(&current).await.unwrap();
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
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:00:00.000Z".into(),
                    last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                    workspace_trust: WorkspaceTrust::Clean,
                    logical_image_size_bytes: image_size_bytes,
                    allocated_bytes: allocated_bytes(&current_metadata),
                    current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                    drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    state: WorkspaceCacheState::Current,
                },
            )
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(
            !paths.session_workspace_cache_entry_dir(&key).exists(),
            "current directories must not remain as reusable workspace cache entries"
        );
    }

    #[tokio::test]
    async fn gc_counts_nested_current_directory_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let session_id = "sess-1";
        let working_dir = "/workspace";
        let image_size_bytes = 1024 * 1024;
        let key =
            cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, working_dir, image_size_bytes);
        let current = paths.session_workspace_cache_current_image(&key);
        let nested = current.join("nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        tokio::fs::write(
            nested.join("payload"),
            vec![1_u8; image_size_bytes as usize],
        )
        .await
        .unwrap();
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
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                    last_used_at: "2026-05-01T00:00:00.000Z".into(),
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

        let freed = cache.gc(false).await.unwrap();

        assert!(
            freed >= image_size_bytes,
            "GC must report nested current directory bytes so callers refresh disk stats after cleanup"
        );
        assert!(!paths.session_workspace_cache_entry_dir(&key).exists());
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
    async fn gc_removes_orphan_temporary_workspace_cache_directories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = write_current_cache_entry(
            &cache,
            &paths,
            run_id,
            "sess-1",
            "/workspace",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
        let metadata_tmp = paths
            .session_workspace_cache_metadata(&cache_key)
            .with_file_name(format!("metadata.json.tmp.{run_id}"));
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        tokio::fs::write(tmp.join("partial-image"), b"partial image")
            .await
            .unwrap();
        tokio::fs::create_dir_all(&metadata_tmp).await.unwrap();
        tokio::fs::write(metadata_tmp.join("partial-metadata"), b"partial metadata")
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(freed > 0);
        assert!(!tmp.exists());
        assert!(!metadata_tmp.exists());
        assert!(
            paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
    }

    #[tokio::test]
    async fn gc_counts_nested_temporary_workspace_cache_directories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let cache_key = write_current_cache_entry(
            &cache,
            &paths,
            run_id,
            "sess-1",
            "/workspace",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
        let nested = tmp.join("nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        tokio::fs::write(nested.join("partial-image"), vec![1_u8; 4096])
            .await
            .unwrap();

        let freed = cache.gc(false).await.unwrap();

        assert!(
            freed > 0,
            "GC must report bytes freed from nested temporary directories"
        );
        assert!(!tmp.exists());
        assert!(
            paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
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
    async fn promote_skips_symlink_active_image_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let session_id = "sess-active-symlink";
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        let active_image = paths.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        let outside_image = dir.path().join("outside-active.ext4");
        tokio::fs::write(&outside_image, b"image").await.unwrap();
        std::os::unix::fs::symlink(&outside_image, &active_image).unwrap();

        let promoted = lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap();

        let cache_key = session_workspace_cache_key(session_id, "/workspace");
        assert!(!promoted);
        assert!(
            !paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
        assert_eq!(tokio::fs::read(&outside_image).await.unwrap(), b"image");
        assert!(
            tokio::fs::symlink_metadata(&active_image)
                .await
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    async fn promote_replaces_symlink_cache_entry_dir_without_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let session_id = "sess-promote-entry-symlink";
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        let active_image = paths.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&active_image, b"image").await.unwrap();
        let cache_key = session_workspace_cache_key(session_id, "/workspace");
        let entry_dir = paths.session_workspace_cache_entry_dir(&cache_key);
        let outside_entry = dir.path().join("outside-promotion-entry");
        tokio::fs::create_dir_all(&outside_entry).await.unwrap();
        tokio::fs::write(outside_entry.join("marker"), b"marker")
            .await
            .unwrap();
        tokio::fs::create_dir_all(entry_dir.parent().unwrap())
            .await
            .unwrap();
        std::os::unix::fs::symlink(&outside_entry, &entry_dir).unwrap();

        let promoted = lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap();

        let entry_metadata = fs::symlink_metadata(&entry_dir).await.unwrap();
        assert!(promoted);
        assert!(entry_metadata.is_dir());
        assert!(!entry_metadata.file_type().is_symlink());
        assert_eq!(
            fs::read(paths.session_workspace_cache_current_image(&cache_key))
                .await
                .unwrap(),
            b"image"
        );
        assert!(!outside_entry.join("current.ext4").exists());
        assert_eq!(
            fs::read(outside_entry.join("marker")).await.unwrap(),
            b"marker"
        );
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
    async fn promote_removes_stale_temporary_directory_before_copy() {
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
        let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        tokio::fs::write(tmp.join("stale"), b"stale").await.unwrap();

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

        let current = paths.session_workspace_cache_current_image(&cache_key);
        assert!(!tmp.exists());
        assert!(fs::metadata(&current).await.unwrap().is_file());
        assert_eq!(fs::read(current).await.unwrap(), b"image");
    }

    #[tokio::test]
    async fn promote_replaces_stale_current_directory_before_rename() {
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
        let current = paths.session_workspace_cache_current_image(&cache_key);
        tokio::fs::create_dir_all(&current).await.unwrap();
        tokio::fs::write(current.join("stale"), b"stale")
            .await
            .unwrap();

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

        assert!(fs::metadata(&current).await.unwrap().is_file());
        assert_eq!(fs::read(current).await.unwrap(), b"image");
    }

    #[tokio::test]
    async fn promote_skips_copied_image_with_unexpected_logical_size() {
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
                session_id: Some("sess-size-mismatch"),
                working_dir: "/workspace",
                image_size_bytes: 16 * 1024 * 1024,
                workspace_drive_required: false,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"truncated")
            .await
            .unwrap();
        let cache_key = session_workspace_cache_key("sess-size-mismatch", "/workspace");

        assert!(
            !lease
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
        assert!(
            !paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
        assert!(cache.held_session_states().await.is_empty());
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

    #[tokio::test]
    async fn late_session_promotion_skips_when_entry_lock_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let session_id = "sess-late-lock-busy";
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
        let promotion = lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .unwrap();
        let cache_key = session_workspace_cache_key(session_id, "/workspace");
        let _held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
            .await
            .unwrap();

        let promoted = tokio::time::timeout(std::time::Duration::from_secs(1), promotion.promote())
            .await
            .expect("late-session promotion must not block behind another runner's lock")
            .unwrap();

        assert!(!promoted);
        assert!(
            !paths
                .session_workspace_cache_current_image(&cache_key)
                .exists()
        );
    }

    #[tokio::test]
    async fn no_lock_promotion_context_survives_reuse_active_lease() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths);
        let run_id = RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let session_id = "sess-reused-late-context";
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
        let promotion = lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .unwrap();

        let active_lease = promotion.into_active_lease(WorkspaceImageActiveLeaseRequest {
            run_id: RunId::new_v4(),
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: 5,
            workspace_drive_available: true,
        });

        assert!(active_lease.can_attempt_promotion(Some(session_id)));
        assert!(
            active_lease
                .into_promotion_context(WorkspaceImagePromotionRequest {
                    run_id: RunId::new_v4(),
                    sandbox_id,
                    session_id_override: Some(session_id),
                    terminal_status: WorkspaceCacheTerminalStatus::Success,
                    completed_at: "2026-05-01T00:00:01.000Z".into(),
                    storage_fingerprints: StorageFingerprints::default(),
                    promotable: true,
                })
                .is_some(),
            "reusing an idle sandbox created before the CLI reported a session id must not lose the future cache promotion"
        );
    }
}
