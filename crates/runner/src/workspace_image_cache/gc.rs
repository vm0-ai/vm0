use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;

use tokio::fs;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::types::MAX_HELD_SESSION_STATES;

use super::entry::is_cache_key_name;
use super::fs::{
    allocated_bytes, cache_entry_dir_is_dir, directory_tree_allocated_bytes,
    entry_file_type_is_dir, fs_stats_with_additional_available, is_workspace_tmp_path_name,
    remove_workspace_cache_path_if_exists, workspace_cache_path_allocated_bytes,
};
use super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceTrust, validate_current_image_identity,
};
use super::path_safety::is_safe_guest_working_dir;
use super::types::{CacheBudget, FsStats};
use super::{
    CACHE_FORMAT_VERSION, CACHE_KEY_VERSION, SessionWorkspaceCache, WORKSPACE_DRIVE_LAYOUT,
};

pub(super) struct GcCandidate {
    pub(super) cache_key: String,
    pub(super) allocated_bytes: u64,
    file_dev: u64,
    file_ino: u64,
    pub(super) last_used_at: String,
}

#[derive(Default)]
pub(super) struct GcEntryCleanup {
    freed_bytes: u64,
    removed_entry_keys: BTreeSet<String>,
}

impl GcCandidate {
    pub(super) fn same_current_image(&self, other: &Self) -> bool {
        self.file_dev == other.file_dev
            && self.file_ino == other.file_ino
            && self.last_used_at == other.last_used_at
    }
}

pub(super) fn gc_budget_satisfied(
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

impl SessionWorkspaceCache {
    pub(crate) async fn gc(&self, dry_run: bool) -> RunnerResult<u64> {
        let _capacity_lock = crate::lock::acquire(self.capacity_lock_path()).await?;
        self.gc_locked(dry_run).await
    }

    pub(super) async fn gc_locked(&self, dry_run: bool) -> RunnerResult<u64> {
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

    pub(super) fn unusable_current_entry_reason(
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
            match fs::symlink_metadata(&current).await {
                Ok(_) => {
                    drop(lock);
                    continue;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
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

    pub(super) async fn gc_candidates(&self) -> RunnerResult<Vec<GcCandidate>> {
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

    pub(super) async fn gc_candidate(&self, cache_key: String) -> Option<GcCandidate> {
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
            Ok(metadata) => metadata.last_used_at,
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
}
